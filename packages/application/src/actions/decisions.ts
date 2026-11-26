import {
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResultSchema,
  ApprovalPreflightSchema,
  ApprovalQueueResponseSchema,
  UuidSchema,
  type Actor,
  type ActionProposalDetail,
  type ActionProposalStatus,
  type ApprovalDecision,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResult,
  type ApprovalPreflight,
  type ApprovalQueueItem,
  type ApprovalQueueResponse,
  type Role,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type { PolicyBundleSource } from './policy-source.js';
import {
  requireActiveSandbox,
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from '../cases/context.js';

export const APPROVE_ROUTE = '/api/v1/proposals/:proposalId/approve';
export const REJECT_ROUTE = '/api/v1/proposals/:proposalId/reject';
export const ROLE_ORDER: readonly Role[] = ['approver_ops', 'approver_finance'];

export type DecisionErrorCode =
  | 'INVALID_REQUEST'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_NOT_PENDING'
  | 'REVISION_MISMATCH'
  | 'PLAN_HASH_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'POLICY_CHANGED'
  | 'POLICY_UNAVAILABLE'
  | 'SELF_APPROVAL'
  | 'ACTOR_ALREADY_DECIDED'
  | 'ROLE_NOT_ELIGIBLE'
  | 'NO_HUMAN_APPROVAL_REQUIRED'
  | 'DECISION_CONFLICT'
  | 'IDEMPOTENCY_MISMATCH'
  | 'EXECUTION_STATE_PRESENT'
  | 'CASE_TERMINAL';

export class DecisionError extends Error {
  constructor(
    readonly code: DecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

export interface DecisionWriteContext {
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface CommandReplay {
  readonly requestHash: string;
  readonly response: unknown;
}

export interface CommandReplayInput {
  readonly sandboxId: string;
  readonly actor: Actor;
  readonly route: string;
  readonly idempotencyKey: string;
}

export interface ApprovalCursor {
  readonly sequence: number;
  readonly id: string;
}

export interface ApprovalStateSnapshot {
  readonly proposal: ActionProposalDetail;
  readonly decisions: ApprovalDecision[];
  readonly filledRoles: Role[];
  readonly missingRoles: Role[];
  readonly expiresAt: string;
}

export interface RecordDecisionInput {
  readonly sandboxId: string;
  readonly proposalId: string;
  readonly decision: 'approve' | 'reject';
  readonly request: ApprovalDecisionRequest;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export type DecisionStoreResult =
  | { readonly ok: true; readonly result: ApprovalDecisionResult }
  | { readonly ok: false; readonly code: DecisionErrorCode };

export interface ApprovalStore extends SandboxResolver {
  findCommandReplay(input: CommandReplayInput): Promise<CommandReplay | null>;
  getApprovalState(
    sandboxId: string,
    proposalId: string,
  ): Promise<ApprovalStateSnapshot | null>;
  listApprovalQueue(input: {
    readonly sandboxId: string;
    readonly actor: Actor;
    readonly limit: number;
    readonly cursor: ApprovalCursor | null;
  }): Promise<{
    readonly items: ApprovalQueueItem[];
    readonly hasMore: boolean;
    readonly lastCursor: ApprovalCursor | null;
  }>;
  recordDecision(input: RecordDecisionInput): Promise<DecisionStoreResult>;
}

export type RevisionExecutionState = 'none' | 'started' | 'succeeded' | 'unknown';

export interface ExecutionStatePort {
  getRevisionExecutionState(input: {
    readonly sandboxId: string;
    readonly actionRevisionId: string;
  }): Promise<RevisionExecutionState>;
}

export function createEmptyExecutionStatePort(): ExecutionStatePort {
  return {
    async getRevisionExecutionState(): Promise<RevisionExecutionState> {
      return 'none';
    },
  };
}

export function encodeApprovalCursor(cursor: ApprovalCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeApprovalCursor(
  value: string | undefined,
): ApprovalCursor | null {
  if (value === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      sequence?: unknown;
      id?: unknown;
    };
    if (
      !Number.isInteger(parsed.sequence) ||
      (parsed.sequence as number) < 1 ||
      !UuidSchema.safeParse(parsed.id).success
    ) {
      throw new Error('invalid cursor');
    }
    return { sequence: parsed.sequence as number, id: parsed.id as string };
  } catch {
    throw new DecisionError('INVALID_REQUEST', 'Approval cursor is invalid');
  }
}

function sortedRoles(values: readonly Role[]): Role[] {
  return ROLE_ORDER.filter((role) => values.includes(role));
}

function decisionResult(body: unknown): ApprovalDecisionResult {
  return ApprovalDecisionResultSchema.parse(body);
}

export class DecisionService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly executionState: ExecutionStatePort = createEmptyExecutionStatePort(),
    private readonly policySource: PolicyBundleSource | null = null,
  ) {}

  async decide(
    proposalId: string,
    decision: 'approve' | 'reject',
    body: unknown,
    idempotencyKey: string | undefined,
    context: DecisionWriteContext,
  ): Promise<ApprovalDecisionResult> {
    if (!UuidSchema.safeParse(proposalId).success) {
      throw new DecisionError('INVALID_REQUEST', 'Proposal id is invalid');
    }
    const parsed = ApprovalDecisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DecisionError(
        'INVALID_REQUEST',
        'Approval decision request is invalid',
      );
    }
    const key = this.#idempotencyKey(idempotencyKey);
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const route = decision === 'approve' ? APPROVE_ROUTE : REJECT_ROUTE;
    const requestHash = canonicalJsonSha256({
      decision,
      proposalId,
      request: parsed.data,
    });
    const replay = await this.store.findCommandReplay({
      sandboxId: sandbox.id,
      actor: context.actor,
      route,
      idempotencyKey: key,
    });
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new DecisionError(
          'IDEMPOTENCY_MISMATCH',
          'Idempotency key was reused with a different request body',
        );
      }
      return decisionResult(replay.response);
    }
    if (decision === 'approve' && this.policySource) {
      const snapshot = await this.store.getApprovalState(sandbox.id, proposalId);
      if (!snapshot) {
        throw new DecisionError('PROPOSAL_NOT_FOUND', 'Proposal was not found');
      }
      let policy;
      try {
        policy = await this.policySource.load();
      } catch {
        throw new DecisionError(
          'POLICY_UNAVAILABLE',
          'The current policy bundle is unavailable',
        );
      }
      if (
        snapshot.proposal.revision.policyRevision !== policy.bundle.revision ||
        snapshot.proposal.revision.policyContentHash !== policy.contentHash
      ) {
        throw new DecisionError(
          'POLICY_CHANGED',
          'The revision was created under a different policy bundle',
        );
      }
    }
    const result = await this.store.recordDecision({
      sandboxId: sandbox.id,
      proposalId,
      decision,
      request: parsed.data,
      actor: context.actor,
      idempotencyKey: key,
      requestHash,
      requestId: context.requestId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      throw new DecisionError(result.code, result.code);
    }
    return decisionResult(result.result);
  }

  async list(
    actor: Actor,
    limit: number,
    cursor: string | undefined,
    sandboxResolver: SandboxResolver = this.store,
  ): Promise<ApprovalQueueResponse> {
    const bounded = Math.min(Math.max(limit, 1), 50);
    const sandbox = await requireActiveSandbox(sandboxResolver);
    const result = await this.store.listApprovalQueue({
      sandboxId: sandbox.id,
      actor,
      limit: bounded,
      cursor: decodeApprovalCursor(cursor),
    });
    return ApprovalQueueResponseSchema.parse({
      items: result.items,
      nextCursor:
        result.hasMore && result.lastCursor
          ? encodeApprovalCursor(result.lastCursor)
          : null,
    });
  }

  async preflight(
    proposalId: string,
    sandboxResolver: SandboxResolver = this.store,
  ): Promise<ApprovalPreflight> {
    if (!UuidSchema.safeParse(proposalId).success) {
      throw new DecisionError('PROPOSAL_NOT_FOUND', 'Proposal id is invalid');
    }
    const sandbox = await requireActiveSandbox(sandboxResolver);
    const snapshot = await this.store.getApprovalState(sandbox.id, proposalId);
    if (!snapshot) {
      throw new DecisionError('PROPOSAL_NOT_FOUND', 'Proposal was not found');
    }
    const executionState = await this.executionState.getRevisionExecutionState({
      sandboxId: sandbox.id,
      actionRevisionId: snapshot.proposal.revision.id,
    });
    const status = this.#statusFor(snapshot);
    return ApprovalPreflightSchema.parse({
      proposalId: snapshot.proposal.proposal.id,
      actionRevisionId: snapshot.proposal.revision.id,
      planHash: snapshot.proposal.revision.planHash,
      status,
      requiredRoles: sortedRoles(snapshot.proposal.revision.requiredRoles),
      filledRoles: sortedRoles(snapshot.filledRoles),
      missingRoles: sortedRoles(snapshot.missingRoles),
      policyRevision: snapshot.proposal.revision.policyRevision,
      policyContentHash: snapshot.proposal.revision.policyContentHash,
      expiresAt: snapshot.expiresAt,
      executionState,
    });
  }

  #statusFor(snapshot: ApprovalStateSnapshot): ApprovalPreflight['status'] {
    const revisionState: ActionProposalStatus = snapshot.proposal.revision.state;
    if (revisionState === 'superseded') {
      return 'superseded';
    }
    if (revisionState === 'expired') {
      return 'expired';
    }
    if (snapshot.proposal.proposal.status === 'rejected') {
      return 'rejected';
    }
    if (snapshot.proposal.proposal.status === 'approved') {
      return 'approved';
    }
    if (new Date(snapshot.expiresAt).getTime() <= Date.now()) {
      return 'expired';
    }
    return 'pending';
  }

  #idempotencyKey(value: string | undefined): string {
    try {
      return UuidSchema.parse(value).toLowerCase();
    } catch {
      throw new DecisionError(
        'INVALID_REQUEST',
        'A valid Idempotency-Key header is required',
      );
    }
  }
}

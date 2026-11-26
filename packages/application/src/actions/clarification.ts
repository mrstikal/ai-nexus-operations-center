import {
  ActionRevisionRequestInputSchema,
  ActionRevisionRequestResponseSchema,
  UuidSchema,
  type ActionRevisionRequest,
  type ActionRevisionRequestInput,
  type ActionRevisionRequestKind,
  type ActionRevisionRequestResponse,
  type Actor,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from '../cases/context.js';
import type { CommandReplay, CommandReplayInput } from './decisions.js';

export const CLARIFICATION_ROUTE = '/api/v1/proposals/:proposalId/clarification';

export type RevisionRequestErrorCode =
  | 'INVALID_REQUEST'
  | 'PROPOSAL_NOT_FOUND'
  | 'REVISION_MISMATCH'
  | 'PLAN_HASH_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'REQUEST_NOT_ALLOWED'
  | 'REQUEST_CONFLICT'
  | 'IDEMPOTENCY_MISMATCH';

export class RevisionRequestError extends Error {
  constructor(
    readonly code: RevisionRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RevisionRequestError';
  }
}

export interface RevisionRequestWriteContext {
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface RecordRevisionRequestInput {
  readonly sandboxId: string;
  readonly proposalId: string;
  readonly kind: ActionRevisionRequestKind;
  readonly request: ActionRevisionRequestInput;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export type RevisionRequestStoreResult =
  | { readonly ok: true; readonly response: ActionRevisionRequestResponse }
  | { readonly ok: false; readonly code: RevisionRequestErrorCode };

export interface RevisionRequestStore extends SandboxResolver {
  findCommandReplay(input: CommandReplayInput): Promise<CommandReplay | null>;
  recordRevisionRequest(
    input: RecordRevisionRequestInput,
  ): Promise<RevisionRequestStoreResult>;
}

export class RevisionRequestService {
  constructor(
    private readonly store: RevisionRequestStore,
    private readonly kind: ActionRevisionRequestKind,
    private readonly route: string,
  ) {}

  async request(
    proposalId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    context: RevisionRequestWriteContext,
  ): Promise<ActionRevisionRequestResponse> {
    if (!UuidSchema.safeParse(proposalId).success) {
      throw new RevisionRequestError('PROPOSAL_NOT_FOUND', 'Proposal id is invalid');
    }
    const parsed = ActionRevisionRequestInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new RevisionRequestError(
        'INVALID_REQUEST',
        'Revision request is invalid',
      );
    }
    let key: string;
    try {
      key = UuidSchema.parse(idempotencyKey).toLowerCase();
    } catch {
      throw new RevisionRequestError(
        'INVALID_REQUEST',
        'A valid Idempotency-Key header is required',
      );
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const requestHash = canonicalJsonSha256({
      kind: this.kind,
      proposalId,
      request: parsed.data,
    });
    const replay = await this.store.findCommandReplay({
      sandboxId: sandbox.id,
      actor: context.actor,
      route: this.route,
      idempotencyKey: key,
    });
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new RevisionRequestError(
          'IDEMPOTENCY_MISMATCH',
          'Idempotency key was reused with a different request body',
        );
      }
      return ActionRevisionRequestResponseSchema.parse(replay.response);
    }
    const result = await this.store.recordRevisionRequest({
      sandboxId: sandbox.id,
      proposalId,
      kind: this.kind,
      request: parsed.data,
      actor: context.actor,
      idempotencyKey: key,
      requestHash,
      requestId: context.requestId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      throw new RevisionRequestError(result.code, result.code);
    }
    return ActionRevisionRequestResponseSchema.parse(result.response);
  }
}

export class ClarificationService extends RevisionRequestService {
  constructor(store: RevisionRequestStore) {
    super(store, 'clarification', CLARIFICATION_ROUTE);
  }
}

export function revisionRequestFromRow(row: {
  id: string;
  proposalId: string;
  actionRevisionId: string;
  planHash: string;
  kind: string;
  state: string;
  actor: Actor;
  reason: string;
  waitRunId: string | null;
  createdAt: Date;
}): ActionRevisionRequest {
  return {
    id: row.id,
    proposalId: row.proposalId,
    actionRevisionId: row.actionRevisionId,
    planHash: row.planHash,
    kind: row.kind as ActionRevisionRequestKind,
    state: row.state as ActionRevisionRequest['state'],
    actor: row.actor,
    reason: row.reason,
    waitRunId: row.waitRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

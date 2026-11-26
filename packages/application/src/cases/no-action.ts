import {
  NoActionInputSchema,
  NoActionResponseSchema,
  UuidSchema,
  type Actor,
  type NoActionInput,
  type NoActionResponse,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from './context.js';
import {
  createEmptyExecutionStatePort,
  type CommandReplay,
  type CommandReplayInput,
  type ExecutionStatePort,
} from '../actions/decisions.js';

export const NO_ACTION_ROUTE = '/api/v1/cases/:caseId/resolve-no-action';

export type NoActionErrorCode =
  | 'CASE_NOT_FOUND'
  | 'CASE_TERMINAL'
  | 'NO_ACTIVE_RUN'
  | 'EXECUTION_STATE_PRESENT'
  | 'NO_ACTION_NOT_ALLOWED'
  | 'IDEMPOTENCY_MISMATCH';

export class NoActionError extends Error {
  constructor(
    readonly code: NoActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NoActionError';
  }
}

export interface NoActionWriteContext {
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface ResolveNoActionInput {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly reason: string;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export type NoActionStoreResult =
  | { readonly ok: true; readonly response: NoActionResponse }
  | { readonly ok: false; readonly code: NoActionErrorCode };

export interface NoActionResultStore extends SandboxResolver {
  findCommandReplay(input: CommandReplayInput): Promise<CommandReplay | null>;
  listOpenRevisionIds(
    sandboxId: string,
    caseId: string,
  ): Promise<{ readonly caseStatus: string; readonly revisionIds: string[] } | null>;
  resolveNoAction(input: ResolveNoActionInput): Promise<NoActionStoreResult>;
}

export class NoActionService {
  constructor(
    private readonly store: NoActionResultStore,
    private readonly executionState: ExecutionStatePort = createEmptyExecutionStatePort(),
  ) {}

  async resolve(
    caseId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    context: NoActionWriteContext,
  ): Promise<NoActionResponse> {
    if (!UuidSchema.safeParse(caseId).success) {
      throw new NoActionError('CASE_NOT_FOUND', 'Case id is invalid');
    }
    let parsed: NoActionInput;
    try {
      parsed = NoActionInputSchema.parse(body);
    } catch {
      throw new NoActionError('NO_ACTION_NOT_ALLOWED', 'No-action request is invalid');
    }
    let key: string;
    try {
      key = UuidSchema.parse(idempotencyKey).toLowerCase();
    } catch {
      throw new NoActionError(
        'NO_ACTION_NOT_ALLOWED',
        'A valid Idempotency-Key header is required',
      );
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const requestHash = canonicalJsonSha256({ caseId, reason: parsed.reason });
    const replay = await this.store.findCommandReplay({
      sandboxId: sandbox.id,
      actor: context.actor,
      route: NO_ACTION_ROUTE,
      idempotencyKey: key,
    });
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new NoActionError(
          'IDEMPOTENCY_MISMATCH',
          'Idempotency key was reused with a different request body',
        );
      }
      return NoActionResponseSchema.parse(replay.response);
    }
    const open = await this.store.listOpenRevisionIds(sandbox.id, caseId);
    if (!open) {
      throw new NoActionError('CASE_NOT_FOUND', 'Case was not found');
    }
    if (open.caseStatus === 'resolved' || open.caseStatus === 'escalated' || open.caseStatus === 'cancelled') {
      throw new NoActionError('CASE_TERMINAL', 'Case is already terminal');
    }
    for (const revisionId of open.revisionIds) {
      const state = await this.executionState.getRevisionExecutionState({
        sandboxId: sandbox.id,
        actionRevisionId: revisionId,
      });
      if (state !== 'none') {
        throw new NoActionError(
          'EXECUTION_STATE_PRESENT',
          'A started, succeeded or unknown execution prevents no-action resolution',
        );
      }
    }
    const result = await this.store.resolveNoAction({
      sandboxId: sandbox.id,
      caseId,
      reason: parsed.reason,
      actor: context.actor,
      idempotencyKey: key,
      requestHash,
      requestId: context.requestId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      throw new NoActionError(result.code, result.code);
    }
    return NoActionResponseSchema.parse(result.response);
  }
}

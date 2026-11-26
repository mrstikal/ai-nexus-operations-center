import {
  RunControlResponseSchema,
  type Actor,
  type CaseStatus,
  type RunCancelRequest,
  type RunControlResponse,
} from '@nexus/contracts';
import { caseStatusForWorkflowStatus } from '../cases/state.js';
import {
  RunControlError,
  type PartialEffect,
  validateCancellation,
} from './waits.js';
import type {
  ControlStoreResult,
  RunControlSnapshot,
} from './resume.js';

export interface CancellationReconciler {
  collectPartialEffects(runId: string): Promise<PartialEffect[]>;
}

export interface CancelRunStoreInput {
  readonly runId: string;
  readonly sandboxId: string;
  readonly actor: Actor;
  readonly request: RunCancelRequest;
  readonly requestId: string;
  readonly correlationId: string;
  readonly caseStatusAfter: CaseStatus;
  readonly partialEffects: readonly PartialEffect[];
}

export interface CancellationStore {
  getRunForControl(
    sandboxId: string,
    runId: string,
  ): Promise<RunControlSnapshot | null>;
  cancelRun(input: CancelRunStoreInput): Promise<ControlStoreResult>;
}

export class CancellationService {
  constructor(
    private readonly store: CancellationStore,
    private readonly reconciler: CancellationReconciler | null = null,
  ) {}

  async cancel(input: {
    readonly sandboxId: string;
    readonly runId: string;
    readonly request: RunCancelRequest;
    readonly actor: Actor;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<RunControlResponse> {
    const run = await this.store.getRunForControl(input.sandboxId, input.runId);
    if (!run) {
      throw new RunControlError('RUN_NOT_FOUND', 'Run was not found');
    }
    validateCancellation(run.status);
    const partialEffects =
      this.reconciler === null
        ? []
        : await this.reconciler.collectPartialEffects(input.runId);
    const result = await this.store.cancelRun({
      runId: input.runId,
      sandboxId: input.sandboxId,
      actor: input.actor,
      request: input.request,
      requestId: input.requestId,
      correlationId: input.correlationId,
      caseStatusAfter:
        caseStatusForWorkflowStatus('cancelled') ?? 'cancelled',
      partialEffects,
    });
    if (!result.ok) {
      throw new RunControlError(result.code, result.code);
    }
    return RunControlResponseSchema.parse(result.response);
  }
}

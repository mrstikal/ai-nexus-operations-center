import type { PartialEffectSummary } from './partial-effects.js';
import type { ReconcileService } from './reconcile.js';

export type CancelPlanErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'PLAN_UNRESOLVED'
  | 'PLAN_ALREADY_CLOSED';

export class CancelPlanError extends Error {
  constructor(
    readonly code: CancelPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CancelPlanError';
  }
}

export type CancelPlanResult =
  | {
      readonly ok: true;
      readonly summary: PartialEffectSummary;
      readonly handoffId: string;
    }
  | { readonly ok: false; readonly code: CancelPlanErrorCode };

export interface CancelPlanStore {
  cancelPlan(input: {
    readonly sandboxId: string;
    readonly proposalId: string;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<CancelPlanResult>;
}

export class CancelPlanService {
  constructor(
    private readonly store: CancelPlanStore,
    private readonly reconciler: Pick<ReconcileService, 'processOnce'>,
  ) {}

  async cancel(
    sandboxId: string,
    proposalId: string,
    requestId = 'cancel-plan',
    correlationId = 'cancel-plan',
  ): Promise<CancelPlanResult> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const progressed = await this.reconciler.processOnce();
      if (!progressed) {
        break;
      }
    }
    return this.store.cancelPlan({
      sandboxId,
      proposalId,
      requestId,
      correlationId,
    });
  }
}

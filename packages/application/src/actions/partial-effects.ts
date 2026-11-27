import type { EnterpriseCommandReceipt } from '@nexus/contracts';

export interface PlanExecutionEffect {
  readonly itemId: string;
  readonly state: string;
  readonly receiptKey: string | null;
  readonly resultEntityType: string | null;
  readonly resultEntityId: string | null;
}

export interface PartialEffectSummary {
  readonly succeededReceiptKeys: string[];
  readonly cancelledItemIds: string[];
  readonly unknownItemIds: string[];
  readonly pendingItemIds: string[];
  readonly effects: Array<{
    readonly itemId: string;
    readonly kind: 'succeeded' | 'cancelled' | 'unknown';
    readonly receiptKey: string | null;
    readonly entityType: string | null;
    readonly entityId: string | null;
  }>;
}

export function summarizePartialEffects(
  executions: readonly PlanExecutionEffect[],
  receipts: readonly EnterpriseCommandReceipt[] = [],
): PartialEffectSummary {
  const byKey = new Map(receipts.map((receipt) => [receipt.idempotencyKey, receipt]));
  const effects: PartialEffectSummary['effects'] = [];
  for (const execution of executions) {
    if (execution.state === 'succeeded') {
      const receipt = execution.receiptKey
        ? byKey.get(execution.receiptKey)
        : undefined;
      effects.push({
        itemId: execution.itemId,
        kind: 'succeeded',
        receiptKey: execution.receiptKey,
        entityType: receipt?.result.entityType ?? execution.resultEntityType,
        entityId: receipt?.result.id ?? execution.resultEntityId,
      });
    } else if (execution.state === 'unknown') {
      effects.push({
        itemId: execution.itemId,
        kind: 'unknown',
        receiptKey: execution.receiptKey,
        entityType: null,
        entityId: null,
      });
    } else if (execution.state === 'cancelled') {
      effects.push({
        itemId: execution.itemId,
        kind: 'cancelled',
        receiptKey: null,
        entityType: null,
        entityId: null,
      });
    }
  }
  return {
    succeededReceiptKeys: [
      ...new Set(
        executions
          .filter((execution) => execution.state === 'succeeded' && execution.receiptKey)
          .map((execution) => execution.receiptKey as string),
      ),
    ].sort(),
    cancelledItemIds: executions
      .filter((execution) => execution.state === 'cancelled')
      .map((execution) => execution.itemId)
      .sort(),
    unknownItemIds: executions
      .filter((execution) => execution.state === 'unknown')
      .map((execution) => execution.itemId)
      .sort(),
    pendingItemIds: executions
      .filter((execution) => execution.state === 'pending')
      .map((execution) => execution.itemId)
      .sort(),
    effects,
  };
}

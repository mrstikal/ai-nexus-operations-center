import type { ActionPlanItem } from '@nexus/contracts';

export interface ItemExecutionState {
  readonly itemId: string;
  readonly state: string;
  readonly receiptKey: string | null;
  readonly resultEntityType: string | null;
  readonly resultEntityId: string | null;
  readonly resultEntityVersion: number | null;
}

export function topologicalItems(
  items: readonly ActionPlanItem[],
): ActionPlanItem[] {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const order = new Map(items.map((item, index) => [item.itemId, index]));
  const result: ActionPlanItem[] = [];
  const visited = new Set<string>();
  const visit = (item: ActionPlanItem): void => {
    if (visited.has(item.itemId)) {
      return;
    }
    for (const dependencyId of item.dependsOnItemIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error('Action dependency is missing');
      }
      visit(dependency);
    }
    visited.add(item.itemId);
    result.push(item);
  };
  for (const item of [...items].sort(
    (left, right) => (order.get(left.itemId) ?? 0) - (order.get(right.itemId) ?? 0),
  )) {
    visit(item);
  }
  return result;
}

export function nextRunnableItem(
  items: readonly ActionPlanItem[],
  executions: readonly ItemExecutionState[],
): ActionPlanItem | null {
  const byId = new Map(executions.map((execution) => [execution.itemId, execution]));
  for (const item of topologicalItems(items)) {
    const execution = byId.get(item.itemId);
    if (execution?.state === 'succeeded') {
      continue;
    }
    const ready = item.dependsOnItemIds.every(
      (dependencyId) => byId.get(dependencyId)?.state === 'succeeded',
    );
    if (ready) {
      return item;
    }
  }
  return null;
}

export function priorReceiptKeys(
  items: readonly ActionPlanItem[],
  item: ActionPlanItem,
  executions: readonly ItemExecutionState[],
): string[] {
  const byId = new Map(executions.map((execution) => [execution.itemId, execution]));
  const keys: string[] = [];
  for (const candidate of topologicalItems(items)) {
    if (candidate.itemId === item.itemId) {
      break;
    }
    const execution = byId.get(candidate.itemId);
    if (execution?.state === 'succeeded' && execution.receiptKey) {
      keys.push(execution.receiptKey);
    }
  }
  return [...new Set(keys)].sort();
}

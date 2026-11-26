import type { ActionPlanItem, Money, Role } from '@nexus/contracts';
import { addMinor, assertMinorBound, formatMinor, parseMinor } from '../money.js';
import {
  ACTION_HANDLER_CATALOG,
  assertSupportedActionKind,
} from './action-validation.js';

const ROLE_ORDER: readonly Role[] = ['approver_ops', 'approver_finance'];

export interface PlanApprovalInput {
  readonly items: readonly ActionPlanItem[];
  readonly priorProcurementMinor: bigint;
  readonly financeThresholdMinor: bigint;
}

export interface PlanApprovalResult {
  readonly requiredRoles: Role[];
  readonly aggregateImpact: Money | null;
  readonly procurement: boolean;
  readonly financeRequired: boolean;
  readonly totalProcurementMinor: bigint;
}

export function isProcurementPlan(items: readonly ActionPlanItem[]): boolean {
  return items.some(
    (item) => item.payload.kind === 'enterprise.create_purchase_order',
  );
}

export function purchaseOrderCommitmentMinor(
  item: ActionPlanItem,
): bigint {
  if (item.payload.kind !== 'enterprise.create_purchase_order') {
    return 0n;
  }
  let total = 0n;
  for (const line of item.payload.lines) {
    total = addMinor(
      total,
      assertMinorBound(BigInt(line.quantity) * parseMinor(line.unitPriceMinor)),
    );
  }
  return addMinor(total, parseMinor(item.payload.expediteChargeMinor));
}

export function computePlanAggregateImpact(
  items: readonly ActionPlanItem[],
): Money | null {
  if (!isProcurementPlan(items)) {
    return null;
  }
  let total = 0n;
  for (const item of items) {
    total = addMinor(total, purchaseOrderCommitmentMinor(item));
  }
  return { amountMinor: formatMinor(total), currency: 'EUR' };
}

export function computePlanCommitmentMinor(items: readonly ActionPlanItem[]): bigint {
  let total = 0n;
  for (const item of items) {
    total = addMinor(total, purchaseOrderCommitmentMinor(item));
  }
  return total;
}

export function computeRequiredApprovalRoles(
  input: PlanApprovalInput,
): PlanApprovalResult {
  if (input.priorProcurementMinor < 0n) {
    throw new Error('Prior procurement commitment must be non-negative');
  }
  assertMinorBound(input.priorProcurementMinor);
  if (input.financeThresholdMinor < 0n) {
    throw new Error('Finance threshold must be non-negative');
  }
  assertMinorBound(input.financeThresholdMinor);

  const roles = new Set<Role>();
  let procurement = false;
  for (const item of input.items) {
    const kind = assertSupportedActionKind(item.payload.kind);
    const rule = ACTION_HANDLER_CATALOG[kind];
    for (const role of rule.approvalRoles) {
      roles.add(role);
    }
    if (rule.financeThresholdApplies) {
      procurement = true;
    }
  }
  const newCommitmentMinor = computePlanCommitmentMinor(input.items);
  const totalProcurementMinor = addMinor(
    input.priorProcurementMinor,
    newCommitmentMinor,
  );
  const financeRequired =
    procurement && totalProcurementMinor > input.financeThresholdMinor;
  if (financeRequired) {
    roles.add('approver_finance');
  }
  return {
    requiredRoles: ROLE_ORDER.filter((role) => roles.has(role)),
    aggregateImpact: computePlanAggregateImpact(input.items),
    procurement,
    financeRequired,
    totalProcurementMinor,
  };
}

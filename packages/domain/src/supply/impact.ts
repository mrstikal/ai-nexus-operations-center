import type {
  SupplyDemandLine,
  SupplyImpact,
  SupplyProcurementOption,
  SupplyPurchaseOrder,
  SupplyUnitPriceComparison,
} from '@nexus/contracts';
import {
  addMinor,
  assertMinorBound,
  formatMinor,
  parseMinor,
  penaltyMinor,
} from '../money.js';

export const DAY_MS = 86_400_000;

function outstandingQuantity(line: {
  readonly unreceivedQuantity: number;
}): number {
  return Math.max(0, line.unreceivedQuantity);
}

export function lateWholeDays(arrivalAt: string, promisedDeliveryAt: string): number {
  const delta = new Date(arrivalAt).getTime() - new Date(promisedDeliveryAt).getTime();
  return delta <= 0 ? 0 : Math.floor(delta / DAY_MS);
}

export interface SupplyImpactInput {
  readonly purchaseOrder: SupplyPurchaseOrder;
  readonly demand: readonly SupplyDemandLine[];
  readonly option: SupplyProcurementOption | null;
  readonly waitArrivalAt: string | null;
  readonly uncoveredOrderIds: readonly string[];
  readonly priorAdditionalCommittedMinor: string;
  readonly financeThresholdMinor: string;
}

export function financeApprovalRequired(input: {
  priorAdditionalCommittedMinor: string;
  additionalCommitmentMinor: string;
  financeThresholdMinor: string;
}): {
  cumulativeCommittedMinor: string;
  required: boolean;
} {
  const cumulative = addMinor(
    parseMinor(input.priorAdditionalCommittedMinor),
    parseMinor(input.additionalCommitmentMinor),
  );
  return {
    cumulativeCommittedMinor: formatMinor(cumulative),
    required: cumulative > parseMinor(input.financeThresholdMinor),
  };
}

function comparisonsForOption(
  purchaseOrder: SupplyPurchaseOrder,
  option: SupplyProcurementOption | null,
): SupplyUnitPriceComparison[] {
  if (!option) {
    return [];
  }
  const comparisons: SupplyUnitPriceComparison[] = [];
  for (const item of option.items) {
    const line = purchaseOrder.lines.find(
      (candidate) => candidate.productId === item.productId,
    );
    if (!line) {
      comparisons.push({
        productId: item.productId,
        originalUnitPriceMinor: null,
        offerUnitPriceMinor: item.unitPriceMinor,
        differenceMinor: null,
        missingReason: 'MISSING_ORIGINAL_PURCHASE_ORDER_LINE',
      });
      continue;
    }
    const difference = assertMinorBound(
      parseMinor(item.unitPriceMinor) - parseMinor(line.unitPriceMinor),
    );
    comparisons.push({
      productId: item.productId,
      originalUnitPriceMinor: line.unitPriceMinor,
      offerUnitPriceMinor: item.unitPriceMinor,
      differenceMinor:
        difference < 0n
          ? `-${(-difference).toString()}`
          : formatMinor(difference),
      missingReason: null,
    });
  }
  return comparisons.sort((left, right) =>
    left.productId.localeCompare(right.productId),
  );
}

export function calculateImpact(input: SupplyImpactInput): SupplyImpact {
  const outstanding = input.purchaseOrder.lines.reduce(
    (total, line) =>
      addMinor(
        total,
        parseMinor(line.unitPriceMinor) * BigInt(outstandingQuantity(line)),
      ),
    0n,
  );
  const comparisons = comparisonsForOption(input.purchaseOrder, input.option);
  let exposed = 0n;
  for (const order of input.demand) {
    exposed = addMinor(exposed, parseMinor(order.exposedValueMinor));
  }
  const era = input.option?.latestArrivalAt ?? input.waitArrivalAt;
  const uncovered = new Set(input.uncoveredOrderIds);
  const penaltyMissingFields: string[] = [];
  let penaltyTotal = 0n;
  let penaltyComputable = true;
  for (const order of input.demand) {
    const mustPlanArrival = uncovered.has(order.orderId);
    const plannedArrival = mustPlanArrival
      ? era
      : order.promisedDeliveryAt;
    if (plannedArrival === null) {
      penaltyComputable = false;
      penaltyMissingFields.push(`demand.${order.orderId}.plannedArrival`);
      continue;
    }
    const lateDays = lateWholeDays(plannedArrival, order.promisedDeliveryAt);
    if (lateDays === 0) {
      continue;
    }
    if (
      order.penaltyDailyMinor === null ||
      order.penaltyCapMinor === null
    ) {
      penaltyComputable = false;
      if (order.penaltyDailyMinor === null) {
        penaltyMissingFields.push(`demand.${order.orderId}.penaltyDailyMinor`);
      }
      if (order.penaltyCapMinor === null) {
        penaltyMissingFields.push(`demand.${order.orderId}.penaltyCapMinor`);
      }
      continue;
    }
    penaltyTotal = addMinor(
      penaltyTotal,
      penaltyMinor({
        lateDays,
        dailyMinor: parseMinor(order.penaltyDailyMinor),
        capMinor: parseMinor(order.penaltyCapMinor),
      }),
    );
  }
  const additional = input.option?.additionalCommitmentMinor ?? '0';
  const finance = financeApprovalRequired({
    priorAdditionalCommittedMinor: input.priorAdditionalCommittedMinor,
    additionalCommitmentMinor: additional,
    financeThresholdMinor: input.financeThresholdMinor,
  });
  return {
    describedOptionId: input.option?.optionId ?? null,
    originalPurchaseOrderOutstandingMinor: formatMinor(outstanding),
    unitPriceComparisons: comparisons,
    exposedSalesValueMinor: formatMinor(exposed),
    contractualPenaltyMinor: penaltyComputable
      ? formatMinor(penaltyTotal)
      : null,
    penaltyMissingFields,
    priorAdditionalCommittedMinor: input.priorAdditionalCommittedMinor,
    additionalCommitmentMinor: additional,
    cumulativeCommittedMinor: finance.cumulativeCommittedMinor,
    financeThresholdMinor: input.financeThresholdMinor,
    financeApprovalRequired:
      parseMinor(additional) > 0n && finance.required,
  };
}

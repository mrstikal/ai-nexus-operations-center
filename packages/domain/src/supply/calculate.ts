import {
  SUPPLY_RULE_VERSION,
  SupplyCalculationRequestSchema,
  SupplyCalculationResultSchema,
  type SupplyCalculationRequest,
  type SupplyCalculationResult,
  type SupplyWaitingOption,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '../canonical-json.js';
import { allocateFromStock } from './allocate.js';
import { buildProcurementOptions } from './alternatives.js';
import { calculateImpact } from './impact.js';

const MAX_WAITING_REASONS = 20;

function evaluateWaiting(
  request: SupplyCalculationRequest,
  shortageQuantities: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly orderIds: readonly string[];
  }[],
): SupplyWaitingOption {
  const reasons: string[] = [];
  let reasonLimitReached = false;
  const pushReason = (reason: string): void => {
    if (reasons.length < MAX_WAITING_REASONS - 1) {
      reasons.push(reason);
    } else {
      reasonLimitReached = true;
    }
  };
  const notice = request.supplierNotice;
  const affectedOrderIds = [
    ...new Set(shortageQuantities.flatMap((entry) => [...entry.orderIds])),
  ].sort();
  if (shortageQuantities.length === 0) {
    return {
      feasible: false,
      revisedArrivalAt: notice.revisedArrivalAt,
      affectedOrderIds: [],
      reasons: ['NO_SHORTAGE'],
    };
  }
  if (notice.revisedArrivalAt === null) {
    pushReason('MISSING_REVISED_ARRIVAL');
  }
  const productShortages = new Map<string, number>();
  for (const entry of shortageQuantities) {
    productShortages.set(
      entry.productId,
      (productShortages.get(entry.productId) ?? 0) + entry.quantity,
    );
  }
  const shortProductIds = [...productShortages.keys()].sort();
  const perProduct = notice.revisedProductQuantities ?? [];
  if (perProduct.length > 0) {
    for (const productId of shortProductIds) {
      const entry = perProduct.find(
        (candidate) => candidate.productId === productId,
      );
      if (
        !entry ||
        entry.quantity < (productShortages.get(productId) ?? 0)
      ) {
        pushReason(`REVISED_QUANTITY_INSUFFICIENT:${productId}`);
      }
    }
  } else if (shortProductIds.length > 1) {
    pushReason('MISSING_REVISED_PRODUCT_QUANTITIES');
  } else if (notice.revisedQuantity === null) {
    pushReason('MISSING_REVISED_QUANTITY');
  } else if (
    notice.revisedQuantity < (productShortages.get(shortProductIds[0]!) ?? 0)
  ) {
    pushReason('REVISED_QUANTITY_INSUFFICIENT');
  }
  if (notice.revisedArrivalAt !== null) {
    const arrivalMs = new Date(notice.revisedArrivalAt).getTime();
    const affected = new Set(affectedOrderIds);
    for (const order of request.demand) {
      if (!affected.has(order.orderId)) {
        continue;
      }
      if (new Date(order.promisedDeliveryAt).getTime() >= arrivalMs) {
        continue;
      }
      const tolerance = order.delayToleratedUntil;
      if (
        tolerance === null ||
        new Date(tolerance).getTime() < arrivalMs
      ) {
        pushReason(`CONTRACT_DOES_NOT_ALLOW_DELAY:${order.orderId}`);
      }
    }
  }
  if (reasonLimitReached) {
    reasons.push('REASON_LIMIT_REACHED');
  }
  return {
    feasible: reasons.length === 0,
    revisedArrivalAt: notice.revisedArrivalAt,
    affectedOrderIds,
    reasons,
  };
}

export function calculateSupply(
  input: SupplyCalculationRequest,
): SupplyCalculationResult {
  const request = SupplyCalculationRequestSchema.parse(input);
  const allocation = allocateFromStock({
    inventory: request.inventory,
    demand: request.demand.map((line) => ({
      orderId: line.orderId,
      reference: line.reference,
      productId: line.productId,
      quantity: line.quantity,
      promisedDeliveryAt: line.promisedDeliveryAt,
      version: line.version,
    })),
    excludedPurchaseOrderId: request.purchaseOrder.id,
  });
  const optionSets = buildProcurementOptions({
    asOf: request.asOf,
    shortages: allocation.shortages,
    offers: request.offers,
  });
  const waitingOption = evaluateWaiting(request, allocation.shortages);
  const noProcurementRequired = allocation.shortages.length === 0;
  const completeSet = optionSets.at(-1) ?? null;
  const bestOption = completeSet?.options[0] ?? null;
  const impact = calculateImpact({
    purchaseOrder: request.purchaseOrder,
    demand: request.demand,
    option: bestOption,
    waitArrivalAt: waitingOption.feasible
      ? waitingOption.revisedArrivalAt
      : null,
    uncoveredOrderIds: [
      ...new Set(allocation.shortages.flatMap((entry) => entry.orderIds)),
    ],
    priorAdditionalCommittedMinor: request.priorAdditionalCommittedMinor,
    financeThresholdMinor: request.financeThresholdMinor,
  });

  const missingFields = new Set<string>();
  if (request.supplierNotice.revisedArrivalAt === null) {
    missingFields.add('supplierNotice.revisedArrivalAt');
  }
  if (
    request.supplierNotice.revisedQuantity === null &&
    (request.supplierNotice.revisedProductQuantities?.length ?? 0) === 0
  ) {
    missingFields.add('supplierNotice.revisedQuantity');
  }
  if (
    new Set(allocation.shortages.map((entry) => entry.productId)).size > 1 &&
    (request.supplierNotice.revisedProductQuantities?.length ?? 0) === 0
  ) {
    missingFields.add('supplierNotice.revisedProductQuantities');
  }
  for (const shortage of allocation.shortages) {
    if (!request.offers.some((entry) => entry.productId === shortage.productId)) {
      missingFields.add(`offers.${shortage.productId}`);
    }
  }
  for (const productId of allocation.missingInventoryProductIds) {
    missingFields.add(`inventory.${productId}`);
  }
  for (const field of impact.penaltyMissingFields) {
    missingFields.add(field);
  }

  const agreements = new Map<string, number>();
  for (const productOffers of request.offers) {
    for (const offer of productOffers.offers) {
      agreements.set(offer.agreementId, offer.agreementVersion);
    }
  }
  const entityVersions = {
    purchaseOrder: request.purchaseOrder.version,
    inventory: request.inventory
      .map((line) => ({ productId: line.productId, version: line.version }))
      .sort((left, right) => left.productId.localeCompare(right.productId)),
    demandOrders: request.demand
      .map((line) => ({ orderId: line.orderId, version: line.version }))
      .sort((left, right) => left.orderId.localeCompare(right.orderId)),
    agreements: [...agreements.entries()]
      .map(([agreementId, version]) => ({ agreementId, version }))
      .sort((left, right) => left.agreementId.localeCompare(right.agreementId)),
  };

  const infeasible =
    !noProcurementRequired &&
    optionSets.some((set) => set.options.length === 0) &&
    !waitingOption.feasible;
  const base = {
    ruleVersion: SUPPLY_RULE_VERSION,
    asOf: request.asOf,
    policyRevision: request.policyRevision,
    policyContentHash: request.policyContentHash,
    entityVersions,
    availableForAllocation: allocation.availableForAllocation,
    coverageByDeadline: allocation.coverageByDeadline,
    allocations: allocation.allocations,
    shortages: allocation.shortages,
    optionSets,
    waitingOption,
    impact,
    noProcurementRequired,
    infeasible,
    missingFields: [...missingFields].sort(),
  };
  return SupplyCalculationResultSchema.parse({
    ...base,
    inputHash: canonicalJsonSha256(request),
    resultHash: canonicalJsonSha256(base),
  });
}

import type {
  SupplyAllocation,
  SupplyInbound,
  SupplyInventoryLine,
  SupplyShortage,
} from '@nexus/contracts';

export interface DemandForAllocation {
  readonly orderId: string;
  readonly reference: string;
  readonly productId: string;
  readonly quantity: number;
  readonly promisedDeliveryAt: string;
  readonly version: number;
}

export interface AllocationInput {
  readonly inventory: readonly SupplyInventoryLine[];
  readonly demand: readonly DemandForAllocation[];
  readonly excludedPurchaseOrderId: string;
}

export interface CoveragePoint {
  readonly productId: string;
  readonly deadline: string;
  readonly quantity: number;
}

export interface AllocationResult {
  readonly allocations: SupplyAllocation[];
  readonly shortages: SupplyShortage[];
  readonly coverageByDeadline: CoveragePoint[];
  readonly availableForAllocation: Array<{ readonly productId: string; readonly quantity: number }>;
  readonly missingInventoryProductIds: string[];
}

export function availableForAllocation(item: {
  readonly onHandQuantity: number;
  readonly activeReservations: number;
}): number {
  return Math.max(0, item.onHandQuantity - item.activeReservations);
}

export function coverageByDeadline(
  item: SupplyInventoryLine,
  deadline: string,
  excludedPurchaseOrderId: string | null,
): number {
  const deadlineMs = new Date(deadline).getTime();
  let quantity = availableForAllocation(item);
  for (const inbound of item.confirmedInbound) {
    if (
      excludedPurchaseOrderId !== null &&
      inbound.purchaseOrderId === excludedPurchaseOrderId
    ) {
      continue;
    }
    if (new Date(inbound.arrivalAt).getTime() <= deadlineMs) {
      quantity += inbound.quantity;
    }
  }
  return quantity;
}

function sortInbound(inbound: readonly SupplyInbound[]): SupplyInbound[] {
  return [...inbound].sort((left, right) => {
    const byArrival = left.arrivalAt.localeCompare(right.arrivalAt);
    return byArrival !== 0
      ? byArrival
      : left.purchaseOrderId.localeCompare(right.purchaseOrderId);
  });
}

export function allocateFromStock(input: AllocationInput): AllocationResult {
  const inventoryByProduct = new Map(
    input.inventory.map((item) => [item.productId, item]),
  );
  const allocations: SupplyAllocation[] = [];
  const shortagesByKey = new Map<
    string,
    { productId: string; deadline: string; quantity: number; orderIds: string[] }
  >();
  const coverage: CoveragePoint[] = [];
  const seenCoverage = new Set<string>();
  const missingInventoryProductIds: string[] = [];

  const demandByProduct = new Map<string, DemandForAllocation[]>();
  for (const line of input.demand) {
    const bucket = demandByProduct.get(line.productId) ?? [];
    bucket.push(line);
    demandByProduct.set(line.productId, bucket);
  }
  const productIds = [...demandByProduct.keys()].sort();
  for (const productId of productIds) {
    const item = inventoryByProduct.get(productId);
    if (!item) {
      missingInventoryProductIds.push(productId);
    }
    const demand = [...(demandByProduct.get(productId) ?? [])].sort(
      (left, right) => {
        const byDeadline = left.promisedDeliveryAt.localeCompare(
          right.promisedDeliveryAt,
        );
        return byDeadline !== 0
          ? byDeadline
          : left.orderId.localeCompare(right.orderId);
      },
    );
    const inbound = item
      ? sortInbound(item.confirmedInbound).filter(
          (entry) => entry.purchaseOrderId !== input.excludedPurchaseOrderId,
        )
      : [];
    let inboundIndex = 0;
    let remainingSupply = item ? availableForAllocation(item) : 0;
    for (const line of demand) {
      const deadlineMs = new Date(line.promisedDeliveryAt).getTime();
      while (
        inboundIndex < inbound.length &&
        new Date(inbound[inboundIndex]!.arrivalAt).getTime() <= deadlineMs
      ) {
        remainingSupply += inbound[inboundIndex]!.quantity;
        inboundIndex += 1;
      }
      const allocated = Math.min(line.quantity, remainingSupply);
      remainingSupply -= allocated;
      const shortage = line.quantity - allocated;
      allocations.push({
        orderId: line.orderId,
        reference: line.reference,
        productId: line.productId,
        requestedQuantity: line.quantity,
        allocatedQuantity: allocated,
        shortageQuantity: shortage,
        promisedDeliveryAt: line.promisedDeliveryAt,
        version: line.version,
      });
      const coverageKey = `${productId}:${line.promisedDeliveryAt}`;
      if (!seenCoverage.has(coverageKey)) {
        seenCoverage.add(coverageKey);
        coverage.push({
          productId,
          deadline: line.promisedDeliveryAt,
          quantity: item
            ? coverageByDeadline(
                item,
                line.promisedDeliveryAt,
                input.excludedPurchaseOrderId,
              )
            : 0,
        });
      }
      if (shortage > 0) {
        const key = `${productId}:${line.promisedDeliveryAt}`;
        const aggregate = shortagesByKey.get(key) ?? {
          productId,
          deadline: line.promisedDeliveryAt,
          quantity: 0,
          orderIds: [],
        };
        aggregate.quantity += shortage;
        aggregate.orderIds.push(line.orderId);
        shortagesByKey.set(key, aggregate);
      }
    }
  }

  const shortages = [...shortagesByKey.values()]
    .sort((left, right) => {
      const byDeadline = left.deadline.localeCompare(right.deadline);
      return byDeadline !== 0
        ? byDeadline
        : left.productId.localeCompare(right.productId);
    })
    .map((entry) => ({
      productId: entry.productId,
      deadline: entry.deadline,
      quantity: entry.quantity,
      orderIds: [...entry.orderIds].sort(),
    }));
  const available = input.inventory
    .map((item) => ({
      productId: item.productId,
      quantity: availableForAllocation(item),
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  for (const productId of missingInventoryProductIds) {
    if (!available.some((entry) => entry.productId === productId)) {
      available.push({ productId, quantity: 0 });
    }
  }
  available.sort((left, right) => left.productId.localeCompare(right.productId));
  return {
    allocations,
    shortages,
    coverageByDeadline: coverage,
    availableForAllocation: available,
    missingInventoryProductIds,
  };
}

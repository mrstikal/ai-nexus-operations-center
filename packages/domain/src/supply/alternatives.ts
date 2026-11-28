import {
  SUPPLY_MAX_SUPPLIERS,
  type SupplyOffer,
  type SupplyProcurementItem,
  type SupplyProcurementOption,
  type SupplyProductOffers,
  type SupplyRejectedOffer,
  type SupplyRejectedOption,
  type SupplyShortage,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '../canonical-json.js';
import { addMinor, formatMinor, parseMinor } from '../money.js';

export interface DeadlineOptionSet {
  readonly deadline: string;
  readonly options: SupplyProcurementOption[];
  readonly rejectedOffers: SupplyRejectedOffer[];
  readonly rejectedOptions: SupplyRejectedOption[];
}

export interface ProcurementSearchInput {
  readonly asOf: string;
  readonly shortages: readonly SupplyShortage[];
  readonly offers: readonly SupplyProductOffers[];
}

interface OfferEvaluation {
  readonly offer: SupplyOffer;
  readonly productId: string;
  readonly reasonCode: SupplyRejectedOffer['reasonCode'] | null;
}

function isoMs(value: string): number {
  return new Date(value).getTime();
}

function maxIso(values: readonly string[]): string {
  return values.reduce((latest, value) =>
    isoMs(value) > isoMs(latest) ? value : latest,
  );
}

const MAX_CANDIDATE_SUPPLIERS = 20;
const MAX_OPTIONS_PER_SET = 100;
const MAX_REJECTED_OPTIONS = 1000;
const MAX_REJECTED_OFFERS = 1000;
const MAX_ITEMS_PER_OPTION = 100;

function evaluateOffer(
  offer: SupplyOffer,
  productId: string,
  deadline: string,
  asOf: string,
): OfferEvaluation {
  let reason: SupplyRejectedOffer['reasonCode'] | null = null;
  if (offer.supplierStatus !== 'active') {
    reason = 'SUPPLIER_INACTIVE';
  } else if (offer.agreementStatus !== 'approved') {
    reason = 'AGREEMENT_NOT_APPROVED';
  } else if (
    !offer.currentlyValid ||
    isoMs(offer.validFrom) > isoMs(asOf) ||
    isoMs(offer.validTo) < isoMs(asOf)
  ) {
    reason = 'AGREEMENT_NOT_CURRENT';
  } else if (offer.currency !== 'EUR') {
    reason = 'CURRENCY_MISMATCH';
  } else if (offer.capacityQuantity <= 0) {
    reason = 'ZERO_CAPACITY';
  } else if (parseMinor(offer.unitPriceMinor) < 0n) {
    reason = 'NEGATIVE_PRICE';
  } else if (isoMs(offer.latestArrivalAt) > isoMs(deadline)) {
    reason = 'LATE_ARRIVAL';
  }
  return { offer, productId, reasonCode: reason };
}

function optionIdFor(deadline: string, items: readonly SupplyProcurementItem[]): string {
  return canonicalJsonSha256({
    deadline,
    items: items
      .map((item) => ({
        agreementId: item.agreementId,
        productId: item.productId,
        quantity: item.quantity,
        supplierId: item.supplierId,
        unitPriceMinor: item.unitPriceMinor,
        expediteChargeMinor: item.expediteChargeMinor,
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId)),
  }).slice(0, 20);
}

function requirementsForDeadline(
  shortages: readonly SupplyShortage[],
  deadline: string,
): Map<string, number> {
  const requirement = new Map<string, number>();
  const deadlineMs = isoMs(deadline);
  for (const shortage of shortages) {
    if (isoMs(shortage.deadline) > deadlineMs) {
      continue;
    }
    requirement.set(
      shortage.productId,
      (requirement.get(shortage.productId) ?? 0) + shortage.quantity,
    );
  }
  return requirement;
}

function subsetsOfAtMostTwo(
  supplierIds: readonly string[],
): string[][] {
  const subsets: string[][] = [];
  for (let index = 0; index < supplierIds.length; index += 1) {
    subsets.push([supplierIds[index]!]);
  }
  if (SUPPLY_MAX_SUPPLIERS >= 2) {
    for (let left = 0; left < supplierIds.length; left += 1) {
      for (let right = left + 1; right < supplierIds.length; right += 1) {
        subsets.push([supplierIds[left]!, supplierIds[right]!]);
      }
    }
  }
  return subsets;
}

function buildOptionForSubset(input: {
  readonly deadline: string;
  readonly requirements: ReadonlyMap<string, number>;
  readonly offersByProduct: ReadonlyMap<string, readonly OfferEvaluation[]>;
  readonly supplierIds: readonly string[];
}): {
  readonly option: SupplyProcurementOption | null;
  readonly failure: 'INSUFFICIENT_CAPACITY' | 'ITEM_LIMIT_REACHED' | null;
} {
  const items: SupplyProcurementItem[] = [];
  const contributingSuppliers = new Set<string>();
  let goods = 0n;
  let expedite = 0n;
  for (const [productId, quantity] of [...input.requirements.entries()].sort(
    (left, right) => left[0].localeCompare(right[0]),
  )) {
    const candidates = (input.offersByProduct.get(productId) ?? [])
      .filter(
        (entry) =>
          entry.reasonCode === null &&
          input.supplierIds.includes(entry.offer.supplierId),
      )
      .sort((left, right) => {
        const leftPrice = parseMinor(left.offer.unitPriceMinor);
        const rightPrice = parseMinor(right.offer.unitPriceMinor);
        if (leftPrice !== rightPrice) {
          return leftPrice < rightPrice ? -1 : 1;
        }
        const byArrival = isoMs(left.offer.latestArrivalAt) -
          isoMs(right.offer.latestArrivalAt);
        if (byArrival !== 0) {
          return byArrival;
        }
        return left.offer.agreementId.localeCompare(right.offer.agreementId);
      });
    let remaining = quantity;
    for (const candidate of candidates) {
      if (remaining <= 0) {
        break;
      }
      if (items.length >= MAX_ITEMS_PER_OPTION) {
        return { option: null, failure: 'ITEM_LIMIT_REACHED' };
      }
      const taken = Math.min(remaining, candidate.offer.capacityQuantity);
      if (taken <= 0) {
        continue;
      }
      const unitPrice = parseMinor(candidate.offer.unitPriceMinor);
      const lineGoods = unitPrice * BigInt(taken);
      goods = addMinor(goods, lineGoods);
      expedite = addMinor(
        expedite,
        parseMinor(candidate.offer.expediteChargeMinor),
      );
      remaining -= taken;
      contributingSuppliers.add(candidate.offer.supplierId);
      items.push({
        productId,
        agreementId: candidate.offer.agreementId,
        supplierId: candidate.offer.supplierId,
        supplierReference: candidate.offer.supplierReference,
        quantity: taken,
        unitPriceMinor: candidate.offer.unitPriceMinor,
        goodsMinor: formatMinor(lineGoods),
        expediteChargeMinor: candidate.offer.expediteChargeMinor,
        latestArrivalAt: candidate.offer.latestArrivalAt,
      });
    }
    if (remaining > 0) {
      return { option: null, failure: 'INSUFFICIENT_CAPACITY' };
    }
  }
  if (
    items.length === 0 ||
    [...contributingSuppliers].sort().join(',') !==
      [...input.supplierIds].sort().join(',')
  ) {
    return { option: null, failure: null };
  }
  const suppliers = [...contributingSuppliers]
    .sort()
    .map((supplierId) => {
      const item = items.find((entry) => entry.supplierId === supplierId)!;
      return {
        supplierId,
        supplierReference: item.supplierReference,
      };
    });
  const additional = addMinor(goods, expedite);
  return {
    option: {
      optionId: optionIdFor(input.deadline, items),
      deadline: input.deadline,
      kind: 'procure',
      suppliers,
      items,
      goodsTotalMinor: formatMinor(goods),
      expediteTotalMinor: formatMinor(expedite),
      additionalCommitmentMinor: formatMinor(additional),
      latestArrivalAt: maxIso(items.map((item) => item.latestArrivalAt)),
      rank: 0,
    },
    failure: null,
  };
}

export function buildProcurementOptions(
  input: ProcurementSearchInput,
): DeadlineOptionSet[] {
  const deadlines = [...new Set(input.shortages.map((entry) => entry.deadline))]
    .sort((left, right) => isoMs(left) - isoMs(right));
  const sets: DeadlineOptionSet[] = [];
  for (const deadline of deadlines) {
    const requirements = requirementsForDeadline(input.shortages, deadline);
    const offersByProduct = new Map<string, OfferEvaluation[]>();
    const options: SupplyProcurementOption[] = [];
    const rejectedOptions: SupplyRejectedOption[] = [];
    const rejectedOffers: SupplyRejectedOffer[] = [];
    const pushRejection = (rejection: SupplyRejectedOption): void => {
      if (rejectedOptions.length < MAX_REJECTED_OPTIONS) {
        rejectedOptions.push(rejection);
      }
    };
    let rejectedOffersTruncated = false;
    for (const productOffers of input.offers) {
      if (!requirements.has(productOffers.productId)) {
        continue;
      }
      const evaluated = productOffers.offers.map((offer) =>
        evaluateOffer(offer, productOffers.productId, deadline, input.asOf),
      );
      offersByProduct.set(productOffers.productId, evaluated);
      for (const entry of evaluated) {
        if (entry.reasonCode !== null) {
          if (rejectedOffers.length < MAX_REJECTED_OFFERS) {
            rejectedOffers.push({
              productId: entry.productId,
              agreementId: entry.offer.agreementId,
              supplierId: entry.offer.supplierId,
              reasonCode: entry.reasonCode,
            });
          } else {
            rejectedOffersTruncated = true;
          }
        }
      }
    }
    if (rejectedOffersTruncated) {
      pushRejection({
        deadline,
        supplierIds: [],
        reasonCode: 'OFFER_LIMIT_REACHED',
      });
    }
    const eligibleOffers = [...offersByProduct.values()]
      .flat()
      .filter((entry) => entry.reasonCode === null);
    const allSupplierIds = [
      ...new Set(eligibleOffers.map((entry) => entry.offer.supplierId)),
    ].sort();
    const supplierStats = new Map<
      string,
      { readonly price: bigint; readonly arrivalMs: number }
    >();
    for (const entry of eligibleOffers) {
      const price = parseMinor(entry.offer.unitPriceMinor);
      const arrivalMs = isoMs(entry.offer.latestArrivalAt);
      const current = supplierStats.get(entry.offer.supplierId);
      if (
        !current ||
        price < current.price ||
        (price === current.price && arrivalMs < current.arrivalMs)
      ) {
        supplierStats.set(entry.offer.supplierId, { price, arrivalMs });
      }
    }
    const compareSuppliers = (left: string, right: string): number => {
      const leftStats = supplierStats.get(left)!;
      const rightStats = supplierStats.get(right)!;
      if (leftStats.price !== rightStats.price) {
        return leftStats.price < rightStats.price ? -1 : 1;
      }
      if (leftStats.arrivalMs !== rightStats.arrivalMs) {
        return leftStats.arrivalMs - rightStats.arrivalMs;
      }
      return left.localeCompare(right);
    };
    const priceSorted = [...allSupplierIds].sort(compareSuppliers);
    const cheapestPerProduct = new Set<string>();
    const sufficientSuppliers = new Set<string>();
    for (const [productId, required] of requirements) {
      const entries = (offersByProduct.get(productId) ?? []).filter(
        (entry) => entry.reasonCode === null,
      );
      if (entries.length === 0) {
        continue;
      }
      const byPrice = [...entries].sort((left, right) => {
        const leftPrice = parseMinor(left.offer.unitPriceMinor);
        const rightPrice = parseMinor(right.offer.unitPriceMinor);
        if (leftPrice !== rightPrice) {
          return leftPrice < rightPrice ? -1 : 1;
        }
        const byArrival =
          isoMs(left.offer.latestArrivalAt) - isoMs(right.offer.latestArrivalAt);
        return byArrival !== 0
          ? byArrival
          : left.offer.agreementId.localeCompare(right.offer.agreementId);
      });
      const byCapacity = [...entries].sort((left, right) => {
        if (left.offer.capacityQuantity !== right.offer.capacityQuantity) {
          return right.offer.capacityQuantity - left.offer.capacityQuantity;
        }
        return byPrice.indexOf(left) - byPrice.indexOf(right);
      });
      const retainAnchor = (anchor: OfferEvaluation | undefined): void => {
        if (!anchor) {
          return;
        }
        cheapestPerProduct.add(anchor.offer.supplierId);
        const remaining = required - anchor.offer.capacityQuantity;
        if (remaining <= 0) {
          return;
        }
        const partner = byPrice.find(
          (entry) =>
            entry.offer.supplierId !== anchor.offer.supplierId &&
            entry.offer.capacityQuantity >= remaining,
        );
        if (partner) {
          cheapestPerProduct.add(partner.offer.supplierId);
        }
      };
      retainAnchor(byPrice[0]);
      retainAnchor(byCapacity[0]);
      const sufficient = byPrice.find(
        (entry) => entry.offer.capacityQuantity >= required,
      );
      if (sufficient) {
        sufficientSuppliers.add(sufficient.offer.supplierId);
      }
    }
    const mustRetain = [
      ...new Set([...sufficientSuppliers, ...cheapestPerProduct]),
    ].sort((left, right) => {
      const leftCoverage = sufficientSuppliers.has(left) ? 0 : 1;
      const rightCoverage = sufficientSuppliers.has(right) ? 0 : 1;
      return leftCoverage !== rightCoverage
        ? leftCoverage - rightCoverage
        : compareSuppliers(left, right);
    });
    const retained: string[] = [];
    for (const supplierId of mustRetain) {
      if (retained.length < MAX_CANDIDATE_SUPPLIERS) {
        retained.push(supplierId);
      }
    }
    for (const supplierId of priceSorted) {
      if (
        !retained.includes(supplierId) &&
        retained.length < MAX_CANDIDATE_SUPPLIERS
      ) {
        retained.push(supplierId);
      }
    }
    const supplierIds = [...retained].sort();
    if (supplierIds.length === 0) {
      pushRejection({
        deadline,
        supplierIds: [],
        reasonCode: 'NO_ELIGIBLE_OFFERS',
      });
    } else if (retained.length < allSupplierIds.length) {
      pushRejection({
        deadline,
        supplierIds: [],
        reasonCode: 'SUPPLIER_LIMIT',
      });
    }
    for (const subset of subsetsOfAtMostTwo(supplierIds)) {
      const result = buildOptionForSubset({
        deadline,
        requirements,
        offersByProduct,
        supplierIds: subset,
      });
      if (result.option) {
        options.push(result.option);
      } else if (result.failure !== null) {
        pushRejection({
          deadline,
          supplierIds: subset,
          reasonCode: result.failure,
        });
      }
    }
    options.sort((left, right) => {
      const leftTotal = parseMinor(left.additionalCommitmentMinor);
      const rightTotal = parseMinor(right.additionalCommitmentMinor);
      if (leftTotal !== rightTotal) {
        return leftTotal < rightTotal ? -1 : 1;
      }
      const byArrival = isoMs(left.latestArrivalAt) - isoMs(right.latestArrivalAt);
      if (byArrival !== 0) {
        return byArrival;
      }
      const leftSuppliers = left.suppliers
        .map((entry) => entry.supplierId)
        .sort()
        .join(',');
      const rightSuppliers = right.suppliers
        .map((entry) => entry.supplierId)
        .sort()
        .join(',');
      const bySupplier = leftSuppliers.localeCompare(rightSuppliers);
      return bySupplier !== 0
        ? bySupplier
        : left.optionId.localeCompare(right.optionId);
    });
    const uniqueOptions: SupplyProcurementOption[] = [];
    const seen = new Set<string>();
    for (const option of options) {
      if (!seen.has(option.optionId)) {
        seen.add(option.optionId);
        if (uniqueOptions.length < MAX_OPTIONS_PER_SET) {
          uniqueOptions.push(option);
        } else {
          pushRejection({
            deadline,
            supplierIds: option.suppliers.map((entry) => entry.supplierId),
            reasonCode: 'OPTION_LIMIT_REACHED',
          });
        }
      }
    }
    sets.push({
      deadline,
      options: uniqueOptions.map((option, index) => ({
        ...option,
        rank: index + 1,
      })),
      rejectedOffers,
      rejectedOptions,
    });
  }
  return sets;
}

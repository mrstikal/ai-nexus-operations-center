import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RegisteredToolDefinitionSchema,
  SupplyScenarioFixtureSchema,
  type SupplyCalculationRequest,
  type SupplyRecommendationInput,
} from '@nexus/contracts';
import { calculateSupply } from '@nexus/domain/supply/calculate';
import {
  allocateFromStock,
  availableForAllocation,
  coverageByDeadline,
} from '@nexus/domain/supply/allocate';
import { buildProcurementOptions } from '@nexus/domain/supply/alternatives';
import { financeApprovalRequired } from '@nexus/domain/supply/impact';
import { createSupplyCalculationToolDefinition } from '@nexus/integrations/tools/supply-calculation';
import {
  buildCalculationEvidence,
  type CitedEvidenceRecord,
} from '@nexus/application/verification/citations';
import { verifySupplyRecommendation } from '@nexus/application/verification/deterministic';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureDir = path.join(root, 'fixtures/scenarios');
const fixtureFiles = [
  'a-partial-split.json',
  'a-wait-and-notify.json',
  'a-no-feasible.json',
  'a-full-on-hand.json',
  'a-full-procurement-boundary.json',
  'a-multi-deadline-infeasible.json',
  'a-multi-product-wait.json',
] as const;

function loadFixture(name: (typeof fixtureFiles)[number]) {
  return SupplyScenarioFixtureSchema.parse(
    JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8')),
  );
}

function boundaryRequest(): SupplyCalculationRequest {
  return structuredClone(loadFixture('a-full-procurement-boundary.json').request);
}

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

describe('F19 supply allocation', () => {
  it('uses unreserved on-hand stock only and reports zero, partial and full allocation', () => {
    const inventory = [
      {
        productId: PRODUCT_ID,
        sku: 'NS-100',
        onHandQuantity: 10,
        activeReservations: 4,
        confirmedInbound: [],
        version: 1,
      },
    ];
    expect(availableForAllocation(inventory[0]!)).toBe(6);
    const demand = [
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
        reference: 'SO-1',
        productId: PRODUCT_ID,
        quantity: 6,
        promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
        version: 1,
      },
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
        reference: 'SO-2',
        productId: PRODUCT_ID,
        quantity: 4,
        promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
        version: 1,
      },
    ];
    const result = allocateFromStock({
      inventory,
      demand,
      excludedPurchaseOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(
      result.allocations.map((entry) => entry.allocatedQuantity),
    ).toEqual([6, 0]);
    expect(result.allocations.map((entry) => entry.shortageQuantity)).toEqual([
      0, 4,
    ]);
    expect(result.shortages).toEqual([
      {
        productId: PRODUCT_ID,
        deadline: '2026-11-06T17:00:00.000Z',
        quantity: 4,
        orderIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccc02'],
      },
    ]);
  });

  it('includes confirmed inbound in coverageByDeadline but never in availableForAllocation', () => {
    const item = {
      productId: PRODUCT_ID,
      sku: 'NS-100',
      onHandQuantity: 5,
      activeReservations: 1,
      confirmedInbound: [
        {
          purchaseOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          purchaseOrderReference: 'PO-2',
          quantity: 7,
          arrivalAt: '2026-11-04T17:00:00.000Z',
        },
        {
          purchaseOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          purchaseOrderReference: 'PO-1',
          quantity: 100,
          arrivalAt: '2026-11-04T17:00:00.000Z',
        },
      ],
      version: 1,
    };
    expect(availableForAllocation(item)).toBe(4);
    expect(
      coverageByDeadline(
        item,
        '2026-11-06T17:00:00.000Z',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).toBe(11);
    expect(
      coverageByDeadline(
        item,
        '2026-11-03T17:00:00.000Z',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).toBe(4);
  });

  it('allocates overlapping demand in deadline then order-ID order and never double-counts stock', () => {
    const inventory = [
      {
        productId: PRODUCT_ID,
        sku: 'NS-100',
        onHandQuantity: 10,
        activeReservations: 0,
        confirmedInbound: [],
        version: 1,
      },
    ];
    const demand = [
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
        reference: 'SO-2',
        productId: PRODUCT_ID,
        quantity: 8,
        promisedDeliveryAt: '2026-11-05T17:00:00.000Z',
        version: 1,
      },
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
        reference: 'SO-1',
        productId: PRODUCT_ID,
        quantity: 8,
        promisedDeliveryAt: '2026-11-04T17:00:00.000Z',
        version: 1,
      },
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc03',
        reference: 'SO-3',
        productId: PRODUCT_ID,
        quantity: 5,
        promisedDeliveryAt: '2026-11-05T17:00:00.000Z',
        version: 1,
      },
    ];
    const result = allocateFromStock({
      inventory,
      demand,
      excludedPurchaseOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(
      result.allocations.map((entry) => ({
        orderId: entry.orderId.slice(-2),
        allocated: entry.allocatedQuantity,
      })),
    ).toEqual([
      { orderId: '01', allocated: 8 },
      { orderId: '02', allocated: 2 },
      { orderId: '03', allocated: 0 },
    ]);
    const shortages = result.shortages.reduce(
      (total, shortage) => total + shortage.quantity,
      0,
    );
    expect(shortages).toBe(11);
  });
});

describe('F19 alternative search', () => {
  it('covers every A fixture with an explicit option set and exact impact', () => {
    for (const file of fixtureFiles) {
      const fixture = loadFixture(file);
      const result = calculateSupply(fixture.request);
      const firstOption = result.optionSets.at(-1)?.options[0] ?? null;
      const supplierReferences = firstOption
        ? firstOption.suppliers.map((supplier) => supplier.supplierReference)
        : [];
      expect(
        {
          noProcurementRequired: result.noProcurementRequired,
          waitingFeasible: result.waitingOption.feasible,
          infeasible: result.infeasible,
          financeApprovalRequired: result.impact.financeApprovalRequired,
          additionalCommitmentMinor: result.impact.additionalCommitmentMinor,
          bestOptionSuppliers: firstOption ? [supplierReferences] : [],
          penalties: result.impact.contractualPenaltyMinor,
        },
        file,
      ).toEqual(fixture.expected);
      const repeated = calculateSupply(structuredClone(fixture.request));
      expect(repeated.resultHash, file).toBe(result.resultHash);
      expect(repeated.inputHash, file).toBe(result.inputHash);
    }
  });

  it('ranks equal-cost options by arrival then supplier ID with stable option IDs', () => {
    const deadline = '2026-11-06T17:00:00.000Z';
    const offer = (supplierId: string, supplierReference: string) => ({
      agreementId: randomUUID(),
      agreementReference: `AGR-${supplierReference}`,
      agreementVersion: 1,
      agreementStatus: 'approved' as const,
      currentlyValid: true,
      supplierId,
      supplierReference,
      supplierStatus: 'active' as const,
      unitPriceMinor: '1000',
      currency: 'EUR' as const,
      capacityQuantity: 10,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
    });
    const offers = [
      {
        productId: PRODUCT_ID,
        offers: [
          offer('ffffffff-ffff-4fff-8fff-ffffffffffff', 'SUP-Z'),
          offer('dddddddd-dddd-4ddd-8ddd-dddddddddd01', 'SUP-A'),
        ],
      },
    ];
    const result = buildProcurementOptions({
      asOf: '2026-11-03T09:00:00.000Z',
      shortages: [
        { productId: PRODUCT_ID, deadline, quantity: 10, orderIds: [randomUUID()] },
      ],
      offers,
    });
    expect(result).toHaveLength(1);
    expect(
      result[0]!.options.map((option) => option.suppliers[0]!.supplierReference),
    ).toEqual(['SUP-A', 'SUP-Z']);
    expect(result[0]!.options.map((option) => option.rank)).toEqual([1, 2]);
    const again = buildProcurementOptions({
      asOf: '2026-11-03T09:00:00.000Z',
      shortages: [
        { productId: PRODUCT_ID, deadline, quantity: 10, orderIds: [randomUUID()] },
      ],
      offers,
    });
    expect(again[0]!.options.map((option) => option.optionId)).toEqual(
      result[0]!.options.map((option) => option.optionId),
    );
  });

  it('splits across at most two suppliers and reports rejected offers with reasons', () => {
    const deadline = '2026-11-06T17:00:00.000Z';
    const baseOffer = (supplierId: string, overrides: Record<string, unknown>) => ({
      agreementId: randomUUID(),
      agreementReference: `AGR-${supplierId.slice(-4)}`,
      agreementVersion: 1,
      agreementStatus: 'approved' as const,
      currentlyValid: true,
      supplierId,
      supplierReference: `SUP-${supplierId.slice(-4)}`,
      supplierStatus: 'active' as const,
      unitPriceMinor: '1000',
      currency: 'EUR' as const,
      capacityQuantity: 5,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
      ...overrides,
    });
    const result = buildProcurementOptions({
      asOf: '2026-11-03T09:00:00.000Z',
      shortages: [
        { productId: PRODUCT_ID, deadline, quantity: 10, orderIds: [randomUUID()] },
      ],
      offers: [
        {
          productId: PRODUCT_ID,
          offers: [
            baseOffer('dddddddd-dddd-4ddd-8ddd-dddddddddd01', {}),
            baseOffer('dddddddd-dddd-4ddd-8ddd-dddddddddd02', {}),
            baseOffer('dddddddd-dddd-4ddd-8ddd-dddddddddd03', {
              agreementStatus: 'pending',
            }),
            baseOffer('dddddddd-dddd-4ddd-8ddd-dddddddddd04', {
              latestArrivalAt: '2026-11-09T17:00:00.000Z',
            }),
          ],
        },
      ],
    });
    const set = result[0]!;
    expect(set.options).toHaveLength(1);
    expect(set.options[0]!.suppliers).toHaveLength(2);
    expect(
      set.rejectedOffers.map((entry) => entry.reasonCode).sort(),
    ).toEqual(['AGREEMENT_NOT_APPROVED', 'LATE_ARRIVAL']);
  });
});

describe('F19 financial impact and deterministic verification', () => {
  it('applies the cumulative finance threshold with the exact EUR 500 boundary', () => {
    expect(
      financeApprovalRequired({
        priorAdditionalCommittedMinor: '30000',
        additionalCommitmentMinor: '20000',
        financeThresholdMinor: '50000',
      }),
    ).toEqual({ cumulativeCommittedMinor: '50000', required: false });
    expect(
      financeApprovalRequired({
        priorAdditionalCommittedMinor: '30000',
        additionalCommitmentMinor: '20001',
        financeThresholdMinor: '50000',
      }),
    ).toEqual({ cumulativeCommittedMinor: '50001', required: true });
    expect(
      financeApprovalRequired({
        priorAdditionalCommittedMinor: '25000',
        additionalCommitmentMinor: '25001',
        financeThresholdMinor: '50000',
      }).required,
    ).toBe(true);
  });

  it('computes the original outstanding commitment, exposed value and capped penalties exactly', () => {
    const fixture = loadFixture('a-wait-and-notify.json');
    const request = structuredClone(fixture.request);
    request.supplierNotice.revisedArrivalAt = '2026-11-11T17:00:00.000Z';
    request.demand[0]!.delayToleratedUntil = '2026-11-12T17:00:00.000Z';
    const result = calculateSupply(request);
    expect(result.waitingOption.feasible).toBe(true);
    expect(result.impact.contractualPenaltyMinor).toBe('2500');
    expect(result.impact.originalPurchaseOrderOutstandingMinor).toBe('400000');
    expect(result.impact.exposedSalesValueMinor).toBe('40000');

    const noTerms = structuredClone(request);
    noTerms.demand[0]!.penaltyDailyMinor = null;
    noTerms.demand[0]!.penaltyCapMinor = null;
    const missing = calculateSupply(noTerms);
    expect(missing.impact.contractualPenaltyMinor).toBeNull();
    expect(missing.impact.penaltyMissingFields.length).toBe(2);
    expect(missing.missingFields).toContain(
      `demand.${request.demand[0]!.orderId}.penaltyDailyMinor`,
    );
  });

  it('escalates when a later affected deadline has no feasible option and rejects an early-only selection', () => {
    const fixture = loadFixture('a-multi-deadline-infeasible.json');
    const result = calculateSupply(fixture.request);
    expect(result.optionSets).toHaveLength(2);
    expect(result.optionSets[0]!.options).toHaveLength(1);
    expect(result.optionSets[1]!.options).toHaveLength(0);
    expect(result.infeasible).toBe(true);
    expect(result.impact.additionalCommitmentMinor).toBe('0');
    expect(result.impact.describedOptionId).toBeNull();
    const evidenceId = randomUUID();
    const payload = buildCalculationEvidence(result);
    const verification = verifySupplyRecommendation({
      recommendation: {
        optionIds: [result.optionSets[0]!.options[0]!.optionId],
        claims: [],
        evidenceIds: [evidenceId],
      },
      calculation: result,
      evidence: new Map([
        [
          evidenceId,
          {
            id: evidenceId,
            kind: 'calculation',
            contentHash: payload.contentHash,
            capturedFacts: payload.capturedFacts,
          },
        ],
      ]),
    });
    expect(verification.ok).toBe(false);
    expect(verification.findings.map((finding) => finding.code)).toContain(
      'INFEASIBLE_OPTION_SELECTED',
    );
  });

  it('escalates when an earlier deadline has no feasible option even if a later deadline does', () => {
    const fixture = loadFixture('a-multi-deadline-infeasible.json');
    const request = structuredClone(fixture.request);
    request.offers[0]!.offers[0]!.capacityQuantity = 40;
    request.offers[0]!.offers[0]!.latestArrivalAt = '2026-11-06T20:00:00.000Z';
    const result = calculateSupply(request);
    expect(result.optionSets).toHaveLength(2);
    expect(result.optionSets[0]!.options).toHaveLength(0);
    expect(result.optionSets[1]!.options.length).toBeGreaterThan(0);
    expect(result.infeasible).toBe(true);
  });

  it('requires per-product notice quantities when several products are short', () => {
    const fixture = loadFixture('a-multi-product-wait.json');
    const complete = calculateSupply(fixture.request);
    expect(complete.waitingOption.feasible).toBe(true);
    expect(complete.infeasible).toBe(false);

    const partial = structuredClone(fixture.request);
    partial.supplierNotice.revisedProductQuantities = [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        quantity: 30,
      },
    ];
    const secondProduct = '22222222-2222-4222-8222-222222222222';
    const incomplete = calculateSupply(partial);
    expect(incomplete.waitingOption.feasible).toBe(false);
    expect(incomplete.waitingOption.reasons).toContain(
      `REVISED_QUANTITY_INSUFFICIENT:${secondProduct}`,
    );
    expect(incomplete.infeasible).toBe(true);

    const noBreakdown = structuredClone(fixture.request);
    delete noBreakdown.supplierNotice.revisedProductQuantities;
    const missingBreakdown = calculateSupply(noBreakdown);
    expect(missingBreakdown.waitingOption.reasons).toContain(
      'MISSING_REVISED_PRODUCT_QUANTITIES',
    );
    expect(missingBreakdown.infeasible).toBe(true);
  });

  it('keeps the only capable supplier when more than 20 suppliers are eligible', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const request = structuredClone(fixture.request);
    const cheap = Array.from({ length: 20 }, () => ({
      agreementId: randomUUID(),
      agreementReference: 'AGR-CHEAP',
      agreementVersion: 1,
      agreementStatus: 'approved' as const,
      currentlyValid: true,
      supplierId: randomUUID(),
      supplierReference: 'SUP-CHEAP',
      supplierStatus: 'active' as const,
      unitPriceMinor: '1000',
      currency: 'EUR' as const,
      capacityQuantity: 1,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
    }));
    request.offers[0]!.offers = [
      ...cheap,
      {
        agreementId: randomUUID(),
        agreementReference: 'AGR-BIG',
        agreementVersion: 1,
        agreementStatus: 'approved',
        currentlyValid: true,
        supplierId: randomUUID(),
        supplierReference: 'SUP-BIG',
        supplierStatus: 'active',
        unitPriceMinor: '5000',
        currency: 'EUR',
        capacityQuantity: 40,
        latestArrivalAt: '2026-11-05T17:00:00.000Z',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        expediteChargeMinor: '0',
      },
    ];
    const result = calculateSupply(request);
    expect(result.infeasible).toBe(false);
    expect(result.optionSets[0]!.options.length).toBeGreaterThan(0);
    expect(
      result.optionSets[0]!.options.some((option) =>
        option.suppliers.some(
          (supplier) => supplier.supplierReference === 'SUP-BIG',
        ),
      ),
    ).toBe(true);
    expect(
      result.optionSets[0]!.rejectedOptions.map((entry) => entry.reasonCode),
    ).toContain('SUPPLIER_LIMIT');
  });

  it('caps rejected offers and option items within the result contract', () => {
    const boundary = loadFixture('a-full-procurement-boundary.json');
    const manyProducts = structuredClone(boundary.request);
    const deadline = '2026-11-06T17:00:00.000Z';
    const productIds = Array.from({ length: 11 }, () => randomUUID());
    manyProducts.inventory = productIds.map((productId) => ({
      productId,
      sku: 'NS-BULK',
      onHandQuantity: 0,
      activeReservations: 0,
      confirmedInbound: [],
      version: 1,
    }));
    manyProducts.demand = productIds.map((productId, index) => ({
      orderId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index + 20).padStart(2, '0')}`,
      reference: `SO-BULK-${index}`,
      productId,
      quantity: 10,
      promisedDeliveryAt: deadline,
      exposedValueMinor: '1000',
      currency: 'EUR' as const,
      penaltyDailyMinor: '100',
      penaltyCapMinor: '1000',
      delayToleratedUntil: null,
      version: 1,
    }));
    manyProducts.offers = productIds.map((productId) => ({
      productId,
      offers: Array.from({ length: 100 }, () => ({
        agreementId: randomUUID(),
        agreementReference: 'AGR-INACTIVE',
        agreementVersion: 1,
        agreementStatus: 'approved' as const,
        currentlyValid: true,
        supplierId: randomUUID(),
        supplierReference: 'SUP-INACTIVE',
        supplierStatus: 'inactive' as const,
        unitPriceMinor: '1000',
        currency: 'EUR' as const,
        capacityQuantity: 10,
        latestArrivalAt: '2026-11-05T17:00:00.000Z',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        expediteChargeMinor: '0',
      })),
    }));
    const manyRejected = calculateSupply(manyProducts);
    expect(manyRejected.optionSets[0]!.rejectedOffers.length).toBeLessThanOrEqual(1000);
    expect(
      manyRejected.optionSets[0]!.rejectedOptions.map(
        (entry) => entry.reasonCode,
      ),
    ).toContain('OFFER_LIMIT_REACHED');

    const manyItems = structuredClone(boundary.request);
    const itemProducts = [randomUUID(), randomUUID()];
    manyItems.inventory = itemProducts.map((productId) => ({
      productId,
      sku: 'NS-UNIT',
      onHandQuantity: 0,
      activeReservations: 0,
      confirmedInbound: [],
      version: 1,
    }));
    manyItems.demand = itemProducts.map((productId, index) => ({
      orderId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index + 40).padStart(2, '0')}`,
      reference: `SO-UNIT-${index}`,
      productId,
      quantity: 51,
      promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
      exposedValueMinor: '5100',
      currency: 'EUR' as const,
      penaltyDailyMinor: '100',
      penaltyCapMinor: '1000',
      delayToleratedUntil: null,
      version: 1,
    }));
    manyItems.offers = itemProducts.map((productId) => ({
      productId,
      offers: Array.from({ length: 51 }, () => ({
        agreementId: randomUUID(),
        agreementReference: 'AGR-UNIT',
        agreementVersion: 1,
        agreementStatus: 'approved' as const,
        currentlyValid: true,
        supplierId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
        supplierReference: 'SUP-UNIT',
        supplierStatus: 'active' as const,
        unitPriceMinor: '1000',
        currency: 'EUR' as const,
        capacityQuantity: 1,
        latestArrivalAt: '2026-11-05T17:00:00.000Z',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        expediteChargeMinor: '0',
      })),
    }));
    const itemLimited = calculateSupply(manyItems);
    expect(itemLimited.optionSets[0]!.options).toEqual([]);
    expect(
      itemLimited.optionSets[0]!.rejectedOptions.map(
        (entry) => entry.reasonCode,
      ),
    ).toContain('ITEM_LIMIT_REACHED');
    expect(itemLimited.infeasible).toBe(true);
  });

  it('retains both suppliers of a feasible two-supplier combination outside the price top 20', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const request = structuredClone(fixture.request);
    const cheapMid = Array.from({ length: 19 }, (_, index) => ({
      agreementId: randomUUID(),
      agreementReference: `AGR-MID-${index}`,
      agreementVersion: 1,
      agreementStatus: 'approved' as const,
      currentlyValid: true,
      supplierId: randomUUID(),
      supplierReference: `SUP-MID-${index}`,
      supplierStatus: 'active' as const,
      unitPriceMinor: '1500',
      currency: 'EUR' as const,
      capacityQuantity: 1,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
    }));
    request.offers[0]!.offers = [
      {
        agreementId: randomUUID(),
        agreementReference: 'AGR-A',
        agreementVersion: 1,
        agreementStatus: 'approved',
        currentlyValid: true,
        supplierId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        supplierReference: 'SUP-A',
        supplierStatus: 'active',
        unitPriceMinor: '1000',
        currency: 'EUR',
        capacityQuantity: 20,
        latestArrivalAt: '2026-11-05T17:00:00.000Z',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        expediteChargeMinor: '0',
      },
      {
        agreementId: randomUUID(),
        agreementReference: 'AGR-B',
        agreementVersion: 1,
        agreementStatus: 'approved',
        currentlyValid: true,
        supplierId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        supplierReference: 'SUP-B',
        supplierStatus: 'active',
        unitPriceMinor: '2000',
        currency: 'EUR',
        capacityQuantity: 20,
        latestArrivalAt: '2026-11-05T17:00:00.000Z',
        validFrom: '2026-11-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        expediteChargeMinor: '0',
      },
      ...cheapMid,
    ];
    const result = calculateSupply(request);
    expect(result.infeasible).toBe(false);
    const pair = result.optionSets[0]!.options.find(
      (option) =>
        option.suppliers.length === 2 &&
        option.additionalCommitmentMinor === '40000',
    );
    expect(pair).toBeDefined();
    expect(
      pair!.suppliers.map((supplier) => supplier.supplierReference).sort(),
    ).toEqual(['SUP-A', 'SUP-B']);
    expect(
      result.optionSets[0]!.rejectedOptions.map((entry) => entry.reasonCode),
    ).toContain('SUPPLIER_LIMIT');
  });

  it('bounds waiting reasons and keeps more than 20 available stock rows', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const manyOrders = structuredClone(fixture.request);
    manyOrders.inventory[0]!.onHandQuantity = 0;
    manyOrders.offers = [];
    manyOrders.demand = Array.from({ length: 21 }, (_, index) => ({
      orderId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index + 60).padStart(2, '0')}`,
      reference: `SO-MANY-${index}`,
      productId: '11111111-1111-4111-8111-111111111111',
      quantity: 1,
      promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
      exposedValueMinor: '100',
      currency: 'EUR' as const,
      penaltyDailyMinor: '10',
      penaltyCapMinor: '100',
      delayToleratedUntil: null,
      version: 1,
    }));
    manyOrders.supplierNotice = {
      revisedArrivalAt: '2026-11-08T17:00:00.000Z',
      revisedQuantity: 21,
    };
    const reasons = calculateSupply(manyOrders);
    expect(reasons.waitingOption.reasons).toHaveLength(20);
    expect(reasons.waitingOption.reasons).toContain('REASON_LIMIT_REACHED');
    expect(reasons.infeasible).toBe(true);

    const manyInventory = structuredClone(fixture.request);
    const inventoryProducts = Array.from({ length: 20 }, () => randomUUID());
    manyInventory.inventory = inventoryProducts.map((productId) => ({
      productId,
      sku: 'NS-STOCK',
      onHandQuantity: 5,
      activeReservations: 0,
      confirmedInbound: [],
      version: 1,
    }));
    const missingDemandProduct = '77777777-7777-4777-8777-777777777777';
    manyInventory.demand = [
      {
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc90',
        reference: 'SO-MISSING',
        productId: missingDemandProduct,
        quantity: 1,
        promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
        exposedValueMinor: '100',
        currency: 'EUR',
        penaltyDailyMinor: '10',
        penaltyCapMinor: '100',
        delayToleratedUntil: null,
        version: 1,
      },
    ];
    manyInventory.offers = [];
    manyInventory.supplierNotice = {
      revisedArrivalAt: null,
      revisedQuantity: null,
    };
    const stock = calculateSupply(manyInventory);
    expect(stock.availableForAllocation).toHaveLength(21);
    expect(stock.availableForAllocation).toContainEqual({
      productId: missingDemandProduct,
      quantity: 0,
    });
    expect(stock.missingFields).toContain(
      `inventory.${missingDemandProduct}`,
    );
  });

  it('bounds penalty missing fields at the contract maximum for many late orders', () => {
    const fixture = loadFixture('a-wait-and-notify.json');
    const request = structuredClone(fixture.request);
    request.inventory[0]!.onHandQuantity = 0;
    request.offers = [];
    request.demand = Array.from({ length: 51 }, (_, index) => ({
      orderId: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index + 10).padStart(2, '0')}`,
      reference: `SO-PENALTY-${index}`,
      productId: '11111111-1111-4111-8111-111111111111',
      quantity: 1,
      promisedDeliveryAt: '2026-11-06T17:00:00.000Z',
      exposedValueMinor: '100',
      currency: 'EUR' as const,
      penaltyDailyMinor: null,
      penaltyCapMinor: null,
      delayToleratedUntil: '2026-11-09T17:00:00.000Z',
      version: 1,
    }));
    request.supplierNotice = {
      revisedArrivalAt: '2026-11-08T17:00:00.000Z',
      revisedQuantity: 51,
    };
    const result = calculateSupply(request);
    expect(result.waitingOption.feasible).toBe(true);
    expect(result.impact.penaltyMissingFields).toHaveLength(102);
    expect(result.impact.contractualPenaltyMinor).toBeNull();
    expect(result.missingFields).toContain(
      `demand.${request.demand[0]!.orderId}.penaltyDailyMinor`,
    );
  });

  it('requires the selected option to cover the latest affected deadline', () => {
    const fixture = loadFixture('a-multi-deadline-infeasible.json');
    const request = structuredClone(fixture.request);
    request.offers[0]!.offers[0]!.capacityQuantity = 10;
    request.demand[0]!.quantity = 5;
    request.demand[1]!.quantity = 5;
    const result = calculateSupply(request);
    expect(result.infeasible).toBe(false);
    expect(result.optionSets).toHaveLength(2);
    const early = result.optionSets[0]!.options[0]!;
    const complete = result.optionSets[1]!.options[0]!;
    expect(early.optionId).not.toBe(complete.optionId);
    const evidenceId = randomUUID();
    const payload = buildCalculationEvidence(result);
    const evidence = new Map([
      [
        evidenceId,
        {
          id: evidenceId,
          kind: 'calculation' as const,
          contentHash: payload.contentHash,
          capturedFacts: payload.capturedFacts,
        },
      ],
    ]);
    const incomplete = verifySupplyRecommendation({
      recommendation: {
        optionIds: [early.optionId],
        claims: [],
        evidenceIds: [evidenceId],
      },
      calculation: result,
      evidence,
    });
    expect(incomplete.findings.map((finding) => finding.code)).toContain(
      'INCOMPLETE_OPTION_SELECTION',
    );
    expect(
      verifySupplyRecommendation({
        recommendation: {
          optionIds: [complete.optionId],
          claims: [],
          evidenceIds: [evidenceId],
        },
        calculation: result,
        evidence,
      }).ok,
    ).toBe(true);
  });

  it('applies the delay tolerance only to orders that depend on the delayed purchase order', () => {
    const fixture = loadFixture('a-wait-and-notify.json');
    const request = structuredClone(fixture.request);
    request.inventory[0]!.onHandQuantity = 10;
    const covered = structuredClone(request.demand[0]!);
    covered.orderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccc09';
    covered.reference = 'SO-COVERED';
    covered.quantity = 10;
    covered.promisedDeliveryAt = '2026-11-05T17:00:00.000Z';
    covered.delayToleratedUntil = null;
    request.demand.unshift(covered);
    const result = calculateSupply(request);
    const coveredAllocation = result.allocations.find(
      (entry) => entry.orderId === covered.orderId,
    );
    expect(coveredAllocation?.shortageQuantity).toBe(0);
    expect(result.waitingOption.affectedOrderIds).not.toContain(covered.orderId);
    expect(result.waitingOption.reasons).not.toEqual(
      expect.arrayContaining([`CONTRACT_DOES_NOT_ALLOW_DELAY:${covered.orderId}`]),
    );
    expect(result.waitingOption.feasible).toBe(true);
  });

  it('reports a missing inventory row as a missing field and zero coverage instead of throwing', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const request = structuredClone(fixture.request);
    const missingProduct = '99999999-9999-4999-8999-999999999999';
    request.demand[0]!.productId = missingProduct;
    const result = calculateSupply(request);
    expect(result.shortages).toHaveLength(1);
    expect(result.shortages[0]!.quantity).toBe(30);
    expect(result.availableForAllocation).toContainEqual({
      productId: missingProduct,
      quantity: 0,
    });
    expect(result.missingFields).toContain(`inventory.${missingProduct}`);
    expect(result.infeasible).toBe(true);
  });

  it('bounds the two-supplier enumeration instead of failing the result schema', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const request = structuredClone(fixture.request);
    request.offers[0]!.offers = Array.from({ length: 30 }, () => ({
      agreementId: randomUUID(),
      agreementReference: 'AGR-BULK',
      agreementVersion: 1,
      agreementStatus: 'approved' as const,
      currentlyValid: true,
      supplierId: randomUUID(),
      supplierReference: 'SUP-BULK',
      supplierStatus: 'active' as const,
      unitPriceMinor: '1000',
      currency: 'EUR' as const,
      capacityQuantity: 16,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
    }));
    const result = calculateSupply(request);
    expect(result.optionSets[0]!.options.length).toBeLessThanOrEqual(100);
    expect(result.optionSets[0]!.rejectedOptions.length).toBeLessThanOrEqual(1000);
    expect(
      result.optionSets[0]!.rejectedOptions.map((entry) => entry.reasonCode),
    ).toEqual(
      expect.arrayContaining(['SUPPLIER_LIMIT', 'OPTION_LIMIT_REACHED']),
    );
  });

  it('verifies the finance decision against the selected option rather than the canonical best', () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const request = structuredClone(fixture.request);
    request.offers[0]!.offers.push({
      agreementId: randomUUID(),
      agreementReference: 'AGR-EXPENSIVE',
      agreementVersion: 1,
      agreementStatus: 'approved',
      currentlyValid: true,
      supplierId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      supplierReference: 'SUP-EXPENSIVE',
      supplierStatus: 'active',
      unitPriceMinor: '2000',
      currency: 'EUR',
      capacityQuantity: 30,
      latestArrivalAt: '2026-11-05T17:00:00.000Z',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-01T00:00:00.000Z',
      expediteChargeMinor: '0',
    });
    const result = calculateSupply(request);
    expect(result.optionSets[0]!.options).toHaveLength(2);
    const expensive = result.optionSets[0]!.options.find(
      (option) => option.additionalCommitmentMinor === '60000',
    )!;
    expect(result.impact.additionalCommitmentMinor).toBe('30000');
    expect(result.impact.financeApprovalRequired).toBe(false);
    const evidenceId = randomUUID();
    const payload = buildCalculationEvidence(result);
    const evidence = new Map([
      [
        evidenceId,
        {
          id: evidenceId,
          kind: 'calculation' as const,
          contentHash: payload.contentHash,
          capturedFacts: payload.capturedFacts,
        },
      ],
    ]);
    const staleClaim = verifySupplyRecommendation({
      recommendation: {
        optionIds: [expensive.optionId],
        claims: [
          {
            claimId: 'finance',
            kind: 'finance_approval_required',
            optionId: null,
            productId: null,
            deadline: null,
            value: 'false',
            evidenceIds: [evidenceId],
          },
        ],
        evidenceIds: [evidenceId],
      },
      calculation: result,
      evidence,
    });
    expect(staleClaim.findings.map((finding) => finding.code)).toContain(
      'CLAIM_VALUE_MISMATCH',
    );
    expect(
      verifySupplyRecommendation({
        recommendation: {
          optionIds: [expensive.optionId],
          claims: [
            {
              claimId: 'finance',
              kind: 'finance_approval_required',
              optionId: null,
              productId: null,
              deadline: null,
              value: 'true',
              evidenceIds: [evidenceId],
            },
          ],
          evidenceIds: [evidenceId],
        },
        calculation: result,
        evidence,
      }).ok,
    ).toBe(true);
  });

  it('rejects invented or stale calculation citations and unsupported option claims', () => {
    const fixture = loadFixture('a-partial-split.json');
    const result = calculateSupply(fixture.request);
    const evidenceId = randomUUID();
    const calculationEvidence = buildCalculationEvidence(result);
    const evidence = new Map<string, CitedEvidenceRecord>([
      [
        evidenceId,
        {
          id: evidenceId,
          kind: 'calculation',
          contentHash: calculationEvidence.contentHash,
          capturedFacts: calculationEvidence.capturedFacts,
        },
      ],
    ]);
    const option = result.optionSets.at(-1)!.options[0]!;
    const valid: SupplyRecommendationInput = {
      optionIds: [option.optionId],
      claims: [
        {
          claimId: 'commitment',
          kind: 'option_additional_commitment',
          optionId: option.optionId,
          productId: null,
          deadline: null,
          value: option.additionalCommitmentMinor,
          evidenceIds: [evidenceId],
        },
      ],
      evidenceIds: [evidenceId],
    };
    expect(
      verifySupplyRecommendation({
        recommendation: valid,
        calculation: result,
        evidence,
      }).ok,
    ).toBe(true);

    const invented = structuredClone(valid);
    invented.claims[0]!.value = '999999';
    const inventedResult = verifySupplyRecommendation({
      recommendation: invented,
      calculation: result,
      evidence,
    });
    expect(inventedResult.ok).toBe(false);
    expect(inventedResult.findings.map((finding) => finding.code)).toContain(
      'CLAIM_VALUE_MISMATCH',
    );

    const unknownCitation = structuredClone(valid);
    unknownCitation.claims[0]!.evidenceIds = [randomUUID()];
    expect(
      verifySupplyRecommendation({
        recommendation: unknownCitation,
        calculation: result,
        evidence,
      }).findings.map((finding) => finding.code),
    ).toContain('MISSING_CITATION_EVIDENCE');

    const wrongKind = new Map(evidence);
    wrongKind.set(evidenceId, {
      ...wrongKind.get(evidenceId)!,
      kind: 'enterprise_snapshot',
    });
    expect(
      verifySupplyRecommendation({
        recommendation: valid,
        calculation: result,
        evidence: wrongKind,
      }).findings.map((finding) => finding.code),
    ).toContain('WRONG_EVIDENCE_KIND');

    const staleFixture = loadFixture('a-wait-and-notify.json');
    const staleResult = calculateSupply(staleFixture.request);
    const staleEvidence = buildCalculationEvidence(staleResult);
    expect(
      verifySupplyRecommendation({
        recommendation: valid,
        calculation: result,
        evidence: new Map([
          [
            evidenceId,
            {
              id: evidenceId,
              kind: 'calculation',
              contentHash: staleEvidence.contentHash,
              capturedFacts: staleEvidence.capturedFacts,
            },
          ],
        ]),
      }).findings.map((finding) => finding.code),
    ).toContain('STALE_CALCULATION_EVIDENCE');

    const infeasibleFixture = loadFixture('a-no-feasible.json');
    const infeasible = calculateSupply(infeasibleFixture.request);
    const infeasibleEvidence = buildCalculationEvidence(infeasible);
    const infeasibleId = randomUUID();
    const infeasibleVerification = verifySupplyRecommendation({
      recommendation: {
        optionIds: ['00000000000000000000'],
        claims: [],
        evidenceIds: [infeasibleId],
      },
      calculation: infeasible,
      evidence: new Map([
        [
          infeasibleId,
          {
            id: infeasibleId,
            kind: 'calculation' as const,
            contentHash: infeasibleEvidence.contentHash,
            capturedFacts: infeasibleEvidence.capturedFacts,
          },
        ],
      ]),
    });
    expect(infeasibleVerification.ok).toBe(false);
    expect(
      infeasibleVerification.findings.map((finding) => finding.code),
    ).toEqual(
      expect.arrayContaining(['UNKNOWN_OPTION', 'INFEASIBLE_OPTION_SELECTED']),
    );
  });

  it('registers the deterministic calculation as a compute tool with closed schemas', async () => {
    const tool = createSupplyCalculationToolDefinition();
    expect(RegisteredToolDefinitionSchema.parse(tool.descriptor)).toMatchObject({
      name: 'domain.calculate_supply_options',
      toolClass: 'compute',
      supportedScenarios: ['A'],
      retryable: false,
    });
    const request = boundaryRequest();
    const registered = await tool.execute(request, {
      requestId: randomUUID(),
      correlationId: 'f19-unit',
      sandboxId: randomUUID(),
      actor: { kind: 'service', id: 'f19-test', roles: [] },
      scenario: 'A',
      workflowStep: 'calculate',
      allowedToolNames: ['domain.calculate_supply_options'],
      timeoutMs: 5_000,
    });
    expect(registered).toEqual(calculateSupply(request));
  });
});

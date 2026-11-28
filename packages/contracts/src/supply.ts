import { z } from 'zod';
import {
  HashSchema,
  IsoUtcTimestampSchema,
  MoneyAmountMinorSchema,
  UuidSchema,
} from './common.js';
import {
  EnterpriseIdentifierSchema,
  EnterpriseQuantitySchema,
  EnterpriseVersionSchema,
} from './tools.js';

export const SUPPLY_RULE_VERSION = 'supply-rules-v1';
export const SUPPLY_MAX_SUPPLIERS = 2;

const NonNegativeMoneySchema = z
  .string()
  .max(14)
  .regex(
    /^(?:0|[1-9]\d{0,11}|1000000000000)$/,
    'Expected a non-negative minor amount',
  );
const ComputedMoneySchema = z
  .string()
  .max(20)
  .regex(/^(?:0|[1-9]\d{0,19})$/, 'Expected a non-negative computed amount');

export const SupplyPurchaseOrderStatusSchema = z.enum([
  'open',
  'acknowledged',
  'delayed',
  'partially_received',
  'received',
  'cancelled',
]);
export type SupplyPurchaseOrderStatus = z.infer<
  typeof SupplyPurchaseOrderStatusSchema
>;

export const SupplyPurchaseOrderLineSchema = z
  .object({
    lineId: UuidSchema,
    productId: UuidSchema,
    orderedQuantity: EnterpriseQuantitySchema,
    receivedQuantity: EnterpriseQuantitySchema,
    unreceivedQuantity: EnterpriseQuantitySchema,
    unitPriceMinor: NonNegativeMoneySchema,
    currency: z.literal('EUR'),
    confirmedArrivalAt: IsoUtcTimestampSchema,
  })
  .strict();
export type SupplyPurchaseOrderLine = z.infer<
  typeof SupplyPurchaseOrderLineSchema
>;

export const SupplyPurchaseOrderSchema = z
  .object({
    id: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    status: SupplyPurchaseOrderStatusSchema,
    version: EnterpriseVersionSchema,
    currency: z.literal('EUR'),
    expectedAt: IsoUtcTimestampSchema,
    lines: z.array(SupplyPurchaseOrderLineSchema).min(1).max(100),
  })
  .strict();
export type SupplyPurchaseOrder = z.infer<typeof SupplyPurchaseOrderSchema>;

export const SupplyInboundSchema = z
  .object({
    purchaseOrderId: UuidSchema,
    purchaseOrderReference: EnterpriseIdentifierSchema,
    quantity: EnterpriseQuantitySchema,
    arrivalAt: IsoUtcTimestampSchema,
  })
  .strict();
export type SupplyInbound = z.infer<typeof SupplyInboundSchema>;

export const SupplyInventoryLineSchema = z
  .object({
    productId: UuidSchema,
    sku: EnterpriseIdentifierSchema,
    onHandQuantity: EnterpriseQuantitySchema,
    activeReservations: EnterpriseQuantitySchema,
    confirmedInbound: z.array(SupplyInboundSchema).max(100),
    version: EnterpriseVersionSchema,
  })
  .strict();
export type SupplyInventoryLine = z.infer<typeof SupplyInventoryLineSchema>;

export const SupplyDemandLineSchema = z
  .object({
    orderId: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    productId: UuidSchema,
    quantity: z.number().int().min(1).max(1_000_000),
    promisedDeliveryAt: IsoUtcTimestampSchema,
    exposedValueMinor: NonNegativeMoneySchema,
    currency: z.literal('EUR'),
    penaltyDailyMinor: NonNegativeMoneySchema.nullable(),
    penaltyCapMinor: NonNegativeMoneySchema.nullable(),
    delayToleratedUntil: IsoUtcTimestampSchema.nullable(),
    version: EnterpriseVersionSchema,
  })
  .strict();
export type SupplyDemandLine = z.infer<typeof SupplyDemandLineSchema>;

export const SupplyOfferSchema = z
  .object({
    agreementId: UuidSchema,
    agreementReference: EnterpriseIdentifierSchema,
    agreementVersion: EnterpriseVersionSchema,
    agreementStatus: z.enum(['pending', 'approved', 'expired', 'revoked']),
    currentlyValid: z.boolean(),
    supplierId: UuidSchema,
    supplierReference: EnterpriseIdentifierSchema,
    supplierStatus: z.enum(['active', 'inactive', 'suspended']),
    unitPriceMinor: NonNegativeMoneySchema,
    currency: z.literal('EUR'),
    capacityQuantity: EnterpriseQuantitySchema,
    latestArrivalAt: IsoUtcTimestampSchema,
    validFrom: IsoUtcTimestampSchema,
    validTo: IsoUtcTimestampSchema,
    expediteChargeMinor: NonNegativeMoneySchema,
  })
  .strict();
export type SupplyOffer = z.infer<typeof SupplyOfferSchema>;

export const SupplyProductOffersSchema = z
  .object({
    productId: UuidSchema,
    offers: z.array(SupplyOfferSchema).max(100),
  })
  .strict();
export type SupplyProductOffers = z.infer<typeof SupplyProductOffersSchema>;

export const SupplySupplierNoticeSchema = z
  .object({
    revisedArrivalAt: IsoUtcTimestampSchema.nullable(),
    revisedQuantity: EnterpriseQuantitySchema.nullable(),
    revisedProductQuantities: z
      .array(
        z
          .object({
            productId: UuidSchema,
            quantity: EnterpriseQuantitySchema,
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type SupplySupplierNotice = z.infer<typeof SupplySupplierNoticeSchema>;

export const SupplyCalculationRequestSchema = z
  .object({
    asOf: IsoUtcTimestampSchema,
    policyRevision: z.string().min(1).max(100),
    policyContentHash: HashSchema,
    financeThresholdMinor: MoneyAmountMinorSchema,
    priorAdditionalCommittedMinor: NonNegativeMoneySchema,
    purchaseOrder: SupplyPurchaseOrderSchema,
    inventory: z.array(SupplyInventoryLineSchema).min(1).max(20),
    demand: z.array(SupplyDemandLineSchema).max(100),
    offers: z.array(SupplyProductOffersSchema).max(20),
    supplierNotice: SupplySupplierNoticeSchema,
  })
  .strict();
export type SupplyCalculationRequest = z.infer<
  typeof SupplyCalculationRequestSchema
>;

export const SupplyAvailableStockSchema = z
  .object({
    productId: UuidSchema,
    quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const SupplyCoverageSchema = z
  .object({
    productId: UuidSchema,
    deadline: IsoUtcTimestampSchema,
    quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const SupplyAllocationSchema = z
  .object({
    orderId: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    productId: UuidSchema,
    requestedQuantity: z.number().int().min(1).max(1_000_000),
    allocatedQuantity: z.number().int().min(0).max(1_000_000),
    shortageQuantity: z.number().int().min(0).max(1_000_000),
    promisedDeliveryAt: IsoUtcTimestampSchema,
    version: EnterpriseVersionSchema,
  })
  .strict();
export type SupplyAllocation = z.infer<typeof SupplyAllocationSchema>;

export const SupplyShortageSchema = z
  .object({
    productId: UuidSchema,
    deadline: IsoUtcTimestampSchema,
    quantity: z.number().int().min(1).max(1_000_000),
    orderIds: z.array(UuidSchema).min(1).max(100),
  })
  .strict();
export type SupplyShortage = z.infer<typeof SupplyShortageSchema>;

export const SupplyProcurementItemSchema = z
  .object({
    productId: UuidSchema,
    agreementId: UuidSchema,
    supplierId: UuidSchema,
    supplierReference: EnterpriseIdentifierSchema,
    quantity: z.number().int().min(1).max(1_000_000),
    unitPriceMinor: NonNegativeMoneySchema,
    goodsMinor: ComputedMoneySchema,
    expediteChargeMinor: NonNegativeMoneySchema,
    latestArrivalAt: IsoUtcTimestampSchema,
  })
  .strict();
export type SupplyProcurementItem = z.infer<
  typeof SupplyProcurementItemSchema
>;

export const SupplyProcurementOptionSchema = z
  .object({
    optionId: z.string().regex(/^[a-f0-9]{20}$/),
    deadline: IsoUtcTimestampSchema,
    kind: z.literal('procure'),
    suppliers: z
      .array(
        z
          .object({
            supplierId: UuidSchema,
            supplierReference: EnterpriseIdentifierSchema,
          })
          .strict(),
      )
      .min(1)
      .max(SUPPLY_MAX_SUPPLIERS),
    items: z.array(SupplyProcurementItemSchema).min(1).max(100),
    goodsTotalMinor: ComputedMoneySchema,
    expediteTotalMinor: ComputedMoneySchema,
    additionalCommitmentMinor: ComputedMoneySchema,
    latestArrivalAt: IsoUtcTimestampSchema,
    rank: z.number().int().min(1).max(1000),
  })
  .strict();
export type SupplyProcurementOption = z.infer<
  typeof SupplyProcurementOptionSchema
>;

export const SupplyRejectedOfferSchema = z
  .object({
    productId: UuidSchema,
    agreementId: UuidSchema,
    supplierId: UuidSchema,
    reasonCode: z.enum([
      'SUPPLIER_INACTIVE',
      'AGREEMENT_NOT_APPROVED',
      'AGREEMENT_NOT_CURRENT',
      'CURRENCY_MISMATCH',
      'ZERO_CAPACITY',
      'LATE_ARRIVAL',
      'NEGATIVE_PRICE',
    ]),
  })
  .strict();
export type SupplyRejectedOffer = z.infer<typeof SupplyRejectedOfferSchema>;

export const SupplyRejectedOptionSchema = z
  .object({
    deadline: IsoUtcTimestampSchema,
    supplierIds: z.array(UuidSchema).max(SUPPLY_MAX_SUPPLIERS),
    reasonCode: z.enum([
      'INSUFFICIENT_CAPACITY',
      'NO_ELIGIBLE_OFFERS',
      'SUPPLIER_LIMIT',
      'OPTION_LIMIT_REACHED',
      'ITEM_LIMIT_REACHED',
      'OFFER_LIMIT_REACHED',
      'LATE_ARRIVAL',
    ]),
  })
  .strict();
export type SupplyRejectedOption = z.infer<typeof SupplyRejectedOptionSchema>;

export const SupplyOptionSetSchema = z
  .object({
    deadline: IsoUtcTimestampSchema,
    options: z.array(SupplyProcurementOptionSchema).max(100),
    rejectedOffers: z.array(SupplyRejectedOfferSchema).max(1000),
    rejectedOptions: z.array(SupplyRejectedOptionSchema).max(1000),
  })
  .strict();

export const SupplyWaitingOptionSchema = z
  .object({
    feasible: z.boolean(),
    revisedArrivalAt: IsoUtcTimestampSchema.nullable(),
    affectedOrderIds: z.array(UuidSchema).max(100),
    reasons: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict();

export type SupplyWaitingOption = z.infer<typeof SupplyWaitingOptionSchema>;

export const SupplyUnitPriceComparisonSchema = z
  .object({
    productId: UuidSchema,
    originalUnitPriceMinor: NonNegativeMoneySchema.nullable(),
    offerUnitPriceMinor: NonNegativeMoneySchema,
    differenceMinor: z
      .string()
      .max(15)
      .regex(/^-?(?:0|[1-9]\d{0,13})$/)
      .nullable(),
    missingReason: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type SupplyUnitPriceComparison = z.infer<
  typeof SupplyUnitPriceComparisonSchema
>;

export const SupplyImpactSchema = z
  .object({
    describedOptionId: z.string().min(1).max(100).nullable(),
    originalPurchaseOrderOutstandingMinor: ComputedMoneySchema,
    unitPriceComparisons: z
      .array(SupplyUnitPriceComparisonSchema)
      .max(100),
    exposedSalesValueMinor: ComputedMoneySchema,
    contractualPenaltyMinor: ComputedMoneySchema.nullable(),
    penaltyMissingFields: z.array(z.string().min(1).max(200)).max(200),
    priorAdditionalCommittedMinor: NonNegativeMoneySchema,
    additionalCommitmentMinor: ComputedMoneySchema,
    cumulativeCommittedMinor: ComputedMoneySchema,
    financeThresholdMinor: NonNegativeMoneySchema,
    financeApprovalRequired: z.boolean(),
  })
  .strict();
export type SupplyImpact = z.infer<typeof SupplyImpactSchema>;

export const SupplyCalculationResultSchema = z
  .object({
    ruleVersion: z.literal(SUPPLY_RULE_VERSION),
    asOf: IsoUtcTimestampSchema,
    policyRevision: z.string().min(1).max(100),
    policyContentHash: HashSchema,
    inputHash: HashSchema,
    resultHash: HashSchema,
    entityVersions: z
      .object({
        purchaseOrder: EnterpriseVersionSchema,
        inventory: z
          .array(
            z.object({ productId: UuidSchema, version: EnterpriseVersionSchema }).strict(),
          )
          .max(20),
        demandOrders: z
          .array(
            z.object({ orderId: UuidSchema, version: EnterpriseVersionSchema }).strict(),
          )
          .max(100),
        agreements: z
          .array(
            z
              .object({
                agreementId: UuidSchema,
                version: EnterpriseVersionSchema,
              })
              .strict(),
          )
          .max(2000),
      })
      .strict(),
    availableForAllocation: z.array(SupplyAvailableStockSchema).max(120),
    coverageByDeadline: z.array(SupplyCoverageSchema).max(2000),
    allocations: z.array(SupplyAllocationSchema).max(100),
    shortages: z.array(SupplyShortageSchema).max(2000),
    optionSets: z.array(SupplyOptionSetSchema).max(365),
    waitingOption: SupplyWaitingOptionSchema,
    impact: SupplyImpactSchema,
    noProcurementRequired: z.boolean(),
    infeasible: z.boolean(),
    missingFields: z.array(z.string().min(1).max(200)).max(500),
  })
  .strict();
export type SupplyCalculationResult = z.infer<
  typeof SupplyCalculationResultSchema
>;

export const SupplyScenarioExpectationSchema = z
  .object({
    noProcurementRequired: z.boolean(),
    waitingFeasible: z.boolean(),
    infeasible: z.boolean(),
    financeApprovalRequired: z.boolean(),
    additionalCommitmentMinor: ComputedMoneySchema,
    bestOptionSuppliers: z.array(z.array(EnterpriseIdentifierSchema).max(2)).max(100),
    penalties: ComputedMoneySchema.nullable(),
  })
  .strict();

export const SupplyScenarioFixtureSchema = z
  .object({
    fixtureId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    description: z.string().min(1).max(500),
    request: SupplyCalculationRequestSchema,
    expected: SupplyScenarioExpectationSchema,
  })
  .strict();
export type SupplyScenarioFixture = z.infer<
  typeof SupplyScenarioFixtureSchema
>;

export const SupplyClaimKindSchema = z.enum([
  'option_additional_commitment',
  'option_arrival',
  'option_rank',
  'shortage_quantity',
  'wait_feasible',
  'finance_approval_required',
]);
export type SupplyClaimKind = z.infer<typeof SupplyClaimKindSchema>;

export const SupplyRecommendationClaimSchema = z
  .object({
    claimId: z.string().min(1).max(100),
    kind: SupplyClaimKindSchema,
    optionId: z.string().min(1).max(100).nullable(),
    productId: UuidSchema.nullable(),
    deadline: IsoUtcTimestampSchema.nullable(),
    value: z.string().min(1).max(100),
    evidenceIds: z.array(UuidSchema).min(1).max(10),
  })
  .strict();
export type SupplyRecommendationClaim = z.infer<
  typeof SupplyRecommendationClaimSchema
>;

export const SupplyRecommendationInputSchema = z
  .object({
    optionIds: z.array(z.string().min(1).max(100)).max(20),
    claims: z.array(SupplyRecommendationClaimSchema).max(100),
    evidenceIds: z.array(UuidSchema).max(100),
  })
  .strict();
export type SupplyRecommendationInput = z.infer<
  typeof SupplyRecommendationInputSchema
>;

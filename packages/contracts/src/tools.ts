import { z } from 'zod';
import {
  ActorSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
} from './common.js';
import {
  ToolClassSchema,
  ToolDefinitionSchema,
  ToolNameSchema,
} from './models.js';

export const EnterpriseIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Expected an exact identifier');
export type EnterpriseIdentifier = z.infer<typeof EnterpriseIdentifierSchema>;

export const EnterpriseVersionSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647);
export const EnterpriseQuantitySchema = z.number().int().min(0).max(1_000_000);
export const EnterpriseTotalQuantitySchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const EnterpriseNonNegativeMoneySchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,11}|1000000000000)$/,
    'Expected a non-negative money string',
  );
export const EnterpriseComputedMoneySchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,14}|999000000000000)$/,
    'Expected a non-negative aggregate money string',
  );

export const EnterpriseProductSummarySchema = z
  .object({
    id: UuidSchema,
    sku: EnterpriseIdentifierSchema,
    name: z.string().min(1).max(200),
    category: z.string().min(1).max(100),
    status: z.enum(['active', 'discontinued']),
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseProductSummary = z.infer<
  typeof EnterpriseProductSummarySchema
>;

export const EnterpriseSupplierSummarySchema = z
  .object({
    id: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'inactive', 'suspended']),
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseSupplierSummary = z.infer<
  typeof EnterpriseSupplierSummarySchema
>;

export const EnterpriseCustomerSummarySchema = z
  .object({
    id: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'inactive']),
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseCustomerSummary = z.infer<
  typeof EnterpriseCustomerSummarySchema
>;

export const EnterprisePurchaseOrderLineSchema = z
  .object({
    id: UuidSchema,
    lineNumber: z.number().int().min(1).max(999),
    product: EnterpriseProductSummarySchema,
    agreementId: UuidSchema.nullable(),
    agreementReference: EnterpriseIdentifierSchema.nullable(),
    agreementVersion: EnterpriseVersionSchema.nullable(),
    orderedQuantity: EnterpriseQuantitySchema,
    receivedQuantity: EnterpriseQuantitySchema,
    unreceivedQuantity: EnterpriseQuantitySchema,
    unitPriceMinor: EnterpriseNonNegativeMoneySchema,
    currency: z.literal('EUR'),
    confirmedArrivalAt: IsoUtcTimestampSchema,
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterprisePurchaseOrderLine = z.infer<
  typeof EnterprisePurchaseOrderLineSchema
>;

export const EnterprisePurchaseOrderSchema = z
  .object({
    id: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    supplierReference: EnterpriseIdentifierSchema.nullable(),
    status: z.enum([
      'open',
      'acknowledged',
      'delayed',
      'partially_received',
      'received',
      'cancelled',
    ]),
    version: EnterpriseVersionSchema,
    orderedAt: IsoUtcTimestampSchema,
    expectedAt: IsoUtcTimestampSchema,
    sourcePurchaseOrderId: UuidSchema.nullable(),
    sourcePurchaseOrderReference: EnterpriseIdentifierSchema.nullable(),
    expediteChargeMinor: EnterpriseNonNegativeMoneySchema,
    paymentTerms: z.string().min(1).max(200),
    deliveryTerms: z.string().min(1).max(200),
    supplier: EnterpriseSupplierSummarySchema,
    lines: z.array(EnterprisePurchaseOrderLineSchema).max(999),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterprisePurchaseOrder = z.infer<
  typeof EnterprisePurchaseOrderSchema
>;

export const EnterprisePurchaseOrderResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    businessEffectiveAt: IsoUtcTimestampSchema,
    purchaseOrders: z.array(EnterprisePurchaseOrderSchema).max(10),
  })
  .strict();
export type EnterprisePurchaseOrderResponse = z.infer<
  typeof EnterprisePurchaseOrderResponseSchema
>;

export const EnterpriseReservationSchema = z
  .object({
    id: UuidSchema,
    salesOrderId: UuidSchema.nullable(),
    status: z.enum(['active', 'released', 'fulfilled']),
    quantity: EnterpriseQuantitySchema,
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseReservation = z.infer<
  typeof EnterpriseReservationSchema
>;

export const EnterpriseInboundLineSchema = z
  .object({
    purchaseOrderId: UuidSchema,
    purchaseOrderReference: EnterpriseIdentifierSchema,
    purchaseOrderStatus: z.enum([
      'open',
      'acknowledged',
      'delayed',
      'partially_received',
      'received',
      'cancelled',
    ]),
    lineId: UuidSchema,
    lineNumber: z.number().int().min(1).max(999),
    unreceivedQuantity: EnterpriseQuantitySchema,
    confirmedArrivalAt: IsoUtcTimestampSchema,
    version: EnterpriseVersionSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseInboundLine = z.infer<
  typeof EnterpriseInboundLineSchema
>;

export const EnterpriseInventoryItemSchema = z
  .object({
    product: EnterpriseProductSummarySchema,
    onHandQuantity: EnterpriseQuantitySchema,
    activeReservations: EnterpriseTotalQuantitySchema,
    availableForAllocation: EnterpriseTotalQuantitySchema,
    reservations: z.array(EnterpriseReservationSchema).max(1000),
    reservationsTruncated: z.boolean(),
    confirmedInboundQuantity: EnterpriseTotalQuantitySchema,
    confirmedInbound: z.array(EnterpriseInboundLineSchema).max(1000),
    confirmedInboundTruncated: z.boolean(),
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseInventoryItem = z.infer<
  typeof EnterpriseInventoryItemSchema
>;

export const EnterpriseInventoryResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    businessEffectiveAt: IsoUtcTimestampSchema,
    items: z.array(EnterpriseInventoryItemSchema).max(20),
  })
  .strict();
export type EnterpriseInventoryResponse = z.infer<
  typeof EnterpriseInventoryResponseSchema
>;

export const EnterpriseSalesOrderLineSchema = z
  .object({
    id: UuidSchema,
    lineNumber: z.number().int().min(1).max(999),
    product: EnterpriseProductSummarySchema,
    quantity: EnterpriseQuantitySchema,
    unitPriceMinor: EnterpriseNonNegativeMoneySchema,
    currency: z.literal('EUR'),
    version: EnterpriseVersionSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseSalesOrderLine = z.infer<
  typeof EnterpriseSalesOrderLineSchema
>;

export const EnterpriseAffectedOrderSchema = z
  .object({
    id: UuidSchema,
    reference: EnterpriseIdentifierSchema,
    status: z.enum([
      'confirmed',
      'allocated',
      'shipped',
      'delivered',
      'cancelled',
    ]),
    version: EnterpriseVersionSchema,
    orderedAt: IsoUtcTimestampSchema,
    promisedDeliveryAt: IsoUtcTimestampSchema,
    shippedAt: IsoUtcTimestampSchema.nullable(),
    deliveredAt: IsoUtcTimestampSchema.nullable(),
    exposedValueMinor: EnterpriseComputedMoneySchema,
    currency: z.literal('EUR'),
    contractualPenaltyDailyMinor: EnterpriseNonNegativeMoneySchema.nullable(),
    contractualPenaltyCapMinor: EnterpriseNonNegativeMoneySchema.nullable(),
    customer: EnterpriseCustomerSummarySchema,
    lines: z.array(EnterpriseSalesOrderLineSchema).max(999),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseAffectedOrder = z.infer<
  typeof EnterpriseAffectedOrderSchema
>;

export const EnterpriseAffectedOrdersResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    businessEffectiveAt: IsoUtcTimestampSchema,
    requestedProductIds: z.array(UuidSchema).max(999),
    horizon: z
      .object({
        from: IsoUtcTimestampSchema,
        to: IsoUtcTimestampSchema,
        days: z.number().int().min(1).max(365),
      })
      .strict(),
    orders: z.array(EnterpriseAffectedOrderSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();
export type EnterpriseAffectedOrdersResponse = z.infer<
  typeof EnterpriseAffectedOrdersResponseSchema
>;

export const EnterpriseSupplierOfferSchema = z
  .object({
    agreementId: UuidSchema,
    agreementReference: EnterpriseIdentifierSchema,
    agreementVersion: EnterpriseVersionSchema,
    agreementStatus: z.enum(['pending', 'approved', 'expired', 'revoked']),
    currentlyValid: z.boolean(),
    supplier: EnterpriseSupplierSummarySchema,
    unitPriceMinor: EnterpriseNonNegativeMoneySchema,
    currency: z.literal('EUR'),
    capacityQuantity: EnterpriseQuantitySchema,
    leadTimeDays: z.number().int().min(0).max(365),
    latestArrivalAt: IsoUtcTimestampSchema,
    validFrom: IsoUtcTimestampSchema,
    validTo: IsoUtcTimestampSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseSupplierOffer = z.infer<
  typeof EnterpriseSupplierOfferSchema
>;

export const EnterpriseProductAlternativesSchema = z
  .object({
    product: EnterpriseProductSummarySchema,
    requestedQuantity: z.number().int().min(1).max(1_000_000),
    offers: z.array(EnterpriseSupplierOfferSchema).max(1000),
    offersTruncated: z.boolean(),
  })
  .strict();
export type EnterpriseProductAlternatives = z.infer<
  typeof EnterpriseProductAlternativesSchema
>;

export const EnterpriseAlternativesResponseSchema = z
  .object({
    sandboxId: UuidSchema,
    businessEffectiveAt: IsoUtcTimestampSchema,
    deadline: IsoUtcTimestampSchema,
    products: z.array(EnterpriseProductAlternativesSchema).max(20),
  })
  .strict();
export type EnterpriseAlternativesResponse = z.infer<
  typeof EnterpriseAlternativesResponseSchema
>;

export const GetPurchaseOrderArgsSchema = z
  .object({
    identifier: EnterpriseIdentifierSchema,
  })
  .strict();
export type GetPurchaseOrderArgs = z.infer<typeof GetPurchaseOrderArgsSchema>;

export const GetInventoryArgsSchema = z
  .object({
    productIds: z.array(UuidSchema).min(1).max(20).refine(
      (values) => new Set(values).size === values.length,
      'Expected unique product identifiers',
    ),
  })
  .strict();
export type GetInventoryArgs = z.infer<typeof GetInventoryArgsSchema>;

export const GetAffectedOrdersArgsSchema = z
  .object({
    purchaseOrderId: UuidSchema.optional(),
    productIds: z
      .array(UuidSchema)
      .min(1)
      .max(20)
      .refine(
        (values) => new Set(values).size === values.length,
        'Expected unique product identifiers',
      )
      .optional(),
    horizonDays: z.number().int().min(1).max(365),
  })
  .strict()
  .refine(
    (value) =>
      (value.purchaseOrderId === undefined) !==
      (value.productIds === undefined),
    'Provide exactly one of purchaseOrderId or productIds',
  );
export type GetAffectedOrdersArgs = z.infer<
  typeof GetAffectedOrdersArgsSchema
>;

export const ListAlternativesArgsSchema = z
  .object({
    productIds: z.array(UuidSchema).min(1).max(20).refine(
      (values) => new Set(values).size === values.length,
      'Expected unique product identifiers',
    ),
    quantities: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(20),
    deadline: IsoUtcTimestampSchema,
  })
  .strict()
  .refine(
    (value) => value.productIds.length === value.quantities.length,
    'productIds and quantities must contain the same number of values',
  );
export type ListAlternativesArgs = z.infer<typeof ListAlternativesArgsSchema>;

export const TOOL_SCENARIOS = ['A', 'B', 'C'] as const;
export const ToolScenarioSchema = z.enum(TOOL_SCENARIOS);
export type ToolScenario = z.infer<typeof ToolScenarioSchema>;

export const TOOL_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TOOL_WORKFLOW_STEP_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

export const ToolInvocationContextSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    correlationId: z
      .string()
      .regex(TOOL_CORRELATION_PATTERN, 'Expected a valid correlation identifier'),
    sandboxId: UuidSchema,
    actor: ActorSchema,
    scenario: ToolScenarioSchema,
    workflowStep: z
      .string()
      .regex(TOOL_WORKFLOW_STEP_PATTERN, 'Expected a registered workflow step'),
    allowedToolNames: z.array(ToolNameSchema).max(20),
    timeoutMsCap: z.number().int().min(1).max(120_000).optional(),
  })
  .strict();
export type ToolInvocationContext = z.infer<
  typeof ToolInvocationContextSchema
>;

export const RegisteredToolDefinitionSchema = ToolDefinitionSchema.extend({
  argumentSchemaId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_.]*\.arguments\.v1$/),
  resultSchemaId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_.]*\.result\.v1$/),
  maxArgumentBytes: z.number().int().min(16).max(65_536),
  maxResultBytes: z.number().int().min(64).max(4_194_304),
})
  .strict();
export type RegisteredToolDefinition = z.infer<
  typeof RegisteredToolDefinitionSchema
>;

export const TOOL_ERROR_CODES = [
  'TOOL_NOT_FOUND',
  'TOOL_NOT_ALLOWED',
  'TOOL_FORBIDDEN',
  'TOOL_INVALID_CONTEXT',
  'TOOL_INVALID_ARGUMENTS',
  'TOOL_ARGUMENTS_TOO_LARGE',
  'TOOL_RESULT_INVALID',
  'TOOL_RESULT_TOO_LARGE',
  'TOOL_RESULT_LIMIT_EXCEEDED',
  'TOOL_SANDBOX_MISMATCH',
  'TOOL_RETRYABLE_FAILURE',
  'TOOL_PERMANENT_FAILURE',
] as const;
export const ToolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolTraceSchema = z
  .object({
    toolName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .nullable(),
    schemaVersion: z.number().int().positive().nullable(),
    toolClass: ToolClassSchema.nullable(),
    requestId: z.string().min(1).max(128),
    correlationId: z.string().min(1).max(128),
    sandboxId: UuidSchema,
    scenario: ToolScenarioSchema,
    workflowStep: z.string().min(1).max(128),
    outcome: z.enum(['succeeded', 'failed']),
    errorCode: ToolErrorCodeSchema.nullable(),
    causeCode: z.string().min(1).max(64).nullable(),
    retryable: z.boolean().nullable(),
    durationMs: z.number().int().min(0).max(600_000),
    argumentBytes: z.number().int().min(0).max(65_536),
    resultBytes: z.number().int().min(0).max(4_194_304).nullable(),
    resultCount: z.number().int().min(0).max(100_000).nullable(),
  })
  .strict();
export type ToolTrace = z.infer<typeof ToolTraceSchema>;

export const TOOL_REGISTRY_ERROR_STATUS: Record<ToolErrorCode, number> = {
  TOOL_NOT_FOUND: 404,
  TOOL_NOT_ALLOWED: 403,
  TOOL_FORBIDDEN: 403,
  TOOL_INVALID_CONTEXT: 400,
  TOOL_INVALID_ARGUMENTS: 400,
  TOOL_ARGUMENTS_TOO_LARGE: 413,
  TOOL_RESULT_INVALID: 503,
  TOOL_RESULT_TOO_LARGE: 503,
  TOOL_RESULT_LIMIT_EXCEEDED: 503,
  TOOL_SANDBOX_MISMATCH: 403,
  TOOL_RETRYABLE_FAILURE: 503,
  TOOL_PERMANENT_FAILURE: 409,
};

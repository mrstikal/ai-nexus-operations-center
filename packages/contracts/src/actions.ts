import { z } from 'zod';
import {
  ActorSchema,
  EntityIdSchema,
  EntityRefSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  MoneyAmountMinorSchema,
  MoneySchema,
  plainTextSchema,
  RoleSchema,
  UuidSchema,
} from './common.js';

export const ACTION_KINDS = [
  'case.add_internal_note',
  'enterprise.create_purchase_order',
  'enterprise.send_message',
  'enterprise.mark_invoice_reconciled',
  'enterprise.hold_invoice',
  'enterprise.post_goods_receipt',
  'enterprise.create_replacement_shipment',
  'enterprise.create_return_authorization',
  'enterprise.create_credit_note_draft',
  'enterprise.change_delivery_address',
] as const;

export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ACTION_PROPOSAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'superseded',
  'expired',
] as const;

export const ActionProposalStatusSchema = z.enum(ACTION_PROPOSAL_STATUSES);
export type ActionProposalStatus = z.infer<typeof ActionProposalStatusSchema>;

export const ACTION_EXECUTION_STATUSES = [
  'pending',
  'in_progress',
  'succeeded',
  'retryable_failure',
  'unknown',
  'permanent_failure',
  'cancelled',
] as const;

export const ActionExecutionStatusSchema = z.enum(ACTION_EXECUTION_STATUSES);
export type ActionExecutionStatus = z.infer<typeof ActionExecutionStatusSchema>;

export const PostalAddressSchema = z
  .object({
    line1: plainTextSchema(200),
    line2: plainTextSchema(200).nullable(),
    city: plainTextSchema(100),
    postalCode: z.string().min(2).max(20).regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
export type PostalAddress = z.infer<typeof PostalAddressSchema>;

export const DeferredBindingSchema = z
  .object({
    fromItemId: UuidSchema,
    output: z.enum([
      'purchaseOrderId',
      'shipmentId',
      'returnAuthorizationId',
      'creditDraftId',
    ]),
  })
  .strict();
export type DeferredBinding = z.infer<typeof DeferredBindingSchema>;

export const MessagePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: plainTextSchema(2000) }).strict(),
  z
    .object({
      kind: z.literal('verified_claim'),
      claimId: EntityIdSchema,
      text: plainTextSchema(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('receipt_fact'),
      binding: DeferredBindingSchema,
      label: plainTextSchema(200),
    })
    .strict(),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const PurchaseOrderLineSchema = z
  .object({
    productId: UuidSchema,
    quantity: z.number().int().positive().max(1_000_000),
    agreementId: UuidSchema,
    unitPriceMinor: MoneyAmountMinorSchema,
    arrivalAt: IsoUtcTimestampSchema,
  })
  .strict();

export const AddInternalNotePayloadSchema = z
  .object({
    kind: z.literal('case.add_internal_note'),
    caseId: EntityIdSchema,
    text: plainTextSchema(2000),
  })
  .strict();

export const CreatePurchaseOrderPayloadSchema = z
  .object({
    kind: z.literal('enterprise.create_purchase_order'),
    supplierId: UuidSchema,
    sourcePurchaseOrderId: UuidSchema,
    lines: z.array(PurchaseOrderLineSchema).min(1).max(20),
    expediteChargeMinor: MoneyAmountMinorSchema,
  })
  .strict();

export type CreatePurchaseOrderPayload = z.infer<
  typeof CreatePurchaseOrderPayloadSchema
>;

export const SendMessagePayloadSchema = z
  .object({
    kind: z.literal('enterprise.send_message'),
    recipient: EntityRefSchema,
    subject: plainTextSchema(200),
    parts: z.array(MessagePartSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (payload) =>
      payload.parts.reduce((total, part) => {
        if (part.kind === 'receipt_fact') {
          return total + part.label.length;
        }
        return total + part.text.length;
      }, 0) <= 5000,
    'Rendered message parts exceed 5,000 characters',
  );

export type SendMessagePayload = z.infer<typeof SendMessagePayloadSchema>;

export const MarkInvoiceReconciledPayloadSchema = z
  .object({
    kind: z.literal('enterprise.mark_invoice_reconciled'),
    invoiceId: UuidSchema,
    reportId: EntityIdSchema,
    reportHash: HashSchema,
  })
  .strict();

export const HoldInvoicePayloadSchema = z
  .object({
    kind: z.literal('enterprise.hold_invoice'),
    invoiceId: UuidSchema,
    reason: z.enum([
      'duplicate',
      'price_mismatch',
      'missing_receipt',
      'quantity_mismatch',
      'tax_mismatch',
      'other',
    ]),
    reportId: EntityIdSchema,
    reportHash: HashSchema,
  })
  .strict();

export const GoodsReceiptLineSchema = z
  .object({
    lineId: UuidSchema,
    quantity: z.number().int().positive().max(1_000_000),
  })
  .strict();

export const PostGoodsReceiptPayloadSchema = z
  .object({
    kind: z.literal('enterprise.post_goods_receipt'),
    purchaseOrderId: UuidSchema,
    deliveryReference: z.string().min(1).max(100),
    documentVersionId: UuidSchema,
    lines: z.array(GoodsReceiptLineSchema).min(1).max(100),
  })
  .strict();

export const CreateReplacementShipmentPayloadSchema = z
  .object({
    kind: z.literal('enterprise.create_replacement_shipment'),
    orderId: UuidSchema,
    deliveryId: UuidSchema,
    lines: z.array(GoodsReceiptLineSchema).min(1).max(100),
    verifiedAddressRef: UuidSchema,
  })
  .strict();

export const ReturnLineSchema = z
  .object({
    lineId: UuidSchema,
    quantity: z.number().int().positive().max(1_000_000),
    reason: z.enum(['damaged', 'wrong_item', 'not_needed', 'other']),
  })
  .strict();

export const CreateReturnAuthorizationPayloadSchema = z
  .object({
    kind: z.literal('enterprise.create_return_authorization'),
    orderId: UuidSchema,
    deliveryId: UuidSchema,
    lines: z.array(ReturnLineSchema).min(1).max(100),
  })
  .strict();

export const CreateCreditNoteDraftPayloadSchema = z
  .object({
    kind: z.literal('enterprise.create_credit_note_draft'),
    invoiceId: UuidSchema,
    reportId: EntityIdSchema,
    reportHash: HashSchema,
    amountMinor: MoneyAmountMinorSchema.refine(
      (value) => !value.startsWith('-') && value !== '0',
      'Credit-note draft amount must be positive',
    ),
    reason: z.enum(['return', 'damage', 'overcharge', 'other']),
  })
  .strict();

export const ChangeDeliveryAddressPayloadSchema = z
  .object({
    kind: z.literal('enterprise.change_delivery_address'),
    orderId: UuidSchema,
    address: PostalAddressSchema,
  })
  .strict();

export const ActionPayloadSchema = z.discriminatedUnion('kind', [
  AddInternalNotePayloadSchema,
  CreatePurchaseOrderPayloadSchema,
  SendMessagePayloadSchema,
  MarkInvoiceReconciledPayloadSchema,
  HoldInvoicePayloadSchema,
  PostGoodsReceiptPayloadSchema,
  CreateReplacementShipmentPayloadSchema,
  CreateReturnAuthorizationPayloadSchema,
  CreateCreditNoteDraftPayloadSchema,
  ChangeDeliveryAddressPayloadSchema,
]);
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export const ActionDraftItemSchema = z
  .object({
    target: EntityRefSchema,
    evidenceIds: z.array(EntityIdSchema).max(20),
    payload: ActionPayloadSchema,
  })
  .strict();
export type ActionDraftItem = z.infer<typeof ActionDraftItemSchema>;

export const ActionDraftPlanSchema = z
  .object({
    items: z.array(ActionDraftItemSchema).min(1).max(6),
    rationale: plainTextSchema(4000),
  })
  .strict();
export type ActionDraftPlan = z.infer<typeof ActionDraftPlanSchema>;

export const ActionPlanItemSchema = ActionDraftItemSchema.extend({
  itemId: UuidSchema,
  dependsOnItemIds: z.array(UuidSchema).max(5),
  baseExpectedVersions: z.array(EntityRefSchema).max(50),
}).strict();
export type ActionPlanItem = z.infer<typeof ActionPlanItemSchema>;

export const ActionRevisionSchema = z
  .object({
    id: EntityIdSchema,
    proposalId: EntityIdSchema,
    revisionNumber: z.number().int().positive().max(2_147_483_647),
    planHash: HashSchema,
    state: ActionProposalStatusSchema,
    items: z.array(ActionPlanItemSchema).min(1).max(6),
    requiredRoles: z.array(RoleSchema).max(5),
    policyRevision: z.string().min(1).max(100),
    aggregateImpact: MoneySchema.nullable(),
    createdBy: ActorSchema,
    createdAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();
export type ActionRevision = z.infer<typeof ActionRevisionSchema>;

export const ActionProposalSchema = z
  .object({
    id: EntityIdSchema,
    caseId: EntityIdSchema,
    sandboxId: EntityIdSchema,
    currentRevisionId: EntityIdSchema.nullable(),
    status: ActionProposalStatusSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ActionProposalCreateInputSchema = z
  .object({
    plan: ActionDraftPlanSchema,
  })
  .strict();
export type ActionProposalCreateInput = z.infer<
  typeof ActionProposalCreateInputSchema
>;

export const ActionProposalEditItemSchema = z
  .object({
    itemId: UuidSchema,
    target: EntityRefSchema,
    evidenceIds: z.array(EntityIdSchema).max(20),
    payload: ActionPayloadSchema,
  })
  .strict();
export type ActionProposalEditItem = z.infer<typeof ActionProposalEditItemSchema>;

export const ActionProposalEditInputSchema = z
  .object({
    rationale: plainTextSchema(4000),
    items: z.array(ActionProposalEditItemSchema).min(1).max(6),
  })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.itemId)).size === value.items.length,
    'Item identifiers must be unique',
  );
export type ActionProposalEditInput = z.infer<
  typeof ActionProposalEditInputSchema
>;

export const ActionProposalDetailSchema = z
  .object({
    proposal: ActionProposalSchema,
    revision: ActionRevisionSchema,
  })
  .strict();
export type ActionProposalDetail = z.infer<typeof ActionProposalDetailSchema>;

export const ActionProposalListResponseSchema = z
  .object({
    items: z.array(ActionProposalDetailSchema).max(50),
    nextCursor: z.string().max(512).nullable(),
  })
  .strict();
export type ActionProposalListResponse = z.infer<
  typeof ActionProposalListResponseSchema
>;

export const RevisionPreconditionSchema = z
  .string()
  .regex(/^"?[1-9][0-9]{0,9}"?$/, 'Expected a positive revision precondition');

export const ApprovalDecisionSchema = z
  .object({
    id: EntityIdSchema,
    proposalId: EntityIdSchema,
    actionRevisionId: EntityIdSchema,
    planHash: HashSchema,
    decision: z.enum(['approve', 'reject']),
    requiredRoles: z.array(RoleSchema).min(1).max(5),
    actor: ActorSchema,
    reason: z.string().min(1).max(2000).nullable(),
    decidedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ActionExecutionSchema = z
  .object({
    id: EntityIdSchema,
    actionRevisionId: EntityIdSchema,
    itemId: UuidSchema,
    status: ActionExecutionStatusSchema,
    attempt: z.number().int().nonnegative().max(3),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;

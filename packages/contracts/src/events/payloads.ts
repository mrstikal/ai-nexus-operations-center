import { z } from 'zod';
import {
  EntityIdSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  plainTextSchema,
  UuidSchema,
} from '../common.js';

export const CaseCreatedPayloadSchema = z
  .object({
    caseId: EntityIdSchema,
    title: plainTextSchema(200),
  })
  .strict();
export type CaseCreatedPayload = z.infer<typeof CaseCreatedPayloadSchema>;

export const CaseCompletedPayloadSchema = z
  .object({
    caseId: EntityIdSchema,
    terminalRunId: EntityIdSchema,
    terminalTriggerEventId: UuidSchema,
    terminalCaseVersion: z.number().int().nonnegative().max(2_147_483_647),
    terminalStatus: z.enum(['resolved', 'escalated', 'cancelled']),
    outcomeEvidenceIds: z.array(EntityIdSchema).max(100),
  })
  .strict();
export type CaseCompletedPayload = z.infer<typeof CaseCompletedPayloadSchema>;

export const DocumentReadyPayloadSchema = z
  .object({
    documentId: EntityIdSchema,
    documentVersionId: EntityIdSchema,
    contentHash: HashSchema,
  })
  .strict();
export type DocumentReadyPayload = z.infer<typeof DocumentReadyPayloadSchema>;

export const WorkflowResumePayloadSchema = z
  .object({
    runId: EntityIdSchema,
    cause: z.enum([
      'human_input',
      'approval_completed',
      'dependency_retry',
      'budget_extension',
    ]),
  })
  .strict();
export type WorkflowResumePayload = z.infer<typeof WorkflowResumePayloadSchema>;

export const ActionRequestedPayloadSchema = z
  .object({
    proposalId: EntityIdSchema,
    actionRevisionId: EntityIdSchema,
    planHash: HashSchema,
  })
  .strict();
export type ActionRequestedPayload = z.infer<typeof ActionRequestedPayloadSchema>;

export const SupplierDelayPayloadSchema = z
  .object({
    supplierId: EntityIdSchema,
    purchaseOrderId: EntityIdSchema,
    existingDocumentIds: z.array(EntityIdSchema).max(20).optional(),
  })
  .strict();
export type SupplierDelayPayload = z.infer<typeof SupplierDelayPayloadSchema>;

export const EnterpriseChangePayloadSchema = z
  .object({
    entityType: z.enum([
      'supplier',
      'product',
      'inventory',
      'purchase_order',
      'sales_order',
      'invoice',
      'customer',
      'delivery',
    ]),
    entityId: EntityIdSchema,
    version: z.number().int().nonnegative().max(2_147_483_647),
    changedFields: z.array(z.string().min(1).max(100)).min(1).max(50),
    originatingRevisionId: UuidSchema.optional(),
    originatingItemId: UuidSchema.optional(),
    originatingReceiptKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EnterpriseChangePayload = z.infer<typeof EnterpriseChangePayloadSchema>;

export const CommunicationCreatedPayloadSchema = z
  .object({
    communicationId: EntityIdSchema,
    customerId: EntityIdSchema,
    orderId: EntityIdSchema.nullable(),
    version: z.number().int().nonnegative().max(2_147_483_647),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type CommunicationCreatedPayload = z.infer<typeof CommunicationCreatedPayloadSchema>;

export const KnowledgeChangedPayloadSchema = z
  .object({
    documentId: EntityIdSchema,
    documentVersionId: EntityIdSchema,
    publicationState: z.enum(['published', 'withdrawn']),
    retrievalGeneration: z.number().int().positive(),
  })
  .strict();
export type KnowledgeChangedPayload = z.infer<typeof KnowledgeChangedPayloadSchema>;

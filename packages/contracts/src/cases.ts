import { z } from 'zod';
import {
  ActorSchema,
  CursorPageSchema,
  EntityIdSchema,
  EntityRefSchema,
  IsoUtcTimestampSchema,
  plainTextSchema,
  UuidSchema,
} from './common.js';

export const CASE_STATUSES = [
  'new',
  'investigating',
  'needs_input',
  'needs_approval',
  'executing',
  'resolved',
  'escalated',
  'cancelled',
] as const;

export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const CaseSummarySchema = z
  .object({
    id: EntityIdSchema,
    sandboxId: EntityIdSchema,
    title: plainTextSchema(200),
    status: CaseStatusSchema,
    version: z.number().int().nonnegative().max(2_147_483_647),
    terminalReason: z.string().min(1).max(1000).nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseDetailSchema = CaseSummarySchema.extend({
  summary: z.string().min(1).max(5000).nullable(),
  entityRefs: z.array(EntityRefSchema).max(50),
}).strict();
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const CaseCreateInputSchema = z
  .object({
    title: plainTextSchema(200),
    summary: z.string().min(1).max(5000).nullable(),
  })
  .strict();
export type CaseCreateInput = z.infer<typeof CaseCreateInputSchema>;

export const CaseUpdateInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
    status: CaseStatusSchema,
    terminalReason: z.string().min(1).max(1000).nullable(),
  })
  .strict();
export type CaseUpdateInput = z.infer<typeof CaseUpdateInputSchema>;

export const CaseListResponseSchema = CursorPageSchema(CaseSummarySchema);
export type CaseListResponse = z.infer<typeof CaseListResponseSchema>;

export const CaseHistoryItemSchema = z
  .object({
    id: UuidSchema,
    caseId: EntityIdSchema,
    caseVersion: z.number().int().nonnegative().max(2_147_483_647),
    status: CaseStatusSchema,
    summary: z.string().min(1).max(2000),
    actor: ActorSchema,
    occurredAt: IsoUtcTimestampSchema,
  })
  .strict();
export type CaseHistoryItem = z.infer<typeof CaseHistoryItemSchema>;

export const CaseHistoryResponseSchema = CursorPageSchema(CaseHistoryItemSchema);
export type CaseHistoryResponse = z.infer<typeof CaseHistoryResponseSchema>;

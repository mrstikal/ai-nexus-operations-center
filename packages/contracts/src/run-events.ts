import { z } from 'zod';
import { CaseStatusSchema } from './cases.js';
import { UuidSchema } from './common.js';
import {
  WaitReasonSchema,
  WorkflowStatusSchema,
  WorkflowStepStatusSchema,
} from './workflows.js';

export const RUN_EVENT_TYPES = [
  'step',
  'status',
  'text_delta',
  'final',
  'error',
] as const;
export const RunEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const RunStepEventDataSchema = z
  .object({
    step: z.string().min(1).max(100),
    status: WorkflowStepStatusSchema,
    attempt: z.number().int().min(0).max(10),
    durationMs: z.number().int().min(0).max(600_000).nullable(),
    errorClass: z.string().min(1).max(100).nullable(),
    count: z.number().int().min(0).max(1_000),
  })
  .strict();
export type RunStepEventData = z.infer<typeof RunStepEventDataSchema>;

export const RunStatusEventDataSchema = z
  .object({
    status: z.string().min(1).max(100),
    caseStatus: CaseStatusSchema.nullable(),
    waitReason: WaitReasonSchema.nullable(),
    errorClass: z.string().min(1).max(100).nullable(),
    count: z.number().int().min(0).max(1_000).nullable(),
  })
  .strict();
export type RunStatusEventData = z.infer<typeof RunStatusEventDataSchema>;

export const RunTextDeltaEventDataSchema = z
  .object({
    text: z.string().min(1).max(2_000),
    provisional: z.literal(true),
  })
  .strict();
export type RunTextDeltaEventData = z.infer<
  typeof RunTextDeltaEventDataSchema
>;

export const RunFinalEventDataSchema = z
  .object({
    caseStatus: CaseStatusSchema,
    caseVersion: z.number().int().positive(),
    evidenceCount: z.number().int().min(0).max(100),
  })
  .strict();
export type RunFinalEventData = z.infer<typeof RunFinalEventDataSchema>;

export const RunErrorEventDataSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RunErrorEventData = z.infer<typeof RunErrorEventDataSchema>;

export const RunEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      id: RunEventIdSchema,
      event: z.literal('step'),
      data: RunStepEventDataSchema,
    })
    .strict(),
  z
    .object({
      id: RunEventIdSchema,
      event: z.literal('status'),
      data: RunStatusEventDataSchema,
    })
    .strict(),
  z
    .object({
      id: RunEventIdSchema,
      event: z.literal('text_delta'),
      data: RunTextDeltaEventDataSchema,
    })
    .strict(),
  z
    .object({
      id: RunEventIdSchema,
      event: z.literal('final'),
      data: RunFinalEventDataSchema,
    })
    .strict(),
  z
    .object({
      id: RunEventIdSchema,
      event: z.literal('error'),
      data: RunErrorEventDataSchema,
    })
    .strict(),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunEventsPageSchema = z
  .object({
    items: z.array(RunEventSchema).max(200),
    nextAfter: RunEventIdSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>;

export const RunEventsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;

export const RunStepSummarySchema = z
  .object({
    stepKey: z.string().min(1).max(100),
    stepKind: z.enum(['pure', 'read', 'external']),
    status: WorkflowStepStatusSchema,
    attemptCount: z.number().int().min(0).max(10),
    maxAttempts: z.number().int().min(1).max(10),
    errorClass: z.string().min(1).max(100).nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();
export type RunStepSummary = z.infer<typeof RunStepSummarySchema>;

export const RunDetailSchema = z
  .object({
    id: UuidSchema,
    sandboxId: UuidSchema,
    caseId: UuidSchema,
    caseStatus: CaseStatusSchema,
    caseVersion: z.number().int().nonnegative(),
    definitionName: z.string().min(1).max(100),
    definitionVersion: z.string().min(1).max(100),
    status: WorkflowStatusSchema,
    waitReason: WaitReasonSchema.nullable(),
    effectiveAt: z.string().datetime(),
    activeMsLimit: z.number().int().positive(),
    activeMsUsed: z.number().int().nonnegative(),
    deadlineAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    steps: z.array(RunStepSummarySchema).max(100),
  })
  .strict();
export type RunDetail = z.infer<typeof RunDetailSchema>;

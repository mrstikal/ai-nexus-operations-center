import { z } from 'zod';
import {
  EntityIdSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
} from './common.js';

export const WORKFLOW_STATUSES = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_dependency',
  'blocked',
  'budget_exhausted',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;

export const WorkflowStatusSchema = z.enum(WORKFLOW_STATUSES);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WORKFLOW_STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'retryable_failure',
  'permanent_failure',
  'waiting',
  'cancelled',
] as const;

export const WorkflowStepStatusSchema = z.enum(WORKFLOW_STEP_STATUSES);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;

export const WaitReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human_input'), prompt: z.string().min(1).max(2000) }).strict(),
  z
    .object({
      kind: z.literal('approval'),
      proposalId: EntityIdSchema,
      actionRevisionId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('dependency'),
      childCaseId: EntityIdSchema,
      childTriggerEventId: UuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('budget'),
      accountId: EntityIdSchema,
      requestedMicrousd: z.string().regex(/^(?:0|[1-9]\d*)$/).max(16),
    })
    .strict(),
]);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

export const WorkflowRunSchema = z
  .object({
    id: EntityIdSchema,
    sandboxId: EntityIdSchema,
    caseId: EntityIdSchema,
    definitionVersion: z.string().min(1).max(100),
    status: WorkflowStatusSchema,
    effectiveAt: IsoUtcTimestampSchema,
    waitReason: WaitReasonSchema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const WorkflowStepSchema = z
  .object({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    name: z.string().min(1).max(100),
    status: WorkflowStepStatusSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    outputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    attempt: z.number().int().nonnegative().max(3),
    startedAt: IsoUtcTimestampSchema.nullable(),
    finishedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

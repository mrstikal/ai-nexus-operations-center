import { z } from 'zod';
import { CaseStatusSchema } from './cases.js';
import { EntityIdSchema } from './common.js';
import { WorkflowStatusSchema } from './workflows.js';

export const RunResumeCauseSchema = z.enum([
  'human_input',
  'approval_completed',
  'dependency_retry',
  'budget_extension',
]);
export type RunResumeCause = z.infer<typeof RunResumeCauseSchema>;

export const RunResumeRequestSchema = z.discriminatedUnion('cause', [
  z.object({ cause: z.literal('human_input') }).strict(),
  z
    .object({
      cause: z.literal('approval_completed'),
      proposalId: EntityIdSchema,
      actionRevisionId: EntityIdSchema,
    })
    .strict(),
  z.object({ cause: z.literal('budget_extension') }).strict(),
]);
export type RunResumeRequest = z.infer<typeof RunResumeRequestSchema>;

export const RunCancelCauseSchema = z.enum([
  'operator_request',
  'dependency_failure',
  'dependency_timeout',
  'test',
]);
export type RunCancelCause = z.infer<typeof RunCancelCauseSchema>;

export const RunCancelRequestSchema = z
  .object({
    cause: RunCancelCauseSchema,
  })
  .strict();
export type RunCancelRequest = z.infer<typeof RunCancelRequestSchema>;

export const RunControlResponseSchema = z
  .object({
    runId: EntityIdSchema,
    status: WorkflowStatusSchema,
    caseStatus: CaseStatusSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type RunControlResponse = z.infer<typeof RunControlResponseSchema>;

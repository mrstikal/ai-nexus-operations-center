import { z } from 'zod';
import {
  EntityIdSchema,
  HashSchema,
  JsonValueSchema,
  MoneySchema,
  plainTextSchema,
  ProblemSchema,
  RoleSchema,
  UuidSchema,
} from './common.js';
import { WorkflowStepStatusSchema, WorkflowStatusSchema } from './workflows.js';

export const UiActionSchema = z
  .object({
    action: z.enum([
      'open_case',
      'open_evidence',
      'approve',
      'reject',
      'request_clarification',
      'cancel_run',
    ]),
    targetId: UuidSchema,
  })
  .strict();
export type UiAction = z.infer<typeof UiActionSchema>;

export const UiFieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const UiFieldSchema = z.discriminatedUnion('control', [
  z
    .object({
      control: z.literal('text'),
      key: UiFieldKeySchema,
      label: plainTextSchema(200),
      required: z.boolean(),
      maxLength: z.number().int().positive().max(5000),
    })
    .strict(),
  z
    .object({
      control: z.literal('number'),
      key: UiFieldKeySchema,
      label: plainTextSchema(200),
      required: z.boolean(),
      minimum: z.number().finite().nullable(),
      maximum: z.number().finite().nullable(),
    })
    .strict(),
  z
    .object({
      control: z.literal('enum'),
      key: UiFieldKeySchema,
      label: plainTextSchema(200),
      required: z.boolean(),
      options: z
        .array(z.object({ value: z.string().min(1).max(100), label: plainTextSchema(200) }).strict())
        .min(1)
        .max(50),
    })
    .strict(),
]);
export type UiField = z.infer<typeof UiFieldSchema>;

export const ClarificationFormDescriptorSchema = z
  .object({
    kind: z.literal('clarification_form'),
    title: plainTextSchema(200),
    fields: z.array(UiFieldSchema).min(1).max(20),
    submitAction: UiActionSchema,
  })
  .strict();

export const AlternativesTableDescriptorSchema = z
  .object({
    kind: z.literal('alternatives_table'),
    title: plainTextSchema(200),
    columns: z
      .array(z.object({ key: UiFieldKeySchema, label: plainTextSchema(100) }).strict())
      .min(1)
      .max(20),
    rows: z
      .array(
        z
          .array(z.union([plainTextSchema(1000), z.number().finite(), z.null()]))
          .max(20),
      )
      .max(100),
    rejectedReasons: z.array(plainTextSchema(1000)).max(50),
  })
  .strict();

export const DiscrepancyListDescriptorSchema = z
  .object({
    kind: z.literal('discrepancy_list'),
    title: plainTextSchema(200),
    items: z
      .array(
        z
          .object({
            code: z.string().min(1).max(100),
            label: plainTextSchema(500),
            detail: plainTextSchema(2000).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const EvidenceListDescriptorSchema = z
  .object({
    kind: z.literal('evidence_list'),
    title: plainTextSchema(200),
    items: z
      .array(
        z
          .object({
            evidenceId: EntityIdSchema,
            label: plainTextSchema(500),
            action: UiActionSchema.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const ApprovalSummaryDescriptorSchema = z
  .object({
    kind: z.literal('approval_summary'),
    title: plainTextSchema(200),
    proposalId: EntityIdSchema,
    actionRevisionId: EntityIdSchema,
    planHash: HashSchema,
    requiredRoles: z.array(RoleSchema).min(1).max(5),
    aggregateImpact: MoneySchema.nullable(),
    items: z
      .array(
        z
          .object({
            itemId: UuidSchema,
            label: plainTextSchema(500),
            amountMinor: z.string().max(14).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    actions: z.array(UiActionSchema).max(5),
  })
  .strict();

export const UiDescriptorSchema = z.discriminatedUnion('kind', [
  ClarificationFormDescriptorSchema,
  AlternativesTableDescriptorSchema,
  DiscrepancyListDescriptorSchema,
  EvidenceListDescriptorSchema,
  ApprovalSummaryDescriptorSchema,
]);
export type UiDescriptor = z.infer<typeof UiDescriptorSchema>;

export const SseStepDataSchema = z
  .object({
    stepId: EntityIdSchema,
    status: WorkflowStepStatusSchema,
  })
  .strict();

export const SseStatusDataSchema = z
  .object({
    status: WorkflowStatusSchema,
    reason: z.string().min(1).max(1000).nullable(),
  })
  .strict();

export const SseTextDeltaDataSchema = z
  .object({
    text: z.string().min(1).max(5000),
    provisional: z.literal(true),
  })
  .strict();

export const SseEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      id: z.number().int().nonnegative(),
      event: z.literal('step'),
      data: SseStepDataSchema,
    })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      event: z.literal('status'),
      data: SseStatusDataSchema,
    })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      event: z.literal('text_delta'),
      data: SseTextDeltaDataSchema,
    })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      event: z.literal('final'),
      data: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      event: z.literal('error'),
      data: ProblemSchema,
    })
    .strict(),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

export const LastEventIdSchema = z.number().int().nonnegative();

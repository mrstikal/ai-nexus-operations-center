import { z } from 'zod';
import { ActionKindSchema } from './actions.js';
import { HashSchema, MoneyAmountMinorSchema } from './common.js';

export const POLICY_SCHEMA_VERSION = 1;
export const POLICY_ID = 'northstar';
export const POLICY_REVISION_PATTERN = /^northstar-v[1-9][0-9]{0,8}$/;
export const POLICY_CANONICAL_TEXT_PATTERN =
  /^fixtures\/knowledge\/[a-z0-9][a-z0-9._-]{0,99}\.md$/;

export const PolicyBundleSchema = z
  .object({
    schemaVersion: z.literal(POLICY_SCHEMA_VERSION),
    policyId: z.literal(POLICY_ID),
    revision: z.string().regex(POLICY_REVISION_PATTERN, 'Expected a northstar revision'),
    canonicalText: z
      .object({
        path: z
          .string()
          .regex(POLICY_CANONICAL_TEXT_PATTERN, 'Expected a fixtures/knowledge path'),
        sha256: HashSchema,
      })
      .strict(),
    supplyApproval: z
      .object({
        financeThresholdMinor: MoneyAmountMinorSchema.refine(
          (value) => !value.startsWith('-'),
          'Finance threshold must be non-negative',
        ),
      })
      .strict(),
    approval: z
      .object({
        ttlHours: z.number().int().min(1).max(24),
      })
      .strict(),
    lowRiskAutomation: z
      .object({
        enabled: z.boolean(),
        actionKinds: z.array(ActionKindSchema).max(5),
      })
      .strict(),
    enabledActionKinds: z
      .array(ActionKindSchema)
      .min(1)
      .max(20)
      .refine(
        (values) => new Set(values).size === values.length,
        'Enabled action kinds must be unique',
      ),
  })
  .strict();

export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

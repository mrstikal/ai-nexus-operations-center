import { z } from 'zod';
import {
  EntityIdSchema,
  JsonValueSchema,
  MoneyAmountMinorSchema,
  plainTextSchema,
  type JsonValue,
} from './common.js';
import { ReviewerOutputSchema, type ModelRole } from './models.js';

/**
 * Versioned, closed registry of AI output schemas.
 *
 * A schema id is part of the replay key and of the recorded prompt/config
 * identity, so a new output shape must be published under a new versioned id.
 * Roles whose owner stage has not yet defined an output schema deliberately
 * have no registration; the gateway rejects such a request instead of
 * accepting an unvalidated payload.
 */
export const DocumentClassificationV1Schema = z
  .object({
    kind: z.enum([
      'supply_exception',
      'invoice',
      'delivery_note',
      'customer_request',
      'knowledge_document',
      'other',
      'unknown',
    ]),
    evidenceIds: z.array(EntityIdSchema).max(20),
    missingFields: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();
export type DocumentClassificationV1 = z.infer<
  typeof DocumentClassificationV1Schema
>;

export const AnalysisFindingV1Schema = z
  .object({
    kind: z.enum(['verified_fact', 'assumption', 'interpretation', 'unresolved']),
    text: plainTextSchema(2000),
    evidenceIds: z.array(EntityIdSchema).max(20),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (finding.kind === 'verified_fact' && finding.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: 'A verified fact requires at least one evidence id',
      });
    }
  });
export type AnalysisFindingV1 = z.infer<typeof AnalysisFindingV1Schema>;

export const AnalysisOptionV1Schema = z
  .object({
    optionId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    summary: plainTextSchema(1000),
    costMinor: MoneyAmountMinorSchema.nullable(),
    evidenceIds: z.array(EntityIdSchema).max(20),
  })
  .strict();
export type AnalysisOptionV1 = z.infer<typeof AnalysisOptionV1Schema>;

export const DraftCommunicationV1Schema = z
  .object({
    recipientKind: z.enum(['supplier', 'customer']),
    subject: plainTextSchema(200),
    body: plainTextSchema(5000),
    evidenceIds: z.array(EntityIdSchema).max(20),
  })
  .strict();
export type DraftCommunicationV1 = z.infer<typeof DraftCommunicationV1Schema>;

export const AnalysisRecommendationV1Schema = z
  .object({
    findings: z.array(AnalysisFindingV1Schema).min(1).max(50),
    options: z.array(AnalysisOptionV1Schema).max(6),
    recommendedOptionId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
    draftCommunications: z.array(DraftCommunicationV1Schema).max(3),
    missingFields: z.array(z.string().min(1).max(100)).max(50),
    uncertainties: z.array(plainTextSchema(1000)).max(20),
    evidenceIds: z.array(EntityIdSchema).max(50),
  })
  .strict()
  .superRefine((recommendation, ctx) => {
    if (
      recommendation.recommendedOptionId !== null &&
      !recommendation.options.some(
        (option) => option.optionId === recommendation.recommendedOptionId,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedOptionId'],
        message: 'A recommended option id must name one of the supplied options',
      });
    }
  });
export type AnalysisRecommendationV1 = z.infer<
  typeof AnalysisRecommendationV1Schema
>;

export interface AiOutputRegistration {
  readonly id: string;
  readonly version: number;
  readonly role: ModelRole;
  readonly schema: z.ZodType<JsonValue>;
}

function registration(
  id: string,
  version: number,
  role: ModelRole,
  schema: z.ZodType<JsonValue>,
): AiOutputRegistration {
  return Object.freeze({ id, version, role, schema });
}

export const AI_OUTPUT_REGISTRY: readonly AiOutputRegistration[] = Object.freeze([
  registration(
    'document.classification.v1',
    1,
    'classify',
    DocumentClassificationV1Schema as z.ZodType<JsonValue>,
  ),
  registration(
    'analysis.recommendation.v1',
    1,
    'analyse',
    AnalysisRecommendationV1Schema as z.ZodType<JsonValue>,
  ),
  registration(
    'verification.review.v1',
    1,
    'verify',
    ReviewerOutputSchema as z.ZodType<JsonValue>,
  ),
]);

export function findAiOutputRegistration(
  id: string,
): AiOutputRegistration | null {
  return AI_OUTPUT_REGISTRY.find((entry) => entry.id === id) ?? null;
}

export function parseAiOutput(
  id: string,
  role: ModelRole,
  value: unknown,
): JsonValue {
  const entry = findAiOutputRegistration(id);
  if (!entry) {
    throw new AiOutputError(
      'OUTPUT_SCHEMA_UNKNOWN',
      `No AI output schema is registered for ${id}`,
    );
  }
  if (entry.role !== role) {
    throw new AiOutputError(
      'OUTPUT_SCHEMA_ROLE_MISMATCH',
      `Schema ${id} is not available to role ${role}`,
    );
  }
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) {
    throw new AiOutputError(
      'OUTPUT_SCHEMA_INVALID',
      `AI output does not validate against ${id}`,
    );
  }
  return parsed.data;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return JsonValueSchema.safeParse(value).success;
}

export type AiOutputErrorCode =
  | 'OUTPUT_SCHEMA_UNKNOWN'
  | 'OUTPUT_SCHEMA_ROLE_MISMATCH'
  | 'OUTPUT_SCHEMA_INVALID';

export class AiOutputError extends Error {
  constructor(
    readonly code: AiOutputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiOutputError';
  }
}

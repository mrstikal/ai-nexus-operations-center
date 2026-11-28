import { z } from 'zod';
import {
  EntityIdSchema,
  EntityRefSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  JsonValueSchema,
  UuidSchema,
} from './common.js';

export const EvidenceKindSchema = z.enum([
  'enterprise_snapshot',
  'document_page',
  'policy_version',
  'knowledge_chunk',
  'calculation',
  'historical_memory',
  'reconciliation_report',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const BoundingBoxSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export const EvidenceLocatorSchema = z
  .object({
    documentVersionId: UuidSchema.nullable(),
    page: z.number().int().positive().max(1000).nullable(),
    startOffset: z.number().int().nonnegative().max(10_000_000).nullable(),
    endOffset: z.number().int().nonnegative().max(10_000_000).nullable(),
    bbox: BoundingBoxSchema.optional(),
  })
  .strict()
  .refine(
    (locator) =>
      locator.startOffset === null ||
      locator.endOffset === null ||
      locator.endOffset > locator.startOffset,
    'endOffset must be greater than startOffset',
  );
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export const EvidenceSchema = z
  .object({
    id: EntityIdSchema,
    sandboxId: EntityIdSchema,
    caseId: EntityIdSchema.nullable(),
    kind: EvidenceKindSchema,
    sourceRef: EntityRefSchema.nullable(),
    sourceStatus: z.enum(['available', 'missing']),
    missingReason: z.string().min(1).max(1000).nullable(),
    contentHash: HashSchema,
    locator: EvidenceLocatorSchema.nullable(),
    capturedFacts: JsonValueSchema,
    capturedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const EvidenceCreateInputSchema = z
  .object({
    caseId: EntityIdSchema.nullable(),
    kind: EvidenceKindSchema,
    sourceStatus: z.enum(['available', 'missing']),
    sourceRef: EntityRefSchema.nullable(),
    sourceSandboxId: EntityIdSchema.nullable(),
    contentHash: HashSchema.nullable(),
    locator: EvidenceLocatorSchema.nullable(),
    capturedFacts: JsonValueSchema,
    missingReason: z.string().min(1).max(1000).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.sourceStatus === 'missing'
        ? value.sourceRef === null &&
          value.sourceSandboxId === null &&
          value.missingReason !== null
        : value.sourceRef !== null &&
          value.sourceSandboxId !== null &&
          value.missingReason === null,
    'Evidence source status, source reference and missing reason are inconsistent',
  );
export type EvidenceCreateInput = z.infer<typeof EvidenceCreateInputSchema>;

export const FieldSourceSchema = z
  .object({
    documentVersionId: UuidSchema,
    page: z.number().int().positive().max(1000),
    start: z.number().int().nonnegative().max(10_000_000),
    end: z.number().int().nonnegative().max(10_000_000),
    bbox: BoundingBoxSchema.optional(),
  })
  .strict()
  .refine((source) => source.end > source.start, 'end must be greater than start');
export type FieldSource = z.infer<typeof FieldSourceSchema>;

export const ExtractedFieldSchema = z
  .object({
    value: z.string().min(1).max(5000).nullable(),
    source: FieldSourceSchema.nullable(),
    status: z.enum(['extracted', 'corrected', 'missing', 'ambiguous']),
    alternatives: z.array(z.string().min(1).max(5000)).max(10).optional(),
  })
  .strict();
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

export const StructuredClaimPredicateSchema = z.enum([
  'document_stated_value',
  'inventory_quantity',
  'calculated_cost',
  'calculated_penalty',
  'calculated_difference',
  'entity_status',
  'policy_rule',
  'eligibility_result',
]);
export type StructuredClaimPredicate = z.infer<typeof StructuredClaimPredicateSchema>;

export const StructuredClaimSchema = z
  .object({
    predicate: StructuredClaimPredicateSchema,
    subjectRef: EntityRefSchema,
    value: JsonValueSchema,
    evidenceId: EntityIdSchema,
  })
  .strict();
export type StructuredClaim = z.infer<typeof StructuredClaimSchema>;

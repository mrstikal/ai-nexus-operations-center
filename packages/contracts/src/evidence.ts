import { z } from 'zod';
import {
  EntityIdSchema,
  EntityRefSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  JsonValueSchema,
  UuidSchema,
} from './common.js';

export const DOCUMENT_STATUSES = [
  'uploaded',
  'validating',
  'extracting',
  'needs_review',
  'ready',
  'rejected',
  'failed',
] as const;

export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentMediaTypeSchema = z.enum([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'message/rfc822',
  'text/plain',
]);

export const DocumentVersionSchema = z
  .object({
    id: EntityIdSchema,
    documentId: EntityIdSchema,
    sandboxId: EntityIdSchema,
    blobHash: HashSchema,
    mediaType: DocumentMediaTypeSchema,
    originalFilename: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive().max(5_368_709_120),
    pageCount: z.number().int().positive().max(1000),
    sourceEventId: UuidSchema.nullable(),
    status: DocumentStatusSchema,
    parserVersion: z.string().min(1).max(100).nullable(),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const EvidenceKindSchema = z.enum([
  'enterprise_snapshot',
  'document_page',
  'policy_version',
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
    contentHash: HashSchema,
    locator: EvidenceLocatorSchema.nullable(),
    capturedFacts: JsonValueSchema,
    capturedAt: IsoUtcTimestampSchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

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

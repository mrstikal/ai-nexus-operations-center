import { z } from 'zod';
import {
  CursorPageSchema,
  EntityIdSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
  plainTextSchema,
} from './common.js';

export const KNOWLEDGE_SOURCE_PATH_PATTERN =
  /^fixtures\/(?:knowledge\/[a-z0-9][a-z0-9._-]{0,99}\.md|security\/inject-policy\.md)$/;

export const KnowledgeDocumentKindSchema = z.enum([
  'policy',
  'informational',
]);
export type KnowledgeDocumentKind = z.infer<typeof KnowledgeDocumentKindSchema>;

export const KnowledgeVersionStateSchema = z.enum([
  'draft',
  'published',
  'superseded',
  'withdrawn',
]);
export type KnowledgeVersionState = z.infer<typeof KnowledgeVersionStateSchema>;

export const KnowledgePolicyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Expected a lowercase policy identifier');

export const KnowledgeSourcePathSchema = z
  .string()
  .max(120)
  .regex(
    KNOWLEDGE_SOURCE_PATH_PATTERN,
    'Expected a registered knowledge markdown path',
  );

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

export const KnowledgeTextSchema = z
  .string()
  .min(1)
  .max(20_000)
  .refine(
    (value) => !hasControlCharacters(value),
    'Expected text without control characters',
  );

export const KnowledgeChunkLocatorSchema = z
  .object({
    sourcePath: KnowledgeSourcePathSchema,
    headingPath: z.array(z.string().min(1).max(200)).max(8),
    startOffset: z.number().int().nonnegative().max(10_000_000),
    endOffset: z.number().int().nonnegative().max(10_000_000),
  })
  .strict()
  .refine(
    (locator) => locator.endOffset > locator.startOffset,
    'endOffset must be greater than startOffset',
  );
export type KnowledgeChunkLocator = z.infer<typeof KnowledgeChunkLocatorSchema>;

export const KnowledgeChunkSchema = z
  .object({
    id: EntityIdSchema,
    documentVersionId: EntityIdSchema,
    policyBundleVersion: z.string().min(1).max(100).nullable(),
    text: KnowledgeTextSchema,
    locator: KnowledgeChunkLocatorSchema,
    score: z.number().finite().nonnegative(),
    evidenceId: EntityIdSchema,
  })
  .strict();
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export const KnowledgeSearchRequestSchema = z
  .object({
    query: plainTextSchema(500),
    limit: z.number().int().min(1).max(6).optional(),
    policyId: KnowledgePolicyIdSchema.optional(),
    kind: KnowledgeDocumentKindSchema.optional(),
    effectiveAt: IsoUtcTimestampSchema.optional(),
  })
  .strict();
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

export const KnowledgeSearchResponseSchema = z
  .object({
    mode: z.literal('lexical'),
    queryId: UuidSchema,
    noEvidence: z.boolean(),
    chunks: z.array(KnowledgeChunkSchema).max(6),
  })
  .strict();
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponseSchema>;

export const KnowledgeVersionSchema = z
  .object({
    id: EntityIdSchema,
    documentId: EntityIdSchema,
    versionNo: z.number().int().min(1).max(1_000_000),
    state: KnowledgeVersionStateSchema,
    contentSha256: HashSchema,
    policyBundleVersion: z.string().min(1).max(100).nullable(),
    policyContentHash: HashSchema.nullable(),
    effectiveFrom: IsoUtcTimestampSchema,
    effectiveUntil: IsoUtcTimestampSchema.nullable(),
    publishedAt: IsoUtcTimestampSchema.nullable(),
    withdrawnAt: IsoUtcTimestampSchema.nullable(),
    sourcePath: KnowledgeSourcePathSchema,
    charCount: z.number().int().nonnegative().max(10_000_000),
    chunkCount: z.number().int().nonnegative().max(10_000),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type KnowledgeVersion = z.infer<typeof KnowledgeVersionSchema>;

export const KnowledgeDocumentSchema = z
  .object({
    id: EntityIdSchema,
    sandboxId: EntityIdSchema,
    kind: KnowledgeDocumentKindSchema,
    policyId: KnowledgePolicyIdSchema.nullable(),
    sourcePath: KnowledgeSourcePathSchema,
    createdAt: IsoUtcTimestampSchema,
    latestVersion: KnowledgeVersionSchema.nullable(),
  })
  .strict();
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

export const KnowledgeIngestRequestSchema = z
  .object({
    kind: KnowledgeDocumentKindSchema,
    policyId: KnowledgePolicyIdSchema.optional(),
    path: KnowledgeSourcePathSchema,
    effectiveFrom: IsoUtcTimestampSchema.optional(),
  })
  .strict();
export type KnowledgeIngestRequest = z.infer<typeof KnowledgeIngestRequestSchema>;

export const KnowledgeIngestResponseSchema = z
  .object({
    document: KnowledgeDocumentSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type KnowledgeIngestResponse = z.infer<typeof KnowledgeIngestResponseSchema>;

export const KnowledgePublicationResponseSchema = z
  .object({
    document: KnowledgeDocumentSchema,
    version: KnowledgeVersionSchema,
    retrievalGeneration: z.number().int().positive().max(2_147_483_647),
    changed: z.boolean(),
    expiredProposalIds: z.array(UuidSchema).max(1000),
  })
  .strict();
export type KnowledgePublicationResponse = z.infer<
  typeof KnowledgePublicationResponseSchema
>;

export const KnowledgeRevokeRequestSchema = z
  .object({
    versionId: UuidSchema.optional(),
    reason: plainTextSchema(500),
  })
  .strict();
export type KnowledgeRevokeRequest = z.infer<typeof KnowledgeRevokeRequestSchema>;

export const KnowledgeListResponseSchema = CursorPageSchema(KnowledgeDocumentSchema);
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponseSchema>;

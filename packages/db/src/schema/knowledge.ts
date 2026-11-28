import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sandboxes } from './cases.js';
import { evidence } from './evidence.js';

export const nexusSchema = pgSchema('nexus');

export const knowledgeDocuments = nexusSchema.table(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    kind: text('kind').notNull(),
    policyId: text('policy_id'),
    sourcePath: text('source_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_documents_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    index('knowledge_documents_sandbox_created_idx').on(
      table.sandboxId,
      table.createdAt,
      table.id,
    ),
    check(
      'knowledge_documents_kind_check',
      sql`${table.kind} IN ('policy','informational')`,
    ),
    check(
      'knowledge_documents_policy_check',
      sql`(${table.kind} = 'policy' AND ${table.policyId} IS NOT NULL)
        OR (${table.kind} = 'informational' AND ${table.policyId} IS NULL)`,
    ),
    check(
      'knowledge_documents_path_check',
      sql`${table.sourcePath} ~ '^fixtures/(knowledge/[a-z0-9][a-z0-9._-]{0,99}|security/inject-policy)\\.md$'`,
    ),
  ],
);

export const knowledgeVersions = nexusSchema.table(
  'knowledge_versions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionNo: integer('version_no').notNull(),
    state: text('state').notNull(),
    contentSha256: text('content_sha256').notNull(),
    policyBundleVersion: text('policy_bundle_version'),
    policyContentHash: text('policy_content_hash'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    sourcePath: text('source_path').notNull(),
    charCount: integer('char_count').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_versions_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    uniqueIndex('knowledge_versions_document_version_key').on(
      table.sandboxId,
      table.documentId,
      table.versionNo,
    ),
    index('knowledge_versions_publication_idx').on(
      table.sandboxId,
      table.state,
      table.effectiveFrom,
    ),
    foreignKey({
      columns: [table.sandboxId, table.documentId],
      foreignColumns: [knowledgeDocuments.sandboxId, knowledgeDocuments.id],
    }),
    check(
      'knowledge_versions_state_check',
      sql`${table.state} IN ('draft','published','superseded','withdrawn')`,
    ),
    check(
      'knowledge_versions_version_check',
      sql`${table.versionNo} BETWEEN 1 AND 1000000`,
    ),
    check(
      'knowledge_versions_content_hash_check',
      sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'knowledge_versions_policy_hash_check',
      sql`${table.policyContentHash} IS NULL
        OR ${table.policyContentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'knowledge_versions_policy_link_check',
      sql`(${table.policyBundleVersion} IS NULL AND ${table.policyContentHash} IS NULL)
        OR (${table.policyBundleVersion} IS NOT NULL AND length(${table.policyBundleVersion}) BETWEEN 1 AND 100 AND ${table.policyContentHash} IS NOT NULL)`,
    ),
    check(
      'knowledge_versions_count_check',
      sql`${table.charCount} >= 0 AND ${table.chunkCount} BETWEEN 1 AND 10000`,
    ),
    check(
      'knowledge_versions_path_check',
      sql`${table.sourcePath} ~ '^fixtures/(knowledge/[a-z0-9][a-z0-9._-]{0,99}|security/inject-policy)\\.md$'`,
    ),
    check(
      'knowledge_versions_withdrawn_check',
      sql`${table.withdrawnAt} IS NULL OR ${table.state} IN ('withdrawn','superseded')`,
    ),
  ],
);

export const knowledgeChunks = nexusSchema.table(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    headingPath: jsonb('heading_path').$type<string[]>().notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull(),
    tokenCount: integer('token_count').notNull(),
    locator: jsonb('locator').$type<Record<string, unknown>>().notNull(),
    contentSha256: text('content_sha256').notNull(),
    evidenceId: uuid('evidence_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_chunks_version_index_key').on(
      table.sandboxId,
      table.documentVersionId,
      table.chunkIndex,
    ),
    index('knowledge_chunks_version_idx').on(
      table.sandboxId,
      table.documentVersionId,
    ),
    index('knowledge_chunks_evidence_idx').on(
      table.sandboxId,
      table.evidenceId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.documentVersionId],
      foreignColumns: [knowledgeVersions.sandboxId, knowledgeVersions.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.evidenceId],
      foreignColumns: [evidence.sandboxId, evidence.id],
    }),
    check(
      'knowledge_chunks_index_check',
      sql`${table.chunkIndex} BETWEEN 0 AND 9999`,
    ),
    check(
      'knowledge_chunks_text_check',
      sql`char_length(${table.text}) BETWEEN 1 AND 20000 AND ${table.charCount} = char_length(${table.text})`,
    ),
    check(
      'knowledge_chunks_token_check',
      sql`${table.tokenCount} BETWEEN 1 AND 1200`,
    ),
    check(
      'knowledge_chunks_hash_check',
      sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const knowledgeRetrievalState = nexusSchema.table(
  'knowledge_retrieval_state',
  {
    sandboxId: uuid('sandbox_id')
      .primaryKey()
      .references(() => sandboxes.id),
    generation: integer('generation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'knowledge_retrieval_state_generation_check',
      sql`${table.generation} BETWEEN 1 AND 2147483647`,
    ),
  ],
);

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeVersionRow = typeof knowledgeVersions.$inferSelect;
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;
export type KnowledgeRetrievalStateRow =
  typeof knowledgeRetrievalState.$inferSelect;

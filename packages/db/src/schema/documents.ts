import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cases, sandboxes } from './cases.js';

export const nexusSchema = pgSchema('nexus');

export const blobs = nexusSchema.table(
  'blobs',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mediaType: text('media_type').notNull(),
    storageKey: text('storage_key').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('blobs_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('blobs_storage_key_key').on(table.storageKey),
    uniqueIndex('blobs_sandbox_sha_active_key')
      .on(table.sandboxId, table.sha256)
      .where(sql`${table.state} = 'available'`),
    check('blobs_sha_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'blobs_size_check',
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 15728640`,
    ),
    check(
      'blobs_media_type_check',
      sql`${table.mediaType} IN ('application/pdf','message/rfc822','text/plain','image/png','image/jpeg')`,
    ),
    check('blobs_state_check', sql`${table.state} IN ('available','deleted')`),
    check(
      'blobs_storage_key_check',
      sql`${table.storageKey} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`,
    ),
  ],
);

export const blobStorageState = nexusSchema.table(
  'blob_storage_state',
  {
    singleton: boolean('singleton').primaryKey(),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('blob_storage_state_used_check', sql`${table.usedBytes} >= 0`),
  ],
);

export const documents = nexusSchema.table(
  'documents',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    caseId: uuid('case_id'),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('documents_sandbox_id_id_key').on(table.sandboxId, table.id),
    index('documents_sandbox_status_idx').on(
      table.sandboxId,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    check(
      'documents_status_check',
      sql`${table.status} IN ('uploaded','validating','extracting','needs_review','ready','rejected','failed')`,
    ),
    check('documents_version_check', sql`${table.version} >= 1`),
  ],
);

export const documentVersions = nexusSchema.table(
  'document_versions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionNo: integer('version_no').notNull(),
    blobId: uuid('blob_id').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull(),
    pageCount: integer('page_count'),
    parserVersion: text('parser_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('document_versions_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    uniqueIndex('document_versions_document_version_key').on(
      table.sandboxId,
      table.documentId,
      table.versionNo,
    ),
    index('document_versions_blob_idx').on(table.sandboxId, table.blobId),
    foreignKey({
      columns: [table.sandboxId, table.documentId],
      foreignColumns: [documents.sandboxId, documents.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.blobId],
      foreignColumns: [blobs.sandboxId, blobs.id],
    }),
    check(
      'document_versions_status_check',
      sql`${table.status} IN ('uploaded','validating','extracting','needs_review','ready','rejected','failed')`,
    ),
    check(
      'document_versions_media_type_check',
      sql`${table.mediaType} IN ('application/pdf','message/rfc822','text/plain','image/png','image/jpeg')`,
    ),
    check(
      'document_versions_size_check',
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 15728640`,
    ),
    check(
      'document_versions_sha_check',
      sql`${table.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'document_versions_filename_check',
      sql`length(${table.filename}) BETWEEN 1 AND 200`,
    ),
    check(
      'document_versions_page_count_check',
      sql`${table.pageCount} IS NULL OR ${table.pageCount} BETWEEN 1 AND 1000`,
    ),
    check(
      'document_versions_parser_version_check',
      sql`${table.parserVersion} IS NULL OR length(${table.parserVersion}) BETWEEN 1 AND 100`,
    ),
    check(
      'document_versions_version_check',
      sql`${table.versionNo} >= 1`,
    ),
  ],
);

export const extractionJobs = nexusSchema.table(
  'extraction_jobs',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    state: text('state').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('extraction_jobs_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    index('extraction_jobs_claim_idx').on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    uniqueIndex('extraction_jobs_active_version_key')
      .on(table.sandboxId, table.documentVersionId)
      .where(sql`${table.state} IN ('pending','leased')`),
    foreignKey({
      columns: [table.sandboxId, table.documentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    check(
      'extraction_jobs_state_check',
      sql`${table.state} IN ('pending','leased','succeeded','failed','cancelled')`,
    ),
    check(
      'extraction_jobs_attempt_check',
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 3 AND ${table.attemptCount} <= 3`,
    ),
  ],
);

export const documentUploads = nexusSchema.table(
  'document_uploads',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    actorId: text('actor_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    duplicateOf: uuid('duplicate_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('document_uploads_idempotency_key').on(
      table.sandboxId,
      table.actorId,
      table.idempotencyKey,
    ),
    uniqueIndex('document_uploads_version_key').on(table.documentVersionId),
    foreignKey({
      columns: [table.sandboxId, table.documentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    check(
      'document_uploads_request_hash_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const documentPageTexts = nexusSchema.table(
  'document_page_texts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    documentVersionId: uuid('document_version_id').notNull(),
    pageNo: integer('page_no').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('document_page_texts_version_page_key').on(
      table.sandboxId,
      table.documentVersionId,
      table.pageNo,
    ),
    index('document_page_texts_version_idx').on(
      table.sandboxId,
      table.documentVersionId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.documentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    check(
      'document_page_texts_page_check',
      sql`${table.pageNo} BETWEEN 1 AND 20`,
    ),
    check(
      'document_page_texts_text_check',
      sql`char_length(${table.text}) <= 200000 AND ${table.charCount} = char_length(${table.text})`,
    ),
  ],
);

export const documentAttachments = nexusSchema.table(
  'document_attachments',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    parentDocumentVersionId: uuid('parent_document_version_id').notNull(),
    attachmentDocumentVersionId: uuid('attachment_document_version_id').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('document_attachments_parent_sha_key').on(
      table.sandboxId,
      table.parentDocumentVersionId,
      table.sha256,
    ),
    uniqueIndex('document_attachments_parent_version_key').on(
      table.sandboxId,
      table.parentDocumentVersionId,
      table.attachmentDocumentVersionId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.parentDocumentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.attachmentDocumentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    check(
      'document_attachments_media_type_check',
      sql`${table.mediaType} IN ('application/pdf','message/rfc822','text/plain','image/png','image/jpeg')`,
    ),
    check(
      'document_attachments_size_check',
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 15728640`,
    ),
    check(
      'document_attachments_sha_check',
      sql`${table.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'document_attachments_filename_check',
      sql`length(${table.filename}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const documentExtractionCache = nexusSchema.table(
  'document_extraction_cache',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    blobSha256: text('blob_sha256').notNull(),
    parserVersion: text('parser_version').notNull(),
    sourceDocumentVersionId: uuid('source_document_version_id').notNull(),
    format: text('format').notNull(),
    status: text('status').notNull(),
    reasonCode: text('reason_code'),
    pageCount: integer('page_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('document_extraction_cache_key').on(
      table.sandboxId,
      table.blobSha256,
      table.parserVersion,
    ),
    foreignKey({
      columns: [table.sandboxId, table.sourceDocumentVersionId],
      foreignColumns: [documentVersions.sandboxId, documentVersions.id],
    }),
    check(
      'document_extraction_cache_sha_check',
      sql`${table.blobSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'document_extraction_cache_format_check',
      sql`${table.format} IN ('digital_pdf','email','text')`,
    ),
    check(
      'document_extraction_cache_status_check',
      sql`${table.status} IN ('ready','needs_review','rejected')`,
    ),
    check(
      'document_extraction_cache_page_count_check',
      sql`${table.pageCount} BETWEEN 1 AND 20`,
    ),
    check(
      'document_extraction_cache_parser_version_check',
      sql`length(${table.parserVersion}) BETWEEN 1 AND 100`,
    ),
  ],
);

export type BlobRow = typeof blobs.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type ExtractionJobRow = typeof extractionJobs.$inferSelect;
export type DocumentUploadRow = typeof documentUploads.$inferSelect;
export type DocumentPageTextRow = typeof documentPageTexts.$inferSelect;
export type DocumentAttachmentRow = typeof documentAttachments.$inferSelect;
export type DocumentExtractionCacheRow = typeof documentExtractionCache.$inferSelect;

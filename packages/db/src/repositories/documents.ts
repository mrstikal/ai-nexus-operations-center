import { sql } from 'drizzle-orm';
import {
  DocumentUploadResponseSchema,
  SandboxSummarySchema,
  type DocumentUploadResponse,
  type DocumentVersion,
  type SandboxSummary,
} from '@nexus/contracts';
import { sanitizeAuditDetails } from '@nexus/observability/redaction';
import type {
  CompleteDocumentUploadInput,
  DocumentStore,
  DocumentUploadCursor,
} from '@nexus/application/documents/upload';
import type { AppendAuditStoreInput } from '@nexus/application/cases/service';
import type { NexusDb } from '../connection.js';
import {
  blobStorageState,
  blobs,
  documentUploads,
  documentVersions,
  documents,
  extractionJobs,
} from '../schema/documents.js';
import { activeSandbox, sandboxes } from '../schema/cases.js';
import { appendAuditInTransaction } from './audit.js';
import type { DbTransaction } from './types.js';

type Executor = Pick<NexusDb, 'execute'> | Pick<DbTransaction, 'execute'>;

interface VersionRow {
  version_id: string;
  document_id: string;
  case_id: string | null;
  filename: string;
  media_type: string;
  size_bytes: string | number;
  sha256: string;
  status: string;
  page_count: number | null;
  parser_version: string | null;
  version_no: number;
  created_at: Date | string;
  job_id?: string | null;
  duplicate_of?: string | null;
  storage_key?: string;
}

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function documentVersion(row: VersionRow): DocumentVersion {
  return {
    id: row.version_id,
    documentId: row.document_id,
    sandboxId: '',
    caseId: row.case_id,
    blobHash: row.sha256,
    mediaType: row.media_type as DocumentVersion['mediaType'],
    originalFilename: row.filename,
    sizeBytes: Number(row.size_bytes),
    pageCount: row.page_count,
    sourceEventId: null,
    status: row.status as DocumentVersion['status'],
    parserVersion: row.parser_version,
    createdAt: iso(row.created_at),
  };
}

const UPLOAD_SELECT = sql`
  SELECT
    v.id AS version_id,
    d.id AS document_id,
    d.case_id,
    v.filename,
    v.media_type,
    v.size_bytes,
    v.sha256,
    v.status,
    v.page_count,
    v.parser_version,
    v.version_no,
    v.created_at,
    u.duplicate_of,
    (
      SELECT j.id
      FROM nexus.extraction_jobs j
      WHERE j.sandbox_id = u.sandbox_id
        AND j.document_version_id = u.document_version_id
      ORDER BY j.created_at ASC, j.id ASC
      LIMIT 1
    ) AS job_id
  FROM nexus.document_uploads u
  JOIN nexus.document_versions v
    ON v.sandbox_id = u.sandbox_id AND v.id = u.document_version_id
  JOIN nexus.documents d
    ON d.sandbox_id = v.sandbox_id AND d.id = v.document_id
`;

async function loadUploadResponse(
  executor: Executor,
  sandboxId: string,
  actorId: string,
  idempotencyKey: string,
): Promise<DocumentUploadResponse | null> {
  const rows = asRows<VersionRow>(
    await executor.execute(sql`
      ${UPLOAD_SELECT}
      WHERE u.sandbox_id = ${sandboxId}
        AND u.actor_id = ${actorId}
        AND u.idempotency_key = ${idempotencyKey}
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (!row.job_id) {
    return null;
  }
  return DocumentUploadResponseSchema.parse({
    document: { ...documentVersion(row), sandboxId },
    jobId: row.job_id,
    duplicateOf: row.duplicate_of ?? null,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createDocumentStore(db: NexusDb): DocumentStore {
  return {
    async getActiveSandbox(): Promise<SandboxSummary | null> {
      const rows = await db
        .select({
          id: sandboxes.id,
          name: sandboxes.name,
          status: sandboxes.status,
          businessEffectiveAt: sandboxes.businessEffectiveAt,
        })
        .from(activeSandbox)
        .innerJoin(sandboxes, sql`${sandboxes.id} = ${activeSandbox.sandboxId}`)
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return SandboxSummarySchema.parse({
        id: row.id,
        name: row.name,
        status: row.status,
        businessEffectiveAt: iso(row.businessEffectiveAt),
      });
    },

    async findUpload(scope): Promise<DocumentUploadResponse | null> {
      return loadUploadResponse(
        db,
        scope.sandboxId,
        scope.actorId,
        scope.idempotencyKey,
      );
    },

    async completeUpload(input: CompleteDocumentUploadInput) {
      try {
        return await db.transaction(async (tx) => {
          const existing = asRows<{ id: string; request_hash: string }>(
            await tx.execute(sql`
              SELECT id, request_hash
              FROM nexus.document_uploads
              WHERE sandbox_id = ${input.sandboxId}
                AND actor_id = ${input.actorId}
                AND idempotency_key = ${input.idempotencyKey}
              LIMIT 1
            `),
          )[0];
          if (existing) {
            if (existing.request_hash !== input.requestHash) {
              return { kind: 'idempotency_mismatch' as const };
            }
            const response = await loadUploadResponse(
              tx,
              input.sandboxId,
              input.actorId,
              input.idempotencyKey,
            );
            return response
              ? { kind: 'existing' as const, response }
              : { kind: 'conflict' as const };
          }
          if (input.caseId !== null) {
            const caseRows = asRows<{ id: string }>(
              await tx.execute(sql`
                SELECT id FROM nexus.cases
                WHERE sandbox_id = ${input.sandboxId} AND id = ${input.caseId}
                LIMIT 1
              `),
            );
            if (!caseRows[0]) {
              return { kind: 'case_not_found' as const };
            }
          }
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(
                ${`${input.sandboxId}:${input.sha256}`},
                0
              )
            )
          `);
          let blob = asRows<{ id: string; storage_key: string }>(
            await tx.execute(sql`
              SELECT id, storage_key
              FROM nexus.blobs
              WHERE sandbox_id = ${input.sandboxId}
                AND sha256 = ${input.sha256}
                AND state = 'available'
              LIMIT 1
            `),
          )[0];
          let duplicateOf: string | null = null;
          if (blob) {
            const duplicateRows = asRows<{ document_id: string }>(
              await tx.execute(sql`
                SELECT document_id
                FROM nexus.document_versions
                WHERE sandbox_id = ${input.sandboxId} AND blob_id = ${blob.id}
                ORDER BY created_at ASC, id ASC
                LIMIT 1
              `),
            );
            duplicateOf = duplicateRows[0]?.document_id ?? null;
          } else {
            const stateRows = asRows<{ used_bytes: string }>(
              await tx.execute(sql`
                SELECT used_bytes
                FROM nexus.blob_storage_state
                WHERE singleton = true
                FOR UPDATE
              `),
            );
            const used = Number(stateRows[0]?.used_bytes ?? '0');
            if (used + input.sizeBytes > input.blobAdmissionBytes) {
              return { kind: 'admission_exceeded' as const };
            }
            blob = asRows<{ id: string; storage_key: string }>(
              await tx.execute(sql`
                SELECT id, storage_key
                FROM nexus.blobs
                WHERE sandbox_id = ${input.sandboxId}
                  AND sha256 = ${input.sha256}
                  AND state = 'available'
                LIMIT 1
              `),
            )[0];
            if (blob) {
              const duplicateRows = asRows<{ document_id: string }>(
                await tx.execute(sql`
                  SELECT document_id
                  FROM nexus.document_versions
                  WHERE sandbox_id = ${input.sandboxId} AND blob_id = ${blob.id}
                  ORDER BY created_at ASC, id ASC
                  LIMIT 1
                `),
              );
              duplicateOf = duplicateRows[0]?.document_id ?? null;
            } else {
              await tx.insert(blobs).values({
                id: input.blobId,
                sandboxId: input.sandboxId,
                sha256: input.sha256,
                sizeBytes: input.sizeBytes,
                mediaType: input.mediaType,
                storageKey: input.storageKey,
                state: 'available',
                createdAt: sql`clock_timestamp()`,
              });
              await tx
                .update(blobStorageState)
                .set({
                  usedBytes: sql`${blobStorageState.usedBytes} + ${input.sizeBytes}`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(sql`${blobStorageState.singleton} = true`);
              blob = { id: input.blobId, storage_key: input.storageKey };
            }
          }
          if (!blob) {
            throw new Error('Blob resolution failed');
          }
          const documentRows = await tx
            .insert(documents)
            .values({
              id: input.documentId,
              sandboxId: input.sandboxId,
              caseId: input.caseId,
              status: 'uploaded',
              version: 1,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .returning({ createdAt: documents.createdAt });
          const documentCreatedAt = documentRows[0]?.createdAt;
          if (!documentCreatedAt) {
            throw new Error('Document insert returned no row');
          }
          const versionRows = await tx
            .insert(documentVersions)
            .values({
              id: input.documentVersionId,
              sandboxId: input.sandboxId,
              documentId: input.documentId,
              versionNo: 1,
              blobId: blob.id,
              filename: input.filename,
              mediaType: input.mediaType,
              sizeBytes: input.sizeBytes,
              sha256: input.sha256,
              status: 'uploaded',
              pageCount: null,
              parserVersion: null,
              createdAt: sql`clock_timestamp()`,
            })
            .returning({ createdAt: documentVersions.createdAt });
          const versionCreatedAt = versionRows[0]?.createdAt;
          if (!versionCreatedAt) {
            throw new Error('Document version insert returned no row');
          }
          await tx.insert(extractionJobs).values({
            id: input.jobId,
            sandboxId: input.sandboxId,
            documentVersionId: input.documentVersionId,
            state: 'pending',
            attemptCount: 0,
            maxAttempts: 3,
            availableAt: sql`clock_timestamp()`,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            version: 0,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await tx.insert(documentUploads).values({
            id: input.uploadId,
            sandboxId: input.sandboxId,
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            documentVersionId: input.documentVersionId,
            duplicateOf,
            createdAt: sql`clock_timestamp()`,
          });
          const audit: AppendAuditStoreInput = {
            sandboxId: input.sandboxId,
            actor: input.actor,
            requestId: input.requestId,
            correlationId: input.correlationId,
            runId: null,
            action: 'document.uploaded',
            targetType: 'document',
            targetId: input.documentId,
            targetVersion: '1',
            beforeHash: null,
            afterHash: input.sha256,
            outcome: 'succeeded',
            details: sanitizeAuditDetails({
              documentId: input.documentId,
              documentVersionId: input.documentVersionId,
              jobId: input.jobId,
              caseId: input.caseId,
              mediaType: input.mediaType,
              sizeBytes: input.sizeBytes,
              contentHash: input.sha256,
              status: 'uploaded',
              action: 'document.uploaded',
              outcome: 'succeeded',
            }),
          };
          await appendAuditInTransaction(tx, audit);
          const response = DocumentUploadResponseSchema.parse({
            document: {
              id: input.documentVersionId,
              documentId: input.documentId,
              sandboxId: input.sandboxId,
              caseId: input.caseId,
              blobHash: input.sha256,
              originalFilename: input.filename,
              mediaType: input.mediaType,
              sizeBytes: input.sizeBytes,
              pageCount: null,
              sourceEventId: null,
              status: 'uploaded',
              parserVersion: null,
              createdAt: iso(versionCreatedAt),
            },
            jobId: input.jobId,
            duplicateOf,
          });
          return { kind: 'created' as const, response };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadUploadResponse(
            db,
            input.sandboxId,
            input.actorId,
            input.idempotencyKey,
          );
          return raced
            ? { kind: 'existing' as const, response: raced }
            : { kind: 'conflict' as const };
        }
        throw error;
      }
    },

    async listDocuments(input: {
      readonly sandboxId: string;
      readonly limit: number;
      readonly after?: DocumentUploadCursor;
    }) {
      const rows = asRows<VersionRow>(
        await db.execute(sql`
          SELECT
            v.id AS version_id,
            d.id AS document_id,
            d.case_id,
            v.filename,
            v.media_type,
            v.size_bytes,
            v.sha256,
            v.status,
            v.page_count,
            v.parser_version,
            v.version_no,
            d.created_at
          FROM nexus.documents d
          JOIN nexus.document_versions v
            ON v.sandbox_id = d.sandbox_id
           AND v.document_id = d.id
           AND v.version_no = d.version
          WHERE d.sandbox_id = ${input.sandboxId}
          ${
            input.after
              ? sql`AND (date_trunc('milliseconds', d.created_at), d.id) < (${new Date(input.after.createdAt)}, ${input.after.documentId}::uuid)`
              : sql``
          }
          ORDER BY date_trunc('milliseconds', d.created_at) DESC, d.id DESC
          LIMIT ${input.limit + 1}
        `),
      );
      const hasMore = rows.length > input.limit;
      return {
        items: rows.slice(0, input.limit).map((row) => ({
          ...documentVersion(row),
          sandboxId: input.sandboxId,
        })),
        hasMore,
      };
    },

    async getDocument(sandboxId, documentId): Promise<DocumentVersion | null> {
      const rows = asRows<VersionRow>(
        await db.execute(sql`
          SELECT
            v.id AS version_id,
            d.id AS document_id,
            d.case_id,
            v.filename,
            v.media_type,
            v.size_bytes,
            v.sha256,
            v.status,
            v.page_count,
            v.parser_version,
            v.version_no,
            d.created_at
          FROM nexus.documents d
          JOIN nexus.document_versions v
            ON v.sandbox_id = d.sandbox_id
           AND v.document_id = d.id
           AND v.version_no = d.version
          WHERE d.sandbox_id = ${sandboxId} AND d.id = ${documentId}
          LIMIT 1
        `),
      );
      const row = rows[0];
      return row ? { ...documentVersion(row), sandboxId } : null;
    },

    async getDownload(
      sandboxId,
      documentId,
    ): Promise<{ document: DocumentVersion; storageKey: string } | null> {
      const rows = asRows<VersionRow>(
        await db.execute(sql`
          SELECT
            v.id AS version_id,
            d.id AS document_id,
            d.case_id,
            v.filename,
            v.media_type,
            v.size_bytes,
            v.sha256,
            v.status,
            v.page_count,
            v.parser_version,
            v.version_no,
            d.created_at,
            b.storage_key
          FROM nexus.documents d
          JOIN nexus.document_versions v
            ON v.sandbox_id = d.sandbox_id
           AND v.document_id = d.id
           AND v.version_no = d.version
          JOIN nexus.blobs b
            ON b.sandbox_id = v.sandbox_id AND b.id = v.blob_id
          WHERE d.sandbox_id = ${sandboxId} AND d.id = ${documentId}
          LIMIT 1
        `),
      );
      const row = rows[0];
      if (!row?.storage_key) {
        return null;
      }
      return {
        document: { ...documentVersion(row), sandboxId },
        storageKey: row.storage_key,
      };
    },
  };
}

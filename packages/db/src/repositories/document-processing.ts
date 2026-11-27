import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type { AppendAuditStoreInput } from '@nexus/application/cases/service';
import type {
  CachedExtraction,
  CompleteJobResult,
  DocumentProcessingStore,
  ExtractionJobClaim,
  ProcessingAttachment,
  ProcessingOutcome,
} from '@nexus/application/documents/processing';
import type { NexusDb } from '../connection.js';
import { eventOutbox } from '../schema/events.js';
import {
  blobStorageState,
  blobs,
  documentVersions,
  documents,
  extractionJobs,
} from '../schema/documents.js';
import { appendAuditInTransaction } from './audit.js';
import type { DbTransaction } from './types.js';

export interface DocumentProcessingStoreOptions {
  readonly blobAdmissionBytes: number;
}

interface ClaimRow {
  job_id: string;
  sandbox_id: string;
  document_version_id: string;
  document_id: string;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string;
  lease_expires_at: Date | string;
  filename: string;
  media_type: string;
  size_bytes: string | number;
  sha256: string;
  case_id: string | null;
  storage_key: string;
}

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function iso(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function auditInput(input: {
  readonly claim: ExtractionJobClaim;
  readonly outcome: ProcessingOutcome;
  readonly action: string;
  readonly outcomeStatus: 'succeeded' | 'failed';
  readonly targetVersion: string;
  readonly attachmentCount: number;
  readonly attachmentHashes: readonly string[];
}): AppendAuditStoreInput {
  const afterHash = canonicalJsonSha256({
    documentVersionId: input.claim.documentVersionId,
    status: input.outcome.status,
    pageCount: input.outcome.pageCount,
    parserVersion: input.outcome.parserVersion,
    attachmentHashes: [...input.attachmentHashes].sort(),
  });
  return {
    sandboxId: input.claim.sandboxId,
    actor: { kind: 'service', id: 'document-extractor', roles: [] },
    requestId: `extraction:${input.claim.jobId}`.slice(0, 128),
    correlationId: `document:${input.claim.documentVersionId}`.slice(0, 128),
    runId: null,
    action: input.action,
    targetType: 'document',
    targetId: input.claim.documentId,
    targetVersion: input.targetVersion,
    beforeHash: null,
    afterHash,
    outcome: input.outcomeStatus,
    details: {
      documentId: input.claim.documentId,
      documentVersionId: input.claim.documentVersionId,
      jobId: input.claim.jobId,
      pageCount: input.outcome.pageCount,
      attachmentCount: input.attachmentCount,
      parserVersion: input.outcome.parserVersion,
      reasonCode: input.outcome.reasonCode,
      status: input.outcome.status,
      action: input.action,
      outcome: input.outcomeStatus,
    },
  };
}

async function assertClaim(
  tx: DbTransaction,
  claim: ExtractionJobClaim,
): Promise<boolean> {
  const rows = asRows<{
    state: string;
    lease_owner: string | null;
    active: boolean;
  }>(
    await tx.execute(sql`
      SELECT state, lease_owner,
             lease_expires_at > clock_timestamp() AS active
      FROM nexus.extraction_jobs
      WHERE id = ${claim.jobId}
      FOR UPDATE
    `),
  );
  const row = rows[0];
  return (
    row !== undefined &&
    row.state === 'leased' &&
    row.lease_owner === claim.leaseOwner &&
    row.active === true
  );
}

async function currentDocumentVersion(
  tx: DbTransaction,
  claim: ExtractionJobClaim,
): Promise<{ versionNo: number; status: string }> {
  const rows = asRows<{ version_no: number; status: string }>(
    await tx.execute(sql`
      SELECT version_no, status
      FROM nexus.document_versions
      WHERE sandbox_id = ${claim.sandboxId} AND id = ${claim.documentVersionId}
      FOR UPDATE
    `),
  );
  const version = rows[0];
  if (!version) {
    throw new Error('Document version disappeared during extraction');
  }
  return { versionNo: version.version_no, status: version.status };
}

async function insertPageTexts(
  tx: DbTransaction,
  claim: ExtractionJobClaim,
  outcome: ProcessingOutcome,
): Promise<void> {
  for (const page of outcome.pages) {
    await tx.execute(sql`
      INSERT INTO nexus.document_page_texts (
        id, sandbox_id, document_version_id, page_no, text, char_count, created_at
      ) VALUES (
        ${randomUUID()}, ${claim.sandboxId}, ${claim.documentVersionId},
        ${page.page}, ${page.text}, ${page.charCount}, clock_timestamp()
      )
      ON CONFLICT (sandbox_id, document_version_id, page_no) DO NOTHING
    `);
  }
  const countRows = asRows<{ count: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM nexus.document_page_texts
      WHERE sandbox_id = ${claim.sandboxId}
        AND document_version_id = ${claim.documentVersionId}
    `),
  );
  if ((countRows[0]?.count ?? 0) !== outcome.pageCount) {
    throw new Error('Stored page text count does not match the extraction');
  }
}

async function markDocumentStatus(
  tx: DbTransaction,
  claim: ExtractionJobClaim,
  status: string,
  pageCount: number | null,
  parserVersion: string | null,
): Promise<number> {
  await tx.execute(sql`
    UPDATE nexus.document_versions
    SET status = ${status},
        page_count = ${pageCount},
        parser_version = ${parserVersion}
    WHERE sandbox_id = ${claim.sandboxId}
      AND id = ${claim.documentVersionId}
  `);
  const rows = asRows<{ version: number }>(
    await tx.execute(sql`
      UPDATE nexus.documents
      SET status = ${status},
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE sandbox_id = ${claim.sandboxId}
        AND id = ${claim.documentId}
      RETURNING version
    `),
  );
  return rows[0]?.version ?? 1;
}

async function appendExtractionAudit(
  tx: DbTransaction,
  input: Parameters<typeof auditInput>[0],
): Promise<void> {
  await appendAuditInTransaction(tx, auditInput(input));
}

export function createDocumentProcessingStore(
  db: NexusDb,
  options: DocumentProcessingStoreOptions,
): DocumentProcessingStore {
  if (
    !Number.isSafeInteger(options.blobAdmissionBytes) ||
    options.blobAdmissionBytes < 1
  ) {
    throw new Error('Invalid blob admission configuration');
  }

  return {
    async claimJob(ownerId, leaseMs): Promise<ExtractionJobClaim | null> {
      const rows = asRows<ClaimRow>(
        await db.execute(sql`
          WITH candidate AS (
            SELECT id
            FROM nexus.extraction_jobs
            WHERE (
                (state = 'pending' AND available_at <= clock_timestamp())
                OR (state = 'leased' AND lease_expires_at <= clock_timestamp())
              )
              AND attempt_count < max_attempts
            ORDER BY available_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          ),
          claimed AS (
            UPDATE nexus.extraction_jobs AS job
            SET state = 'leased',
                lease_owner = ${ownerId},
                lease_expires_at =
                  clock_timestamp() + make_interval(secs => ${leaseMs}::double precision / 1000.0),
                attempt_count = job.attempt_count + 1,
                version = job.version + 1,
                updated_at = clock_timestamp()
            FROM candidate
            WHERE job.id = candidate.id
            RETURNING job.id, job.sandbox_id, job.document_version_id,
                      job.attempt_count, job.max_attempts, job.lease_owner,
                      job.lease_expires_at
          )
          SELECT claimed.id AS job_id,
                 claimed.sandbox_id,
                 claimed.document_version_id,
                 claimed.attempt_count,
                 claimed.max_attempts,
                 claimed.lease_owner,
                 claimed.lease_expires_at,
                 v.document_id,
                 v.filename,
                 v.media_type,
                 v.size_bytes,
                 v.sha256,
                 d.case_id,
                 b.storage_key
          FROM claimed
          JOIN nexus.document_versions AS v
            ON v.sandbox_id = claimed.sandbox_id
           AND v.id = claimed.document_version_id
          JOIN nexus.documents AS d
            ON d.sandbox_id = v.sandbox_id
           AND d.id = v.document_id
          JOIN nexus.blobs AS b
            ON b.sandbox_id = v.sandbox_id
           AND b.id = v.blob_id
          LIMIT 1
        `),
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        jobId: row.job_id,
        sandboxId: row.sandbox_id,
        documentId: row.document_id,
        documentVersionId: row.document_version_id,
        blobSha256: row.sha256,
        blobSizeBytes: Number(row.size_bytes),
        storageKey: row.storage_key,
        filename: row.filename,
        mediaType: row.media_type as ExtractionJobClaim['mediaType'],
        caseId: row.case_id,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: iso(row.lease_expires_at),
      };
    },

    async heartbeat(claim, leaseMs): Promise<boolean> {
      const result = await db.execute(sql`
        UPDATE nexus.extraction_jobs
        SET lease_expires_at =
              clock_timestamp() + make_interval(secs => ${leaseMs}::double precision / 1000.0),
            updated_at = clock_timestamp()
        WHERE id = ${claim.jobId}
          AND state = 'leased'
          AND lease_owner = ${claim.leaseOwner}
          AND lease_expires_at > clock_timestamp()
      `);
      return (result.rowCount ?? 0) > 0;
    },

    async reapExhausted(ownerId): Promise<number> {
      return db.transaction(async (tx) => {
        const rows = asRows<{
          id: string;
          sandbox_id: string;
          document_version_id: string;
          document_id: string;
        }>(
          await tx.execute(sql`
            WITH exhausted AS (
              SELECT id, sandbox_id, document_version_id
              FROM nexus.extraction_jobs
              WHERE state IN ('pending', 'leased')
                AND attempt_count >= max_attempts
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 10
            )
            UPDATE nexus.extraction_jobs AS job
            SET state = 'failed',
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = COALESCE(job.last_error, 'extraction attempts exhausted'),
                version = job.version + 1,
                updated_at = clock_timestamp()
            FROM exhausted
            WHERE job.id = exhausted.id
            RETURNING job.id, job.sandbox_id, job.document_version_id,
                      (SELECT d.id FROM nexus.documents AS d
                       JOIN nexus.document_versions AS v
                         ON v.sandbox_id = d.sandbox_id AND v.document_id = d.id
                       WHERE v.sandbox_id = job.sandbox_id
                         AND v.id = job.document_version_id) AS document_id
          `),
        );
        for (const row of rows) {
          const claim: ExtractionJobClaim = {
            jobId: row.id,
            sandboxId: row.sandbox_id,
            documentId: row.document_id,
            documentVersionId: row.document_version_id,
            blobSha256: '',
            blobSizeBytes: 0,
            storageKey: '',
            filename: '',
            mediaType: 'text/plain',
            caseId: null,
            attemptCount: 3,
            maxAttempts: 3,
            leaseOwner: ownerId,
            leaseExpiresAt: new Date(),
          };
          const documentVersion = await markDocumentStatus(
            tx,
            claim,
            'failed',
            null,
            null,
          );
          await appendExtractionAudit(tx, {
            claim,
            outcome: {
              status: 'rejected',
              reasonCode: 'MALFORMED',
              format: 'text',
              parserVersion: 'unknown',
              pageCount: 1,
              pages: [],
              attachments: [],
            },
            action: 'document.extraction_failed',
            outcomeStatus: 'failed',
            targetVersion: String(documentVersion),
            attachmentCount: 0,
            attachmentHashes: [],
          });
        }
        return rows.length;
      });
    },

    async findCachedExtraction(input): Promise<CachedExtraction | null> {
      const rows = asRows<{
        source_document_version_id: string;
        format: string;
        status: string;
        reason_code: string | null;
        parser_version: string;
        page_count: number;
      }>(
        await db.execute(sql`
          SELECT source_document_version_id, format, status, reason_code,
                 parser_version, page_count
          FROM nexus.document_extraction_cache
          WHERE sandbox_id = ${input.sandboxId}
            AND blob_sha256 = ${input.sha256}
            AND parser_version = ${input.parserVersion}
          LIMIT 1
        `),
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      const pageRows = asRows<{ page_no: number; text: string; char_count: number }>(
        await db.execute(sql`
          SELECT page_no, text, char_count
          FROM nexus.document_page_texts
          WHERE sandbox_id = ${input.sandboxId}
            AND document_version_id = ${row.source_document_version_id}
          ORDER BY page_no ASC
        `),
      );
      if (row.status !== 'rejected' && pageRows.length !== row.page_count) {
        return null;
      }
      const attachmentRows = asRows<{
        filename: string;
        media_type: string;
        size_bytes: string | number;
        sha256: string;
        attachment_document_version_id: string;
        document_id: string;
      }>(
        await db.execute(sql`
          SELECT a.filename, a.media_type, a.size_bytes, a.sha256,
                 a.attachment_document_version_id, v.document_id
          FROM nexus.document_attachments AS a
          JOIN nexus.document_versions AS v
            ON v.sandbox_id = a.sandbox_id
           AND v.id = a.attachment_document_version_id
          WHERE a.sandbox_id = ${input.sandboxId}
            AND a.parent_document_version_id = ${row.source_document_version_id}
          ORDER BY a.filename ASC, a.sha256 ASC
        `),
      );
      return {
        format: row.format as CachedExtraction['format'],
        status: row.status as CachedExtraction['status'],
        reasonCode: row.reason_code as CachedExtraction['reasonCode'],
        parserVersion: row.parser_version,
        pageCount: row.page_count,
        pages:
          row.status === 'rejected'
            ? []
            : pageRows.map((page) => ({
                page: page.page_no,
                text: page.text,
                charCount: page.char_count,
              })),
        attachments: attachmentRows.map((attachment) => ({
          filename: attachment.filename,
          mediaType: attachment.media_type as CachedExtraction['attachments'][number]['mediaType'],
          sizeBytes: Number(attachment.size_bytes),
          sha256: attachment.sha256,
          documentId: attachment.document_id,
          documentVersionId: attachment.attachment_document_version_id,
        })),
      };
    },

    async completeJob(claim, outcome, attachments): Promise<CompleteJobResult> {
      return db.transaction(async (tx) => {
        if (!(await assertClaim(tx, claim))) {
          return { kind: 'lease_lost' as const };
        }
        const version = await currentDocumentVersion(tx, claim);
        if (version.status === 'ready' || version.status === 'needs_review') {
          return { kind: 'completed' as const, unusedStorageKeys: [] };
        }

        const unusedStorageKeys: string[] = [];
        const seenSha = new Set<string>();
        const blobsToInsert: Array<{
          sha256: string;
          attachment: ProcessingAttachment;
        }> = [];
        const resolved: Array<{
          attachment: ProcessingAttachment;
          blobId: string;
          storageKey: string;
        }> = [];

        for (const attachment of attachments) {
          if (seenSha.has(attachment.sha256)) {
            if (attachment.storageKey !== null) {
              unusedStorageKeys.push(attachment.storageKey);
            }
            continue;
          }
          seenSha.add(attachment.sha256);
          if (attachment.existingDocumentVersionId !== null) {
            const rows = asRows<{ blob_id: string }>(
              await tx.execute(sql`
                SELECT v.blob_id
                FROM nexus.document_versions AS v
                JOIN nexus.blobs AS b
                  ON b.sandbox_id = v.sandbox_id AND b.id = v.blob_id
                WHERE v.sandbox_id = ${claim.sandboxId}
                  AND v.id = ${attachment.existingDocumentVersionId}
                  AND b.sha256 = ${attachment.sha256}
                LIMIT 1
              `),
            );
            if (!rows[0]) {
              throw new Error('Cached attachment is not available');
            }
            resolved.push({
              attachment,
              blobId: rows[0].blob_id,
              storageKey: '',
            });
            continue;
          }
          if (attachment.storageKey === null || attachment.blobId === null) {
            throw new Error('New attachment is missing its stored bytes');
          }
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${`${claim.sandboxId}:${attachment.sha256}`}, 0)
            )
          `);
          const existing = asRows<{ id: string; storage_key: string }>(
            await tx.execute(sql`
              SELECT id, storage_key
              FROM nexus.blobs
              WHERE sandbox_id = ${claim.sandboxId}
                AND sha256 = ${attachment.sha256}
                AND state = 'available'
              LIMIT 1
            `),
          )[0];
          if (existing) {
            unusedStorageKeys.push(attachment.storageKey);
            resolved.push({
              attachment,
              blobId: existing.id,
              storageKey: existing.storage_key,
            });
          } else {
            blobsToInsert.push({ sha256: attachment.sha256, attachment });
            resolved.push({
              attachment,
              blobId: attachment.blobId,
              storageKey: attachment.storageKey,
            });
          }
        }

        if (blobsToInsert.length > 0) {
          const stateRows = asRows<{ used_bytes: string }>(
            await tx.execute(sql`
              SELECT used_bytes
              FROM nexus.blob_storage_state
              WHERE singleton = true
              FOR UPDATE
            `),
          );
          const used = Number(stateRows[0]?.used_bytes ?? '0');
          const added = blobsToInsert.reduce(
            (total, entry) => total + entry.attachment.sizeBytes,
            0,
          );
          if (used + added > options.blobAdmissionBytes) {
            return { kind: 'admission_exceeded' as const };
          }
          for (const entry of blobsToInsert) {
            await tx.insert(blobs).values({
              id: entry.attachment.blobId ?? randomUUID(),
              sandboxId: claim.sandboxId,
              sha256: entry.attachment.sha256,
              sizeBytes: entry.attachment.sizeBytes,
              mediaType: entry.attachment.mediaType,
              storageKey: entry.attachment.storageKey ?? '',
              state: 'available',
              createdAt: sql`clock_timestamp()`,
            });
          }
          await tx
            .update(blobStorageState)
            .set({
              usedBytes: sql`${blobStorageState.usedBytes} + ${added}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(sql`${blobStorageState.singleton} = true`);
        }

        let attachmentCount = 0;
        const attachmentHashes: string[] = [];
        for (const entry of resolved) {
          const existingVersionId = entry.attachment.existingDocumentVersionId;
          let attachmentVersionId = existingVersionId;
          if (existingVersionId === null) {
            const attachmentDocumentId = randomUUID();
            attachmentVersionId = randomUUID();
            await tx.insert(documents).values({
              id: attachmentDocumentId,
              sandboxId: claim.sandboxId,
              caseId: claim.caseId,
              status: 'uploaded',
              version: 1,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            });
            await tx.insert(documentVersions).values({
              id: attachmentVersionId,
              sandboxId: claim.sandboxId,
              documentId: attachmentDocumentId,
              versionNo: 1,
              blobId: entry.blobId,
              filename: entry.attachment.filename,
              mediaType: entry.attachment.mediaType,
              sizeBytes: entry.attachment.sizeBytes,
              sha256: entry.attachment.sha256,
              status: 'uploaded',
              pageCount: null,
              parserVersion: null,
              createdAt: sql`clock_timestamp()`,
            });
            await tx.insert(extractionJobs).values({
              id: randomUUID(),
              sandboxId: claim.sandboxId,
              documentVersionId: attachmentVersionId,
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
          }
          if (!attachmentVersionId) {
            throw new Error('Attachment version resolution failed');
          }
          await tx.execute(sql`
            INSERT INTO nexus.document_attachments (
              id, sandbox_id, parent_document_version_id,
              attachment_document_version_id, filename, media_type,
              size_bytes, sha256, created_at
            ) VALUES (
              ${randomUUID()}, ${claim.sandboxId}, ${claim.documentVersionId},
              ${attachmentVersionId}, ${entry.attachment.filename},
              ${entry.attachment.mediaType}, ${entry.attachment.sizeBytes},
              ${entry.attachment.sha256}, clock_timestamp()
            )
            ON CONFLICT (sandbox_id, parent_document_version_id, sha256) DO NOTHING
          `);
          attachmentCount += 1;
          attachmentHashes.push(entry.attachment.sha256);
        }

        await insertPageTexts(tx, claim, outcome);
        const documentVersion = await markDocumentStatus(
          tx,
          claim,
          outcome.status,
          outcome.pageCount,
          outcome.parserVersion,
        );
        await tx.execute(sql`
          INSERT INTO nexus.document_extraction_cache (
            id, sandbox_id, blob_sha256, parser_version, source_document_version_id,
            format, status, reason_code, page_count, created_at
          ) VALUES (
            ${randomUUID()}, ${claim.sandboxId}, ${claim.blobSha256},
            ${outcome.parserVersion}, ${claim.documentVersionId},
            ${outcome.format}, ${outcome.status}, ${outcome.reasonCode},
            ${outcome.pageCount}, clock_timestamp()
          )
          ON CONFLICT (sandbox_id, blob_sha256, parser_version) DO NOTHING
        `);
        await appendExtractionAudit(tx, {
          claim,
          outcome,
          action: 'document.extracted',
          outcomeStatus: 'succeeded',
          targetVersion: String(documentVersion),
          attachmentCount,
          attachmentHashes,
        });
        if (outcome.status === 'ready') {
          await tx.insert(eventOutbox).values({
            id: randomUUID(),
            sandboxId: claim.sandboxId,
            eventType: 'nexus.document.ready.v1',
            schemaVersion: 1,
            producer: 'worker',
            occurredAt: new Date(),
            correlationId: `document:${claim.documentVersionId}`.slice(0, 128),
            causationId: claim.jobId,
            aggregateType: 'document',
            aggregateId: claim.documentId,
            aggregateVersion: documentVersion,
            payload: {
              documentId: claim.documentId,
              documentVersionId: claim.documentVersionId,
              contentHash: claim.blobSha256,
            },
            status: 'pending',
            attemptCount: 0,
            nextAttemptAt: sql`clock_timestamp()`,
            lastError: null,
            version: 0,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
        }
        await tx.execute(sql`
          UPDATE nexus.extraction_jobs
          SET state = 'succeeded',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${claim.jobId}
            AND state = 'leased'
            AND lease_owner = ${claim.leaseOwner}
        `);
        return { kind: 'completed' as const, unusedStorageKeys };
      });
    },

    async rejectJob(claim, outcome): Promise<CompleteJobResult> {
      return db.transaction(async (tx) => {
        if (!(await assertClaim(tx, claim))) {
          return { kind: 'lease_lost' as const };
        }
        const documentVersion = await markDocumentStatus(
          tx,
          claim,
          'rejected',
          null,
          outcome.parserVersion,
        );
        await tx.execute(sql`
          INSERT INTO nexus.document_extraction_cache (
            id, sandbox_id, blob_sha256, parser_version, source_document_version_id,
            format, status, reason_code, page_count, created_at
          ) VALUES (
            ${randomUUID()}, ${claim.sandboxId}, ${claim.blobSha256},
            ${outcome.parserVersion}, ${claim.documentVersionId},
            ${outcome.format}, 'rejected', ${outcome.reasonCode},
            ${outcome.pageCount}, clock_timestamp()
          )
          ON CONFLICT (sandbox_id, blob_sha256, parser_version) DO NOTHING
        `);
        await appendExtractionAudit(tx, {
          claim,
          outcome,
          action: 'document.extraction_rejected',
          outcomeStatus: 'failed',
          targetVersion: String(documentVersion),
          attachmentCount: 0,
          attachmentHashes: [],
        });
        await tx.execute(sql`
          UPDATE nexus.extraction_jobs
          SET state = 'failed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = ${`rejected:${outcome.reasonCode ?? 'unknown'}`},
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${claim.jobId}
            AND state = 'leased'
            AND lease_owner = ${claim.leaseOwner}
        `);
        return { kind: 'completed' as const, unusedStorageKeys: [] };
      });
    },

    async failJob(claim, message, retryable, retryDelayMs): Promise<void> {
      await db.transaction(async (tx) => {
        if (!(await assertClaim(tx, claim))) {
          return;
        }
        const rows = asRows<{ attempt_count: number; max_attempts: number }>(
          await tx.execute(sql`
            SELECT attempt_count, max_attempts
            FROM nexus.extraction_jobs
            WHERE id = ${claim.jobId}
          `),
        );
        const attempt = rows[0];
        if (!attempt) {
          return;
        }
        const safeMessage = message.slice(0, 400);
        if (retryable && attempt.attempt_count < attempt.max_attempts) {
          await tx.execute(sql`
            UPDATE nexus.extraction_jobs
            SET state = 'pending',
                available_at =
                  clock_timestamp() + make_interval(secs => ${retryDelayMs}::double precision / 1000.0),
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = ${safeMessage},
                version = version + 1,
                updated_at = clock_timestamp()
            WHERE id = ${claim.jobId}
              AND state = 'leased'
              AND lease_owner = ${claim.leaseOwner}
          `);
          return;
        }
        await tx.execute(sql`
          UPDATE nexus.extraction_jobs
          SET state = 'failed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = ${safeMessage},
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${claim.jobId}
            AND state = 'leased'
            AND lease_owner = ${claim.leaseOwner}
        `);
        const documentVersion = await markDocumentStatus(
          tx,
          claim,
          'failed',
          null,
          null,
        );
        await appendExtractionAudit(tx, {
          claim,
          outcome: {
            status: 'rejected',
            reasonCode: null,
            format: 'text',
            parserVersion: 'unknown',
            pageCount: 1,
            pages: [],
            attachments: [],
          },
          action: 'document.extraction_failed',
          outcomeStatus: 'failed',
          targetVersion: String(documentVersion),
          attachmentCount: 0,
          attachmentHashes: [],
        });
      });
    },
  };
}

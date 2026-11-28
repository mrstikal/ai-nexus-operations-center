import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  DocumentExtractionRevisionSchema,
  type DocumentExtractionField,
  type DocumentExtractionRevision,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type {
  DocumentExtractionStore,
  ReadyDocumentForExtraction,
  SaveExtractionInput,
} from '@nexus/application/documents/extract';
import type {
  DocumentCorrectionStore,
  LatestDocumentExtraction,
  SaveCorrectionInput,
  SaveCorrectionResult,
} from '@nexus/application/documents/correct';
import type { NexusDb } from '../connection.js';
import { appendAuditInTransaction } from './audit.js';
import { expireProposalRevisionInTransaction } from './actions.js';
import type { DbTransaction } from './types.js';

type Executor = Pick<NexusDb, 'execute'> | Pick<DbTransaction, 'execute'>;

class CorrectionBlockedByExecutionError extends Error {
  constructor() {
    super('An action derived from this extraction is executing or unresolved');
    this.name = 'CorrectionBlockedByExecutionError';
  }
}

interface RevisionRow {
  id: string;
  sandbox_id: string;
  document_id: string;
  document_version_id: string;
  revision_number: number;
  kind: string;
  revision_status: string;
  authored_by_kind: string;
  authored_by_id: string;
  supersedes_revision_id: string | null;
  review_required: boolean;
  review_reason: string | null;
  request_reason: string | null;
  created_at: Date | string;
}

interface FieldRow {
  revision_id: string;
  field: string;
  value: string | null;
  status: string;
  source_page: number | null;
  source_start: number | null;
  source_end: number | null;
  source_bbox: Record<string, number> | null;
  alternatives: string[] | null;
  evidence_id: string | null;
}

interface PageRow {
  page_no: number;
  text: string;
}

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function revisionFromRows(
  revision: RevisionRow,
  fieldRows: readonly FieldRow[],
): DocumentExtractionRevision {
  return DocumentExtractionRevisionSchema.parse({
    id: revision.id,
    documentId: revision.document_id,
    documentVersionId: revision.document_version_id,
    revisionNumber: revision.revision_number,
    kind: revision.kind,
    revisionStatus: revision.revision_status,
    authoredByKind: revision.authored_by_kind,
    authoredById: revision.authored_by_id,
    supersedesRevisionId: revision.supersedes_revision_id,
    fields: fieldRows.map((row) => ({
      field: row.field,
      value: row.value,
      source:
        row.source_page === null
          ? null
          : {
              documentVersionId: revision.document_version_id,
              page: row.source_page,
              start: row.source_start as number,
              end: row.source_end as number,
              ...(row.source_bbox === null ? {} : { bbox: row.source_bbox }),
            },
      status: row.status,
      ...(row.alternatives === null ? {} : { alternatives: row.alternatives }),
      evidenceId: row.evidence_id,
    })),
    reviewRequired: revision.review_required,
    reviewReason: revision.review_reason,
    requestReason: revision.request_reason,
    createdAt: iso(revision.created_at),
  });
}

async function lockExtraction(
  tx: DbTransaction,
  sandboxId: string,
  documentId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${sandboxId}:${documentId}:extraction`}, 0)
    )
  `);
}

async function nextRevisionNumber(
  tx: DbTransaction,
  sandboxId: string,
  documentVersionId: string,
): Promise<number> {
  const rows = asRows<{ next: number }>(
    await tx.execute(sql`
      SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
      FROM nexus.document_extraction_revisions
      WHERE sandbox_id = ${sandboxId}
        AND document_version_id = ${documentVersionId}
    `),
  );
  return rows[0]?.next ?? 1;
}

async function evidenceIdsForVersion(
  executor: Executor,
  sandboxId: string,
  documentVersionId: string,
): Promise<string[]> {
  const rows = asRows<{ evidence_id: string }>(
    await executor.execute(sql`
      SELECT DISTINCT f.evidence_id
      FROM nexus.document_extraction_fields AS f
      JOIN nexus.document_extraction_revisions AS r
        ON r.sandbox_id = f.sandbox_id AND r.id = f.revision_id
      WHERE f.sandbox_id = ${sandboxId}
        AND r.document_version_id = ${documentVersionId}
        AND f.evidence_id IS NOT NULL
    `),
  );
  return rows.map((row) => row.evidence_id);
}

async function blockingExecutionExists(
  executor: Executor,
  sandboxId: string,
  evidenceIds: readonly string[],
): Promise<boolean> {
  if (evidenceIds.length === 0) {
    return false;
  }
  const rows = asRows<{ id: string }>(
    await executor.execute(sql`
      SELECT e.id
      FROM nexus.action_executions AS e
      JOIN nexus.action_revision_evidence AS re
        ON re.sandbox_id = e.sandbox_id
       AND re.revision_id = e.action_revision_id
      WHERE e.sandbox_id = ${sandboxId}
        AND re.evidence_id IN (${sql.join(
          evidenceIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND e.state IN (
          'pending', 'in_progress', 'retryable_failure', 'unknown'
        )
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

async function supersedeExtractionEvidence(
  tx: DbTransaction,
  sandboxId: string,
  evidenceIds: readonly string[],
): Promise<void> {
  if (evidenceIds.length === 0) {
    return;
  }
  const idList = sql.join(
    evidenceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // Lock in a deterministic order before updating so concurrent proposal
  // creation, which share-locks the same evidence rows, cannot commit a new
  // link between the invalidation-set query and this update.
  await tx.execute(sql`
    SELECT id
    FROM nexus.evidence
    WHERE sandbox_id = ${sandboxId} AND id IN (${idList})
    ORDER BY id
    FOR UPDATE
  `);
  await tx.execute(sql`
    UPDATE nexus.evidence
    SET superseded_at = clock_timestamp(),
        superseded_reason = 'extraction_corrected'
    WHERE sandbox_id = ${sandboxId}
      AND id IN (${idList})
      AND superseded_at IS NULL
  `);
}

interface LockedProposalRevision {
  readonly proposal_id: string;
  readonly revision_id: string;
}

async function lockOpenProposalRevisionsForEvidence(
  tx: DbTransaction,
  sandboxId: string,
  evidenceIds: readonly string[],
): Promise<LockedProposalRevision[]> {
  if (evidenceIds.length === 0) {
    return [];
  }
  return asRows<LockedProposalRevision>(
    await tx.execute(sql`
      SELECT p.id AS proposal_id, r.id AS revision_id
      FROM nexus.action_proposals AS p
      JOIN nexus.action_revisions AS r
        ON r.sandbox_id = p.sandbox_id
       AND r.proposal_id = p.id
       AND r.id = p.current_revision_id
      WHERE p.sandbox_id = ${sandboxId}
        AND p.status IN ('draft', 'pending_approval', 'approved')
        AND r.state IN ('draft', 'pending_approval', 'approved')
        AND EXISTS (
          SELECT 1
          FROM nexus.action_revision_evidence AS re
          WHERE re.sandbox_id = p.sandbox_id
            AND re.revision_id = r.id
            AND re.evidence_id IN (${sql.join(
              evidenceIds.map((id) => sql`${id}`),
              sql`, `,
            )})
        )
      ORDER BY p.id, r.id
      FOR UPDATE OF p, r
    `),
  );
}

function fieldEvidence(
  input: {
    readonly sandboxId: string;
    readonly documentVersionId: string;
    readonly field: DocumentExtractionField;
  },
): {
  readonly evidenceId: string | null;
  readonly contentHash: string | null;
  readonly locator: Record<string, unknown> | null;
  readonly capturedFacts: Record<string, unknown> | null;
} {
  const source = input.field.source;
  if (source === null) {
    return {
      evidenceId: null,
      contentHash: null,
      locator: null,
      capturedFacts: null,
    };
  }
  const locator: Record<string, unknown> = {
    documentVersionId: input.documentVersionId,
    page: source.page,
    startOffset: source.start,
    endOffset: source.end,
    ...(source.bbox === undefined ? {} : { bbox: source.bbox }),
  };
  const capturedFacts = {
    field: input.field.field,
    value: input.field.value,
    status: input.field.status,
    documentVersionId: input.documentVersionId,
    page: source.page,
    start: source.start,
    end: source.end,
  };
  return {
    evidenceId: randomUUID(),
    contentHash: canonicalJsonSha256(capturedFacts),
    locator,
    capturedFacts,
  };
}

async function insertEvidence(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly caseId: string | null;
    readonly documentVersionId: string;
    readonly field: DocumentExtractionField;
  },
): Promise<string | null> {
  const evidence = fieldEvidence(input);
  if (
    evidence.evidenceId === null ||
    evidence.contentHash === null ||
    evidence.locator === null ||
    evidence.capturedFacts === null
  ) {
    return null;
  }
  await tx.execute(sql`
    INSERT INTO nexus.evidence (
      id, sandbox_id, case_id, kind, source_status, source_system, source_type,
      source_id, source_version, source_sandbox_id, content_hash, locator,
      captured_facts, missing_reason, captured_at
    ) VALUES (
      ${evidence.evidenceId}, ${input.sandboxId}, ${input.caseId},
      'document_page', 'available', 'nexus', 'document_version',
      ${input.documentVersionId}, 1, ${input.sandboxId},
      ${evidence.contentHash},
      ${JSON.stringify(evidence.locator)}::jsonb,
      ${JSON.stringify(evidence.capturedFacts)}::jsonb,
      NULL, clock_timestamp()
    )
  `);
  return evidence.evidenceId;
}

async function insertFields(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly caseId: string | null;
    readonly revisionId: string;
    readonly documentVersionId: string;
    readonly fields: readonly DocumentExtractionField[];
  },
): Promise<string[]> {
  const evidenceIds: string[] = [];
  for (const field of input.fields) {
    const evidenceId = await insertEvidence(tx, {
      sandboxId: input.sandboxId,
      caseId: input.caseId,
      documentVersionId: input.documentVersionId,
      field,
    });
    if (evidenceId !== null) {
      evidenceIds.push(evidenceId);
    }
    await tx.execute(sql`
      INSERT INTO nexus.document_extraction_fields (
        id, sandbox_id, revision_id, field, value, status, source_page,
        source_start, source_end, source_bbox, alternatives, evidence_id, created_at
      ) VALUES (
        ${randomUUID()}, ${input.sandboxId}, ${input.revisionId}, ${field.field},
        ${field.value}, ${field.status},
        ${field.source?.page ?? null}, ${field.source?.start ?? null},
        ${field.source?.end ?? null},
        ${field.source?.bbox === undefined ? null : JSON.stringify(field.source.bbox)}::jsonb,
        ${field.alternatives === undefined ? null : JSON.stringify(field.alternatives)}::jsonb,
        ${evidenceId}, clock_timestamp()
      )
    `);
  }
  return evidenceIds;
}

async function setDocumentReviewStatus(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly reviewRequired: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE nexus.documents
    SET status = ${input.reviewRequired ? 'needs_review' : 'ready'},
        version = version + 1,
        updated_at = clock_timestamp()
    WHERE sandbox_id = ${input.sandboxId} AND id = ${input.documentId}
  `);
}

async function appendExtractionAudit(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly action: string;
    readonly authoredByKind: 'model' | 'human';
    readonly authoredById: string;
    readonly reviewRequired: boolean;
    readonly reviewReason: string | null;
    readonly fields: readonly DocumentExtractionField[];
    readonly requestId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  const afterHash = canonicalJsonSha256({
    revisionId: input.revisionId,
    documentVersionId: input.documentVersionId,
    reviewRequired: input.reviewRequired,
    fields: input.fields.map((field) => ({
      field: field.field,
      value: field.value,
      status: field.status,
      evidenceId: field.evidenceId,
    })),
  });
  await appendAuditInTransaction(tx, {
    sandboxId: input.sandboxId,
    actor:
      input.authoredByKind === 'human'
        ? { kind: 'human', id: input.authoredById, roles: [] }
        : { kind: 'service', id: input.authoredById, roles: [] },
    requestId: input.requestId.slice(0, 128),
    correlationId: input.correlationId.slice(0, 128),
    runId: null,
    action: input.action,
    targetType: 'document',
    targetId: input.documentId,
    targetVersion: String(input.revisionNumber),
    beforeHash: null,
    afterHash,
    outcome: 'succeeded',
    details: {
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      status: input.reviewRequired ? 'needs_review' : 'ready',
      reasonCode: input.reviewReason,
      action: input.action,
      outcome: 'succeeded',
    },
  });
}

export function createDocumentExtractionStore(
  db: NexusDb,
): DocumentExtractionStore & DocumentCorrectionStore {
  return {
    async getActiveSandbox(): Promise<string | null> {
      const rows = asRows<{ sandbox_id: string }>(
        await db.execute(sql`
          SELECT sandbox_id
          FROM nexus.active_sandbox
          WHERE singleton = true
          LIMIT 1
        `),
      );
      return rows[0]?.sandbox_id ?? null;
    },

    async loadReadyDocument(input: {
      readonly sandboxId: string;
      readonly documentId: string;
    }): Promise<ReadyDocumentForExtraction | null> {
      const rows = asRows<{
        document_id: string;
        document_version_id: string;
        case_id: string | null;
        status: string;
        version_status: string;
      }>(
        await db.execute(sql`
          SELECT d.id AS document_id, v.id AS document_version_id, d.case_id,
                 d.status, v.status AS version_status
          FROM nexus.documents AS d
          JOIN nexus.document_versions AS v
            ON v.sandbox_id = d.sandbox_id AND v.document_id = d.id
          WHERE d.sandbox_id = ${input.sandboxId}
            AND d.id = ${input.documentId}
          ORDER BY v.version_no DESC
          LIMIT 1
        `),
      );
      const row = rows[0];
      if (
        !row ||
        row.status !== 'ready' ||
        row.version_status !== 'ready'
      ) {
        return null;
      }
      const pages = asRows<PageRow>(
        await db.execute(sql`
          SELECT page_no, text
          FROM nexus.document_page_texts
          WHERE sandbox_id = ${input.sandboxId}
            AND document_version_id = ${row.document_version_id}
          ORDER BY page_no ASC
        `),
      );
      return {
        sandboxId: input.sandboxId,
        documentId: row.document_id,
        documentVersionId: row.document_version_id,
        caseId: row.case_id,
        pages: pages.map((page) => ({ page: page.page_no, text: page.text })),
      };
    },

    async saveExtraction(input: SaveExtractionInput): Promise<DocumentExtractionRevision> {
      return db.transaction(async (tx) => {
        await lockExtraction(tx, input.sandboxId, input.documentId);
        const revisionNumber = await nextRevisionNumber(
          tx,
          input.sandboxId,
          input.documentVersionId,
        );
        const revisionId = randomUUID();
        await tx.execute(sql`
          INSERT INTO nexus.document_extraction_revisions (
            id, sandbox_id, document_id, document_version_id, revision_number,
            kind, revision_status, authored_by_kind, authored_by_id,
            supersedes_revision_id, review_required, review_reason, request_reason, created_at
          ) VALUES (
            ${revisionId}, ${input.sandboxId}, ${input.documentId},
            ${input.documentVersionId}, ${revisionNumber}, ${input.kind},
            'extracted', 'model', ${input.authoredById}, NULL,
            ${input.reviewRequired}, ${input.reviewReason}, NULL, clock_timestamp()
          )
        `);
        await insertFields(tx, {
          sandboxId: input.sandboxId,
          caseId: input.caseId,
          revisionId,
          documentVersionId: input.documentVersionId,
          fields: input.fields,
        });
        await setDocumentReviewStatus(tx, {
          sandboxId: input.sandboxId,
          documentId: input.documentId,
          reviewRequired: input.reviewRequired,
        });
        await appendExtractionAudit(tx, {
          sandboxId: input.sandboxId,
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          revisionId,
          revisionNumber,
          action: 'document.structured_extracted',
          authoredByKind: 'model',
          authoredById: input.authoredById,
          reviewRequired: input.reviewRequired,
          reviewReason: input.reviewReason,
          fields: input.fields,
          requestId: input.requestId,
          correlationId: input.correlationId,
        });
        return readRevision(tx, input.sandboxId, revisionId);
      });
    },

    async loadLatestExtraction(input: {
      readonly sandboxId: string;
      readonly documentId: string;
    }): Promise<LatestDocumentExtraction | null> {
      const rows = asRows<RevisionRow>(
        await db.execute(sql`
          SELECT *
          FROM nexus.document_extraction_revisions
          WHERE sandbox_id = ${input.sandboxId}
            AND document_id = ${input.documentId}
          ORDER BY revision_number DESC
          LIMIT 1
        `),
      );
      const revision = rows[0];
      if (!revision) {
        return null;
      }
      const fields = asRows<FieldRow>(
        await db.execute(sql`
          SELECT revision_id, field, value, status, source_page, source_start,
                 source_end, source_bbox, alternatives, evidence_id
          FROM nexus.document_extraction_fields
          WHERE sandbox_id = ${input.sandboxId}
            AND revision_id = ${revision.id}
          ORDER BY field ASC
        `),
      );
      const pages = asRows<PageRow>(
        await db.execute(sql`
          SELECT page_no, text
          FROM nexus.document_page_texts
          WHERE sandbox_id = ${input.sandboxId}
            AND document_version_id = ${revision.document_version_id}
          ORDER BY page_no ASC
        `),
      );
      return {
        revision: revisionFromRows(revision, fields),
        pages: pages.map((page) => ({ page: page.page_no, text: page.text })),
      };
    },

    async saveCorrection(
      input: SaveCorrectionInput,
    ): Promise<SaveCorrectionResult> {
      try {
        return await db.transaction(async (tx) => {
          await lockExtraction(tx, input.sandboxId, input.documentId);
          const current = asRows<{ revision_number: number; case_id: string | null }>(
            await tx.execute(sql`
              SELECT r.revision_number, d.case_id
              FROM nexus.document_extraction_revisions AS r
              JOIN nexus.documents AS d
                ON d.sandbox_id = r.sandbox_id AND d.id = r.document_id
              WHERE r.sandbox_id = ${input.sandboxId}
                AND r.document_id = ${input.documentId}
              ORDER BY r.revision_number DESC
              LIMIT 1
            `),
          )[0];
          if (!current || current.revision_number !== input.expectedRevisionNumber) {
            return { ok: false, conflict: 'REVISION_CONFLICT' };
          }
          const evidenceIds = await evidenceIdsForVersion(
            tx,
            input.sandboxId,
            input.documentVersionId,
          );
          const expireProposal = (
            proposalRevision: LockedProposalRevision,
          ): Promise<boolean> =>
            expireProposalRevisionInTransaction(tx, {
              sandboxId: input.sandboxId,
              proposalId: proposalRevision.proposal_id,
              revisionId: proposalRevision.revision_id,
              entityRef: {
                system: 'nexus',
                type: 'document_version',
                id: input.documentVersionId,
                version: input.expectedRevisionNumber,
              },
              changedFields: ['extraction'],
              originatingRevisionId: null,
              requestId: input.requestId,
              correlationId: input.correlationId,
            });
          // Lock the proposals that cite the old evidence before checking for
          // blocking executions. The worker's claim path takes the same
          // proposal row lock, so this closes the check-then-act window.
          const firstAffected = await lockOpenProposalRevisionsForEvidence(
            tx,
            input.sandboxId,
            evidenceIds,
          );
          if (await blockingExecutionExists(tx, input.sandboxId, evidenceIds)) {
            throw new CorrectionBlockedByExecutionError();
          }
          // Mark the old extraction evidence superseded before any expiry takes
          // a case lock. Proposal creation takes the evidence share locks
          // before its case share lock, so both paths use the same global
          // order: evidence, then case. Proposal creation revalidates the
          // marker inside its transaction, so an in-flight creation either
          // commits first and appears in the refreshed set below, or blocks
          // and then rejects the superseded evidence.
          await supersedeExtractionEvidence(tx, input.sandboxId, evidenceIds);
          for (const proposalRevision of firstAffected) {
            await expireProposal(proposalRevision);
          }
          const afterSupersession = await lockOpenProposalRevisionsForEvidence(
            tx,
            input.sandboxId,
            evidenceIds,
          );
          if (await blockingExecutionExists(tx, input.sandboxId, evidenceIds)) {
            throw new CorrectionBlockedByExecutionError();
          }
          const newlyVisible = afterSupersession.filter(
            (candidate) =>
              !firstAffected.some(
                (existing) =>
                  existing.revision_id === candidate.revision_id,
              ),
          );
          const revisionNumber = input.expectedRevisionNumber + 1;
          const revisionId = randomUUID();
          await tx.execute(sql`
            INSERT INTO nexus.document_extraction_revisions (
              id, sandbox_id, document_id, document_version_id, revision_number,
              kind, revision_status, authored_by_kind, authored_by_id,
              supersedes_revision_id, review_required, review_reason, request_reason, created_at
            ) VALUES (
              ${revisionId}, ${input.sandboxId}, ${input.documentId},
              ${input.documentVersionId}, ${revisionNumber}, ${input.kind},
              'corrected', 'human', ${input.actorId}, ${input.supersedesRevisionId},
              ${input.reviewRequired}, ${input.reviewReason}, ${input.reason}, clock_timestamp()
            )
          `);
          await insertFields(tx, {
            sandboxId: input.sandboxId,
            caseId: current.case_id,
            revisionId,
            documentVersionId: input.documentVersionId,
            fields: input.fields,
          });
          for (const correction of input.corrections) {
            await tx.execute(sql`
              INSERT INTO nexus.document_extraction_corrections (
                id, sandbox_id, revision_id, field, prior_value, new_value,
                reason, actor_id, created_at
              ) VALUES (
                ${randomUUID()}, ${input.sandboxId}, ${revisionId},
                ${correction.field}, ${correction.priorValue},
                ${correction.newValue}, ${correction.reason},
                ${input.actorId}, clock_timestamp()
              )
            `);
          }
          await setDocumentReviewStatus(tx, {
            sandboxId: input.sandboxId,
            documentId: input.documentId,
            reviewRequired: input.reviewRequired,
          });
          await appendExtractionAudit(tx, {
            sandboxId: input.sandboxId,
            documentId: input.documentId,
            documentVersionId: input.documentVersionId,
            revisionId,
            revisionNumber,
            action: 'document.extraction_corrected',
            authoredByKind: 'human',
            authoredById: input.actorId,
            reviewRequired: input.reviewRequired,
            reviewReason: input.reviewReason,
            fields: input.fields,
            requestId: input.requestId,
            correlationId: input.correlationId,
          });
          // Proposals that became visible while the evidence marker was being
          // written are expired here, still in the same transaction.
          for (const proposalRevision of newlyVisible) {
            await expireProposal(proposalRevision);
          }
          return {
            ok: true,
            revision: await readRevision(tx, input.sandboxId, revisionId),
          };
        });
      } catch (error) {
        if (error instanceof CorrectionBlockedByExecutionError) {
          return { ok: false, conflict: 'EXTRACTION_IN_USE' };
        }
        throw error;
      }
    },
  };
}

async function readRevision(
  executor: Executor,
  sandboxId: string,
  revisionId: string,
): Promise<DocumentExtractionRevision> {
  const revision = asRows<RevisionRow>(
    await executor.execute(sql`
      SELECT *
      FROM nexus.document_extraction_revisions
      WHERE sandbox_id = ${sandboxId} AND id = ${revisionId}
      LIMIT 1
    `),
  )[0];
  if (!revision) {
    throw new Error('Extraction revision was not persisted');
  }
  const fields = asRows<FieldRow>(
    await executor.execute(sql`
      SELECT revision_id, field, value, status, source_page, source_start,
             source_end, source_bbox, alternatives, evidence_id
      FROM nexus.document_extraction_fields
      WHERE sandbox_id = ${sandboxId} AND revision_id = ${revisionId}
      ORDER BY field ASC
    `),
  );
  return revisionFromRows(revision, fields);
}

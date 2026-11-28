import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  KnowledgeDocumentSchema,
  KnowledgeVersionSchema,
  type KnowledgeDocument,
  type KnowledgeVersion,
  type KnowledgeVersionState,
} from '@nexus/contracts';
import type {
  KnowledgeCatalogStore,
  KnowledgeDocumentCursor,
  KnowledgeIngestStore,
  SaveKnowledgeVersionInput,
} from '@nexus/application/knowledge/ingest';
import type {
  KnowledgeDocumentSnapshot,
  KnowledgePublicationStoreResult,
  KnowledgePublishStore,
  KnowledgeVersionSnapshot,
  PublishKnowledgeVersionInput,
  RevokeKnowledgeVersionInput,
} from '@nexus/application/knowledge/publish';
import type {
  KnowledgeSearchRow,
  KnowledgeSearchStore,
} from '@nexus/application/knowledge/lexical-retriever';
import type { NexusDb } from '../connection.js';
import { activeSandbox, sandboxes } from '../schema/cases.js';
import { evidence } from '../schema/evidence.js';
import { eventOutbox } from '../schema/events.js';
import {
  knowledgeChunks,
} from '../schema/knowledge.js';
import { appendAuditInTransaction } from './audit.js';
import { expireProposalRevisionInTransaction } from './actions.js';
import type { DbTransaction } from './types.js';

export interface KnowledgeStoreBundle
  extends KnowledgeIngestStore,
    KnowledgeCatalogStore,
    KnowledgePublishStore,
    KnowledgeSearchStore {}

interface DocumentRow {
  readonly id: string;
  readonly sandbox_id: string;
  readonly kind: string;
  readonly policy_id: string | null;
  readonly source_path: string;
  readonly created_at: Date | string;
}

interface VersionRow {
  readonly id: string;
  readonly sandbox_id: string;
  readonly document_id: string;
  readonly version_no: number;
  readonly state: string;
  readonly content_sha256: string;
  readonly policy_bundle_version: string | null;
  readonly policy_content_hash: string | null;
  readonly effective_from: Date | string;
  readonly effective_until: Date | string | null;
  readonly published_at: Date | string | null;
  readonly withdrawn_at: Date | string | null;
  readonly source_path: string;
  readonly char_count: number;
  readonly chunk_count: number;
  readonly created_at: Date | string;
}

interface ChunkRow {
  readonly id: string;
  readonly chunk_index: number;
  readonly heading_path: string[];
  readonly text: string;
  readonly char_count: number;
  readonly token_count: number;
  readonly locator: Record<string, unknown>;
  readonly content_sha256: string;
  readonly evidence_id: string | null;
}

interface ListingRow extends DocumentRow {
  readonly v_id: string | null;
  readonly v_document_id: string | null;
  readonly v_version_no: number | null;
  readonly v_state: string | null;
  readonly v_content_sha256: string | null;
  readonly v_policy_bundle_version: string | null;
  readonly v_policy_content_hash: string | null;
  readonly v_effective_from: Date | string | null;
  readonly v_effective_until: Date | string | null;
  readonly v_published_at: Date | string | null;
  readonly v_withdrawn_at: Date | string | null;
  readonly v_source_path: string | null;
  readonly v_char_count: number | null;
  readonly v_chunk_count: number | null;
  readonly v_created_at: Date | string | null;
}

interface SearchDbRow {
  readonly id: string;
  readonly document_version_id: string;
  readonly policy_bundle_version: string | null;
  readonly text: string;
  readonly locator: unknown;
  readonly score: number | string;
  readonly evidence_id: string;
}

interface OpenProposalRow {
  readonly id: string;
  readonly current_revision_id: string;
}

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function versionFromRow(row: VersionRow): KnowledgeVersion {
  return KnowledgeVersionSchema.parse({
    id: row.id,
    documentId: row.document_id,
    versionNo: row.version_no,
    state: row.state as KnowledgeVersionState,
    contentSha256: row.content_sha256,
    policyBundleVersion: row.policy_bundle_version,
    policyContentHash: row.policy_content_hash,
    effectiveFrom: iso(row.effective_from),
    effectiveUntil: isoOrNull(row.effective_until),
    publishedAt: isoOrNull(row.published_at),
    withdrawnAt: isoOrNull(row.withdrawn_at),
    sourcePath: row.source_path,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    createdAt: iso(row.created_at),
  });
}

function documentFromRow(
  row: DocumentRow,
  latestVersion: KnowledgeVersion | null,
): KnowledgeDocument {
  return KnowledgeDocumentSchema.parse({
    id: row.id,
    sandboxId: row.sandbox_id,
    kind: row.kind,
    policyId: row.policy_id,
    sourcePath: row.source_path,
    createdAt: iso(row.created_at),
    latestVersion,
  });
}

function versionSnapshot(row: VersionRow): KnowledgeVersionSnapshot {
  return {
    id: row.id,
    versionNo: row.version_no,
    state: row.state as KnowledgeVersionState,
    contentSha256: row.content_sha256,
    sourcePath: row.source_path,
    policyBundleVersion: row.policy_bundle_version,
    policyContentHash: row.policy_content_hash,
  };
}

async function generationInTransaction(
  tx: DbTransaction,
  sandboxId: string,
): Promise<number> {
  const rows = asRows<{ generation: number }>(
    await tx.execute(sql`
      INSERT INTO nexus.knowledge_retrieval_state (sandbox_id, generation, updated_at)
      VALUES (${sandboxId}, 1, clock_timestamp())
      ON CONFLICT (sandbox_id) DO UPDATE
        SET generation = nexus.knowledge_retrieval_state.generation + 1,
            updated_at = clock_timestamp()
      RETURNING generation
    `),
  );
  const generation = rows[0]?.generation;
  if (typeof generation !== 'number' || generation < 1) {
    throw new Error('Knowledge retrieval generation allocation failed');
  }
  return generation;
}

async function currentGenerationInTransaction(
  tx: DbTransaction,
  sandboxId: string,
): Promise<number> {
  const rows = asRows<{ generation: number }>(
    await tx.execute(sql`
      SELECT generation
      FROM nexus.knowledge_retrieval_state
      WHERE sandbox_id = ${sandboxId}
      LIMIT 1
    `),
  );
  return rows[0]?.generation ?? 1;
}

async function loadDocumentRowForUpdate(
  tx: DbTransaction,
  sandboxId: string,
  documentId: string,
): Promise<DocumentRow | null> {
  const rows = asRows<DocumentRow>(
    await tx.execute(sql`
      SELECT id, sandbox_id, kind, policy_id, source_path, created_at
      FROM nexus.knowledge_documents
      WHERE sandbox_id = ${sandboxId} AND id = ${documentId}
      FOR UPDATE
    `),
  );
  return rows[0] ?? null;
}

async function findPublishedVersionForUpdate(
  tx: DbTransaction,
  sandboxId: string,
  documentId: string,
  versionId: string,
): Promise<VersionRow | null> {
  const rows = asRows<VersionRow>(
    await tx.execute(sql`
      SELECT *
      FROM nexus.knowledge_versions
      WHERE sandbox_id = ${sandboxId}
        AND document_id = ${documentId}
        AND id = ${versionId}
      FOR UPDATE
    `),
  );
  const row = rows[0];
  return row && row.state === 'published' ? row : null;
}

async function expireOpenProposalsInTransaction(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly versionNo: number;
    readonly requestId: string;
    readonly correlationId: string;
  },
): Promise<string[]> {
  const proposals = asRows<OpenProposalRow>(
    await tx.execute(sql`
      SELECT id, current_revision_id
      FROM nexus.action_proposals
      WHERE sandbox_id = ${input.sandboxId}
        AND status IN ('draft', 'pending_approval', 'approved')
        AND current_revision_id IS NOT NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1000
      FOR UPDATE
    `),
  );
  const expired: string[] = [];
  for (const proposal of proposals) {
    const didExpire = await expireProposalRevisionInTransaction(tx, {
      sandboxId: input.sandboxId,
      proposalId: proposal.id,
      revisionId: proposal.current_revision_id,
      entityRef: {
        system: 'nexus',
        type: 'knowledge_document',
        id: input.documentId,
        version: input.versionNo,
      },
      changedFields: ['publication_state'],
      originatingRevisionId: null,
      requestId: input.requestId.slice(0, 128),
      correlationId: input.correlationId.slice(0, 128),
    });
    if (didExpire) {
      expired.push(proposal.id);
    }
  }
  return expired;
}

async function insertKnowledgeChangedEvent(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly versionNo: number;
    readonly publicationState: 'published' | 'withdrawn';
    readonly retrievalGeneration: number;
    readonly correlationId: string;
  },
): Promise<void> {
  await tx.insert(eventOutbox).values({
    id: randomUUID(),
    sandboxId: input.sandboxId,
    eventType: 'nexus.knowledge.changed.v1',
    schemaVersion: 1,
    producer: 'api',
    occurredAt: new Date(),
    correlationId: input.correlationId.slice(0, 128),
    causationId: null,
    aggregateType: 'knowledge',
    aggregateId: input.documentId,
    aggregateVersion: input.versionNo,
    payload: {
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      publicationState: input.publicationState,
      retrievalGeneration: input.retrievalGeneration,
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

async function attachChunkEvidence(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly versionNo: number;
    readonly policyId: string | null;
    readonly policyBundleVersion: string | null;
    readonly sourcePath: string;
  },
): Promise<number> {
  const chunks = asRows<ChunkRow>(
    await tx.execute(sql`
      SELECT id, chunk_index, heading_path, text, char_count, token_count,
             locator, content_sha256, evidence_id
      FROM nexus.knowledge_chunks
      WHERE sandbox_id = ${input.sandboxId}
        AND document_version_id = ${input.documentVersionId}
      ORDER BY chunk_index ASC
      FOR UPDATE
    `),
  );
  for (const chunk of chunks) {
    if (chunk.evidence_id !== null) {
      continue;
    }
    const evidenceId = randomUUID();
    const locator = chunk.locator as unknown as {
      readonly startOffset?: number;
      readonly endOffset?: number;
    };
    await tx.insert(evidence).values({
      id: evidenceId,
      sandboxId: input.sandboxId,
      caseId: null,
      kind: 'knowledge_chunk',
      sourceStatus: 'available',
      sourceSystem: 'nexus',
      sourceType: 'knowledge_chunk',
      sourceId: chunk.id,
      sourceVersion: input.versionNo,
      sourceSandboxId: input.sandboxId,
      contentHash: chunk.content_sha256,
      locator: {
        documentVersionId: input.documentVersionId,
        page: null,
        startOffset: locator.startOffset ?? null,
        endOffset: locator.endOffset ?? null,
      },
      capturedFacts: {
        text: chunk.text,
        headingPath: chunk.heading_path,
        chunkIndex: chunk.chunk_index,
        sourcePath: input.sourcePath,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        policyId: input.policyId,
        policyBundleVersion: input.policyBundleVersion,
        publicationState: 'published',
      },
      missingReason: null,
      capturedAt: sql`clock_timestamp()`,
    });
    await tx
      .update(knowledgeChunks)
      .set({ evidenceId })
      .where(
        and(
          eq(knowledgeChunks.sandboxId, input.sandboxId),
          eq(knowledgeChunks.id, chunk.id),
        ),
      );
  }
  return chunks.length;
}

export function createKnowledgeStore(db: NexusDb): KnowledgeStoreBundle {
  return {
    async getActiveSandbox(): Promise<string | null> {
      const rows = await db
        .select({ id: sandboxes.id })
        .from(activeSandbox)
        .innerJoin(sandboxes, sql`${sandboxes.id} = ${activeSandbox.sandboxId}`)
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async saveVersion(input: SaveKnowledgeVersionInput): Promise<{
      readonly document: KnowledgeDocument;
      readonly deduplicated: boolean;
    }> {
      return db.transaction(async (tx) => {
        const lockKey = `knowledge:${input.sandboxId}:${input.kind}:${input.policyId ?? ''}:${input.sourcePath}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );
        const documentRows = asRows<DocumentRow>(
          await tx.execute(sql`
            SELECT id, sandbox_id, kind, policy_id, source_path, created_at
            FROM nexus.knowledge_documents
            WHERE sandbox_id = ${input.sandboxId}
              AND kind = ${input.kind}
              AND policy_id IS NOT DISTINCT FROM ${input.policyId}
              AND source_path = ${input.sourcePath}
            LIMIT 1
          `),
        );
        let documentRow = documentRows[0];
        if (!documentRow) {
          const inserted = asRows<DocumentRow>(
            await tx.execute(sql`
              INSERT INTO nexus.knowledge_documents
                (id, sandbox_id, kind, policy_id, source_path, created_at)
              VALUES (
                ${randomUUID()}, ${input.sandboxId}, ${input.kind},
                ${input.policyId}, ${input.sourcePath}, clock_timestamp()
              )
              RETURNING id, sandbox_id, kind, policy_id, source_path, created_at
            `),
          );
          documentRow = inserted[0];
          if (!documentRow) {
            throw new Error('Knowledge document insert returned no row');
          }
        }
        const latestRows = asRows<VersionRow>(
          await tx.execute(sql`
            SELECT *
            FROM nexus.knowledge_versions
            WHERE sandbox_id = ${input.sandboxId}
              AND document_id = ${documentRow.id}
            ORDER BY version_no DESC
            LIMIT 1
          `),
        );
        const latest = latestRows[0];
        if (
          latest &&
          latest.content_sha256 === input.contentSha256 &&
          (latest.state === 'draft' || latest.state === 'published')
        ) {
          const version = versionFromRow(latest);
          return {
            document: documentFromRow(documentRow, version),
            deduplicated: true,
          };
        }
        const versionNo = (latest?.version_no ?? 0) + 1;
        const versionId = randomUUID();
        const insertedVersion = asRows<VersionRow>(
          await tx.execute(sql`
            INSERT INTO nexus.knowledge_versions
              (id, sandbox_id, document_id, version_no, state, content_sha256,
               policy_bundle_version, policy_content_hash, effective_from,
               effective_until, published_at, withdrawn_at, source_path,
               char_count, chunk_count, created_at, updated_at)
            VALUES (
              ${versionId}, ${input.sandboxId}, ${documentRow.id}, ${versionNo},
              'draft', ${input.contentSha256}, ${input.policyBundleVersion},
              ${input.policyContentHash}, ${new Date(input.effectiveFrom)},
              NULL, NULL, NULL, ${input.sourcePath}, ${input.charCount},
              ${input.chunks.length}, clock_timestamp(), clock_timestamp()
            )
            RETURNING *
          `),
        );
        const versionRow = insertedVersion[0];
        if (!versionRow) {
          throw new Error('Knowledge version insert returned no row');
        }
        for (const chunk of input.chunks) {
          await tx.insert(knowledgeChunks).values({
            id: randomUUID(),
            sandboxId: input.sandboxId,
            documentVersionId: versionId,
            chunkIndex: chunk.index,
            headingPath: [...chunk.headingPath],
            text: chunk.text,
            charCount: chunk.charCount,
            tokenCount: chunk.tokenCount,
            locator: chunk.locator as unknown as Record<string, unknown>,
            contentSha256: chunk.contentSha256,
            evidenceId: null,
            createdAt: sql`clock_timestamp()`,
          });
        }
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId.slice(0, 128),
          correlationId: input.correlationId.slice(0, 128),
          actor: {
            kind: 'human',
            id: input.actorId.slice(0, 128),
            roles: ['admin'],
          },
          runId: null,
          action: 'knowledge.ingested',
          targetType: 'knowledge_document',
          targetId: documentRow.id,
          targetVersion: String(versionNo),
          beforeHash: latest?.content_sha256 ?? null,
          afterHash: input.contentSha256,
          outcome: 'succeeded',
          details: {
            documentId: documentRow.id,
            documentVersionId: versionId,
            status: 'draft',
            reasonCode: input.kind,
            policyRevision: input.policyId,
            sourcePath: input.sourcePath,
            contentHash: input.contentSha256,
            chunkCount: input.chunks.length,
          },
        });
        const version = versionFromRow(versionRow);
        return {
          document: documentFromRow(documentRow, version),
          deduplicated: false,
        };
      });
    },

    async listDocuments(input: {
      readonly sandboxId: string;
      readonly limit: number;
      readonly after?: KnowledgeDocumentCursor;
    }) {
      const rows = asRows<ListingRow>(
        await db.execute(sql`
          SELECT
            d.id, d.sandbox_id, d.kind, d.policy_id, d.source_path, d.created_at,
            v.id AS v_id,
            v.document_id AS v_document_id,
            v.version_no AS v_version_no,
            v.state AS v_state,
            v.content_sha256 AS v_content_sha256,
            v.policy_bundle_version AS v_policy_bundle_version,
            v.policy_content_hash AS v_policy_content_hash,
            v.effective_from AS v_effective_from,
            v.effective_until AS v_effective_until,
            v.published_at AS v_published_at,
            v.withdrawn_at AS v_withdrawn_at,
            v.source_path AS v_source_path,
            v.char_count AS v_char_count,
            v.chunk_count AS v_chunk_count,
            v.created_at AS v_created_at
          FROM nexus.knowledge_documents d
          LEFT JOIN LATERAL (
            SELECT *
            FROM nexus.knowledge_versions v
            WHERE v.sandbox_id = d.sandbox_id
              AND v.document_id = d.id
            ORDER BY v.version_no DESC
            LIMIT 1
          ) v ON true
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
      const items = rows.slice(0, input.limit).map((row) => {
        const latestVersion =
          row.v_id !== null &&
          row.v_document_id !== null &&
          row.v_version_no !== null &&
          row.v_state !== null &&
          row.v_content_sha256 !== null &&
          row.v_effective_from !== null &&
          row.v_source_path !== null &&
          row.v_char_count !== null &&
          row.v_chunk_count !== null &&
          row.v_created_at !== null
            ? versionFromRow({
                id: row.v_id,
                sandbox_id: row.sandbox_id,
                document_id: row.v_document_id,
                version_no: row.v_version_no,
                state: row.v_state,
                content_sha256: row.v_content_sha256,
                policy_bundle_version: row.v_policy_bundle_version,
                policy_content_hash: row.v_policy_content_hash,
                effective_from: row.v_effective_from,
                effective_until: row.v_effective_until,
                published_at: row.v_published_at,
                withdrawn_at: row.v_withdrawn_at,
                source_path: row.v_source_path,
                char_count: row.v_char_count,
                chunk_count: row.v_chunk_count,
                created_at: row.v_created_at,
              })
            : null;
        return documentFromRow(row, latestVersion);
      });
      return { items, hasMore };
    },

    async loadDocument(
      sandboxId: string,
      documentId: string,
    ): Promise<KnowledgeDocumentSnapshot | null> {
      const documentRows = asRows<DocumentRow>(
        await db.execute(sql`
          SELECT id, sandbox_id, kind, policy_id, source_path, created_at
          FROM nexus.knowledge_documents
          WHERE sandbox_id = ${sandboxId} AND id = ${documentId}
          LIMIT 1
        `),
      );
      const documentRow = documentRows[0];
      if (!documentRow) {
        return null;
      }
      const versionRows = asRows<VersionRow>(
        await db.execute(sql`
          SELECT *
          FROM nexus.knowledge_versions
          WHERE sandbox_id = ${sandboxId} AND document_id = ${documentId}
          ORDER BY version_no DESC
        `),
      );
      const versions = versionRows.map(versionFromRow);
      return {
        document: documentFromRow(documentRow, versions[0] ?? null),
        kind: documentRow.kind as 'policy' | 'informational',
        versions: versionRows.map(versionSnapshot),
      };
    },

    async publishVersion(
      input: PublishKnowledgeVersionInput,
    ): Promise<KnowledgePublicationStoreResult> {
      return db.transaction(async (tx) => {
        const documentRow = await loadDocumentRowForUpdate(
          tx,
          input.sandboxId,
          input.documentId,
        );
        if (!documentRow) {
          return { ok: false as const, conflict: 'NO_DRAFT' as const };
        }
        if (input.versionId === null) {
          const publishedRows = asRows<VersionRow>(
            await tx.execute(sql`
              SELECT *
              FROM nexus.knowledge_versions
              WHERE sandbox_id = ${input.sandboxId}
                AND document_id = ${input.documentId}
                AND state = 'published'
              ORDER BY version_no DESC
              LIMIT 1
            `),
          );
          const published = publishedRows[0];
          if (!published) {
            return { ok: false as const, conflict: 'NO_DRAFT' as const };
          }
          const version = versionFromRow(published);
          return {
            ok: true as const,
            value: {
              document: documentFromRow(documentRow, version),
              version,
              retrievalGeneration: await currentGenerationInTransaction(
                tx,
                input.sandboxId,
              ),
              expiredProposalIds: [],
              changed: false,
            },
          };
        }
        const draftRows = asRows<VersionRow>(
          await tx.execute(sql`
            SELECT *
            FROM nexus.knowledge_versions
            WHERE sandbox_id = ${input.sandboxId}
              AND document_id = ${input.documentId}
              AND id = ${input.versionId}
            FOR UPDATE
          `),
        );
        const draft = draftRows[0];
        if (!draft || draft.state !== 'draft') {
          return { ok: false as const, conflict: 'NO_DRAFT' as const };
        }
        const previousRows = asRows<{ content_sha256: string }>(
          await tx.execute(sql`
            SELECT content_sha256
            FROM nexus.knowledge_versions
            WHERE sandbox_id = ${input.sandboxId}
              AND document_id = ${input.documentId}
              AND state = 'published'
            ORDER BY version_no DESC
            LIMIT 1
          `),
        );
        const previousContentHash = previousRows[0]?.content_sha256 ?? null;
        await tx.execute(sql`
          UPDATE nexus.knowledge_versions
          SET state = 'superseded',
              effective_until = LEAST(
                COALESCE(effective_until, clock_timestamp()),
                clock_timestamp()
              ),
              updated_at = clock_timestamp()
          WHERE sandbox_id = ${input.sandboxId}
            AND document_id = ${input.documentId}
            AND state = 'published'
        `);
        const publishedRows = asRows<VersionRow>(
          await tx.execute(sql`
            UPDATE nexus.knowledge_versions
            SET state = 'published',
                published_at = clock_timestamp(),
                effective_until = NULL,
                updated_at = clock_timestamp()
            WHERE sandbox_id = ${input.sandboxId}
              AND id = ${input.versionId}
            RETURNING *
          `),
        );
        const published = publishedRows[0];
        if (!published) {
          throw new Error('Knowledge publication update returned no row');
        }
        const chunkCount = await attachChunkEvidence(tx, {
          sandboxId: input.sandboxId,
          documentId: input.documentId,
          documentVersionId: published.id,
          versionNo: published.version_no,
          policyId: documentRow.policy_id,
          policyBundleVersion: published.policy_bundle_version,
          sourcePath: published.source_path,
        });
        const retrievalGeneration = await generationInTransaction(
          tx,
          input.sandboxId,
        );
        await insertKnowledgeChangedEvent(tx, {
          sandboxId: input.sandboxId,
          documentId: input.documentId,
          documentVersionId: published.id,
          versionNo: published.version_no,
          publicationState: 'published',
          retrievalGeneration,
          correlationId: input.correlationId,
        });
        const expiredProposalIds =
          documentRow.kind === 'policy'
            ? await expireOpenProposalsInTransaction(tx, {
                sandboxId: input.sandboxId,
                documentId: input.documentId,
                versionNo: published.version_no,
                requestId: input.requestId,
                correlationId: input.correlationId,
              })
            : [];
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId.slice(0, 128),
          correlationId: input.correlationId.slice(0, 128),
          actor: {
            kind: 'human',
            id: input.actorId.slice(0, 128),
            roles: ['admin'],
          },
          runId: null,
          action: 'knowledge.published',
          targetType: 'knowledge_document',
          targetId: input.documentId,
          targetVersion: String(published.version_no),
          beforeHash: previousContentHash,
          afterHash: published.content_sha256,
          outcome: 'succeeded',
          details: {
            documentId: input.documentId,
            documentVersionId: published.id,
            status: 'published',
            reasonCode: documentRow.kind,
            policyRevision: documentRow.policy_id,
            sourcePath: published.source_path,
            contentHash: published.content_sha256,
            chunkCount,
            retrievalGeneration,
            expiredProposalCount: expiredProposalIds.length,
          },
        });
        const version = versionFromRow(published);
        return {
          ok: true as const,
          value: {
            document: documentFromRow(documentRow, version),
            version,
            retrievalGeneration,
            expiredProposalIds,
            changed: true,
          },
        };
      });
    },

    async revokeVersion(
      input: RevokeKnowledgeVersionInput,
    ): Promise<KnowledgePublicationStoreResult> {
      return db.transaction(async (tx) => {
        const documentRow = await loadDocumentRowForUpdate(
          tx,
          input.sandboxId,
          input.documentId,
        );
        if (!documentRow) {
          return { ok: false as const, conflict: 'NO_PUBLISHED_VERSION' as const };
        }
        const target = await findPublishedVersionForUpdate(
          tx,
          input.sandboxId,
          input.documentId,
          input.versionId,
        );
        if (!target) {
          return { ok: false as const, conflict: 'NO_PUBLISHED_VERSION' as const };
        }
        const revokedRows = asRows<VersionRow>(
          await tx.execute(sql`
            UPDATE nexus.knowledge_versions
            SET state = 'withdrawn',
                withdrawn_at = clock_timestamp(),
                effective_until = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE sandbox_id = ${input.sandboxId}
              AND id = ${input.versionId}
            RETURNING *
          `),
        );
        const revoked = revokedRows[0];
        if (!revoked) {
          throw new Error('Knowledge revocation update returned no row');
        }
        const retrievalGeneration = await generationInTransaction(
          tx,
          input.sandboxId,
        );
        await insertKnowledgeChangedEvent(tx, {
          sandboxId: input.sandboxId,
          documentId: input.documentId,
          documentVersionId: revoked.id,
          versionNo: revoked.version_no,
          publicationState: 'withdrawn',
          retrievalGeneration,
          correlationId: input.correlationId,
        });
        const expiredProposalIds =
          documentRow.kind === 'policy'
            ? await expireOpenProposalsInTransaction(tx, {
                sandboxId: input.sandboxId,
                documentId: input.documentId,
                versionNo: revoked.version_no,
                requestId: input.requestId,
                correlationId: input.correlationId,
              })
            : [];
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId.slice(0, 128),
          correlationId: input.correlationId.slice(0, 128),
          actor: {
            kind: 'human',
            id: input.actorId.slice(0, 128),
            roles: ['admin'],
          },
          runId: null,
          action: 'knowledge.revoked',
          targetType: 'knowledge_document',
          targetId: input.documentId,
          targetVersion: String(revoked.version_no),
          beforeHash: revoked.content_sha256,
          afterHash: null,
          outcome: 'succeeded',
          details: {
            documentId: input.documentId,
            documentVersionId: revoked.id,
            status: 'withdrawn',
            reasonCode: 'revoked_by_admin',
            reason: input.reason.slice(0, 500),
            policyRevision: documentRow.policy_id,
            sourcePath: revoked.source_path,
            contentHash: revoked.content_sha256,
            retrievalGeneration,
            expiredProposalCount: expiredProposalIds.length,
          },
        });
        const version = versionFromRow(revoked);
        return {
          ok: true as const,
          value: {
            document: documentFromRow(documentRow, version),
            version,
            retrievalGeneration,
            expiredProposalIds,
            changed: true,
          },
        };
      });
    },

    async searchChunks(input: {
      readonly sandboxId: string;
      readonly query: string;
      readonly limit: number;
      readonly effectiveAt: string;
      readonly policyId?: string;
      readonly kind?: 'policy' | 'informational';
    }): Promise<KnowledgeSearchRow[]> {
      const effectiveAt = new Date(input.effectiveAt);
      const rows = asRows<SearchDbRow>(
        await db.execute(sql`
          SELECT
            c.id,
            c.document_version_id,
            v.policy_bundle_version,
            c.text,
            c.locator,
            c.evidence_id,
            ts_rank_cd(
              to_tsvector('english', c.text),
              q.query
            )::float8 AS score
          FROM nexus.knowledge_chunks c
          JOIN nexus.knowledge_versions v
            ON v.sandbox_id = c.sandbox_id
           AND v.id = c.document_version_id
          JOIN nexus.knowledge_documents d
            ON d.sandbox_id = v.sandbox_id
           AND d.id = v.document_id
          CROSS JOIN LATERAL (
            SELECT websearch_to_tsquery('english', ${input.query}) AS query
          ) q
          WHERE c.sandbox_id = ${input.sandboxId}
            AND v.state = 'published'
            AND v.effective_from <= ${effectiveAt}
            AND (v.effective_until IS NULL OR v.effective_until > ${effectiveAt})
            AND c.evidence_id IS NOT NULL
            ${input.kind === undefined ? sql`` : sql`AND d.kind = ${input.kind}`}
            ${input.policyId === undefined ? sql`` : sql`AND d.policy_id = ${input.policyId}`}
            AND to_tsvector('english', c.text) @@ q.query
          ORDER BY score DESC, c.id ASC
          LIMIT ${input.limit}
        `),
      );
      return rows.map((row) => ({
        id: row.id,
        documentVersionId: row.document_version_id,
        policyBundleVersion: row.policy_bundle_version,
        text: row.text,
        locator: row.locator,
        score: Number(row.score ?? 0),
        evidenceId: row.evidence_id,
      }));
    },
  };
}

import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  ActorSchema,
  CaseDetailSchema,
  CaseHistoryItemSchema,
  CaseStatusSchema,
  CaseSummarySchema,
  SandboxSummarySchema,
  type CaseDetail,
  type CaseHistoryItem,
  type CaseSummary,
  type Evidence,
  type SandboxSummary,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type {
  AppendAuditStoreInput,
  CaseStore,
  CreateCaseStoreInput,
  InsertEvidenceStoreInput,
  UpdateCaseStoreInput,
} from '@nexus/application/cases/service';
import type { NexusDb } from '../connection.js';
import { auditEvents } from '../schema/audit.js';
import {
  activeSandbox,
  caseEntityLinks,
  cases,
  sandboxes,
} from '../schema/cases.js';
import { appendAuditInTransaction } from './audit.js';
import { getEvidenceRow, insertEvidenceInTransaction } from './evidence.js';
import type { DbTransaction } from './types.js';

function iso(value: Date): string {
  return value.toISOString();
}

function summaryFromRow(row: typeof cases.$inferSelect): CaseSummary {
  return CaseSummarySchema.parse({
    id: row.id,
    sandboxId: row.sandboxId,
    title: row.title,
    status: CaseStatusSchema.parse(row.status),
    version: row.version,
    terminalReason: row.terminalReason,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

async function detailFromRow(
  tx: DbTransaction | NexusDb,
  row: typeof cases.$inferSelect,
): Promise<CaseDetail> {
  const links = await tx
    .select()
    .from(caseEntityLinks)
    .where(
      and(
        eq(caseEntityLinks.sandboxId, row.sandboxId),
        eq(caseEntityLinks.caseId, row.id),
      ),
    );
  return CaseDetailSchema.parse({
    ...summaryFromRow(row),
    summary: row.summary,
    entityRefs: links.map((link) => ({
      system: link.system,
      type: link.entityType,
      id: link.entityId,
      version: link.entityVersion,
    })),
  });
}

export function createCaseStore(db: NexusDb): CaseStore {
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
        .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
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

    async listCases(input) {
      const conditions = [eq(cases.sandboxId, input.sandboxId)];
      if (input.status) {
        conditions.push(eq(cases.status, input.status));
      }
      if (input.after) {
        conditions.push(
          sql`(date_trunc('milliseconds', ${cases.createdAt}), ${cases.id}) < (${new Date(input.after.createdAt)}, ${input.after.id})`,
        );
      }
      const rows = await db
        .select()
        .from(cases)
        .where(and(...conditions))
        .orderBy(
          sql`date_trunc('milliseconds', ${cases.createdAt}) DESC`,
          desc(cases.id),
        )
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      return {
        items: rows.slice(0, input.limit).map(summaryFromRow),
        hasMore,
      };
    },

    async getCase(sandboxId, caseId) {
      const rows = await db
        .select()
        .from(cases)
        .where(and(eq(cases.sandboxId, sandboxId), eq(cases.id, caseId)))
        .limit(1);
      const row = rows[0];
      return row ? detailFromRow(db, row) : null;
    },

    async listHistory(input) {
      const currentRows = await db
        .select({ status: cases.status, version: cases.version })
        .from(cases)
        .where(and(eq(cases.sandboxId, input.sandboxId), eq(cases.id, input.caseId)))
        .limit(1);
      const current = currentRows[0];
      if (!current) {
        return { items: [], hasMore: false, lastSequence: null };
      }
      const conditions = [
        eq(auditEvents.sandboxId, input.sandboxId),
        or(
          and(
            eq(auditEvents.targetType, 'case'),
            eq(auditEvents.targetId, input.caseId),
          ),
          sql`${auditEvents.details} ->> 'caseId' = ${input.caseId}`,
        ),
      ];
      if (input.afterSequence !== undefined) {
        conditions.push(sql`${auditEvents.sequence} < ${input.afterSequence}`);
      }
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.sequence))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const items = page.map((row): CaseHistoryItem => {
        const details = row.details as Record<string, unknown>;
        const statusValue =
          typeof details['caseStatus'] === 'string'
            ? details['caseStatus']
            : current.status;
        const versionValue =
          typeof details['caseVersion'] === 'number'
            ? details['caseVersion']
            : current.version;
        return CaseHistoryItemSchema.parse({
          id: row.id,
          caseId: input.caseId,
          caseVersion: versionValue,
          status: CaseStatusSchema.parse(statusValue),
          summary: `${row.action}: ${row.outcome}`,
          actor: ActorSchema.parse({
            kind: row.actorKind,
            id: row.actorId,
            roles: row.actorRoles,
          }),
          occurredAt: iso(row.createdAt),
        });
      });
      return {
        items,
        hasMore,
        lastSequence: page.at(-1)?.sequence ?? null,
      };
    },

    async getEvidence(sandboxId, evidenceId): Promise<Evidence | null> {
      return getEvidenceRow(db, sandboxId, evidenceId);
    },

    async createCase(input: CreateCaseStoreInput): Promise<CaseDetail> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(cases)
          .values({
            id: input.caseId,
            sandboxId: input.sandboxId,
            title: input.title,
            summary: input.summary,
            status: 'new',
            version: 1,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new Error('Case insert returned no row');
        }
        await appendAuditInTransaction(tx, {
          ...input,
          runId: null,
          targetType: 'case',
          targetId: input.caseId,
          targetVersion: '1',
          action: input.audit.action,
          beforeHash: null,
          afterHash: canonicalJsonSha256({ status: 'new', version: 1 }),
          outcome: input.audit.outcome,
          details: input.audit.details,
        });
        return detailFromRow(tx, row);
      });
    },

    async updateCase(input: UpdateCaseStoreInput): Promise<CaseDetail | null> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(cases)
          .set({
            status: input.status,
            terminalReason: input.terminalReason,
            version: sql`${cases.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(cases.sandboxId, input.sandboxId),
              eq(cases.id, input.caseId),
              eq(cases.version, input.expectedVersion),
            ),
          )
          .returning();
        const row = rows[0];
        if (!row) {
          return null;
        }
        await appendAuditInTransaction(tx, {
          ...input,
          runId: null,
          targetType: 'case',
          targetId: input.caseId,
          targetVersion: String(row.version),
          action: input.audit.action,
          outcome: input.audit.outcome,
          details: input.audit.details,
        });
        return detailFromRow(tx, row);
      });
    },

    async insertEvidence(input: InsertEvidenceStoreInput): Promise<Evidence> {
      return db.transaction(async (tx) => {
        const stored = await insertEvidenceInTransaction(tx, input);
        await appendAuditInTransaction(tx, {
          ...input,
          runId: null,
          targetType: 'evidence',
          targetId: input.evidenceId,
          targetVersion: null,
          action: input.audit.action,
          beforeHash: null,
          afterHash: input.contentHash,
          outcome: input.audit.outcome,
          details: input.audit.details,
        });
        return stored;
      });
    },

    async appendAudit(input: AppendAuditStoreInput): Promise<void> {
      await db.transaction((tx) => appendAuditInTransaction(tx, input));
    },
  };
}

import { and, eq, sql } from 'drizzle-orm';
import { EvidenceSchema, type Evidence } from '@nexus/contracts';
import type { InsertEvidenceStoreInput } from '@nexus/application/cases/service';
import type { NexusDb } from '../connection.js';
import { evidence } from '../schema/evidence.js';
import type { DbTransaction } from './types.js';

export async function insertEvidenceInTransaction(
  tx: DbTransaction,
  input: InsertEvidenceStoreInput,
): Promise<Evidence> {
  const source = input.sourceRef;
  const rows = await tx
    .insert(evidence)
    .values({
      id: input.evidenceId,
      sandboxId: input.sandboxId,
      caseId: input.caseId,
      kind: input.kind,
      sourceStatus: input.sourceStatus,
      sourceSystem: source?.system ?? null,
      sourceType: source?.type ?? null,
      sourceId: source?.id ?? null,
      sourceVersion: source?.version ?? null,
      sourceSandboxId: input.sourceSandboxId,
      contentHash: input.contentHash,
      locator: input.locator,
      capturedFacts: input.capturedFacts,
      missingReason: input.missingReason,
      capturedAt: sql`clock_timestamp()`,
    })
    .returning({ capturedAt: evidence.capturedAt });
  const capturedAt = rows[0]?.capturedAt;
  if (!capturedAt) {
    throw new Error('Evidence insert returned no row');
  }
  return EvidenceSchema.parse({
    id: input.evidenceId,
    sandboxId: input.sandboxId,
    caseId: input.caseId,
    kind: input.kind,
    sourceRef: source,
    sourceStatus: input.sourceStatus,
    missingReason: input.missingReason,
    contentHash: input.contentHash,
    locator: input.locator,
    capturedFacts: input.capturedFacts,
    capturedAt: capturedAt.toISOString(),
  });
}

export async function getEvidenceRow(
  db: NexusDb,
  sandboxId: string,
  evidenceId: string,
): Promise<Evidence | null> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.sandboxId, sandboxId), eq(evidence.id, evidenceId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return EvidenceSchema.parse({
    id: row.id,
    sandboxId: row.sandboxId,
    caseId: row.caseId,
    kind: row.kind,
    sourceRef:
      row.sourceSystem && row.sourceType && row.sourceId && row.sourceVersion !== null
        ? {
            system: row.sourceSystem,
            type: row.sourceType,
            id: row.sourceId,
            version: row.sourceVersion,
          }
        : null,
    sourceStatus: row.sourceStatus,
    missingReason: row.missingReason,
    contentHash: row.contentHash,
    locator: row.locator,
    capturedFacts: row.capturedFacts,
    capturedAt: row.capturedAt.toISOString(),
  });
}

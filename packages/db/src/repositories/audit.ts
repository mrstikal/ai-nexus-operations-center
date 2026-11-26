import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AppendAuditStoreInput } from '@nexus/application/cases/service';
import { sanitizeAuditDetails } from '@nexus/observability/redaction';
import { ActorSchema, CaseStatusSchema } from '@nexus/contracts';
import type { NexusDb } from '../connection.js';
import { auditEvents } from '../schema/audit.js';
import { sequenceCounters } from '../schema/cases.js';
import type { DbTransaction } from './types.js';

export async function nextSequence(
  tx: DbTransaction,
  sandboxId: string,
  stream: string,
): Promise<number> {
  const rows = await tx
    .insert(sequenceCounters)
    .values({ sandboxId, stream, lastValue: 1 })
    .onConflictDoUpdate({
      target: [sequenceCounters.sandboxId, sequenceCounters.stream],
      set: { lastValue: sql`${sequenceCounters.lastValue} + 1` },
    })
    .returning({ lastValue: sequenceCounters.lastValue });
  const value = rows[0]?.lastValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Sequence allocation failed');
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export async function appendAuditInTransaction(
  tx: DbTransaction,
  input: AppendAuditStoreInput,
): Promise<void> {
  const sequence = await nextSequence(tx, input.sandboxId, 'audit');
  if (!ActorSchema.safeParse(input.actor).success) {
    throw new Error('Invalid audit actor');
  }
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(input.action)) {
    throw new Error('Invalid audit action');
  }
  if (input.targetType !== null && (input.targetType.length > 100 || hasControlCharacters(input.targetType))) {
    throw new Error('Invalid audit target type');
  }
  if (input.targetVersion !== null && (input.targetVersion.length > 100 || hasControlCharacters(input.targetVersion))) {
    throw new Error('Invalid audit target version');
  }
  const details = sanitizeAuditDetails(input.details);
  if (typeof details.caseStatus === 'string' && !CaseStatusSchema.safeParse(details.caseStatus).success) {
    throw new Error('Invalid audit case status');
  }
  if (
    details.caseVersion !== undefined &&
    details.caseVersion !== null &&
    (typeof details.caseVersion !== 'number' ||
      !Number.isInteger(details.caseVersion) ||
      details.caseVersion < 0 ||
      details.caseVersion > 2_147_483_647)
  ) {
    throw new Error('Invalid audit case version');
  }
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    sandboxId: input.sandboxId,
    sequence,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    actorRoles: input.actor.roles,
    requestId: input.requestId,
    correlationId: input.correlationId,
    runId: input.runId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    targetVersion: input.targetVersion,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    outcome: input.outcome,
    details: details as Record<string, unknown>,
    createdAt: sql`clock_timestamp()`,
  });
}

export async function appendAuditEvent(
  db: NexusDb,
  input: AppendAuditStoreInput,
): Promise<void> {
  await db.transaction((tx) => appendAuditInTransaction(tx, input));
}

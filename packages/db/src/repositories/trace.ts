import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sanitizeTraceData, type TraceData } from '@nexus/observability/trace';
import type { NexusDb } from '../connection.js';
import { traceEvents } from '../schema/trace.js';
import { nextSequence } from './audit.js';
import type { DbTransaction } from './types.js';

export interface TraceWriteInput {
  readonly sandboxId: string;
  readonly runId: string | null;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly event: string;
  readonly data: TraceData;
}

export async function appendTraceEventInTransaction(
  tx: DbTransaction,
  input: TraceWriteInput,
): Promise<void> {
  const sequence = await nextSequence(tx, input.sandboxId, 'trace');
  const data = sanitizeTraceData(input.data);
  await tx.insert(traceEvents).values({
    id: randomUUID(),
    sandboxId: input.sandboxId,
    runId: input.runId,
    sequence,
    level: input.level,
    event: input.event,
    data: data as Record<string, unknown>,
    createdAt: sql`clock_timestamp()`,
  });
}

export async function appendTraceEvent(
  db: NexusDb,
  input: TraceWriteInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    await appendTraceEventInTransaction(tx, input);
  });
}

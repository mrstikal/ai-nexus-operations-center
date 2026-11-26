import {
  bigint,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const nexusSchema = pgSchema('nexus');

export const traceEvents = nexusSchema.table(
  'trace_events',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    runId: uuid('run_id'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    level: text('level').notNull(),
    event: text('event').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('trace_events_sandbox_sequence_key').on(table.sandboxId, table.sequence)],
);

export type TraceEventRow = typeof traceEvents.$inferSelect;

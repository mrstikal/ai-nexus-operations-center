import {
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cases } from './cases.js';

export const nexusSchema = pgSchema('nexus');

export const evidence = nexusSchema.table(
  'evidence',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    caseId: uuid('case_id'),
    kind: text('kind').notNull(),
    sourceStatus: text('source_status').notNull(),
    sourceSystem: text('source_system'),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    sourceVersion: integer('source_version'),
    sourceSandboxId: uuid('source_sandbox_id'),
    contentHash: text('content_hash').notNull(),
    locator: jsonb('locator').$type<Record<string, unknown> | null>(),
    capturedFacts: jsonb('captured_facts').$type<unknown>().notNull(),
    missingReason: text('missing_reason'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededReason: text('superseded_reason'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('evidence_sandbox_id_key').on(table.sandboxId, table.id),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
  ],
);

export type EvidenceRow = typeof evidence.$inferSelect;

import {
  bigint,
  boolean,
  foreignKey,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const nexusSchema = pgSchema('nexus');

export const sandboxes = nexusSchema.table('sandboxes', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  businessEffectiveAt: timestamp('business_effective_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export const activeSandbox = nexusSchema.table(
  'active_sandbox',
  {
  singleton: boolean('singleton').primaryKey(),
  id: uuid('id').notNull(),
  sandboxId: uuid('sandbox_id')
    .notNull()
    .references(() => sandboxes.id),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('active_sandbox_id_key').on(table.id)],
);

export const cases = nexusSchema.table(
  'cases',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    title: text('title').notNull(),
    summary: text('summary'),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    terminalReason: text('terminal_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('cases_sandbox_id_id_key').on(table.sandboxId, table.id),
  ],
);

export const caseEntityLinks = nexusSchema.table(
  'case_entity_links',
  {
    id: uuid('id').notNull(),
    sandboxId: uuid('sandbox_id').notNull(),
    caseId: uuid('case_id').notNull(),
    system: text('system').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityVersion: integer('entity_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.sandboxId,
        table.caseId,
        table.system,
        table.entityType,
        table.entityId,
        table.entityVersion,
      ],
    }),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }).onDelete('cascade'),
    uniqueIndex('case_entity_links_id_key').on(table.id),
  ],
);

export const sequenceCounters = nexusSchema.table(
  'sequence_counters',
  {
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    stream: text('stream').notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sandboxId, table.stream] })],
);

export type CaseRow = typeof cases.$inferSelect;
export type SandboxRow = typeof sandboxes.$inferSelect;

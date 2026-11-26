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

export const auditEvents = nexusSchema.table(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actorRoles: jsonb('actor_roles').$type<string[]>().notNull(),
    requestId: text('request_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    runId: uuid('run_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    targetVersion: text('target_version'),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    outcome: text('outcome').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('audit_events_sandbox_sequence_key').on(table.sandboxId, table.sequence)],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;

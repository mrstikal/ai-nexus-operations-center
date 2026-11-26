import {
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cases, sandboxes } from './cases.js';
import { workflowRuns } from './workflows.js';

export const nexusSchema = pgSchema('nexus');

export const workflowDependencies = nexusSchema.table(
  'workflow_dependencies',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    parentRunId: uuid('parent_run_id').notNull(),
    parentCaseId: uuid('parent_case_id').notNull(),
    rootCaseId: uuid('root_case_id').notNull(),
    childCaseId: uuid('child_case_id').notNull(),
    childTriggerEventId: uuid('child_trigger_event_id').notNull(),
    linkedCaseVersion: integer('linked_case_version').notNull(),
    state: text('state').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_dependencies_parent_child_key').on(
      table.sandboxId,
      table.parentRunId,
      table.childTriggerEventId,
    ),
    uniqueIndex('workflow_dependencies_active_parent_key')
      .on(table.parentRunId)
      .where(sql`${table.state} = 'waiting'`),
    index('workflow_dependencies_wait_idx').on(
      table.state,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.parentRunId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.parentCaseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.rootCaseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.childCaseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.childCaseId, table.childTriggerEventId],
      foreignColumns: [
        workflowRuns.sandboxId,
        workflowRuns.caseId,
        workflowRuns.triggerEventId,
      ],
    }),
  ],
);

export type WorkflowDependencyRow = typeof workflowDependencies.$inferSelect;

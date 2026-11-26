import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { actionProposals, actionRevisions } from './actions.js';
import { cases, sandboxes } from './cases.js';

export const nexusSchema = pgSchema('nexus');

export const actionExecutions = nexusSchema.table(
  'action_executions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    caseId: uuid('case_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    itemId: uuid('item_id').notNull(),
    commandKind: text('command_kind').notNull(),
    executionKey: text('execution_key').notNull(),
    planHash: text('plan_hash').notNull(),
    itemHash: text('item_hash').notNull(),
    state: text('state').notNull(),
    authorizationBasis: text('authorization_basis').notNull(),
    policyRevision: text('policy_revision'),
    policyContentHash: text('policy_content_hash'),
    committedMinor: bigint('committed_minor', { mode: 'number' }),
    receiptKey: text('receipt_key'),
    receiptId: uuid('receipt_id'),
    resultEntityType: text('result_entity_type'),
    resultEntityId: uuid('result_entity_id'),
    resultEntityVersion: integer('result_entity_version'),
    attemptCount: integer('attempt_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_executions_revision_item_key').on(
      table.sandboxId,
      table.actionRevisionId,
      table.itemId,
    ),
    uniqueIndex('action_executions_execution_key').on(
      table.sandboxId,
      table.executionKey,
    ),
    uniqueIndex('action_executions_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    index('action_executions_case_idx').on(table.sandboxId, table.caseId),
    index('action_executions_revision_idx').on(
      table.sandboxId,
      table.actionRevisionId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.proposalId],
      foreignColumns: [actionProposals.sandboxId, actionProposals.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.actionRevisionId],
      foreignColumns: [actionRevisions.sandboxId, actionRevisions.id],
    }),
  ],
);

export const actionExecutionAttempts = nexusSchema.table(
  'action_execution_attempts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    state: text('state').notNull(),
    requestHash: text('request_hash'),
    executeBefore: timestamp('execute_before', { withTimezone: true }),
    authorizationValidUntil: timestamp('authorization_valid_until', {
      withTimezone: true,
    }),
    errorCode: text('error_code'),
    receiptKey: text('receipt_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_execution_attempts_number_key').on(
      table.executionId,
      table.attemptNumber,
    ),
    index('action_execution_attempts_execution_idx').on(
      table.sandboxId,
      table.executionId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.executionId],
      foreignColumns: [actionExecutions.sandboxId, actionExecutions.id],
    }),
  ],
);

export const actionExecutionReceipts = nexusSchema.table(
  'action_execution_receipts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    receiptKey: text('receipt_key').notNull(),
    commandKind: text('command_kind').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    itemId: uuid('item_id').notNull(),
    planHash: text('plan_hash').notNull(),
    itemHash: text('item_hash').notNull(),
    resultEntityType: text('result_entity_type').notNull(),
    resultEntityId: uuid('result_entity_id').notNull(),
    resultEntityVersion: integer('result_entity_version').notNull(),
    receipt: jsonb('receipt').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_execution_receipts_key').on(
      table.sandboxId,
      table.receiptKey,
    ),
    uniqueIndex('action_execution_receipts_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    uniqueIndex('action_execution_receipts_execution_key').on(
      table.executionId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.executionId],
      foreignColumns: [actionExecutions.sandboxId, actionExecutions.id],
    }),
  ],
);

export const actionExecutionEntityChanges = nexusSchema.table(
  'action_execution_entity_changes',
  {
    sandboxId: uuid('sandbox_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    beforeVersion: integer('before_version'),
    afterVersion: integer('after_version').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sandboxId, table.receiptId, table.ordinal],
      name: 'action_execution_entity_changes_pkey',
    }),
    index('action_execution_entity_changes_entity_idx').on(
      table.sandboxId,
      table.entityType,
      table.entityId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.receiptId],
      foreignColumns: [actionExecutionReceipts.sandboxId, actionExecutionReceipts.id],
    }),
  ],
);

export const caseNotes = nexusSchema.table(
  'case_notes',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    caseId: uuid('case_id').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    itemId: uuid('item_id').notNull(),
    text: text('text').notNull(),
    authorizationBasis: text('authorization_basis').notNull(),
    policyRevision: text('policy_revision').notNull(),
    policyContentHash: text('policy_content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('case_notes_revision_item_key').on(
      table.actionRevisionId,
      table.itemId,
    ),
    index('case_notes_case_idx').on(table.sandboxId, table.caseId, table.createdAt),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
  ],
);

export type ActionExecutionRow = typeof actionExecutions.$inferSelect;
export type ActionExecutionReceiptRow = typeof actionExecutionReceipts.$inferSelect;

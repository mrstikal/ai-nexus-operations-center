import {
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EnterpriseBaseExpectedVersion } from '@nexus/contracts';
import { actionExecutions, actionExecutionAttempts } from './executions.js';
import { actionProposals } from './actions.js';

export const nexusSchema = pgSchema('nexus');

export const executionAttemptPayloads = nexusSchema.table(
  'execution_attempt_payloads',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull(),
    baseExpectedVersions: jsonb('base_expected_versions').$type<EnterpriseBaseExpectedVersion[]>().notNull(),
    priorReceiptKeys: jsonb('prior_receipt_keys').$type<string[]>().notNull(),
    commandKind: text('command_kind').notNull(),
    receiptKey: text('receipt_key').notNull(),
    planHash: text('plan_hash').notNull(),
    itemHash: text('item_hash').notNull(),
    executeBefore: timestamp('execute_before', { withTimezone: true }).notNull(),
    authorizationValidUntil: timestamp('authorization_valid_until', {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sandboxId, table.attemptId],
      foreignColumns: [actionExecutionAttempts.sandboxId, actionExecutionAttempts.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.executionId],
      foreignColumns: [actionExecutions.sandboxId, actionExecutions.id],
    }),
  ],
);

export const executionReconciliations = nexusSchema.table(
  'execution_reconciliations',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    result: text('result').notNull(),
    receiptKey: text('receipt_key'),
    dbNow: timestamp('db_now', { withTimezone: true }).notNull(),
    detail: text('detail'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('execution_reconciliations_execution_idx').on(
      table.sandboxId,
      table.executionId,
      table.observedAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.executionId],
      foreignColumns: [actionExecutions.sandboxId, actionExecutions.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.attemptId],
      foreignColumns: [actionExecutionAttempts.sandboxId, actionExecutionAttempts.id],
    }),
  ],
);

export const actionPartialEffects = nexusSchema.table(
  'action_partial_effects',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    kind: text('kind').notNull(),
    receiptKey: text('receipt_key'),
    itemId: uuid('item_id').notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_partial_effects_execution_key').on(table.executionId),
    foreignKey({
      columns: [table.sandboxId, table.executionId],
      foreignColumns: [actionExecutions.sandboxId, actionExecutions.id],
    }),
  ],
);

export const actionReanalysisHandoffs = nexusSchema.table(
  'action_reanalysis_handoffs',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    sourceProposalId: uuid('source_proposal_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    succeededReceiptKeys: jsonb('succeeded_receipt_keys').$type<string[]>().notNull(),
    cancelledItemIds: jsonb('cancelled_item_ids').$type<string[]>().notNull(),
    state: text('state').notNull(),
    createdProposalId: uuid('created_proposal_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_reanalysis_handoffs_revision_key').on(table.sourceRevisionId),
    foreignKey({
      columns: [table.sandboxId, table.sourceProposalId],
      foreignColumns: [actionProposals.sandboxId, actionProposals.id],
    }),
  ],
);

export const actionCaseCancellations = nexusSchema.table(
  'action_case_cancellations',
  {
    sandboxId: uuid('sandbox_id').notNull(),
    caseId: uuid('case_id').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sandboxId, table.caseId] }),
  ],
);

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ModelFailureCode, ModelUsage } from '@nexus/contracts';
import { workflowRuns } from './workflows.js';
import { budgetAccounts } from './budget-accounts.js';

export const nexusSchema = pgSchema('nexus');

export interface ModelCallReservationRow {
  readonly accountId: string;
  readonly reservedMicrousd: string;
}

export const modelCalls = nexusSchema.table(
  'model_calls',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    budgetAccountId: uuid('budget_account_id').notNull(),
    gatewayInvocationId: uuid('gateway_invocation_id').notNull(),
    physicalAttempt: integer('physical_attempt').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    role: text('role').notNull(),
    outputSchemaId: text('output_schema_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    configRevision: text('config_revision').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    mode: text('mode').notNull(),
    replayKey: text('replay_key'),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull(),
    reservedMicrousd: bigint('reserved_microusd', { mode: 'bigint' }).notNull(),
    settledMicrousd: bigint('settled_microusd', { mode: 'bigint' }),
    reservations: jsonb('reservations').$type<ModelCallReservationRow[]>().notNull(),
    usage: jsonb('usage').$type<ModelUsage | null>(),
    failureCode: text('failure_code').$type<ModelFailureCode>(),
    diagnostics: jsonb('diagnostics').$type<string[]>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('model_calls_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('model_calls_invocation_attempt_key').on(
      table.sandboxId,
      table.gatewayInvocationId,
      table.physicalAttempt,
    ),
    index('model_calls_account_idx').on(table.sandboxId, table.budgetAccountId, table.createdAt),
    index('model_calls_run_idx').on(table.sandboxId, table.workflowRunId, table.createdAt),
    foreignKey({
      columns: [table.sandboxId, table.budgetAccountId],
      foreignColumns: [budgetAccounts.sandboxId, budgetAccounts.id],
      name: 'model_calls_account_fk',
    }),
    foreignKey({
      columns: [table.sandboxId, table.workflowRunId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
      name: 'model_calls_run_fk',
    }),
    check(
      'model_calls_state_check',
      sql`${table.state} IN ('reserved','settled','failed','uncertain')`,
    ),
    check('model_calls_mode_check', sql`${table.mode} IN ('replay','live')`),
    check(
      'model_calls_attempt_check',
      sql`${table.physicalAttempt} BETWEEN 1 AND 2`,
    ),
    check(
      'model_calls_amounts_check',
      sql`${table.reservedMicrousd} >= 0 AND (${table.settledMicrousd} IS NULL OR ${table.settledMicrousd} >= 0)`,
    ),
    check(
      'model_calls_hashes_check',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$' AND (${table.replayKey} IS NULL OR ${table.replayKey} ~ '^[a-f0-9]{64}$') AND ${table.promptVersion} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'model_calls_reservations_check',
      sql`jsonb_typeof(${table.reservations}) = 'array' AND jsonb_array_length(${table.reservations}) BETWEEN 1 AND 4`,
    ),
  ],
);

export type ModelCallRow = typeof modelCalls.$inferSelect;

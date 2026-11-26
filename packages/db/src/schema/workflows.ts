import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { cases, sandboxes } from './cases.js';
import { evidence } from './evidence.js';
import { eventInbox } from './events.js';

export const nexusSchema = pgSchema('nexus');

export const workflowRuns = nexusSchema.table(
  'workflow_runs',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    caseId: uuid('case_id').notNull(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => eventInbox.id),
    triggerEventId: uuid('trigger_event_id').notNull(),
    triggerEventType: text('trigger_event_type').notNull(),
    definitionName: text('definition_name').notNull(),
    definitionVersion: text('definition_version').notNull(),
    status: text('status').notNull(),
    ingress: jsonb('ingress').$type<Record<string, unknown>>().notNull(),
    ingressHash: text('ingress_hash').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    waitReason: jsonb('wait_reason').$type<Record<string, unknown> | null>(),
    policyRevision: text('policy_revision').notNull(),
    modelRevision: text('model_revision').notNull(),
    configRevision: text('config_revision').notNull(),
    promptRevision: text('prompt_revision'),
    activeMsLimit: integer('active_ms_limit').notNull(),
    activeMsUsed: integer('active_ms_used').notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    cancelRequested: boolean('cancel_requested').notNull(),
    lastError: text('last_error'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_runs_sandbox_id_key').on(table.sandboxId, table.id),
    uniqueIndex('workflow_runs_sandbox_trigger_key').on(
      table.sandboxId,
      table.triggerEventId,
    ),
    index('workflow_runs_status_idx').on(
      table.sandboxId,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    check(
      'workflow_runs_status_check',
      sql`${table.status} IN ('queued','running','waiting_input','waiting_approval','waiting_dependency','blocked','budget_exhausted','completed','failed','cancel_requested','cancelled')`,
    ),
    check('workflow_runs_ingress_hash_check', sql`${table.ingressHash} ~ '^[a-f0-9]{64}$'`),
    check('workflow_runs_active_ms_check', sql`${table.activeMsUsed} >= 0 AND ${table.activeMsLimit} > 0`),
  ],
);

export const workflowSteps = nexusSchema.table(
  'workflow_steps',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    runId: uuid('run_id').notNull(),
    stepKey: text('step_key').notNull(),
    stepKind: text('step_kind').notNull(),
    status: text('status').notNull(),
    inputHash: text('input_hash'),
    outputHash: text('output_hash'),
    output: jsonb('output').$type<Record<string, string | number | boolean | null> | null>(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull(),
    attemptCount: integer('attempt_count').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    errorClass: text('error_class'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_steps_run_step_key').on(table.runId, table.stepKey),
    index('workflow_steps_run_status_idx').on(table.runId, table.status),
    foreignKey({
      columns: [table.sandboxId, table.runId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
    }),
    check(
      'workflow_steps_kind_check',
      sql`${table.stepKind} IN ('pure','read','external')`,
    ),
    check(
      'workflow_steps_status_check',
      sql`${table.status} IN ('pending','running','succeeded','retryable_failure','permanent_failure','waiting','cancelled')`,
    ),
    check(
      'workflow_steps_attempts_check',
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 3 AND ${table.attemptCount} <= 3`,
    ),
    check('workflow_steps_key_check', sql`${table.stepKey} ~ '^[a-z][a-z0-9_.-]{0,99}$'`),
    check(
      'workflow_steps_hashes_check',
      sql`(${table.inputHash} IS NULL OR ${table.inputHash} ~ '^[a-f0-9]{64}$') AND (${table.outputHash} IS NULL OR ${table.outputHash} ~ '^[a-f0-9]{64}$')`,
    ),
  ],
);

export const workflowStepAttempts = nexusSchema.table(
  'workflow_step_attempts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    runId: uuid('run_id').notNull(),
    stepId: uuid('step_id').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    status: text('status').notNull(),
    inputHash: text('input_hash').notNull(),
    outputHash: text('output_hash'),
    output: jsonb('output').$type<Record<string, string | number | boolean | null> | null>(),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull(),
    errorClass: text('error_class'),
    modelRevision: text('model_revision'),
    policyRevision: text('policy_revision'),
    configRevision: text('config_revision'),
    promptRevision: text('prompt_revision'),
    leaseFencingToken: bigint('lease_fencing_token', { mode: 'number' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_step_attempts_sandbox_id_key').on(
      table.sandboxId,
      table.id,
    ),
    uniqueIndex('workflow_step_attempts_step_attempt_key').on(
      table.stepId,
      table.attemptNo,
    ),
    index('workflow_step_attempts_run_idx').on(table.runId, table.createdAt),
    foreignKey({
      columns: [table.sandboxId, table.runId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
    }),
    foreignKey({
      columns: [table.stepId],
      foreignColumns: [workflowSteps.id],
    }),
    check(
      'workflow_step_attempts_status_check',
      sql`${table.status} IN ('running','succeeded','retryable_failure','permanent_failure','waiting','cancelled')`,
    ),
    check(
      'workflow_step_attempts_hashes_check',
      sql`${table.inputHash} ~ '^[a-f0-9]{64}$' AND (${table.outputHash} IS NULL OR ${table.outputHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check('workflow_step_attempts_no_check', sql`${table.attemptNo} BETWEEN 1 AND 3`),
  ],
);

export const workflowAttemptEvidence = nexusSchema.table(
  'workflow_attempt_evidence',
  {
    attemptId: uuid('attempt_id').notNull(),
    sandboxId: uuid('sandbox_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.attemptId, table.evidenceId] }),
    foreignKey({
      columns: [table.sandboxId, table.attemptId],
      foreignColumns: [workflowStepAttempts.sandboxId, workflowStepAttempts.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.evidenceId],
      foreignColumns: [evidence.sandboxId, evidence.id],
    }),
  ],
);

export const workflowJobs = nexusSchema.table(
  'workflow_jobs',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    runId: uuid('run_id').notNull(),
    state: text('state').notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('workflow_jobs_active_run_key')
      .on(table.runId)
      .where(sql`${table.state} IN ('pending','leased')`),
    index('workflow_jobs_claim_idx').on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.runId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
    }),
    check(
      'workflow_jobs_state_check',
      sql`${table.state} IN ('pending','leased','succeeded','failed','cancelled')`,
    ),
    check('workflow_jobs_fencing_check', sql`${table.fencingToken} >= 0`),
  ],
);

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowStepRow = typeof workflowSteps.$inferSelect;
export type WorkflowStepAttemptRow = typeof workflowStepAttempts.$inferSelect;
export type WorkflowJobRow = typeof workflowJobs.$inferSelect;

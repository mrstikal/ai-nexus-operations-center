import {
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
import { sql } from 'drizzle-orm';
import type { Role } from '@nexus/contracts';
import { cases, sandboxes } from './cases.js';
import { actionProposals, actionRevisions } from './actions.js';
import { workflowRuns } from './workflows.js';

export const nexusSchema = pgSchema('nexus');

export const approvalDecisions = nexusSchema.table(
  'approval_decisions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    proposalId: uuid('proposal_id').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    planHash: text('plan_hash').notNull(),
    decision: text('decision').notNull(),
    role: text('role').notNull(),
    requiredRoles: jsonb('required_roles').$type<Role[]>().notNull(),
    state: text('state').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actorRoles: jsonb('actor_roles').$type<Role[]>().notNull(),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    index('approval_decisions_revision_idx').on(
      table.sandboxId,
      table.actionRevisionId,
      table.decidedAt,
    ),
    index('approval_decisions_proposal_idx').on(
      table.sandboxId,
      table.proposalId,
      table.decidedAt,
    ),
    uniqueIndex('approval_decisions_active_role_key')
      .on(table.sandboxId, table.actionRevisionId, table.role)
      .where(sql`${table.decision} = 'approve' AND ${table.state} = 'active'`),
    uniqueIndex('approval_decisions_active_actor_key')
      .on(table.sandboxId, table.actionRevisionId, table.actorId)
      .where(sql`${table.decision} = 'approve' AND ${table.state} = 'active'`),
    uniqueIndex('approval_decisions_active_reject_key')
      .on(table.sandboxId, table.actionRevisionId)
      .where(sql`${table.decision} = 'reject' AND ${table.state} = 'active'`),
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

export const actionCommandIdempotency = nexusSchema.table(
  'action_command_idempotency',
  {
    sandboxId: uuid('sandbox_id').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    route: text('route').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.sandboxId,
        table.actorKind,
        table.actorId,
        table.route,
        table.idempotencyKey,
      ],
      name: 'action_command_idempotency_pkey',
    }),
  ],
);

export const actionRevisionRequests = nexusSchema.table(
  'action_revision_requests',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    planHash: text('plan_hash').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actorRoles: jsonb('actor_roles').$type<Role[]>().notNull(),
    reason: text('reason').notNull(),
    waitRunId: uuid('wait_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('action_revision_requests_proposal_idx').on(
      table.sandboxId,
      table.proposalId,
      table.createdAt,
    ),
    uniqueIndex('action_revision_requests_active_kind_key')
      .on(table.sandboxId, table.actionRevisionId, table.kind)
      .where(sql`${table.state} = 'recorded'`),
    foreignKey({
      columns: [table.sandboxId, table.proposalId],
      foreignColumns: [actionProposals.sandboxId, actionProposals.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.actionRevisionId],
      foreignColumns: [actionRevisions.sandboxId, actionRevisions.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.waitRunId],
      foreignColumns: [workflowRuns.sandboxId, workflowRuns.id],
    }),
  ],
);

export const caseResolutions = nexusSchema.table(
  'case_resolutions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    caseId: uuid('case_id').notNull(),
    caseVersion: integer('case_version').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    actorRoles: jsonb('actor_roles').$type<Role[]>().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('case_resolutions_case_idx').on(
      table.sandboxId,
      table.caseId,
      table.resolvedAt,
    ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
  ],
);

export type ApprovalDecisionRow = typeof approvalDecisions.$inferSelect;
export type ActionRevisionRequestRow = typeof actionRevisionRequests.$inferSelect;

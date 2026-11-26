import {
  bigint,
  boolean,
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
import type { ActionPlanItem, Role } from '@nexus/contracts';
import { cases, sandboxes } from './cases.js';
import { evidence } from './evidence.js';

export const nexusSchema = pgSchema('nexus');

export const actionProposals = nexusSchema.table(
  'action_proposals',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    caseId: uuid('case_id').notNull(),
    currentRevisionId: uuid('current_revision_id'),
    status: text('status').notNull(),
    hasProcurement: boolean('has_procurement').notNull(),
    createdByKind: text('created_by_kind').notNull(),
    createdById: text('created_by_id').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_proposals_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    index('action_proposals_case_idx').on(
      table.sandboxId,
      table.caseId,
      table.createdAt,
    ),
    uniqueIndex('action_proposals_open_procurement_key')
      .on(table.sandboxId, table.caseId)
      .where(
        sql`${table.hasProcurement} AND ${table.status} IN ('draft', 'pending_approval', 'approved')`,
      ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
  ],
);

export const actionRevisions = nexusSchema.table(
  'action_revisions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    state: text('state').notNull(),
    planHash: text('plan_hash').notNull(),
    items: jsonb('items').$type<ActionPlanItem[]>().notNull(),
    requiredRoles: jsonb('required_roles').$type<Role[]>().notNull(),
    aggregateImpactMinor: bigint('aggregate_impact_minor', { mode: 'number' }),
    isProcurement: boolean('is_procurement').notNull(),
    policyRevision: text('policy_revision').notNull(),
    policyContentHash: text('policy_content_hash').notNull(),
    rationale: text('rationale').notNull(),
    authoredByKind: text('authored_by_kind').notNull(),
    authoredById: text('authored_by_id').notNull(),
    authoredByRoles: jsonb('authored_by_roles').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('action_revisions_sandbox_id_id_key').on(
      table.sandboxId,
      table.id,
    ),
    uniqueIndex('action_revisions_proposal_number_key').on(
      table.proposalId,
      table.revisionNumber,
    ),
    index('action_revisions_proposal_idx').on(table.sandboxId, table.proposalId),
    foreignKey({
      columns: [table.sandboxId, table.proposalId],
      foreignColumns: [actionProposals.sandboxId, actionProposals.id],
    }),
  ],
);

export const actionRevisionEvidence = nexusSchema.table(
  'action_revision_evidence',
  {
    sandboxId: uuid('sandbox_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sandboxId, table.revisionId, table.evidenceId],
      name: 'action_revision_evidence_pkey',
    }),
    foreignKey({
      columns: [table.sandboxId, table.revisionId],
      foreignColumns: [actionRevisions.sandboxId, actionRevisions.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.evidenceId],
      foreignColumns: [evidence.sandboxId, evidence.id],
    }),
  ],
);

export const actionProposalIdempotency = nexusSchema.table(
  'action_proposal_idempotency',
  {
    sandboxId: uuid('sandbox_id').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    route: text('route').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    proposalId: uuid('proposal_id').notNull(),
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
      name: 'action_proposal_idempotency_pkey',
    }),
    foreignKey({
      columns: [table.sandboxId, table.proposalId],
      foreignColumns: [actionProposals.sandboxId, actionProposals.id],
    }),
  ],
);

export type ActionProposalRow = typeof actionProposals.$inferSelect;
export type ActionRevisionRow = typeof actionRevisions.$inferSelect;

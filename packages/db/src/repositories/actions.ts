import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  ActionPlanItemSchema,
  ActionProposalDetailSchema,
  ActionProposalStatusSchema,
  CaseStatusSchema,
  EvidenceSchema,
  RoleSchema,
  SandboxSummarySchema,
  type ActionProposalDetail,
  type ActionPlanItem,
  type Evidence,
  type Money,
  type Role,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { formatMinor } from '@nexus/domain/money';
import { PolicyValidationError } from '@nexus/domain/policies/action-validation';
import type {
  CreateProposalStoreInput,
  PolicyBundleRegistration,
  ProposalCaseSnapshot,
  ProposalCreateStoreResult,
  ProposalReviseStoreResult,
  ProposalListCursor,
  ProposalStore,
  ReviseProposalStoreInput,
} from '@nexus/application/actions/proposals';
import type {
  ExpireProposalRevisionInput,
  OpenProposalRevision,
  ProposalInvalidationStore,
} from '@nexus/application/actions/invalidation';
import type { NexusDb } from '../connection.js';
import { activeSandbox, cases, sandboxes } from '../schema/cases.js';
import { evidence } from '../schema/evidence.js';
import { eventInbox } from '../schema/events.js';
import {
  actionProposalIdempotency,
  actionProposals,
  actionRevisionEvidence,
  actionRevisions,
} from '../schema/actions.js';
import { policyBundles } from '../schema/policies.js';
import { approvalDecisions } from '../schema/approvals.js';
import { workflowRuns } from '../schema/workflows.js';
import {
  actionExecutionEntityChanges,
  actionExecutionReceipts,
  actionExecutions,
} from '../schema/executions.js';
import {
  CaseWorkflowTransitionError,
  applyCaseTransition,
} from './workflow-case.js';
import { appendAuditInTransaction } from './audit.js';
import type { DbTransaction } from './types.js';

const CONSUMER_NAME = 'nexus.worker.events.v1';
const PROPOSAL_EVENT_TYPES = [
  'enterprise.inventory.changed.v1',
  'enterprise.order.changed.v1',
  'enterprise.invoice.changed.v1',
] as const;

function iso(value: Date): string {
  return value.toISOString();
}

function actionItems(value: unknown): ActionPlanItem[] {
  return ActionPlanItemSchema.array().parse(value);
}

function requiredRoles(value: unknown): Role[] {
  return RoleSchema.array().parse(value);
}

function aggregateImpact(value: number | null): Money | null {
  return value === null
    ? null
    : { amountMinor: formatMinor(BigInt(value)), currency: 'EUR' };
}

export function detailFromRows(
  proposal: typeof actionProposals.$inferSelect,
  revision: typeof actionRevisions.$inferSelect,
): ActionProposalDetail {
  return ActionProposalDetailSchema.parse({
    proposal: {
      id: proposal.id,
      caseId: proposal.caseId,
      sandboxId: proposal.sandboxId,
      currentRevisionId: proposal.currentRevisionId,
      status: ActionProposalStatusSchema.parse(proposal.status),
      createdAt: iso(proposal.createdAt),
      updatedAt: iso(proposal.updatedAt),
    },
    revision: {
      id: revision.id,
      proposalId: revision.proposalId,
      revisionNumber: revision.revisionNumber,
      planHash: revision.planHash,
      state: ActionProposalStatusSchema.parse(revision.state),
      items: actionItems(revision.items),
      requiredRoles: requiredRoles(revision.requiredRoles),
      policyRevision: revision.policyRevision,
      policyContentHash: revision.policyContentHash,
      aggregateImpact: aggregateImpact(revision.aggregateImpactMinor),
      createdBy: {
        kind: revision.authoredByKind as 'human' | 'workflow' | 'service',
        id: revision.authoredById,
        roles: RoleSchema.array().parse(revision.authoredByRoles),
      },
      createdAt: iso(revision.createdAt),
      expiresAt: iso(revision.expiresAt),
    },
  });
}

export async function loadProposalDetail(
  tx: NexusDb | DbTransaction,
  sandboxId: string,
  proposalId: string,
): Promise<ActionProposalDetail | null> {
  const proposalRows = await tx
    .select()
    .from(actionProposals)
    .where(
      and(
        eq(actionProposals.sandboxId, sandboxId),
        eq(actionProposals.id, proposalId),
      ),
    )
    .limit(1);
  const proposal = proposalRows[0];
  if (!proposal || !proposal.currentRevisionId) {
    return null;
  }
  const revisionRows = await tx
    .select()
    .from(actionRevisions)
    .where(
      and(
        eq(actionRevisions.sandboxId, sandboxId),
        eq(actionRevisions.id, proposal.currentRevisionId),
      ),
    )
    .limit(1);
  const revision = revisionRows[0];
  return revision ? detailFromRows(proposal, revision) : null;
}

export async function resolveActiveSandbox(
  tx: DbTransaction,
): Promise<{ id: string } | { status: 'sandbox_inactive' | 'sandbox_unavailable' }> {
  const rows = await tx
    .select({ id: sandboxes.id, status: sandboxes.status })
    .from(activeSandbox)
    .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { status: 'sandbox_unavailable' };
  }
  if (row.status !== 'active') {
    return { status: 'sandbox_inactive' };
  }
  return { id: row.id };
}

function isOpenStatus(status: string): boolean {
  return status === 'draft' || status === 'pending_approval' || status === 'approved';
}

async function lock(tx: DbTransaction, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function uniqueViolation(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === '23505') {
      return typeof record.constraint === 'string' ? record.constraint : '';
    }
    current = record.cause;
  }
  return null;
}

async function insertEvidenceLinks(
  tx: DbTransaction,
  sandboxId: string,
  revisionId: string,
  items: readonly ActionPlanItem[],
): Promise<void> {
  const evidenceIds = [...new Set(items.flatMap((item) => item.evidenceIds))];
  for (const evidenceId of evidenceIds) {
    await tx.insert(actionRevisionEvidence).values({
      sandboxId,
      revisionId,
      evidenceId,
    });
  }
}

async function appendProposalAudit(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly actor: CreateProposalStoreInput['actor'];
    readonly requestId: string;
    readonly correlationId: string;
    readonly action: string;
    readonly caseId: string;
    readonly proposalId: string;
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly planHash: string;
    readonly policyRevision: string;
    readonly beforeHash: string | null;
    readonly status: string;
  },
): Promise<void> {
  await appendAuditInTransaction(tx, {
    sandboxId: input.sandboxId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actor: input.actor,
    runId: null,
    action: input.action,
    targetType: 'action_proposal',
    targetId: input.proposalId,
    targetVersion: String(input.revisionNumber),
    beforeHash: input.beforeHash,
    afterHash: input.planHash,
    outcome: 'succeeded',
    details: {
      caseId: input.caseId,
      actionRevisionId: input.revisionId,
      planHash: input.planHash,
      policyRevision: input.policyRevision,
      status: input.status,
    },
  });
}

export interface ProposalEventClaim {
  readonly inboxId: string;
  readonly eventId: string;
  readonly sandboxId: string;
  readonly eventType: string;
  readonly correlationId: string;
  readonly envelope: Record<string, unknown>;
}

export interface ProposalEventStore {
  claimPendingProposalEvent(): Promise<ProposalEventClaim | null>;
  completeProposalEvent(inboxId: string): Promise<void>;
  failProposalEvent(inboxId: string): Promise<void>;
}

export interface ProposalStoreBundle
  extends ProposalStore,
    ProposalInvalidationStore,
    ProposalEventStore {}

export function createActionProposalStore(db: NexusDb): ProposalStoreBundle {
  return {
    async getActiveSandbox() {
      const rows = await db
        .select({
          id: sandboxes.id,
          name: sandboxes.name,
          status: sandboxes.status,
          businessEffectiveAt: sandboxes.businessEffectiveAt,
        })
        .from(activeSandbox)
        .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return SandboxSummarySchema.parse({
        id: row.id,
        name: row.name,
        status: row.status,
        businessEffectiveAt: iso(row.businessEffectiveAt),
      });
    },

    async getCaseForAction(
      sandboxId: string,
      caseId: string,
    ): Promise<ProposalCaseSnapshot | null> {
      const rows = await db
        .select({ id: cases.id, status: cases.status, version: cases.version })
        .from(cases)
        .where(and(eq(cases.sandboxId, sandboxId), eq(cases.id, caseId)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        status: CaseStatusSchema.parse(row.status),
        version: row.version,
      };
    },

    async getEvidenceForAction(
      sandboxId: string,
      evidenceIds: readonly string[],
    ): Promise<Evidence[]> {
      if (evidenceIds.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.sandboxId, sandboxId),
            inArray(evidence.id, [...evidenceIds]),
          ),
        );
      return rows.map((row) =>
        EvidenceSchema.parse({
          id: row.id,
          sandboxId: row.sandboxId,
          caseId: row.caseId,
          kind: row.kind,
          sourceRef:
            row.sourceSystem &&
            row.sourceType &&
            row.sourceId &&
            row.sourceVersion !== null
              ? {
                  system: row.sourceSystem,
                  type: row.sourceType,
                  id: row.sourceId,
                  version: row.sourceVersion,
                }
              : null,
          sourceStatus: row.sourceStatus,
          missingReason: row.missingReason,
          contentHash: row.contentHash,
          locator: row.locator,
          capturedFacts: row.capturedFacts,
          capturedAt: iso(row.capturedAt),
        }),
      );
    },

    async registerPolicyBundle(input: PolicyBundleRegistration): Promise<void> {
      const inserted = await db
        .insert(policyBundles)
        .values({
          revision: input.bundle.revision,
          schemaVersion: input.bundle.schemaVersion,
          bundle: input.bundle as unknown as Record<string, unknown>,
          contentHash: input.contentHash,
          canonicalTextPath: input.canonicalTextPath,
          canonicalTextHash: input.canonicalTextHash,
          status: 'active',
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing({ target: policyBundles.revision })
        .returning({ revision: policyBundles.revision });
      if (inserted.length > 0) {
        return;
      }
      const rows = await db
        .select({
          contentHash: policyBundles.contentHash,
          canonicalTextPath: policyBundles.canonicalTextPath,
          canonicalTextHash: policyBundles.canonicalTextHash,
        })
        .from(policyBundles)
        .where(eq(policyBundles.revision, input.bundle.revision))
        .limit(1);
      const existing = rows[0];
      if (
        !existing ||
        existing.contentHash !== input.contentHash ||
        existing.canonicalTextPath !== input.canonicalTextPath ||
        existing.canonicalTextHash !== input.canonicalTextHash
      ) {
        throw new PolicyValidationError(
          'POLICY_REVISION_CONFLICT',
          'Policy revision content changed without a new revision',
        );
      }
    },

    async findIdempotentProposal(input: {
      readonly sandboxId: string;
      readonly route: string;
      readonly idempotencyKey: string;
      readonly actor: CreateProposalStoreInput['actor'];
    }): Promise<{ readonly requestHash: string; readonly detail: ActionProposalDetail } | null> {
      const rows = await db
        .select()
        .from(actionProposalIdempotency)
        .where(
          and(
            eq(actionProposalIdempotency.sandboxId, input.sandboxId),
            eq(actionProposalIdempotency.actorKind, input.actor.kind),
            eq(actionProposalIdempotency.actorId, input.actor.id),
            eq(actionProposalIdempotency.route, input.route),
            eq(actionProposalIdempotency.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row
        ? {
            requestHash: row.requestHash,
            detail: ActionProposalDetailSchema.parse(row.response),
          }
        : null;
    },

    async createProposal(
      input: CreateProposalStoreInput,
    ): Promise<ProposalCreateStoreResult> {
      try {
        return await db.transaction(async (tx) => {
          const sandbox = await resolveActiveSandbox(tx);
          if (!('id' in sandbox)) {
            return { status: sandbox.status };
          }
          if (sandbox.id !== input.sandboxId) {
            return { status: 'sandbox_inactive' };
          }
          await lock(
            tx,
            `${input.sandboxId}:${input.route}:${input.actor.kind}:${input.actor.id}:${input.idempotencyKey}`,
          );
          const existingRows = await tx
            .select()
            .from(actionProposalIdempotency)
            .where(
              and(
                eq(actionProposalIdempotency.sandboxId, input.sandboxId),
                eq(actionProposalIdempotency.actorKind, input.actor.kind),
                eq(actionProposalIdempotency.actorId, input.actor.id),
                eq(actionProposalIdempotency.route, input.route),
                eq(actionProposalIdempotency.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          if (existing) {
            if (existing.requestHash !== input.requestHash) {
              return { status: 'idempotency_conflict' };
            }
            return {
              status: 'duplicate',
              detail: ActionProposalDetailSchema.parse(existing.response),
            };
          }
          const caseRows = await tx
            .select({ id: cases.id })
            .from(cases)
            .where(
              and(
                eq(cases.sandboxId, input.sandboxId),
                eq(cases.id, input.caseId),
              ),
            )
            .for('share')
            .limit(1);
          if (!caseRows[0]) {
            return { status: 'case_not_found' };
          }
          await tx.insert(actionProposals).values({
            id: input.proposalId,
            sandboxId: input.sandboxId,
            caseId: input.caseId,
            currentRevisionId: null,
            status: 'pending_approval',
            hasProcurement: input.isProcurement,
            createdByKind: input.actor.kind,
            createdById: input.actor.id,
            version: 0,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await tx.insert(actionRevisions).values({
            id: input.revisionId,
            sandboxId: input.sandboxId,
            proposalId: input.proposalId,
            revisionNumber: 1,
            state: 'pending_approval',
            planHash: input.planHash,
            items: [...input.items],
            requiredRoles: [...input.requiredRoles],
            aggregateImpactMinor:
              input.aggregateImpactMinor === null
                ? null
                : Number(input.aggregateImpactMinor),
            isProcurement: input.isProcurement,
            policyRevision: input.policyRevision,
            policyContentHash: input.policyContentHash,
            rationale: input.rationale,
            authoredByKind: input.actor.kind,
            authoredById: input.actor.id,
            authoredByRoles: input.actor.roles,
            expiresAt: sql`clock_timestamp() + (${input.ttlHours} * interval '1 hour')`,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await insertEvidenceLinks(
            tx,
            input.sandboxId,
            input.revisionId,
            input.items,
          );
          await tx
            .update(actionProposals)
            .set({
              currentRevisionId: input.revisionId,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(actionProposals.id, input.proposalId));
          await appendProposalAudit(tx, {
            sandboxId: input.sandboxId,
            actor: input.actor,
            requestId: input.requestId,
            correlationId: input.correlationId,
            action: 'action.proposal_created',
            caseId: input.caseId,
            proposalId: input.proposalId,
            revisionId: input.revisionId,
            revisionNumber: 1,
            planHash: input.planHash,
            policyRevision: input.policyRevision,
            beforeHash: null,
            status: 'pending_approval',
          });
          const detail = await loadProposalDetail(
            tx,
            input.sandboxId,
            input.proposalId,
          );
          if (!detail) {
            throw new Error('Proposal insert returned no detail');
          }
          await tx.insert(actionProposalIdempotency).values({
            sandboxId: input.sandboxId,
            actorKind: input.actor.kind,
            actorId: input.actor.id,
            route: input.route,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            proposalId: input.proposalId,
            response: detail as unknown as Record<string, unknown>,
            createdAt: sql`clock_timestamp()`,
          });
          return { status: 'created', detail };
        });
      } catch (error) {
        if (uniqueViolation(error)?.includes('action_proposals_open_procurement_key')) {
          return { status: 'open_procurement_conflict' };
        }
        throw error;
      }
    },

    async getProposal(
      sandboxId: string,
      proposalId: string,
    ): Promise<ActionProposalDetail | null> {
      const proposalRows = await db
        .select()
        .from(actionProposals)
        .where(
          and(
            eq(actionProposals.sandboxId, sandboxId),
            eq(actionProposals.id, proposalId),
          ),
        )
        .limit(1);
      const proposal = proposalRows[0];
      if (!proposal || !proposal.currentRevisionId) {
        return null;
      }
      const revisionRows = await db
        .select()
        .from(actionRevisions)
        .where(
          and(
            eq(actionRevisions.sandboxId, sandboxId),
            eq(actionRevisions.id, proposal.currentRevisionId),
          ),
        )
        .limit(1);
      const revision = revisionRows[0];
      return revision ? detailFromRows(proposal, revision) : null;
    },

    async listProposals(
      sandboxId: string,
      caseId: string,
      limit: number,
      cursor: ProposalListCursor | null,
    ): Promise<{ readonly items: ActionProposalDetail[]; readonly hasMore: boolean }> {
      const conditions = [
        eq(actionProposals.sandboxId, sandboxId),
        eq(actionProposals.caseId, caseId),
      ];
      if (cursor) {
        conditions.push(
          sql`(${actionProposals.createdAt}, ${actionProposals.id}) < (${new Date(cursor.createdAt)}, ${cursor.id})`,
        );
      }
      const rows = await db
        .select()
        .from(actionProposals)
        .where(and(...conditions))
        .orderBy(sql`${actionProposals.createdAt} DESC`, sql`${actionProposals.id} DESC`)
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const items: ActionProposalDetail[] = [];
      for (const proposal of page) {
        if (!proposal.currentRevisionId) {
          continue;
        }
        const revisionRows = await db
          .select()
          .from(actionRevisions)
          .where(
            and(
              eq(actionRevisions.sandboxId, sandboxId),
              eq(actionRevisions.id, proposal.currentRevisionId),
            ),
          )
          .limit(1);
        const revision = revisionRows[0];
        if (revision) {
          items.push(detailFromRows(proposal, revision));
        }
      }
      return {
        items,
        hasMore: rows.length > limit,
      };
    },

    async reviseProposal(
      input: ReviseProposalStoreInput,
    ): Promise<ProposalReviseStoreResult> {
      try {
        return await db.transaction(async (tx) => {
          const sandbox = await resolveActiveSandbox(tx);
          if (!('id' in sandbox)) {
            return { status: sandbox.status };
          }
          if (sandbox.id !== input.sandboxId) {
            return { status: 'sandbox_inactive' };
          }
          const proposalRows = await tx
            .select()
            .from(actionProposals)
            .where(
              and(
                eq(actionProposals.sandboxId, input.sandboxId),
                eq(actionProposals.id, input.proposalId),
              ),
            )
            .for('update')
            .limit(1);
          const proposal = proposalRows[0];
          if (!proposal || !proposal.currentRevisionId) {
            return { status: 'not_found' };
          }
          if (!isOpenStatus(proposal.status)) {
            return { status: 'stale' };
          }
          const revisionRows = await tx
            .select()
            .from(actionRevisions)
            .where(
              and(
                eq(actionRevisions.sandboxId, input.sandboxId),
                eq(actionRevisions.id, proposal.currentRevisionId),
              ),
            )
            .for('update')
            .limit(1);
          const current = revisionRows[0];
          if (
            !current ||
            !isOpenStatus(current.state) ||
            current.revisionNumber !== input.expectedRevisionNumber
          ) {
            return { status: 'stale' };
          }
          const nextNumber = current.revisionNumber + 1;
          await tx
            .update(actionRevisions)
            .set({
              state: 'superseded',
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(actionRevisions.id, current.id));
          await tx
            .update(approvalDecisions)
            .set({
              state: 'superseded',
              supersededAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(approvalDecisions.sandboxId, input.sandboxId),
                eq(approvalDecisions.actionRevisionId, current.id),
                eq(approvalDecisions.state, 'active'),
              ),
            );
          await tx.insert(actionRevisions).values({
            id: input.revisionId,
            sandboxId: input.sandboxId,
            proposalId: input.proposalId,
            revisionNumber: nextNumber,
            state: 'pending_approval',
            planHash: input.planHash,
            items: [...input.items],
            requiredRoles: [...input.requiredRoles],
            aggregateImpactMinor:
              input.aggregateImpactMinor === null
                ? null
                : Number(input.aggregateImpactMinor),
            isProcurement: input.isProcurement,
            policyRevision: input.policyRevision,
            policyContentHash: input.policyContentHash,
            rationale: input.rationale,
            authoredByKind: input.actor.kind,
            authoredById: input.actor.id,
            authoredByRoles: input.actor.roles,
            expiresAt: sql`clock_timestamp() + (${input.ttlHours} * interval '1 hour')`,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await insertEvidenceLinks(
            tx,
            input.sandboxId,
            input.revisionId,
            input.items,
          );
          await tx
            .update(actionProposals)
            .set({
              currentRevisionId: input.revisionId,
              status: 'pending_approval',
              hasProcurement: input.isProcurement,
              version: sql`${actionProposals.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(actionProposals.id, input.proposalId));
          await tx
            .update(workflowRuns)
            .set({
              waitReason: sql`jsonb_set(
                jsonb_set(
                  coalesce(${workflowRuns.waitReason}, '{}'::jsonb),
                  '{proposalId}',
                  to_jsonb(${input.proposalId}::text)
                ),
                '{actionRevisionId}',
                to_jsonb(${input.revisionId}::text)
              )`,
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(workflowRuns.sandboxId, input.sandboxId),
                eq(workflowRuns.caseId, proposal.caseId),
                eq(workflowRuns.status, 'waiting_approval'),
                sql`${workflowRuns.waitReason}->>'proposalId' = ${input.proposalId}`,
                sql`${workflowRuns.waitReason}->>'actionRevisionId' = ${current.id}`,
              ),
            );
          await appendProposalAudit(tx, {
            sandboxId: input.sandboxId,
            actor: input.actor,
            requestId: input.requestId,
            correlationId: input.correlationId,
            action: 'action.proposal_revised',
            caseId: proposal.caseId,
            proposalId: input.proposalId,
            revisionId: input.revisionId,
            revisionNumber: nextNumber,
            planHash: input.planHash,
            policyRevision: input.policyRevision,
            beforeHash: current.planHash,
            status: 'pending_approval',
          });
          const detail = await loadProposalDetail(
            tx,
            input.sandboxId,
            input.proposalId,
          );
          if (!detail) {
            throw new Error('Proposal revision returned no detail');
          }
          return { status: 'revised', detail };
        });
      } catch (error) {
        const constraint = uniqueViolation(error);
        if (constraint?.includes('action_proposals_open_procurement_key')) {
          return { status: 'open_procurement_conflict' };
        }
        if (constraint?.includes('action_revisions_proposal_number_key')) {
          return { status: 'stale' };
        }
        throw error;
      }
    },

    async hasProvenOwnExecution(input: {
      readonly sandboxId: string;
      readonly actionRevisionId: string;
      readonly entityRef: { readonly type: string; readonly id: string };
      readonly originatingRevisionId: string | null;
      readonly itemId?: string;
      readonly receiptKey?: string;
    }): Promise<boolean> {
      if (input.originatingRevisionId !== input.actionRevisionId) {
        return false;
      }
      const rows = await db
        .select({ id: actionExecutionEntityChanges.entityId })
        .from(actionExecutionEntityChanges)
        .innerJoin(
          actionExecutionReceipts,
          and(
            eq(actionExecutionReceipts.sandboxId, actionExecutionEntityChanges.sandboxId),
            eq(actionExecutionReceipts.id, actionExecutionEntityChanges.receiptId),
          ),
        )
        .innerJoin(
          actionExecutions,
          and(
            eq(actionExecutions.sandboxId, actionExecutionReceipts.sandboxId),
            eq(actionExecutions.id, actionExecutionReceipts.executionId),
          ),
        )
        .where(
          and(
            eq(actionExecutionEntityChanges.sandboxId, input.sandboxId),
            eq(actionExecutionEntityChanges.entityType, input.entityRef.type),
            eq(actionExecutionEntityChanges.entityId, input.entityRef.id),
            eq(actionExecutions.actionRevisionId, input.actionRevisionId),
            eq(actionExecutions.state, 'succeeded'),
            ...(input.itemId === undefined
              ? []
              : [eq(actionExecutionReceipts.itemId, input.itemId)]),
            ...(input.receiptKey === undefined
              ? []
              : [eq(actionExecutionReceipts.receiptKey, input.receiptKey)]),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async listOpenProposalRevisions(
      sandboxId: string,
    ): Promise<OpenProposalRevision[]> {
      const rows = await db
        .select({
          proposalId: actionProposals.id,
          revisionId: actionRevisions.id,
          revisionNumber: actionRevisions.revisionNumber,
          planHash: actionRevisions.planHash,
          items: actionRevisions.items,
        })
        .from(actionProposals)
        .innerJoin(
          actionRevisions,
          and(
            eq(actionRevisions.sandboxId, actionProposals.sandboxId),
            eq(actionRevisions.id, actionProposals.currentRevisionId),
          ),
        )
        .where(
          and(
            eq(actionProposals.sandboxId, sandboxId),
            inArray(actionProposals.status, ['draft', 'pending_approval', 'approved']),
            inArray(actionRevisions.state, ['draft', 'pending_approval', 'approved']),
          ),
        );
      return rows.map((row) => ({
        proposalId: row.proposalId,
        revisionId: row.revisionId,
        revisionNumber: row.revisionNumber,
        planHash: row.planHash,
        items: actionItems(row.items),
      }));
    },

    async expireProposalRevision(
      input: ExpireProposalRevisionInput,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const proposalRows = await tx
          .select()
          .from(actionProposals)
          .where(
            and(
              eq(actionProposals.sandboxId, input.sandboxId),
              eq(actionProposals.id, input.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const proposal = proposalRows[0];
        if (
          !proposal ||
          proposal.currentRevisionId !== input.revisionId ||
          !isOpenStatus(proposal.status)
        ) {
          return false;
        }
        const revisionRows = await tx
          .select()
          .from(actionRevisions)
          .where(
            and(
              eq(actionRevisions.sandboxId, input.sandboxId),
              eq(actionRevisions.id, input.revisionId),
            ),
          )
          .for('update')
          .limit(1);
        const revision = revisionRows[0];
        if (!revision || !isOpenStatus(revision.state)) {
          return false;
        }
        await tx
          .update(actionRevisions)
          .set({ state: 'expired', updatedAt: sql`clock_timestamp()` })
          .where(eq(actionRevisions.id, input.revisionId));
        const waitingRuns = await tx
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.sandboxId, input.sandboxId),
              eq(workflowRuns.caseId, proposal.caseId),
              eq(workflowRuns.status, 'waiting_approval'),
              sql`${workflowRuns.waitReason}->>'proposalId' = ${input.proposalId}`,
              sql`${workflowRuns.waitReason}->>'actionRevisionId' = ${input.revisionId}`,
            ),
          )
          .for('update');
        for (const run of waitingRuns) {
          await tx
            .update(workflowRuns)
            .set({
              status: 'waiting_input',
              waitReason: {
                kind: 'human_input',
                prompt:
                  'Proposal expired after an external change. Provide new analysis input.',
              },
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowRuns.id, run.id));
          try {
            await applyCaseTransition(tx, {
              sandboxId: input.sandboxId,
              caseId: proposal.caseId,
              runId: run.id,
              triggerEventId: run.triggerEventId,
              targetStatus: 'needs_input',
              reason: 'proposal_expired',
              correlationId: input.correlationId,
            });
          } catch (error) {
            if (!(error instanceof CaseWorkflowTransitionError)) {
              throw error;
            }
          }
        }
        await tx
          .update(approvalDecisions)
          .set({
            state: 'superseded',
            supersededAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(approvalDecisions.sandboxId, input.sandboxId),
              eq(approvalDecisions.actionRevisionId, input.revisionId),
              eq(approvalDecisions.state, 'active'),
            ),
          );
        await tx
          .update(actionProposals)
          .set({
            status: 'expired',
            version: sql`${actionProposals.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionProposals.id, input.proposalId));
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId.slice(0, 128),
          correlationId: input.correlationId.slice(0, 128),
          actor: {
            kind: 'service',
            id: 'proposal-invalidation',
            roles: [],
          },
          runId: null,
          action: 'action.proposal_invalidated',
          targetType: 'action_proposal',
          targetId: input.proposalId,
          targetVersion: String(revision.revisionNumber),
          beforeHash: revision.planHash,
          afterHash: revision.planHash,
          outcome: 'succeeded',
          details: {
            caseId: proposal.caseId,
            actionRevisionId: input.revisionId,
            planHash: revision.planHash,
            policyRevision: revision.policyRevision,
            status: 'expired',
            reasonCode: 'external_change',
            entityType: input.entityRef.type,
            entityId: input.entityRef.id,
            entityVersion: input.entityRef.version,
            contentHash: canonicalJsonSha256(input.changedFields),
          },
        });
        return true;
      });
    },

    async claimPendingProposalEvent(): Promise<ProposalEventClaim | null> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(eventInbox)
          .where(
            and(
              eq(eventInbox.consumerName, CONSUMER_NAME),
              inArray(eventInbox.eventType, [...PROPOSAL_EVENT_TYPES]),
              or(
                eq(eventInbox.dispatchState, 'pending'),
                and(
                  eq(eventInbox.dispatchState, 'scheduled'),
                  sql`${eventInbox.updatedAt} < clock_timestamp() - interval '60 seconds'`,
                ),
              ),
            ),
          )
          .orderBy(eventInbox.receivedAt, eventInbox.id)
          .for('update', { skipLocked: true })
          .limit(1);
        const inbox = rows[0];
        if (!inbox) {
          return null;
        }
        await tx
          .update(eventInbox)
          .set({
            dispatchState: 'scheduled',
            attemptCount: sql`${eventInbox.attemptCount} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(eventInbox.id, inbox.id));
        return {
          inboxId: inbox.id,
          eventId: inbox.eventId,
          sandboxId: inbox.sandboxId,
          eventType: inbox.eventType,
          correlationId: inbox.correlationId,
          envelope: inbox.envelope,
        };
      });
    },

    async completeProposalEvent(inboxId: string): Promise<void> {
      await db
        .update(eventInbox)
        .set({
          dispatchState: 'processed',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(eventInbox.id, inboxId));
    },

    async failProposalEvent(inboxId: string): Promise<void> {
      await db
        .update(eventInbox)
        .set({
          dispatchState: 'dead',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(eventInbox.id, inboxId));
    },
  };
}

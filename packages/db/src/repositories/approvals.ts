import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ActionRevisionRequestResponseSchema,
  ApprovalDecisionResultSchema,
  ApprovalDecisionSchema,
  ApprovalQueueItemSchema,
  NoActionResponseSchema,
  RoleSchema,
  type ActionRevisionRequestKind,
  type ActionRevisionRequestResponse,
  type Actor,
  type ApprovalDecision,
  type ApprovalDecisionResult,
  type ApprovalQueueItem,
  type NoActionResponse,
  type Role,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type {
  ApprovalCursor,
  ApprovalStateSnapshot,
  ApprovalStore,
  CommandReplay,
  CommandReplayInput,
  DecisionStoreResult,
  RecordDecisionInput,
} from '@nexus/application/actions/decisions';
import type {
  RecordRevisionRequestInput,
  RevisionRequestStore,
  RevisionRequestStoreResult,
} from '@nexus/application/actions/clarification';
import type {
  NoActionResultStore,
  NoActionStoreResult,
  ResolveNoActionInput,
} from '@nexus/application/cases/no-action';
import type { NexusDb } from '../connection.js';
import { actionProposals, actionRevisions } from '../schema/actions.js';
import {
  actionCommandIdempotency,
  actionRevisionRequests,
  approvalDecisions,
  caseResolutions,
} from '../schema/approvals.js';
import { cases } from '../schema/cases.js';
import { userRoles } from '../schema/identity.js';
import {
  workflowJobs,
  workflowRuns,
  workflowSteps,
} from '../schema/workflows.js';
import { workflowDependencies } from '../schema/workflow-dependencies.js';
import { appendAuditInTransaction } from './audit.js';
import {
  createActionProposalStore,
  detailFromRows,
  loadProposalDetail,
  resolveActiveSandbox,
  uniqueViolation,
} from './actions.js';
import {
  CaseWorkflowTransitionError,
  applyCaseTransition,
} from './workflow-case.js';
import { appendTraceEventInTransaction } from './trace.js';
import type { DbTransaction } from './types.js';

const ROLE_ORDER: readonly Role[] = ['approver_ops', 'approver_finance'];
const ACTIVE_RUN_STATES = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_dependency',
  'blocked',
  'budget_exhausted',
  'cancel_requested',
] as const;

function iso(value: Date): string {
  return value.toISOString();
}

function sortedRoles(values: readonly Role[]): Role[] {
  return ROLE_ORDER.filter((role) => values.includes(role));
}

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function decisionFromRow(
  row: typeof approvalDecisions.$inferSelect,
): ApprovalDecision {
  return ApprovalDecisionSchema.parse({
    id: row.id,
    proposalId: row.proposalId,
    actionRevisionId: row.actionRevisionId,
    planHash: row.planHash,
    decision: row.decision,
    role: row.role,
    requiredRoles: RoleSchema.array().parse(row.requiredRoles),
    state: row.state,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      roles: RoleSchema.array().parse(row.actorRoles),
    },
    reason: row.reason,
    expiresAt: iso(row.expiresAt),
    decidedAt: iso(row.decidedAt),
  });
}

function requestFromRow(
  row: typeof actionRevisionRequests.$inferSelect,
): ActionRevisionRequestResponse['request'] {
  return {
    id: row.id,
    proposalId: row.proposalId,
    actionRevisionId: row.actionRevisionId,
    planHash: row.planHash,
    kind: row.kind as ActionRevisionRequestKind,
    state: row.state as 'recorded' | 'completed' | 'superseded',
    actor: {
      kind: row.actorKind as Actor['kind'],
      id: row.actorId,
      roles: RoleSchema.array().parse(row.actorRoles),
    },
    reason: row.reason,
    waitRunId: row.waitRunId,
    createdAt: iso(row.createdAt),
  };
}

async function findReplayDb(
  db: NexusDb | DbTransaction,
  input: CommandReplayInput,
): Promise<CommandReplay | null> {
  const rows = await db
    .select()
    .from(actionCommandIdempotency)
    .where(
      and(
        eq(actionCommandIdempotency.sandboxId, input.sandboxId),
        eq(actionCommandIdempotency.actorKind, input.actor.kind),
        eq(actionCommandIdempotency.actorId, input.actor.id),
        eq(actionCommandIdempotency.route, input.route),
        eq(actionCommandIdempotency.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { requestHash: row.requestHash, response: row.response } : null;
}

async function insertReplay(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly actor: Actor;
    readonly route: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly response: unknown;
  },
): Promise<void> {
  await tx.insert(actionCommandIdempotency).values({
    sandboxId: input.sandboxId,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    route: input.route,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    response: input.response as Record<string, unknown>,
    createdAt: sql`clock_timestamp()`,
  });
}

async function actorRolesFromDb(
  tx: DbTransaction,
  actor: Actor,
): Promise<Role[]> {
  const rows = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, actor.id));
  return RoleSchema.array().parse(rows.map((row) => row.role));
}

async function activeDecisions(
  tx: NexusDb | DbTransaction,
  sandboxId: string,
  revisionId: string,
): Promise<Array<typeof approvalDecisions.$inferSelect>> {
  return tx
    .select()
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.sandboxId, sandboxId),
        eq(approvalDecisions.actionRevisionId, revisionId),
        eq(approvalDecisions.state, 'active'),
      ),
    )
    .orderBy(approvalDecisions.decidedAt);
}

function filledFromRows(
  decisions: Array<typeof approvalDecisions.$inferSelect>,
): Role[] {
  const roles = decisions
    .filter((row) => row.decision === 'approve')
    .map((row) => RoleSchema.parse(row.role));
  return sortedRoles(roles);
}

async function supersedeDecisions(
  tx: DbTransaction,
  sandboxId: string,
  revisionId: string,
  onlyApprovals = false,
): Promise<void> {
  await tx
    .update(approvalDecisions)
    .set({
      state: 'superseded',
      supersededAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(approvalDecisions.sandboxId, sandboxId),
        eq(approvalDecisions.actionRevisionId, revisionId),
        eq(approvalDecisions.state, 'active'),
        ...(onlyApprovals ? [eq(approvalDecisions.decision, 'approve')] : []),
      ),
    );
}

async function expireProposalAtDecision(
  tx: DbTransaction,
  proposal: typeof actionProposals.$inferSelect,
  revision: typeof actionRevisions.$inferSelect,
  actor: Actor,
  requestId: string,
  correlationId: string,
): Promise<void> {
  await tx
    .update(actionRevisions)
    .set({ state: 'expired', updatedAt: sql`clock_timestamp()` })
    .where(eq(actionRevisions.id, revision.id));
  await tx
    .update(actionProposals)
    .set({
      status: 'expired',
      version: sql`${actionProposals.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(actionProposals.id, proposal.id));
  await supersedeDecisions(tx, proposal.sandboxId, revision.id);
  await appendAuditInTransaction(tx, {
    sandboxId: proposal.sandboxId,
    requestId,
    correlationId,
    actor,
    runId: null,
    action: 'action.proposal_expired',
    targetType: 'action_proposal',
    targetId: proposal.id,
    targetVersion: String(revision.revisionNumber),
    beforeHash: revision.planHash,
    afterHash: revision.planHash,
    outcome: 'denied',
    details: {
      caseId: proposal.caseId,
      actionRevisionId: revision.id,
      planHash: revision.planHash,
      policyRevision: revision.policyRevision,
      status: 'expired',
      reasonCode: 'approval_expired',
    },
  });
  await moveWaitingRunsToHumanInput(
    tx,
    proposal,
    revision,
    'Approval expired. Provide new analysis input.',
    correlationId,
  );
}

async function resetWaitingSteps(
  tx: DbTransaction,
  runId: string,
): Promise<void> {
  await tx
    .update(workflowSteps)
    .set({
      status: 'pending',
      errorClass: null,
      version: sql`${workflowSteps.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(eq(workflowSteps.runId, runId), eq(workflowSteps.status, 'waiting')),
    );
}

async function ensurePendingJob(
  tx: DbTransaction,
  run: typeof workflowRuns.$inferSelect,
): Promise<void> {
  const active = await tx
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(
      and(
        eq(workflowJobs.runId, run.id),
        inArray(workflowJobs.state, ['pending', 'leased']),
      ),
    )
    .limit(1);
  if (active[0]) {
    return;
  }
  await tx.insert(workflowJobs).values({
    id: randomUUID(),
    sandboxId: run.sandboxId,
    runId: run.id,
    state: 'pending',
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    attemptCount: 0,
    availableAt: sql`clock_timestamp()`,
    lastError: null,
    version: 0,
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  });
}

async function resumeApprovalWaiters(
  tx: DbTransaction,
  proposal: typeof actionProposals.$inferSelect,
  revision: typeof actionRevisions.$inferSelect,
  actor: Actor,
  requestId: string,
  correlationId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.sandboxId, proposal.sandboxId),
        eq(workflowRuns.caseId, proposal.caseId),
        eq(workflowRuns.status, 'waiting_approval'),
        sql`${workflowRuns.waitReason}->>'proposalId' = ${proposal.id}`,
        sql`${workflowRuns.waitReason}->>'actionRevisionId' = ${revision.id}`,
      ),
    )
    .for('update');
  for (const run of rows) {
    await tx
      .update(workflowRuns)
      .set({
        status: 'queued',
        waitReason: null,
        resumeCause: 'approval_completed',
        lastError: null,
        version: sql`${workflowRuns.version} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowRuns.id, run.id));
    await resetWaitingSteps(tx, run.id);
    await ensurePendingJob(tx, run);
    await applyCaseTransition(tx, {
      sandboxId: proposal.sandboxId,
      caseId: proposal.caseId,
      runId: run.id,
      triggerEventId: run.triggerEventId,
      targetStatus: 'investigating',
      reason: 'workflow_resumed',
      correlationId,
    });
    await appendAuditInTransaction(tx, {
      sandboxId: proposal.sandboxId,
      requestId,
      correlationId,
      actor,
      runId: run.id,
      action: 'workflow.resumed',
      targetType: 'workflow_run',
      targetId: run.id,
      targetVersion: String(run.version + 1),
      beforeHash: null,
      afterHash: null,
      outcome: 'succeeded',
      details: {
        status: 'queued',
        action: 'workflow.resumed',
        outcome: 'succeeded',
      },
    });
    await appendTraceEventInTransaction(tx, {
      sandboxId: proposal.sandboxId,
      runId: run.id,
      level: 'info',
      event: 'workflow.run.resumed',
      data: { status: 'queued', attempt: 0 },
    });
  }
}

async function moveWaitingRunsToHumanInput(
  tx: DbTransaction,
  proposal: typeof actionProposals.$inferSelect,
  revision: typeof actionRevisions.$inferSelect,
  prompt: string,
  correlationId: string,
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.sandboxId, proposal.sandboxId),
        eq(workflowRuns.caseId, proposal.caseId),
        eq(workflowRuns.status, 'waiting_approval'),
        sql`${workflowRuns.waitReason}->>'proposalId' = ${proposal.id}`,
        sql`${workflowRuns.waitReason}->>'actionRevisionId' = ${revision.id}`,
      ),
    )
    .for('update');
  let waitRunId: string | null = null;
  for (const run of rows) {
    waitRunId = run.id;
    await tx
      .update(workflowRuns)
      .set({
        status: 'waiting_input',
        waitReason: {
          kind: 'human_input',
          prompt: prompt.slice(0, 2000),
        },
        resumeCause: null,
        version: sql`${workflowRuns.version} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowRuns.id, run.id));
    try {
      await applyCaseTransition(tx, {
        sandboxId: proposal.sandboxId,
        caseId: proposal.caseId,
        runId: run.id,
        triggerEventId: run.triggerEventId,
        targetStatus: 'needs_input',
        reason: 'human_input_requested',
        correlationId,
      });
    } catch (error) {
      if (!(error instanceof CaseWorkflowTransitionError)) {
        throw error;
      }
    }
    await appendTraceEventInTransaction(tx, {
      sandboxId: proposal.sandboxId,
      runId: run.id,
      level: 'info',
      event: 'workflow.run.waiting_input',
      data: { status: 'waiting_input' },
    });
  }
  return waitRunId;
}

async function cancelRunForNoAction(
  tx: DbTransaction,
  run: typeof workflowRuns.$inferSelect,
): Promise<void> {
  await tx
    .update(workflowRuns)
    .set({
      status: 'cancelled',
      waitReason: null,
      cancelCause: 'operator_request',
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowRuns.id, run.id));
  await tx
    .update(workflowJobs)
    .set({
      state: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: 'no_action',
      version: sql`${workflowJobs.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowJobs.runId, run.id),
        inArray(workflowJobs.state, ['pending', 'leased']),
      ),
    );
  await tx
    .update(workflowSteps)
    .set({
      status: 'cancelled',
      errorClass: 'no_action',
      version: sql`${workflowSteps.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowSteps.runId, run.id),
        inArray(workflowSteps.status, ['pending', 'running', 'waiting']),
      ),
    );
  await tx
    .update(workflowDependencies)
    .set({
      state: 'cancelled',
      resolvedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowDependencies.parentRunId, run.id),
        eq(workflowDependencies.state, 'waiting'),
      ),
    );
  await appendTraceEventInTransaction(tx, {
    sandboxId: run.sandboxId,
    runId: run.id,
    level: 'warn',
    event: 'workflow.run.cancelled',
    data: { status: 'cancelled', errorClass: 'no_action' },
  });
}

export interface ApprovalStoreBundle
  extends ApprovalStore,
    RevisionRequestStore,
    NoActionResultStore {}

export function createApprovalStore(db: NexusDb): ApprovalStoreBundle {
  return {
    async getActiveSandbox() {
      return createActionProposalStore(db).getActiveSandbox();
    },

    async findCommandReplay(input: CommandReplayInput): Promise<CommandReplay | null> {
      return findReplayDb(db, input);
    },

    async getApprovalState(
      sandboxId: string,
      proposalId: string,
    ): Promise<ApprovalStateSnapshot | null> {
      const detail = await loadProposalDetail(db, sandboxId, proposalId);
      if (!detail) {
        return null;
      }
      const rows = await db
        .select()
        .from(approvalDecisions)
        .where(
          and(
            eq(approvalDecisions.sandboxId, sandboxId),
            eq(approvalDecisions.actionRevisionId, detail.revision.id),
            eq(approvalDecisions.state, 'active'),
          ),
        )
        .orderBy(approvalDecisions.decidedAt);
      const filled = filledFromRows(rows);
      const required = sortedRoles(detail.revision.requiredRoles);
      return {
        proposal: detail,
        decisions: rows.map(decisionFromRow),
        filledRoles: filled,
        missingRoles: required.filter((role) => !filled.includes(role)),
        expiresAt: detail.revision.expiresAt,
      };
    },

    async listApprovalQueue(input: {
      readonly sandboxId: string;
      readonly actor: Actor;
      readonly limit: number;
      readonly cursor: ApprovalCursor | null;
    }): Promise<{
      readonly items: ApprovalQueueItem[];
      readonly hasMore: boolean;
      readonly lastCursor: ApprovalCursor | null;
    }> {
      const conditions = [
        eq(actionProposals.sandboxId, input.sandboxId),
        eq(actionProposals.status, 'pending_approval'),
        eq(actionRevisions.state, 'pending_approval'),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${actionRevisions.requiredRoles}) AS required_role
          WHERE required_role = ANY(ARRAY[${sql.join(
            input.actor.roles.map((role) => sql`${role}`),
            sql`, `,
          )}]::text[])
          AND NOT EXISTS (
            SELECT 1 FROM nexus.approval_decisions AS filled_decision
            WHERE filled_decision.sandbox_id = ${actionProposals.sandboxId}
              AND filled_decision.action_revision_id = ${actionRevisions.id}
              AND filled_decision.decision = 'approve'
              AND filled_decision.state = 'active'
              AND filled_decision.role = required_role
          )
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM nexus.approval_decisions AS own_decision
          WHERE own_decision.sandbox_id = ${actionProposals.sandboxId}
            AND own_decision.action_revision_id = ${actionRevisions.id}
            AND own_decision.actor_id = ${input.actor.id}
            AND own_decision.decision = 'approve'
            AND own_decision.state = 'active'
        )`,
      ];
      if (input.cursor) {
        conditions.push(
          sql`(${actionProposals.sequence}, ${actionProposals.id}) < (${input.cursor.sequence}, ${input.cursor.id})`,
        );
      }
      const rows = await db
        .select({ proposal: actionProposals, revision: actionRevisions })
        .from(actionProposals)
        .innerJoin(
          actionRevisions,
          and(
            eq(actionRevisions.sandboxId, actionProposals.sandboxId),
            eq(actionRevisions.id, actionProposals.currentRevisionId),
          ),
        )
        .where(and(...conditions))
        .orderBy(sql`${actionProposals.sequence} DESC`, sql`${actionProposals.id} DESC`)
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const items: ApprovalQueueItem[] = [];
      for (const row of page) {
        const decisions = await activeDecisions(db, input.sandboxId, row.revision.id);
        const filled = filledFromRows(decisions);
        const required = sortedRoles(RoleSchema.array().parse(row.revision.requiredRoles));
        const missing = required.filter((role) => !filled.includes(role));
        if (missing.length === 0 || !missing.some((role) => input.actor.roles.includes(role))) {
          continue;
        }
        const detail = detailFromRows(row.proposal, row.revision);
        items.push(
          ApprovalQueueItemSchema.parse({
            proposal: detail.proposal,
            revision: detail.revision,
            filledRoles: filled,
            missingRoles: missing,
          }),
        );
      }
      const lastRaw = page.at(-1);
      return {
        items,
        hasMore: rows.length > input.limit,
        lastCursor: lastRaw
          ? { sequence: lastRaw.proposal.sequence, id: lastRaw.proposal.id }
          : null,
      };
    },

    async recordDecision(input: RecordDecisionInput): Promise<DecisionStoreResult> {
      try {
        return await db.transaction(async (tx) => {
          const sandbox = await resolveActiveSandbox(tx);
          if (!('id' in sandbox) || sandbox.id !== input.sandboxId) {
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
          }
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.sandboxId}:${input.decision}:${input.actor.kind}:${input.actor.id}:${input.idempotencyKey}`}, 0))`,
          );
          const replay = await findReplayDb(tx, {
            sandboxId: input.sandboxId,
            actor: input.actor,
            route:
              input.decision === 'approve'
                ? '/api/v1/proposals/:proposalId/approve'
                : '/api/v1/proposals/:proposalId/reject',
            idempotencyKey: input.idempotencyKey,
          });
          if (replay) {
            if (replay.requestHash !== input.requestHash) {
              return { ok: false, code: 'IDEMPOTENCY_MISMATCH' };
            }
            return {
              ok: true,
              result: ApprovalDecisionResultSchema.parse(replay.response),
            };
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
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
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
          const revision = revisionRows[0];
          if (!revision) {
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
          }
          if (revision.id !== input.request.actionRevisionId) {
            return { ok: false, code: 'REVISION_MISMATCH' };
          }
          if (revision.planHash !== input.request.planHash) {
            return { ok: false, code: 'PLAN_HASH_MISMATCH' };
          }
          if (proposal.status !== 'pending_approval' || revision.state !== 'pending_approval') {
            return { ok: false, code: 'PROPOSAL_NOT_PENDING' };
          }
          const nowRows = asRows<{ now: Date }>(
            await tx.execute(sql`SELECT clock_timestamp() AS now`),
          );
          const now = nowRows[0]?.now;
          if (!now) {
            throw new Error('Database clock unavailable');
          }
          if (new Date(revision.expiresAt).getTime() <= new Date(now as unknown as string).getTime()) {
            await expireProposalAtDecision(
              tx,
              proposal,
              revision,
              input.actor,
              input.requestId,
              input.correlationId,
            );
            return { ok: false, code: 'APPROVAL_EXPIRED' };
          }
          const actorRoles = await actorRolesFromDb(tx, input.actor);
          if (actorRoles.length === 0) {
            return { ok: false, code: 'ROLE_NOT_ELIGIBLE' };
          }
          if (
            revision.authoredByKind === 'human' &&
            revision.authoredById === input.actor.id
          ) {
            return { ok: false, code: 'SELF_APPROVAL' };
          }
          const decisions = await activeDecisions(tx, input.sandboxId, revision.id);
          if (decisions.some((row) => row.decision === 'reject')) {
            return { ok: false, code: 'PROPOSAL_NOT_PENDING' };
          }
          if (
            decisions.some(
              (row) => row.decision === 'approve' && row.actorId === input.actor.id,
            )
          ) {
            return { ok: false, code: 'ACTOR_ALREADY_DECIDED' };
          }
          const required = sortedRoles(RoleSchema.array().parse(revision.requiredRoles));
          if (required.length === 0) {
            return { ok: false, code: 'NO_HUMAN_APPROVAL_REQUIRED' };
          }
          if (
            decisions.some((row) => {
              const stored = RoleSchema.array().parse(row.requiredRoles);
              return (
                stored.length !== required.length ||
                required.some((role) => !stored.includes(role))
              );
            })
          ) {
            return { ok: false, code: 'DECISION_CONFLICT' };
          }
          const filled = filledFromRows(decisions);
          const missing = required.filter((role) => !filled.includes(role));
          if (missing.length === 0) {
            return { ok: false, code: 'DECISION_CONFLICT' };
          }
          const eligible = missing.filter((role) => actorRoles.includes(role));
          if (eligible.length === 0) {
            return { ok: false, code: 'ROLE_NOT_ELIGIBLE' };
          }
          const role = eligible[0] as Role;
          const insertedRows = await tx
            .insert(approvalDecisions)
            .values({
              id: randomUUID(),
              sandboxId: input.sandboxId,
              proposalId: proposal.id,
              actionRevisionId: revision.id,
              planHash: revision.planHash,
              decision: input.decision,
              role,
              requiredRoles: required,
              state: 'active',
              actorKind: input.actor.kind,
              actorId: input.actor.id,
              actorRoles,
              reason: input.request.reason,
              expiresAt: revision.expiresAt,
              decidedAt: sql`clock_timestamp()`,
              supersededAt: null,
            })
            .returning();
          const decisionRow = insertedRows[0];
          if (!decisionRow) {
            throw new Error('Approval decision insert returned no row');
          }
          let newFilled = filled;
          let newMissing: Role[];
          if (input.decision === 'reject') {
            await supersedeDecisions(tx, input.sandboxId, revision.id, true);
            await tx
              .update(actionRevisions)
              .set({ state: 'rejected', updatedAt: sql`clock_timestamp()` })
              .where(eq(actionRevisions.id, revision.id));
            await tx
              .update(actionProposals)
              .set({
                status: 'rejected',
                version: sql`${actionProposals.version} + 1`,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(actionProposals.id, proposal.id));
            await appendAuditInTransaction(tx, {
              sandboxId: input.sandboxId,
              requestId: input.requestId,
              correlationId: input.correlationId,
              actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
              runId: null,
              action: 'action.proposal_rejected',
              targetType: 'action_proposal',
              targetId: proposal.id,
              targetVersion: String(revision.revisionNumber),
              beforeHash: revision.planHash,
              afterHash: revision.planHash,
              outcome: 'succeeded',
              details: {
                caseId: proposal.caseId,
                actionRevisionId: revision.id,
                planHash: revision.planHash,
                policyRevision: revision.policyRevision,
                status: 'rejected',
                decision: 'reject',
                role,
                contentHash: canonicalJsonSha256({ reason: input.request.reason }),
              },
            });
            newMissing = [];
            await moveWaitingRunsToHumanInput(
              tx,
              proposal,
              revision,
              'Plan was rejected. Provide new analysis input.',
              input.correlationId,
            );
          } else {
            newFilled = sortedRoles([...filled, role]);
            newMissing = required.filter((item) => !newFilled.includes(item));
            if (newMissing.length === 0) {
              await tx
                .update(actionRevisions)
                .set({ state: 'approved', updatedAt: sql`clock_timestamp()` })
                .where(eq(actionRevisions.id, revision.id));
              await tx
                .update(actionProposals)
                .set({
                  status: 'approved',
                  version: sql`${actionProposals.version} + 1`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(eq(actionProposals.id, proposal.id));
              await appendAuditInTransaction(tx, {
                sandboxId: input.sandboxId,
                requestId: input.requestId,
                correlationId: input.correlationId,
                actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
                runId: null,
                action: 'action.proposal_approved',
                targetType: 'action_proposal',
                targetId: proposal.id,
                targetVersion: String(revision.revisionNumber),
                beforeHash: revision.planHash,
                afterHash: revision.planHash,
                outcome: 'succeeded',
                details: {
                  caseId: proposal.caseId,
                  actionRevisionId: revision.id,
                  planHash: revision.planHash,
                  policyRevision: revision.policyRevision,
                  status: 'approved',
                  decision: 'approve',
                  role,
                },
              });
              await resumeApprovalWaiters(
                tx,
                proposal,
                revision,
                { kind: 'human', id: input.actor.id, roles: actorRoles },
                input.requestId,
                input.correlationId,
              );
            } else {
              await appendAuditInTransaction(tx, {
                sandboxId: input.sandboxId,
                requestId: input.requestId,
                correlationId: input.correlationId,
                actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
                runId: null,
                action: 'action.proposal_approval_recorded',
                targetType: 'action_proposal',
                targetId: proposal.id,
                targetVersion: String(revision.revisionNumber),
                beforeHash: revision.planHash,
                afterHash: revision.planHash,
                outcome: 'succeeded',
                details: {
                  caseId: proposal.caseId,
                  actionRevisionId: revision.id,
                  planHash: revision.planHash,
                  policyRevision: revision.policyRevision,
                  status: 'pending_approval',
                  decision: 'approve',
                  role,
                },
              });
            }
          }
          const detail = await loadProposalDetail(tx, input.sandboxId, proposal.id);
          if (!detail) {
            throw new Error('Proposal detail missing after decision');
          }
          const result: ApprovalDecisionResult = ApprovalDecisionResultSchema.parse({
            proposal: detail,
            decision: decisionFromRow(decisionRow),
            filledRoles: newFilled,
            missingRoles: newMissing,
          });
          await insertReplay(tx, {
            sandboxId: input.sandboxId,
            actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
            route:
              input.decision === 'approve'
                ? '/api/v1/proposals/:proposalId/approve'
                : '/api/v1/proposals/:proposalId/reject',
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            resourceType: 'approval_decision',
            resourceId: decisionRow.id,
            response: result,
          });
          return { ok: true, result };
        });
      } catch (error) {
        const constraint = uniqueViolation(error);
        if (
          constraint?.includes('approval_decisions_active_role_key') ||
          constraint?.includes('approval_decisions_active_actor_key') ||
          constraint?.includes('approval_decisions_active_reject_key')
        ) {
          return { ok: false, code: 'DECISION_CONFLICT' };
        }
        throw error;
      }
    },

    async recordRevisionRequest(
      input: RecordRevisionRequestInput,
    ): Promise<RevisionRequestStoreResult> {
      try {
        return await db.transaction(async (tx) => {
          const sandbox = await resolveActiveSandbox(tx);
          if (!('id' in sandbox) || sandbox.id !== input.sandboxId) {
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
          }
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.sandboxId}:${input.kind}:${input.actor.kind}:${input.actor.id}:${input.idempotencyKey}`}, 0))`,
          );
          const route =
            input.kind === 'clarification'
              ? '/api/v1/proposals/:proposalId/clarification'
              : '/api/v1/proposals/:proposalId/reanalyse';
          const replay = await findReplayDb(tx, {
            sandboxId: input.sandboxId,
            actor: input.actor,
            route,
            idempotencyKey: input.idempotencyKey,
          });
          if (replay) {
            if (replay.requestHash !== input.requestHash) {
              return { ok: false, code: 'IDEMPOTENCY_MISMATCH' };
            }
            return {
              ok: true,
              response: ActionRevisionRequestResponseSchema.parse(replay.response),
            };
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
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
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
          const revision = revisionRows[0];
          if (!revision) {
            return { ok: false, code: 'PROPOSAL_NOT_FOUND' };
          }
          if (revision.id !== input.request.actionRevisionId) {
            return { ok: false, code: 'REVISION_MISMATCH' };
          }
          if (revision.planHash !== input.request.planHash) {
            return { ok: false, code: 'PLAN_HASH_MISMATCH' };
          }
          const nowRows = asRows<{ now: Date }>(
            await tx.execute(sql`SELECT clock_timestamp() AS now`),
          );
          const now = nowRows[0]?.now;
          if (!now) {
            throw new Error('Database clock unavailable');
          }
          if (new Date(revision.expiresAt).getTime() <= new Date(now as unknown as string).getTime()) {
            await expireProposalAtDecision(
              tx,
              proposal,
              revision,
              input.actor,
              input.requestId,
              input.correlationId,
            );
            return { ok: false, code: 'APPROVAL_EXPIRED' };
          }
          const allowed =
            input.kind === 'clarification'
              ? proposal.status === 'pending_approval' &&
                revision.state === 'pending_approval'
              : (proposal.status === 'pending_approval' || proposal.status === 'approved') &&
                (revision.state === 'pending_approval' || revision.state === 'approved');
          if (!allowed) {
            return { ok: false, code: 'REQUEST_NOT_ALLOWED' };
          }
          const actorRoles = await actorRolesFromDb(tx, input.actor);
          await supersedeDecisions(tx, input.sandboxId, revision.id);
          if (input.kind === 'reanalysis') {
            await tx
              .update(actionRevisions)
              .set({ state: 'superseded', updatedAt: sql`clock_timestamp()` })
              .where(eq(actionRevisions.id, revision.id));
            await tx
              .update(actionProposals)
              .set({
                status: 'superseded',
                version: sql`${actionProposals.version} + 1`,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(actionProposals.id, proposal.id));
          }
          const requestId = randomUUID();
          const waitRunId = await moveWaitingRunsToHumanInput(
            tx,
            proposal,
            revision,
            `${input.kind === 'clarification' ? 'Clarification' : 'Reanalysis'} requested: ${input.request.reason}`,
            input.correlationId,
          );
          await tx.insert(actionRevisionRequests).values({
            id: requestId,
            sandboxId: input.sandboxId,
            proposalId: proposal.id,
            actionRevisionId: revision.id,
            planHash: revision.planHash,
            kind: input.kind,
            state: 'recorded',
            actorKind: input.actor.kind,
            actorId: input.actor.id,
            actorRoles,
            reason: input.request.reason,
            waitRunId,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await appendAuditInTransaction(tx, {
            sandboxId: input.sandboxId,
            requestId: input.requestId,
            correlationId: input.correlationId,
            actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
            runId: waitRunId,
            action:
              input.kind === 'clarification'
                ? 'action.clarification_requested'
                : 'action.reanalysis_requested',
            targetType: 'action_proposal',
            targetId: proposal.id,
            targetVersion: String(revision.revisionNumber),
            beforeHash: revision.planHash,
            afterHash: revision.planHash,
            outcome: 'succeeded',
            details: {
              caseId: proposal.caseId,
              actionRevisionId: revision.id,
              planHash: revision.planHash,
              policyRevision: revision.policyRevision,
              status: input.kind === 'reanalysis' ? 'superseded' : 'pending_approval',
              reasonCode: input.kind,
              contentHash: canonicalJsonSha256({ reason: input.request.reason }),
            },
          });
          const detail = await loadProposalDetail(tx, input.sandboxId, proposal.id);
          if (!detail) {
            throw new Error('Proposal detail missing after revision request');
          }
          const requestRows = await tx
            .select()
            .from(actionRevisionRequests)
            .where(eq(actionRevisionRequests.id, requestId))
            .limit(1);
          const requestRow = requestRows[0];
          if (!requestRow) {
            throw new Error('Revision request missing after insert');
          }
          const response = ActionRevisionRequestResponseSchema.parse({
            request: requestFromRow(requestRow),
            proposal: detail,
          });
          await insertReplay(tx, {
            sandboxId: input.sandboxId,
            actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
            route,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            resourceType: 'action_revision_request',
            resourceId: requestId,
            response,
          });
          return { ok: true, response };
        });
      } catch (error) {
        const constraint = uniqueViolation(error);
        if (constraint?.includes('action_revision_requests_active_kind_key')) {
          return { ok: false, code: 'REQUEST_CONFLICT' };
        }
        throw error;
      }
    },

    async listOpenRevisionIds(sandboxId: string, caseId: string) {
      const caseRows = await db
        .select({ id: cases.id, status: cases.status })
        .from(cases)
        .where(and(eq(cases.sandboxId, sandboxId), eq(cases.id, caseId)))
        .limit(1);
      const current = caseRows[0];
      if (!current) {
        return null;
      }
      const rows = await db
        .select({ revisionId: actionProposals.currentRevisionId })
        .from(actionProposals)
        .where(
          and(
            eq(actionProposals.sandboxId, sandboxId),
            eq(actionProposals.caseId, caseId),
            inArray(actionProposals.status, ['draft', 'pending_approval', 'approved']),
          ),
        );
      return {
        caseStatus: current.status,
        revisionIds: rows
          .map((row) => row.revisionId)
          .filter((value): value is string => typeof value === 'string'),
      };
    },

    async resolveNoAction(input: ResolveNoActionInput): Promise<NoActionStoreResult> {
      return db.transaction(async (tx) => {
        const sandbox = await resolveActiveSandbox(tx);
        if (!('id' in sandbox) || sandbox.id !== input.sandboxId) {
          return { ok: false, code: 'CASE_NOT_FOUND' };
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.sandboxId}:no-action:${input.actor.kind}:${input.actor.id}:${input.idempotencyKey}`}, 0))`,
        );
        const route = '/api/v1/cases/:caseId/resolve-no-action';
        const replay = await findReplayDb(tx, {
          sandboxId: input.sandboxId,
          actor: input.actor,
          route,
          idempotencyKey: input.idempotencyKey,
        });
        if (replay) {
          if (replay.requestHash !== input.requestHash) {
            return { ok: false, code: 'IDEMPOTENCY_MISMATCH' };
          }
          return { ok: true, response: NoActionResponseSchema.parse(replay.response) };
        }
        const initialCaseRows = await tx
          .select()
          .from(cases)
          .where(
            and(eq(cases.sandboxId, input.sandboxId), eq(cases.id, input.caseId)),
          )
          .limit(1);
        const initialCase = initialCaseRows[0];
        if (!initialCase) {
          return { ok: false, code: 'CASE_NOT_FOUND' };
        }
        if (
          initialCase.status === 'resolved' ||
          initialCase.status === 'escalated' ||
          initialCase.status === 'cancelled'
        ) {
          return { ok: false, code: 'CASE_TERMINAL' };
        }
        const actorRoles = await actorRolesFromDb(tx, input.actor);
        const proposalRows = await tx
          .select()
          .from(actionProposals)
          .where(
            and(
              eq(actionProposals.sandboxId, input.sandboxId),
              eq(actionProposals.caseId, input.caseId),
              inArray(actionProposals.status, ['draft', 'pending_approval', 'approved']),
            ),
          )
          .orderBy(actionProposals.id)
          .for('update');
        const revisions: Array<typeof actionRevisions.$inferSelect> = [];
        const proposalsToSupersede: Array<typeof actionProposals.$inferSelect> = [];
        for (const proposal of proposalRows) {
          if (!proposal.currentRevisionId) {
            continue;
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
          const revision = revisionRows[0];
          if (revision) {
            proposalsToSupersede.push(proposal);
            revisions.push(revision);
          }
        }
        const runRows = await tx
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.sandboxId, input.sandboxId),
              eq(workflowRuns.caseId, input.caseId),
              inArray(workflowRuns.status, [...ACTIVE_RUN_STATES]),
            ),
          )
          .orderBy(workflowRuns.createdAt)
          .for('update');
        if (runRows.length === 0) {
          return { ok: false, code: 'NO_ACTIVE_RUN' };
        }
        const caseRows = await tx
          .select()
          .from(cases)
          .where(
            and(eq(cases.sandboxId, input.sandboxId), eq(cases.id, input.caseId)),
          )
          .for('update')
          .limit(1);
        const currentCase = caseRows[0];
        if (!currentCase) {
          return { ok: false, code: 'CASE_NOT_FOUND' };
        }
        if (
          currentCase.status === 'resolved' ||
          currentCase.status === 'escalated' ||
          currentCase.status === 'cancelled'
        ) {
          return { ok: false, code: 'CASE_TERMINAL' };
        }
        for (let index = 0; index < proposalsToSupersede.length; index += 1) {
          const proposal = proposalsToSupersede[index];
          const revision = revisions[index];
          if (!proposal || !revision) {
            continue;
          }
          await supersedeDecisions(tx, input.sandboxId, revision.id);
          await tx
            .update(actionRevisions)
            .set({ state: 'superseded', updatedAt: sql`clock_timestamp()` })
            .where(eq(actionRevisions.id, revision.id));
          await tx
            .update(actionProposals)
            .set({
              status: 'superseded',
              version: sql`${actionProposals.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(actionProposals.id, proposal.id));
        }
        for (const run of runRows) {
          await cancelRunForNoAction(tx, run);
        }
        const terminalRun = runRows[runRows.length - 1];
        if (!terminalRun) {
          return { ok: false, code: 'NO_ACTIVE_RUN' };
        }
        const transition = await applyCaseTransition(tx, {
          sandboxId: input.sandboxId,
          caseId: input.caseId,
          runId: terminalRun.id,
          triggerEventId: terminalRun.triggerEventId,
          targetStatus: 'resolved',
          reason: 'no_action',
          correlationId: input.correlationId,
        });
        const caseVersion = transition.version;
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId,
          correlationId: input.correlationId,
          actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
          runId: terminalRun.id,
          action: 'case.no_action',
          targetType: 'case',
          targetId: input.caseId,
          targetVersion: String(caseVersion),
          beforeHash: null,
          afterHash: null,
          outcome: 'succeeded',
          details: {
            caseId: input.caseId,
            caseStatus: 'resolved',
            caseVersion,
            status: 'resolved',
            reasonCode: 'no_action',
            contentHash: canonicalJsonSha256({ reason: input.reason }),
          },
        });
        const resolvedAtRows = asRows<{ now: Date }>(
          await tx.execute(sql`SELECT clock_timestamp() AS now`),
        );
        const resolvedAt = resolvedAtRows[0]?.now;
        if (!resolvedAt) {
          throw new Error('Database clock unavailable');
        }
        await tx.insert(caseResolutions).values({
          id: randomUUID(),
          sandboxId: input.sandboxId,
          caseId: input.caseId,
          caseVersion,
          kind: 'no_action',
          reason: input.reason,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
          actorRoles,
          resolvedAt: sql`clock_timestamp()`,
        });
        const response: NoActionResponse = NoActionResponseSchema.parse({
          caseId: input.caseId,
          caseVersion,
          status: 'resolved',
          reason: input.reason,
          actor: { kind: input.actor.kind, id: input.actor.id, roles: actorRoles },
          resolvedAt: new Date(resolvedAt as unknown as string).toISOString(),
        });
        await insertReplay(tx, {
          sandboxId: input.sandboxId,
          actor: { kind: 'human', id: input.actor.id, roles: actorRoles },
          route,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          resourceType: 'case_resolution',
          resourceId: input.caseId,
          response,
        });
        return { ok: true, response };
      });
    },
  };
}

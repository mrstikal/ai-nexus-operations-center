import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  ActionPlanItemSchema,
  RoleSchema,
  type EntityRef,
  type Role,
} from '@nexus/contracts';
import type {
  ActionExecutionStore,
  ClaimedExecution,
  CommandFailureInput,
  CommandSuccessInput,
  ExecutionCandidate,
  NoteSuccessInput,
} from '@nexus/application/actions/executor';
import type { ActionExecutionSnapshot } from '@nexus/application/actions/preflight';
import type { NexusDb } from '../connection.js';
import { actionProposals, actionRevisions } from '../schema/actions.js';
import { actionRevisionEvidence } from '../schema/actions.js';
import { approvalDecisions } from '../schema/approvals.js';
import { cases } from '../schema/cases.js';
import { userRoles } from '../schema/identity.js';
import { evidence } from '../schema/evidence.js';
import {
  actionExecutionAttempts,
  actionExecutionEntityChanges,
  actionExecutionReceipts,
  actionExecutions,
  caseNotes,
} from '../schema/executions.js';
import { appendAuditInTransaction } from './audit.js';
import { loadProposalDetail, resolveActiveSandbox } from './actions.js';
import { appendTraceEventInTransaction } from './trace.js';
import type { DbTransaction } from './types.js';

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

interface CandidateRow {
  sandbox_id: string;
  case_id: string;
  proposal_id: string;
  revision_id: string;
}

async function loadReferences(
  db: NexusDb | DbTransaction,
  sandboxId: string,
  revisionId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      capturedFacts: evidence.capturedFacts,
    })
    .from(actionRevisionEvidence)
    .innerJoin(
      evidence,
      and(
        eq(evidence.sandboxId, actionRevisionEvidence.sandboxId),
        eq(evidence.id, actionRevisionEvidence.evidenceId),
      ),
    )
    .where(
      and(
        eq(actionRevisionEvidence.sandboxId, sandboxId),
        eq(actionRevisionEvidence.revisionId, revisionId),
      ),
    );
  const references: Record<string, string> = {};
  for (const row of rows) {
    if (!row.sourceType || !row.sourceId || typeof row.capturedFacts !== 'object' || row.capturedFacts === null) {
      continue;
    }
    const facts = row.capturedFacts as Record<string, unknown>;
    const key = `${row.sourceType}:${row.sourceId}`;
    if (typeof facts['reference'] === 'string') {
      references[key] = facts['reference'];
    }
    if (typeof facts['references'] === 'object' && facts['references'] !== null) {
      for (const [referenceKey, value] of Object.entries(
        facts['references'] as Record<string, unknown>,
      )) {
        if (typeof value === 'string') {
          references[referenceKey] = value;
        }
      }
    }
  }
  return references;
}

async function activeRoles(
  db: NexusDb | DbTransaction,
  sandboxId: string,
  revisionId: string,
): Promise<Role[]> {
  const rows = await db
    .select({ role: approvalDecisions.role })
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.sandboxId, sandboxId),
        eq(approvalDecisions.actionRevisionId, revisionId),
        eq(approvalDecisions.decision, 'approve'),
        eq(approvalDecisions.state, 'active'),
      ),
    );
  return RoleSchema.array().parse(rows.map((row) => row.role));
}

async function executionMap(
  db: NexusDb | DbTransaction,
  sandboxId: string,
  revisionId: string,
): Promise<
  Array<{
    itemId: string;
    state: string;
    receiptKey: string | null;
    resultEntityType: string | null;
    resultEntityId: string | null;
    resultEntityVersion: number | null;
  }>
> {
  const rows = await db
    .select()
    .from(actionExecutions)
    .where(
      and(
        eq(actionExecutions.sandboxId, sandboxId),
        eq(actionExecutions.actionRevisionId, revisionId),
      ),
    );
  return rows.map((row) => ({
    itemId: row.itemId,
    state: row.state,
    receiptKey: row.receiptKey,
    resultEntityType: row.resultEntityType,
    resultEntityId: row.resultEntityId,
    resultEntityVersion: row.resultEntityVersion,
  }));
}

export interface ExecutionRuntimeStore extends ActionExecutionStore {
  getRevisionExecutionState(input: {
    readonly sandboxId: string;
    readonly actionRevisionId: string;
  }): Promise<'none' | 'started' | 'succeeded' | 'unknown'>;
  priorSuccessfulAdditionalProcurementMinor(input: {
    readonly sandboxId: string;
    readonly caseId: string;
  }): Promise<bigint>;
  hasProvenOwnExecution(input: {
    readonly sandboxId: string;
    readonly actionRevisionId: string;
    readonly entityRef: EntityRef;
    readonly originatingRevisionId: string | null;
    readonly itemId?: string;
    readonly receiptKey?: string;
  }): Promise<boolean>;
}

export function createExecutionStore(db: NexusDb): ExecutionRuntimeStore {
  return {
    async findCandidate(): Promise<ExecutionCandidate | null> {
      const result = await db.execute(sql`
        SELECT proposal.sandbox_id, proposal.case_id, proposal.id AS proposal_id,
               revision.id AS revision_id
        FROM nexus.action_proposals AS proposal
        JOIN nexus.action_revisions AS revision
          ON revision.sandbox_id = proposal.sandbox_id
         AND revision.id = proposal.current_revision_id
        JOIN nexus.cases AS case_row
          ON case_row.sandbox_id = proposal.sandbox_id
         AND case_row.id = proposal.case_id
        WHERE case_row.status NOT IN ('resolved', 'escalated', 'cancelled')
          AND proposal.sandbox_id = (SELECT sandbox_id FROM nexus.active_sandbox LIMIT 1)
          AND revision.expires_at > clock_timestamp()
          AND (
            (proposal.status = 'approved' AND revision.state = 'approved')
            OR (
              proposal.status = 'pending_approval'
              AND revision.state = 'pending_approval'
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(revision.items) AS item
                WHERE item->'payload'->>'kind' <> 'case.add_internal_note'
              )
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(revision.items) AS item
                WHERE item->'payload'->>'kind' = 'case.add_internal_note'
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM nexus.action_executions AS blocked
            WHERE blocked.sandbox_id = proposal.sandbox_id
              AND blocked.action_revision_id = revision.id
              AND blocked.state IN ('in_progress', 'retryable_failure', 'permanent_failure', 'unknown')
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(revision.items) AS item
            WHERE NOT EXISTS (
              SELECT 1 FROM nexus.action_executions AS execution
              WHERE execution.sandbox_id = proposal.sandbox_id
                AND execution.action_revision_id = revision.id
                AND execution.item_id = (item->>'itemId')::uuid
                AND execution.state = 'succeeded'
            )
          )
        ORDER BY proposal.sequence
        LIMIT 1
      `);
      const row = asRows<CandidateRow>(result)[0];
      return row
        ? {
            sandboxId: row.sandbox_id,
            caseId: row.case_id,
            proposalId: row.proposal_id,
            revisionId: row.revision_id,
          }
        : null;
    },

    async loadExecutionSnapshot(
      candidate: ExecutionCandidate,
    ): Promise<ActionExecutionSnapshot | null> {
      const detail = await loadProposalDetail(
        db,
        candidate.sandboxId,
        candidate.proposalId,
      );
      if (!detail || detail.revision.id !== candidate.revisionId) {
        return null;
      }
      const caseRows = await db
        .select({ status: cases.status })
        .from(cases)
        .where(
          and(
            eq(cases.sandboxId, candidate.sandboxId),
            eq(cases.id, detail.proposal.caseId),
          ),
        )
        .limit(1);
      const caseStatus = caseRows[0]?.status;
      if (!caseStatus) {
        return null;
      }
      const evidenceRows = await db
        .select({ status: evidence.sourceStatus })
        .from(actionRevisionEvidence)
        .innerJoin(
          evidence,
          and(
            eq(evidence.sandboxId, actionRevisionEvidence.sandboxId),
            eq(evidence.id, actionRevisionEvidence.evidenceId),
          ),
        )
        .where(
          and(
            eq(actionRevisionEvidence.sandboxId, candidate.sandboxId),
            eq(actionRevisionEvidence.revisionId, candidate.revisionId),
          ),
        );
      const evidenceAvailable = evidenceRows.every((row) => row.status === 'available');
      const filledRoles = await activeRoles(
        db,
        candidate.sandboxId,
        candidate.revisionId,
      );
      const executions = await executionMap(
        db,
        candidate.sandboxId,
        candidate.revisionId,
      );
      const nowResult = asRows<{ now: Date }>(
        await db.execute(sql`SELECT clock_timestamp() AS now`),
      );
      const now = nowResult[0]?.now;
      if (!now) {
        return null;
      }
      return {
        sandboxId: candidate.sandboxId,
        caseId: detail.proposal.caseId,
        proposalId: detail.proposal.id,
        proposalStatus: detail.proposal.status,
        revisionId: detail.revision.id,
        revisionState: detail.revision.state,
        revisionNumber: detail.revision.revisionNumber,
        items: detail.revision.items,
        planHash: detail.revision.planHash,
        requiredRoles: detail.revision.requiredRoles,
        filledRoles,
        policyRevision: detail.revision.policyRevision,
        policyContentHash: detail.revision.policyContentHash,
        expiresAt: detail.revision.expiresAt,
        now: new Date(now as unknown as string).toISOString(),
        executions,
        references: await loadReferences(db, candidate.sandboxId, candidate.revisionId),
        caseStatus,
        evidenceAvailable,
      };
    },

    async claimItem(input): Promise<ClaimedExecution | null> {
      return db.transaction(async (tx) => {
        const sandbox = await resolveActiveSandbox(tx);
        if (!('id' in sandbox) || sandbox.id !== input.candidate.sandboxId) {
          return null;
        }
        const proposalRows = await tx
          .select()
          .from(actionProposals)
          .where(
            and(
              eq(actionProposals.sandboxId, input.candidate.sandboxId),
              eq(actionProposals.id, input.candidate.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const proposal = proposalRows[0];
        if (!proposal || proposal.currentRevisionId !== input.candidate.revisionId) {
          return null;
        }
        const revisionRows = await tx
          .select()
          .from(actionRevisions)
          .where(
            and(
              eq(actionRevisions.sandboxId, input.candidate.sandboxId),
              eq(actionRevisions.id, input.candidate.revisionId),
            ),
          )
          .for('update')
          .limit(1);
        const revision = revisionRows[0];
        if (!revision) {
          return null;
        }
        const caseRows = await tx
          .select({ status: cases.status })
          .from(cases)
          .where(
            and(
              eq(cases.sandboxId, input.candidate.sandboxId),
              eq(cases.id, proposal.caseId),
            ),
          )
          .limit(1);
        const caseStatus = caseRows[0]?.status;
        if (
          !caseStatus ||
          caseStatus === 'resolved' ||
          caseStatus === 'escalated' ||
          caseStatus === 'cancelled' ||
          revision.policyRevision !== input.currentPolicyRevision ||
          revision.policyContentHash !== input.currentPolicyContentHash
        ) {
          return null;
        }
        const items = ActionPlanItemSchema.array().parse(revision.items);
        const item = items.find((entry) => entry.itemId === input.item.itemId);
        if (!item || item.payload.kind !== input.item.payload.kind) {
          return null;
        }
        const clock = asRows<{ now: Date }>(
          await tx.execute(sql`SELECT clock_timestamp() AS now`),
        )[0]?.now;
        const clockDate = clock
          ? new Date(clock as unknown as string)
          : null;
        if (
          !clockDate ||
          new Date(revision.expiresAt).getTime() <= clockDate.getTime() ||
          new Date(input.executeBefore).getTime() <= clockDate.getTime()
        ) {
          return null;
        }
        if (input.authorizationBasis === 'human') {
          if (proposal.status !== 'approved' || revision.state !== 'approved') {
            return null;
          }
          const roles = await activeRoles(
            tx,
            input.candidate.sandboxId,
            input.candidate.revisionId,
          );
          const required = RoleSchema.array().parse(revision.requiredRoles);
          if (required.some((role) => !roles.includes(role))) {
            return null;
          }
          const decisionRoles = await tx
            .select({
              actorId: approvalDecisions.actorId,
              role: approvalDecisions.role,
            })
            .from(approvalDecisions)
            .where(
              and(
                eq(approvalDecisions.sandboxId, input.candidate.sandboxId),
                eq(approvalDecisions.actionRevisionId, input.candidate.revisionId),
                eq(approvalDecisions.decision, 'approve'),
                eq(approvalDecisions.state, 'active'),
              ),
            );
          for (const decision of decisionRoles) {
            const current = await tx
              .select({ userId: userRoles.userId })
              .from(userRoles)
              .where(
                and(
                  eq(userRoles.userId, decision.actorId),
                  eq(userRoles.role, decision.role),
                ),
              )
              .limit(1);
            if (!current[0]) {
              return null;
            }
          }
        } else if (
          item.payload.kind !== 'case.add_internal_note' ||
          proposal.status !== 'pending_approval' ||
          revision.state !== 'pending_approval'
        ) {
          return null;
        }
        const executions = await tx
          .select()
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.sandboxId, input.candidate.sandboxId),
              eq(actionExecutions.actionRevisionId, input.candidate.revisionId),
            ),
          )
          .for('update');
        if (executions.some((execution) => execution.state === 'in_progress')) {
          return null;
        }
        const otherFailed = executions.some((execution) =>
          ['retryable_failure', 'permanent_failure', 'unknown'].includes(execution.state),
        );
        if (otherFailed) {
          return null;
        }
        const target = executions.find((execution) => execution.itemId === item.itemId);
        if (target && target.state !== 'pending') {
          return null;
        }
        for (const dependencyId of item.dependsOnItemIds) {
          const dependency = executions.find(
            (execution) => execution.itemId === dependencyId,
          );
          if (dependency?.state !== 'succeeded') {
            return null;
          }
        }
        if (!target) {
          await tx
            .insert(actionExecutions)
            .values({
              id: randomUUID(),
              sandboxId: input.candidate.sandboxId,
              caseId: proposal.caseId,
              proposalId: proposal.id,
              actionRevisionId: revision.id,
              itemId: item.itemId,
              commandKind: item.payload.kind,
              executionKey: `${input.candidate.sandboxId}:${revision.id}:${item.itemId}:${item.payload.kind}`,
              planHash: revision.planHash,
              itemHash: input.itemHash,
              state: 'pending',
              authorizationBasis: input.authorizationBasis,
              policyRevision: input.policyRevision,
              policyContentHash: input.policyContentHash,
              committedMinor:
                input.committedMinor === null ? null : Number(input.committedMinor),
              receiptKey: null,
              receiptId: null,
              resultEntityType: null,
              resultEntityId: null,
              resultEntityVersion: null,
              attemptCount: 0,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .onConflictDoNothing();
        }
        const executionRows = await tx
          .select()
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.sandboxId, input.candidate.sandboxId),
              eq(actionExecutions.actionRevisionId, input.candidate.revisionId),
              eq(actionExecutions.itemId, item.itemId),
            ),
          )
          .for('update')
          .limit(1);
        const execution = executionRows[0];
        if (
          !execution ||
          !['pending'].includes(execution.state) ||
          execution.state === 'succeeded'
        ) {
          return null;
        }
        const attemptNumber = execution.attemptCount + 1;
        const attemptId = randomUUID();
        await tx
          .update(actionExecutions)
          .set({
            state: 'in_progress',
            itemHash: input.itemHash,
            authorizationBasis: input.authorizationBasis,
            policyRevision: input.policyRevision,
            policyContentHash: input.policyContentHash,
            attemptCount: attemptNumber,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, execution.id));
        await tx.insert(actionExecutionAttempts).values({
          id: attemptId,
          sandboxId: input.candidate.sandboxId,
          executionId: execution.id,
          attemptNumber,
          state: 'in_progress',
          requestHash: input.requestHash,
          executeBefore: new Date(input.executeBefore),
          authorizationValidUntil: new Date(input.authorizationValidUntil),
          errorCode: null,
          receiptKey: null,
          startedAt: sql`clock_timestamp()`,
          finishedAt: null,
          createdAt: sql`clock_timestamp()`,
        });
        await appendAuditInTransaction(tx, {
          sandboxId: input.candidate.sandboxId,
          requestId: `action-start-${attemptId}`,
          correlationId: `action-${revision.id}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-executor', roles: [] },
          runId: null,
          action: 'action.execution_started',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(attemptNumber),
          beforeHash: revision.planHash,
          afterHash: revision.planHash,
          outcome: 'succeeded',
          details: {
            caseId: proposal.caseId,
            actionRevisionId: revision.id,
            planHash: revision.planHash,
            policyRevision: input.policyRevision,
            status: 'in_progress',
            reasonCode: input.authorizationBasis,
          },
        });
        return {
          sandboxId: input.candidate.sandboxId,
          caseId: proposal.caseId,
          proposalId: proposal.id,
          revisionId: revision.id,
          item,
          executionId: execution.id,
          attemptId,
          attemptNumber,
          authorizationBasis: input.authorizationBasis,
          policyRevision: input.policyRevision,
          policyContentHash: input.policyContentHash,
          planHash: revision.planHash,
          itemHash: input.itemHash,
          payload: input.payload,
          baseExpectedVersions: input.baseExpectedVersions,
          priorReceiptKeys: input.priorReceiptKeys,
          executeBefore: input.executeBefore,
          authorizationValidUntil: input.authorizationValidUntil,
          requestHash: input.requestHash,
        };
      });
    },

    async recordCommandSuccess(input: CommandSuccessInput): Promise<void> {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.id, input.claimed.executionId))
          .for('update')
          .limit(1);
        const execution = rows[0];
        if (!execution || execution.state === 'succeeded') {
          return;
        }
        const receipt = input.receipt;
        await tx
          .update(actionExecutions)
          .set({
            state: 'succeeded',
            receiptKey: receipt.idempotencyKey,
            receiptId: receipt.id,
            resultEntityType: receipt.result.entityType,
            resultEntityId: receipt.result.id,
            resultEntityVersion: receipt.result.version,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, execution.id));
        await tx
          .update(actionExecutionAttempts)
          .set({
            state: 'succeeded',
            receiptKey: receipt.idempotencyKey,
            finishedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutionAttempts.id, input.claimed.attemptId));
        await tx
          .insert(actionExecutionReceipts)
          .values({
            id: receipt.id,
            sandboxId: execution.sandboxId,
            executionId: execution.id,
            receiptKey: receipt.idempotencyKey,
            commandKind: receipt.commandKind,
            actionRevisionId: receipt.actionRevisionId,
            itemId: receipt.itemId,
            planHash: receipt.planHash,
            itemHash: receipt.itemHash,
            resultEntityType: receipt.result.entityType,
            resultEntityId: receipt.result.id,
            resultEntityVersion: receipt.result.version,
            receipt: receipt as unknown as Record<string, unknown>,
            createdAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing();
        for (const [ordinal, change] of receipt.entityChanges.entries()) {
          await tx
            .insert(actionExecutionEntityChanges)
            .values({
              sandboxId: execution.sandboxId,
              receiptId: receipt.id,
              ordinal,
              entityType: change.entityType,
              entityId: change.id,
              beforeVersion: change.beforeVersion,
              afterVersion: change.afterVersion,
            })
            .onConflictDoNothing();
        }
        await appendAuditInTransaction(tx, {
          sandboxId: execution.sandboxId,
          requestId: `action-success-${execution.id}`,
          correlationId: `action-${execution.actionRevisionId}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-executor', roles: [] },
          runId: null,
          action: 'action.execution_succeeded',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(execution.attemptCount),
          beforeHash: execution.planHash,
          afterHash: execution.planHash,
          outcome: 'succeeded',
          details: {
            caseId: execution.caseId,
            actionRevisionId: execution.actionRevisionId,
            planHash: execution.planHash,
            policyRevision: execution.policyRevision ?? '',
            status: 'succeeded',
            reasonCode: `receipt:${receipt.idempotencyKey}`,
          },
        });
        await appendTraceEventInTransaction(tx, {
          sandboxId: execution.sandboxId,
          runId: null,
          level: 'info',
          event: 'action.execution_succeeded',
          data: { status: 'succeeded' },
        });
      });
    },

    async recordCommandFailure(input: CommandFailureInput): Promise<void> {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(actionExecutions)
          .where(eq(actionExecutions.id, input.claimed.executionId))
          .for('update')
          .limit(1);
        const execution = rows[0];
        if (!execution || execution.state === 'succeeded') {
          return;
        }
        const state = input.unknown
          ? 'unknown'
          : input.permanent
            ? 'permanent_failure'
            : 'retryable_failure';
        await tx
          .update(actionExecutions)
          .set({ state, updatedAt: sql`clock_timestamp()` })
          .where(eq(actionExecutions.id, execution.id));
        await tx
          .update(actionExecutionAttempts)
          .set({
            state,
            errorCode: input.errorCode,
            finishedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutionAttempts.id, input.claimed.attemptId));
        await appendAuditInTransaction(tx, {
          sandboxId: execution.sandboxId,
          requestId: `action-failure-${execution.id}`,
          correlationId: `action-${execution.actionRevisionId}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-executor', roles: [] },
          runId: null,
          action: 'action.execution_failed',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(execution.attemptCount),
          beforeHash: execution.planHash,
          afterHash: execution.planHash,
          outcome: 'failed',
          details: {
            caseId: execution.caseId,
            actionRevisionId: execution.actionRevisionId,
            planHash: execution.planHash,
            policyRevision: execution.policyRevision ?? '',
            status: state,
            reasonCode: input.errorCode.slice(0, 100),
          },
        });
      });
    },

    async recordNoteSuccess(input: NoteSuccessInput): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(caseNotes)
          .values({
            id: randomUUID(),
            sandboxId: input.claimed.sandboxId,
            caseId: input.claimed.caseId,
            actionRevisionId: input.claimed.revisionId,
            itemId: input.claimed.item.itemId,
            text: input.text,
            authorizationBasis: 'policy_auto',
            policyRevision: input.policyRevision,
            policyContentHash: input.policyContentHash,
            createdAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing();
        await tx
          .update(actionExecutions)
          .set({
            state: 'succeeded',
            authorizationBasis: 'policy_auto',
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, input.claimed.executionId));
        await tx
          .update(actionExecutionAttempts)
          .set({ state: 'succeeded', finishedAt: sql`clock_timestamp()` })
          .where(eq(actionExecutionAttempts.id, input.claimed.attemptId));
        await appendAuditInTransaction(tx, {
          sandboxId: input.claimed.sandboxId,
          requestId: `action-note-${input.claimed.executionId}`,
          correlationId: `action-${input.claimed.revisionId}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-executor', roles: [] },
          runId: null,
          action: 'action.note_executed',
          targetType: 'action_execution',
          targetId: input.claimed.executionId,
          targetVersion: String(input.claimed.attemptNumber),
          beforeHash: input.claimed.planHash,
          afterHash: input.claimed.planHash,
          outcome: 'succeeded',
          details: {
            caseId: input.claimed.caseId,
            actionRevisionId: input.claimed.revisionId,
            planHash: input.claimed.planHash,
            policyRevision: input.policyRevision,
            policyContentHash: input.policyContentHash,
            status: 'succeeded',
            reasonCode: 'policy_auto',
          },
        });
      });
    },

    async blockUnavailableEvidence(candidate: ExecutionCandidate): Promise<void> {
      await db.transaction(async (tx) => {
        const proposalRows = await tx
          .select()
          .from(actionProposals)
          .where(
            and(
              eq(actionProposals.sandboxId, candidate.sandboxId),
              eq(actionProposals.id, candidate.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const proposal = proposalRows[0];
        if (!proposal || proposal.currentRevisionId !== candidate.revisionId) {
          return;
        }
        const revisionRows = await tx
          .select()
          .from(actionRevisions)
          .where(
            and(
              eq(actionRevisions.sandboxId, candidate.sandboxId),
              eq(actionRevisions.id, candidate.revisionId),
            ),
          )
          .for('update')
          .limit(1);
        const revision = revisionRows[0];
        if (!revision || !['approved', 'pending_approval'].includes(revision.state)) {
          return;
        }
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
        await tx
          .update(approvalDecisions)
          .set({
            state: 'superseded',
            supersededAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(approvalDecisions.sandboxId, candidate.sandboxId),
              eq(approvalDecisions.actionRevisionId, revision.id),
              eq(approvalDecisions.state, 'active'),
            ),
          );
        await appendAuditInTransaction(tx, {
          sandboxId: candidate.sandboxId,
          requestId: `action-evidence-${revision.id}`,
          correlationId: `action-evidence-${revision.id}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-executor', roles: [] },
          runId: null,
          action: 'action.proposal_invalidated',
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
            reasonCode: 'evidence_unavailable',
          },
        });
      });
    },

    async getRevisionExecutionState(input) {
      const rows = await db
        .select({ state: actionExecutions.state })
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.sandboxId, input.sandboxId),
            eq(actionExecutions.actionRevisionId, input.actionRevisionId),
          ),
        );
      if (rows.some((row) => row.state === 'unknown')) {
        return 'unknown';
      }
      if (rows.some((row) => row.state === 'succeeded')) {
        return 'succeeded';
      }
      if (rows.some((row) => row.state === 'in_progress')) {
        return 'started';
      }
      return 'none';
    },

    async priorSuccessfulAdditionalProcurementMinor(input) {
      const rows = await db
        .select({ committed: actionExecutions.committedMinor })
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.sandboxId, input.sandboxId),
            eq(actionExecutions.caseId, input.caseId),
            eq(actionExecutions.state, 'succeeded'),
          ),
        );
      return rows.reduce(
        (total, row) => total + BigInt(row.committed ?? 0),
        0n,
      );
    },

    async hasProvenOwnExecution(input) {
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
  };
}

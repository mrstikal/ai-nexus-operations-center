import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CaseCompletedPayloadSchema,
  type CaseStatus,
  type RunResumeCause,
  type RunResumeRequest,
  type WaitReason,
  type WorkflowStatus,
} from '@nexus/contracts';
import type {
  CancelRunStoreInput,
  CancellationStore,
} from '@nexus/application/workflows/cancellation';
import type {
  ControlStoreResult,
  ResumeRunStoreInput,
  ResumeStore,
  RunControlSnapshot,
} from '@nexus/application/workflows/resume';
import type { PartialEffect } from '@nexus/application/workflows/waits';
import type { NexusDb } from '../connection.js';
import { activeSandbox, cases, sandboxes } from '../schema/cases.js';
import { eventInbox } from '../schema/events.js';
import { workflowDependencies } from '../schema/workflow-dependencies.js';
import { actionExecutions } from '../schema/executions.js';
import { actionCaseCancellations } from '../schema/execution-attempts.js';
import {
  workflowJobs,
  workflowRuns,
  workflowSteps,
} from '../schema/workflows.js';
import { appendAuditInTransaction } from './audit.js';
import { appendTraceEventInTransaction } from './trace.js';
import { applyCaseTransition } from './workflow-case.js';
import type { DbTransaction } from './types.js';

const CONSUMER_NAME = 'nexus.worker.events.v1';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asWaitReason(value: unknown): WaitReason | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as WaitReason)
    : null;
}

function correlationOf(row: typeof workflowRuns.$inferSelect): string {
  const value = asRecord(row.ingress)['correlationId'];
  return typeof value === 'string' && value.length <= 128 ? value : row.id;
}

async function applyCaseStatus(
  tx: DbTransaction,
  run: typeof workflowRuns.$inferSelect,
  targetStatus: CaseStatus,
  reason: string,
): Promise<CaseStatus> {
  const result = await applyCaseTransition(tx, {
    sandboxId: run.sandboxId,
    caseId: run.caseId,
    runId: run.id,
    triggerEventId: run.triggerEventId,
    targetStatus,
    reason,
    correlationId: correlationOf(run),
  });
  return result.status;
}

async function resetWaitingStep(
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

async function cancelActiveJobs(
  tx: DbTransaction,
  runId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(workflowJobs)
    .set({
      state: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: reason.slice(0, 200),
      version: sql`${workflowJobs.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowJobs.runId, runId),
        inArray(workflowJobs.state, ['pending', 'leased']),
      ),
    );
}

async function resumeDependencyParent(
  tx: DbTransaction,
  parent: typeof workflowRuns.$inferSelect,
  cause: RunResumeCause,
  reason: string,
): Promise<void> {
  await tx
    .update(workflowRuns)
    .set({
      status: 'queued',
      waitReason: null,
      resumeCause: cause,
      lastError: null,
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowRuns.id, parent.id));
  await resetWaitingStep(tx, parent.id);
  await ensurePendingJob(tx, parent);
  await applyCaseStatus(tx, parent, 'investigating', reason);
  await appendTraceEventInTransaction(tx, {
    sandboxId: parent.sandboxId,
    runId: parent.id,
    level: 'info',
    event: 'workflow.run.resumed',
    data: { status: 'queued', caseStatus: 'investigating', attempt: 0 },
  });
}

async function escalateDependencyParent(
  tx: DbTransaction,
  parent: typeof workflowRuns.$inferSelect,
  reason: string,
  errorClass: string,
  cancelCause: 'dependency_failure' | 'dependency_timeout',
): Promise<void> {
  await tx
    .update(workflowRuns)
    .set({
      status: 'cancelled',
      waitReason: null,
      cancelCause,
      lastError: errorClass,
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowRuns.id, parent.id));
  await cancelActiveJobs(tx, parent.id, errorClass);
  await tx
    .update(workflowSteps)
    .set({
      status: 'cancelled',
      errorClass,
      version: sql`${workflowSteps.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowSteps.runId, parent.id),
        inArray(workflowSteps.status, ['pending', 'running', 'waiting']),
      ),
    );
  await applyCaseStatus(tx, parent, 'escalated', reason);
  await appendTraceEventInTransaction(tx, {
    sandboxId: parent.sandboxId,
    runId: parent.id,
    level: 'error',
    event: 'workflow.dependency.escalated',
    data: { status: 'cancelled', caseStatus: 'escalated', errorClass },
  });
}

function resumeMatches(
  status: WorkflowStatus,
  waitReason: WaitReason | null,
  request: RunResumeRequest,
): boolean {
  if (status === 'waiting_input') {
    return request.cause === 'human_input';
  }
  if (status === 'waiting_approval') {
    return (
      request.cause === 'approval_completed' &&
      waitReason?.kind === 'approval' &&
      waitReason.proposalId === request.proposalId &&
      waitReason.actionRevisionId === request.actionRevisionId
    );
  }
  return false;
}

function controlResponse(
  runId: string,
  status: WorkflowStatus,
  caseStatus: CaseStatus,
): ControlStoreResult {
  return {
    ok: true,
    response: {
      runId,
      status,
      caseStatus,
      deduplicated: false,
    },
  };
}


async function approvalWaitIsCurrent(
  tx: DbTransaction,
  sandboxId: string,
  proposalId: string,
  actionRevisionId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1
    FROM nexus.action_proposals AS proposal
    JOIN nexus.action_revisions AS revision
      ON revision.sandbox_id = proposal.sandbox_id
     AND revision.id = proposal.current_revision_id
    WHERE proposal.sandbox_id = ${sandboxId}
      AND proposal.id = ${proposalId}
      AND proposal.current_revision_id = ${actionRevisionId}
      AND proposal.status = 'approved'
      AND revision.state = 'approved'
      AND revision.id = ${actionRevisionId}
      AND revision.expires_at > clock_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(revision.required_roles) AS required_role
        WHERE NOT EXISTS (
          SELECT 1
          FROM nexus.approval_decisions AS decision
          WHERE decision.sandbox_id = proposal.sandbox_id
            AND decision.action_revision_id = revision.id
            AND decision.decision = 'approve'
            AND decision.state = 'active'
            AND decision.role = required_role
        )
      )
    LIMIT 1
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function completeCancelRequestedRuns(
  db: NexusDb,
  limit = 10,
): Promise<number> {
  let completed = 0;
  for (let index = 0; index < limit; index += 1) {
    const rows = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.status, 'cancel_requested'))
      .orderBy(workflowRuns.updatedAt)
      .limit(1);
    const candidate = rows[0];
    if (!candidate) {
      break;
    }
    const done = await db.transaction(async (tx) => {
      const runRows = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.sandboxId, candidate.sandboxId),
            eq(workflowRuns.id, candidate.id),
          ),
        )
        .for('update')
        .limit(1);
      const run = runRows[0];
      if (!run || run.status !== 'cancel_requested') {
        return false;
      }
      const executionRows = await tx
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.sandboxId, run.sandboxId),
            eq(actionExecutions.caseId, run.caseId),
          ),
        );
      if (
        executionRows.some((execution) =>
          ['in_progress', 'unknown'].includes(execution.state),
        )
      ) {
        return false;
      }
      const partialEffects: PartialEffect[] = executionRows
        .filter((execution) => execution.state === 'succeeded')
        .map((execution) => ({
          kind: 'succeeded',
          reference: execution.receiptKey ?? execution.itemId,
        }));
      for (const execution of executionRows) {
        if (execution.state === 'cancelled') {
          partialEffects.push({
            kind: 'cancelled',
            reference: execution.itemId,
          });
        }
      }
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
      await tx
        .update(workflowRuns)
        .set({
          status: 'cancelled',
          waitReason: null,
          partialEffects: partialEffects as unknown as PartialEffect[],
          lastError: run.cancelCause ?? 'cancel_requested',
          version: sql`${workflowRuns.version} + 1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(workflowRuns.id, run.id));
      await cancelActiveJobs(tx, run.id, run.cancelCause ?? 'cancel_requested');
      await tx
        .update(workflowSteps)
        .set({
          status: 'cancelled',
          errorClass: run.cancelCause ?? 'cancel_requested',
          version: sql`${workflowSteps.version} + 1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workflowSteps.runId, run.id),
            inArray(workflowSteps.status, ['pending', 'running', 'waiting']),
          ),
        );
      const caseRows = await tx
        .select({ status: cases.status })
        .from(cases)
        .where(
          and(eq(cases.sandboxId, run.sandboxId), eq(cases.id, run.caseId)),
        )
        .limit(1);
      const existingCaseStatus = caseRows[0]?.status as CaseStatus | undefined;
      const caseStatus =
        existingCaseStatus === 'resolved' ||
        existingCaseStatus === 'escalated' ||
        existingCaseStatus === 'cancelled'
          ? existingCaseStatus
          : await applyCaseStatus(
              tx,
              run,
              'cancelled',
              run.cancelCause ?? 'cancel_requested',
            );
      await appendAuditInTransaction(tx, {
        actor: { kind: 'service', id: 'action-reconciler', roles: [] },
        requestId: `cancel-complete-${run.id}`,
        correlationId: `cancel-${run.id}`.slice(0, 128),
        sandboxId: run.sandboxId,
        runId: run.id,
        targetType: 'workflow_run',
        targetId: run.id,
        targetVersion: String(run.version + 1),
        action: 'workflow.cancelled',
        beforeHash: null,
        afterHash: null,
        outcome: 'succeeded',
        details: {
          status: 'cancelled',
          action: 'workflow.cancelled',
          outcome: 'succeeded',
        },
      });
      await appendTraceEventInTransaction(tx, {
        sandboxId: run.sandboxId,
        runId: run.id,
        level: 'warn',
        event: 'workflow.run.cancelled',
        data: {
          status: 'cancelled',
          caseStatus,
          count: partialEffects.length,
          errorClass: run.cancelCause ?? 'cancel_requested',
        },
      });
      return true;
    });
    if (done) {
      completed += 1;
    } else {
      break;
    }
  }
  return completed;
}

export function createWorkflowControlStore(
  db: NexusDb,
): ResumeStore & CancellationStore & {
  getActiveSandboxId(): Promise<string | null>;
  processDependencyEvents(limit: number): Promise<number>;
  expireDependencies(limit: number): Promise<number>;
} {
  async function loadRun(
    tx: DbTransaction,
    sandboxId: string,
    runId: string,
  ): Promise<typeof workflowRuns.$inferSelect | null> {
    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.sandboxId, sandboxId),
          eq(workflowRuns.id, runId),
        ),
      )
      .for('update')
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async getActiveSandboxId(): Promise<string | null> {
      const rows = await db
        .select({ id: sandboxes.id })
        .from(activeSandbox)
        .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
        .where(eq(sandboxes.status, 'active'))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async getRunForControl(
      sandboxId,
      runId,
    ): Promise<RunControlSnapshot | null> {
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.sandboxId, sandboxId),
            eq(workflowRuns.id, runId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        runId: row.id,
        caseId: row.caseId,
        status: row.status as WorkflowStatus,
        waitReason: asWaitReason(row.waitReason),
      };
    },

    async resumeRun(input: ResumeRunStoreInput): Promise<ControlStoreResult> {
      return db.transaction(async (tx) => {
        const run = await loadRun(tx, input.sandboxId, input.runId);
        if (!run) {
          return { ok: false, code: 'RUN_NOT_FOUND' };
        }
        const status = run.status as WorkflowStatus;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          return { ok: false, code: 'RUN_TERMINAL' };
        }
        const waitReason = asWaitReason(run.waitReason);
        if (!resumeMatches(status, waitReason, input.request)) {
          return { ok: false, code: 'ILLEGAL_WAKE' };
        }
        if (
          input.request.cause === 'approval_completed' &&
          waitReason?.kind === 'approval'
        ) {
          const current = await approvalWaitIsCurrent(
            tx,
            run.sandboxId,
            waitReason.proposalId,
            waitReason.actionRevisionId,
          );
          if (!current) {
            return { ok: false, code: 'ILLEGAL_WAKE' };
          }
        }
        await tx
          .update(workflowRuns)
          .set({
            status: 'queued',
            waitReason: null,
            resumeCause: input.request.cause,
            lastError: null,
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, run.id));
        await resetWaitingStep(tx, run.id);
        await ensurePendingJob(tx, run);
        const caseStatus = await applyCaseStatus(
          tx,
          run,
          input.caseStatusAfter,
          'workflow_resumed',
        );
        await appendAuditInTransaction(tx, {
          actor: input.actor,
          requestId: input.requestId,
          correlationId: input.correlationId,
          sandboxId: run.sandboxId,
          runId: run.id,
          targetType: 'workflow_run',
          targetId: run.id,
          targetVersion: String(run.version + 1),
          action: 'workflow.resumed',
          beforeHash: null,
          afterHash: null,
          outcome: 'succeeded',
          details: { status: 'queued', action: 'workflow.resumed', outcome: 'succeeded' },
        });
        await appendTraceEventInTransaction(tx, {
          sandboxId: run.sandboxId,
          runId: run.id,
          level: 'info',
          event: 'workflow.run.resumed',
          data: { status: 'queued', attempt: 0 },
        });
        return controlResponse(run.id, 'queued', caseStatus);
      });
    },

    async cancelRun(input: CancelRunStoreInput): Promise<ControlStoreResult> {
      return db.transaction(async (tx) => {
        const run = await loadRun(tx, input.sandboxId, input.runId);
        if (!run) {
          return { ok: false, code: 'RUN_NOT_FOUND' };
        }
        const status = run.status as WorkflowStatus;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          return { ok: false, code: 'RUN_TERMINAL' };
        }
        if (status === 'cancel_requested') {
          return { ok: false, code: 'DUPLICATE_CANCELLATION' };
        }
        const unresolved = await tx
          .select({ id: actionExecutions.id })
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.sandboxId, run.sandboxId),
              eq(actionExecutions.caseId, run.caseId),
              inArray(actionExecutions.state, ['in_progress', 'unknown']),
            ),
          )
          .limit(1);
        if (unresolved[0]) {
          await tx
            .update(actionExecutions)
            .set({
              state: 'cancelled',
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(actionExecutions.sandboxId, run.sandboxId),
                eq(actionExecutions.caseId, run.caseId),
                inArray(actionExecutions.state, [
                  'pending',
                  'retryable_failure',
                  'permanent_failure',
                ]),
              ),
            );
          await tx
            .insert(actionCaseCancellations)
            .values({
              sandboxId: run.sandboxId,
              caseId: run.caseId,
              requestedAt: sql`clock_timestamp()`,
            })
            .onConflictDoNothing();
          await tx
            .update(workflowRuns)
            .set({
              status: 'cancel_requested',
              waitReason: null,
              cancelCause: input.request.cause,
              lastError: input.request.cause,
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowRuns.id, run.id));
          await cancelActiveJobs(tx, run.id, input.request.cause);
          const caseRows = await tx
            .select({ status: cases.status })
            .from(cases)
            .where(
              and(eq(cases.sandboxId, run.sandboxId), eq(cases.id, run.caseId)),
            )
            .limit(1);
          const caseStatus = (caseRows[0]?.status ?? run.caseId) as CaseStatus;
          await appendAuditInTransaction(tx, {
            actor: input.actor,
            requestId: input.requestId,
            correlationId: input.correlationId,
            sandboxId: run.sandboxId,
            runId: run.id,
            targetType: 'workflow_run',
            targetId: run.id,
            targetVersion: String(run.version + 1),
            action: 'workflow.cancel_requested',
            beforeHash: null,
            afterHash: null,
            outcome: 'succeeded',
            details: {
              status: 'cancel_requested',
              action: 'workflow.cancel_requested',
              outcome: 'succeeded',
            },
          });
          return controlResponse(run.id, 'cancel_requested', caseStatus);
        }
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
        await tx
          .update(workflowRuns)
          .set({
            status: 'cancelled',
            waitReason: null,
            cancelCause: input.request.cause,
            partialEffects: input.partialEffects as unknown as PartialEffect[],
            lastError: input.request.cause,
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, run.id));
        await cancelActiveJobs(tx, run.id, input.request.cause);
        await tx
          .update(workflowSteps)
          .set({
            status: 'cancelled',
            errorClass: input.request.cause,
            version: sql`${workflowSteps.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(workflowSteps.runId, run.id),
              inArray(workflowSteps.status, ['pending', 'running', 'waiting']),
            ),
          );
        const caseStatus = await applyCaseStatus(
          tx,
          run,
          input.caseStatusAfter,
          input.request.cause,
        );
        await appendAuditInTransaction(tx, {
          actor: input.actor,
          requestId: input.requestId,
          correlationId: input.correlationId,
          sandboxId: run.sandboxId,
          runId: run.id,
          targetType: 'workflow_run',
          targetId: run.id,
          targetVersion: String(run.version + 1),
          action: 'workflow.cancelled',
          beforeHash: null,
          afterHash: null,
          outcome: 'succeeded',
          details: {
            status: 'cancelled',
            action: 'workflow.cancelled',
            outcome: 'succeeded',
          },
        });
        await appendTraceEventInTransaction(tx, {
          sandboxId: run.sandboxId,
          runId: run.id,
          level: 'warn',
          event: 'workflow.run.cancelled',
          data: {
            status: 'cancelled',
            count: input.partialEffects.length,
            errorClass: input.request.cause,
          },
        });
        return controlResponse(run.id, 'cancelled', caseStatus);
      });
    },

    async processDependencyEvents(limit: number): Promise<number> {
      let processed = 0;
      for (let index = 0; index < limit; index += 1) {
        const handled = await db.transaction(async (tx) => {
          const inboxRows = await tx
            .select()
            .from(eventInbox)
            .where(
              and(
                eq(eventInbox.consumerName, CONSUMER_NAME),
                eq(eventInbox.dispatchState, 'pending'),
                eq(eventInbox.eventType, 'nexus.case.completed.v1'),
              ),
            )
            .orderBy(eventInbox.receivedAt, eventInbox.id)
            .for('update', { skipLocked: true })
            .limit(1);
          const inbox = inboxRows[0];
          if (!inbox) {
            return false;
          }
          const payload = CaseCompletedPayloadSchema.safeParse(
            asRecord(inbox.envelope)['payload'],
          );
          if (!payload.success) {
            await tx
              .update(eventInbox)
              .set({ dispatchState: 'processed', updatedAt: sql`clock_timestamp()` })
              .where(eq(eventInbox.id, inbox.id));
            return true;
          }
          const childRows = await tx
            .select()
            .from(cases)
            .where(
              and(
                eq(cases.sandboxId, inbox.sandboxId),
                eq(cases.id, payload.data.caseId),
              ),
            )
            .for('update')
            .limit(1);
          const child = childRows[0];
          if (
            !child ||
            child.version !== payload.data.terminalCaseVersion ||
            child.status !== payload.data.terminalStatus
          ) {
            await tx
              .update(eventInbox)
              .set({ dispatchState: 'processed', updatedAt: sql`clock_timestamp()` })
              .where(eq(eventInbox.id, inbox.id));
            return true;
          }
          const nowResult = await tx.execute(sql`SELECT clock_timestamp() AS now`);
          const nowValue = nowResult.rows[0]?.['now'];
          const databaseNow =
            nowValue instanceof Date ? nowValue : new Date(String(nowValue));
          const dependencyRows = await tx
            .select()
            .from(workflowDependencies)
            .where(
              and(
                eq(workflowDependencies.sandboxId, inbox.sandboxId),
                eq(workflowDependencies.childCaseId, payload.data.caseId),
                eq(
                  workflowDependencies.childTriggerEventId,
                  payload.data.terminalTriggerEventId,
                ),
                eq(workflowDependencies.state, 'waiting'),
              ),
            )
            .for('update');
          for (const dependency of dependencyRows) {
            if (dependency.linkedCaseVersion > payload.data.terminalCaseVersion) {
              continue;
            }
            if (dependency.expiresAt.getTime() <= databaseNow.getTime()) {
              await tx
                .update(workflowDependencies)
                .set({
                  state: 'expired',
                  resolvedAt: sql`clock_timestamp()`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(eq(workflowDependencies.id, dependency.id));
              const expiredParentRows = await tx
                .select()
                .from(workflowRuns)
                .where(
                  and(
                    eq(workflowRuns.sandboxId, dependency.sandboxId),
                    eq(workflowRuns.id, dependency.parentRunId),
                  ),
                )
                .for('update')
                .limit(1);
              const expiredParent = expiredParentRows[0];
              if (expiredParent && expiredParent.status === 'waiting_dependency') {
                await escalateDependencyParent(
                  tx,
                  expiredParent,
                  'dependency_timeout',
                  'DEPENDENCY_TIMEOUT',
                  'dependency_timeout',
                );
              }
              continue;
            }
            const parentRows = await tx
              .select()
              .from(workflowRuns)
              .where(
                and(
                  eq(workflowRuns.sandboxId, dependency.sandboxId),
                  eq(workflowRuns.id, dependency.parentRunId),
                ),
              )
              .for('update')
              .limit(1);
            const parent = parentRows[0];
            if (!parent || parent.status !== 'waiting_dependency') {
              await tx
                .update(workflowDependencies)
                .set({
                  state: 'cancelled',
                  resolvedAt: sql`clock_timestamp()`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(eq(workflowDependencies.id, dependency.id));
              continue;
            }
            if (payload.data.terminalStatus === 'resolved') {
              await tx
                .update(workflowDependencies)
                .set({
                  state: 'resolved',
                  resolvedAt: sql`clock_timestamp()`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(eq(workflowDependencies.id, dependency.id));
              await resumeDependencyParent(
                tx,
                parent,
                'dependency_retry',
                'dependency_resolved',
              );
            } else {
              await tx
                .update(workflowDependencies)
                .set({
                  state: 'escalated',
                  resolvedAt: sql`clock_timestamp()`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(eq(workflowDependencies.id, dependency.id));
              await escalateDependencyParent(
                tx,
                parent,
                payload.data.terminalStatus === 'cancelled'
                  ? 'dependency_child_cancelled'
                  : 'dependency_child_escalated',
                `DEPENDENCY_CHILD_${payload.data.terminalStatus.toUpperCase()}`,
                'dependency_failure',
              );
            }
          }
          await tx
            .update(eventInbox)
            .set({ dispatchState: 'processed', updatedAt: sql`clock_timestamp()` })
            .where(eq(eventInbox.id, inbox.id));
          return true;
        });
        if (!handled) {
          break;
        }
        processed += 1;
      }
      return processed;
    },

    async expireDependencies(limit: number): Promise<number> {
      let expired = 0;
      for (let index = 0; index < limit; index += 1) {
        const handled = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(workflowDependencies)
            .where(
              and(
                eq(workflowDependencies.state, 'waiting'),
                sql`${workflowDependencies.expiresAt} <= clock_timestamp()`,
              ),
            )
            .orderBy(workflowDependencies.expiresAt)
            .for('update', { skipLocked: true })
            .limit(1);
          const dependency = rows[0];
          if (!dependency) {
            return false;
          }
          const parentRows = await tx
            .select()
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.sandboxId, dependency.sandboxId),
                eq(workflowRuns.id, dependency.parentRunId),
              ),
            )
            .for('update')
            .limit(1);
          const parent = parentRows[0];
          if (!parent || parent.status !== 'waiting_dependency') {
            await tx
              .update(workflowDependencies)
              .set({
                state: 'cancelled',
                resolvedAt: sql`clock_timestamp()`,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(workflowDependencies.id, dependency.id));
            return true;
          }
          await tx
            .update(workflowDependencies)
            .set({
              state: 'expired',
              resolvedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowDependencies.id, dependency.id));
          await escalateDependencyParent(
            tx,
            parent,
            'dependency_timeout',
            'DEPENDENCY_TIMEOUT',
            'dependency_timeout',
          );
          return true;
        });
        if (!handled) {
          break;
        }
        expired += 1;
      }
      return expired;
    },
  };
}

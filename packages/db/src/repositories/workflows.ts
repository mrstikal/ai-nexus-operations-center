import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  WorkflowStatus,
  WorkflowStepStatus,
  WaitReason,
} from '@nexus/contracts';
import type {
  CommitStepInput,
  CommitStepResult,
  CompleteJobInput,
  CompleteJobResult,
  ScheduleOutcome,
  SchedulePendingInput,
  WorkflowJournal,
  WorkflowRunContext,
  WorkflowRunSnapshot,
  WorkflowStepSnapshot,
} from '@nexus/application/workflows/journal';
import type { WorkflowJobClaim, WorkflowJobState } from '@nexus/application/workflows/leases';
import type {
  RedactedOutput,
  WorkflowDefinition,
  WorkflowStepKind,
} from '@nexus/application/workflows/definitions';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type { NexusDb } from '../connection.js';
import { eventInbox } from '../schema/events.js';
import { evidence } from '../schema/evidence.js';
import {
  workflowAttemptEvidence,
  workflowJobs,
  workflowRuns,
  workflowSteps,
  workflowStepAttempts,
} from '../schema/workflows.js';
import { appendTraceEventInTransaction } from './trace.js';
import type { DbTransaction } from './types.js';

const CONSUMER_NAME = 'nexus.worker.events.v1';
const DEFAULT_ACTIVE_MS_LIMIT = 300_000;
const DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000;
const STEP_KEY_DEFAULT_ATTEMPTS = 3;

function leaseLost(): Error {
  const error = new Error('Workflow lease is no longer held by this worker');
  error.name = 'LeaseLostError';
  return error;
}

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

function asRedactedOutput(value: unknown): RedactedOutput | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RedactedOutput)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function runSnapshot(row: typeof workflowRuns.$inferSelect): WorkflowRunSnapshot {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    caseId: row.caseId,
    definitionName: row.definitionName,
    definitionVersion: row.definitionVersion,
    status: row.status as WorkflowStatus,
    ingress: asRecord(row.ingress),
    ingressHash: row.ingressHash,
    waitReason: asWaitReason(row.waitReason),
    policyRevision: row.policyRevision,
    modelRevision: row.modelRevision,
    configRevision: row.configRevision,
    promptRevision: row.promptRevision,
    activeMsLimit: row.activeMsLimit,
    activeMsUsed: row.activeMsUsed,
    deadlineAt: row.deadlineAt,
    cancelRequested: row.cancelRequested,
    version: row.version,
  };
}

function stepSnapshot(row: typeof workflowSteps.$inferSelect): WorkflowStepSnapshot {
  return {
    id: row.id,
    stepKey: row.stepKey,
    stepKind: row.stepKind as WorkflowStepKind,
    status: row.status as WorkflowStepStatus,
    inputHash: row.inputHash,
    outputHash: row.outputHash,
    output: asRedactedOutput(row.output),
    evidenceRefs: asStringArray(row.evidenceRefs),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    errorClass: row.errorClass,
  };
}

async function assertClaim(
  tx: DbTransaction,
  claim: WorkflowJobClaim,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT id
    FROM nexus.workflow_jobs
    WHERE id = ${claim.jobId}
      AND state = 'leased'
      AND lease_owner = ${claim.leaseOwner}
      AND fencing_token = ${claim.fencingToken}
      AND lease_expires_at > clock_timestamp()
    FOR UPDATE
  `);
  if (result.rows.length !== 1) {
    throw leaseLost();
  }
}

async function loadRun(
  tx: DbTransaction,
  claim: WorkflowJobClaim,
): Promise<typeof workflowRuns.$inferSelect> {
  const rows = await tx
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, claim.runId),
        eq(workflowRuns.sandboxId, claim.sandboxId),
      ),
    )
    .for('update')
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw leaseLost();
  }
  return row;
}

async function loadContextTx(
  tx: DbTransaction,
  claim: WorkflowJobClaim,
): Promise<WorkflowRunContext> {
  const run = await loadRun(tx, claim);
  const steps = await tx
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.runId, run.id))
    .orderBy(workflowSteps.stepKey);
  return {
    run: runSnapshot(run),
    steps: new Map(steps.map((step) => [step.stepKey, stepSnapshot(step)])),
  };
}

async function updateStepsForDefinition(
  tx: DbTransaction,
  runId: string,
  sandboxId: string,
  definition: WorkflowDefinition,
): Promise<void> {
  const now = sql`clock_timestamp()`;
  for (const step of definition.steps) {
    await tx.insert(workflowSteps).values({
      id: randomUUID(),
      sandboxId,
      runId,
      stepKey: step.key,
      stepKind: step.kind,
      status: 'pending',
      inputHash: null,
      outputHash: null,
      output: null,
      evidenceRefs: [],
      attemptCount: 0,
      maxAttempts:
        step.kind === 'external'
          ? 1
          : (step.maxAttempts ?? STEP_KEY_DEFAULT_ATTEMPTS),
      errorClass: null,
      startedAt: null,
      finishedAt: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function jobStateForAction(action: CommitStepInput['jobAction']): WorkflowJobState {
  switch (action) {
    case 'continue':
      return 'leased';
    case 'retry':
      return 'pending';
    case 'wait':
      return 'succeeded';
    case 'fail':
      return 'failed';
  }
}

function traceErrorClass(errorClass: string | null): string | null {
  return errorClass === null ? null : errorClass.slice(0, 100);
}

export function createWorkflowJournal(db: NexusDb): WorkflowJournal {
  return {
    async currentTime(): Promise<Date> {
      const result = await db.execute(sql`SELECT clock_timestamp() AS now`);
      const value = result.rows[0]?.['now'];
      return value instanceof Date ? value : new Date(String(value));
    },

    async schedulePendingInbox(input: SchedulePendingInput): Promise<ScheduleOutcome[]> {
      const eventTypes = Object.keys(input.triggerMap);
      if (eventTypes.length === 0) {
        return [];
      }
      const outcomes: ScheduleOutcome[] = [];
      const limit = input.limit ?? 10;
      for (let index = 0; index < limit; index += 1) {
        const outcome = await db.transaction(async (tx) => {
          const inboxRows = await tx
            .select()
            .from(eventInbox)
            .where(
              and(
                eq(eventInbox.consumerName, CONSUMER_NAME),
                eq(eventInbox.dispatchState, 'pending'),
                inArray(eventInbox.eventType, eventTypes),
              ),
            )
            .orderBy(eventInbox.receivedAt, eventInbox.id)
            .for('update', { skipLocked: true })
            .limit(1);
          const inbox = inboxRows[0];
          if (!inbox) {
            return null;
          }
          const existing = await tx
            .select({ id: workflowRuns.id })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.sandboxId, inbox.sandboxId),
                eq(workflowRuns.triggerEventId, inbox.eventId),
              ),
            )
            .limit(1);
          if (existing[0]) {
            await tx
              .update(eventInbox)
              .set({ dispatchState: 'scheduled', updatedAt: sql`clock_timestamp()` })
              .where(eq(eventInbox.id, inbox.id));
            return {
              inboxId: inbox.id,
              eventId: inbox.eventId,
              runId: existing[0].id,
              outcome: 'duplicate',
            } satisfies ScheduleOutcome;
          }
          const trigger = input.triggerMap[inbox.eventType];
          const definition =
            trigger === undefined
              ? null
              : input.registry.get(trigger.name, trigger.version);
          const runId = randomUUID();
          const ingressHash = canonicalJsonSha256(inbox.envelope);
          const envelopePayload = asRecord(inbox.envelope)['payload'];
          const caseId =
            envelopePayload !== null &&
            typeof envelopePayload === 'object' &&
            typeof (envelopePayload as { caseId?: unknown }).caseId === 'string'
              ? (envelopePayload as { caseId: string }).caseId
              : null;
          if (caseId === null) {
            await tx
              .update(eventInbox)
              .set({ dispatchState: 'dead', updatedAt: sql`clock_timestamp()` })
              .where(eq(eventInbox.id, inbox.id));
            await appendTraceEventInTransaction(tx, {
              sandboxId: inbox.sandboxId,
              runId: null,
              level: 'error',
              event: 'workflow.trigger_case_missing',
              data: {
                status: 'dead',
                errorClass: 'TRIGGER_CASE_MISSING',
                correlationId: inbox.correlationId,
              },
            });
            return {
              inboxId: inbox.id,
              eventId: inbox.eventId,
              runId: null,
              outcome: 'blocked',
            } satisfies ScheduleOutcome;
          }
          if (!definition) {
            await tx.insert(workflowRuns).values({
              id: runId,
              sandboxId: inbox.sandboxId,
              caseId,
              inboxId: inbox.id,
              triggerEventId: inbox.eventId,
              triggerEventType: inbox.eventType,
              definitionName: trigger?.name ?? 'unknown',
              definitionVersion: trigger?.version ?? 'unknown',
              status: 'blocked',
              ingress: asRecord(inbox.envelope),
              ingressHash,
              effectiveAt: inbox.occurredAt,
              waitReason: null,
              policyRevision: 'unknown',
              modelRevision: 'unknown',
              configRevision: 'unknown',
              promptRevision: null,
              activeMsLimit: DEFAULT_ACTIVE_MS_LIMIT,
              activeMsUsed: 0,
              deadlineAt: new Date(Date.now() + DEFAULT_DEADLINE_MS),
              cancelRequested: false,
              lastError: 'UNKNOWN_DEFINITION',
              version: 0,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            });
            await tx
              .update(eventInbox)
              .set({ dispatchState: 'scheduled', updatedAt: sql`clock_timestamp()` })
              .where(eq(eventInbox.id, inbox.id));
            await appendTraceEventInTransaction(tx, {
              sandboxId: inbox.sandboxId,
              runId,
              level: 'error',
              event: 'workflow.definition_unknown',
              data: {
                status: 'blocked',
                errorClass: 'UNKNOWN_DEFINITION',
                correlationId: inbox.correlationId,
              },
            });
            return {
              inboxId: inbox.id,
              eventId: inbox.eventId,
              runId,
              outcome: 'blocked',
            } satisfies ScheduleOutcome;
          }
          await tx.insert(workflowRuns).values({
            id: runId,
            sandboxId: inbox.sandboxId,
            caseId,
            inboxId: inbox.id,
            triggerEventId: inbox.eventId,
            triggerEventType: inbox.eventType,
            definitionName: definition.name,
            definitionVersion: definition.version,
            status: 'queued',
            ingress: asRecord(inbox.envelope),
            ingressHash,
            effectiveAt: inbox.occurredAt,
            waitReason: null,
            policyRevision: definition.policyRevision ?? 'f11-v1',
            modelRevision: definition.modelRevision ?? 'none',
            configRevision: definition.configRevision ?? 'f11-v1',
            promptRevision: definition.promptRevision ?? null,
            activeMsLimit: definition.activeMsLimit ?? DEFAULT_ACTIVE_MS_LIMIT,
            activeMsUsed: 0,
            deadlineAt: new Date(Date.now() + (definition.deadlineMs ?? DEFAULT_DEADLINE_MS)),
            cancelRequested: false,
            lastError: null,
            version: 0,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
          await updateStepsForDefinition(tx, runId, inbox.sandboxId, definition);
          await tx.insert(workflowJobs).values({
            id: randomUUID(),
            sandboxId: inbox.sandboxId,
            runId,
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
          await tx
            .update(eventInbox)
            .set({ dispatchState: 'scheduled', updatedAt: sql`clock_timestamp()` })
            .where(eq(eventInbox.id, inbox.id));
          await appendTraceEventInTransaction(tx, {
            sandboxId: inbox.sandboxId,
            runId,
            level: 'info',
            event: 'workflow.scheduled',
            data: {
              status: 'queued',
              attempt: 0,
              correlationId: inbox.correlationId,
            },
          });
          return {
            inboxId: inbox.id,
            eventId: inbox.eventId,
            runId,
            outcome: 'scheduled',
          } satisfies ScheduleOutcome;
        });
        if (!outcome) {
          break;
        }
        outcomes.push(outcome);
      }
      return outcomes;
    },

    async claimJob(ownerId, leaseMs): Promise<WorkflowJobClaim | null> {
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM nexus.workflow_jobs
          WHERE (state = 'pending' AND available_at <= clock_timestamp())
             OR (state = 'leased' AND lease_expires_at <= clock_timestamp())
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE nexus.workflow_jobs AS job
        SET state = 'leased',
            lease_owner = ${ownerId},
            lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseMs}::double precision / 1000.0),
            fencing_token = job.fencing_token + 1,
            attempt_count = job.attempt_count + 1,
            version = job.version + 1,
            updated_at = clock_timestamp()
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id, job.sandbox_id, job.run_id, job.lease_owner,
                  job.lease_expires_at, job.fencing_token, job.attempt_count
      `);
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        jobId: String(row['id']),
        sandboxId: String(row['sandbox_id']),
        runId: String(row['run_id']),
        leaseOwner: String(row['lease_owner']),
        leaseExpiresAt: row['lease_expires_at'] instanceof Date
          ? row['lease_expires_at']
          : new Date(String(row['lease_expires_at'])),
        fencingToken: Number(row['fencing_token']),
        attemptCount: Number(row['attempt_count']),
      };
    },

    async heartbeat(claim, leaseMs): Promise<boolean> {
      const result = await db.execute(sql`
        UPDATE nexus.workflow_jobs
        SET lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseMs}::double precision / 1000.0),
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE id = ${claim.jobId}
          AND state = 'leased'
          AND lease_owner = ${claim.leaseOwner}
          AND fencing_token = ${claim.fencingToken}
          AND lease_expires_at > clock_timestamp()
        RETURNING id
      `);
      return result.rows.length === 1;
    },

    async markRunning(claim): Promise<WorkflowRunContext> {
      return db.transaction(async (tx) => {
        await assertClaim(tx, claim);
        const run = await loadRun(tx, claim);
        if (run.status === 'queued') {
          await tx
            .update(workflowRuns)
            .set({
              status: 'running',
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowRuns.id, run.id));
        }
        return loadContextTx(tx, claim);
      });
    },

    async loadContext(claim): Promise<WorkflowRunContext> {
      return db.transaction(async (tx) => {
        await assertClaim(tx, claim);
        return loadContextTx(tx, claim);
      });
    },

    async commitStep(input): Promise<CommitStepResult> {
      return db.transaction(async (tx) => {
        await assertClaim(tx, input.claim);
        const runRow = await loadRun(tx, input.claim);
        const now = await tx.execute(sql`SELECT clock_timestamp() AS now`);
        const nowValue = now.rows[0]?.['now'];
        const databaseNow = nowValue instanceof Date ? nowValue : new Date(String(nowValue));
        if (
          runRow.cancelRequested ||
          runRow.status === 'cancelled' ||
          runRow.status === 'failed' ||
          runRow.status === 'completed'
        ) {
          await tx
            .update(workflowJobs)
            .set({
              state: 'failed',
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: 'RUN_CLOSED',
              version: sql`${workflowJobs.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowJobs.id, input.claim.jobId));
          const steps = await tx
            .select()
            .from(workflowSteps)
            .where(eq(workflowSteps.runId, runRow.id));
          const step = steps.find((candidate) => candidate.stepKey === input.stepKey);
          if (!step) {
            throw leaseLost();
          }
          return {
            reused: true,
            step: stepSnapshot(step),
            runStatus: runRow.status as WorkflowStatus,
            jobState: 'failed',
          };
        }
        const stepRows = await tx
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.runId, runRow.id),
              eq(workflowSteps.stepKey, input.stepKey),
            ),
          )
          .for('update')
          .limit(1);
        const stepRow = stepRows[0];
        if (!stepRow) {
          throw leaseLost();
        }
        if (
          databaseNow.getTime() >= runRow.deadlineAt.getTime() ||
          runRow.activeMsUsed >= runRow.activeMsLimit ||
          runRow.activeMsUsed + input.activeMs > runRow.activeMsLimit
        ) {
          const budgetReason =
            databaseNow.getTime() >= runRow.deadlineAt.getTime()
              ? 'DEADLINE_EXCEEDED'
              : 'ACTIVE_LIMIT_EXCEEDED';
          await tx
            .update(workflowRuns)
            .set({
              status: 'budget_exhausted',
              waitReason: null,
              lastError: budgetReason,
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowRuns.id, runRow.id));
          await tx
            .update(workflowJobs)
            .set({
              state: 'failed',
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: budgetReason,
              version: sql`${workflowJobs.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowJobs.id, input.claim.jobId));
          await appendTraceEventInTransaction(tx, {
            sandboxId: runRow.sandboxId,
            runId: runRow.id,
            level: 'error',
            event: 'workflow.run.budget_exhausted',
            data: { status: 'budget_exhausted', errorClass: budgetReason },
          });
          return {
            reused: true,
            step: stepSnapshot(stepRow),
            runStatus: 'budget_exhausted',
            jobState: 'failed',
          };
        }
        if (stepRow.status === 'succeeded') {
          if (stepRow.inputHash === input.inputHash) {
            return {
              reused: true,
              step: stepSnapshot(stepRow),
              runStatus: runRow.status as WorkflowStatus,
              jobState: 'leased',
            };
          }
          await tx
            .update(workflowRuns)
            .set({
              status: 'blocked',
              waitReason: null,
              lastError: 'STEP_INPUT_CHANGED',
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowRuns.id, runRow.id));
          await tx
            .update(workflowJobs)
            .set({
              state: 'failed',
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: 'STEP_INPUT_CHANGED',
              version: sql`${workflowJobs.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowJobs.id, input.claim.jobId));
          return {
            reused: true,
            step: stepSnapshot(stepRow),
            runStatus: 'blocked',
            jobState: 'failed',
          };
        }

        const uniqueEvidenceRefs = [...new Set(input.evidenceRefs)];
        let evidenceInvalid =
          uniqueEvidenceRefs.length !== input.evidenceRefs.length;
        if (!evidenceInvalid && uniqueEvidenceRefs.length > 0) {
          const existingEvidence = await tx
            .select({ id: evidence.id })
            .from(evidence)
            .where(
              and(
                eq(evidence.sandboxId, runRow.sandboxId),
                inArray(evidence.id, uniqueEvidenceRefs),
              ),
            );
          evidenceInvalid = existingEvidence.length !== uniqueEvidenceRefs.length;
        }
        const outcome = evidenceInvalid
          ? {
              ...input,
              outcomeStatus: 'permanent_failure' as const,
              output: null,
              outputHash: null,
              evidenceRefs: [],
              errorClass: 'INVALID_EVIDENCE_REF',
              waitReason: null,
              runStatusAfter: 'failed' as const,
              jobAction: 'fail' as const,
              retryAt: null,
            }
          : input;

        const attemptId = randomUUID();
        await tx.insert(workflowStepAttempts).values({
          id: attemptId,
          sandboxId: runRow.sandboxId,
          runId: runRow.id,
          stepId: stepRow.id,
          attemptNo: input.attemptNo,
          status: outcome.outcomeStatus,
          inputHash: input.inputHash,
          outputHash: outcome.outputHash,
          output: outcome.output,
          evidenceRefs: [...outcome.evidenceRefs],
          errorClass: traceErrorClass(outcome.errorClass),
          modelRevision: runRow.modelRevision,
          policyRevision: runRow.policyRevision,
          configRevision: runRow.configRevision,
          promptRevision: runRow.promptRevision,
          leaseFencingToken: input.claim.fencingToken,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          createdAt: sql`clock_timestamp()`,
        });
        for (const evidenceId of outcome.evidenceRefs) {
          await tx.insert(workflowAttemptEvidence).values({
            attemptId,
            sandboxId: runRow.sandboxId,
            evidenceId,
            createdAt: sql`clock_timestamp()`,
          });
        }
        const updatedSteps = await tx
          .update(workflowSteps)
          .set({
            status: outcome.outcomeStatus,
            inputHash: input.inputHash,
            outputHash: outcome.outputHash,
            output: outcome.output,
            evidenceRefs: [...outcome.evidenceRefs],
            attemptCount: input.attemptNo,
            errorClass: traceErrorClass(outcome.errorClass),
            startedAt: stepRow.startedAt ?? input.startedAt,
            finishedAt: input.finishedAt,
            version: sql`${workflowSteps.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowSteps.id, stepRow.id))
          .returning();
        const updatedStep = updatedSteps[0];
        if (!updatedStep) {
          throw leaseLost();
        }

        await tx
          .update(workflowRuns)
          .set({
            status: outcome.runStatusAfter,
            waitReason: outcome.waitReason,
            activeMsUsed: sql`${workflowRuns.activeMsUsed} + ${input.activeMs}`,
            lastError: traceErrorClass(outcome.errorClass),
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, runRow.id));

        if (outcome.jobAction !== 'continue') {
          await tx
            .update(workflowJobs)
            .set({
              state: jobStateForAction(outcome.jobAction),
              leaseOwner: null,
              leaseExpiresAt: null,
              availableAt:
                outcome.jobAction === 'retry'
                  ? (outcome.retryAt ?? new Date(Date.now() + 1_000))
                  : sql`clock_timestamp()`,
              lastError: traceErrorClass(outcome.errorClass),
              version: sql`${workflowJobs.version} + 1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowJobs.id, input.claim.jobId));
        }

        await appendTraceEventInTransaction(tx, {
          sandboxId: runRow.sandboxId,
          runId: runRow.id,
          level: outcome.outcomeStatus === 'permanent_failure' ? 'error' : 'info',
          event: `workflow.step.${outcome.outcomeStatus}`,
          data: {
            step: input.stepKey,
            status: outcome.outcomeStatus,
            attempt: input.attemptNo,
            durationMs: input.activeMs,
            errorClass: traceErrorClass(outcome.errorClass),
            count: outcome.evidenceRefs.length,
            retry: outcome.jobAction === 'retry',
          },
        });

        return {
          reused: false,
          step: stepSnapshot(updatedStep),
          runStatus: outcome.runStatusAfter,
          jobState: jobStateForAction(outcome.jobAction),
        };
      });
    },

    async completeJob(input: CompleteJobInput): Promise<CompleteJobResult> {
      return db.transaction(async (tx) => {
        await assertClaim(tx, input.claim);
        const runRow = await loadRun(tx, input.claim);
        const nowResult = await tx.execute(sql`SELECT clock_timestamp() AS now`);
        const nowValue = nowResult.rows[0]?.['now'];
        const databaseNow = nowValue instanceof Date ? nowValue : new Date(String(nowValue));
        const deadlineExceeded = databaseNow.getTime() >= runRow.deadlineAt.getTime();
        const activeExceeded = runRow.activeMsUsed >= runRow.activeMsLimit;
        const budgetExceeded =
          input.runStatus === 'completed' && (deadlineExceeded || activeExceeded);
        const finalStatus = budgetExceeded ? 'budget_exhausted' : input.runStatus;
        const finalJobState =
          finalStatus === 'budget_exhausted' ? 'failed' : input.jobState;
        const finalError = budgetExceeded
          ? deadlineExceeded
            ? 'DEADLINE_EXCEEDED'
            : 'ACTIVE_LIMIT_EXCEEDED'
          : input.errorClass ?? null;
        await tx
          .update(workflowRuns)
          .set({
            status: finalStatus,
            waitReason:
              finalStatus === 'waiting_input' ||
              finalStatus === 'waiting_approval' ||
              finalStatus === 'waiting_dependency'
                ? runRow.waitReason
                : null,
            lastError:
              finalJobState === 'failed'
                ? traceErrorClass(finalError ?? runRow.lastError)
                : null,
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, runRow.id));
        await tx
          .update(workflowJobs)
          .set({
            state: finalJobState,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: traceErrorClass(finalError),
            version: sql`${workflowJobs.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowJobs.id, input.claim.jobId));
        await appendTraceEventInTransaction(tx, {
          sandboxId: runRow.sandboxId,
          runId: runRow.id,
          level: finalJobState === 'failed' ? 'error' : 'info',
          event: `workflow.run.${finalStatus}`,
          data: {
            status: finalStatus,
            errorClass: traceErrorClass(finalError),
          },
        });
        return { runStatus: finalStatus, jobState: finalJobState };
      });
    },

    async markBudgetExhausted(claim, context, errorClass): Promise<void> {
      await db.transaction(async (tx) => {
        await assertClaim(tx, claim);
        await loadRun(tx, claim);
        await tx
          .update(workflowRuns)
          .set({
            status: 'budget_exhausted',
            waitReason: null,
            lastError: traceErrorClass(errorClass),
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, context.run.id));
        await tx
          .update(workflowJobs)
          .set({
            state: 'failed',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: traceErrorClass(errorClass),
            version: sql`${workflowJobs.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowJobs.id, claim.jobId));
        await appendTraceEventInTransaction(tx, {
          sandboxId: context.run.sandboxId,
          runId: context.run.id,
          level: 'error',
          event: 'workflow.run.budget_exhausted',
          data: { status: 'budget_exhausted', errorClass },
        });
      });
    },

    async markBlocked(claim, context, errorClass): Promise<void> {
      await db.transaction(async (tx) => {
        await assertClaim(tx, claim);
        await loadRun(tx, claim);
        await tx
          .update(workflowRuns)
          .set({
            status: 'blocked',
            waitReason: null,
            lastError: traceErrorClass(errorClass),
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowRuns.id, context.run.id));
        await tx
          .update(workflowJobs)
          .set({
            state: 'failed',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: traceErrorClass(errorClass),
            version: sql`${workflowJobs.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(workflowJobs.id, claim.jobId));
        await appendTraceEventInTransaction(tx, {
          sandboxId: context.run.sandboxId,
          runId: context.run.id,
          level: 'error',
          event: 'workflow.run.blocked',
          data: { status: 'blocked', errorClass },
        });
      });
    },
  };
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, Pool as PgPoolType, PoolConfig } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionRegistry,
  createTestWorkflowDefinitions,
  type WorkflowDefinition,
} from '@nexus/application/workflows/definitions';
import { WorkflowRunner } from '@nexus/application/workflows/runner';
import { ResumeService } from '@nexus/application/workflows/resume';
import { CancellationService } from '@nexus/application/workflows/cancellation';
import { RunControlError } from '@nexus/application/workflows/waits';
import { createNexusDb } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createWorkflowControlStore } from '@nexus/db/repositories/workflow-control';
import { createWorkflowJournal } from '@nexus/db/repositories/workflows';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const CONSUMER_NAME = 'nexus.worker.events.v1';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F11A`);
  }
  return value;
}

function pgConfig(user: string, password: string): PoolConfig {
  return {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f11a-control-test',
    connectionTimeoutMillis: 5000,
  };
}

let superuser: Client;
let migrator: Client;
let workflowPool: PgPoolType;
let apiPool: PgPoolType;
let journal: ReturnType<typeof createWorkflowJournal>;
let control: ReturnType<typeof createWorkflowControlStore>;
let resumeService: ResumeService;
let cancellationService: CancellationService;

async function dbAll<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  const result = await superuser.query(sql, parameters);
  return result.rows as T[];
}

async function dbOne<T>(sql: string, parameters: unknown[] = []): Promise<T> {
  const rows = await dbAll<T>(sql, parameters);
  const row = rows[0];
  if (!row) {
    throw new Error('Expected one database row');
  }
  return row;
}

async function createCase(title: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases
       (id, sandbox_id, title, summary, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, 'new', 1, clock_timestamp(), clock_timestamp())`,
    [id, SANDBOX_ID, title],
  );
  return id;
}

async function createSandbox(name: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.sandboxes (id, name, status, business_effective_at)
     VALUES ($1, $2, 'active', '2026-11-02T09:00:00Z')`,
    [id, name],
  );
  return id;
}

async function createInboxEvent(caseId: string, title: string): Promise<string> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    eventId,
    eventType: 'nexus.case.created.v1',
    schemaVersion: 1,
    occurredAt,
    sandboxId: SANDBOX_ID,
    correlationId: `f11a-${randomUUID()}`,
    causationId: null,
    producer: 'api',
    payload: { caseId, title },
  };
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id, sandbox_id, consumer_name, event_id, event_type, producer,
        correlation_id, causation_id, occurred_at, envelope, dispatch_state,
        attempt_count, next_attempt_at, received_at, updated_at)
     VALUES ($1, $2, $3, $4, 'nexus.case.created.v1', 'api', $5, NULL,
             $6, $7::jsonb, 'pending', 0, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [
      randomUUID(),
      SANDBOX_ID,
      CONSUMER_NAME,
      eventId,
      envelope.correlationId,
      occurredAt,
      JSON.stringify(envelope),
    ],
  );
  return eventId;
}

async function createChildRun(
  childCaseId: string,
  childTriggerEventId: string,
): Promise<string> {
  const runId = randomUUID();
  const inboxId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    eventId: childTriggerEventId,
    eventType: 'nexus.case.created.v1',
    schemaVersion: 1,
    occurredAt,
    sandboxId: SANDBOX_ID,
    correlationId: `f11a-child-${randomUUID()}`,
    causationId: null,
    producer: 'api',
    payload: { caseId: childCaseId, title: 'Child trigger' },
  };
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id, sandbox_id, consumer_name, event_id, event_type, producer,
        correlation_id, causation_id, occurred_at, envelope, dispatch_state,
        attempt_count, next_attempt_at, received_at, updated_at)
     VALUES ($1, $2, $3, $4, 'nexus.case.created.v1', 'api', $5, NULL,
             $6, $7::jsonb, 'processed', 0, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [
      inboxId,
      SANDBOX_ID,
      CONSUMER_NAME,
      childTriggerEventId,
      envelope.correlationId,
      occurredAt,
      JSON.stringify(envelope),
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.workflow_runs
       (id, sandbox_id, case_id, inbox_id, trigger_event_id, trigger_event_type,
        definition_name, definition_version, status, ingress, ingress_hash,
        effective_at, wait_reason, policy_revision, model_revision, config_revision,
        prompt_revision, active_ms_limit, active_ms_used, deadline_at,
        cancel_requested, resume_cause, cancel_cause, partial_effects, last_error,
        version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'nexus.case.created.v1', 'child-test', 'v1',
             'running', '{}'::jsonb, $6, clock_timestamp(), NULL, 'test', 'none',
             'test', NULL, 300000, 0, clock_timestamp() + interval '1 hour', false,
             NULL, NULL, '[]'::jsonb, NULL, 0, clock_timestamp(), clock_timestamp())`,
    [
      runId,
      SANDBOX_ID,
      childCaseId,
      inboxId,
      childTriggerEventId,
      'a'.repeat(64),
    ],
  );
  return runId;
}

async function insertPendingSibling(runId: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.workflow_steps
       (id, sandbox_id, run_id, step_key, step_kind, status, input_hash,
        output_hash, output, evidence_refs, attempt_count, max_attempts,
        error_class, started_at, finished_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, 'sibling', 'pure', 'pending', NULL, NULL, NULL,
             '[]'::jsonb, 0, 3, NULL, NULL, NULL, 0, clock_timestamp(),
             clock_timestamp())`,
    [id, SANDBOX_ID, runId],
  );
  return id;
}

async function readChildCase(
  childCaseId: string,
): Promise<{ status: string; version: number }> {
  return dbOne<{ status: string; version: number }>(
    'SELECT status, version FROM nexus.cases WHERE id = $1',
    [childCaseId],
  );
}

async function completeChild(
  childCaseId: string,
  status: 'resolved' | 'escalated' | 'cancelled',
): Promise<number> {
  const row = await dbOne<{ version: number }>(
    `UPDATE nexus.cases
     SET status = $2, version = version + 1, terminal_reason = $3,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING version`,
    [childCaseId, status, `test_${status}`],
  );
  return row.version;
}

async function createCompletionEvent(input: {
  caseId: string;
  terminalRunId: string;
  terminalTriggerEventId: string;
  terminalCaseVersion: number;
  terminalStatus: 'resolved' | 'escalated' | 'cancelled';
  sandboxId?: string;
}): Promise<void> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    eventId,
    eventType: 'nexus.case.completed.v1',
    schemaVersion: 1,
    occurredAt,
    sandboxId: input.sandboxId ?? SANDBOX_ID,
    correlationId: `f11a-complete-${randomUUID()}`,
    causationId: null,
    producer: 'worker',
    payload: {
      caseId: input.caseId,
      terminalRunId: input.terminalRunId,
      terminalTriggerEventId: input.terminalTriggerEventId,
      terminalCaseVersion: input.terminalCaseVersion,
      terminalStatus: input.terminalStatus,
      outcomeEvidenceIds: [],
    },
  };
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id, sandbox_id, consumer_name, event_id, event_type, producer,
        correlation_id, causation_id, occurred_at, envelope, dispatch_state,
        attempt_count, next_attempt_at, received_at, updated_at)
     VALUES ($1, $2, $3, $4, 'nexus.case.completed.v1', 'worker', $5, NULL,
             $6, $7::jsonb, 'pending', 0, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [
      randomUUID(),
      input.sandboxId ?? SANDBOX_ID,
      CONSUMER_NAME,
      eventId,
      envelope.correlationId,
      occurredAt,
      JSON.stringify(envelope),
    ],
  );
}

function dependencyDefinition(
  name: string,
  childCaseId: string,
  childTriggerEventId: string,
): WorkflowDefinition {
  return {
    name,
    version: 'v1',
    steps: [
      {
        key: 'wait',
        kind: 'pure',
        dependsOn: [],
        execute: async (context) =>
          context.resumeCause === 'dependency_retry'
            ? {
                status: 'succeeded',
                output: { resumed: true },
                evidenceRefs: [],
              }
            : {
                status: 'waiting',
                wait: {
                  kind: 'dependency',
                  childCaseId,
                  childTriggerEventId,
                },
                output: { waiting: true },
                evidenceRefs: [],
              },
      },
    ],
  };
}

function runnerFor(
  definitionName: string,
  definitionRegistry: WorkflowDefinitionRegistry,
): WorkflowRunner {
  return new WorkflowRunner({
    journal,
    registry: definitionRegistry,
    triggerMap: {
      'nexus.case.created.v1': { name: definitionName, version: 'v1' },
    },
    ownerId: `f11a-${randomUUID()}`,
    leaseMs: 1_000,
    heartbeatMs: 200,
    maxParallel: 4,
  });
}

async function scheduleAndRun(runner: WorkflowRunner): Promise<void> {
  const count = await runner.schedulePendingInbox(10);
  expect(count).toBeGreaterThanOrEqual(1);
  await runner.runOnce();
}

async function parentWait(): Promise<{
  parentRunId: string;
  parentCaseId: string;
  childCaseId: string;
  childTriggerEventId: string;
  childRunId: string;
  runner: WorkflowRunner;
}> {
  const childCaseId = await createCase('F11A child case');
  const childTriggerEventId = randomUUID();
  const childRunId = await createChildRun(childCaseId, childTriggerEventId);
  const parentCaseId = await createCase('F11A parent case');
  const name = `test-dependency-${randomUUID()}`;
  const definition = dependencyDefinition(
    name,
    childCaseId,
    childTriggerEventId,
  );
  const definitionRegistry = new WorkflowDefinitionRegistry([
    ...createTestWorkflowDefinitions(),
    definition,
  ]);
  const runner = runnerFor(name, definitionRegistry);
  await createInboxEvent(parentCaseId, 'F11A parent case');
  await scheduleAndRun(runner);
  const parent = await dbOne<{ id: string; status: string }>(
    'SELECT id, status FROM nexus.workflow_runs WHERE case_id = $1',
    [parentCaseId],
  );
  expect(parent.status).toBe('waiting_dependency');
  return {
    parentRunId: parent.id,
    parentCaseId,
    childCaseId,
    childTriggerEventId,
    childRunId,
    runner,
  };
}

beforeAll(async () => {
  superuser = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
      requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    ),
  );
  migrator = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    ),
  );
  await superuser.connect();
  await migrator.connect();
  await applyMigrations(migrator, {
    schema: 'nexus',
    migrations: loadMigrations(path.join(root, 'packages/db/migrations')),
  });
  workflowPool = new PgPool(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
    ),
  );
  apiPool = new PgPool(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
    ),
  );
  const db = createNexusDb(workflowPool);
  journal = createWorkflowJournal(db);
  control = createWorkflowControlStore(db);
  const apiControl = createWorkflowControlStore(createNexusDb(apiPool));
  resumeService = new ResumeService(apiControl);
  cancellationService = new CancellationService(apiControl);
}, 120_000);

afterAll(async () => {
  await apiPool?.end();
  await workflowPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.workflow_dependencies,
       nexus.workflow_attempt_evidence,
       nexus.workflow_step_attempts,
       nexus.workflow_steps,
       nexus.workflow_jobs,
       nexus.workflow_runs,
       nexus.event_inbox,
       nexus.event_outbox
     CASCADE`,
  );
});

describe('F11A waits, resume and cancellation', () => {
  it('persists a human wait across restart and resumes only with human input', async () => {
    const caseId = await createCase('Human wait case');
    const eventId = await createInboxEvent(caseId, 'Human wait case');
    const definitionRegistry = new WorkflowDefinitionRegistry(
      createTestWorkflowDefinitions(),
    );
    const firstRunner = runnerFor('test-wait', definitionRegistry);
    await scheduleAndRun(firstRunner);
    const run = await dbOne<{ id: string; status: string }>(
      'SELECT id, status FROM nexus.workflow_runs WHERE trigger_event_id = $1',
      [eventId],
    );
    expect(run.status).toBe('waiting_input');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_steps WHERE run_id = $1', [run.id])).status).toBe('waiting');
    await expect(
      resumeService.resume({
        sandboxId: SANDBOX_ID,
        runId: run.id,
        request: {
          cause: 'approval_completed',
          proposalId: randomUUID(),
          actionRevisionId: randomUUID(),
        },
        actor: { kind: 'human', id: 'operator', roles: ['operator'] },
        requestId: 'f11a-wrong-resume',
        correlationId: 'f11a-wrong-resume',
      }),
    ).rejects.toBeInstanceOf(RunControlError);

    const restartedRunner = runnerFor('test-wait', definitionRegistry);
    expect((await restartedRunner.runOnce()).status).toBe('idle');
    const resumed = await resumeService.resume({
      sandboxId: SANDBOX_ID,
      runId: run.id,
      request: { cause: 'human_input' },
      actor: { kind: 'human', id: 'operator', roles: ['operator'] },
      requestId: 'f11a-resume',
      correlationId: 'f11a-resume',
    });
    expect(resumed.status).toBe('queued');
    expect((await restartedRunner.runOnce()).status).toBe('completed');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [run.id])).status).toBe('completed');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [caseId])).status).toBe('resolved');
    const completedEvents = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.event_outbox WHERE event_type = 'nexus.case.completed.v1' AND aggregate_id = $1",
      [caseId],
    );
    expect(completedEvents.count).toBe(1);
    await expect(
      resumeService.resume({
        sandboxId: SANDBOX_ID,
        runId: run.id,
        request: { cause: 'human_input' },
        actor: { kind: 'human', id: 'operator', roles: ['operator'] },
        requestId: 'f11a-terminal-resume',
        correlationId: 'f11a-terminal-resume',
      }),
    ).rejects.toBeInstanceOf(RunControlError);
  });

  it('cancels a waiting run, releases its job and rejects resume after cancellation', async () => {
    const caseId = await createCase('Waiting cancellation case');
    const eventId = await createInboxEvent(caseId, 'Waiting cancellation case');
    const definitionRegistry = new WorkflowDefinitionRegistry(
      createTestWorkflowDefinitions(),
    );
    const runnerInstance = runnerFor('test-wait', definitionRegistry);
    await scheduleAndRun(runnerInstance);
    const run = await dbOne<{ id: string; status: string }>(
      'SELECT id, status FROM nexus.workflow_runs WHERE trigger_event_id = $1',
      [eventId],
    );
    const cancelled = await cancellationService.cancel({
      sandboxId: SANDBOX_ID,
      runId: run.id,
      request: { cause: 'operator_request' },
      actor: { kind: 'human', id: 'operator', roles: ['operator'] },
      requestId: 'f11a-cancel',
      correlationId: 'f11a-cancel',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.caseStatus).toBe('cancelled');
    const job = await dbOne<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM nexus.workflow_jobs WHERE run_id = $1',
      [run.id],
    );
    expect(job.lease_owner).toBeNull();
    expect(['succeeded', 'cancelled']).toContain(job.state);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [caseId])).status).toBe('cancelled');
    const completedEvents = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.event_outbox WHERE event_type = 'nexus.case.completed.v1' AND aggregate_id = $1",
      [caseId],
    );
    expect(completedEvents.count).toBe(1);
    await expect(
      resumeService.resume({
        sandboxId: SANDBOX_ID,
        runId: run.id,
        request: { cause: 'human_input' },
        actor: { kind: 'human', id: 'operator', roles: ['operator'] },
        requestId: 'f11a-cancel-resume',
        correlationId: 'f11a-cancel-resume',
      }),
    ).rejects.toBeInstanceOf(RunControlError);
    await expect(
      cancellationService.cancel({
        sandboxId: SANDBOX_ID,
        runId: run.id,
        request: { cause: 'operator_request' },
        actor: { kind: 'human', id: 'operator', roles: ['operator'] },
        requestId: 'f11a-cancel-duplicate',
        correlationId: 'f11a-cancel-duplicate',
      }),
    ).rejects.toBeInstanceOf(RunControlError);
  });

  it('ignores wrong child/version completions and resumes a parent exactly once on the exact event', async () => {
    const parent = await parentWait();
    const dependency = await dbOne<{ id: string; state: string }>(
      'SELECT id, state FROM nexus.workflow_dependencies WHERE parent_run_id = $1',
      [parent.parentRunId],
    );
    expect(dependency.state).toBe('waiting');

    const child = await readChildCase(parent.childCaseId);
    await createCompletionEvent({
      caseId: parent.childCaseId,
      terminalRunId: parent.childRunId,
      terminalTriggerEventId: parent.childTriggerEventId,
      terminalCaseVersion: child.version,
      terminalStatus: 'resolved',
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [parent.parentRunId])).status).toBe('waiting_dependency');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE id = $1', [dependency.id])).state).toBe('waiting');

    const wrongChild = await createCase('F11A wrong child');
    await createCompletionEvent({
      caseId: wrongChild,
      terminalRunId: parent.childRunId,
      terminalTriggerEventId: parent.childTriggerEventId,
      terminalCaseVersion: 1,
      terminalStatus: 'resolved',
    });
    const otherSandbox = await createSandbox('F11A other sandbox');
    await createCompletionEvent({
      caseId: parent.childCaseId,
      terminalRunId: parent.childRunId,
      terminalTriggerEventId: parent.childTriggerEventId,
      terminalCaseVersion: child.version,
      terminalStatus: 'resolved',
      sandboxId: otherSandbox,
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [parent.parentRunId])).status).toBe('waiting_dependency');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE id = $1', [dependency.id])).state).toBe('waiting');

    await completeChild(parent.childCaseId, 'resolved');
    const completedVersion = (await readChildCase(parent.childCaseId)).version;
    await createCompletionEvent({
      caseId: parent.childCaseId,
      terminalRunId: parent.childRunId,
      terminalTriggerEventId: parent.childTriggerEventId,
      terminalCaseVersion: completedVersion,
      terminalStatus: 'resolved',
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [parent.parentRunId])).status).toBe('queued');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE id = $1', [dependency.id])).state).toBe('resolved');
    expect((await parent.runner.runOnce()).status).toBe('completed');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [parent.parentCaseId])).status).toBe('resolved');

    const jobsBefore = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.workflow_jobs WHERE run_id = $1',
      [parent.parentRunId],
    );
    await createCompletionEvent({
      caseId: parent.childCaseId,
      terminalRunId: parent.childRunId,
      terminalTriggerEventId: parent.childTriggerEventId,
      terminalCaseVersion: completedVersion,
      terminalStatus: 'resolved',
    });
    await control.processDependencyEvents(10);
    const jobsAfter = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.workflow_jobs WHERE run_id = $1',
      [parent.parentRunId],
    );
    expect(jobsAfter.count).toBe(jobsBefore.count);
    expect((await parent.runner.runOnce()).status).toBe('idle');
  });

  it('escalates a parent on child escalation and on dependency timeout', async () => {
    const childEscalation = await parentWait();
    const siblingId = await insertPendingSibling(childEscalation.parentRunId);
    await completeChild(childEscalation.childCaseId, 'escalated');
    const escalatedVersion = (await readChildCase(childEscalation.childCaseId)).version;
    await createCompletionEvent({
      caseId: childEscalation.childCaseId,
      terminalRunId: childEscalation.childRunId,
      terminalTriggerEventId: childEscalation.childTriggerEventId,
      terminalCaseVersion: escalatedVersion,
      terminalStatus: 'escalated',
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [childEscalation.parentRunId])).status).toBe('cancelled');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [childEscalation.parentCaseId])).status).toBe('escalated');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE parent_run_id = $1', [childEscalation.parentRunId])).state).toBe('escalated');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_steps WHERE id = $1', [siblingId])).status).toBe('cancelled');

    const childCancellation = await parentWait();
    await completeChild(childCancellation.childCaseId, 'cancelled');
    const cancelledVersion = (await readChildCase(childCancellation.childCaseId)).version;
    await createCompletionEvent({
      caseId: childCancellation.childCaseId,
      terminalRunId: childCancellation.childRunId,
      terminalTriggerEventId: childCancellation.childTriggerEventId,
      terminalCaseVersion: cancelledVersion,
      terminalStatus: 'cancelled',
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [childCancellation.parentRunId])).status).toBe('cancelled');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [childCancellation.parentCaseId])).status).toBe('escalated');

    const expiredEvent = await parentWait();
    await superuser.query(
      `UPDATE nexus.workflow_dependencies
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE parent_run_id = $1`,
      [expiredEvent.parentRunId],
    );
    await completeChild(expiredEvent.childCaseId, 'resolved');
    const expiredVersion = (await readChildCase(expiredEvent.childCaseId)).version;
    await createCompletionEvent({
      caseId: expiredEvent.childCaseId,
      terminalRunId: expiredEvent.childRunId,
      terminalTriggerEventId: expiredEvent.childTriggerEventId,
      terminalCaseVersion: expiredVersion,
      terminalStatus: 'resolved',
    });
    await control.processDependencyEvents(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [expiredEvent.parentRunId])).status).toBe('cancelled');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [expiredEvent.parentCaseId])).status).toBe('escalated');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE parent_run_id = $1', [expiredEvent.parentRunId])).state).toBe('expired');

    const timeout = await parentWait();
    await superuser.query(
      `UPDATE nexus.workflow_dependencies
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE parent_run_id = $1`,
      [timeout.parentRunId],
    );
    await control.expireDependencies(10);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [timeout.parentRunId])).status).toBe('cancelled');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.cases WHERE id = $1', [timeout.parentCaseId])).status).toBe('escalated');
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.workflow_dependencies WHERE parent_run_id = $1', [timeout.parentRunId])).state).toBe('expired');
  });

  it('rejects a self-dependency instead of persisting a depth-two wait', async () => {
    const caseId = await createCase('Self dependency case');
    const eventId = await createInboxEvent(caseId, 'Self dependency case');
    const definition: WorkflowDefinition = {
      name: 'test-self-dependency',
      version: 'v1',
      steps: [
        {
          key: 'wait',
          kind: 'pure',
          dependsOn: [],
          execute: async () => ({
            status: 'waiting',
            wait: {
              kind: 'dependency',
              childCaseId: caseId,
              childTriggerEventId: randomUUID(),
            },
            output: { waiting: true },
            evidenceRefs: [],
          }),
        },
      ],
    };
    const definitionRegistry = new WorkflowDefinitionRegistry([
      ...createTestWorkflowDefinitions(),
      definition,
    ]);
    const runnerInstance = runnerFor('test-self-dependency', definitionRegistry);
    await scheduleAndRun(runnerInstance);
    const run = await dbOne<{ id: string; status: string }>(
      'SELECT id, status FROM nexus.workflow_runs WHERE trigger_event_id = $1',
      [eventId],
    );
    expect(run.status).toBe('failed');
    const step = await dbOne<{ status: string; error_class: string | null }>(
      'SELECT status, error_class FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(step).toMatchObject({
      status: 'permanent_failure',
      error_class: 'DEPENDENCY_SELF_LINK',
    });
    const dependencies = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.workflow_dependencies WHERE parent_run_id = $1',
      [run.id],
    );
    expect(dependencies).toHaveLength(0);
  });
});

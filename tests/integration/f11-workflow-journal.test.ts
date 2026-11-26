import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import {
  computeOutputHash,
  computeStepInputHash,
  type CommitStepInput,
  type WorkflowFaults,
} from '@nexus/application/workflows/journal';
import { WorkflowRunner } from '@nexus/application/workflows/runner';
import { createNexusDb } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createWorkflowJournal } from '@nexus/db/repositories/workflows';
import {
  SimulatedWorkerCrash,
  singleFault,
} from '../helpers/worker-faults.js';
import { waitFor } from '../helpers/event-faults.js';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workerEntry = path.join(root, 'apps/worker/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const CONSUMER_NAME = 'nexus.worker.events.v1';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F11`);
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
    application_name: 'f11-workflow-test',
    connectionTimeoutMillis: 5000,
  };
}

function workerEnv(): Record<string, string> {
  return {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_WORKER_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
    NEXUS_WORKER_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
    NEXUS_WORKFLOW_TEST_DEFINITION: '1',
    NEXUS_RABBIT_PASSWORD: '',
    RABBITMQ_DEFAULT_PASS: '',
  };
}

interface SpawnedWorker {
  readonly child: ChildProcess;
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  stop(): Promise<void>;
}

function spawnWorker(): SpawnedWorker {
  if (!existsSync(workerEntry)) {
    throw new Error('Compiled worker is missing; run pnpm build first');
  }
  const child = spawn(process.execPath, [workerEntry], {
    cwd: root,
    env: { ...process.env, ...workerEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    async waitForOutput(pattern, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = pattern.exec(stdout);
        if (match) {
          return match;
        }
        if (child.exitCode !== null) {
          throw new Error(`Worker exited early. stderr: ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${pattern}. stderr: ${stderr}`);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

let superuser: Client;
let migrator: Client;
let workflowPool: PgPoolType;
let workflowDb: ReturnType<typeof createNexusDb>;
let journal: ReturnType<typeof createWorkflowJournal>;

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

async function createCase(title = 'F11 workflow case'): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases
       (id, sandbox_id, title, summary, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, 'new', 1, clock_timestamp(), clock_timestamp())`,
    [id, SANDBOX_ID, title],
  );
  return id;
}

async function createEvidence(caseId: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, content_hash, captured_facts)
     VALUES ($1, $2, $3, 'calculation', 'available', $4, '{}'::jsonb)`,
    [id, SANDBOX_ID, caseId, 'a'.repeat(64)],
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

async function createEvidenceInSandbox(
  sandboxId: string,
  caseId: string | null,
): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, content_hash, captured_facts)
     VALUES ($1, $2, $3, 'calculation', 'available', $4, '{}'::jsonb)`,
    [id, sandboxId, caseId, 'b'.repeat(64)],
  );
  return id;
}

async function createInboxEvent(
  caseId: string,
  title = 'F11 workflow case',
): Promise<string> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    eventId,
    eventType: 'nexus.case.created.v1',
    schemaVersion: 1,
    occurredAt,
    sandboxId: SANDBOX_ID,
    correlationId: `f11-${randomUUID()}`,
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

function registry(definitions: readonly WorkflowDefinition[] = createTestWorkflowDefinitions()): WorkflowDefinitionRegistry {
  return new WorkflowDefinitionRegistry(definitions);
}

function triggerMap(name: string, version = 'v1'): Record<string, { name: string; version: string }> {
  return {
    'nexus.case.created.v1': { name, version },
  };
}

function runner(
  options: {
    readonly definitionRegistry?: WorkflowDefinitionRegistry;
    readonly trigger?: Record<string, { name: string; version: string }>;
    readonly faults?: WorkflowFaults;
    readonly ownerId?: string;
  } = {},
): WorkflowRunner {
  return new WorkflowRunner({
    journal,
    registry: options.definitionRegistry ?? registry(),
    triggerMap: options.trigger ?? triggerMap('test-three-step'),
    ownerId: options.ownerId ?? `f11-test-${randomUUID()}`,
    leaseMs: 1_000,
    heartbeatMs: 200,
    maxParallel: 4,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
}

async function schedule(runnerInstance: WorkflowRunner): Promise<void> {
  const count = await runnerInstance.schedulePendingInbox(10);
  expect(count).toBeGreaterThanOrEqual(1);
}

async function expireLease(runId: string): Promise<void> {
  await superuser.query(
    `UPDATE nexus.workflow_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE run_id = $1 AND state = 'leased'`,
    [runId],
  );
}

async function makeJobAvailable(runId: string): Promise<void> {
  await superuser.query(
    `UPDATE nexus.workflow_jobs
     SET available_at = clock_timestamp() - interval '1 second'
     WHERE run_id = $1 AND state = 'pending'`,
    [runId],
  );
}

interface RunRow {
  id: string;
  status: string;
  wait_reason: unknown;
  active_ms_used: number;
  last_error: string | null;
}

async function runByTrigger(eventId: string): Promise<RunRow> {
  return dbOne<RunRow>(
    'SELECT id, status, wait_reason, active_ms_used, last_error FROM nexus.workflow_runs WHERE trigger_event_id = $1',
    [eventId],
  );
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
  workflowDb = createNexusDb(workflowPool);
  journal = createWorkflowJournal(workflowDb);
}, 120_000);

afterAll(async () => {
  await workflowPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.workflow_attempt_evidence,
       nexus.workflow_step_attempts,
       nexus.workflow_steps,
       nexus.workflow_jobs,
       nexus.workflow_runs,
       nexus.event_inbox
     CASCADE`,
  );
});

describe('F11 workflow journal, jobs and leases', () => {
  it('runs a three-step deterministic workflow from the pending inbox through the worker', async () => {
    const worker = spawnWorker();
    try {
      await worker.waitForOutput(/NEXUS_WORKER_READY/);
      const caseId = await createCase('Worker three-step case');
      const eventId = await createInboxEvent(caseId, 'Worker three-step case');
      const run = await waitFor(
        async () => {
          const row = await dbAll<RunRow>(
            'SELECT id, status, wait_reason, active_ms_used, last_error FROM nexus.workflow_runs WHERE trigger_event_id = $1',
            [eventId],
          );
          return row[0]?.status === 'completed' ? row[0] : null;
        },
        { timeoutMs: 20_000 },
      );
      expect(run.active_ms_used).toBeGreaterThan(0);
      const steps = await dbAll<{ step_key: string; status: string; attempt_count: number; output: unknown }>(
        'SELECT step_key, status, attempt_count, output FROM nexus.workflow_steps WHERE run_id = $1 ORDER BY step_key',
        [run.id],
      );
      expect(steps.map((step) => step.step_key)).toEqual(['alpha', 'beta', 'join']);
      expect(steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(steps.map((step) => step.attempt_count)).toEqual([1, 1, 1]);
      expect(steps[2]?.output).toMatchObject({ joined: 'alpha|beta' });
      const job = await dbOne<{ state: string; lease_owner: string | null }>(
        'SELECT state, lease_owner FROM nexus.workflow_jobs WHERE run_id = $1',
        [run.id],
      );
      expect(job.state).toBe('succeeded');
      expect(job.lease_owner).toBeNull();
      const inbox = await dbOne<{ dispatch_state: string }>(
        'SELECT dispatch_state FROM nexus.event_inbox WHERE event_id = $1',
        [eventId],
      );
      expect(inbox.dispatch_state).toBe('scheduled');
      const traces = await dbOne<{ count: number }>(
        "SELECT count(*)::int AS count FROM nexus.trace_events WHERE run_id = $1 AND event = 'workflow.step.succeeded'",
        [run.id],
      );
      expect(traces.count).toBe(3);
    } finally {
      await worker.stop();
    }
  });

  it('deduplicates a repeated trigger without a second run or job', async () => {
    const caseId = await createCase('Duplicate trigger case');
    const eventId = await createInboxEvent(caseId, 'Duplicate trigger case');
    const runnerInstance = runner();
    await schedule(runnerInstance);
    const firstRun = await runByTrigger(eventId);
    await superuser.query(
      "UPDATE nexus.event_inbox SET dispatch_state = 'pending' WHERE event_id = $1",
      [eventId],
    );
    await schedule(runnerInstance);
    const runs = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.workflow_runs WHERE trigger_event_id = $1',
      [eventId],
    );
    const jobs = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.workflow_jobs WHERE run_id = $1',
      [firstRun.id],
    );
    expect(runs).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('reuses a committed pure step after a crash and completes from the lease reclaim', async () => {
    const caseId = await createCase('Crash after commit case');
    const eventId = await createInboxEvent(caseId, 'Crash after commit case');
    const firstRunner = runner({
      faults: singleFault('after_step_commit', 'beta'),
      ownerId: 'f11-owner-a',
    });
    await schedule(firstRunner);
    const run = await runByTrigger(eventId);
    await expect(firstRunner.runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);

    const committed = await dbAll<{ step_key: string; status: string; attempt_count: number }>(
      'SELECT step_key, status, attempt_count FROM nexus.workflow_steps WHERE run_id = $1 ORDER BY step_key',
      [run.id],
    );
    expect(committed.map((step) => step.step_key)).toEqual(['alpha', 'beta', 'join']);
    expect(committed.find((step) => step.step_key === 'alpha')?.status).toBe('succeeded');
    expect(committed.find((step) => step.step_key === 'beta')?.status).toBe('succeeded');
    expect(committed.find((step) => step.step_key === 'join')?.status).toBe('pending');

    await expireLease(run.id);
    const secondRunner = runner({ ownerId: 'f11-owner-b' });
    const result = await secondRunner.runOnce();
    expect(result.status).toBe('completed');

    const after = await dbAll<{ step_key: string; status: string; attempt_count: number }>(
      'SELECT step_key, status, attempt_count FROM nexus.workflow_steps WHERE run_id = $1 ORDER BY step_key',
      [run.id],
    );
    expect(after.map((step) => step.attempt_count)).toEqual([1, 1, 1]);
    expect(after.every((step) => step.status === 'succeeded')).toBe(true);
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [run.id])).status).toBe('completed');
  });

  it('restarts before any pure step commit without duplicating attempts', async () => {
    const caseId = await createCase('Crash before commit case');
    const eventId = await createInboxEvent(caseId, 'Crash before commit case');
    const firstRunner = runner({
      faults: singleFault('before_step_commit', 'alpha'),
      ownerId: 'f11-owner-before',
    });
    await schedule(firstRunner);
    const run = await runByTrigger(eventId);
    await expect(firstRunner.runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);
    const before = await dbAll<{ status: string }>(
      'SELECT status FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(before.every((step) => step.status === 'pending')).toBe(true);

    await expireLease(run.id);
    const secondRunner = runner({ ownerId: 'f11-owner-after' });
    expect((await secondRunner.runOnce()).status).toBe('completed');
    const attempts = await dbAll<{ attempt_count: number }>(
      'SELECT attempt_count FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(attempts.map((step) => step.attempt_count)).toEqual([1, 1, 1]);
  });

  it('rejects a stale worker commit after lease theft and lets the new fence complete', async () => {
    const caseId = await createCase('Lease theft case');
    await createInboxEvent(caseId, 'Lease theft case');
    await schedule(runner());
    const claimA = await journal.claimJob('f11-lease-a', 5_000);
    expect(claimA).not.toBeNull();
    if (!claimA) {
      throw new Error('Expected claim A');
    }
    await superuser.query(
      `UPDATE nexus.workflow_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [claimA.jobId],
    );
    const claimB = await journal.claimJob('f11-lease-b', 5_000);
    expect(claimB).not.toBeNull();
    if (!claimB) {
      throw new Error('Expected claim B');
    }
    expect(claimB.fencingToken).toBe(claimA.fencingToken + 1);

    const context = await journal.loadContext(claimB);
    const alpha = context.steps.get('alpha');
    expect(alpha).toBeDefined();
    const inputHash = computeStepInputHash({
      definitionName: 'test-three-step',
      definitionVersion: 'v1',
      ingressHash: context.run.ingressHash,
      stepKey: 'alpha',
      dependencies: [],
    });
    const output = { value: 'stale' };
    const staleInput: CommitStepInput = {
      claim: claimA,
      context,
      stepKey: 'alpha',
      stepKind: 'pure',
      inputHash,
      attemptNo: 1,
      maxAttempts: 3,
      outcomeStatus: 'succeeded',
      output,
      outputHash: computeOutputHash(output),
      evidenceRefs: [],
      errorClass: null,
      waitReason: null,
      runStatusAfter: 'running',
      jobAction: 'continue',
      caseStatusAfter: 'investigating',
      retryAt: null,
      dependencyKeys: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      activeMs: 1,
    };
    await expect(journal.commitStep(staleInput)).rejects.toMatchObject({
      name: 'LeaseLostError',
    });
    await superuser.query(
      `UPDATE nexus.workflow_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [claimB.jobId],
    );
    const finalRunner = runner({ ownerId: 'f11-lease-final' });
    expect((await finalRunner.runOnce()).status).toBe('completed');
  });

  it('exhausts a retryable pure step after three attempts and fails the run', async () => {
    const caseId = await createCase('Attempt exhaustion case');
    const eventId = await createInboxEvent(caseId, 'Attempt exhaustion case');
    const runnerInstance = runner({ trigger: triggerMap('test-retry') });
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runnerInstance.runOnce();
      if (attempt < 3) {
        expect(result.status).toBe('retry_scheduled');
        await makeJobAvailable(run.id);
      } else {
        expect(result.status).toBe('failed');
      }
    }
    const step = await dbOne<{ status: string; attempt_count: number; error_class: string | null }>(
      'SELECT status, attempt_count, error_class FROM nexus.workflow_steps WHERE run_id = $1 AND step_key = $2',
      [run.id, 'flaky'],
    );
    expect(step.status).toBe('permanent_failure');
    expect(step.attempt_count).toBe(3);
    expect(step.error_class).toBe('TEST_TRANSIENT');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [run.id])).status).toBe('failed');
    const attempts = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.workflow_step_attempts WHERE run_id = $1',
      [run.id],
    );
    expect(attempts.count).toBe(3);
  });

  it('never generically retries an external step', async () => {
    const caseId = await createCase('External retry case');
    const eventId = await createInboxEvent(caseId, 'External retry case');
    const runnerInstance = runner({ trigger: triggerMap('test-external') });
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    expect((await runnerInstance.runOnce()).status).toBe('failed');
    const step = await dbOne<{ status: string; attempt_count: number; error_class: string | null }>(
      'SELECT status, attempt_count, error_class FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(step.status).toBe('permanent_failure');
    expect(step.attempt_count).toBe(1);
    expect(step.error_class).toBe('EXTERNAL_RETRY_FORBIDDEN');
  });

  it('persists a typed wait and releases the lease', async () => {
    const caseId = await createCase('Persisted wait case');
    const eventId = await createInboxEvent(caseId, 'Persisted wait case');
    const runnerInstance = runner({ trigger: triggerMap('test-wait') });
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    expect((await runnerInstance.runOnce()).status).toBe('waiting');
    const step = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(step.status).toBe('waiting');
    const status = await dbOne<{ status: string; wait_reason: unknown }>(
      'SELECT status, wait_reason FROM nexus.workflow_runs WHERE id = $1',
      [run.id],
    );
    expect(status.status).toBe('waiting_input');
    expect(status.wait_reason).toMatchObject({ kind: 'human_input' });
    const job = await dbOne<{ state: string; lease_owner: string | null }>(
      'SELECT state, lease_owner FROM nexus.workflow_jobs WHERE run_id = $1',
      [run.id],
    );
    expect(job.state).toBe('succeeded');
    expect(job.lease_owner).toBeNull();
    expect((await runnerInstance.runOnce()).status).toBe('idle');
  });

  it('marks a run budget_exhausted when its deadline has passed', async () => {
    const caseId = await createCase('Deadline case');
    const eventId = await createInboxEvent(caseId, 'Deadline case');
    const runnerInstance = runner();
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    await superuser.query(
      `UPDATE nexus.workflow_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    expect((await runnerInstance.runOnce()).status).toBe('budget_exhausted');
    expect((await dbOne<{ status: string }>('SELECT status FROM nexus.workflow_runs WHERE id = $1', [run.id])).status).toBe('budget_exhausted');
    const job = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.workflow_jobs WHERE run_id = $1',
      [run.id],
    );
    expect(job.state).toBe('failed');
  });

  it('blocks an unknown definition version and schedules the inbox row without a job', async () => {
    const caseId = await createCase('Unknown definition case');
    const eventId = await createInboxEvent(caseId, 'Unknown definition case');
    const runnerInstance = runner({ trigger: triggerMap('test-three-step', 'v9') });
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    expect(run.status).toBe('blocked');
    expect(run.last_error).toBe('UNKNOWN_DEFINITION');
    const jobs = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.workflow_jobs WHERE run_id = $1',
      [run.id],
    );
    expect(jobs).toHaveLength(0);
    const inbox = await dbOne<{ dispatch_state: string }>(
      'SELECT dispatch_state FROM nexus.event_inbox WHERE event_id = $1',
      [eventId],
    );
    expect(inbox.dispatch_state).toBe('scheduled');
  });

  it('persists an attempt evidence join and a typed trace reference', async () => {
    const caseId = await createCase('Evidence join case');
    const evidenceId = await createEvidence(caseId);
    const definition: WorkflowDefinition = {
      name: 'test-evidence',
      version: 'v1',
      steps: [
        {
          key: 'evidence',
          kind: 'pure',
          dependsOn: [],
          execute: async () => ({
            status: 'succeeded',
            output: { evidence: 'linked' },
            evidenceRefs: [evidenceId],
          }),
        },
      ],
    };
    const runnerInstance = runner({
      definitionRegistry: registry([...createTestWorkflowDefinitions(), definition]),
      trigger: triggerMap('test-evidence'),
    });
    const eventId = await createInboxEvent(caseId, 'Evidence join case');
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    expect((await runnerInstance.runOnce()).status).toBe('completed');
    const joins = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM nexus.workflow_attempt_evidence AS evidence
       JOIN nexus.workflow_step_attempts AS attempt ON attempt.id = evidence.attempt_id
       WHERE attempt.run_id = $1 AND evidence.evidence_id = $2`,
      [run.id, evidenceId],
    );
    expect(joins.count).toBe(1);
    const trace = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.trace_events WHERE run_id = $1 AND event = 'workflow.step.succeeded'",
      [run.id],
    );
    expect(trace.count).toBe(1);
  });

  it('persists budget exhaustion that happens during a step instead of rolling it back', async () => {
    const caseId = await createCase('Slow deadline case');
    const slowDefinition: WorkflowDefinition = {
      name: 'test-slow',
      version: 'v1',
      steps: [
        {
          key: 'slow',
          kind: 'pure',
          dependsOn: [],
          timeoutMs: 3_000,
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            return {
              status: 'succeeded',
              output: { slow: true },
              evidenceRefs: [],
            };
          },
        },
      ],
    };
    const runnerInstance = runner({
      definitionRegistry: registry([...createTestWorkflowDefinitions(), slowDefinition]),
      trigger: triggerMap('test-slow'),
    });
    const eventId = await createInboxEvent(caseId, 'Slow deadline case');
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    await superuser.query(
      `UPDATE nexus.workflow_runs SET deadline_at = clock_timestamp() + interval '500 milliseconds' WHERE id = $1`,
      [run.id],
    );
    expect((await runnerInstance.runOnce()).status).toBe('budget_exhausted');
    const status = await dbOne<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM nexus.workflow_runs WHERE id = $1',
      [run.id],
    );
    expect(status.status).toBe('budget_exhausted');
    expect(status.last_error).toBe('DEADLINE_EXCEEDED');
    const job = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.workflow_jobs WHERE run_id = $1',
      [run.id],
    );
    expect(job.state).toBe('failed');
    const trace = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.trace_events WHERE run_id = $1 AND event = 'workflow.run.budget_exhausted'",
      [run.id],
    );
    expect(trace.count).toBe(1);
    const steps = await dbAll<{ status: string }>(
      'SELECT status FROM nexus.workflow_steps WHERE run_id = $1',
      [run.id],
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('pending');
  });

  it('rejects a final step that would exceed the active-time ceiling', async () => {
    const caseId = await createCase('Active ceiling case');
    const activeDefinition: WorkflowDefinition = {
      name: 'test-active',
      version: 'v1',
      steps: [
        {
          key: 'active',
          kind: 'pure',
          dependsOn: [],
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              status: 'succeeded',
              output: { active: true },
              evidenceRefs: [],
            };
          },
        },
      ],
    };
    const runnerInstance = runner({
      definitionRegistry: registry([...createTestWorkflowDefinitions(), activeDefinition]),
      trigger: triggerMap('test-active'),
    });
    const eventId = await createInboxEvent(caseId, 'Active ceiling case');
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    await superuser.query(
      'UPDATE nexus.workflow_runs SET active_ms_limit = 1 WHERE id = $1',
      [run.id],
    );
    expect((await runnerInstance.runOnce()).status).toBe('budget_exhausted');
    expect((await dbOne<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM nexus.workflow_runs WHERE id = $1',
      [run.id],
    ))).toMatchObject({ status: 'budget_exhausted', last_error: 'ACTIVE_LIMIT_EXCEEDED' });
  });

  it('records active-time pre-check exhaustion with the active error class', async () => {
    const caseId = await createCase('Active pre-check case');
    const runnerInstance = runner();
    const eventId = await createInboxEvent(caseId, 'Active pre-check case');
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    await superuser.query(
      'UPDATE nexus.workflow_runs SET active_ms_limit = 1, active_ms_used = 1 WHERE id = $1',
      [run.id],
    );
    expect((await runnerInstance.runOnce()).status).toBe('budget_exhausted');
    expect((await dbOne<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM nexus.workflow_runs WHERE id = $1',
      [run.id],
    ))).toMatchObject({
      status: 'budget_exhausted',
      last_error: 'ACTIVE_LIMIT_EXCEEDED',
    });
  });

  it('refuses a completed job whose deadline passed before the completion commit', async () => {
    const caseId = await createCase('Completion deadline case');
    const eventId = await createInboxEvent(caseId, 'Completion deadline case');
    const runnerInstance = runner();
    await schedule(runnerInstance);
    const run = await runByTrigger(eventId);
    const claim = await journal.claimJob('f11-completion-deadline', 5_000);
    expect(claim).not.toBeNull();
    if (!claim) {
      throw new Error('Expected completion claim');
    }
    await superuser.query(
      `UPDATE nexus.workflow_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    const completed = await journal.completeJob({
      claim,
      runStatus: 'completed',
      jobState: 'succeeded',
      caseStatusAfter: 'resolved',
    });
    expect(completed).toMatchObject({
      runStatus: 'budget_exhausted',
      jobState: 'failed',
    });
    expect((await dbOne<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM nexus.workflow_runs WHERE id = $1',
      [run.id],
    ))).toMatchObject({
      status: 'budget_exhausted',
      last_error: 'DEADLINE_EXCEEDED',
    });
  });

  it('journals invalid, duplicate and cross-sandbox evidence as a permanent failure', async () => {
    const validEvidence = await createEvidence(await createCase('Valid evidence owner'));
    const otherSandbox = await createSandbox('Other sandbox');
    const crossSandboxEvidence = await createEvidenceInSandbox(otherSandbox, null);
    const cases: Array<{ name: string; refs: string[]; waiting?: boolean }> = [
      { name: 'test-evidence-missing', refs: [randomUUID()] },
      { name: 'test-evidence-duplicate', refs: [validEvidence, validEvidence] },
      { name: 'test-evidence-cross', refs: [crossSandboxEvidence] },
      { name: 'test-evidence-waiting', refs: [randomUUID()], waiting: true },
    ];
    for (const item of cases) {
      const caseId = await createCase(`Evidence failure ${item.name}`);
      const definition: WorkflowDefinition = {
        name: item.name,
        version: 'v1',
        steps: [
          {
            key: 'evidence',
            kind: 'pure',
            dependsOn: [],
            execute: async () =>
              item.waiting === true
                ? {
                    status: 'waiting',
                    wait: { kind: 'human_input', prompt: 'Invalid evidence wait' },
                    evidenceRefs: item.refs,
                  }
                : {
                    status: 'succeeded',
                    output: { evidence: 'invalid' },
                    evidenceRefs: item.refs,
                  },
          },
        ],
      };
      const runnerInstance = runner({
        definitionRegistry: registry([...createTestWorkflowDefinitions(), definition]),
        trigger: triggerMap(item.name),
      });
      const eventId = await createInboxEvent(caseId, `Evidence failure ${item.name}`);
      await schedule(runnerInstance);
      const run = await runByTrigger(eventId);
      expect((await runnerInstance.runOnce()).status).toBe('failed');
      const step = await dbOne<{ status: string; attempt_count: number; error_class: string | null }>(
        'SELECT status, attempt_count, error_class FROM nexus.workflow_steps WHERE run_id = $1',
        [run.id],
      );
      expect(step).toMatchObject({
        status: 'permanent_failure',
        attempt_count: 1,
        error_class: 'INVALID_EVIDENCE_REF',
      });
      expect((await dbOne<{ status: string }>(
        'SELECT status FROM nexus.workflow_runs WHERE id = $1',
        [run.id],
      )).status).toBe('failed');
      const joins = await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM nexus.workflow_attempt_evidence AS evidence
         JOIN nexus.workflow_step_attempts AS attempt ON attempt.id = evidence.attempt_id
         WHERE attempt.run_id = $1`,
        [run.id],
      );
      expect(joins.count).toBe(0);
    }
  });
});

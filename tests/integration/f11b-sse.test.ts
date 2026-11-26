import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, PoolConfig, Pool as PgPoolType } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunDetailSchema,
  RunEventSchema,
  RunEventsPageSchema,
  type RunEvent,
} from '@nexus/contracts';
import {
  WorkflowDefinitionRegistry,
  createTestWorkflowDefinitions,
} from '@nexus/application/workflows/definitions';
import { WorkflowRunner } from '@nexus/application/workflows/runner';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createWorkflowJournal } from '@nexus/db/repositories/workflows';
import { appendTraceEventInTransaction } from '@nexus/db/repositories/trace';
import { RoleSchema } from '@nexus/contracts';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const CONSUMER_NAME = 'nexus.worker.events.v1';
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f11b-test-password-only';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F11B`);
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
    application_name: 'f11b-sse-test',
    connectionTimeoutMillis: 5000,
  };
}

function apiEnv(): Record<string, string> {
  return {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
    VALKEY_HOST: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
    VALKEY_PORT: requiredEnv('NEXUS_TEST_VALKEY_PORT'),
    VALKEY_PASSWORD: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
    NEXUS_ALLOWED_ORIGINS: allowedOrigin,
    NEXUS_COOKIE_SECURE: 'false',
    NEXUS_SSE_POLL_MS: '30',
    NEXUS_SSE_HEARTBEAT_MS: '30',
    NEXUS_SSE_MAX_BUFFER_BYTES: '1048576',
    NEXUS_RABBIT_PASSWORD: '',
    RABBITMQ_DEFAULT_PASS: '',
  };
}

interface SpawnedApi {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

async function startApi(overrides: Record<string, string> = {}): Promise<SpawnedApi> {
  if (!existsSync(apiEntry)) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: { ...process.env, PORT: '0', ...apiEnv(), ...overrides },
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
  const deadline = Date.now() + 20_000;
  let baseUrl = '';
  while (Date.now() < deadline) {
    const match = /NEXUS_API_READY port=(\d+)/.exec(stdout);
    if (match) {
      baseUrl = `http://127.0.0.1:${match[1]}`;
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`API exited early. stderr: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (baseUrl === '') {
    child.kill('SIGKILL');
    throw new Error(`API did not become ready. stderr: ${stderr}`);
  }
  return {
    child,
    baseUrl,
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
let api: SpawnedApi;
let operator: Session;

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

async function seedIdentity(): Promise<void> {
  const existing = await dbAll<{ count: number }>(
    'SELECT count(*)::int AS count FROM nexus.users',
  );
  if ((existing[0]?.count ?? 0) > 0) {
    return;
  }
  const fixture = JSON.parse(
    readFileSync(path.join(root, 'fixtures/users/roles.json'), 'utf8'),
  ) as { users: Array<{ username: string; displayName: string; roles: string[] }> };
  const pool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  try {
    const db = createNexusDb(pool);
    for (const user of fixture.users) {
      await createIdentityUser(db, {
        username: user.username,
        displayName: user.displayName,
        roles: RoleSchema.array().parse(user.roles),
        password: await hashPassword(testPassword),
      });
    }
  } finally {
    await pool.end();
  }
}

async function requestJson(
  baseUrl: string,
  route: string,
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Cookie: cookie },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function login(baseUrl: string, username: string): Promise<Session> {
  const csrfResponse = await fetch(`${baseUrl}/api/v1/auth/csrf`);
  const challenge = (await csrfResponse.json()) as { csrfToken: string };
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      'X-CSRF-Token': challenge.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password: testPassword }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie?.()[0]?.split(';')[0] ?? '';
  const body = (await response.json()) as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

class SseStream {
  readonly events: RunEvent[] = [];
  comments = 0;
  status = 0;
  ended = false;
  #request: http.ClientRequest | null = null;
  #response: http.IncomingMessage | null = null;
  #buffer = '';
  #endWaiters = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly cookie: string,
    private readonly lastEventId?: number,
    private readonly autoCloseAfter?: number,
  ) {}

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = { Cookie: this.cookie };
      if (this.lastEventId !== undefined) {
        headers['Last-Event-ID'] = String(this.lastEventId);
      }
      const request = http.request(this.url, { headers }, (response) => {
        this.#response = response;
        this.status = response.statusCode ?? 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (this.status !== 200) {
            return;
          }
          this.#buffer += chunk;
          this.#parse();
        });
        response.on('end', () => {
          this.ended = true;
          for (const resolve of this.#endWaiters) {
            resolve();
          }
          this.#endWaiters.clear();
        });
        response.on('close', () => {
          this.ended = true;
          for (const resolve of this.#endWaiters) {
            resolve();
          }
          this.#endWaiters.clear();
        });
        resolve();
      });
      request.on('error', reject);
      request.end();
      this.#request = request;
    });
  }

  #parse(): void {
    let boundary = this.#buffer.indexOf('\n\n');
    while (boundary >= 0 && !this.ended) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      this.#handleFrame(frame);
      boundary = this.#buffer.indexOf('\n\n');
    }
  }

  #handleFrame(frame: string): void {
    let id: number | null = null;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) {
        this.comments += 1;
      } else if (line.startsWith('id:')) {
        id = Number(line.slice(3).trim());
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (id === null || event === null || dataLines.length === 0) {
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    const parsed = RunEventSchema.safeParse({ id, event, data });
    if (parsed.success) {
      this.events.push(parsed.data);
      if (
        this.autoCloseAfter !== undefined &&
        this.events.length >= this.autoCloseAfter
      ) {
        this.close();
      }
    }
  }

  async waitFor(
    predicate: (stream: SseStream) => boolean,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this)) {
        return;
      }
      if (this.ended) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the SSE condition');
  }

  async waitForEnd(timeoutMs = 10_000): Promise<void> {
    if (this.ended) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#endWaiters.add(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  pause(): void {
    this.#response?.pause();
  }

  resume(): void {
    this.#response?.resume();
  }

  close(): void {
    this.#response?.destroy();
    this.#request?.destroy();
    this.ended = true;
  }
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

async function createInboxEvent(caseId: string, title: string): Promise<string> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope = {
    eventId,
    eventType: 'nexus.case.created.v1',
    schemaVersion: 1,
    occurredAt,
    sandboxId: SANDBOX_ID,
    correlationId: `f11b-${randomUUID()}`,
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

function runner(): WorkflowRunner {
  return new WorkflowRunner({
    journal,
    registry: new WorkflowDefinitionRegistry(createTestWorkflowDefinitions()),
    triggerMap: {
      'nexus.case.created.v1': { name: 'test-three-step', version: 'v1' },
    },
    ownerId: `f11b-${randomUUID()}`,
    leaseMs: 1_000,
    heartbeatMs: 200,
    maxParallel: 4,
  });
}

async function createRun(options: { readonly run?: boolean } = {}): Promise<{
  runId: string;
  caseId: string;
  eventId: string;
}> {
  const caseId = await createCase('F11B read case');
  const eventId = await createInboxEvent(caseId, 'F11B read case');
  const runnerInstance = runner();
  await runnerInstance.schedulePendingInbox(10);
  if (options.run !== false) {
    await runnerInstance.runOnce();
  }
  const run = await dbOne<{ id: string }>(
    'SELECT id FROM nexus.workflow_runs WHERE trigger_event_id = $1',
    [eventId],
  );
  return { runId: run.id, caseId, eventId };
}

async function addTraceEvents(runId: string, count: number): Promise<void> {
  await workflowDb.transaction(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      await appendTraceEventInTransaction(tx, {
        sandboxId: SANDBOX_ID,
        runId,
        level: 'info',
        event: 'workflow.run.running',
        data: { status: 'running', attempt: index },
      });
    }
  });
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
  await seedIdentity();
  api = await startApi();
  operator = await login(api.baseUrl, 'operator');
}, 120_000);

afterAll(async () => {
  await api?.stop();
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
       nexus.event_inbox,
       nexus.event_outbox
     CASCADE`,
  );
});

describe('F11B run read API and persisted SSE', () => {
  it('returns run detail and ordered bounded event pages', async () => {
    const { runId, caseId } = await createRun();
    const detailResponse = await requestJson(
      api.baseUrl,
      `/api/v1/runs/${runId}`,
      operator.cookie,
    );
    expect(detailResponse.status).toBe(200);
    const detail = RunDetailSchema.parse(detailResponse.body);
    expect(detail).toMatchObject({
      id: runId,
      caseId,
      caseStatus: 'resolved',
      status: 'completed',
    });
    expect(detail.steps.map((step) => step.stepKey)).toEqual([
      'alpha',
      'beta',
      'join',
    ]);

    const pageResponse = await requestJson(
      api.baseUrl,
      `/api/v1/runs/${runId}/events/page?limit=3`,
      operator.cookie,
    );
    expect(pageResponse.status).toBe(200);
    const page = RunEventsPageSchema.parse(pageResponse.body);
    expect(page.items.length).toBeLessThanOrEqual(3);
    expect(page.items.length).toBeGreaterThan(0);
    for (let index = 1; index < page.items.length; index += 1) {
      expect(page.items[index]!.id).toBeGreaterThan(page.items[index - 1]!.id);
    }
    expect(page.nextAfter).not.toBeNull();
    const after = page.nextAfter ?? 0;
    const nextPage = RunEventsPageSchema.parse(
      (
        await requestJson(
          api.baseUrl,
          `/api/v1/runs/${runId}/events/page?after=${after}&limit=200`,
          operator.cookie,
        )
      ).body,
    );
    expect(nextPage.items.every((event) => event.id > after)).toBe(true);
  });

  it('replays persisted events across Last-Event-ID reconnect without gaps or duplicates', async () => {
    const { runId } = await createRun();
    const first = new SseStream(
      `${api.baseUrl}/api/v1/runs/${runId}/events`,
      operator.cookie,
      undefined,
      3,
    );
    await first.open();
    expect(first.status).toBe(200);
    await first.waitFor((stream) => stream.events.length >= 3);
    first.close();
    const firstIds = first.events.map((event) => event.id);
    const lastId = firstIds[firstIds.length - 1] ?? 0;

    const second = new SseStream(
      `${api.baseUrl}/api/v1/runs/${runId}/events`,
      operator.cookie,
      lastId,
    );
    await second.open();
    expect(second.status).toBe(200);
    await second.waitFor((stream) =>
      stream.events.some((event) => event.event === 'final'),
    );
    second.close();

    const combined = [...first.events, ...second.events];
    const ids = combined.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]!).toBeGreaterThan(ids[index - 1]!);
    }
    expect(combined.some((event) => event.event === 'final')).toBe(true);
    const page = RunEventsPageSchema.parse(
      (
        await requestJson(
          api.baseUrl,
          `/api/v1/runs/${runId}/events/page?limit=200`,
          operator.cookie,
        )
      ).body,
    );
    expect(ids).toEqual(page.items.map((event) => event.id));
  });

  it('does not persist SSE heartbeats as audit or trace rows', async () => {
    const { runId } = await createRun();
    const before = await dbOne<{ audit: number; trace: number }>(
      `SELECT
         (SELECT count(*)::int FROM nexus.audit_events) AS audit,
         (SELECT count(*)::int FROM nexus.trace_events) AS trace`,
    );
    const stream = new SseStream(
      `${api.baseUrl}/api/v1/runs/${runId}/events`,
      operator.cookie,
    );
    await stream.open();
    expect(stream.status).toBe(200);
    await stream.waitFor((value) => value.comments >= 2);
    stream.close();
    const after = await dbOne<{ audit: number; trace: number }>(
      `SELECT
         (SELECT count(*)::int FROM nexus.audit_events) AS audit,
         (SELECT count(*)::int FROM nexus.trace_events) AS trace`,
    );
    expect(after.audit).toBe(before.audit);
    expect(after.trace).toBe(before.trace);
  });

  it('leaves the run alive when the browser disconnects', async () => {
    const { runId, eventId } = await createRun({ run: false });
    const stream = new SseStream(
      `${api.baseUrl}/api/v1/runs/${runId}/events`,
      operator.cookie,
    );
    await stream.open();
    expect(stream.status).toBe(200);
    await stream.waitFor((value) => value.events.length >= 1);
    stream.close();

    const runnerInstance = runner();
    expect((await runnerInstance.runOnce()).status).toBe('completed');
    const run = await dbOne<{ id: string; status: string }>(
      'SELECT id, status FROM nexus.workflow_runs WHERE trigger_event_id = $1',
      [eventId],
    );
    expect(run.status).toBe('completed');
    const detail = RunDetailSchema.parse(
      (
        await requestJson(
          api.baseUrl,
          `/api/v1/runs/${runId}`,
          operator.cookie,
        )
      ).body,
    );
    expect(detail.status).toBe('completed');
  });

  it('rejects an inaccessible run and an expired session', async () => {
    const missing = randomUUID();
    const missingDetail = await requestJson(
      api.baseUrl,
      `/api/v1/runs/${missing}`,
      operator.cookie,
    );
    expect(missingDetail.status).toBe(404);
    const missingStream = new SseStream(
      `${api.baseUrl}/api/v1/runs/${missing}/events`,
      operator.cookie,
    );
    await missingStream.open();
    expect(missingStream.status).toBe(404);
    missingStream.close();

    const expired = await login(api.baseUrl, 'ops.approver');
    await superuser.query(
      `UPDATE nexus.sessions
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE user_id = (SELECT id FROM nexus.users WHERE username = 'ops.approver')`,
    );
    const expiredStream = new SseStream(
      `${api.baseUrl}/api/v1/runs/${missing}/events`,
      expired.cookie,
    );
    await expiredStream.open();
    expect(expiredStream.status).toBe(401);
    expiredStream.close();
  });

  it('serves persisted status after an API process restart', async () => {
    const { runId } = await createRun();
    const before = await requestJson(
      api.baseUrl,
      `/api/v1/runs/${runId}`,
      operator.cookie,
    );
    expect(before.status).toBe(200);

    await api.stop();
    api = await startApi();
    const after = await requestJson(
      api.baseUrl,
      `/api/v1/runs/${runId}`,
      operator.cookie,
    );
    expect(after.status).toBe(200);
    expect(RunDetailSchema.parse(after.body).status).toBe('completed');

    const stream = new SseStream(
      `${api.baseUrl}/api/v1/runs/${runId}/events`,
      operator.cookie,
    );
    await stream.open();
    await stream.waitFor((value) =>
      value.events.some((event) => event.event === 'final'),
    );
    stream.close();
    expect(stream.events.some((event) => event.event === 'final')).toBe(true);
  });

  it('bounds a slow SSE client instead of buffering without limit', async () => {
    const { runId } = await createRun();
    await addTraceEvents(runId, 5);
    const slowApi = await startApi({ NEXUS_SSE_MAX_BUFFER_BYTES: '64' });
    try {
      const stream = new SseStream(
        `${slowApi.baseUrl}/api/v1/runs/${runId}/events`,
        operator.cookie,
      );
      await stream.open();
      expect(stream.status).toBe(200);
      stream.pause();
      await new Promise((resolve) => setTimeout(resolve, 200));
      stream.resume();
      await stream.waitForEnd(10_000);
      expect(stream.ended).toBe(true);
      stream.close();
    } finally {
      await slowApi.stop();
    }
  });
});

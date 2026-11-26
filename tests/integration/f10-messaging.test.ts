import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeEnterpriseCommandItem,
  CaseIntakeResponseSchema,
  EnterpriseCommandReceiptSchema,
  RoleSchema,
  parseEventEnvelope,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
  type EventEnvelope,
} from '@nexus/contracts';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';
import {
  applyMigrations as applyEnterpriseMigrations,
  loadMigrations as loadEnterpriseMigrations,
} from '@nexus/enterprise-db/migrate';
import {
  INITIAL_ENTERPRISE_SANDBOX,
  seedEnterpriseSupply,
} from '@nexus/enterprise-db/seed';
import {
  DEAD_LETTER_QUEUE,
  ENTERPRISE_EVENT_EXCHANGE,
  NEXUS_EVENT_EXCHANGE,
} from '@nexus/messaging/topology';
import {
  connectTestBroker,
  publishRaw,
  queueDepth,
  testBrokerEnv,
  waitFor,
  type TestBroker,
} from '../helpers/event-faults.js';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const workerEntry = path.join(root, 'apps/worker/dist/main.js');
const simulatorEntry = path.join(root, 'apps/enterprise-sim/dist/main.js');
const fixturesDirectory = path.join(root, 'fixtures/company');
const failureFixture = path.join(root, 'fixtures/failures/duplicate-event.json');
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f10-test-password-only';
const SANDBOX_ID = INITIAL_ENTERPRISE_SANDBOX.id;
const SUPPLIER_RHINE = '10000000-0000-4000-8000-000000000002';
const PRODUCT_MONITOR_27 = '20000000-0000-4000-8000-000000000001';
const AGREEMENT_RHINE_MONITOR = '40000000-0000-4000-8000-000000000002';
const SOURCE_PURCHASE_ORDER = '50000000-0000-4000-8000-000000000001';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F10`);
  }
  return value;
}

function pgConfig(user: string, password: string): ConstructorParameters<typeof PgClient>[0] {
  return {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f10-messaging-test',
    connectionTimeoutMillis: 5000,
  };
}

function nexusRuntimeEnv(
  role: 'api' | 'worker',
  password: string,
): Record<string, string> {
  const prefix = role === 'api' ? 'NEXUS_API' : 'NEXUS_WORKER';
  return {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    [`${prefix}_DB_USER`]: requiredEnv(`NEXUS_TEST_${prefix}_USER`),
    [`${prefix}_DB_PASSWORD`]: password,
  };
}

function apiEnv(): Record<string, string> {
  return {
    ...nexusRuntimeEnv('api', requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD')),
    VALKEY_HOST: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
    VALKEY_PORT: requiredEnv('NEXUS_TEST_VALKEY_PORT'),
    VALKEY_PASSWORD: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
    NEXUS_ALLOWED_ORIGINS: allowedOrigin,
    NEXUS_COOKIE_SECURE: 'false',
    ...testBrokerEnv(),
  };
}

function workerEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...nexusRuntimeEnv('worker', requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD')),
    ...testBrokerEnv(),
    NEXUS_OUTBOX_CLAIM_TIMEOUT_MS: '100',
    ...overrides,
  };
}

function simulatorEnv(): Record<string, string> {
  return {
    ENTERPRISE_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    ENTERPRISE_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    ENTERPRISE_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    ENTERPRISE_APP_DB_USER: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
    ENTERPRISE_APP_DB_PASSWORD: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
    ENTERPRISE_SIM_READ_TOKEN: requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN'),
    ENTERPRISE_SIM_COMMAND_TOKEN: requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN'),
    ...testBrokerEnv(),
  };
}

interface SpawnedApp {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  stop(): Promise<void>;
}

function spawnApp(entry: string, environment: Record<string, string>): SpawnedApp {
  if (!existsSync(entry)) {
    throw new Error(`Missing compiled entry ${entry}; run "pnpm build" first`);
  }
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, PORT: '0', ...environment },
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
    stdout: () => stdout,
    stderr: () => stderr,
    async waitForOutput(pattern, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = pattern.exec(stdout);
        if (match) {
          return match;
        }
        if (child.exitCode !== null) {
          throw new Error(`Process exited early. stderr: ${stderr}`);
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

interface ApiSession {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

async function request(
  baseUrl: string,
  route: string,
  options: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function login(baseUrl: string, username: string): Promise<ApiSession> {
  const csrf = await request(baseUrl, '/api/v1/auth/csrf');
  expect(csrf.status).toBe(200);
  const challenge = (csrf.body as { csrfToken: string }).csrfToken;
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      'X-CSRF-Token': challenge,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password: testPassword }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie?.()[0]?.split(';')[0] ?? '';
  const body = (await response.json()) as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

async function intake(
  baseUrl: string,
  session: ApiSession,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Origin: allowedOrigin,
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrfToken,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return request(baseUrl, '/api/v1/cases', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function intakeBody(
  sourceIdentity: string,
  title = 'F10 durable intake',
): { title: string; summary: string; source: { type: 'text'; identity: string } } {
  return {
    title,
    summary: 'F10 durable intake summary',
    source: { type: 'text', identity: sourceIdentity },
  };
}

function expectProblem(response: ApiResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  const body = response.body as { code?: unknown; requestId?: unknown };
  expect(body.code).toBe(code);
  expect(typeof body.requestId).toBe('string');
}

async function seedIdentity(): Promise<void> {
  const existing = await dbAll<{ count: number }>('SELECT count(*)::int AS count FROM nexus.users');
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

let api: SpawnedApp;
let worker: SpawnedApp | null = null;
let simulator: SpawnedApp;
let broker: TestBroker;
let operator: ApiSession;
let dbClient: Client;
let nexusMigrator: Client;
let enterpriseMigrator: Client;
let apiBase: string;
let simulatorBase: string;

async function dbAll<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  const result = await dbClient.query(sql, parameters);
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

async function dbOneOrNull<T>(sql: string, parameters: unknown[] = []): Promise<T | null> {
  const rows = await dbAll<T>(sql, parameters);
  return rows[0] ?? null;
}

interface OutboxDbRow {
  id: string;
  sandbox_id: string;
  event_type: string;
  schema_version: number;
  producer: string;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  version: number;
}

interface InboxDbRow {
  event_id: string;
  event_type: string;
  producer: string;
  dispatch_state: string;
  envelope: Record<string, unknown>;
}

interface EnterpriseOutboxDbRow {
  id: string;
  event_type: string;
  status: string;
  payload: Record<string, unknown>;
}

function envelopeFromOutbox(row: OutboxDbRow): EventEnvelope<unknown> {
  return parseEventEnvelope({
    eventId: row.id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    sandboxId: row.sandbox_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    producer: row.producer,
    payload: row.payload,
  });
}

async function startWorker(overrides: Record<string, string> = {}): Promise<void> {
  if (worker) {
    return;
  }
  worker = spawnApp(workerEntry, workerEnv(overrides));
  await worker.waitForOutput(/NEXUS_WORKER_READY/);
}

async function stopWorker(): Promise<void> {
  if (!worker) {
    return;
  }
  const current = worker;
  worker = null;
  await current.stop();
}

function planHashFor(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

function itemHashFor(
  payloadTemplate: EnterpriseCommandRequest['payloadTemplate'],
  baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[],
): string {
  return createHash('sha256')
    .update(
      canonicalizeEnterpriseCommandItem({
        payloadTemplate,
        baseExpectedVersions,
      }),
      'utf8',
    )
    .digest('hex');
}

interface BaseSpec {
  readonly supplierIds?: readonly string[];
  readonly sourcePurchaseOrderId?: string;
  readonly agreementIds?: readonly string[];
  readonly productIds?: readonly string[];
}

async function baseVersions(spec: BaseSpec): Promise<EnterpriseBaseExpectedVersion[]> {
  const versions: EnterpriseBaseExpectedVersion[] = [];
  for (const supplierId of spec.supplierIds ?? []) {
    const row = await dbOne<{ reference: string; version: number }>(
      'SELECT reference, version FROM enterprise.suppliers WHERE sandbox_id = $1 AND id = $2',
      [SANDBOX_ID, supplierId],
    );
    versions.push({
      system: 'enterprise',
      type: 'supplier',
      id: supplierId,
      reference: row.reference,
      version: row.version,
    });
  }
  if (spec.sourcePurchaseOrderId) {
    const row = await dbOne<{ reference: string; version: number }>(
      'SELECT reference, version FROM enterprise.purchase_orders WHERE sandbox_id = $1 AND id = $2',
      [SANDBOX_ID, spec.sourcePurchaseOrderId],
    );
    versions.push({
      system: 'enterprise',
      type: 'purchase_order',
      id: spec.sourcePurchaseOrderId,
      reference: row.reference,
      version: row.version,
    });
  }
  for (const agreementId of spec.agreementIds ?? []) {
    const row = await dbOne<{ reference: string; version: number }>(
      'SELECT reference, version FROM enterprise.agreements WHERE sandbox_id = $1 AND id = $2',
      [SANDBOX_ID, agreementId],
    );
    versions.push({
      system: 'enterprise',
      type: 'agreement',
      id: agreementId,
      reference: row.reference,
      version: row.version,
    });
  }
  for (const productId of spec.productIds ?? []) {
    const row = await dbOne<{ sku: string; version: number }>(
      'SELECT sku, version FROM enterprise.products WHERE sandbox_id = $1 AND id = $2',
      [SANDBOX_ID, productId],
    );
    versions.push({
      system: 'enterprise',
      type: 'product',
      id: productId,
      reference: row.sku,
      version: row.version,
    });
    const inventory = await dbOne<{ version: number }>(
      'SELECT version FROM enterprise.inventory WHERE sandbox_id = $1 AND product_id = $2',
      [SANDBOX_ID, productId],
    );
    versions.push({
      system: 'enterprise',
      type: 'inventory',
      id: productId,
      reference: null,
      version: inventory.version,
    });
  }
  return versions;
}

function createOrderPayload(): EnterpriseCommandRequest['payloadTemplate'] {
  return {
    kind: 'enterprise.create_purchase_order',
    supplierId: SUPPLIER_RHINE,
    sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
    lines: [
      {
        productId: PRODUCT_MONITOR_27,
        quantity: 5,
        agreementId: AGREEMENT_RHINE_MONITOR,
        unitPriceMinor: '17900',
        arrivalAt: '2026-11-04T09:00:00Z',
      },
    ],
    expediteChargeMinor: '0',
  };
}

async function postCommand(
  body: EnterpriseCommandRequest,
): Promise<EnterpriseCommandReceipt> {
  const response = await fetch(
    `${simulatorBase}/v1/commands/${body.payloadTemplate.kind}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN')}`,
        'x-nexus-sandbox-id': SANDBOX_ID,
        'x-correlation-id': `f10-${randomUUID()}`,
      },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(200);
  return EnterpriseCommandReceiptSchema.parse(await response.json());
}

beforeAll(async () => {
  if (
    !existsSync(apiEntry) ||
    !existsSync(workerEntry) ||
    !existsSync(simulatorEntry)
  ) {
    throw new Error('Compiled applications are missing; run pnpm build first');
  }
  dbClient = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
      requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    ),
  );
  await dbClient.connect();
  nexusMigrator = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    ),
  );
  enterpriseMigrator = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD'),
    ),
  );
  await nexusMigrator.connect();
  await enterpriseMigrator.connect();
  await applyMigrations(nexusMigrator, {
    schema: 'nexus',
    migrations: loadMigrations(path.join(root, 'packages/db/migrations')),
  });
  await applyEnterpriseMigrations(enterpriseMigrator, {
    schema: 'enterprise',
    migrations: loadEnterpriseMigrations(
      path.join(root, 'packages/enterprise-db/migrations'),
    ),
  });
  await seedEnterpriseSupply(enterpriseMigrator, { fixturesDirectory });
  await seedIdentity();
  broker = await connectTestBroker();
  api = spawnApp(apiEntry, apiEnv());
  const apiPort = await api.waitForOutput(/NEXUS_API_READY port=(\d+)/);
  apiBase = `http://127.0.0.1:${apiPort[1]}`;
  simulator = spawnApp(simulatorEntry, simulatorEnv());
  const simulatorPort = await simulator.waitForOutput(/ENTERPRISE_SIM_READY port=(\d+)/);
  simulatorBase = `http://127.0.0.1:${simulatorPort[1]}`;
  operator = await login(apiBase, 'operator');
}, 180_000);

afterAll(async () => {
  await stopWorker();
  await simulator?.stop();
  await api?.stop();
  await broker?.close();
  await dbClient?.end();
  await nexusMigrator?.end();
  await enterpriseMigrator?.end();
});

describe('F10 durable ingress, outbox and inbox', () => {
  it('deduplicates one accepted case and outbox event by key and source identity', async () => {
    const key = `f10-key-${randomUUID()}`;
    const sourceIdentity = `f10-source-${randomUUID()}`;
    const body = intakeBody(sourceIdentity, 'F10 idempotent case');

    const first = await intake(apiBase, operator, body, key);
    expect(first.status).toBe(202);
    const accepted = CaseIntakeResponseSchema.parse(first.body);
    expect(accepted.deduplicated).toBe(false);
    expect(accepted.case.status).toBe('new');
    expect(accepted.queued).toBe(true);

    const outbox = await dbOne<OutboxDbRow>(
      'SELECT * FROM nexus.event_outbox WHERE id = $1',
      [accepted.eventId],
    );
    expect(outbox.status).toBe('pending');
    expect(outbox.event_type).toBe('nexus.case.created.v1');
    expect(outbox.correlation_id.length).toBeGreaterThan(0);

    const replay = await intake(apiBase, operator, body, key);
    expect(replay.status).toBe(202);
    const replayed = CaseIntakeResponseSchema.parse(replay.body);
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.case.id).toBe(accepted.case.id);
    expect(replayed.eventId).toBe(accepted.eventId);

    const sameSource = await intake(
      apiBase,
      operator,
      body,
      `f10-other-${randomUUID()}`,
    );
    expect(sameSource.status).toBe(202);
    const sourceReplay = CaseIntakeResponseSchema.parse(sameSource.body);
    expect(sourceReplay.deduplicated).toBe(true);
    expect(sourceReplay.case.id).toBe(accepted.case.id);

    expectProblem(
      await intake(apiBase, operator, { ...body, title: 'Changed same key' }, key),
      409,
      'IDEMPOTENCY_MISMATCH',
    );
    expectProblem(
      await intake(
        apiBase,
        operator,
        { ...body, title: 'Changed source body' },
        `f10-conflict-${randomUUID()}`,
      ),
      409,
      'IDEMPOTENCY_MISMATCH',
    );

    const caseCount = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.cases WHERE id = $1',
      [accepted.case.id],
    );
    expect(caseCount.count).toBe(1);
    const outboxCount = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.event_outbox WHERE id = $1',
      [accepted.eventId],
    );
    expect(outboxCount.count).toBe(1);
    const keyCount = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.ingress_keys WHERE source_identity = $1',
      [`text:${sourceIdentity}`],
    );
    expect(keyCount.count).toBe(1);
  });

  it('rejects missing keys, wrong roles and nonexistent document references', async () => {
    const body = intakeBody(`f10-invalid-${randomUUID()}`);
    expectProblem(
      await intake(apiBase, operator, body, undefined),
      400,
      'VALIDATION_FAILED',
    );

    const viewer = await login(apiBase, 'ops.approver');
    expectProblem(
      await intake(apiBase, viewer, body, `f10-viewer-${randomUUID()}`),
      403,
      'FORBIDDEN',
    );

    expectProblem(
      await intake(
        apiBase,
        operator,
        {
          title: 'Missing document case',
          summary: null,
          source: { type: 'document', documentId: randomUUID() },
        },
        `f10-doc-${randomUUID()}`,
      ),
      404,
      'NOT_FOUND',
    );
  });

  it('does not duplicate an event confirmed before publisher crash or redelivery', async () => {
    const body = intakeBody(`f10-crash-${randomUUID()}`, 'F10 crash safe case');
    const first = await intake(apiBase, operator, body, `f10-crash-key-${randomUUID()}`);
    expect(first.status).toBe(202);
    const accepted = CaseIntakeResponseSchema.parse(first.body);

    const outbox = await dbOne<OutboxDbRow>(
      'SELECT * FROM nexus.event_outbox WHERE id = $1',
      [accepted.eventId],
    );
    const envelope = envelopeFromOutbox(outbox);
    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await dbClient.query(
      `UPDATE nexus.event_outbox
       SET status = 'publishing',
           attempt_count = 1,
           version = 1,
           updated_at = clock_timestamp() - interval '5 seconds'
       WHERE id = $1`,
      [accepted.eventId],
    );

    await startWorker();

    const inbox = await waitFor(
      async () => {
        const rows = await dbAll<InboxDbRow>(
          'SELECT * FROM nexus.event_inbox WHERE event_id = $1',
          [accepted.eventId],
        );
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: 15_000 },
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.dispatch_state).toBe('pending');
    expect(inbox[0]?.event_type).toBe('nexus.case.created.v1');

    await waitFor(
      async () =>
        (await dbOneOrNull<{ status: string }>(
          'SELECT status FROM nexus.event_outbox WHERE id = $1',
          [accepted.eventId],
        ))?.status === 'published'
          ? true
          : null,
      { timeoutMs: 15_000 },
    );

    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillOne = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.event_inbox WHERE event_id = $1',
      [accepted.eventId],
    );
    expect(stillOne.count).toBe(1);
  });

  it('routes schema poison to the DLQ and a queryable dead-letter record', async () => {
    const poisonEventId = randomUUID();
    const poison = {
      eventId: poisonEventId,
      eventType: 'nexus.case.created.v1',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      sandboxId: SANDBOX_ID,
      correlationId: 'f10-poison',
      causationId: null,
      producer: 'api',
      payload: { caseId: randomUUID() },
    };
    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      'nexus.case.created.v1',
      poison,
      poisonEventId,
    );
    const dead = await waitFor(
      async () =>
        dbOneOrNull<{ reason_code: string; event_id: string }>(
          'SELECT reason_code, event_id FROM nexus.dead_letters WHERE event_id = $1',
          [poisonEventId],
        ),
      { timeoutMs: 10_000 },
    );
    expect(dead.reason_code).toBe('SCHEMA_INVALID');
    expect(dead.event_id).toBe(poisonEventId);
    expect(await queueDepth(broker, DEAD_LETTER_QUEUE)).toBeGreaterThanOrEqual(1);
    const inbox = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.event_inbox WHERE event_id = $1',
      [poisonEventId],
    );
    expect(inbox).toHaveLength(0);
  });

  it('accepts the checked-in duplicate event fixture once', async () => {
    const fixture = JSON.parse(readFileSync(failureFixture, 'utf8')) as unknown;
    const envelope = parseEventEnvelope(fixture);
    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await publishRaw(
      broker,
      NEXUS_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    const inbox = await waitFor(
      async () => {
        const rows = await dbAll<{ id: string }>(
          'SELECT id FROM nexus.event_inbox WHERE event_id = $1',
          [envelope.eventId],
        );
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: 10_000 },
    );
    expect(inbox).toHaveLength(1);
  });

  it('retains an accepted case while the worker cannot reach the broker and delivers after recovery', async () => {
    await stopWorker();
    const body = intakeBody(`f10-recovery-${randomUUID()}`, 'F10 recovery case');
    const first = await intake(apiBase, operator, body, `f10-recovery-key-${randomUUID()}`);
    expect(first.status).toBe(202);
    const accepted = CaseIntakeResponseSchema.parse(first.body);

    const unavailable = spawnApp(workerEntry, workerEnv({ NEXUS_RABBIT_PORT: '1' }));
    await unavailable.waitForOutput(/NEXUS_WORKER_READY/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await unavailable.stop();

    const outbox = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.event_outbox WHERE id = $1',
      [accepted.eventId],
    );
    expect(['pending', 'publishing']).toContain(outbox.status);
    const beforeRecovery = await dbAll<{ id: string }>(
      'SELECT id FROM nexus.event_inbox WHERE event_id = $1',
      [accepted.eventId],
    );
    expect(beforeRecovery).toHaveLength(0);

    await startWorker();
    const inbox = await waitFor(
      async () => {
        const rows = await dbAll<{ id: string }>(
          'SELECT id FROM nexus.event_inbox WHERE event_id = $1',
          [accepted.eventId],
        );
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: 20_000 },
    );
    expect(inbox).toHaveLength(1);
  });

  it('delivers an enterprise command event once effectively with its origin identity', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const payload = createOrderPayload();
    const bases = await baseVersions({
      supplierIds: [SUPPLIER_RHINE],
      sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
      agreementIds: [AGREEMENT_RHINE_MONITOR],
      productIds: [PRODUCT_MONITOR_27],
    });
    const now = Date.now();
    const command: EnterpriseCommandRequest = {
      sandboxId: SANDBOX_ID,
      actionRevisionId: revisionId,
      itemId,
      planHash: planHashFor(`f10-plan:${revisionId}`),
      itemHash: itemHashFor(payload, bases),
      baseExpectedVersions: bases,
      payloadTemplate: payload,
      priorReceiptKeys: [],
      executeBefore: new Date(now + 10_000).toISOString(),
      authorizationValidUntil: new Date(now + 20_000).toISOString(),
    };
    const receipt = await postCommand(command);
    expect(receipt.status).toBe('succeeded');

    const event = await waitFor(
      async () =>
        dbOneOrNull<EnterpriseOutboxDbRow>(
          'SELECT id, event_type, status, payload FROM enterprise.event_outbox WHERE origin_action_revision_id = $1',
          [revisionId],
        ),
      { timeoutMs: 10_000 },
    );
    expect(event.event_type).toBe('enterprise.inventory.changed.v1');

    const inbox = await waitFor(
      async () =>
        dbOneOrNull<InboxDbRow>(
          'SELECT event_id, event_type, producer, dispatch_state, envelope FROM nexus.event_inbox WHERE event_id = $1',
          [event.id],
        ),
      { timeoutMs: 20_000 },
    );
    expect(inbox.event_type).toBe('enterprise.inventory.changed.v1');
    expect(inbox.producer).toBe('enterprise-sim');
    expect(inbox.dispatch_state).toBe('pending');

    const published = await waitFor(
      async () => {
        const row = await dbOneOrNull<{ status: string; attempt_count: number }>(
          'SELECT status, attempt_count FROM enterprise.event_outbox WHERE id = $1',
          [event.id],
        );
        return row?.status === 'published' ? row : null;
      },
      { timeoutMs: 15_000 },
    );
    expect(published.attempt_count).toBe(1);

    const envelope = parseEventEnvelope(inbox.envelope);
    const payloadValue = envelope.payload as {
      entityType: string;
      originatingRevisionId?: string;
      originatingItemId?: string;
      originatingReceiptKey?: string;
    };
    expect(payloadValue.entityType).toBe('inventory');
    expect(payloadValue.originatingRevisionId).toBe(revisionId);
    expect(payloadValue.originatingItemId).toBe(itemId);
    expect(typeof payloadValue.originatingReceiptKey).toBe('string');

    await publishRaw(
      broker,
      ENTERPRISE_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await publishRaw(
      broker,
      ENTERPRISE_EVENT_EXCHANGE,
      envelope.eventType,
      envelope,
      envelope.eventId,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const count = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.event_inbox WHERE event_id = $1',
      [event.id],
    );
    expect(count.count).toBe(1);
  });
});

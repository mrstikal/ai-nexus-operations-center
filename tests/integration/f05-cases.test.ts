import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleSchema, type Role } from '@nexus/contracts';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createCaseStore } from '@nexus/db/repositories/cases';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { appendTraceEvent } from '@nexus/db/repositories/trace';
import { CaseService, CaseVersionConflictError } from '@nexus/application/cases/service';
import { SandboxInactiveError } from '@nexus/application/cases/context';
import { hashPassword } from '@nexus/application/identity/passwords';
import { sanitizeTraceData } from '@nexus/observability/trace';
import { sanitizeAuditDetails } from '@nexus/observability/redaction';

const { Client: PgClient } = pg;
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f05-test-password-only';
const initialSandboxId = '00000000-0000-4000-8000-000000000001';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F05`);
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
    application_name: 'f05-cases-test',
    connectionTimeoutMillis: 5000,
  };
}

function clientFor(role: 'superuser' | 'api' | 'migrator'): Client {
  if (role === 'superuser') {
    return new PgClient(
      pgConfig(
        requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
        requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
      ),
    );
  }
  if (role === 'migrator') {
    return new PgClient(
      pgConfig(
        requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
        requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
      ),
    );
  }
  return new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
    ),
  );
}

async function withClient<T>(client: Client, operation: (value: Client) => Promise<T>): Promise<T> {
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

interface SeedFixture {
  users: Array<{ username: string; displayName: string; roles: string[] }>;
}

async function seedIdentity(): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, 'fixtures/users/roles.json'), 'utf8'),
  ) as SeedFixture;
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
      const roles: Role[] = RoleSchema.array().parse(user.roles);
      await createIdentityUser(db, {
        username: user.username,
        displayName: user.displayName,
        roles,
        password: await hashPassword(testPassword),
      });
    }
  } finally {
    await pool.end();
  }
}

interface SpawnedApi {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  port: number;
}

async function startApi(): Promise<SpawnedApi> {
  const entry = path.join(repoRoot, 'apps/api/dist/main.js');
  if (!existsSync(entry)) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: '0',
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
    },
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
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`API did not start. stdout: ${stdout} stderr: ${stderr}`));
    }, 15000);
    const check = () => {
      const match = /NEXUS_API_READY port=(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`API exited early. stderr: ${stderr}`));
      }
    };
    child.stdout?.on('data', check);
    check();
  });
  return { child, stdout, stderr, port };
}

async function stopApi(api: SpawnedApi): Promise<void> {
  if (api.child.exitCode === null && api.child.signalCode === null) {
    api.child.kill('SIGTERM');
  }
  await new Promise<void>((resolve) => {
    if (api.child.exitCode !== null || api.child.signalCode !== null) {
      resolve();
      return;
    }
    api.child.once('exit', () => resolve());
    setTimeout(() => {
      if (api.child.exitCode === null && api.child.signalCode === null) {
        api.child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
  });
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  setCookie: string | null;
}

async function request(
  port: number,
  route: string,
  options: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, options);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { status: response.status, headers: response.headers, body, setCookie };
}

function cookieFrom(response: ApiResponse): string {
  return response.setCookie?.split(';')[0] ?? '';
}

async function login(port: number, username = 'operator'): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const csrfResponse = await request(port, '/api/v1/auth/csrf');
  expect(csrfResponse.status).toBe(200);
  const challenge = (csrfResponse.body as { csrfToken: string }).csrfToken;
  const response = await request(port, '/api/v1/auth/login', {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      'X-CSRF-Token': challenge,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password: testPassword }),
  });
  expect(response.status).toBe(200);
  return {
    cookie: cookieFrom(response),
    csrfToken: (response.body as { csrfToken: string }).csrfToken,
  };
}

let api: SpawnedApi;
let service: CaseService;
let store: ReturnType<typeof createCaseStore>;
let db: ReturnType<typeof createNexusDb>;
let operatorId: string;
let initialSandbox: { id: string };
let otherSandboxId: string;
let caseA: { id: string; version: number };
let caseB: { id: string; version: number };
let otherCaseId: string;
let availableEvidenceId: string;
let missingEvidenceId: string;
let otherEvidenceId: string;

beforeAll(async () => {
  if (!existsSync(path.join(repoRoot, 'apps/api/dist/main.js'))) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  await withClient(clientFor('migrator'), async (client) => {
    await applyMigrations(client, {
      schema: 'nexus',
      migrations: loadMigrations(path.join(repoRoot, 'packages/db/migrations')),
    });
  });
  await seedIdentity();
  const pool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  db = createNexusDb(pool);
  store = createCaseStore(db);
  service = new CaseService(store);
  await withClient(clientFor('superuser'), async (client) => {
    const rows = await client.query<{ id: string }>(
      "SELECT id FROM nexus.users WHERE lower(username) = 'operator'",
    );
    operatorId = rows.rows[0]?.id ?? '';
    expect(operatorId).not.toBe('');
  });
  initialSandbox = await service.getActiveSandbox();
  expect(initialSandbox.id).toBe(initialSandboxId);
  const write = {
    actor: { kind: 'human' as const, id: operatorId, roles: ['operator', 'viewer'] },
    requestId: 'f05-request',
    correlationId: 'f05-correlation',
  };
  caseA = await service.createCase({ title: 'Supplier delay A', summary: null }, write);
  caseB = await service.createCase({ title: 'Invoice discrepancy B', summary: null }, write);
  await service.createCase({ title: 'Customer request C', summary: null }, write);

  otherSandboxId = randomUUID();
  await withClient(clientFor('superuser'), async (client) => {
    await client.query(
      `INSERT INTO nexus.sandboxes (id, name, status, business_effective_at)
       VALUES ($1, 'Retired F05 fixture', 'active', '2026-11-02T09:00:00Z')`,
      [otherSandboxId],
    );
  });
  otherCaseId = randomUUID();
  await store.createCase({
    ...write,
    caseId: otherCaseId,
    sandboxId: otherSandboxId,
    title: 'Foreign sandbox case',
    summary: null,
    audit: {
      action: 'case.created',
      outcome: 'succeeded',
      details: sanitizeAuditDetails({
        caseId: otherCaseId,
        caseStatus: 'new',
        caseVersion: 1,
        action: 'case.created',
        outcome: 'succeeded',
      }),
    },
  });

  const available = await service.addEvidence(
    {
      caseId: caseA.id,
      kind: 'enterprise_snapshot',
      sourceStatus: 'available',
      sourceRef: { system: 'nexus', type: 'case', id: caseA.id, version: 1 },
      sourceSandboxId: initialSandbox.id,
      contentHash: null,
      locator: null,
      capturedFacts: { supplierStatus: 'delayed', purchaseOrderCount: 1 },
      missingReason: null,
    },
    write,
  );
  availableEvidenceId = available.id;
  const missing = await service.addEvidence(
    {
      caseId: caseA.id,
      kind: 'document_page',
      sourceStatus: 'missing',
      sourceRef: null,
      sourceSandboxId: null,
      contentHash: null,
      locator: null,
      capturedFacts: { note: 'No source document was delivered.' },
      missingReason: 'Source page is unavailable',
    },
    write,
  );
  missingEvidenceId = missing.id;
  otherEvidenceId = randomUUID();
  await store.insertEvidence({
    ...write,
    evidenceId: otherEvidenceId,
    sandboxId: otherSandboxId,
    caseId: otherCaseId,
    kind: 'enterprise_snapshot',
    sourceStatus: 'missing',
    sourceRef: null,
    sourceSandboxId: null,
    contentHash: createHash('sha256').update('foreign-evidence').digest('hex'),
    locator: null,
    capturedFacts: { foreign: true },
    missingReason: 'Foreign source unavailable',
    audit: {
      action: 'evidence.created',
      outcome: 'succeeded',
      details: sanitizeAuditDetails({
        evidenceId: otherEvidenceId,
        caseId: otherCaseId,
        sourceKind: 'enterprise_snapshot',
        status: 'missing',
        action: 'evidence.created',
        outcome: 'succeeded',
      }),
    },
  });

  await appendTraceEvent(db, {
    sandboxId: initialSandbox.id,
    runId: null,
    level: 'info',
    event: 'f05.trace.test',
    data: sanitizeTraceData({ event: 'f05.trace.test', count: 1 }),
  });

  api = await startApi();
});

afterAll(async () => {
  if (api) {
    await stopApi(api);
  }
});

describe('F05 cases, evidence, audit and trace persistence', () => {
  it('serves the server-resolved sandbox and a persisted, paginated case list', async () => {
    const session = await login(api.port);
    const sandbox = await request(api.port, '/api/v1/sandbox', {
      headers: { Cookie: session.cookie },
    });
    expect(sandbox.status).toBe(200);
    expect(sandbox.body).toMatchObject({ id: initialSandboxId, status: 'active' });

    const firstPage = await request(api.port, '/api/v1/cases?limit=2', {
      headers: { Cookie: session.cookie },
    });
    expect(firstPage.status).toBe(200);
    const first = firstPage.body as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const createdBetweenPages = await service.createCase(
      { title: 'Inserted between pages', summary: null },
      {
        actor: { kind: 'human', id: operatorId, roles: ['operator', 'viewer'] },
        requestId: 'f05-between',
        correlationId: 'f05-between',
      },
    );
    const secondPage = await request(
      api.port,
      `/api/v1/cases?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      { headers: { Cookie: session.cookie } },
    );
    expect(secondPage.status).toBe(200);
    const second = secondPage.body as { items: Array<{ id: string }> };
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(createdBetweenPages.id);

    const filter = await request(api.port, '/api/v1/cases?status=investigating&limit=100', {
      headers: { Cookie: session.cookie },
    });
    expect(filter.status).toBe(200);
    expect((filter.body as { items: unknown[] }).items).toEqual([]);
  });

  it('returns detail and redacted history while hiding cross-sandbox cases', async () => {
    const session = await login(api.port);
    const detail = await request(api.port, `/api/v1/cases/${caseA.id}`, {
      headers: { Cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: caseA.id, title: 'Supplier delay A' });

    const foreign = await request(api.port, `/api/v1/cases/${otherCaseId}`, {
      headers: { Cookie: session.cookie },
    });
    expect(foreign.status).toBe(404);

    const history = await request(api.port, `/api/v1/cases/${caseA.id}/history?limit=2`, {
      headers: { Cookie: session.cookie },
    });
    expect(history.status).toBe(200);
    const body = history.body as { items: Array<{ summary: string }>; nextCursor: string | null };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(body)).not.toContain('Main Street');
    expect(body.nextCursor).toBeTruthy();

    const anonymous = await request(api.port, `/api/v1/cases/${caseA.id}`);
    expect(anonymous.status).toBe(401);
  });

  it('serves available and explicitly missing evidence without cross-sandbox disclosure', async () => {
    const session = await login(api.port);
    const available = await request(api.port, `/api/v1/evidence/${availableEvidenceId}`, {
      headers: { Cookie: session.cookie },
    });
    expect(available.status).toBe(200);
    expect(available.body).toMatchObject({
      id: availableEvidenceId,
      sourceStatus: 'available',
      missingReason: null,
    });
    expect((available.body as { contentHash: string }).contentHash).toMatch(/^[a-f0-9]{64}$/);

    const missing = await request(api.port, `/api/v1/evidence/${missingEvidenceId}`, {
      headers: { Cookie: session.cookie },
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({
      id: missingEvidenceId,
      sourceStatus: 'missing',
      missingReason: 'Source page is unavailable',
    });

    const foreign = await request(api.port, `/api/v1/evidence/${otherEvidenceId}`, {
      headers: { Cookie: session.cookie },
    });
    expect(foreign.status).toBe(404);
  });

  it('validates evidence hash, locator, source sandbox and case version conflicts', async () => {
    const write = {
      actor: { kind: 'human' as const, id: operatorId, roles: ['operator', 'viewer'] },
      requestId: 'f05-validation',
      correlationId: 'f05-validation',
    };
    const base = {
      caseId: caseA.id,
      kind: 'calculation' as const,
      sourceStatus: 'available' as const,
      sourceRef: { system: 'nexus' as const, type: 'case', id: caseA.id, version: 1 },
      sourceSandboxId: initialSandbox.id,
      locator: null,
      capturedFacts: { total: 1 },
      missingReason: null,
    };
    await expect(
      service.addEvidence({ ...base, contentHash: 'not-a-hash' }, write),
    ).rejects.toBeTruthy();
    await expect(
      service.addEvidence(
        {
          ...base,
          contentHash: null,
          locator: {
            documentVersionId: null,
            page: 0,
            startOffset: null,
            endOffset: null,
          },
        },
        write,
      ),
    ).rejects.toBeTruthy();
    await expect(
      service.addEvidence(
        { ...base, contentHash: null, sourceSandboxId: otherSandboxId },
        write,
      ),
    ).rejects.toBeTruthy();
    await expect(
      service.addEvidence(
        {
          ...base,
          contentHash: null,
          sourceRef: { system: 'nexus', type: 'case', id: otherCaseId, version: 1 },
        },
        write,
      ),
    ).rejects.toBeTruthy();

    const current = await service.getCase(caseB.id);
    await service.updateCase(
      caseB.id,
      { expectedVersion: current.version, status: 'investigating', terminalReason: null },
      write,
    );
    await expect(
      service.updateCase(
        caseB.id,
        { expectedVersion: current.version, status: 'executing', terminalReason: null },
        write,
      ),
    ).rejects.toBeInstanceOf(CaseVersionConflictError);
  });

  it('returns every case when multiple rows share the same millisecond timestamp', async () => {
    const session = await login(api.port);
    await withClient(clientFor('superuser'), async (client) => {
      await client.query(
        "UPDATE nexus.cases SET created_at = '2026-11-02T09:00:00.123456+00' WHERE sandbox_id = $1",
        [initialSandbox.id],
      );
      const count = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM nexus.cases WHERE sandbox_id = $1',
        [initialSandbox.id],
      );
      expect(count.rows[0]?.count).toBeGreaterThan(2);
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const page = await request(api.port, `/api/v1/cases?limit=2${suffix}`, {
        headers: { Cookie: session.cookie },
      });
      expect(page.status).toBe(200);
      const body = page.body as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(seen.length);
    const count = await withClient(clientFor('superuser'), (client) =>
      client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM nexus.cases WHERE sandbox_id = $1',
        [initialSandbox.id],
      ),
    );
    expect(seen).toHaveLength(count.rows[0]?.count ?? 0);
  });

  it('rejects case mutations when the resolved sandbox is retired', async () => {
    const write = {
      actor: { kind: 'human' as const, id: operatorId, roles: ['operator', 'viewer'] },
      requestId: 'f05-retired',
      correlationId: 'f05-retired',
    };
    await withClient(clientFor('superuser'), (client) =>
      client.query("UPDATE nexus.sandboxes SET status = 'retired' WHERE id = $1", [
        initialSandbox.id,
      ]),
    );
    try {
      await expect(
        service.createCase({ title: 'Must not exist', summary: null }, write),
      ).rejects.toBeInstanceOf(SandboxInactiveError);
    } finally {
      await withClient(clientFor('superuser'), (client) =>
        client.query("UPDATE nexus.sandboxes SET status = 'active' WHERE id = $1", [
          initialSandbox.id,
        ]),
      );
    }
  });

  it('allocates concurrent audit sequences and keeps audit append-only for runtime roles', async () => {
    const write = {
      actor: { kind: 'human' as const, id: operatorId, roles: ['operator', 'viewer'] },
      requestId: 'f05-audit',
      correlationId: 'f05-audit',
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendAudit({
          ...write,
          sandboxId: initialSandbox.id,
          runId: null,
          action: `f05.audit.${index}`,
          targetType: null,
          targetId: null,
          targetVersion: null,
          beforeHash: null,
          afterHash: null,
          outcome: 'succeeded',
          details: {},
        }),
      ),
    );
    await withClient(clientFor('superuser'), async (client) => {
      const rows = await client.query<{ sequence: string }>(
        'SELECT sequence FROM nexus.audit_events WHERE sandbox_id = $1 ORDER BY sequence',
        [initialSandbox.id],
      );
      const sequences = rows.rows.map((row) => Number(row.sequence));
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences[0]).toBe(1);
      expect(sequences.at(-1)).toBe(sequences.length);
    });

    await withClient(clientFor('api'), async (client) => {
      await expect(
        client.query("UPDATE nexus.audit_events SET action = 'tampered'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM nexus.audit_events')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('rejects personal address material from audit details and keeps trace data redacted', async () => {
    expect(() => sanitizeAuditDetails({ address: '1 Main Street' })).toThrow(/allowlisted/);
    expect(() => sanitizeTraceData({ address: '1 Main Street' })).toThrow(/allowlisted/);
    await expect(
      store.appendAudit({
        actor: { kind: 'human', id: operatorId, roles: ['operator', 'viewer'] },
        requestId: 'f05-invalid-audit',
        correlationId: 'f05-invalid-audit',
        sandboxId: initialSandbox.id,
        runId: null,
        action: 'x'.repeat(200),
        targetType: null,
        targetId: null,
        targetVersion: null,
        beforeHash: null,
        afterHash: null,
        outcome: 'succeeded',
        details: {},
      }),
    ).rejects.toBeTruthy();
    await expect(
      store.appendAudit({
        actor: { kind: 'human', id: operatorId, roles: ['not-a-role'] },
        requestId: 'f05-invalid-actor',
        correlationId: 'f05-invalid-actor',
        sandboxId: initialSandbox.id,
        runId: null,
        action: 'f05.invalid.actor',
        targetType: null,
        targetId: null,
        targetVersion: null,
        beforeHash: null,
        afterHash: null,
        outcome: 'succeeded',
        details: {},
      }),
    ).rejects.toBeTruthy();
    await expect(
      store.appendAudit({
        actor: { kind: 'human', id: operatorId, roles: ['operator', 'viewer'] },
        requestId: 'f05-invalid-version',
        correlationId: 'f05-invalid-version',
        sandboxId: initialSandbox.id,
        runId: null,
        action: 'f05.invalid.version',
        targetType: 'case',
        targetId: caseA.id,
        targetVersion: '1',
        beforeHash: null,
        afterHash: null,
        outcome: 'succeeded',
        details: { caseVersion: -1 },
      }),
    ).rejects.toBeTruthy();
    const traceRows = await withClient(clientFor('superuser'), (client) =>
      client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM nexus.trace_events WHERE sandbox_id = $1 AND event = 'f05.trace.test'",
        [initialSandbox.id],
      ),
    );
    expect(traceRows.rows[0]?.count).toBe(1);
  });

  it('rejects malformed identifiers with a validation problem', async () => {
    const session = await login(api.port);
    const response = await request(api.port, '/api/v1/cases/not-a-uuid', {
      headers: { Cookie: session.cookie },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });
});

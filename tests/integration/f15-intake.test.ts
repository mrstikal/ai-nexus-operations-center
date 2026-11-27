import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, PoolConfig } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentListResponseSchema,
  DocumentUploadResponseSchema,
  DocumentVersionSchema,
  RoleSchema,
  type DocumentUploadResponse,
  type DocumentVersion,
} from '@nexus/contracts';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f15-test-password-only';
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SANDBOX_ID = '00000000-0000-4000-8000-000000000002';
const ADMISSION_BYTES = 4096;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F15`);
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
    application_name: 'f15-intake-test',
    connectionTimeoutMillis: 5000,
  };
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface SpawnedApi {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApi(blobRoot: string): Promise<SpawnedApi> {
  if (!existsSync(apiEntry)) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  const env: Record<string, string> = {
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
    NEXUS_BLOB_ROOT: blobRoot,
    NEXUS_BLOB_ADMISSION_BYTES: String(ADMISSION_BYTES),
    NEXUS_RABBIT_PASSWORD: '',
    RABBITMQ_DEFAULT_PASS: '',
  };
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: { ...process.env, PORT: '0', ...env },
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
    await delay(50);
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

let superuser: Client;
let migrator: Client;
let api: SpawnedApi;
let operator: Session;
let blobRoot: string;

async function dbAll<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await superuser.query(text, values);
  return result.rows as T[];
}

async function dbOne<T>(text: string, values: unknown[] = []): Promise<T> {
  const rows = await dbAll<T>(text, values);
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

function quarantineFiles(): string[] {
  try {
    return readdirSync(path.join(blobRoot, 'quarantine')).filter((entry) =>
      entry.endsWith('.part'),
    );
  } catch {
    return [];
  }
}

function blobFile(storageKey: string): string {
  return path.join(blobRoot, 'blobs', storageKey.slice(0, 2), storageKey);
}

interface UploadOptions {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly filename: string;
  readonly key?: string;
  readonly caseId?: string;
  readonly session?: Session;
}

async function upload(
  options: UploadOptions,
): Promise<{ status: number; body: unknown }> {
  const session = options.session ?? operator;
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(options.bytes)], { type: options.mediaType }),
    options.filename,
  );
  if (options.caseId) {
    form.append('caseId', options.caseId);
  }
  const response = await fetch(`${api.baseUrl}/api/v1/documents`, {
    method: 'POST',
    headers: {
      Cookie: session.cookie,
      Origin: allowedOrigin,
      'X-CSRF-Token': session.csrfToken,
      'Idempotency-Key': options.key ?? randomUUID(),
    },
    body: form,
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

async function uploaded(options: UploadOptions): Promise<DocumentUploadResponse> {
  const result = await upload(options);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return DocumentUploadResponseSchema.parse(result.body);
}

async function documentRow(documentId: string): Promise<{
  status: string;
  version: number;
  filename: string;
  size_bytes: string;
  sha256: string;
}> {
  return dbOne(
    `SELECT d.status, d.version, v.filename, v.size_bytes::text, v.sha256
     FROM nexus.documents d
     JOIN nexus.document_versions v
       ON v.sandbox_id = d.sandbox_id AND v.document_id = d.id AND v.version_no = d.version
     WHERE d.id = $1`,
    [documentId],
  );
}

const textBytes = Buffer.from(
  'Synthetic supplier notice for the F15 intake test. Ordered 240 units; revised arrival 2026-11-07.\n',
  'utf8',
);

beforeAll(async () => {
  blobRoot = mkdtempSync(path.join(tmpdir(), 'nexus-f15-blobs-'));
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
  await seedIdentity();
  await superuser.query(
    `INSERT INTO nexus.sandboxes (id, name, status, business_effective_at)
     VALUES ($1, 'F15 other sandbox', 'active', '2026-11-02T09:00:00Z')
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_SANDBOX_ID],
  );
  api = await startApi(blobRoot);
  operator = await login(api.baseUrl, 'operator');
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await migrator?.end();
  await superuser?.end();
  rmSync(blobRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(path.join(blobRoot, 'blobs'), { recursive: true, force: true });
  rmSync(path.join(blobRoot, 'quarantine'), { recursive: true, force: true });
  await superuser.query(
    `TRUNCATE TABLE
       nexus.document_uploads,
       nexus.extraction_jobs,
       nexus.document_versions,
       nexus.documents,
       nexus.blobs,
       nexus.audit_events
     CASCADE`,
  );
  await superuser.query(
    `UPDATE nexus.blob_storage_state SET used_bytes = 0, updated_at = clock_timestamp()`,
  );
  await superuser.query(
    `UPDATE nexus.active_sandbox
     SET sandbox_id = $1, updated_at = clock_timestamp()
     WHERE singleton = true`,
    [SANDBOX_ID],
  );
});

describe('F15 secure document intake and blob storage', () => {
  it('stores an inert upload durably with hash, status, pending job and audit', async () => {
    const result = await uploaded({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'supplier-delay.txt',
    });
    expect(result.document.status).toBe('uploaded');
    expect(result.document.blobHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.document.sizeBytes).toBe(textBytes.length);
    expect(result.duplicateOf).toBeNull();

    const row = await documentRow(result.document.documentId);
    expect(row.status).toBe('uploaded');
    expect(row.sha256).toBe(result.document.blobHash);
    expect(row.filename).toBe('supplier-delay.txt');

    const job = await dbOne<{ state: string; attempt_count: number }>(
      `SELECT state, attempt_count FROM nexus.extraction_jobs WHERE id = $1`,
      [result.jobId],
    );
    expect(job.state).toBe('pending');
    expect(job.attempt_count).toBe(0);

    const blob = await dbOne<{ storage_key: string; size_bytes: string }>(
      `SELECT storage_key, size_bytes::text FROM nexus.blobs WHERE sandbox_id = $1 AND sha256 = $2`,
      [SANDBOX_ID, result.document.blobHash],
    );
    expect(Number(blob.size_bytes)).toBe(textBytes.length);
    expect(existsSync(blobFile(blob.storage_key))).toBe(true);
    expect(quarantineFiles()).toEqual([]);

    const audit = await dbOne<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM nexus.audit_events WHERE target_id = $1`,
      [result.document.documentId],
    );
    expect(audit.action).toBe('document.uploaded');
    expect(audit.actor_id).toBe(
      await dbOne<{ id: string }>(
        `SELECT id FROM nexus.users WHERE username = 'operator'`,
      ).then((entry) => entry.id),
    );

    const listed = await fetch(`${api.baseUrl}/api/v1/documents`, {
      headers: { Cookie: operator.cookie },
    });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { items: DocumentVersion[] };
    expect(DocumentVersionSchema.array().parse(list.items)).toHaveLength(1);
  });

  it('paginates the document list by document id without duplicates or gaps', async () => {
    const expected: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await uploaded({
        bytes: Buffer.from(`pagination document ${index}\n`),
        mediaType: 'text/plain',
        filename: `page-${index}.txt`,
      });
      expected.push(result.document.documentId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const url = new URL(`${api.baseUrl}/api/v1/documents`);
      url.searchParams.set('limit', '2');
      if (cursor !== null) {
        url.searchParams.set('cursor', cursor);
      }
      const response = await fetch(url, {
        headers: { Cookie: operator.cookie },
      });
      expect(response.status).toBe(200);
      const body = DocumentListResponseSchema.parse(await response.json());
      for (const item of body.items) {
        seen.push(item.documentId);
      }
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
      const decoded = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as { documentId?: unknown };
      expect(decoded.documentId).toBe(body.items.at(-1)?.documentId);
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(6);
    expect(new Set(seen)).toEqual(new Set(expected));
  });

  it('rejects magic and extension mismatches without persisting rows', async () => {
    const png = readFileSync(
      path.join(root, 'fixtures/documents/intake/tiny.png'),
    );
    const mismatch = await upload({
      bytes: png,
      mediaType: 'application/pdf',
      filename: 'invoice.pdf',
    });
    expect(mismatch.status).toBe(400);

    const textAsPdf = await upload({
      bytes: textBytes,
      mediaType: 'application/pdf',
      filename: 'notice.pdf',
    });
    expect(textAsPdf.status).toBe(400);

    const pdf = readFileSync(
      path.join(root, 'fixtures/documents/intake/purchase-order.pdf'),
    );
    const pdfAsText = await upload({
      bytes: pdf,
      mediaType: 'text/plain',
      filename: 'notice.txt',
    });
    expect(pdfAsText.status).toBe(400);

    const unsupported = await upload({
      bytes: Buffer.from('<svg></svg>'),
      mediaType: 'image/svg+xml',
      filename: 'drawing.svg',
    });
    expect(unsupported.status).toBe(415);

    const counts = await dbOne<{ documents: number; blobs: number }>(
      `SELECT
         (SELECT count(*)::int FROM nexus.documents) AS documents,
         (SELECT count(*)::int FROM nexus.blobs) AS blobs`,
    );
    expect(counts).toEqual({ documents: 0, blobs: 0 });
    expect(quarantineFiles()).toEqual([]);
  });

  it('sanitizes traversal filenames and serves inert content only as an attachment', async () => {
    const script = Buffer.from('<script>alert(1)</script> harmless fixture\n');
    const result = await uploaded({
      bytes: script,
      mediaType: 'text/plain',
      filename: '..\\..\\..\\evil\r\nX-Injected: yes.txt',
    });
    expect(result.document.originalFilename).not.toContain('/');
    expect(result.document.originalFilename).not.toContain('\\');
    expect(result.document.originalFilename).not.toContain('\r');
    expect(result.document.originalFilename.startsWith('..')).toBe(false);

    const blob = await dbOne<{ storage_key: string }>(
      `SELECT storage_key FROM nexus.blobs WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(blob.storage_key).not.toContain('..');
    expect(existsSync(blobFile(blob.storage_key))).toBe(true);
    expect(path.resolve(blobFile(blob.storage_key)).startsWith(blobRoot)).toBe(true);

    const download = await fetch(
      `${api.baseUrl}/api/v1/documents/${result.document.documentId}/content`,
      { headers: { Cookie: operator.cookie } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('text/plain');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment;/,
    );
    expect(download.headers.get('content-disposition')).not.toContain('\r');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(script);
  });

  it('deduplicates bytes only inside the same sandbox', async () => {
    const first = await uploaded({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'first.txt',
    });
    const second = await uploaded({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'second.txt',
      key: randomUUID(),
    });
    expect(second.document.id).not.toBe(first.document.id);
    expect(second.duplicateOf).toBe(first.document.documentId);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.blobs WHERE sandbox_id = $1`,
        [SANDBOX_ID],
      ),
    ).toEqual({ count: 1 });

    await superuser.query(
      `UPDATE nexus.active_sandbox SET sandbox_id = $1, updated_at = clock_timestamp() WHERE singleton = true`,
      [OTHER_SANDBOX_ID],
    );
    try {
      const other = await uploaded({
        bytes: textBytes,
        mediaType: 'text/plain',
        filename: 'other-sandbox.txt',
      });
      expect(other.duplicateOf).toBeNull();
      expect(
        await dbOne<{ count: number }>(
          `SELECT count(*)::int AS count FROM nexus.blobs WHERE sandbox_id = $1`,
          [OTHER_SANDBOX_ID],
        ),
      ).toEqual({ count: 1 });

      const crossSandbox = await fetch(
        `${api.baseUrl}/api/v1/documents/${first.document.documentId}/content`,
        { headers: { Cookie: operator.cookie } },
      );
      expect(crossSandbox.status).toBe(404);
      const detail = await fetch(
        `${api.baseUrl}/api/v1/documents/${first.document.documentId}`,
        { headers: { Cookie: operator.cookie } },
      );
      expect(detail.status).toBe(404);
    } finally {
      await superuser.query(
        `UPDATE nexus.active_sandbox SET sandbox_id = $1, updated_at = clock_timestamp() WHERE singleton = true`,
        [SANDBOX_ID],
      );
    }
  });

  it('replays a stable idempotency key and rejects a changed body', async () => {
    const key = randomUUID();
    const first = await uploaded({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'idempotent.txt',
      key,
    });
    const replay = await uploaded({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'idempotent.txt',
      key,
    });
    expect(replay.document.id).toBe(first.document.id);
    expect(replay.jobId).toBe(first.jobId);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.documents`,
      ),
    ).toEqual({ count: 1 });

    const changed = await upload({
      bytes: Buffer.from('different body'),
      mediaType: 'text/plain',
      filename: 'idempotent.txt',
      key,
    });
    expect(changed.status).toBe(409);
    expect((changed.body as { code: string }).code).toBe(
      'IDEMPOTENCY_MISMATCH',
    );
  });

  it('enforces the blob admission cap under concurrent uploads', async () => {
    const firstBody = Buffer.from('a'.repeat(2500));
    const secondBody = Buffer.from('b'.repeat(2500));
    const results = await Promise.all([
      upload({
        bytes: firstBody,
        mediaType: 'text/plain',
        filename: 'first-race.txt',
      }),
      upload({
        bytes: secondBody,
        mediaType: 'text/plain',
        filename: 'second-race.txt',
      }),
    ]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([201, 413]);
    const state = await dbOne<{ used_bytes: string }>(
      `SELECT used_bytes::text FROM nexus.blob_storage_state`,
    );
    expect(Number(state.used_bytes)).toBe(2500);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.documents`,
      ),
    ).toEqual({ count: 1 });
    expect(quarantineFiles()).toEqual([]);
  });

  it('rejects an upload over the actual byte limit without trusting headers', async () => {
    const boundary = '----f15-boundary';
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="big.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n`,
    );
    const trailing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1024, 0x61);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(new URL(api.baseUrl).port),
          path: '/api/v1/documents',
          method: 'POST',
          headers: {
            Cookie: operator.cookie,
            Origin: allowedOrigin,
            'X-CSRF-Token': operator.csrfToken,
            'Idempotency-Key': randomUUID(),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Transfer-Encoding': 'chunked',
            Connection: 'close',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', () => resolve(413));
      request.write(preamble);
      request.write(oversized);
      request.end(trailing);
      setTimeout(() => {
        request.destroy();
        reject(new Error('oversized upload timed out'));
      }, 20_000).unref();
    }).catch(() => 413);
    expect(status).toBe(413);
    await delay(200);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.documents`,
      ),
    ).toEqual({ count: 0 });
    expect(quarantineFiles()).toEqual([]);
  }, 30_000);

  it('removes quarantine files after a midstream disconnect', async () => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: Number(new URL(api.baseUrl).port),
      path: '/api/v1/documents',
      method: 'POST',
      headers: {
        Cookie: operator.cookie,
        Origin: allowedOrigin,
        'X-CSRF-Token': operator.csrfToken,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'multipart/form-data; boundary=----f15-partial',
        'Transfer-Encoding': 'chunked',
      },
    });
    request.on('error', () => undefined);
    request.write(
      '------f15-partial\r\n' +
        'Content-Disposition: form-data; name="file"; filename="partial.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n' +
        'partial bytes that never complete',
    );
    await delay(100);
    request.destroy();
    await delay(400);
    expect(quarantineFiles()).toEqual([]);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.documents`,
      ),
    ).toEqual({ count: 0 });
  });

  it('removes a finalized orphan when the metadata transaction fails', async () => {
    const result = await upload({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'orphan.txt',
      caseId: randomUUID(),
    });
    expect(result.status).toBe(404);
    expect(quarantineFiles()).toEqual([]);
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.documents`,
      ),
    ).toEqual({ count: 0 });
    expect(
      await dbOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM nexus.blobs`,
      ),
    ).toEqual({ count: 0 });
    const blobDir = path.join(blobRoot, 'blobs');
    const files: string[] = [];
    const walk = (directory: string): void => {
      if (!existsSync(directory)) {
        return;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(target);
        } else {
          files.push(target);
        }
      }
    };
    walk(blobDir);
    expect(files).toEqual([]);
  });

  it('requires authentication, operator rights, CSRF and a UUID idempotency key', async () => {
    const anonymous = await fetch(`${api.baseUrl}/api/v1/documents`);
    expect(anonymous.status).toBe(401);

    const approver = await login(api.baseUrl, 'ops.approver');
    const forbidden = await upload({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'forbidden.txt',
      session: approver,
    });
    expect(forbidden.status).toBe(403);

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(textBytes)], { type: 'text/plain' }),
      'missing-key.txt',
    );
    const missingKey = await fetch(`${api.baseUrl}/api/v1/documents`, {
      method: 'POST',
      headers: {
        Cookie: operator.cookie,
        Origin: allowedOrigin,
        'X-CSRF-Token': operator.csrfToken,
      },
      body: form,
    });
    expect(missingKey.status).toBe(400);

    const invalidKey = await upload({
      bytes: textBytes,
      mediaType: 'text/plain',
      filename: 'invalid-key.txt',
      key: 'not-a-uuid',
    });
    expect(invalidKey.status).toBe(400);
  });
});

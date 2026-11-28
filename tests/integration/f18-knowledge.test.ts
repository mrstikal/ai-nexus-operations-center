import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, PoolConfig } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceSchema,
  KnowledgeIngestResponseSchema,
  KnowledgeListResponseSchema,
  KnowledgePublicationResponseSchema,
  KnowledgeSearchResponseSchema,
  RoleSchema,
  type KnowledgeIngestResponse,
  type KnowledgePublicationResponse,
  type KnowledgeSearchResponse,
} from '@nexus/contracts';
import { sliceKnowledgeText } from '@nexus/application/knowledge/chunk';
import { hashPassword } from '@nexus/application/identity/passwords';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createIdentityUser } from '@nexus/db/repositories/identity';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SANDBOX_ID = '00000000-0000-4000-8000-000000000002';
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f18-test-password-only';
const POLICY_PATH = 'fixtures/knowledge/northstar-v1.md';
const SUPPORT_PATH = 'fixtures/knowledge/support-guide.md';
const INJECT_PATH = 'fixtures/security/inject-policy.md';

const policyText = readFileSync(path.join(root, POLICY_PATH), 'utf8');
const injectText = readFileSync(path.join(root, INJECT_PATH), 'utf8');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F18`);
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
    application_name: 'f18-knowledge-test',
    connectionTimeoutMillis: 5000,
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface SpawnedApi {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApi(): Promise<SpawnedApi> {
  if (!existsSync(apiEntry)) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  const child: ChildProcess = spawn(process.execPath, [apiEntry], {
    cwd: root,
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
      NEXUS_BLOB_ROOT: path.join(tmpdir(), 'nexus-f18-unused-blobs'),
      NEXUS_RABBIT_PASSWORD: '',
      RABBITMQ_DEFAULT_PASS: '',
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
  const responseText = await response.text();
  if (response.status !== 200) {
    throw new Error(`Login ${username} failed: ${response.status} ${responseText}`);
  }
  const cookie = response.headers.getSetCookie?.()[0]?.split(';')[0] ?? '';
  const body = JSON.parse(responseText) as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

let superuser: Client;
let migrator: Client;
let api: SpawnedApi;
let operator: Session;
let admin: Session;
let viewer: Session;

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
  await superuser.query(
    'TRUNCATE TABLE nexus.sessions, nexus.user_roles, nexus.users CASCADE',
  );
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

interface ApiCallOptions {
  readonly session: Session;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
  readonly csrf?: boolean;
}

async function call(options: ApiCallOptions): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: options.session.cookie,
    Origin: allowedOrigin,
  };
  if (options.csrf !== false) {
    headers['X-CSRF-Token'] = options.session.csrfToken;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${api.baseUrl}${options.url}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function ingest(
  session: Session,
  body: {
    kind: 'policy' | 'informational';
    policyId?: string;
    path: string;
    effectiveFrom?: string;
  },
): Promise<KnowledgeIngestResponse> {
  const response = await call({
    session,
    method: 'POST',
    url: '/api/v1/knowledge',
    body,
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return KnowledgeIngestResponseSchema.parse(JSON.parse(text));
}

async function publish(
  session: Session,
  documentId: string,
): Promise<KnowledgePublicationResponse> {
  const response = await call({
    session,
    method: 'POST',
    url: `/api/v1/knowledge/${documentId}/publish`,
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return KnowledgePublicationResponseSchema.parse(JSON.parse(text));
}

async function search(
  session: Session,
  body: {
    query: string;
    limit?: number;
    policyId?: string;
    kind?: 'policy' | 'informational';
    effectiveAt?: string;
  },
): Promise<KnowledgeSearchResponse> {
  const response = await call({
    session,
    method: 'POST',
    url: '/api/v1/knowledge/search',
    body,
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return KnowledgeSearchResponseSchema.parse(JSON.parse(text));
}

async function seedProposal(approved = true): Promise<{
  proposalId: string;
  revisionId: string;
}> {
  const caseId = randomUUID();
  const proposalId = randomUUID();
  const revisionId = randomUUID();
  const itemId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases (
       id, sandbox_id, title, summary, status, version, terminal_reason,
       created_at, updated_at
     ) VALUES ($1, $2, 'F18 knowledge case', NULL, 'investigating', 1, NULL,
               clock_timestamp(), clock_timestamp())`,
    [caseId, SANDBOX_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.action_proposals (
       id, sandbox_id, case_id, current_revision_id, status, has_procurement,
       created_by_kind, created_by_id, version, created_at, updated_at
     ) VALUES ($1, $2, $3, NULL, $4, false, 'human', 'operator', 1,
               clock_timestamp(), clock_timestamp())`,
    [proposalId, SANDBOX_ID, caseId, approved ? 'approved' : 'pending_approval'],
  );
  await superuser.query(
    `INSERT INTO nexus.action_revisions (
       id, sandbox_id, proposal_id, revision_number, state, plan_hash, items,
       required_roles, aggregate_impact_minor, is_procurement, policy_revision,
       policy_content_hash, rationale, authored_by_kind, authored_by_id,
       authored_by_roles, expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, '["operator"]'::jsonb,
               NULL, false, 'northstar-v1', $7, 'F18 invalidation fixture',
               'human', 'operator', '["operator"]'::jsonb,
               clock_timestamp() + interval '24 hours',
               clock_timestamp(), clock_timestamp())`,
    [
      revisionId,
      SANDBOX_ID,
      proposalId,
      approved ? 'approved' : 'pending_approval',
      'a'.repeat(64),
      JSON.stringify([
        {
          itemId,
          target: {
            system: 'nexus',
            type: 'case',
            id: caseId,
            version: 1,
          },
          evidenceIds: [],
          payload: {
            kind: 'case.add_internal_note',
            caseId,
            text: 'F18 knowledge invalidation fixture',
          },
          dependsOnItemIds: [],
          baseExpectedVersions: [],
        },
      ]),
      'b'.repeat(64),
    ],
  );
  await superuser.query(
    `UPDATE nexus.action_proposals
     SET current_revision_id = $1, updated_at = clock_timestamp()
     WHERE sandbox_id = $2 AND id = $3`,
    [revisionId, SANDBOX_ID, proposalId],
  );
  return { proposalId, revisionId };
}

async function seedForeignSandboxKnowledge(): Promise<void> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const evidenceId = randomUUID();
  const chunkText = 'wombat logistics reserve guidance unique';
  await superuser.query(
    `INSERT INTO nexus.sandboxes
       (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, 'F18 other sandbox', 'active', '2026-11-02T09:00:00Z', 1,
             clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_SANDBOX_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.knowledge_documents
       (id, sandbox_id, kind, policy_id, source_path, created_at)
     VALUES ($1, $2, 'informational', NULL, $3, clock_timestamp())`,
    [documentId, OTHER_SANDBOX_ID, SUPPORT_PATH],
  );
  await superuser.query(
    `INSERT INTO nexus.knowledge_versions
       (id, sandbox_id, document_id, version_no, state, content_sha256,
        policy_bundle_version, policy_content_hash, effective_from,
        effective_until, published_at, withdrawn_at, source_path, char_count,
        chunk_count, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 'published', $4, NULL, NULL, clock_timestamp(),
             NULL, clock_timestamp(), NULL, $5, $6, 1, clock_timestamp(),
             clock_timestamp())`,
    [
      versionId,
      OTHER_SANDBOX_ID,
      documentId,
      sha256(chunkText),
      SUPPORT_PATH,
      [...chunkText].length,
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.evidence (
       id, sandbox_id, case_id, kind, source_status, source_system, source_type,
       source_id, source_version, source_sandbox_id, content_hash, locator,
       captured_facts, missing_reason, captured_at
     ) VALUES ($1, $2, NULL, 'knowledge_chunk', 'available', 'nexus',
               'knowledge_chunk', $3, 1, $2, $4, $5::jsonb, $6::jsonb, NULL,
               clock_timestamp())`,
    [
      evidenceId,
      OTHER_SANDBOX_ID,
      chunkId,
      sha256(chunkText),
      JSON.stringify({
        documentVersionId: versionId,
        page: null,
        startOffset: 0,
        endOffset: [...chunkText].length,
      }),
      JSON.stringify({ text: chunkText }),
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.knowledge_chunks (
       id, sandbox_id, document_version_id, chunk_index, heading_path, text,
       char_count, token_count, locator, content_sha256, evidence_id, created_at
     ) VALUES ($1, $2, $3, 0, '[]'::jsonb, $4, $5, 5, $6::jsonb, $7, $8,
               clock_timestamp())`,
    [
      chunkId,
      OTHER_SANDBOX_ID,
      versionId,
      chunkText,
      [...chunkText].length,
      JSON.stringify({
        sourcePath: SUPPORT_PATH,
        headingPath: [],
        startOffset: 0,
        endOffset: [...chunkText].length,
      }),
      sha256(chunkText),
      evidenceId,
    ],
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
  await seedIdentity();
  await superuser.query(
    `INSERT INTO nexus.sandboxes
       (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, 'F18 sandbox', 'active', '2026-11-02T09:00:00Z', 1,
             clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [SANDBOX_ID],
  );
  await superuser.query(
    `UPDATE nexus.active_sandbox
     SET sandbox_id = $1, updated_at = clock_timestamp()
     WHERE singleton = true`,
    [SANDBOX_ID],
  );
  api = await startApi();
  operator = await login(api.baseUrl, 'operator');
  admin = await login(api.baseUrl, 'finance.admin');
  viewer = await login(api.baseUrl, 'ops.approver');
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.knowledge_chunks,
       nexus.knowledge_versions,
       nexus.knowledge_documents,
       nexus.knowledge_retrieval_state,
       nexus.action_revision_evidence,
       nexus.approval_decisions,
       nexus.action_executions,
       nexus.action_revisions,
       nexus.action_proposals,
       nexus.workflow_runs,
       nexus.evidence,
       nexus.audit_events,
       nexus.event_outbox,
       nexus.model_calls,
       nexus.cases
     CASCADE`,
  );
});

describe('F18 versioned knowledge and lexical policy retrieval', () => {
  it('publishes the canonical policy idempotently and retrieves exact locatable chunks', async () => {
    const first = await ingest(admin, {
      kind: 'policy',
      policyId: 'northstar',
      path: POLICY_PATH,
    });
    expect(first.deduplicated).toBe(false);
    expect(first.document.kind).toBe('policy');
    expect(first.document.policyId).toBe('northstar');
    expect(first.document.latestVersion?.state).toBe('draft');
    expect(first.document.latestVersion?.chunkCount).toBeGreaterThan(0);

    const second = await ingest(admin, {
      kind: 'policy',
      policyId: 'northstar',
      path: POLICY_PATH,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.document.latestVersion?.id).toBe(
      first.document.latestVersion?.id,
    );

    const published = await publish(admin, first.document.id);
    expect(published.changed).toBe(true);
    expect(published.version.state).toBe('published');
    expect(published.retrievalGeneration).toBeGreaterThanOrEqual(1);

    const result = await search(operator, {
      query: 'finance approval cumulative procurement commitment',
      policyId: 'northstar',
      limit: 6,
    });
    expect(result.mode).toBe('lexical');
    expect(result.noEvidence).toBe(false);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.policyBundleVersion).toBe('northstar-v1');
      expect(chunk.locator.sourcePath).toBe(POLICY_PATH);
      expect(chunk.locator.startOffset).toBeLessThan(chunk.locator.endOffset);
      expect(sliceKnowledgeText(policyText, chunk.locator)).toBe(chunk.text);
      expect(chunk.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const chunkIds = result.chunks.map((chunk) => chunk.id).sort();
    const evidenceRows = await dbAll<{
      id: string;
      kind: string;
      source_type: string;
      source_id: string;
    }>(
      `SELECT id, kind, source_type, source_id
       FROM nexus.evidence
       WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(evidenceRows).toHaveLength(
      first.document.latestVersion?.chunkCount ?? 0,
    );
    expect(evidenceRows.every((row) => row.kind === 'knowledge_chunk')).toBe(true);
    expect(
      evidenceRows.every((row) => row.source_type === 'knowledge_chunk'),
    ).toBe(true);
    for (const chunkId of chunkIds) {
      expect(evidenceRows.some((row) => row.source_id === chunkId)).toBe(true);
    }

    const events = await dbAll<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, payload FROM nexus.event_outbox
       WHERE sandbox_id = $1 ORDER BY created_at ASC`,
      [SANDBOX_ID],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('nexus.knowledge.changed.v1');
    expect(events[0]!.payload).toMatchObject({
      documentId: first.document.id,
      publicationState: 'published',
      retrievalGeneration: published.retrievalGeneration,
    });
    const audit = await dbOne<{ action: string }>(
      `SELECT action FROM nexus.audit_events
       WHERE target_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [first.document.id],
    );
    expect(audit.action).toBe('knowledge.published');
  });

  it('excludes draft, expired, withdrawn and cross-sandbox chunks before ranking', async () => {
    const guide = await ingest(admin, {
      kind: 'informational',
      path: SUPPORT_PATH,
    });
    const draftSearch = await search(operator, {
      query: 'reconciliation basics',
    });
    expect(draftSearch.noEvidence).toBe(true);
    expect(draftSearch.chunks).toEqual([]);

    await publish(admin, guide.document.id);
    const publishedSearch = await search(operator, {
      query: 'reconciliation basics',
    });
    expect(publishedSearch.noEvidence).toBe(false);
    expect(
      publishedSearch.chunks.some((chunk) => chunk.text.includes('reconciliation')),
    ).toBe(true);

    const earlySearch = await search(operator, {
      query: 'reconciliation basics',
      effectiveAt: '2000-01-01T00:00:00.000Z',
    });
    expect(earlySearch.noEvidence).toBe(true);

    await superuser.query(
      `UPDATE nexus.knowledge_versions
       SET effective_until = clock_timestamp() - interval '1 hour'
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, guide.document.latestVersion?.id],
    );
    const expiredSearch = await search(operator, {
      query: 'reconciliation basics',
    });
    expect(expiredSearch.noEvidence).toBe(true);

    await superuser.query(
      `UPDATE nexus.knowledge_versions
       SET effective_until = NULL
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, guide.document.latestVersion?.id],
    );
    const revokeResponse = await call({
      session: admin,
      method: 'POST',
      url: `/api/v1/knowledge/${guide.document.id}/revoke`,
      body: { reason: 'Guide withdrawn for revision' },
    });
    const revokeText = await revokeResponse.text();
    expect(revokeResponse.status, revokeText).toBe(200);
    KnowledgePublicationResponseSchema.parse(JSON.parse(revokeText));
    const withdrawnSearch = await search(operator, {
      query: 'reconciliation basics',
    });
    expect(withdrawnSearch.noEvidence).toBe(true);

    await seedForeignSandboxKnowledge();
    const crossSandbox = await search(operator, {
      query: 'wombat logistics',
    });
    expect(crossSandbox.noEvidence).toBe(true);
  });

  it('keeps pinned versions and evidence resolvable after a newer publication', async () => {
    const guide = await ingest(admin, {
      kind: 'informational',
      path: SUPPORT_PATH,
    });
    const firstPublication = await publish(admin, guide.document.id);
    const oldVersionId = firstPublication.version.id;
    const oldSearch = await search(operator, {
      query: 'supplier delay triage',
    });
    expect(oldSearch.noEvidence).toBe(false);
    const oldChunk = oldSearch.chunks.find((chunk) =>
      chunk.text.includes('Supplier delay triage'),
    );
    expect(oldChunk).toBeDefined();
    expect(oldChunk!.documentVersionId).toBe(oldVersionId);

    const replacementText = 'Replacement guidance about quokka logistics.';
    const replacementVersionId = randomUUID();
    await superuser.query(
      `INSERT INTO nexus.knowledge_versions
         (id, sandbox_id, document_id, version_no, state, content_sha256,
          policy_bundle_version, policy_content_hash, effective_from,
          effective_until, published_at, withdrawn_at, source_path, char_count,
          chunk_count, created_at, updated_at)
       VALUES ($1, $2, $3, 2, 'draft', $4, NULL, NULL, clock_timestamp(), NULL,
               NULL, NULL, $5, $6, 1, clock_timestamp(), clock_timestamp())`,
      [
        replacementVersionId,
        SANDBOX_ID,
        guide.document.id,
        sha256(replacementText),
        SUPPORT_PATH,
        [...replacementText].length,
      ],
    );
    const locator = {
      sourcePath: SUPPORT_PATH,
      headingPath: ['Replacement guidance'],
      startOffset: 0,
      endOffset: [...replacementText].length,
    };
    await superuser.query(
      `INSERT INTO nexus.knowledge_chunks (
         id, sandbox_id, document_version_id, chunk_index, heading_path, text,
         char_count, token_count, locator, content_sha256, evidence_id, created_at
       ) VALUES ($1, $2, $3, 0, '["Replacement guidance"]'::jsonb, $4, $5, 6,
                 $6::jsonb, $7, NULL, clock_timestamp())`,
      [
        randomUUID(),
        SANDBOX_ID,
        replacementVersionId,
        replacementText,
        [...replacementText].length,
        JSON.stringify(locator),
        sha256(replacementText),
      ],
    );

    const secondPublication = await publish(admin, guide.document.id);
    expect(secondPublication.version.id).toBe(replacementVersionId);
    expect(secondPublication.version.versionNo).toBe(2);
    expect(secondPublication.retrievalGeneration).toBeGreaterThan(
      firstPublication.retrievalGeneration,
    );

    const superseded = await dbOne<{ state: string }>(
      `SELECT state FROM nexus.knowledge_versions
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, oldVersionId],
    );
    expect(superseded.state).toBe('superseded');
    const oldEvidence = await dbOne<{ id: string; captured_facts: { text: string } }>(
      `SELECT id, captured_facts FROM nexus.evidence
       WHERE sandbox_id = $1 AND source_id = $2`,
      [SANDBOX_ID, oldChunk!.id],
    );
    expect(oldEvidence.captured_facts.text).toBe(oldChunk!.text);
    const evidenceResponse = await call({
      session: operator,
      method: 'GET',
      url: `/api/v1/evidence/${oldEvidence.id}`,
    });
    const evidenceText = await evidenceResponse.text();
    expect(evidenceResponse.status, evidenceText).toBe(200);
    const evidence = EvidenceSchema.parse(JSON.parse(evidenceText));
    expect(evidence.contentHash).toBe(sha256(oldChunk!.text));
    expect(evidence.sourceRef).toMatchObject({
      type: 'knowledge_chunk',
      id: oldChunk!.id,
      version: 1,
    });

    const oldQuery = await search(operator, {
      query: 'supplier delay triage',
    });
    expect(oldQuery.noEvidence).toBe(true);
    const newQuery = await search(operator, {
      query: 'quokka logistics',
      kind: 'informational',
    });
    expect(newQuery.noEvidence).toBe(false);
    expect(newQuery.chunks[0]?.documentVersionId).toBe(replacementVersionId);
    expect(sliceKnowledgeText(replacementText, newQuery.chunks[0]!.locator)).toBe(
      replacementText,
    );
  });

  it('expires unexecuted proposals on policy publication and revocation only', async () => {
    const policy = await ingest(admin, {
      kind: 'policy',
      policyId: 'northstar',
      path: POLICY_PATH,
    });
    const proposal = await seedProposal(true);
    const publication = await publish(admin, policy.document.id);
    expect(publication.expiredProposalIds).toContain(proposal.proposalId);
    const expiredProposal = await dbOne<{ status: string }>(
      `SELECT status FROM nexus.action_proposals WHERE id = $1`,
      [proposal.proposalId],
    );
    expect(expiredProposal.status).toBe('expired');
    const expiredRevision = await dbOne<{ state: string }>(
      `SELECT state FROM nexus.action_revisions WHERE id = $1`,
      [proposal.revisionId],
    );
    expect(expiredRevision.state).toBe('expired');

    const secondProposal = await seedProposal(true);
    const guide = await ingest(admin, {
      kind: 'informational',
      path: SUPPORT_PATH,
    });
    const informationalPublication = await publish(admin, guide.document.id);
    expect(informationalPublication.expiredProposalIds).toEqual([]);
    const stillOpen = await dbOne<{ status: string }>(
      `SELECT status FROM nexus.action_proposals WHERE id = $1`,
      [secondProposal.proposalId],
    );
    expect(stillOpen.status).toBe('approved');

    const revokeResponse = await call({
      session: admin,
      method: 'POST',
      url: `/api/v1/knowledge/${policy.document.id}/revoke`,
      body: {
        versionId: publication.version.id,
        reason: 'Policy text superseded by a reviewed configuration change',
      },
    });
    const revokeText = await revokeResponse.text();
    expect(revokeResponse.status, revokeText).toBe(200);
    const revocation = KnowledgePublicationResponseSchema.parse(
      JSON.parse(revokeText),
    );
    expect(revocation.version.state).toBe('withdrawn');
    expect(revocation.retrievalGeneration).toBeGreaterThan(
      informationalPublication.retrievalGeneration,
    );
    expect(revocation.expiredProposalIds).toContain(secondProposal.proposalId);
    const revokedSearch = await search(operator, {
      query: 'finance approval cumulative procurement commitment',
    });
    expect(revokedSearch.noEvidence).toBe(true);
    const events = await dbAll<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM nexus.event_outbox
       WHERE sandbox_id = $1 AND event_type = 'nexus.knowledge.changed.v1'
       ORDER BY created_at ASC`,
      [SANDBOX_ID],
    );
    expect(events.map((event) => event.payload['publicationState'])).toEqual([
      'published',
      'published',
      'withdrawn',
    ]);
  });

  it('blocks publication when the policy text does not match the canonical bundle', async () => {
    const injected = await ingest(admin, {
      kind: 'policy',
      policyId: 'northstar',
      path: INJECT_PATH,
    });
    const response = await call({
      session: admin,
      method: 'POST',
      url: `/api/v1/knowledge/${injected.document.id}/publish`,
    });
    const body = await response.text();
    expect(response.status, body).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ code: 'CONFLICT' });
    const version = await dbOne<{ state: string }>(
      `SELECT state FROM nexus.knowledge_versions
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, injected.document.latestVersion?.id],
    );
    expect(version.state).toBe('draft');
    const evidenceCount = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM nexus.evidence WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(evidenceCount.count).toBe(0);
    const events = await dbAll(
      `SELECT id FROM nexus.event_outbox WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(events).toHaveLength(0);
  });

  it('keeps injected policy text as inert untrusted data', async () => {
    const informational = await ingest(admin, {
      kind: 'informational',
      path: INJECT_PATH,
    });
    await publish(admin, informational.document.id);
    const result = await search(operator, {
      query: 'system instruction purchase order approval',
      kind: 'informational',
    });
    expect(result.noEvidence).toBe(false);
    const injectedChunk = result.chunks.find((chunk) =>
      chunk.text.includes('SYSTEM INSTRUCTION'),
    );
    expect(injectedChunk).toBeDefined();
    expect(injectedChunk!.policyBundleVersion).toBeNull();
    expect(sliceKnowledgeText(injectText, injectedChunk!.locator)).toBe(
      injectedChunk!.text,
    );
    const proposals = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM nexus.action_proposals WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(proposals.count).toBe(0);
    const executions = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM nexus.action_executions WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(executions.count).toBe(0);
    const enterpriseEvents = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM nexus.event_outbox
       WHERE sandbox_id = $1 AND event_type LIKE 'enterprise.%'`,
      [SANDBOX_ID],
    );
    expect(enterpriseEvents.count).toBe(0);
    const modelCalls = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM nexus.model_calls WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(modelCalls.count).toBe(0);
  });

  it('restricts knowledge management and validates requests', async () => {
    const viewerIngest = await call({
      session: viewer,
      method: 'POST',
      url: '/api/v1/knowledge',
      body: { kind: 'informational', path: SUPPORT_PATH },
    });
    expect(viewerIngest.status).toBe(403);
    const operatorIngest = await call({
      session: operator,
      method: 'POST',
      url: '/api/v1/knowledge',
      body: { kind: 'informational', path: SUPPORT_PATH },
    });
    expect(operatorIngest.status).toBe(403);
    const operatorPublish = await call({
      session: operator,
      method: 'POST',
      url: `/api/v1/knowledge/${randomUUID()}/publish`,
    });
    expect(operatorPublish.status).toBe(403);
    const viewerSearch = await call({
      session: viewer,
      method: 'POST',
      url: '/api/v1/knowledge/search',
      body: { query: 'policy' },
    });
    expect(viewerSearch.status).toBe(403);
    const missingCsrf = await call({
      session: admin,
      method: 'POST',
      url: '/api/v1/knowledge',
      body: { kind: 'informational', path: SUPPORT_PATH },
      csrf: false,
    });
    expect(missingCsrf.status).toBe(403);

    const traversal = await call({
      session: admin,
      method: 'POST',
      url: '/api/v1/knowledge',
      body: { kind: 'informational', path: 'fixtures/security/inject-email.eml' },
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const oversizedLimit = await call({
      session: operator,
      method: 'POST',
      url: '/api/v1/knowledge/search',
      body: { query: 'policy', limit: 7 },
    });
    expect(oversizedLimit.status).toBe(400);

    const missingDocument = await call({
      session: admin,
      method: 'POST',
      url: `/api/v1/knowledge/${randomUUID()}/publish`,
    });
    expect(missingDocument.status).toBe(404);

    const noPublishedVersion = await call({
      session: admin,
      method: 'POST',
      url: `/api/v1/knowledge/${randomUUID()}/revoke`,
      body: { reason: 'unknown' },
    });
    expect(noPublishedVersion.status).toBe(404);

    const list = await call({
      session: viewer,
      method: 'GET',
      url: '/api/v1/knowledge',
    });
    const listText = await list.text();
    expect(list.status, listText).toBe(200);
    const parsedList = KnowledgeListResponseSchema.parse(JSON.parse(listText));
    expect(parsedList.items).toEqual([]);
    expect(parsedList.nextCursor).toBeNull();
  });
});

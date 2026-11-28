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
  DOCUMENT_PARSER_VERSION,
  DocumentExtractionRevisionSchema,
  RoleSchema,
  type DocumentExtractionRevision,
  type GatewayRequest,
  type ModelGateway,
} from '@nexus/contracts';
import type { DocumentExtractionCorrectionField } from '@nexus/contracts';
import { loadReplayManifest } from '@nexus/ai/replay';
import { listPromptVersions } from '@nexus/ai/prompts';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { createDocumentExtractionStore } from '@nexus/db/repositories/document-extraction';
import { hashPassword } from '@nexus/application/identity/passwords';
import {
  classificationRequest,
  extractionRequest,
  extractionSourceText,
} from '@nexus/application/documents/classify';
import {
  DocumentExtractionService,
} from '@nexus/application/documents/extract';
import {
  DocumentCorrectionConflictError,
  DocumentCorrectionService,
} from '@nexus/application/documents/correct';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f17-test-password-only';

const TEXT =
  'SUPPLIER DELAY NOTICE\n' +
  'Supplier: Northstar Components AB\n' +
  'Purchase order: PO-2026-0001\n' +
  'Original delivery date: 2026-11-03\n' +
  'Revised delivery date: 2026-11-07\n' +
  'Affected product: NS-100, 240 units\n';

const INVOICE_TEXT =
  'INVOICE\nSupplier: Northstar Components AB\nInvoice number: INV-2026-0017\n' +
  'Purchase order: PO-2026-0001\nCurrency: EUR\nNet amount: 125000\nTax amount: 25000\n' +
  'Gross amount: 150000\nInvoice date: 2026-11-05\n';

const UNICODE_TEXT =
  'Dokument 𝟙\nSupplier: Northstar Components AB\nPurchase order: PO-2026-0001\n';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F17`);
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
    application_name: 'f17-extraction-test',
    connectionTimeoutMillis: 5000,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function span(text: string, value: string, page = 1) {
  const start = text.indexOf(value);
  if (start < 0) {
    throw new Error(`Fixture text does not contain ${value}`);
  }
  return { page, start, end: start + value.length };
}

function codePointSpan(text: string, value: string, page = 1) {
  const utf16Start = text.indexOf(value);
  if (utf16Start < 0) {
    throw new Error(`Fixture text does not contain ${value}`);
  }
  const start = [...text.slice(0, utf16Start)].length;
  return { page, start, end: start + [...value].length };
}

function field(
  name: string,
  value: string | null,
  source: { page: number; start: number; end: number } | null,
  status: 'extracted' | 'missing' | 'ambiguous',
  alternatives?: string[],
) {
  return {
    field: name,
    value,
    source,
    status,
    ...(alternatives === undefined ? {} : { alternatives }),
  };
}

class FakeGateway implements ModelGateway {
  calls: Array<{ role: string; outputSchemaId: string }> = [];
  constructor(
    private readonly classification: unknown,
    private readonly extraction: unknown,
  ) {}

  async invoke(request: GatewayRequest) {
    this.calls.push({
      role: request.role,
      outputSchemaId: request.outputSchemaId,
    });
    const output =
      request.role === 'classify' ? this.classification : this.extraction;
    return {
      ok: true as const,
      output: output as never,
      provider: 'replay',
      model: 'replay-v1',
      attemptIds: [randomUUID()],
      usage: null,
      cost: { amountMicrousd: '0', basis: 'replay' as const },
      promptVersion: 'v1',
      configRevision: 'models-default-2026-11-26',
      diagnostics: [],
    };
  }

  async *stream(): AsyncIterable<never> {
    yield* [];
  }
}

function supplyGateway(overrides?: {
  readonly fields?: ReturnType<typeof field>[];
  readonly kind?: string;
}): FakeGateway {
  return new FakeGateway(
    {
      kind: overrides?.kind ?? 'supply_exception',
      evidenceIds: [],
      missingFields: [],
    },
    {
      kind: overrides?.kind ?? 'supply_exception',
      fields:
        overrides?.fields ??
        [
          field('supplier_name', 'Northstar Components AB', span(TEXT, 'Northstar Components AB'), 'extracted'),
          field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
          field('delivery_date', '2026-11-07', span(TEXT, '2026-11-07'), 'extracted', ['2026-11-03']),
          field('description', 'Affected product: NS-100, 240 units', span(TEXT, 'Affected product: NS-100, 240 units'), 'extracted'),
        ],
    },
  );
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
      NEXUS_BLOB_ROOT: path.join(tmpdir(), 'nexus-f17-unused-blobs'),
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
let workerDb: ReturnType<typeof createNexusDb>;
let apiPool: ReturnType<typeof createNexusPool> | undefined;
let proposalStore: ReturnType<typeof createActionProposalStore>;
let extractionStore: ReturnType<typeof createDocumentExtractionStore>;
let api: SpawnedApi;
let operator: Session;
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

interface SeededDocument {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly caseId: string;
}

async function seedDocument(text = TEXT): Promise<SeededDocument> {
  const documentId = randomUUID();
  const documentVersionId = randomUUID();
  const blobId = randomUUID();
  const caseId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases (
       id, sandbox_id, title, summary, status, version, terminal_reason, created_at, updated_at
     ) VALUES ($1, $2, 'F17 extraction case', NULL, 'investigating', 1, NULL,
               clock_timestamp(), clock_timestamp())`,
    [caseId, SANDBOX_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.blobs (
       id, sandbox_id, sha256, size_bytes, media_type, storage_key, state, created_at
     ) VALUES ($1, $2, $3, $4, 'text/plain', $5, 'available', clock_timestamp())`,
    [blobId, SANDBOX_ID, sha256(text), Buffer.byteLength(text), randomUUID()],
  );
  await superuser.query(
    `INSERT INTO nexus.documents (
       id, sandbox_id, case_id, status, version, created_at, updated_at
     ) VALUES ($1, $2, $3, 'ready', 1, clock_timestamp(), clock_timestamp())`,
    [documentId, SANDBOX_ID, caseId],
  );
  await superuser.query(
    `INSERT INTO nexus.document_versions (
       id, sandbox_id, document_id, version_no, blob_id, filename, media_type,
       size_bytes, sha256, status, page_count, parser_version, created_at
     ) VALUES ($1, $2, $3, 1, $4, 'supplier-notice.txt', 'text/plain', $5, $6,
               'ready', 1, $7, clock_timestamp())`,
    [
      documentVersionId,
      SANDBOX_ID,
      documentId,
      blobId,
      Buffer.byteLength(text),
      sha256(text),
      DOCUMENT_PARSER_VERSION,
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.document_page_texts (
       id, sandbox_id, document_version_id, page_no, text, char_count, created_at
     ) VALUES ($1, $2, $3, 1, $4, $5, clock_timestamp())`,
    [randomUUID(), SANDBOX_ID, documentVersionId, text, [...text].length],
  );
  return { documentId, documentVersionId, caseId };
}

async function extract(
  seeded: SeededDocument,
  gateway: FakeGateway,
  service = new DocumentExtractionService(extractionStore, gateway),
): Promise<DocumentExtractionRevision> {
  return service.extract({
    sandboxId: SANDBOX_ID,
    documentId: seeded.documentId,
    budgetAccountId: randomUUID(),
    workflowRunId: null,
    requestId: randomUUID(),
    correlationId: randomUUID(),
  });
}

function correctionService(): DocumentCorrectionService {
  return new DocumentCorrectionService(extractionStore);
}

async function revisionCount(documentId: string): Promise<number> {
  return (
    await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM nexus.document_extraction_revisions
       WHERE sandbox_id = $1 AND document_id = $2`,
      [SANDBOX_ID, documentId],
    )
  ).count;
}

async function documentStatus(documentId: string): Promise<string> {
  return (
    await dbOne<{ status: string }>(
      `SELECT status FROM nexus.documents WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, documentId],
    )
  ).status;
}

async function seedProposal(input: {
  readonly seeded: SeededDocument;
  readonly evidenceId: string;
}): Promise<{ proposalId: string; revisionId: string }> {
  const proposalId = randomUUID();
  const revisionId = randomUUID();
  const itemId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.action_proposals (
       id, sandbox_id, case_id, current_revision_id, status, has_procurement,
       created_by_kind, created_by_id, version, created_at, updated_at
     ) VALUES ($1, $2, $3, NULL, 'approved', false, 'human', 'operator', 1,
               clock_timestamp(), clock_timestamp())`,
    [proposalId, SANDBOX_ID, input.seeded.caseId],
  );
  await superuser.query(
    `INSERT INTO nexus.action_revisions (
       id, sandbox_id, proposal_id, revision_number, state, plan_hash, items,
       required_roles, aggregate_impact_minor, is_procurement, policy_revision,
       policy_content_hash, rationale, authored_by_kind, authored_by_id,
       authored_by_roles, expires_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 'approved', $4, $5::jsonb, '["operator"]'::jsonb,
               NULL, false, 'northstar-v1', $6, 'F17 invalidation fixture', 'human',
               'operator', '["operator"]'::jsonb,
               clock_timestamp() + interval '24 hours', clock_timestamp(), clock_timestamp())`,
    [
      revisionId,
      SANDBOX_ID,
      proposalId,
      'a'.repeat(64),
      JSON.stringify([
        {
          itemId,
          target: {
            system: 'nexus',
            type: 'case',
            id: input.seeded.caseId,
            version: 1,
          },
          evidenceIds: [input.evidenceId],
          payload: {
            kind: 'case.add_internal_note',
            caseId: input.seeded.caseId,
            text: 'F17 correction invalidation fixture',
          },
          dependsOnItemIds: [],
          baseExpectedVersions: [],
        },
      ]),
      'b'.repeat(64),
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.action_revision_evidence (sandbox_id, revision_id, evidence_id)
     VALUES ($1, $2, $3)`,
    [SANDBOX_ID, revisionId, input.evidenceId],
  );
  await superuser.query(
    `UPDATE nexus.action_proposals
     SET current_revision_id = $1, updated_at = clock_timestamp()
     WHERE sandbox_id = $2 AND id = $3`,
    [revisionId, SANDBOX_ID, proposalId],
  );
  return { proposalId, revisionId };
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
    `INSERT INTO nexus.sandboxes (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, 'F17 sandbox', 'active', '2026-11-02T09:00:00Z', 1, clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [SANDBOX_ID],
  );
  await superuser.query(
    `UPDATE nexus.active_sandbox
     SET sandbox_id = $1, updated_at = clock_timestamp()
     WHERE singleton = true`,
    [SANDBOX_ID],
  );
  const workerPool = createNexusPool('worker', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_WORKER_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
    NEXUS_WORKER_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
  });
  workerDb = createNexusDb(workerPool);
  extractionStore = createDocumentExtractionStore(workerDb);
  apiPool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  proposalStore = createActionProposalStore(createNexusDb(apiPool));
  api = await startApi();
  operator = await login(api.baseUrl, 'operator');
  viewer = await login(api.baseUrl, 'finance.admin');
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await apiPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.document_extraction_corrections,
       nexus.document_extraction_fields,
       nexus.document_extraction_revisions,
       nexus.action_revision_evidence,
       nexus.action_executions,
       nexus.action_revisions,
       nexus.action_proposals,
       nexus.document_page_texts,
       nexus.document_versions,
       nexus.documents,
       nexus.blobs,
       nexus.evidence,
       nexus.cases,
       nexus.audit_events
     CASCADE`,
  );
});

describe('F17 structured extraction and human correction', () => {
  it('extracts a digital supply notice with locatable fields, evidence and a ready status', async () => {
    const seeded = await seedDocument();
    const gateway = supplyGateway();
    const revision = await extract(seeded, gateway);

    expect(gateway.calls).toEqual([
      { role: 'classify', outputSchemaId: 'document.classification.v1' },
      { role: 'extract', outputSchemaId: 'document.extraction.v1' },
    ]);
    expect(revision.kind).toBe('supply_exception');
    expect(revision.revisionStatus).toBe('extracted');
    expect(revision.reviewRequired).toBe(false);
    expect(revision.fields).toHaveLength(4);
    for (const extracted of revision.fields) {
      if (extracted.value !== null) {
        expect(extracted.source).not.toBeNull();
        expect(extracted.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
        const text = TEXT.slice(
          extracted.source!.start,
          extracted.source!.end,
        );
        expect(text).toBe(extracted.value);
      }
    }
    expect(await documentStatus(seeded.documentId)).toBe('ready');
    const evidence = await dbAll<{ kind: string; source_type: string }>(
      `SELECT kind, source_type FROM nexus.evidence WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(evidence).toHaveLength(4);
    expect(evidence.every((row) => row.kind === 'document_page')).toBe(true);
    expect(evidence.every((row) => row.source_type === 'document_version')).toBe(true);
    const audit = await dbOne<{ action: string }>(
      `SELECT action FROM nexus.audit_events WHERE target_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [seeded.documentId],
    );
    expect(audit.action).toBe('document.structured_extracted');
  });

  it('validates source spans in Unicode code points, including non-BMP text', async () => {
    const seeded = await seedDocument(UNICODE_TEXT);
    const revision = await extract(
      seeded,
      supplyGateway({
        fields: [
          field(
            'supplier_name',
            'Northstar Components AB',
            codePointSpan(UNICODE_TEXT, 'Northstar Components AB'),
            'extracted',
          ),
          field(
            'purchase_order_number',
            'PO-2026-0001',
            codePointSpan(UNICODE_TEXT, 'PO-2026-0001'),
            'extracted',
          ),
        ],
      }),
    );
    expect(revision.reviewRequired).toBe(false);
    const supplier = revision.fields.find(
      (entry) => entry.field === 'supplier_name',
    );
    expect(supplier?.value).toBe('Northstar Components AB');
    expect(supplier?.status).toBe('extracted');
    expect(supplier?.source).toMatchObject({ page: 1 });
  });

  it('looks up the F17 replay assets with the same request builders', () => {
    const replay = loadReplayManifest(
      path.join(root, 'fixtures/replay/v1/manifest.json'),
    );
    const sourceText = extractionSourceText([{ page: 1, text: TEXT }]);
    const classify = classificationRequest({
      sourceText,
      budgetAccountId: randomUUID(),
      workflowRunId: null,
    });
    const extraction = extractionRequest({
      kind: 'supply_exception',
      sourceText,
      budgetAccountId: randomUUID(),
      workflowRunId: null,
    });
    const context = {
      schemaVersion: 1,
      configRevision: 'models-default-2026-11-26',
      route: { provider: 'replay', model: 'replay-v1' },
    };
    const promptVersions = listPromptVersions();
    const classifyRecord = replay.records.find(
      (record) => record.recordId === 'f17-classify-supply-notice',
    );
    const extractionRecord = replay.records.find(
      (record) => record.recordId === 'f17-extract-supply-notice',
    );
    expect(classifyRecord).toBeDefined();
    expect(extractionRecord).toBeDefined();
    expect(classifyRecord!.promptVersion).toBe(promptVersions.classify);
    expect(extractionRecord!.promptVersion).toBe(promptVersions.extract);
    expect(
      replay.adapter.lookup(classify, {
        ...context,
        promptVersion: promptVersions.classify,
      })?.record.recordId,
    ).toBe('f17-classify-supply-notice');
    expect(
      replay.adapter.lookup(extraction, {
        ...context,
        promptVersion: promptVersions.extract,
      })?.record.recordId,
    ).toBe('f17-extract-supply-notice');
  });

  it('keeps a missing tax or price null instead of inventing zero and marks review', async () => {
    const seeded = await seedDocument(INVOICE_TEXT);
    const gateway = new FakeGateway(
      { kind: 'invoice', evidenceIds: [], missingFields: ['tax_amount_minor'] },
      {
        kind: 'invoice',
        fields: [
          field('supplier_name', 'Northstar Components AB', span(INVOICE_TEXT, 'Northstar Components AB'), 'extracted'),
          field('invoice_number', 'INV-2026-0017', span(INVOICE_TEXT, 'INV-2026-0017'), 'extracted'),
          field('currency', 'EUR', span(INVOICE_TEXT, 'EUR'), 'extracted'),
          field('net_amount_minor', '125000', span(INVOICE_TEXT, '125000'), 'extracted'),
          field('tax_amount_minor', null, null, 'missing'),
          field('gross_amount_minor', '150000', span(INVOICE_TEXT, '150000'), 'extracted'),
          field('unit_price_minor', null, null, 'missing'),
          field('document_date', '2026-11-05', span(INVOICE_TEXT, '2026-11-05'), 'extracted'),
        ],
      },
    );
    const revision = await extract(seeded, gateway);
    const tax = revision.fields.find((entry) => entry.field === 'tax_amount_minor');
    expect(tax).toMatchObject({ value: null, status: 'missing', evidenceId: null });
    expect(tax?.value).not.toBe('0');
    const price = revision.fields.find((entry) => entry.field === 'unit_price_minor');
    expect(price).toMatchObject({ value: null, status: 'missing', evidenceId: null });
    expect(price?.value).not.toBe('0');
    expect(revision.reviewRequired).toBe(true);
    expect(revision.reviewReason).toBe('REQUIRED_FIELDS_MISSING');
    expect(await documentStatus(seeded.documentId)).toBe('needs_review');
  });

  it('marks an unsupported source page or span ambiguous instead of trusting it', async () => {
    const seeded = await seedDocument();
    const gateway = supplyGateway({
      fields: [
        field('supplier_name', 'Northstar Components AB', { page: 9, start: 0, end: 5 }, 'extracted'),
        field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
      ],
    });
    const revision = await extract(seeded, gateway);
    const supplier = revision.fields.find((entry) => entry.field === 'supplier_name');
    expect(supplier).toMatchObject({
      value: null,
      status: 'ambiguous',
      source: null,
      evidenceId: null,
    });
    expect(revision.reviewRequired).toBe(true);
    expect(revision.reviewReason).toBe('INVALID_SOURCE_SPAN');
    expect(await documentStatus(seeded.documentId)).toBe('needs_review');
  });

  it('checks a value against its span for ambiguous fields too and creates no evidence for it', async () => {
    const seeded = await seedDocument();
    const gateway = supplyGateway({
      fields: [
        field('supplier_name', 'Northstar Components AB', span(TEXT, 'Northstar Components AB'), 'extracted'),
        field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
        field(
          'description',
          'Invented description',
          span(TEXT, 'Northstar Components AB'),
          'ambiguous',
        ),
      ],
    });
    const revision = await extract(seeded, gateway);
    const description = revision.fields.find(
      (entry) => entry.field === 'description',
    );
    expect(description).toMatchObject({
      value: null,
      status: 'ambiguous',
      source: null,
      evidenceId: null,
    });
    expect(revision.reviewRequired).toBe(true);
    expect(revision.reviewReason).toBe('INVALID_SOURCE_SPAN');
    const evidence = await dbAll<{ id: string }>(
      `SELECT id FROM nexus.evidence WHERE sandbox_id = $1`,
      [SANDBOX_ID],
    );
    expect(evidence).toHaveLength(2);
  });

  it('nulls an unverified ambiguous value and requires review for ambiguous financial data', async () => {
    const seeded = await seedDocument();
    const revision = await extract(
      seeded,
      supplyGateway({
        fields: [
          field('supplier_name', 'Northstar Components AB', span(TEXT, 'Northstar Components AB'), 'extracted'),
          field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
          field('unit_price_minor', '999', null, 'ambiguous'),
          field('description', 'Unsourced note', null, 'ambiguous'),
        ],
      }),
    );
    const price = revision.fields.find(
      (entry) => entry.field === 'unit_price_minor',
    );
    expect(price).toMatchObject({
      value: null,
      status: 'ambiguous',
      source: null,
      evidenceId: null,
    });
    expect(price?.alternatives).toEqual(['999']);
    const description = revision.fields.find(
      (entry) => entry.field === 'description',
    );
    expect(description).toMatchObject({
      value: null,
      status: 'ambiguous',
      source: null,
      evidenceId: null,
    });
    expect(revision.reviewRequired).toBe(true);
    expect(revision.reviewReason).toBe('AMBIGUOUS_FINANCIAL_DATA');
    expect(await documentStatus(seeded.documentId)).toBe('needs_review');
  });

  it('detects contradictory dates and keeps the extracted values for review', async () => {
    const seeded = await seedDocument();
    const gateway = supplyGateway({
      fields: [
        field('supplier_name', 'Northstar Components AB', span(TEXT, 'Northstar Components AB'), 'extracted'),
        field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
        field('document_date', '2026-11-07', span(TEXT, '2026-11-07'), 'extracted'),
        field('delivery_date', '2026-11-03', span(TEXT, '2026-11-03'), 'extracted'),
      ],
    });
    const revision = await extract(seeded, gateway);
    expect(revision.reviewReason).toBe('CONTRADICTORY_DATE');
    expect(revision.reviewRequired).toBe(true);
    expect(await documentStatus(seeded.documentId)).toBe('needs_review');
  });

  it('rejects an invalid gateway output shape before persisting any revision', async () => {
    const seeded = await seedDocument();
    const gateway = supplyGateway({
      fields: [
        field('supplier_name', 'Northstar Components AB', null, 'extracted'),
        field('purchase_order_number', 'PO-2026-0001', span(TEXT, 'PO-2026-0001'), 'extracted'),
      ],
    });
    await expect(extract(seeded, gateway)).rejects.toThrow();
    expect(await revisionCount(seeded.documentId)).toBe(0);
    expect(await documentStatus(seeded.documentId)).toBe('ready');
  });

  it('persists a human correction as a new revision with prior value and evidence', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const corrected: DocumentExtractionCorrectionField = {
      field: 'supplier_name',
      value: 'Northstar Components GmbH',
      reason: 'Legal name corrected from the supplier master record',
    };
    const next = await correctionService().correct({
      sandboxId: SANDBOX_ID,
      documentId: seeded.documentId,
      actorId: 'operator-user',
      expectedRevisionNumber: 1,
      reason: 'Supplier legal name correction',
      fields: [corrected],
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(next.revisionNumber).toBe(2);
    expect(next.revisionStatus).toBe('corrected');
    expect(next.authoredByKind).toBe('human');
    expect(next.supersedesRevisionId).toBe(revision.id);
    expect(next.requestReason).toBe('Supplier legal name correction');
    const supplier = next.fields.find((entry) => entry.field === 'supplier_name');
    expect(supplier).toMatchObject({
      value: 'Northstar Components GmbH',
      status: 'corrected',
      source: null,
    });
    const correctionRow = await dbOne<{
      prior_value: string;
      new_value: string;
      actor_id: string;
      reason: string;
    }>(
      `SELECT prior_value, new_value, actor_id, reason
       FROM nexus.document_extraction_corrections
       WHERE sandbox_id = $1 AND revision_id = $2`,
      [SANDBOX_ID, next.id],
    );
    expect(correctionRow).toEqual({
      prior_value: 'Northstar Components AB',
      new_value: 'Northstar Components GmbH',
      actor_id: 'operator-user',
      reason: 'Legal name corrected from the supplier master record',
    });
    expect(await documentStatus(seeded.documentId)).toBe('ready');
  });

  it('rejects a stale revision and blocks corrections while an execution is unresolved', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    await expect(
      correctionService().correct({
        sandboxId: SANDBOX_ID,
        documentId: seeded.documentId,
        actorId: 'operator-user',
        expectedRevisionNumber: 99,
        reason: 'Stale correction',
        fields: [{ field: 'supplier_name', value: 'X', reason: 'test' }],
        requestId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    const evidenceId = revision.fields[0]!.evidenceId!;
    const proposal = await seedProposal({ seeded, evidenceId });
    const item = await dbOne<{ item_id: string }>(
      `SELECT items->0->>'itemId' AS item_id FROM nexus.action_revisions WHERE id = $1`,
      [proposal.revisionId],
    );
    await superuser.query(
      `INSERT INTO nexus.action_executions (
         id, sandbox_id, case_id, proposal_id, action_revision_id, item_id,
         command_kind, execution_key, plan_hash, item_hash, state,
         authorization_basis, attempt_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'case.add_internal_note', $7, $8, $9,
                 'unknown', 'human', 1, clock_timestamp(), clock_timestamp())`,
      [
        randomUUID(),
        SANDBOX_ID,
        seeded.caseId,
        proposal.proposalId,
        proposal.revisionId,
        item.item_id,
        `f17:${randomUUID()}`,
        'a'.repeat(64),
        'b'.repeat(64),
      ],
    );
    await expect(
      correctionService().correct({
        sandboxId: SANDBOX_ID,
        documentId: seeded.documentId,
        actorId: 'operator-user',
        expectedRevisionNumber: 1,
        reason: 'Blocked correction',
        fields: [{ field: 'supplier_name', value: 'X', reason: 'test' }],
        requestId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DocumentCorrectionConflictError);
    expect(await revisionCount(seeded.documentId)).toBe(1);
  });

  it('locks affected proposals before the blocking check so a concurrent claim cannot slip through', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const proposal = await seedProposal({
      seeded,
      evidenceId: revision.fields[0]!.evidenceId!,
    });
    const item = await dbOne<{ item_id: string }>(
      `SELECT items->0->>'itemId' AS item_id FROM nexus.action_revisions WHERE id = $1`,
      [proposal.revisionId],
    );

    const locker = new PgClient(
      pgConfig(
        requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
        requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
      ),
    );
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        `SELECT id FROM nexus.action_proposals
         WHERE sandbox_id = $1 AND id = $2 FOR UPDATE`,
        [SANDBOX_ID, proposal.proposalId],
      );
      const correction = correctionService()
        .correct({
          sandboxId: SANDBOX_ID,
          documentId: seeded.documentId,
          actorId: 'operator-user',
          expectedRevisionNumber: revision.revisionNumber,
          reason: 'Concurrent claim correction',
          fields: [
            {
              field: 'supplier_name',
              value: 'Northstar Components GmbH',
              reason: 'test',
            },
          ],
          requestId: randomUUID(),
          correlationId: randomUUID(),
        })
        .then(
          () => new Error('correction should have been blocked'),
          (error: unknown) => error,
        );
      await locker.query(
        `INSERT INTO nexus.action_executions (
           id, sandbox_id, case_id, proposal_id, action_revision_id, item_id,
           command_kind, execution_key, plan_hash, item_hash, state,
           authorization_basis, attempt_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'case.add_internal_note', $7, $8, $9,
                   'pending', 'human', 1, clock_timestamp(), clock_timestamp())`,
        [
          randomUUID(),
          SANDBOX_ID,
          seeded.caseId,
          proposal.proposalId,
          proposal.revisionId,
          item.item_id,
          `f17:${randomUUID()}`,
          'a'.repeat(64),
          'b'.repeat(64),
        ],
      );
      await locker.query('COMMIT');
      const error = await correction;
      expect(error).toMatchObject({ code: 'EXTRACTION_IN_USE' });
      expect(await revisionCount(seeded.documentId)).toBe(1);
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
  }, 10_000);

  it('invalidates an approved proposal that cites the old extraction evidence', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const evidenceId = revision.fields[0]!.evidenceId!;
    const proposal = await seedProposal({
      seeded,
      evidenceId,
    });
    await correctionService().correct({
      sandboxId: SANDBOX_ID,
      documentId: seeded.documentId,
      actorId: 'operator-user',
      expectedRevisionNumber: 1,
      reason: 'Supplier name correction invalidates dependent proposal',
      fields: [{ field: 'supplier_name', value: 'Northstar Components GmbH', reason: 'corrected' }],
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
    const proposalRow = await dbOne<{ status: string }>(
      `SELECT status FROM nexus.action_proposals WHERE id = $1`,
      [proposal.proposalId],
    );
    const revisionRow = await dbOne<{ state: string }>(
      `SELECT state FROM nexus.action_revisions WHERE id = $1`,
      [proposal.revisionId],
    );
    expect(proposalRow.status).toBe('expired');
    expect(revisionRow.state).toBe('expired');
    const evidenceRow = await dbOne<{
      superseded_at: Date | null;
      superseded_reason: string | null;
    }>(
      `SELECT superseded_at, superseded_reason
       FROM nexus.evidence
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, evidenceId],
    );
    expect(evidenceRow.superseded_at).not.toBeNull();
    expect(evidenceRow.superseded_reason).toBe('extraction_corrected');
  });

  it('rejects a proposal that cites extraction evidence superseded by a correction', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const evidenceId = revision.fields[0]!.evidenceId!;
    await correctionService().correct({
      sandboxId: SANDBOX_ID,
      documentId: seeded.documentId,
      actorId: 'operator-user',
      expectedRevisionNumber: revision.revisionNumber,
      reason: 'Correction before proposal creation',
      fields: [
        {
          field: 'supplier_name',
          value: 'Northstar Components GmbH',
          reason: 'corrected',
        },
      ],
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });

    const itemId = randomUUID();
    const result = await proposalStore.createProposal({
      sandboxId: SANDBOX_ID,
      caseId: seeded.caseId,
      proposalId: randomUUID(),
      revisionId: randomUUID(),
      planHash: 'a'.repeat(64),
      items: [
        {
          itemId,
          target: {
            system: 'nexus',
            type: 'case',
            id: seeded.caseId,
            version: 1,
          },
          evidenceIds: [evidenceId],
          payload: {
            kind: 'case.add_internal_note',
            caseId: seeded.caseId,
            text: 'Proposal after extraction correction',
          },
          dependsOnItemIds: [],
          baseExpectedVersions: [],
        },
      ],
      requiredRoles: ['operator'],
      aggregateImpactMinor: null,
      isProcurement: false,
      policyRevision: 'northstar-v1',
      policyContentHash: 'b'.repeat(64),
      rationale: 'F17 superseded evidence test',
      ttlHours: 24,
      route: '/api/v1/cases/:caseId/proposals',
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      actor: {
        kind: 'human',
        id: 'operator-user',
        roles: ['operator'],
      },
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(result).toEqual({ status: 'evidence_unavailable' });
  });

  it('returns 403 for a viewer and applies an operator correction through the API', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const body = JSON.stringify({
      reason: 'API correction',
      fields: [
        {
          field: 'supplier_name',
          value: 'Northstar Components GmbH',
          reason: 'Master record correction',
        },
      ],
    });
    const viewerResponse = await fetch(
      `${api.baseUrl}/api/v1/documents/${seeded.documentId}/extraction`,
      {
        method: 'PATCH',
        headers: {
          Cookie: viewer.cookie,
          Origin: allowedOrigin,
          'X-CSRF-Token': viewer.csrfToken,
          'If-Match': String(revision.revisionNumber),
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    expect(viewerResponse.status).toBe(403);

    const operatorResponse = await fetch(
      `${api.baseUrl}/api/v1/documents/${seeded.documentId}/extraction`,
      {
        method: 'PATCH',
        headers: {
          Cookie: operator.cookie,
          Origin: allowedOrigin,
          'X-CSRF-Token': operator.csrfToken,
          'If-Match': String(revision.revisionNumber),
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    const operatorText = await operatorResponse.text();
    expect(operatorResponse.status, operatorText).toBe(200);
    const corrected = DocumentExtractionRevisionSchema.parse(
      JSON.parse(operatorText),
    );
    expect(corrected.revisionNumber).toBe(2);
    expect(corrected.revisionStatus).toBe('corrected');
    expect(corrected.requestReason).toBe('API correction');
    expect(await revisionCount(seeded.documentId)).toBe(2);

    const staleResponse = await fetch(
      `${api.baseUrl}/api/v1/documents/${seeded.documentId}/extraction`,
      {
        method: 'PATCH',
        headers: {
          Cookie: operator.cookie,
          Origin: allowedOrigin,
          'X-CSRF-Token': operator.csrfToken,
          'If-Match': String(revision.revisionNumber),
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: 'STALE_STATE' });
    expect(await revisionCount(seeded.documentId)).toBe(2);
  });

  it('returns a typed stale conflict from the correction transaction', async () => {
    const seeded = await seedDocument();
    const revision = await extract(seeded, supplyGateway());
    const result = await extractionStore.saveCorrection({
      sandboxId: SANDBOX_ID,
      documentId: seeded.documentId,
      documentVersionId: seeded.documentVersionId,
      kind: revision.kind,
      expectedRevisionNumber: revision.revisionNumber + 1,
      supersedesRevisionId: revision.id,
      fields: revision.fields,
      corrections: [],
      reviewRequired: false,
      reviewReason: null,
      reason: 'stale revision test',
      actorId: 'operator-user',
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(result).toEqual({ ok: false, conflict: 'REVISION_CONFLICT' });
    expect(await revisionCount(seeded.documentId)).toBe(1);
  });
});

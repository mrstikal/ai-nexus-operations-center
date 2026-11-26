import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, PoolConfig, Pool as PgPoolType } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionProposalDetailSchema,
  CaseHistoryResponseSchema,
  type ActionPlanItem,
  type ActionProposalDetail,
  type PolicyBundle,
} from '@nexus/contracts';
import { parseEventEnvelope } from '@nexus/contracts/events';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  PolicyValidationError,
  assertActionPlan,
  isPolicyAutomatic,
  validatePolicyBundle,
} from '@nexus/domain/policies/action-validation';
import { computePlanHash } from '@nexus/application/actions/revision-hash';
import { computeRequiredApprovalRoles } from '@nexus/domain/policies/approvals';
import { invalidateAffectedProposals } from '@nexus/application/actions/invalidation';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';
import { RoleSchema } from '@nexus/contracts';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const CONSUMER_NAME = 'nexus.worker.events.v1';
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f12-test-password-only';
const policyBundlePath = path.join(root, 'config/policies/northstar-v1.json');
const policyTextPath = path.join(root, 'fixtures/knowledge/northstar-v1.md');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F12`);
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
    application_name: 'f12-proposals-test',
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

async function startApi(): Promise<SpawnedApi> {
  if (!existsSync(apiEntry)) {
    throw new Error('Compiled API is missing; run pnpm build first');
  }
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: { ...process.env, PORT: '0', ...apiEnv() },
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
let workerPool: PgPoolType;
let workerStore: ReturnType<typeof createActionProposalStore>;
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

async function readJson(
  baseUrl: string,
  route: string,
  session: Session,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Cookie: session.cookie },
  });
  return { status: response.status, body: await response.json() };
}

async function mutateJson(
  baseUrl: string,
  method: 'POST' | 'PATCH',
  route: string,
  session: Session,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: allowedOrigin,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function createCase(title: string): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases
       (id, sandbox_id, title, summary, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, 'investigating', 1, clock_timestamp(), clock_timestamp())`,
    [id, SANDBOX_ID, title],
  );
  return id;
}

async function createEvidence(input: {
  readonly caseId: string;
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly sourceStatus?: 'available' | 'missing';
}): Promise<string> {
  const evidenceId = randomUUID();
  const sourceStatus = input.sourceStatus ?? 'available';
  const contentHash = createHash('sha256')
    .update(`${input.type}:${input.id}:${input.version}`)
    .digest('hex');
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, source_system, source_type,
        source_id, source_version, source_sandbox_id, content_hash, locator,
        captured_facts, missing_reason, captured_at)
     VALUES ($1, $2, $3, 'enterprise_snapshot', $4, $5, $6, $7, $8, $9, $10,
             NULL, '{}'::jsonb, $11, clock_timestamp())`,
    [
      evidenceId,
      SANDBOX_ID,
      input.caseId,
      sourceStatus,
      sourceStatus === 'available' ? 'enterprise' : null,
      sourceStatus === 'available' ? input.type : null,
      sourceStatus === 'available' ? input.id : null,
      sourceStatus === 'available' ? input.version : null,
      sourceStatus === 'available' ? SANDBOX_ID : null,
      contentHash,
      sourceStatus === 'missing' ? 'source unavailable' : null,
    ],
  );
  return evidenceId;
}

async function evidenceForPurchaseOrder(
  caseId: string,
  input: {
    readonly purchaseOrderId: string;
    readonly purchaseOrderVersion: number;
    readonly supplierId: string;
    readonly productId: string;
    readonly agreementId: string;
  },
): Promise<string[]> {
  const ids: string[] = [];
  ids.push(
    await createEvidence({
      caseId,
      type: 'purchase_order',
      id: input.purchaseOrderId,
      version: input.purchaseOrderVersion,
    }),
  );
  ids.push(
    await createEvidence({
      caseId,
      type: 'supplier',
      id: input.supplierId,
      version: 7,
    }),
  );
  ids.push(
    await createEvidence({
      caseId,
      type: 'product',
      id: input.productId,
      version: 4,
    }),
  );
  ids.push(
    await createEvidence({
      caseId,
      type: 'agreement',
      id: input.agreementId,
      version: 2,
    }),
  );
  return ids;
}

function poPayload(input: {
  readonly supplierId: string;
  readonly sourcePurchaseOrderId: string;
  readonly productId: string;
  readonly agreementId: string;
  readonly unitPriceMinor: string;
  readonly expediteChargeMinor?: string;
}): Record<string, unknown> {
  return {
    kind: 'enterprise.create_purchase_order',
    supplierId: input.supplierId,
    sourcePurchaseOrderId: input.sourcePurchaseOrderId,
    lines: [
      {
        productId: input.productId,
        quantity: 1,
        agreementId: input.agreementId,
        unitPriceMinor: input.unitPriceMinor,
        arrivalAt: '2026-12-01T09:00:00.000Z',
      },
    ],
    expediteChargeMinor: input.expediteChargeMinor ?? '0',
  };
}

function poDraftItem(input: {
  readonly evidenceIds: readonly string[];
  readonly targetId: string;
  readonly targetVersion: number;
  readonly supplierId: string;
  readonly productId: string;
  readonly agreementId: string;
  readonly unitPriceMinor: string;
}): Record<string, unknown> {
  return {
    target: {
      system: 'enterprise',
      type: 'purchase_order',
      id: input.targetId,
      version: input.targetVersion,
    },
    evidenceIds: [...input.evidenceIds],
    payload: poPayload({
      supplierId: input.supplierId,
      sourcePurchaseOrderId: input.targetId,
      productId: input.productId,
      agreementId: input.agreementId,
      unitPriceMinor: input.unitPriceMinor,
    }),
  };
}

function noteDraftItem(caseId: string, text: string): Record<string, unknown> {
  return {
    target: { system: 'nexus', type: 'case', id: caseId, version: 1 },
    evidenceIds: [],
    payload: { kind: 'case.add_internal_note', caseId, text },
  };
}

async function createProposal(
  caseId: string,
  items: readonly unknown[],
  rationale = 'F12 manual proposal',
  idempotencyKey: string = randomUUID(),
): Promise<ActionProposalDetail> {
  const response = await mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/cases/${caseId}/proposals`,
    operator,
    { plan: { items, rationale } },
    { 'Idempotency-Key': idempotencyKey },
  );
  expect(response.status).toBe(201);
  return ActionProposalDetailSchema.parse(response.body);
}

async function postProposal(
  caseId: string,
  body: unknown,
  idempotencyKey: string = randomUUID(),
): Promise<{ status: number; body: unknown }> {
  return mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/cases/${caseId}/proposals`,
    operator,
    body,
    { 'Idempotency-Key': idempotencyKey },
  );
}

async function editProposal(
  detail: ActionProposalDetail,
  items: readonly unknown[],
  expectedRevisionNumber = detail.revision.revisionNumber,
): Promise<{ status: number; body: unknown }> {
  return mutateJson(
    api.baseUrl,
    'PATCH',
    `/api/v1/proposals/${detail.proposal.id}`,
    operator,
    {
      rationale: 'F12 edited proposal',
      items,
    },
    { 'If-Match': String(expectedRevisionNumber) },
  );
}

async function createOrderChangeEvent(input: {
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  readonly changedFields: string[];
}): Promise<string> {
  const eventId = randomUUID();
  const envelope = {
    eventId,
    eventType: 'enterprise.order.changed.v1',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    sandboxId: SANDBOX_ID,
    correlationId: `f12-${randomUUID()}`,
    causationId: null,
    producer: 'enterprise-sim',
    payload: {
      entityType: input.entityType,
      entityId: input.entityId,
      version: input.version,
      changedFields: input.changedFields,
    },
  };
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id, sandbox_id, consumer_name, event_id, event_type, producer,
        correlation_id, causation_id, occurred_at, envelope, dispatch_state,
        attempt_count, next_attempt_at, received_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'enterprise-sim', $6, NULL, $7, $8::jsonb,
             'pending', 0, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [
      randomUUID(),
      SANDBOX_ID,
      CONSUMER_NAME,
      eventId,
      envelope.eventType,
      envelope.correlationId,
      envelope.occurredAt,
      JSON.stringify(envelope),
    ],
  );
  return eventId;
}

function loadPolicy(): { bundle: PolicyBundle; contentHash: string; textHash: string } {
  const textBytes = readFileSync(policyTextPath);
  const textHash = createHash('sha256').update(textBytes).digest('hex');
  const parsed = JSON.parse(readFileSync(policyBundlePath, 'utf8')) as unknown;
  const bundle = validatePolicyBundle(parsed, textHash);
  return { bundle, contentHash: canonicalJsonSha256(bundle), textHash };
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
  workerPool = new PgPool(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
    ),
  );
  workerStore = createActionProposalStore(createNexusDb(workerPool));
  await seedIdentity();
  api = await startApi();
  operator = await login(api.baseUrl, 'operator');
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await workerPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.action_revision_evidence,
       nexus.action_revisions,
       nexus.action_proposals,
       nexus.policy_bundles,
       nexus.audit_events,
       nexus.evidence,
       nexus.event_inbox,
       nexus.cases
     CASCADE`,
  );
});

describe('F12 action proposals and deterministic policy', () => {
  it('validates the canonical policy bundle and only narrows compiled rules', () => {
    const { bundle, textHash } = loadPolicy();
    expect(bundle.revision).toBe('northstar-v1');
    expect(bundle.enabledActionKinds).toEqual([
      'case.add_internal_note',
      'enterprise.create_purchase_order',
      'enterprise.send_message',
    ]);
    expect(isPolicyAutomatic('case.add_internal_note', bundle)).toBe(true);
    expect(isPolicyAutomatic('enterprise.create_purchase_order', bundle)).toBe(false);
    expect(isPolicyAutomatic('enterprise.send_message', bundle)).toBe(false);
    expect(() =>
      validatePolicyBundle(bundle, '0'.repeat(64)),
    ).toThrow(PolicyValidationError);
    let widened: unknown;
    try {
      validatePolicyBundle(
        {
          ...bundle,
          supplyApproval: { financeThresholdMinor: '60000' },
        },
        textHash,
      );
    } catch (error) {
      widened = error;
    }
    expect(widened).toBeInstanceOf(PolicyValidationError);
    expect((widened as PolicyValidationError).code).toBe('POLICY_THRESHOLD_WIDENED');
    let automation: unknown;
    try {
      validatePolicyBundle(
        {
          ...bundle,
          lowRiskAutomation: {
            enabled: true,
            actionKinds: ['enterprise.create_purchase_order'],
          },
        },
        textHash,
      );
    } catch (error) {
      automation = error;
    }
    expect(automation).toBeInstanceOf(PolicyValidationError);
    expect((automation as PolicyValidationError).code).toBe('POLICY_AUTOMATION_INVALID');
  });

  it('rejects cyclic and missing action dependencies', () => {
    const first = randomUUID();
    const second = randomUUID();
    const baseItem: Omit<
      ActionPlanItem,
      'itemId' | 'dependsOnItemIds' | 'baseExpectedVersions'
    > = {
      target: { system: 'nexus', type: 'case', id: randomUUID(), version: 1 },
      evidenceIds: [],
      payload: {
        kind: 'case.add_internal_note',
        caseId: randomUUID(),
        text: 'Dependency validation',
      },
    };
    const cyclic: ActionPlanItem[] = [
      {
        ...baseItem,
        itemId: first,
        dependsOnItemIds: [second],
        baseExpectedVersions: [],
      },
      {
        ...baseItem,
        itemId: second,
        dependsOnItemIds: [first],
        baseExpectedVersions: [],
      },
    ];
    expect(() => assertActionPlan(cyclic)).toThrow(/acyclic/);
    const missing: ActionPlanItem[] = [
      {
        ...baseItem,
        itemId: first,
        dependsOnItemIds: [randomUUID()],
        baseExpectedVersions: [],
      },
    ];
    expect(() => assertActionPlan(missing)).toThrow(/same plan/);
  });

  it('creates a persisted revision with exact aggregate impact and both role slots', async () => {
    const caseId = await createCase('F12 two purchase orders');
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const firstPurchaseOrder = randomUUID();
    const secondPurchaseOrder = randomUUID();
    const firstEvidence = await evidenceForPurchaseOrder(caseId, {
      purchaseOrderId: firstPurchaseOrder,
      purchaseOrderVersion: 2,
      supplierId,
      productId,
      agreementId,
    });
    const secondEvidence = await evidenceForPurchaseOrder(caseId, {
      purchaseOrderId: secondPurchaseOrder,
      purchaseOrderVersion: 5,
      supplierId,
      productId,
      agreementId,
    });
    const detail = await createProposal(caseId, [
      poDraftItem({
        evidenceIds: firstEvidence,
        targetId: firstPurchaseOrder,
        targetVersion: 2,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '40000',
      }),
      poDraftItem({
        evidenceIds: secondEvidence,
        targetId: secondPurchaseOrder,
        targetVersion: 5,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '40000',
      }),
    ]);
    expect(detail.proposal.status).toBe('pending_approval');
    expect(detail.revision.state).toBe('pending_approval');
    expect(detail.revision.requiredRoles).toEqual([
      'approver_ops',
      'approver_finance',
    ]);
    expect(detail.revision.aggregateImpact).toEqual({
      amountMinor: '80000',
      currency: 'EUR',
    });
    expect(detail.revision.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.revision.items).toHaveLength(2);
    expect(
      detail.revision.items[0]?.baseExpectedVersions.some(
        (ref) => ref.id === firstPurchaseOrder && ref.version === 2,
      ),
    ).toBe(true);
    const { bundle, contentHash } = loadPolicy();
    expect(
      computePlanHash({
        items: detail.revision.items,
        policyRevision: bundle.revision,
        policyContentHash: contentHash,
      }),
    ).toBe(detail.revision.planHash);
    const evidenceLinks = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_revision_evidence WHERE revision_id = $1',
      [detail.revision.id],
    );
    expect(evidenceLinks.count).toBe(8);
    const outbox = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.event_outbox',
    );
    expect(outbox.count).toBe(0);
    const policyRow = await dbOne<{ content_hash: string; canonical_text_hash: string }>(
      'SELECT content_hash, canonical_text_hash FROM nexus.policy_bundles WHERE revision = $1',
      [bundle.revision],
    );
    expect(policyRow.content_hash).toBe(contentHash);
    expect(policyRow.canonical_text_hash).toBe(bundle.canonicalText.sha256);
    const read = await readJson(
      api.baseUrl,
      `/api/v1/proposals/${detail.proposal.id}`,
      operator,
    );
    expect(read.status).toBe(200);
    expect(ActionProposalDetailSchema.parse(read.body)).toEqual(detail);
  });

  it('uses only the operations slot below the cumulative finance threshold', async () => {
    const caseId = await createCase('F12 below threshold');
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const items = await Promise.all(
      [0, 1].map(async () => {
        const purchaseOrderId = randomUUID();
        const evidenceIds = await evidenceForPurchaseOrder(caseId, {
          purchaseOrderId,
          purchaseOrderVersion: 1,
          supplierId,
          productId,
          agreementId,
        });
        return poDraftItem({
          evidenceIds,
          targetId: purchaseOrderId,
          targetVersion: 1,
          supplierId,
          productId,
          agreementId,
          unitPriceMinor: '20000',
        });
      }),
    );
    const detail = await createProposal(caseId, items);
    expect(detail.revision.requiredRoles).toEqual(['approver_ops']);
    expect(detail.revision.aggregateImpact).toEqual({
      amountMinor: '40000',
      currency: 'EUR',
    });
    const withPrior = computeRequiredApprovalRoles({
      items: detail.revision.items,
      priorProcurementMinor: 20000n,
      financeThresholdMinor: 50000n,
    });
    expect(withPrior.requiredRoles).toEqual(['approver_ops', 'approver_finance']);
    expect(withPrior.financeRequired).toBe(true);
  });

  it('rejects missing evidence, unsupported handlers and forged control fields', async () => {
    const caseId = await createCase('F12 rejected drafts');
    const purchaseOrderId = randomUUID();
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const missing = await postProposal(caseId, {
      plan: {
        rationale: 'Missing evidence',
        items: [
          poDraftItem({
            evidenceIds: [randomUUID()],
            targetId: purchaseOrderId,
            targetVersion: 1,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '1000',
          }),
        ],
      },
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { code: string }).code).toBe('VALIDATION_FAILED');

    const unavailableEvidence = await createEvidence({
      caseId,
      type: 'purchase_order',
      id: purchaseOrderId,
      version: 1,
      sourceStatus: 'missing',
    });
    const missingSource = await postProposal(caseId, {
      plan: {
        rationale: 'Missing source',
        items: [
          poDraftItem({
            evidenceIds: [unavailableEvidence],
            targetId: purchaseOrderId,
            targetVersion: 1,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '1000',
          }),
        ],
      },
    });
    expect(missingSource.status).toBe(400);

    const availableEvidence = await createEvidence({
      caseId,
      type: 'purchase_order',
      id: purchaseOrderId,
      version: 1,
    });
    const unsupported = await postProposal(caseId, {
      plan: {
          rationale: 'Unsupported handler',
          items: [
            {
              target: {
                system: 'enterprise',
                type: 'purchase_order',
                id: purchaseOrderId,
                version: 1,
              },
              evidenceIds: [availableEvidence],
              payload: {
                kind: 'enterprise.post_goods_receipt',
                purchaseOrderId,
                deliveryReference: 'DELIVERY-1',
                documentVersionId: randomUUID(),
                lines: [{ lineId: randomUUID(), quantity: 1 }],
              },
            },
          ],
      },
    });
    expect(unsupported.status).toBe(400);

    const versionEvidence = await evidenceForPurchaseOrder(caseId, {
      purchaseOrderId,
      purchaseOrderVersion: 2,
      supplierId,
      productId,
      agreementId,
    });
    const fabricatedVersion = await postProposal(caseId, {
      plan: {
        rationale: 'Fabricated target version',
        items: [
          poDraftItem({
            evidenceIds: versionEvidence,
            targetId: purchaseOrderId,
            targetVersion: 9,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '1000',
          }),
        ],
      },
    });
    expect(fabricatedVersion.status).toBe(400);
    expect((fabricatedVersion.body as { code: string }).code).toBe('VALIDATION_FAILED');

    const incompleteEvidence = await createEvidence({
      caseId,
      type: 'purchase_order',
      id: randomUUID(),
      version: 1,
    });
    const incompletePurchaseOrder = randomUUID();
    const missingReferenced = await postProposal(caseId, {
      plan: {
        rationale: 'Missing supplier evidence',
        items: [
          poDraftItem({
            evidenceIds: [incompleteEvidence],
            targetId: incompletePurchaseOrder,
            targetVersion: 1,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '1000',
          }),
        ],
      },
    });
    expect(missingReferenced.status).toBe(400);

    const forged = await postProposal(caseId, {
      status: 'approved',
      plan: {
        rationale: 'Forged status',
        items: [noteDraftItem(caseId, 'Forged status')],
      },
    });
    expect(forged.status).toBe(400);
    const forgedPlan = await postProposal(caseId, {
      plan: {
          rationale: 'Forged plan hash',
          planHash: '0'.repeat(64),
        items: [noteDraftItem(caseId, 'Forged hash')],
      },
    });
    expect(forgedPlan.status).toBe(400);
    const crossCaseNote = await postProposal(caseId, {
      plan: {
          rationale: 'Cross-case note',
          items: [
            {
              target: { system: 'nexus', type: 'case', id: randomUUID(), version: 1 },
              evidenceIds: [],
              payload: {
                kind: 'case.add_internal_note',
                caseId: randomUUID(),
                text: 'Wrong case',
              },
            },
          ],
        },
      },
    );
    expect(crossCaseNote.status).toBe(400);
  });

  it('enforces one open procurement plan per case', async () => {
    const caseId = await createCase('F12 one procurement plan');
    const purchaseOrderId = randomUUID();
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const evidenceIds = await evidenceForPurchaseOrder(caseId, {
      purchaseOrderId,
      purchaseOrderVersion: 1,
      supplierId,
      productId,
      agreementId,
    });
    await createProposal(caseId, [
      poDraftItem({
        evidenceIds,
        targetId: purchaseOrderId,
        targetVersion: 1,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '10000',
      }),
    ]);
    const second = await postProposal(caseId, {
      plan: {
        rationale: 'Second open plan',
        items: [
          poDraftItem({
            evidenceIds,
            targetId: purchaseOrderId,
            targetVersion: 1,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '20000',
          }),
        ],
      },
    });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('CONFLICT');
  });

  it('supersedes the whole revision on a one-item edit and rejects concurrent edits', async () => {
    const caseId = await createCase('F12 edit concurrency');
    const original = await createProposal(caseId, [noteDraftItem(caseId, 'Original note')]);
    const item = original.revision.items[0];
    if (!item) {
      throw new Error('Expected an action item');
    }
    const editBody = [
      {
        itemId: item.itemId,
        target: item.target,
        evidenceIds: [],
        payload: {
          kind: 'case.add_internal_note',
          caseId,
          text: 'Edited note',
        },
      },
    ];
    const edited = await editProposal(original, editBody);
    expect(edited.status).toBe(200);
    const secondRevision = ActionProposalDetailSchema.parse(edited.body);
    expect(secondRevision.revision.revisionNumber).toBe(2);
    expect(secondRevision.revision.planHash).not.toBe(original.revision.planHash);
    const oldRevision = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_revisions WHERE id = $1',
      [original.revision.id],
    );
    expect(oldRevision.state).toBe('superseded');

    const [first, second] = await Promise.all([
      editProposal(secondRevision, [
        {
          ...editBody[0],
          payload: { kind: 'case.add_internal_note', caseId, text: 'Concurrent A' },
        },
      ]),
      editProposal(secondRevision, [
        {
          ...editBody[0],
          payload: { kind: 'case.add_internal_note', caseId, text: 'Concurrent B' },
        },
      ]),
    ]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);
    expect(statuses).toEqual([200, 409]);
    const current = await dbOne<{ status: string; revision_number: number }>(
      `SELECT p.status, r.revision_number
         FROM nexus.action_proposals p
         JOIN nexus.action_revisions r ON r.id = p.current_revision_id
        WHERE p.id = $1`,
      [original.proposal.id],
    );
    expect(current.status).toBe('pending_approval');
    expect(current.revision_number).toBe(3);
    const stale = first.status === 409 ? first : second;
    expect((stale.body as { code: string }).code).toBe('STALE_STATE');
  });

  it('keeps the internal-note allowlist narrow and audits the proposal', async () => {
    const caseId = await createCase('F12 internal note');
    const detail = await createProposal(caseId, [
      noteDraftItem(caseId, 'Internal note for the operator'),
    ]);
    expect(detail.revision.requiredRoles).toEqual([]);
    expect(detail.revision.aggregateImpact).toBeNull();
    const audit = await dbOne<{
      action: string;
      target_type: string;
      details: Record<string, unknown>;
    }>(
      `SELECT action, target_type, details
         FROM nexus.audit_events
        WHERE target_id = $1
        ORDER BY sequence DESC
        LIMIT 1`,
      [detail.proposal.id],
    );
    expect(audit.action).toBe('action.proposal_created');
    expect(audit.target_type).toBe('action_proposal');
    expect(audit.details['actionRevisionId']).toBe(detail.revision.id);
    expect(audit.details['planHash']).toBe(detail.revision.planHash);
    expect(audit.details['policyRevision']).toBe('northstar-v1');
    expect(audit.details['status']).toBe('pending_approval');
    const history = await readJson(
      api.baseUrl,
      `/api/v1/cases/${caseId}/history`,
      operator,
    );
    expect(history.status).toBe(200);
    const parsed = CaseHistoryResponseSchema.parse(history.body);
    expect(
      parsed.items.some((entry) => entry.summary === 'action.proposal_created: succeeded'),
    ).toBe(true);
  });

  it('honors proposal creation idempotency and lists case proposals', async () => {
    const caseId = await createCase('F12 idempotency');
    const item = noteDraftItem(caseId, 'Idempotent note');
    const body = { plan: { rationale: 'Idempotent proposal', items: [item] } };
    const key = randomUUID();
    const first = await postProposal(caseId, body, key);
    expect(first.status).toBe(201);
    const firstDetail = ActionProposalDetailSchema.parse(first.body);
    const retry = await postProposal(caseId, body, key);
    expect(retry.status).toBe(201);
    expect(ActionProposalDetailSchema.parse(retry.body)).toEqual(firstDetail);
    const count = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_proposals WHERE case_id = $1',
      [caseId],
    );
    expect(count.count).toBe(1);
    const mismatch = await postProposal(
      caseId,
      { plan: { rationale: 'Different body', items: [noteDraftItem(caseId, 'Different')] } },
      key,
    );
    expect(mismatch.status).toBe(409);
    expect((mismatch.body as { code: string }).code).toBe('IDEMPOTENCY_MISMATCH');
    const missingHeader = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/proposals`,
      operator,
      body,
    );
    expect(missingHeader.status).toBe(400);
    const invalidHeader = await postProposal(caseId, body, 'not-a-uuid');
    expect(invalidHeader.status).toBe(400);
    const uppercaseCase = await createCase('F12 uppercase idempotency key');
    const uppercase = await postProposal(
      uppercaseCase,
      {
        plan: {
          rationale: 'Uppercase key',
          items: [noteDraftItem(uppercaseCase, 'Uppercase key note')],
        },
      },
      randomUUID().toUpperCase(),
    );
    expect(uppercase.status).toBe(201);
    const second = await createProposal(caseId, [
      noteDraftItem(caseId, 'Second note'),
    ]);
    const firstPage = await readJson(
      api.baseUrl,
      `/api/v1/cases/${caseId}/proposals?limit=1`,
      operator,
    );
    expect(firstPage.status).toBe(200);
    const firstParsed = firstPage.body as {
      items: ActionProposalDetail[];
      nextCursor: string | null;
    };
    expect(firstParsed.items).toHaveLength(1);
    expect(firstParsed.nextCursor).not.toBeNull();
    const secondPage = await readJson(
      api.baseUrl,
      `/api/v1/cases/${caseId}/proposals?limit=1&cursor=${encodeURIComponent(
        firstParsed.nextCursor ?? '',
      )}`,
      operator,
    );
    expect(secondPage.status).toBe(200);
    const secondParsed = secondPage.body as {
      items: ActionProposalDetail[];
      nextCursor: string | null;
    };
    expect(secondParsed.items).toHaveLength(1);
    expect(secondParsed.nextCursor).toBeNull();
    expect([
      firstParsed.items[0]?.proposal.id,
      secondParsed.items[0]?.proposal.id,
    ].sort()).toEqual([firstDetail.proposal.id, second.proposal.id].sort());
  });

  it('keeps approved unexecuted revisions editable and blocks a second procurement plan', async () => {
    const caseId = await createCase('F12 approved lifecycle');
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const purchaseOrderId = randomUUID();
    const evidenceIds = await evidenceForPurchaseOrder(caseId, {
      purchaseOrderId,
      purchaseOrderVersion: 1,
      supplierId,
      productId,
      agreementId,
    });
    const original = await createProposal(caseId, [
      poDraftItem({
        evidenceIds,
        targetId: purchaseOrderId,
        targetVersion: 1,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '10000',
      }),
    ]);
    await superuser.query(
      "UPDATE nexus.action_proposals SET status = 'approved' WHERE id = $1",
      [original.proposal.id],
    );
    await superuser.query(
      "UPDATE nexus.action_revisions SET state = 'approved' WHERE id = $1",
      [original.revision.id],
    );
    const item = original.revision.items[0];
    if (!item || item.payload.kind !== 'enterprise.create_purchase_order') {
      throw new Error('Expected a purchase-order item');
    }
    const edited = await editProposal(original, [
      {
        itemId: item.itemId,
        target: item.target,
        evidenceIds: item.evidenceIds,
        payload: {
          ...item.payload,
          lines: [
            {
              ...item.payload.lines[0],
              unitPriceMinor: '12000',
            },
          ],
        },
      },
    ]);
    expect(edited.status).toBe(200);
    const editedDetail = ActionProposalDetailSchema.parse(edited.body);
    expect(editedDetail.revision.revisionNumber).toBe(2);
    expect(editedDetail.proposal.status).toBe('pending_approval');
    const oldRevision = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_revisions WHERE id = $1',
      [original.revision.id],
    );
    expect(oldRevision.state).toBe('superseded');
    await superuser.query(
      "UPDATE nexus.action_proposals SET status = 'approved' WHERE id = $1",
      [original.proposal.id],
    );
    await superuser.query(
      "UPDATE nexus.action_revisions SET state = 'approved' WHERE id = $1",
      [editedDetail.revision.id],
    );
    const second = await postProposal(caseId, {
      plan: {
        rationale: 'Second procurement plan',
        items: [
          poDraftItem({
            evidenceIds,
            targetId: purchaseOrderId,
            targetVersion: 1,
            supplierId,
            productId,
            agreementId,
            unitPriceMinor: '15000',
          }),
        ],
      },
    });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('CONFLICT');
    const noteCase = await createCase('F12 missing if-match');
    const note = await createProposal(noteCase, [noteDraftItem(noteCase, 'Note')]);
    const noteItem = note.revision.items[0];
    if (!noteItem) {
      throw new Error('Expected a note item');
    }
    const missingIfMatch = await mutateJson(
      api.baseUrl,
      'PATCH',
      `/api/v1/proposals/${note.proposal.id}`,
      operator,
      {
        rationale: 'No precondition',
        items: [
          {
            itemId: noteItem.itemId,
            target: noteItem.target,
            evidenceIds: [],
            payload: {
              kind: 'case.add_internal_note',
              caseId: noteCase,
              text: 'No precondition',
            },
          },
        ],
      },
    );
    expect(missingIfMatch.status).toBe(400);
  });

  it('expires affected proposals on unrelated enterprise changes and leaves others pending', async () => {
    const firstCase = await createCase('F12 invalidation target');
    const secondCase = await createCase('F12 invalidation unrelated');
    const supplierId = randomUUID();
    const productId = randomUUID();
    const agreementId = randomUUID();
    const changedPurchaseOrder = randomUUID();
    const unrelatedPurchaseOrder = randomUUID();
    const firstEvidence = await evidenceForPurchaseOrder(firstCase, {
      purchaseOrderId: changedPurchaseOrder,
      purchaseOrderVersion: 3,
      supplierId,
      productId,
      agreementId,
    });
    const secondEvidence = await evidenceForPurchaseOrder(secondCase, {
      purchaseOrderId: unrelatedPurchaseOrder,
      purchaseOrderVersion: 1,
      supplierId,
      productId,
      agreementId,
    });
    const affected = await createProposal(firstCase, [
      poDraftItem({
        evidenceIds: firstEvidence,
        targetId: changedPurchaseOrder,
        targetVersion: 3,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '10000',
      }),
    ]);
    const unaffected = await createProposal(secondCase, [
      poDraftItem({
        evidenceIds: secondEvidence,
        targetId: unrelatedPurchaseOrder,
        targetVersion: 1,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: '10000',
      }),
    ]);
    await superuser.query(
      "UPDATE nexus.action_proposals SET status = 'approved' WHERE id = $1",
      [affected.proposal.id],
    );
    await superuser.query(
      "UPDATE nexus.action_revisions SET state = 'approved' WHERE id = $1",
      [affected.revision.id],
    );
    const eventId = await createOrderChangeEvent({
      entityType: 'purchase_order',
      entityId: changedPurchaseOrder,
      version: 4,
      changedFields: ['confirmed_arrival_at'],
    });
    const claim = await workerStore.claimPendingProposalEvent();
    if (!claim || claim.eventId !== eventId) {
      throw new Error('Expected the enterprise change event to be claimable');
    }
    const envelope = parseEventEnvelope(claim.envelope) as {
      payload: {
        entityType: string;
        entityId: string;
        version: number;
        changedFields: string[];
        originatingRevisionId?: string;
      };
    };
    const result = await invalidateAffectedProposals(workerStore, {
      sandboxId: claim.sandboxId,
      entityRef: {
        system: 'enterprise',
        type: envelope.payload.entityType,
        id: envelope.payload.entityId,
        version: envelope.payload.version,
      },
      changedFields: envelope.payload.changedFields,
      originatingRevisionId: envelope.payload.originatingRevisionId ?? null,
      requestId: `f12-test-${claim.eventId}`,
      correlationId: claim.correlationId,
    });
    await workerStore.completeProposalEvent(claim.inboxId);
    expect(result.expiredProposalIds).toEqual([affected.proposal.id]);
    const affectedState = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [affected.proposal.id],
    );
    expect(affectedState.status).toBe('expired');
    const affectedRevision = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_revisions WHERE id = $1',
      [affected.revision.id],
    );
    expect(affectedRevision.state).toBe('expired');
    const unaffectedState = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [unaffected.proposal.id],
    );
    expect(unaffectedState.status).toBe('pending_approval');
    const invalidationAudit = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM nexus.audit_events
        WHERE action = 'action.proposal_invalidated' AND target_id = $1`,
      [affected.proposal.id],
    );
    expect(invalidationAudit.count).toBe(1);
    const processed = await dbOne<{ dispatch_state: string }>(
      'SELECT dispatch_state FROM nexus.event_inbox WHERE event_id = $1',
      [eventId],
    );
    expect(processed.dispatch_state).toBe('processed');
  });
});

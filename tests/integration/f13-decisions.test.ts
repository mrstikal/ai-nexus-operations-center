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
  ActionRevisionRequestResponseSchema,
  ApprovalDecisionResultSchema,
  ApprovalQueueResponseSchema,
  NoActionResponseSchema,
  RoleSchema,
  type ActionProposalDetail,
} from '@nexus/contracts';
import {
  DecisionService,
  createEmptyExecutionStatePort,
} from '@nexus/application/actions/decisions';
import { createNexusDb } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createApprovalStore } from '@nexus/db/repositories/approvals';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const apiEntry = path.join(root, 'apps/api/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f13-test-password-only';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F13`);
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
    application_name: 'f13-decisions-test',
    connectionTimeoutMillis: 5000,
  };
}

function env(role: 'API' | 'WORKER'): Record<string, string> {
  const prefix = role === 'API' ? 'NEXUS_TEST_NEXUS_API' : 'NEXUS_TEST_NEXUS_WORKER';
  return {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    [`NEXUS_${role}_DB_USER`]: requiredEnv(`${prefix}_USER`),
    [`NEXUS_${role}_DB_PASSWORD`]: requiredEnv(`${prefix}_PASSWORD`),
  };
}

function apiEnv(): Record<string, string> {
  return {
    ...env('API'),
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
let apiPool: PgPoolType;
let preflightService: DecisionService;
let workerActionStore: ReturnType<typeof createActionProposalStore>;
let api: SpawnedApi;
let operator: Session;
let ops: Session;
let ops2: Session;
let finance: Session;
let dual: Session;
let opsUserId: string;
let financeUserId: string;

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
  const apiDb = createNexusDb(apiPool);
  const fixture = JSON.parse(
    readFileSync(path.join(root, 'fixtures/users/roles.json'), 'utf8'),
  ) as { users: Array<{ username: string; displayName: string; roles: string[] }> };
  const users = [
    ...fixture.users,
    {
      username: 'ops.two',
      displayName: 'Local Ops Two',
      roles: ['approver_ops', 'viewer'],
    },
    {
      username: 'dual.approver',
      displayName: 'Local Dual Approver',
      roles: ['approver_ops', 'approver_finance', 'viewer'],
    },
  ];
  for (const user of users) {
    const existing = await dbAll<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.users WHERE username = $1',
      [user.username],
    );
    if ((existing[0]?.count ?? 0) > 0) {
      continue;
    }
    await createIdentityUser(apiDb, {
      username: user.username,
      displayName: user.displayName,
      roles: RoleSchema.array().parse(user.roles),
      password: await hashPassword(testPassword),
    });
  }
  opsUserId = (
    await dbOne<{ id: string }>('SELECT id FROM nexus.users WHERE username = $1', [
      'ops.approver',
    ])
  ).id;
  financeUserId = (
    await dbOne<{ id: string }>('SELECT id FROM nexus.users WHERE username = $1', [
      'finance.admin',
    ])
  ).id;
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: allowedOrigin,
      'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json',
      ...headers,
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
}): Promise<string> {
  const evidenceId = randomUUID();
  const contentHash = createHash('sha256')
    .update(`${input.type}:${input.id}:${input.version}`)
    .digest('hex');
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, source_system, source_type,
        source_id, source_version, source_sandbox_id, content_hash, locator,
        captured_facts, missing_reason, captured_at)
     VALUES ($1, $2, $3, 'enterprise_snapshot', 'available', 'enterprise', $4, $5,
             $6, $2, $7, NULL, '{}'::jsonb, NULL, clock_timestamp())`,
    [
      evidenceId,
      SANDBOX_ID,
      input.caseId,
      input.type,
      input.id,
      input.version,
      contentHash,
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
  return [
    await createEvidence({
      caseId,
      type: 'purchase_order',
      id: input.purchaseOrderId,
      version: input.purchaseOrderVersion,
    }),
    await createEvidence({
      caseId,
      type: 'supplier',
      id: input.supplierId,
      version: 7,
    }),
    await createEvidence({
      caseId,
      type: 'product',
      id: input.productId,
      version: 4,
    }),
    await createEvidence({
      caseId,
      type: 'agreement',
      id: input.agreementId,
      version: 2,
    }),
  ];
}

function poPayload(input: {
  readonly supplierId: string;
  readonly sourcePurchaseOrderId: string;
  readonly productId: string;
  readonly agreementId: string;
  readonly unitPriceMinor: string;
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
    expediteChargeMinor: '0',
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

async function createProposal(
  caseId: string,
  items: readonly unknown[],
  rationale = 'F13 decision proposal',
): Promise<ActionProposalDetail> {
  const response = await mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/cases/${caseId}/proposals`,
    operator,
    { plan: { items, rationale } },
    { 'Idempotency-Key': randomUUID() },
  );
  expect(response.status).toBe(201);
  return ActionProposalDetailSchema.parse(response.body);
}

async function createPurchaseProposal(input: {
  readonly caseId: string;
  readonly split: boolean;
}): Promise<ActionProposalDetail> {
  const supplierId = randomUUID();
  const productId = randomUUID();
  const agreementId = randomUUID();
  const items: Record<string, unknown>[] = [];
  const orderIds = input.split
    ? [randomUUID(), randomUUID()]
    : [randomUUID()];
  for (const orderId of orderIds) {
    const evidenceIds = await evidenceForPurchaseOrder(input.caseId, {
      purchaseOrderId: orderId,
      purchaseOrderVersion: 1,
      supplierId,
      productId,
      agreementId,
    });
    items.push(
      poDraftItem({
        evidenceIds,
        targetId: orderId,
        targetVersion: 1,
        supplierId,
        productId,
        agreementId,
        unitPriceMinor: input.split ? '40000' : '10000',
      }),
    );
  }
  return createProposal(input.caseId, items);
}

function decisionBody(
  detail: ActionProposalDetail,
  reason = 'Reviewed exact plan',
): Record<string, unknown> {
  return {
    actionRevisionId: detail.revision.id,
    planHash: detail.revision.planHash,
    reason,
  };
}

async function decide(
  detail: ActionProposalDetail,
  session: Session,
  decision: 'approve' | 'reject',
  body: Record<string, unknown> = decisionBody(detail),
  key: string = randomUUID(),
): Promise<{ status: number; body: unknown }> {
  return mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/proposals/${detail.proposal.id}/${decision}`,
    session,
    body,
    { 'Idempotency-Key': key },
  );
}

async function requestRevisionAction(
  detail: ActionProposalDetail,
  session: Session,
  route: 'clarification' | 'reanalyse',
  reason: string,
  key: string = randomUUID(),
): Promise<{ status: number; body: unknown }> {
  return mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/proposals/${detail.proposal.id}/${route}`,
    session,
    {
      actionRevisionId: detail.revision.id,
      planHash: detail.revision.planHash,
      reason,
    },
    { 'Idempotency-Key': key },
  );
}

async function resumeRun(
  runId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return mutateJson(
    api.baseUrl,
    'POST',
    `/api/v1/runs/${runId}/resume`,
    operator,
    body,
  );
}

async function createApprovalWaitRun(
  caseId: string,
  detail: ActionProposalDetail,
): Promise<string> {
  await superuser.query(
    `UPDATE nexus.cases
        SET status = 'needs_approval', version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1`,
    [caseId],
  );
  const inboxId = randomUUID();
  const eventId = randomUUID();
  const runId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id, sandbox_id, consumer_name, event_id, event_type, producer,
        correlation_id, causation_id, occurred_at, envelope, dispatch_state,
        attempt_count, next_attempt_at, received_at, updated_at)
     VALUES ($1, $2, 'nexus.worker.events.v1', $3, 'nexus.case.created.v1',
             'worker', $4, NULL, clock_timestamp(), '{}'::jsonb, 'processed',
             0, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [inboxId, SANDBOX_ID, eventId, `f13-${eventId}`],
  );
  await superuser.query(
    `INSERT INTO nexus.workflow_runs
       (id, sandbox_id, case_id, inbox_id, trigger_event_id, trigger_event_type,
        definition_name, definition_version, status, ingress, ingress_hash,
        effective_at, wait_reason, policy_revision, model_revision, config_revision,
        prompt_revision, active_ms_limit, active_ms_used, deadline_at,
        cancel_requested, resume_cause, cancel_cause, partial_effects, last_error,
        version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'nexus.case.created.v1', 'test-wait', 'v1',
             'waiting_approval', '{"correlationId":"f13-test"}'::jsonb,
             $6, clock_timestamp(), $7::jsonb, 'test-policy-v1', 'none',
             'f13-test-v1', NULL, 300000, 0, clock_timestamp() + interval '1 hour',
             false, NULL, NULL, '[]'::jsonb, NULL, 1, clock_timestamp(),
             clock_timestamp())`,
    [
      runId,
      SANDBOX_ID,
      caseId,
      inboxId,
      eventId,
      createHash('sha256').update(`run:${runId}`).digest('hex'),
      JSON.stringify({
        kind: 'approval',
        proposalId: detail.proposal.id,
        actionRevisionId: detail.revision.id,
      }),
    ],
  );
  return runId;
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
  apiPool = new PgPool({
    ...pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
    ),
    max: 4,
  });
  preflightService = new DecisionService(
    createApprovalStore(createNexusDb(apiPool)),
    createEmptyExecutionStatePort(),
  );
  workerActionStore = createActionProposalStore(createNexusDb(workerPool));
  api = await startApi();
  await seedIdentity();
  operator = await login(api.baseUrl, 'operator');
  ops = await login(api.baseUrl, 'ops.approver');
  ops2 = await login(api.baseUrl, 'ops.two');
  finance = await login(api.baseUrl, 'finance.admin');
  dual = await login(api.baseUrl, 'dual.approver');
}, 120_000);

afterAll(async () => {
  await api?.stop();
  await apiPool?.end();
  await workerPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.case_resolutions,
       nexus.action_revision_requests,
       nexus.approval_decisions,
       nexus.action_command_idempotency,
       nexus.workflow_dependencies,
       nexus.workflow_jobs,
       nexus.workflow_steps,
       nexus.workflow_step_attempts,
       nexus.workflow_attempt_evidence,
       nexus.workflow_runs,
       nexus.action_revision_evidence,
       nexus.action_revisions,
       nexus.action_proposals,
       nexus.policy_bundles,
       nexus.audit_events,
       nexus.trace_events,
       nexus.event_inbox,
       nexus.event_outbox,
       nexus.evidence,
       nexus.cases
     CASCADE`,
  );
});

describe('F13 human decisions bound to the whole plan', () => {
  it('requires the complete role set and resumes the exact approval wait', async () => {
    const caseId = await createCase('F13 complete approval');
    const detail = await createPurchaseProposal({ caseId, split: true });
    const runId = await createApprovalWaitRun(caseId, detail);

    const queue = await readJson(api.baseUrl, '/api/v1/approvals', ops);
    expect(queue.status).toBe(200);
    const queueBody = ApprovalQueueResponseSchema.parse(queue.body);
    expect(queueBody.items[0]?.missingRoles).toEqual([
      'approver_ops',
      'approver_finance',
    ]);

    const opsDecision = await decide(detail, ops, 'approve');
    expect(opsDecision.status).toBe(200);
    const partial = ApprovalDecisionResultSchema.parse(opsDecision.body);
    expect(partial.proposal.proposal.status).toBe('pending_approval');
    expect(partial.decision.role).toBe('approver_ops');
    expect(partial.filledRoles).toEqual(['approver_ops']);
    expect(partial.missingRoles).toEqual(['approver_finance']);

    const financeQueue = await readJson(api.baseUrl, '/api/v1/approvals', finance);
    expect(financeQueue.status).toBe(200);
    expect(
      ApprovalQueueResponseSchema.parse(financeQueue.body).items[0]?.missingRoles,
    ).toEqual(['approver_finance']);

    const financeDecision = await decide(detail, finance, 'approve');
    expect(financeDecision.status).toBe(200);
    const complete = ApprovalDecisionResultSchema.parse(financeDecision.body);
    expect(complete.proposal.proposal.status).toBe('approved');
    expect(complete.proposal.revision.state).toBe('approved');
    expect(complete.filledRoles).toEqual([
      'approver_ops',
      'approver_finance',
    ]);
    expect(complete.missingRoles).toEqual([]);

    const run = await dbOne<{
      status: string;
      wait_reason: Record<string, unknown> | null;
      resume_cause: string | null;
    }>(
      'SELECT status, wait_reason, resume_cause FROM nexus.workflow_runs WHERE id = $1',
      [runId],
    );
    expect(run.status).toBe('queued');
    expect(run.wait_reason).toBeNull();
    expect(run.resume_cause).toBe('approval_completed');
    const caseRow = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.cases WHERE id = $1',
      [caseId],
    );
    expect(caseRow.status).toBe('investigating');
    const outbox = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.event_outbox',
    );
    expect(outbox.count).toBe(0);

    const preflight = await preflightService.preflight(detail.proposal.id);
    expect(preflight.status).toBe('approved');
    expect(preflight.executionState).toBe('none');
    expect(preflight.filledRoles).toEqual([
      'approver_ops',
      'approver_finance',
    ]);
    expect(preflight.missingRoles).toEqual([]);
  });

  it('rejects self-approval and prevents one user from filling two slots', async () => {
    const selfCase = await createCase('F13 self approval');
    const selfDetail = await createPurchaseProposal({ caseId: selfCase, split: false });
    await superuser.query(
      'UPDATE nexus.action_revisions SET authored_by_id = $1 WHERE id = $2',
      [opsUserId, selfDetail.revision.id],
    );
    const selfDecision = await decide(selfDetail, ops, 'approve');
    expect(selfDecision.status).toBe(403);
    const selfCount = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.approval_decisions',
    );
    expect(selfCount.count).toBe(0);

    const dualCase = await createCase('F13 dual approver');
    const dualDetail = await createPurchaseProposal({ caseId: dualCase, split: true });
    const first = await decide(dualDetail, dual, 'approve');
    expect(first.status).toBe(200);
    expect(ApprovalDecisionResultSchema.parse(first.body).decision.role).toBe(
      'approver_ops',
    );
    const second = await decide(dualDetail, dual, 'approve');
    expect(second.status).toBe(403);
    const decisionCount = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.approval_decisions',
    );
    expect(decisionCount.count).toBe(1);
    const state = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [dualDetail.proposal.id],
    );
    expect(state.status).toBe('pending_approval');
  });

  it('rejects wrong or expired plan bindings', async () => {
    const caseId = await createCase('F13 stale bindings');
    const detail = await createPurchaseProposal({ caseId, split: false });
    const runId = await createApprovalWaitRun(caseId, detail);
    await superuser.query(
      "UPDATE nexus.cases SET status = 'executing', version = version + 1, updated_at = clock_timestamp() WHERE id = $1",
      [caseId],
    );
    const wrong = await decide(detail, ops, 'approve', {
      ...decisionBody(detail),
      planHash: '0'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect((wrong.body as { code: string }).code).toBe('STALE_STATE');
    await superuser.query(
      "UPDATE nexus.action_revisions SET created_at = clock_timestamp() - interval '2 days', expires_at = clock_timestamp() - interval '1 day' WHERE id = $1",
      [detail.revision.id],
    );
    const expired = await decide(detail, ops, 'approve');
    expect(expired.status).toBe(409);
    expect((expired.body as { code: string }).code).toBe('APPROVAL_EXPIRED');
    const proposal = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [detail.proposal.id],
    );
    expect(proposal.status).toBe('expired');
    const run = await dbOne<{ status: string; wait_reason: Record<string, unknown> }>(
      'SELECT status, wait_reason FROM nexus.workflow_runs WHERE id = $1',
      [runId],
    );
    expect(run.status).toBe('waiting_input');
    expect(run.wait_reason['kind']).toBe('human_input');
    const executingCase = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.cases WHERE id = $1',
      [caseId],
    );
    expect(executingCase.status).toBe('executing');
  });

  it('uses current roles and invalidates all decisions on an edit', async () => {
    const caseId = await createCase('F13 changed role and edit');
    const detail = await createPurchaseProposal({ caseId, split: true });
    const partial = await decide(detail, ops, 'approve');
    expect(partial.status).toBe(200);

    await superuser.query(
      'DELETE FROM nexus.user_roles WHERE user_id = $1 AND role = $2',
      [financeUserId, 'approver_finance'],
    );
    const revoked = await decide(detail, finance, 'approve');
    expect(revoked.status).toBe(403);
    await superuser.query(
      'INSERT INTO nexus.user_roles (user_id, role) VALUES ($1, $2)',
      [financeUserId, 'approver_finance'],
    );
    const financeDecision = await decide(detail, finance, 'approve');
    expect(financeDecision.status).toBe(200);

    const item = detail.revision.items[0];
    if (!item) {
      throw new Error('Expected an action item');
    }
    const edited = await mutateJson(
      api.baseUrl,
      'PATCH',
      `/api/v1/proposals/${detail.proposal.id}`,
      operator,
      {
        rationale: 'Changed price after approval',
        items: detail.revision.items.map((existing, index) => ({
          itemId: existing.itemId,
          target: existing.target,
          evidenceIds: existing.evidenceIds,
          payload:
            index === 0 &&
            existing.payload.kind === 'enterprise.create_purchase_order'
              ? {
                  ...existing.payload,
                  lines: [
                    {
                      ...existing.payload.lines[0],
                      unitPriceMinor: '45000',
                    },
                  ],
                }
              : existing.payload,
        })),
      },
      { 'If-Match': String(detail.revision.revisionNumber) },
    );
    expect(edited.status).toBe(200);
    const editedDetail = ActionProposalDetailSchema.parse(edited.body);
    expect(editedDetail.proposal.status).toBe('pending_approval');
    expect(editedDetail.revision.planHash).not.toBe(detail.revision.planHash);
    const decisions = await dbAll<{ state: string }>(
      'SELECT state FROM nexus.approval_decisions WHERE action_revision_id = $1',
      [detail.revision.id],
    );
    expect(decisions).toHaveLength(2);
    expect(decisions.every((row) => row.state === 'superseded')).toBe(true);
  });

  it('serializes concurrent decisions for the same role', async () => {
    const caseId = await createCase('F13 concurrent decisions');
    const detail = await createPurchaseProposal({ caseId, split: false });
    const [first, second] = await Promise.all([
      decide(detail, ops, 'approve'),
      decide(detail, ops2, 'approve'),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const decisions = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.approval_decisions WHERE decision = $1 AND state = $2',
      ['approve', 'active'],
    );
    expect(decisions.count).toBe(1);
    const proposal = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [detail.proposal.id],
    );
    expect(proposal.status).toBe('approved');
  });

  it('replays duplicate decision requests and rejects key reuse with a different body', async () => {
    const caseId = await createCase('F13 decision idempotency');
    const detail = await createPurchaseProposal({ caseId, split: false });
    const key = randomUUID();
    const first = await decide(detail, ops, 'approve', decisionBody(detail), key);
    expect(first.status).toBe(200);
    const firstBody = ApprovalDecisionResultSchema.parse(first.body);
    const replay = await decide(detail, ops, 'approve', decisionBody(detail), key);
    expect(replay.status).toBe(200);
    expect(ApprovalDecisionResultSchema.parse(replay.body).decision.id).toBe(
      firstBody.decision.id,
    );
    const changed = await decide(
      detail,
      ops,
      'approve',
      decisionBody(detail, 'Different reason'),
      key,
    );
    expect(changed.status).toBe(409);
    expect((changed.body as { code: string }).code).toBe('IDEMPOTENCY_MISMATCH');
    const missing = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/proposals/${detail.proposal.id}/approve`,
      ops,
      decisionBody(detail),
    );
    expect(missing.status).toBe(400);
  });

  it('records clarification and reanalysis as waits without editing revision history', async () => {
    const clarificationCase = await createCase('F13 clarification');
    const clarificationDetail = await createPurchaseProposal({
      caseId: clarificationCase,
      split: true,
    });
    const clarificationRun = await createApprovalWaitRun(
      clarificationCase,
      clarificationDetail,
    );
    const partial = await decide(clarificationDetail, ops, 'approve');
    expect(partial.status).toBe(200);
    const clarification = await requestRevisionAction(
      clarificationDetail,
      operator,
      'clarification',
      'Which delivery terms apply?',
    );
    expect(clarification.status).toBe(200);
    const clarificationBody = ActionRevisionRequestResponseSchema.parse(
      clarification.body,
    );
    expect(clarificationBody.request.kind).toBe('clarification');
    expect(clarificationBody.request.waitRunId).toBe(clarificationRun);
    expect(clarificationBody.proposal.proposal.status).toBe('pending_approval');
    expect(clarificationBody.proposal.revision.id).toBe(
      clarificationDetail.revision.id,
    );
    expect(clarificationBody.proposal.revision.planHash).toBe(
      clarificationDetail.revision.planHash,
    );
    const superseded = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.approval_decisions WHERE action_revision_id = $1 AND state = 'superseded'",
      [clarificationDetail.revision.id],
    );
    expect(superseded.count).toBe(1);
    const clarifyRun = await dbOne<{ status: string; wait_reason: Record<string, unknown> }>(
      'SELECT status, wait_reason FROM nexus.workflow_runs WHERE id = $1',
      [clarificationRun],
    );
    expect(clarifyRun.status).toBe('waiting_input');
    expect(clarifyRun.wait_reason['kind']).toBe('human_input');
    const clarifyCase = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.cases WHERE id = $1',
      [clarificationCase],
    );
    expect(clarifyCase.status).toBe('needs_input');

    const reanalysisCase = await createCase('F13 reanalysis');
    const reanalysisDetail = await createPurchaseProposal({
      caseId: reanalysisCase,
      split: false,
    });
    const reanalysisRun = await createApprovalWaitRun(
      reanalysisCase,
      reanalysisDetail,
    );
    const reanalysis = await requestRevisionAction(
      reanalysisDetail,
      operator,
      'reanalyse',
      'Prices changed; rerun the analysis.',
    );
    expect(reanalysis.status).toBe(200);
    const reanalysisBody = ActionRevisionRequestResponseSchema.parse(
      reanalysis.body,
    );
    expect(reanalysisBody.request.kind).toBe('reanalysis');
    expect(reanalysisBody.request.waitRunId).toBe(reanalysisRun);
    expect(reanalysisBody.proposal.proposal.status).toBe('superseded');
    expect(reanalysisBody.proposal.revision.state).toBe('superseded');
    expect(reanalysisBody.proposal.revision.planHash).toBe(
      reanalysisDetail.revision.planHash,
    );
    const oldRevision = await dbOne<{ items: unknown[] }>(
      'SELECT items FROM nexus.action_revisions WHERE id = $1',
      [reanalysisDetail.revision.id],
    );
    expect(oldRevision.items).toHaveLength(reanalysisDetail.revision.items.length);
    const reanalysisRunRow = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.workflow_runs WHERE id = $1',
      [reanalysisRun],
    );
    expect(reanalysisRunRow.status).toBe('waiting_input');
  });

  it('resolves no-action only for an unstarted case and records its reason', async () => {
    const caseId = await createCase('F13 no action');
    const detail = await createPurchaseProposal({ caseId, split: false });
    const runId = await createApprovalWaitRun(caseId, detail);
    const key = randomUUID();
    const response = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/resolve-no-action`,
      operator,
      { reason: 'No feasible option without violating policy.' },
      { 'Idempotency-Key': key },
    );
    expect(response.status).toBe(200);
    const resolution = NoActionResponseSchema.parse(response.body);
    expect(resolution.caseVersion).toBeGreaterThanOrEqual(3);
    const caseRow = await dbOne<{ status: string; version: number }>(
      'SELECT status, version FROM nexus.cases WHERE id = $1',
      [caseId],
    );
    expect(caseRow.status).toBe('resolved');
    expect(caseRow.version).toBe(resolution.caseVersion);
    const proposalRow = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [detail.proposal.id],
    );
    expect(proposalRow.status).toBe('superseded');
    const run = await dbOne<{ status: string; cancel_cause: string | null }>(
      'SELECT status, cancel_cause FROM nexus.workflow_runs WHERE id = $1',
      [runId],
    );
    expect(run.status).toBe('cancelled');
    expect(run.cancel_cause).toBe('operator_request');
    const resolutions = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.case_resolutions WHERE case_id = $1',
      [caseId],
    );
    expect(resolutions.count).toBe(1);
    const replay = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/resolve-no-action`,
      operator,
      { reason: 'No feasible option without violating policy.' },
      { 'Idempotency-Key': key },
    );
    expect(replay.status).toBe(200);
    expect(NoActionResponseSchema.parse(replay.body)).toEqual(resolution);
    const terminal = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/resolve-no-action`,
      operator,
      { reason: 'Second attempt.' },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(terminal.status).toBe(409);
  });

  it('retargets a pending approval wait on edit and invalidates it on expiry', async () => {
    const editCase = await createCase('F13 retarget on edit');
    const editDetail = await createPurchaseProposal({ caseId: editCase, split: true });
    const editRun = await createApprovalWaitRun(editCase, editDetail);
    expect((await decide(editDetail, ops, 'approve')).status).toBe(200);
    const firstItem = editDetail.revision.items[0];
    if (!firstItem || firstItem.payload.kind !== 'enterprise.create_purchase_order') {
      throw new Error('Expected a purchase-order item');
    }
    const editResponse = await mutateJson(
      api.baseUrl,
      'PATCH',
      `/api/v1/proposals/${editDetail.proposal.id}`,
      operator,
      {
        rationale: 'Edited while waiting for finance',
        items: editDetail.revision.items.map((item, index) => ({
          itemId: item.itemId,
          target: item.target,
          evidenceIds: item.evidenceIds,
          payload:
            index === 0 && item.payload.kind === 'enterprise.create_purchase_order'
              ? {
                  ...item.payload,
                  lines: [
                    {
                      ...item.payload.lines[0],
                      unitPriceMinor: '41000',
                    },
                  ],
                }
              : item.payload,
        })),
      },
      { 'If-Match': String(editDetail.revision.revisionNumber) },
    );
    expect(editResponse.status).toBe(200);
    const edited = ActionProposalDetailSchema.parse(editResponse.body);
    const retargeted = await dbOne<{
      status: string;
      wait_reason: Record<string, unknown>;
    }>(
      'SELECT status, wait_reason FROM nexus.workflow_runs WHERE id = $1',
      [editRun],
    );
    expect(retargeted.status).toBe('waiting_approval');
    expect(retargeted.wait_reason['actionRevisionId']).toBe(edited.revision.id);
    const oldResume = await resumeRun(editRun, {
      cause: 'approval_completed',
      proposalId: editDetail.proposal.id,
      actionRevisionId: editDetail.revision.id,
    });
    expect(oldResume.status).toBe(409);

    const expiryCase = await createCase('F13 invalidate wait on expiry');
    const expiryDetail = await createPurchaseProposal({ caseId: expiryCase, split: false });
    const expiryRun = await createApprovalWaitRun(expiryCase, expiryDetail);
    const expired = await workerActionStore.expireProposalRevision({
      sandboxId: SANDBOX_ID,
      proposalId: expiryDetail.proposal.id,
      revisionId: expiryDetail.revision.id,
      entityRef: {
        system: 'enterprise',
        type: 'purchase_order',
        id: randomUUID(),
        version: 1,
      },
      changedFields: ['confirmed_arrival_at'],
      originatingRevisionId: null,
      requestId: 'f13-expiry-test',
      correlationId: 'f13-expiry-test',
    });
    expect(expired).toBe(true);
    const expiredRun = await dbOne<{ status: string; wait_reason: Record<string, unknown> }>(
      'SELECT status, wait_reason FROM nexus.workflow_runs WHERE id = $1',
      [expiryRun],
    );
    expect(expiredRun.status).toBe('waiting_input');
    expect(expiredRun.wait_reason['kind']).toBe('human_input');
    const expiredResume = await resumeRun(expiryRun, {
      cause: 'approval_completed',
      proposalId: expiryDetail.proposal.id,
      actionRevisionId: expiryDetail.revision.id,
    });
    expect(expiredResume.status).toBe(409);

    const approvedCase = await createCase('F13 expired approved resume');
    const approvedDetail = await createPurchaseProposal({
      caseId: approvedCase,
      split: false,
    });
    expect((await decide(approvedDetail, ops, 'approve')).status).toBe(200);
    const approvedRun = await createApprovalWaitRun(approvedCase, approvedDetail);
    await superuser.query(
      "UPDATE nexus.action_revisions SET created_at = clock_timestamp() - interval '2 days', expires_at = clock_timestamp() - interval '1 day' WHERE id = $1",
      [approvedDetail.revision.id],
    );
    const lateResume = await resumeRun(approvedRun, {
      cause: 'approval_completed',
      proposalId: approvedDetail.proposal.id,
      actionRevisionId: approvedDetail.revision.id,
    });
    expect(lateResume.status).toBe(409);
  });

  it('refuses approval when the revision policy identity is no longer current', async () => {
    const caseId = await createCase('F13 changed policy');
    const detail = await createPurchaseProposal({ caseId, split: false });
    await superuser.query(
      "UPDATE nexus.action_revisions SET policy_content_hash = $1 WHERE id = $2",
      ['0'.repeat(64), detail.revision.id],
    );
    const response = await decide(detail, ops, 'approve');
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('STALE_STATE');
    const count = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.approval_decisions',
    );
    expect(count.count).toBe(0);
  });

  it('paginates the approval queue without hiding eligible proposals', async () => {
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const caseId = await createCase(`F13 queue page ${index}`);
      const detail = await createPurchaseProposal({ caseId, split: false });
      created.push(detail.proposal.id);
    }
    await superuser.query(
      'UPDATE nexus.action_proposals SET created_at = clock_timestamp() WHERE id = ANY($1::uuid[])',
      [created],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const route =
        cursor === null
          ? '/api/v1/approvals?limit=1'
          : `/api/v1/approvals?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const response = await readJson(api.baseUrl, route, ops);
      expect(response.status).toBe(200);
      const body = ApprovalQueueResponseSchema.parse(response.body);
      seen.push(...body.items.map((item) => item.proposal.id));
      if (body.nextCursor === null) {
        break;
      }
      cursor = body.nextCursor;
    }
    expect([...seen].sort()).toEqual([...created].sort());
  });

  it('refuses no-action when the case has no active workflow run', async () => {
    const caseId = await createCase('F13 no-action without run');
    const detail = await createPurchaseProposal({ caseId, split: false });
    const response = await mutateJson(
      api.baseUrl,
      'POST',
      `/api/v1/cases/${caseId}/resolve-no-action`,
      operator,
      { reason: 'No run exists to resolve.' },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(response.status).toBe(409);
    const caseRow = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.cases WHERE id = $1',
      [caseId],
    );
    expect(caseRow.status).toBe('investigating');
    const proposal = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [detail.proposal.id],
    );
    expect(proposal.status).toBe('pending_approval');
  });

  it('denies worker inserts into human decisions', async () => {
    await expect(
      workerPool.query(
        `INSERT INTO nexus.approval_decisions (id) VALUES ($1)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

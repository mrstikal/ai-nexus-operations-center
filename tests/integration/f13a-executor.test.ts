import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, Pool as PgPoolType } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionPlanItemSchema,
  EnterpriseCommandReceiptSchema,
  type ActionPlanItem,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
  type PolicyBundle,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { validatePolicyBundle } from '@nexus/domain/policies/action-validation';
import { BindingError, resolveMessagePayload } from '@nexus/domain/actions/bindings';
import { ActionExecutor } from '@nexus/application/actions/executor';
import { computePlanHash } from '@nexus/application/actions/revision-hash';
import { invalidateAffectedProposals } from '@nexus/application/actions/invalidation';
import type { EnterpriseCommandPort } from '@nexus/application/ports/enterprise';
import { createNexusDb } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { createApprovalStore } from '@nexus/db/repositories/approvals';
import { createExecutionStore } from '@nexus/db/repositories/executions';
import { NoActionService } from '@nexus/application/cases/no-action';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OPS_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINANCE_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyBundlePath = path.join(root, 'config/policies/northstar-v1.json');
const policyTextPath = path.join(root, 'fixtures/knowledge/northstar-v1.md');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run through pnpm test:integration F13A`);
  }
  return value;
}

function loadPolicy(): { bundle: PolicyBundle; contentHash: string } {
  const textHash = createHash('sha256')
    .update(readFileSync(policyTextPath))
    .digest('hex');
  const parsed = JSON.parse(readFileSync(policyBundlePath, 'utf8')) as unknown;
  const bundle = validatePolicyBundle(parsed, textHash);
  return { bundle, contentHash: canonicalJsonSha256(bundle) };
}

interface Fixture {
  readonly caseId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly items: ActionPlanItem[];
  readonly planHash: string;
  readonly poItemId: string;
  readonly messageItemId: string;
}

class FakeCommandPort implements EnterpriseCommandPort {
  readonly requests: EnterpriseCommandRequest[] = [];
  readonly receipts = new Map<string, EnterpriseCommandReceipt>();
  readonly #failure: ((request: EnterpriseCommandRequest) => Error | null) | null;
  readonly #delayMs: number;

  constructor(options: { failure?: (request: EnterpriseCommandRequest) => Error | null; delayMs?: number } = {}) {
    this.#failure = options.failure ?? null;
    this.#delayMs = options.delayMs ?? 0;
  }

  async executeCommand(
    input: EnterpriseCommandRequest,
  ): Promise<EnterpriseCommandReceipt> {
    this.requests.push(input);
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    const failure = this.#failure?.(input) ?? null;
    if (failure) {
      throw failure;
    }
    const existing = this.receipts.get(input.itemId);
    if (existing) {
      return existing;
    }
    const resultId = randomUUID();
    let entityChanges;
    let resultEntityType: 'purchase_order' | 'communication';
    if (input.payloadTemplate.kind === 'enterprise.create_purchase_order') {
      resultEntityType = 'purchase_order';
      entityChanges = [
        {
          entityType: 'purchase_order' as const,
          id: resultId,
          beforeVersion: null,
          afterVersion: 1,
        },
        {
          entityType: 'purchase_order' as const,
          id: input.payloadTemplate.sourcePurchaseOrderId,
          beforeVersion: 1,
          afterVersion: 2,
        },
      ];
    } else {
      resultEntityType = 'communication';
      entityChanges = [
        {
          entityType: 'communication' as const,
          id: resultId,
          beforeVersion: null,
          afterVersion: 1,
        },
      ];
    }
    const receipt = EnterpriseCommandReceiptSchema.parse({
      id: randomUUID(),
      sandboxId: input.sandboxId,
      idempotencyKey: `${input.sandboxId}:${input.actionRevisionId}:${input.itemId}:${input.payloadTemplate.kind}`,
      commandKind: input.payloadTemplate.kind,
      actionRevisionId: input.actionRevisionId,
      itemId: input.itemId,
      planHash: input.planHash,
      itemHash: input.itemHash,
      status: 'succeeded',
      executeBefore: input.executeBefore,
      authorizationValidUntil: input.authorizationValidUntil,
      baseExpectedVersions: input.baseExpectedVersions,
      priorReceiptKeys: input.priorReceiptKeys,
      result: {
        entityType: resultEntityType,
        id: resultId,
        version: 1,
      },
      entityChanges,
      createdAt: new Date().toISOString(),
    });
    this.receipts.set(input.itemId, receipt);
    return receipt;
  }

  async getCommandReceipt(key: string): Promise<EnterpriseCommandReceipt> {
    for (const receipt of this.receipts.values()) {
      if (receipt.idempotencyKey === key) {
        return receipt;
      }
    }
    throw new Error('receipt not found');
  }
}

let superuser: Client;
let migrator: Client;
let workerPool: PgPoolType;
let apiPool: PgPoolType;
let workerDb: ReturnType<typeof createNexusDb>;
let executionStore: ReturnType<typeof createExecutionStore>;
let workerActionStore: ReturnType<typeof createActionProposalStore>;
let policy: { bundle: PolicyBundle; contentHash: string };

async function dbAll<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  const result = await superuser.query(sql, parameters);
  return result.rows as T[];
}

async function dbOne<T>(sql: string, parameters: unknown[] = []): Promise<T> {
  const row = (await dbAll<T>(sql, parameters))[0];
  if (!row) {
    throw new Error('Expected one row');
  }
  return row;
}

async function createEvidence(input: {
  readonly caseId: string;
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly reference?: string;
}): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, source_system, source_type,
        source_id, source_version, source_sandbox_id, content_hash, locator,
        captured_facts, missing_reason, captured_at)
     VALUES ($1, $2, $3, 'enterprise_snapshot', 'available', 'enterprise', $4, $5,
             $6, $2, $7, NULL, $8::jsonb, NULL, clock_timestamp())`,
    [
      id,
      SANDBOX_ID,
      input.caseId,
      input.type,
      input.id,
      input.version,
      createHash('sha256').update(`${input.type}:${input.id}`).digest('hex'),
      JSON.stringify(
        input.reference === undefined ? {} : { reference: input.reference },
      ),
    ],
  );
  return id;
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

async function createFixture(input: {
  readonly noteOnly?: boolean;
  readonly unitPriceMinor?: string;
  readonly expiresAt?: string;
} = {}): Promise<Fixture> {
  const caseId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases
       (id, sandbox_id, title, summary, status, version, created_at, updated_at)
     VALUES ($1, $2, 'F13A executor case', NULL, 'needs_approval', 2,
             clock_timestamp(), clock_timestamp())`,
    [caseId, SANDBOX_ID],
  );
  const supplierId = randomUUID();
  const sourcePurchaseOrderId = randomUUID();
  const productId = randomUUID();
  const agreementId = randomUUID();
  const supplierEvidence = await createEvidence({
    caseId,
    type: 'supplier',
    id: supplierId,
    version: 3,
    reference: 'SUPPLIER-001',
  });
  const sourceEvidence = await createEvidence({
    caseId,
    type: 'purchase_order',
    id: sourcePurchaseOrderId,
    version: 1,
    reference: 'PO-2026-1000',
  });
  const productEvidence = await createEvidence({
    caseId,
    type: 'product',
    id: productId,
    version: 2,
    reference: 'SKU-001',
  });
  const agreementEvidence = await createEvidence({
    caseId,
    type: 'agreement',
    id: agreementId,
    version: 4,
    reference: 'AGR-001',
  });
  const poItemId = randomUUID();
  const secondPoItemId = randomUUID();
  const messageItemId = randomUUID();
  const baseVersions = [
    { system: 'enterprise' as const, type: 'supplier', id: supplierId, version: 3 },
    { system: 'enterprise' as const, type: 'purchase_order', id: sourcePurchaseOrderId, version: 1 },
    { system: 'enterprise' as const, type: 'product', id: productId, version: 2 },
    { system: 'enterprise' as const, type: 'agreement', id: agreementId, version: 4 },
  ];
  const evidenceIds = [supplierEvidence, sourceEvidence, productEvidence, agreementEvidence];
  const items: ActionPlanItem[] = input.noteOnly
    ? [
        {
          itemId: poItemId,
          target: { system: 'nexus', type: 'case', id: caseId, version: 1 },
          evidenceIds: [],
          payload: {
            kind: 'case.add_internal_note',
            caseId,
            text: 'Policy-authorized internal note',
          },
          dependsOnItemIds: [],
          baseExpectedVersions: [],
        },
      ]
    : [
        {
          itemId: poItemId,
          target: baseVersions[1]!,
          evidenceIds,
          payload: poPayload({
            supplierId,
            sourcePurchaseOrderId,
            productId,
            agreementId,
            unitPriceMinor: input.unitPriceMinor ?? '30000',
          }) as never,
          dependsOnItemIds: [],
          baseExpectedVersions: baseVersions,
        },
        {
          itemId: secondPoItemId,
          target: baseVersions[1]!,
          evidenceIds,
          payload: poPayload({
            supplierId,
            sourcePurchaseOrderId,
            productId,
            agreementId,
            unitPriceMinor: input.unitPriceMinor ?? '30000',
          }) as never,
          dependsOnItemIds: [],
          baseExpectedVersions: baseVersions,
        },
        {
          itemId: messageItemId,
          target: baseVersions[0]!,
          evidenceIds: [supplierEvidence],
          payload: {
            kind: 'enterprise.send_message',
            recipient: {
              system: 'enterprise',
              type: 'supplier',
              id: supplierId,
              version: 3,
            },
            subject: 'Approved procurement',
            parts: [
              { kind: 'receipt_fact', binding: { fromItemId: poItemId, output: 'purchaseOrderId' }, label: 'First order' },
              { kind: 'receipt_fact', binding: { fromItemId: secondPoItemId, output: 'purchaseOrderId' }, label: 'Second order' },
              { kind: 'text', text: 'Both purchase orders were created.' },
            ],
          },
          dependsOnItemIds: [poItemId, secondPoItemId],
          baseExpectedVersions: [baseVersions[0]!],
        },
      ];
  ActionPlanItemSchema.array().parse(items);
  const planHash = computePlanHash({
    items,
    policyRevision: policy.bundle.revision,
    policyContentHash: policy.contentHash,
  });
  const proposalId = randomUUID();
  const revisionId = randomUUID();
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString();
  await superuser.query('BEGIN');
  try {
    await superuser.query(
      `INSERT INTO nexus.action_proposals
         (id, sandbox_id, case_id, current_revision_id, status, has_procurement,
          created_by_kind, created_by_id, version, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, 'human', 'f13a-test', 1,
               clock_timestamp(), clock_timestamp())`,
      [proposalId, SANDBOX_ID, caseId, input.noteOnly ? 'pending_approval' : 'approved', !input.noteOnly],
    );
    await superuser.query(
      `INSERT INTO nexus.action_revisions
         (id, sandbox_id, proposal_id, revision_number, state, plan_hash, items,
          required_roles, aggregate_impact_minor, is_procurement, policy_revision,
          policy_content_hash, rationale, authored_by_kind, authored_by_id,
          authored_by_roles, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11,
               'F13A executor fixture', 'human', 'f13a-test', '[]'::jsonb, $12,
               $13, clock_timestamp())`,
      [
        revisionId,
        SANDBOX_ID,
        proposalId,
        input.noteOnly ? 'pending_approval' : 'approved',
        planHash,
        JSON.stringify(items),
        JSON.stringify(input.noteOnly ? [] : ['approver_ops', 'approver_finance']),
        input.noteOnly ? null : 60000,
        !input.noteOnly,
        policy.bundle.revision,
        policy.contentHash,
        expiresAt,
        new Date(Date.now() - 7_200_000).toISOString(),
      ],
    );
    for (const evidenceId of [...new Set(items.flatMap((item) => item.evidenceIds))]) {
      await superuser.query(
        `INSERT INTO nexus.action_revision_evidence (sandbox_id, revision_id, evidence_id)
         VALUES ($1, $2, $3)`,
        [SANDBOX_ID, revisionId, evidenceId],
      );
    }
    await superuser.query(
      `UPDATE nexus.action_proposals SET current_revision_id = $1 WHERE id = $2`,
      [revisionId, proposalId],
    );
    if (!input.noteOnly) {
      for (const [role, actorId] of [
        ['approver_ops', OPS_USER_ID],
        ['approver_finance', FINANCE_USER_ID],
      ] as const) {
        await superuser.query(
          `INSERT INTO nexus.approval_decisions
             (id, sandbox_id, proposal_id, action_revision_id, plan_hash, decision,
              role, required_roles, state, actor_kind, actor_id, actor_roles,
              reason, expires_at, decided_at, superseded_at)
           VALUES ($1, $2, $3, $4, $5, 'approve', $6, $7::jsonb, 'active',
                   'human', $8, $7::jsonb, NULL, $9, clock_timestamp(), NULL)`,
          [
            randomUUID(),
            SANDBOX_ID,
            proposalId,
            revisionId,
            planHash,
            role,
            JSON.stringify(['approver_ops', 'approver_finance']),
            actorId,
            expiresAt,
          ],
        );
      }
    }
    await superuser.query('COMMIT');
  } catch (error) {
    await superuser.query('ROLLBACK');
    throw error;
  }
  return {
    caseId,
    proposalId,
    revisionId,
    items,
    planHash,
    poItemId,
    messageItemId,
  };
}

beforeAll(async () => {
  superuser = new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
    password: requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
  });
  migrator = new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
    password: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
  });
  await superuser.connect();
  await migrator.connect();
  await applyMigrations(migrator, {
    schema: 'nexus',
    migrations: loadMigrations(path.join(root, 'packages/db/migrations')),
  });
  const config = {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
  };
  workerPool = new PgPool({
    ...config,
    user: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
    password: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
  });
  apiPool = new PgPool({
    ...config,
    user: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    password: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  workerDb = createNexusDb(workerPool);
  executionStore = createExecutionStore(workerDb);
  workerActionStore = createActionProposalStore(workerDb);
  policy = loadPolicy();
  await superuser.query(
    `INSERT INTO nexus.users
       (id, username, display_name, password_hash, password_salt, password_params, is_active, created_at, updated_at)
     VALUES
       ($1, 'f13a-ops', 'F13A Ops', 'x', 'x', '{"n":1,"r":1,"p":1,"keylen":1}'::jsonb, true, clock_timestamp(), clock_timestamp()),
       ($2, 'f13a-finance', 'F13A Finance', 'x', 'x', '{"n":1,"r":1,"p":1,"keylen":1}'::jsonb, true, clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [OPS_USER_ID, FINANCE_USER_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.user_roles (user_id, role)
     VALUES ($1, 'approver_ops'), ($2, 'approver_finance')
     ON CONFLICT DO NOTHING`,
    [OPS_USER_ID, FINANCE_USER_ID],
  );
}, 120_000);

afterAll(async () => {
  await apiPool?.end();
  await workerPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE
       nexus.case_notes,
       nexus.action_execution_entity_changes,
       nexus.action_execution_receipts,
       nexus.action_execution_attempts,
       nexus.action_executions,
       nexus.case_resolutions,
       nexus.action_revision_requests,
       nexus.approval_decisions,
       nexus.action_command_idempotency,
       nexus.action_revision_evidence,
       nexus.action_revisions,
       nexus.action_proposals,
       nexus.policy_bundles,
       nexus.audit_events,
       nexus.trace_events,
       nexus.evidence,
       nexus.cases
     CASCADE`,
  );
});

describe('F13A sequential executor', () => {
  it('executes two POs and their dependent message once with distinct keys and own-chain advances', async () => {
    const fixture = await createFixture();
    expect(fixture.items).toHaveLength(3);
    const port = new FakeCommandPort();
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    for (let index = 0; index < 4; index += 1) {
      await executor.processOnce();
    }
    expect(fixture.revisionId).toBeTruthy();
    expect(port.requests).toHaveLength(3);
    const orders = port.requests.filter(
      (request) => request.payloadTemplate.kind === 'enterprise.create_purchase_order',
    );
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((request) => request.itemId)).size).toBe(2);
    const message = port.requests.find(
      (request) => request.payloadTemplate.kind === 'enterprise.send_message',
    );
    expect(message?.priorReceiptKeys).toHaveLength(2);
    if (message?.payloadTemplate.kind === 'enterprise.send_message') {
      expect(
        message.payloadTemplate.parts.some((part) => part.kind === 'receipt_fact'),
      ).toBe(false);
    }
    const secondOrder = orders[1];
    const sourceVersion = secondOrder?.baseExpectedVersions.find(
      (base) => base.type === 'purchase_order',
    )?.version;
    expect(sourceVersion).toBe(2);
    const executions = await dbAll<{ item_id: string; state: string; receipt_key: string | null }>(
      'SELECT item_id, state, receipt_key FROM nexus.action_executions ORDER BY created_at',
    );
    expect(executions).toHaveLength(3);
    expect(executions.every((row) => row.state === 'succeeded')).toBe(true);
    expect(new Set(executions.map((row) => row.receipt_key)).size).toBe(3);
    const receipts = await dbAll<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_execution_receipts',
    );
    expect(receipts[0]?.count).toBe(3);
    expect(
      await executionStore.priorSuccessfulAdditionalProcurementMinor({
        sandboxId: SANDBOX_ID,
        caseId: fixture.caseId,
      }),
    ).toBe(60000n);
    expect(orders[0]?.authorizationValidUntil).toBe(orders[0]?.executeBefore);
  });

  it('keeps own-origin changes valid and expires the plan on an unrelated external change', async () => {
    const fixture = await createFixture();
    const port = new FakeCommandPort();
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    const firstReceipt = [...port.receipts.values()][0];
    if (!firstReceipt) {
      throw new Error('Missing receipt');
    }
    const own = await invalidateAffectedProposals(workerActionStore, {
      sandboxId: SANDBOX_ID,
      entityRef: {
        system: 'enterprise',
        type: 'purchase_order',
        id: firstReceipt.entityChanges[1]?.id ?? randomUUID(),
        version: 2,
      },
      changedFields: ['inbound'],
      originatingRevisionId: fixture.revisionId,
      origin: {
        itemId: fixture.poItemId,
        receiptKey: firstReceipt.idempotencyKey,
      },
      requestId: 'f13a-own',
      correlationId: 'f13a-own',
    });
    expect(own.expiredProposalIds).toEqual([]);
    const external = await invalidateAffectedProposals(workerActionStore, {
      sandboxId: SANDBOX_ID,
      entityRef: {
        system: 'enterprise',
        type: 'purchase_order',
        id: firstReceipt.entityChanges[1]?.id ?? randomUUID(),
        version: 3,
      },
      changedFields: ['confirmed_arrival_at'],
      originatingRevisionId: null,
      requestId: 'f13a-external',
      correlationId: 'f13a-external',
    });
    expect(external.expiredProposalIds).toEqual([fixture.proposalId]);

    const incomplete = await createFixture();
    const incompletePort = new FakeCommandPort();
    const incompleteExecutor = new ActionExecutor(executionStore, incompletePort, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await incompleteExecutor.processOnce();
    const incompleteReceipt = [...incompletePort.receipts.values()][0];
    if (!incompleteReceipt) {
      throw new Error('Missing incomplete receipt');
    }
    const incompleteOrigin = await invalidateAffectedProposals(workerActionStore, {
      sandboxId: SANDBOX_ID,
      entityRef: {
        system: 'enterprise',
        type: 'purchase_order',
        id: incompleteReceipt.entityChanges[1]?.id ?? randomUUID(),
        version: 2,
      },
      changedFields: ['inbound'],
      originatingRevisionId: incomplete.revisionId,
      origin: { itemId: incomplete.poItemId },
      requestId: 'f13a-incomplete',
      correlationId: 'f13a-incomplete',
    });
    expect(incompleteOrigin.expiredProposalIds).toEqual([incomplete.proposalId]);
  });

  it('executes the policy-auto note without a human decision and refuses pending enterprise items', async () => {
    const fixture = await createFixture({ noteOnly: true });
    const port = new FakeCommandPort();
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    expect(port.requests).toHaveLength(0);
    const note = await dbOne<{ text: string; authorization_basis: string }>(
      'SELECT text, authorization_basis FROM nexus.case_notes WHERE action_revision_id = $1',
      [fixture.revisionId],
    );
    expect(note.authorization_basis).toBe('policy_auto');
    const audit = await dbOne<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM nexus.audit_events
        WHERE action = 'action.note_executed' ORDER BY sequence DESC LIMIT 1`,
    );
    expect(audit.details['policyRevision']).toBe(policy.bundle.revision);
    expect(audit.details['policyContentHash']).toBe(policy.contentHash);
    expect(audit.details['reasonCode']).toBe('policy_auto');

    const pending = await createFixture();
    await superuser.query(
      "UPDATE nexus.action_proposals SET status='pending_approval' WHERE id=$1",
      [pending.proposalId],
    );
    await superuser.query(
      "UPDATE nexus.action_revisions SET state='pending_approval' WHERE id=$1",
      [pending.revisionId],
    );
    const before = port.requests.length;
    await executor.processOnce();
    expect(port.requests.length).toBe(before);
  });

  it('fails a run without sending its dependent message when a predecessor command fails', async () => {
    const fixture = await createFixture();
    const port = new FakeCommandPort({
      failure: (request) =>
        request.payloadTemplate.kind === 'enterprise.create_purchase_order'
          ? Object.assign(new Error('stale'), { code: 'STALE_STATE' })
          : null,
    });
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    await executor.processOnce();
    const messageRequests = port.requests.filter(
      (request) => request.payloadTemplate.kind === 'enterprise.send_message',
    );
    expect(messageRequests).toHaveLength(0);
    const failed = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_executions WHERE item_id = $1',
      [fixture.poItemId],
    );
    expect(failed.state).toBe('retryable_failure');
  });

  it('serializes duplicate workers to one command attempt', async () => {
    const fixture = await createFixture();
    expect(fixture.revisionId).toBeTruthy();
    const port = new FakeCommandPort({ delayMs: 100 });
    const source = {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    };
    const first = new ActionExecutor(executionStore, port, source);
    const second = new ActionExecutor(executionStore, port, source);
    await Promise.all([first.processOnce(), second.processOnce()]);
    expect(port.requests).toHaveLength(1);
    const count = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_executions',
    );
    expect(count.count).toBe(1);
  });

  it('rejects money/customer/foreign-plan bindings and expired deadlines', async () => {
    const fixture = await createFixture();
    const message = fixture.items[2];
    if (!message || message.payload.kind !== 'enterprise.send_message') {
      throw new Error('Missing message item');
    }
    const messagePayload = message.payload;
    const invalidPayload = {
      ...messagePayload,
      parts: [
        {
          kind: 'receipt_fact' as const,
          binding: { fromItemId: randomUUID(), output: 'purchaseOrderId' as const },
          label: 'Foreign plan',
        },
      ],
    };
    expect(() =>
      resolveMessagePayload(
        { ...message, payload: invalidPayload },
        [],
      ),
    ).toThrow(BindingError);

    const expired = await createFixture({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const port = new FakeCommandPort();
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    expect(
      port.requests.some((request) => request.actionRevisionId === expired.revisionId),
    ).toBe(false);
  });

  it('records ambiguous transport outcomes as unknown and blocks no-action through the real port', async () => {
    const fixture = await createFixture();
    const port = new FakeCommandPort({
      failure: () => Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    });
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    const state = await executionStore.getRevisionExecutionState({
      sandboxId: SANDBOX_ID,
      actionRevisionId: fixture.revisionId,
    });
    expect(state).toBe('unknown');
    const noAction = new NoActionService(
      createApprovalStore(createNexusDb(apiPool)),
      {
        getRevisionExecutionState: (input) =>
          executionStore.getRevisionExecutionState(input),
      },
    );
    await expect(
      noAction.resolve(
        fixture.caseId,
        { reason: 'Must not resolve with an unknown effect.' },
        randomUUID(),
        {
          actor: { kind: 'human', id: 'operator-test', roles: ['operator'] },
          requestId: 'f13a-no-action',
          correlationId: 'f13a-no-action',
        },
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_STATE_PRESENT' });
  });

  it('skips a failed revision and continues with the next approved plan', async () => {
    const failed = await createFixture();
    const later = await createFixture();
    const port = new FakeCommandPort({
      failure: (request) =>
        request.actionRevisionId === failed.revisionId
          ? Object.assign(new Error('stale'), { code: 'STALE_STATE' })
          : null,
    });
    const executor = new ActionExecutor(executionStore, port, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await executor.processOnce();
    await executor.processOnce();
    expect(
      port.requests.some((request) => request.actionRevisionId === later.revisionId),
    ).toBe(true);
  });

  it('blocks a cancelled case and invalidates a plan whose evidence became unavailable', async () => {
    const cancelled = await createFixture();
    await superuser.query(
      "UPDATE nexus.cases SET status = 'cancelled' WHERE id = $1",
      [cancelled.caseId],
    );
    const cancelledPort = new FakeCommandPort();
    const cancelledExecutor = new ActionExecutor(executionStore, cancelledPort, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await cancelledExecutor.processOnce();
    expect(cancelledPort.requests).toHaveLength(0);

    const unavailable = await createFixture();
    await superuser.query(
      "UPDATE nexus.evidence SET source_status = 'missing' WHERE case_id = $1",
      [unavailable.caseId],
    );
    const unavailablePort = new FakeCommandPort();
    const unavailableExecutor = new ActionExecutor(executionStore, unavailablePort, {
      async load() {
        return {
          bundle: policy.bundle,
          contentHash: policy.contentHash,
          canonicalTextPath: policy.bundle.canonicalText.path,
          canonicalTextHash: policy.bundle.canonicalText.sha256,
        };
      },
    });
    await unavailableExecutor.processOnce();
    expect(unavailablePort.requests).toHaveLength(0);
    const proposal = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.action_proposals WHERE id = $1',
      [unavailable.proposalId],
    );
    expect(proposal.status).toBe('expired');
    const audit = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.audit_events WHERE action = 'action.proposal_invalidated' AND target_id = $1",
      [unavailable.proposalId],
    );
    expect(audit.count).toBe(1);
  });

  it('denies API inserts into execution state', async () => {
    await expect(
      apiPool.query(
        'INSERT INTO nexus.action_executions (id) VALUES ($1)',
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

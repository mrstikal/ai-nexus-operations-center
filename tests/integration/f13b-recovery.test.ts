import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { computeRequiredApprovalRoles } from '@nexus/domain/policies/approvals';
import { ActionExecutor } from '@nexus/application/actions/executor';
import { ReconcileService } from '@nexus/application/actions/reconcile';
import { CancelPlanService } from '@nexus/application/actions/cancel-plan';
import { computePlanHash } from '@nexus/application/actions/revision-hash';
import type { EnterpriseCommandPort } from '@nexus/application/ports/enterprise';
import { createNexusDb } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createExecutionStore } from '@nexus/db/repositories/executions';
import { createApprovalStore } from '@nexus/db/repositories/approvals';
import { NoActionService } from '@nexus/application/cases/no-action';
import { createReconciliationStore } from '@nexus/db/repositories/recovery';
import { crashAfterWritingFile, removeFile } from '../helpers/command-faults.js';
import {
  completeCancelRequestedRuns,
  createWorkflowControlStore,
} from '@nexus/db/repositories/workflow-control';

const { Client: PgClient, Pool: PgPool } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OPS_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const policyBundlePath = path.join(root, 'config/policies/northstar-v1.json');
const policyTextPath = path.join(root, 'fixtures/knowledge/northstar-v1.md');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run through pnpm test:integration F13B`);
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

class RecoveryPort implements EnterpriseCommandPort {
  readonly requests: EnterpriseCommandRequest[] = [];
  readonly receipts = new Map<string, EnterpriseCommandReceipt>();
  mode: 'commit_then_timeout' | 'no_receipt' | 'success' | 'always_timeout' = 'success';
  private first = true;

  async executeCommand(input: EnterpriseCommandRequest): Promise<EnterpriseCommandReceipt> {
    this.requests.push(input);
    if (this.mode === 'commit_then_timeout' && this.first) {
      this.first = false;
      this.receipts.set(input.itemId, this.#receipt(input));
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    }
    if (this.mode === 'no_receipt' && this.first) {
      this.first = false;
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    }
    if (this.mode === 'always_timeout') {
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    }
    const receipt = this.#receipt(input);
    this.receipts.set(input.itemId, receipt);
    return receipt;
  }

  async getCommandReceipt(key: string): Promise<EnterpriseCommandReceipt> {
    for (const receipt of this.receipts.values()) {
      if (receipt.idempotencyKey === key) {
        return receipt;
      }
    }
    throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  }

  receiptFor(input: EnterpriseCommandRequest): EnterpriseCommandReceipt {
    return this.#receipt(input);
  }

  #receipt(input: EnterpriseCommandRequest): EnterpriseCommandReceipt {
    if (input.payloadTemplate.kind !== 'enterprise.create_purchase_order') {
      throw new Error('F13B fixture supports POs only');
    }
    const resultId = randomUUID();
    return EnterpriseCommandReceiptSchema.parse({
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
      result: { entityType: 'purchase_order', id: resultId, version: 1 },
      entityChanges: [
        {
          entityType: 'purchase_order',
          id: resultId,
          beforeVersion: null,
          afterVersion: 1,
        },
        {
          entityType: 'purchase_order',
          id: input.payloadTemplate.sourcePurchaseOrderId,
          beforeVersion: 1,
          afterVersion: 2,
        },
      ],
      createdAt: new Date().toISOString(),
    });
  }
}

interface Fixture {
  readonly caseId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly poItemId: string;
  readonly secondPoItemId: string | null;
}

let superuser: Client;
let migrator: Client;
let workerPool: PgPoolType;
let apiPool: PgPoolType;
let workerDb: ReturnType<typeof createNexusDb>;
let executionStore: ReturnType<typeof createExecutionStore>;
let reconciliationStore: ReturnType<typeof createReconciliationStore>;
let policy: { bundle: PolicyBundle; contentHash: string };

async function dbAll<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  const result = await superuser.query(sql, parameters);
  return result.rows as T[];
}
async function dbOne<T>(sql: string, parameters: unknown[] = []): Promise<T> {
  const row = (await dbAll<T>(sql, parameters))[0];
  if (!row) throw new Error('Expected one row');
  return row;
}

async function createEvidence(input: {
  readonly caseId: string;
  readonly type: string;
  readonly id: string;
  readonly version: number;
  readonly reference: string;
}): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.evidence
       (id, sandbox_id, case_id, kind, source_status, source_system, source_type,
        source_id, source_version, source_sandbox_id, content_hash, locator,
        captured_facts, missing_reason, captured_at)
     VALUES ($1, $2, $3, 'enterprise_snapshot', 'available', 'enterprise', $4, $5,
             $6, $2, $7, NULL, $8::jsonb, NULL, clock_timestamp())`,
    [id, SANDBOX_ID, input.caseId, input.type, input.id, input.version,
      createHash('sha256').update(input.type + input.id).digest('hex'),
      JSON.stringify({ reference: input.reference })],
  );
  return id;
}

function poItem(input: {
  readonly itemId: string;
  readonly evidenceIds: string[];
  readonly supplierId: string;
  readonly sourcePurchaseOrderId: string;
  readonly productId: string;
  readonly agreementId: string;
  readonly baseVersions: ActionPlanItem['baseExpectedVersions'];
}): ActionPlanItem {
  return {
    itemId: input.itemId,
    target: input.baseVersions[1]!,
    evidenceIds: input.evidenceIds,
    payload: {
      kind: 'enterprise.create_purchase_order',
      supplierId: input.supplierId,
      sourcePurchaseOrderId: input.sourcePurchaseOrderId,
      lines: [{
        productId: input.productId,
        quantity: 1,
        agreementId: input.agreementId,
        unitPriceMinor: '10000',
        arrivalAt: '2026-12-01T09:00:00.000Z',
      }],
      expediteChargeMinor: '0',
    },
    dependsOnItemIds: [],
    baseExpectedVersions: input.baseVersions,
  };
}

async function createFixture(twoOrders = false, withMessage = false): Promise<Fixture> {
  const caseId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.cases
       (id, sandbox_id, title, summary, status, version, created_at, updated_at)
     VALUES ($1,$2,'F13B recovery',NULL,'needs_approval',2,clock_timestamp(),clock_timestamp())`,
    [caseId, SANDBOX_ID],
  );
  const supplierId = randomUUID();
  const sourceId = randomUUID();
  const productId = randomUUID();
  const agreementId = randomUUID();
  const supplier = await createEvidence({ caseId, type: 'supplier', id: supplierId, version: 3, reference: 'SUP' });
  const source = await createEvidence({ caseId, type: 'purchase_order', id: sourceId, version: 1, reference: 'PO-SRC' });
  const product = await createEvidence({ caseId, type: 'product', id: productId, version: 2, reference: 'SKU' });
  const agreement = await createEvidence({ caseId, type: 'agreement', id: agreementId, version: 4, reference: 'AGR' });
  const baseVersions = [
    { system: 'enterprise' as const, type: 'supplier', id: supplierId, version: 3 },
    { system: 'enterprise' as const, type: 'purchase_order', id: sourceId, version: 1 },
    { system: 'enterprise' as const, type: 'product', id: productId, version: 2 },
    { system: 'enterprise' as const, type: 'agreement', id: agreementId, version: 4 },
  ];
  const firstId = randomUUID();
  const items = [poItem({ itemId: firstId, evidenceIds: [supplier, source, product, agreement], supplierId, sourcePurchaseOrderId: sourceId, productId, agreementId, baseVersions })];
  const secondId = twoOrders ? randomUUID() : null;
  if (secondId) {
    items.push(poItem({ itemId: secondId, evidenceIds: [supplier, source, product, agreement], supplierId, sourcePurchaseOrderId: sourceId, productId, agreementId, baseVersions }));
  }
  if (withMessage) {
    items.push({
      itemId: randomUUID(),
      target: baseVersions[0]!,
      evidenceIds: [supplier],
      payload: {
        kind: 'enterprise.send_message',
        recipient: { system: 'enterprise', type: 'supplier', id: supplierId, version: 3 },
        subject: 'Procurement update',
        parts: [{ kind: 'text', text: 'Both orders are being prepared.' }],
      },
      dependsOnItemIds: [firstId, ...(secondId ? [secondId] : [])],
      baseExpectedVersions: [baseVersions[0]!],
    });
  }
  ActionPlanItemSchema.array().parse(items);
  const planHash = computePlanHash({ items, policyRevision: policy.bundle.revision, policyContentHash: policy.contentHash });
  const proposalId = randomUUID();
  const revisionId = randomUUID();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await superuser.query('BEGIN');
  try {
    await superuser.query(
      `INSERT INTO nexus.action_proposals
         (id,sandbox_id,case_id,current_revision_id,status,has_procurement,
          created_by_kind,created_by_id,version,created_at,updated_at)
       VALUES ($1,$2,$3,NULL,'approved',true,'human','f13b-test',1,clock_timestamp(),clock_timestamp())`,
      [proposalId, SANDBOX_ID, caseId],
    );
    await superuser.query(
      `INSERT INTO nexus.action_revisions
         (id,sandbox_id,proposal_id,revision_number,state,plan_hash,items,required_roles,
          aggregate_impact_minor,is_procurement,policy_revision,policy_content_hash,
          rationale,authored_by_kind,authored_by_id,authored_by_roles,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,1,'approved',$4,$5::jsonb,$6::jsonb,$7,true,$8,$9,'F13B','human','f13b-test','[]'::jsonb,$10,clock_timestamp(),clock_timestamp())`,
      [revisionId, SANDBOX_ID, proposalId, planHash, JSON.stringify(items), JSON.stringify(['approver_ops']), items.length * 10000, policy.bundle.revision, policy.contentHash, expiresAt],
    );
    for (const evidenceId of [...new Set(items.flatMap((item) => item.evidenceIds))]) {
      await superuser.query(
        `INSERT INTO nexus.action_revision_evidence (sandbox_id,revision_id,evidence_id) VALUES ($1,$2,$3)`,
        [SANDBOX_ID, revisionId, evidenceId],
      );
    }
    await superuser.query('UPDATE nexus.action_proposals SET current_revision_id=$1 WHERE id=$2', [revisionId, proposalId]);
    await superuser.query(
      `INSERT INTO nexus.approval_decisions
         (id,sandbox_id,proposal_id,action_revision_id,plan_hash,decision,role,required_roles,
          state,actor_kind,actor_id,actor_roles,reason,expires_at,decided_at,superseded_at)
       VALUES ($1,$2,$3,$4,$5,'approve','approver_ops','["approver_ops"]'::jsonb,'active','human',$6,'["approver_ops"]'::jsonb,NULL,$7,clock_timestamp(),NULL)`,
      [randomUUID(), SANDBOX_ID, proposalId, revisionId, planHash, OPS_USER_ID, expiresAt],
    );
    await superuser.query('COMMIT');
  } catch (error) {
    await superuser.query('ROLLBACK');
    throw error;
  }
  return { caseId, proposalId, revisionId, poItemId: firstId, secondPoItemId: secondId };
}

const policySource = {
  async load() {
    return {
      bundle: policy.bundle,
      contentHash: policy.contentHash,
      canonicalTextPath: policy.bundle.canonicalText.path,
      canonicalTextHash: policy.bundle.canonicalText.sha256,
    };
  },
};

async function createApprovalWaitRun(caseId: string): Promise<string> {
  const inboxId = randomUUID();
  const eventId = randomUUID();
  const runId = randomUUID();
  await superuser.query(
    `INSERT INTO nexus.event_inbox
       (id,sandbox_id,consumer_name,event_id,event_type,producer,correlation_id,causation_id,
        occurred_at,envelope,dispatch_state,attempt_count,next_attempt_at,received_at,updated_at)
     VALUES ($1,$2,'nexus.worker.events.v1',$3,'nexus.case.created.v1','worker',$4,NULL,
             clock_timestamp(),'{}'::jsonb,'processed',0,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
    [inboxId, SANDBOX_ID, eventId, `f13b-${eventId}`],
  );
  await superuser.query(
    `INSERT INTO nexus.workflow_runs
       (id,sandbox_id,case_id,inbox_id,trigger_event_id,trigger_event_type,definition_name,
        definition_version,status,ingress,ingress_hash,effective_at,wait_reason,policy_revision,
        model_revision,config_revision,prompt_revision,active_ms_limit,active_ms_used,deadline_at,
        cancel_requested,resume_cause,cancel_cause,partial_effects,last_error,version,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'nexus.case.created.v1','test-wait','v1','waiting_approval',
             '{"correlationId":"f13b"}'::jsonb,$6,clock_timestamp(),NULL,'test-policy-v1','none',
             'f13b-v1',NULL,300000,0,clock_timestamp()+interval '1 hour',false,NULL,NULL,'[]'::jsonb,
             NULL,1,clock_timestamp(),clock_timestamp())`,
    [runId, SANDBOX_ID, caseId, inboxId, eventId, createHash('sha256').update(runId).digest('hex')],
  );
  return runId;
}

function executor(port: EnterpriseCommandPort): ActionExecutor {
  return new ActionExecutor(executionStore, port, {
    async load() {
      return {
        bundle: policy.bundle,
        contentHash: policy.contentHash,
        canonicalTextPath: policy.bundle.canonicalText.path,
        canonicalTextHash: policy.bundle.canonicalText.sha256,
      };
    },
  });
}

async function makeUnknown(fixture: Fixture, port: EnterpriseCommandPort): Promise<string> {
  await executor(port).processOnce();
  const attempt = await dbOne<{ id: string; execution_id: string }>(
    `SELECT attempt.id, attempt.execution_id
       FROM nexus.action_execution_attempts attempt
       JOIN nexus.action_executions execution ON execution.id = attempt.execution_id
      WHERE execution.action_revision_id = $1 AND execution.state = 'unknown'
      ORDER BY attempt.attempt_number DESC LIMIT 1`,
    [fixture.revisionId],
  );
  await superuser.query(
    `UPDATE nexus.execution_attempt_payloads SET execute_before = clock_timestamp() - interval '30 seconds'
      WHERE attempt_id = $1`,
    [attempt.id],
  );
  return attempt.id;
}

beforeAll(async () => {
  const config = {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
  };
  superuser = new PgClient({ ...config, user: requiredEnv('NEXUS_TEST_SUPERUSER_USER'), password: requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD') });
  migrator = new PgClient({ ...config, user: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'), password: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD') });
  await superuser.connect();
  await migrator.connect();
  await applyMigrations(migrator, { schema: 'nexus', migrations: loadMigrations(path.join(root, 'packages/db/migrations')) });
  workerPool = new PgPool({ ...config, user: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'), password: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD') });
  apiPool = new PgPool({ ...config, user: requiredEnv('NEXUS_TEST_NEXUS_API_USER'), password: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD') });
  workerDb = createNexusDb(workerPool);
  executionStore = createExecutionStore(workerDb);
  reconciliationStore = createReconciliationStore(workerDb);
  policy = loadPolicy();
  await superuser.query(
    `INSERT INTO nexus.users
       (id,username,display_name,password_hash,password_salt,password_params,is_active,created_at,updated_at)
     VALUES ($1,'f13b-ops','F13B Ops','x','x','{"n":1,"r":1,"p":1,"keylen":1}'::jsonb,true,clock_timestamp(),clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [OPS_USER_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.user_roles (user_id,role) VALUES ($1,'approver_ops') ON CONFLICT DO NOTHING`,
    [OPS_USER_ID],
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
       nexus.action_reanalysis_handoffs, nexus.action_partial_effects,
       nexus.execution_reconciliations, nexus.execution_attempt_payloads,
       nexus.case_notes, nexus.action_execution_entity_changes,
       nexus.action_execution_receipts, nexus.action_execution_attempts,
       nexus.action_executions, nexus.case_resolutions, nexus.action_revision_requests,
       nexus.approval_decisions, nexus.action_command_idempotency,
       nexus.action_revision_evidence, nexus.action_revisions, nexus.action_proposals,
       nexus.policy_bundles, nexus.audit_events, nexus.trace_events,
       nexus.evidence, nexus.cases
     CASCADE`,
  );
});

describe('F13B recovery', () => {
  it('applies a found receipt after uncertainty without a new command', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'commit_then_timeout';
    await executor(port).processOnce();
    expect((await dbOne<{ state: string }>('SELECT state FROM nexus.action_executions WHERE action_revision_id=$1', [fixture.revisionId])).state).toBe('unknown');
    const attemptId = await makeUnknown(fixture, port);
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    expect(await reconciler.processOnce()).toBe(true);
    const execution = await dbOne<{ state: string; receipt_key: string }>(
      'SELECT state, receipt_key FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution.state).toBe('succeeded');
    expect(execution.receipt_key).toBeTruthy();
    const effect = await dbOne<{ kind: string }>(
      'SELECT kind FROM nexus.action_partial_effects WHERE execution_id=(SELECT id FROM nexus.action_executions WHERE action_revision_id=$1)',
      [fixture.revisionId],
    );
    expect(effect.kind).toBe('succeeded');
    expect(attemptId).toBeTruthy();
    expect(await reconciler.processOnce()).toBe(false);
    const receipts = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_execution_receipts WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(receipts.count).toBe(1);
  });

  it('classifies absence as unknown before grace and absent-final after it, then reissues once with the same key', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    port.mode = 'success';
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before = clock_timestamp() + interval '20 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    expect(await reconciler.processOnce()).toBe(false);
    expect((await dbOne<{ result: string }>('SELECT result FROM nexus.execution_reconciliations ORDER BY observed_at DESC LIMIT 1')).result).toBe('unknown');
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before = clock_timestamp() - interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    expect(await reconciler.processOnce()).toBe(true);
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'succeeded', attempt_count: 2 });
    expect(port.requests).toHaveLength(2);
    expect((await dbOne<{ result: string }>('SELECT result FROM nexus.execution_reconciliations ORDER BY observed_at DESC LIMIT 1')).result).toBe('found');
  });

  it('does not reissue after cancellation and preserves partial effects in a handoff', async () => {
    const fixture = await createFixture(true);
    const port = new RecoveryPort();
    port.mode = 'success';
    await executor(port).processOnce();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const secondAttempt = await dbOne<{ id: string }>(
      `SELECT attempt.id FROM nexus.action_execution_attempts attempt
       JOIN nexus.action_executions execution ON execution.id=attempt.execution_id
       WHERE execution.action_revision_id=$1 AND execution.state='unknown' LIMIT 1`,
      [fixture.revisionId],
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [secondAttempt.id],
    );
    await superuser.query("UPDATE nexus.cases SET status='cancelled' WHERE id=$1", [fixture.caseId]);
    const reconciler = new ReconcileService(reconciliationStore, {
      async executeCommand() { throw new Error('must not reissue'); },
      async getCommandReceipt() { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); },
    }, policySource);
    await reconciler.processOnce();
    const cancelled = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_executions WHERE action_revision_id=$1 AND state=$2',
      [fixture.revisionId, 'cancelled'],
    );
    expect(cancelled.state).toBe('cancelled');
    const cancelService = new CancelPlanService(
      reconciliationStore,
      { processOnce: async () => false },
    );
    const result = await cancelService.cancel(SANDBOX_ID, fixture.proposalId, 'f13b', 'f13b');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('cancel failed');
    expect(result.summary.unknownItemIds).toEqual([]);
    expect(result.summary.cancelledItemIds.length).toBeGreaterThan(0);
    expect(result.summary.succeededReceiptKeys.length).toBe(1);
    const handoff = await dbOne<{
      succeeded_receipt_keys: string[];
      cancelled_item_ids: string[];
      created_proposal_id: string | null;
      state: string;
    }>(
      'SELECT succeeded_receipt_keys,cancelled_item_ids,created_proposal_id,state FROM nexus.action_reanalysis_handoffs WHERE source_revision_id=$1',
      [fixture.revisionId],
    );
    expect(handoff.cancelled_item_ids.length).toBeGreaterThan(0);
    expect(handoff.succeeded_receipt_keys.length).toBe(1);
    expect(handoff.state).toBe('consumed');
    expect(handoff.created_proposal_id).toBeTruthy();
    const linked = await dbOne<{ status: string; revision_id: string }>(
      `SELECT p.status, p.current_revision_id AS revision_id FROM nexus.action_proposals p
       WHERE p.id=$1`,
      [handoff.created_proposal_id],
    );
    expect(linked.status).toBe('pending_approval');
    const linkedItems = await dbOne<{ items: unknown[] }>(
      'SELECT items FROM nexus.action_revisions WHERE id=$1',
      [linked.revision_id],
    );
    expect(linkedItems.items).toHaveLength(1);
    const linkedDecisions = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.approval_decisions WHERE proposal_id=$1',
      [handoff.created_proposal_id],
    );
    expect(linkedDecisions.count).toBe(0);
    const succeeded = await dbOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM nexus.action_executions WHERE action_revision_id=$1 AND state=$2',
      [fixture.revisionId, 'succeeded'],
    );
    expect(succeeded.count).toBe(1);
    const repeated = await cancelService.cancel(SANDBOX_ID, fixture.proposalId, 'f13b', 'f13b');
    expect(repeated.ok).toBe(false);
    if (repeated.ok) throw new Error('repeat cancel should be closed');
    expect(repeated.code).toBe('PLAN_ALREADY_CLOSED');
  });

  it('stops on a deterministic retry failure instead of issuing another attempt', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    const reconciler = new ReconcileService(
      reconciliationStore,
      {
        async executeCommand() { throw Object.assign(new Error('stale'), { code: 'STALE_STATE' }); },
        async getCommandReceipt() { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); },
      },
      policySource,
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    await reconciler.processOnce();
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state,attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'permanent_failure', attempt_count: 2 });
    await reconciler.processOnce();
    const after = await dbOne<{ attempt_count: number }>(
      'SELECT attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(after.attempt_count).toBe(2);
  });

  it('does not reissue after expiry and explicitly cancels an item that never started', async () => {
    const expired = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(expired, port);
    await superuser.query(
      "UPDATE nexus.action_revisions SET created_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [expired.revisionId],
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    await reconciler.processOnce();
    const expiredExecution = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_executions WHERE action_revision_id=$1',
      [expired.revisionId],
    );
    expect(expiredExecution.state).toBe('cancelled');

    const unsent = await createFixture(true);
    const successPort = new RecoveryPort();
    successPort.mode = 'success';
    await executor(successPort).processOnce();
    const cancelService = new CancelPlanService(
      reconciliationStore,
      { processOnce: async () => false },
    );
    const result = await cancelService.cancel(SANDBOX_ID, unsent.proposalId, 'f13b', 'f13b');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('cancel failed');
    expect(result.summary.succeededReceiptKeys.length).toBe(1);
    expect(result.summary.cancelledItemIds).toEqual([unsent.secondPoItemId]);
    const handoff = await dbOne<{ cancelled_item_ids: string[] }>(
      'SELECT cancelled_item_ids FROM nexus.action_reanalysis_handoffs WHERE source_revision_id=$1',
      [unsent.revisionId],
    );
    expect(handoff.cancelled_item_ids).toEqual([unsent.secondPoItemId]);
  });

  it('stops after at most three identical-payload attempts', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'always_timeout';
    await executor(port).processOnce();
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const latest = await dbOne<{ attempt_id: string }>(
        `SELECT payload.attempt_id FROM nexus.execution_attempt_payloads payload
         JOIN nexus.action_execution_attempts attempt ON attempt.id=payload.attempt_id
         WHERE payload.execution_id=(SELECT id FROM nexus.action_executions WHERE action_revision_id=$1)
         ORDER BY attempt.attempt_number DESC LIMIT 1`,
        [fixture.revisionId],
      );
      await superuser.query(
        `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
        [latest.attempt_id],
      );
      await reconciler.processOnce();
    }
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state,attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'cancelled', attempt_count: 3 });
  });

  it('records cancel_requested, then completes cancellation only after reconciliation', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    const runId = await createApprovalWaitRun(fixture.caseId);
    const control = createWorkflowControlStore(createNexusDb(apiPool));
    const requested = await control.cancelRun({
      runId,
      sandboxId: SANDBOX_ID,
      actor: { kind: 'human', id: 'operator-test', roles: ['operator'] },
      request: { cause: 'operator_request' },
      requestId: 'f13b-cancel',
      correlationId: 'f13b-cancel',
      caseStatusAfter: 'cancelled',
      partialEffects: [],
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error('cancel request failed');
    expect(requested.response.status).toBe('cancel_requested');
    expect(await completeCancelRequestedRuns(workerDb)).toBe(0);
    const reconciler = new ReconcileService(
      reconciliationStore,
      {
        async executeCommand() { throw Object.assign(new Error('stale'), { code: 'STALE_STATE' }); },
        async getCommandReceipt() { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); },
      },
      policySource,
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    await reconciler.processOnce();
    expect(await completeCancelRequestedRuns(workerDb)).toBe(1);
    const run = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.workflow_runs WHERE id=$1',
      [runId],
    );
    expect(run.status).toBe('cancelled');
    const caseRow = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.cases WHERE id=$1',
      [fixture.caseId],
    );
    expect(caseRow.status).toBe('cancelled');
  });

  it('does not reissue after the approver role was revoked', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    await superuser.query(
      "DELETE FROM nexus.user_roles WHERE user_id=$1 AND role='approver_ops'",
      [OPS_USER_ID],
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    await reconciler.processOnce();
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state,attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'cancelled', attempt_count: 1 });
    await superuser.query(
      "INSERT INTO nexus.user_roles (user_id,role) VALUES ($1,'approver_ops') ON CONFLICT DO NOTHING",
      [OPS_USER_ID],
    );
  });

  it('suppresses a dependent message when its second predecessor is unknown or cancelled', async () => {
    const fixture = await createFixture(true, true);
    const port = new RecoveryPort();
    port.mode = 'success';
    await executor(port).processOnce();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attempt = await dbOne<{ id: string }>(
      `SELECT attempt.id FROM nexus.action_execution_attempts attempt
       JOIN nexus.action_executions execution ON execution.id=attempt.execution_id
       WHERE execution.action_revision_id=$1 AND execution.state='unknown' LIMIT 1`,
      [fixture.revisionId],
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attempt.id],
    );
    await superuser.query("UPDATE nexus.cases SET status='cancelled' WHERE id=$1", [fixture.caseId]);
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    await reconciler.processOnce();
    const cancelService = new CancelPlanService(
      reconciliationStore,
      { processOnce: async () => false },
    );
    const result = await cancelService.cancel(SANDBOX_ID, fixture.proposalId, 'f13b', 'f13b');
    expect(result.ok).toBe(true);
    const messageExecutions = await dbAll<{ state: string }>(
      `SELECT execution.state FROM nexus.action_executions execution
       WHERE execution.action_revision_id=$1 AND execution.command_kind='enterprise.send_message'`,
      [fixture.revisionId],
    );
    expect(messageExecutions).toHaveLength(1);
    expect(messageExecutions[0]?.state).toBe('cancelled');
    const receipts = await dbOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM nexus.action_execution_receipts WHERE command_kind='enterprise.send_message'",
    );
    expect(receipts.count).toBe(0);
  });

  it('blocks no-action when a command is already running or unknown', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'success';
    await executor(port).processOnce();
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
        { reason: 'Attempted while a receipt exists.' },
        randomUUID(),
        {
          actor: { kind: 'human', id: 'operator-test', roles: ['operator'] },
          requestId: 'f13b-no-action',
          correlationId: 'f13b-no-action',
        },
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_STATE_PRESENT' });
  });

  it('blocks dispatch for a case with cancellation intent and completes terminal-case cancellation', async () => {
    const blocked = await createFixture();
    await superuser.query(
      'INSERT INTO nexus.action_case_cancellations (sandbox_id,case_id,requested_at) VALUES ($1,$2,clock_timestamp())',
      [SANDBOX_ID, blocked.caseId],
    );
    const port = new RecoveryPort();
    await executor(port).processOnce();
    expect(port.requests).toHaveLength(0);

    const terminal = await createFixture();
    const runId = await createApprovalWaitRun(terminal.caseId);
    await superuser.query(
      "UPDATE nexus.workflow_runs SET status='cancel_requested', cancel_cause='operator_request', updated_at=clock_timestamp() WHERE id=$1",
      [runId],
    );
    await superuser.query("UPDATE nexus.cases SET status='resolved' WHERE id=$1", [terminal.caseId]);
    expect(await completeCancelRequestedRuns(workerDb)).toBe(1);
    const run = await dbOne<{ status: string }>(
      'SELECT status FROM nexus.workflow_runs WHERE id=$1',
      [runId],
    );
    expect(run.status).toBe('cancelled');
  });

  it('does not reissue after cancellation intent', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    await superuser.query(
      'INSERT INTO nexus.action_case_cancellations (sandbox_id,case_id,requested_at) VALUES ($1,$2,clock_timestamp())',
      [SANDBOX_ID, fixture.caseId],
    );
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads SET execute_before=clock_timestamp()-interval '30 seconds' WHERE attempt_id=$1`,
      [attemptId],
    );
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    await reconciler.processOnce();
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state,attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'cancelled', attempt_count: 1 });
  });

  it('applies a receipt produced by a spawned process that died after remote commit', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const request = port.requests[0];
    if (!request) {
      throw new Error('Missing request');
    }
    const receipt = port.receiptFor(request);
    const file = join(tmpdir(), `f13b-receipt-${randomUUID()}.json`);
    const signal = await crashAfterWritingFile(file, JSON.stringify(receipt));
    expect(signal).toBe('SIGKILL');
    const written = JSON.parse(readFileSync(file, 'utf8')) as EnterpriseCommandReceipt;
    removeFile(file);
    port.receipts.set(request.itemId, written);
    const attemptId = await makeUnknown(fixture, port);
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    expect(await reconciler.processOnce()).toBe(true);
    const execution = await dbOne<{ state: string }>(
      'SELECT state FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution.state).toBe('succeeded');
    expect(attemptId).toBeTruthy();
  });

  it('does not reissue a delayed request beyond its authorization deadline', async () => {
    const fixture = await createFixture();
    const port = new RecoveryPort();
    port.mode = 'no_receipt';
    await executor(port).processOnce();
    const attemptId = await makeUnknown(fixture, port);
    await superuser.query(
      `UPDATE nexus.execution_attempt_payloads
          SET execute_before=clock_timestamp()-interval '30 seconds',
              authorization_valid_until=clock_timestamp()-interval '30 seconds'
        WHERE attempt_id=$1`,
      [attemptId],
    );
    const reconciler = new ReconcileService(reconciliationStore, port, policySource);
    await reconciler.processOnce();
    const execution = await dbOne<{ state: string; attempt_count: number }>(
      'SELECT state,attempt_count FROM nexus.action_executions WHERE action_revision_id=$1',
      [fixture.revisionId],
    );
    expect(execution).toEqual({ state: 'cancelled', attempt_count: 1 });
  });

  it('keeps the EUR 500 boundary and cumulative prior commitments deterministic', () => {
    const po = (unitPriceMinor: string) =>
      ({
        itemId: randomUUID(),
        target: { system: 'enterprise', type: 'purchase_order', id: randomUUID(), version: 1 },
        evidenceIds: [],
        payload: {
          kind: 'enterprise.create_purchase_order',
          supplierId: randomUUID(),
          sourcePurchaseOrderId: randomUUID(),
          lines: [{ productId: randomUUID(), quantity: 1, agreementId: randomUUID(), unitPriceMinor, arrivalAt: '2026-12-01T09:00:00.000Z' }],
          expediteChargeMinor: '0',
        },
        dependsOnItemIds: [],
        baseExpectedVersions: [],
      }) as never;
    expect(
      computeRequiredApprovalRoles({ items: [po('40000')], priorProcurementMinor: 0n, financeThresholdMinor: 50000n }).financeRequired,
    ).toBe(false);
    expect(
      computeRequiredApprovalRoles({ items: [po('40000'), po('40000')], priorProcurementMinor: 0n, financeThresholdMinor: 50000n }).financeRequired,
    ).toBe(true);
    expect(
      computeRequiredApprovalRoles({ items: [po('30000')], priorProcurementMinor: 20001n, financeThresholdMinor: 50000n }).financeRequired,
    ).toBe(true);
    expect(
      computeRequiredApprovalRoles({ items: [po('10000')], priorProcurementMinor: 40000n, financeThresholdMinor: 50000n }).financeRequired,
    ).toBe(false);
  });

});

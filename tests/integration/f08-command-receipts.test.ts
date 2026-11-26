import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeEnterpriseCommandItem,
  EnterpriseCommandReceiptSchema,
  receiptKeyFor,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
} from '@nexus/contracts';
import {
  applyMigrations,
  loadMigrations,
} from '@nexus/enterprise-db/migrate';
import {
  INITIAL_ENTERPRISE_SANDBOX,
  seedEnterpriseSupply,
} from '@nexus/enterprise-db/seed';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const simulatorEntry = path.join(root, 'apps/enterprise-sim/dist/main.js');
const fixturesDirectory = path.join(root, 'fixtures/company');
const SANDBOX_ID = INITIAL_ENTERPRISE_SANDBOX.id;
const SUPPLIER_BALTIC = '10000000-0000-4000-8000-000000000001';
const SUPPLIER_RHINE = '10000000-0000-4000-8000-000000000002';
const SUPPLIER_IBERIA = '10000000-0000-4000-8000-000000000003';
const PRODUCT_MONITOR_27 = '20000000-0000-4000-8000-000000000001';
const AGREEMENT_BALTIC_MONITOR = '40000000-0000-4000-8000-000000000001';
const AGREEMENT_RHINE_MONITOR = '40000000-0000-4000-8000-000000000002';
const AGREEMENT_IBERIA_MONITOR = '40000000-0000-4000-8000-000000000003';
const SOURCE_PURCHASE_ORDER = '50000000-0000-4000-8000-000000000001';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F08`);
  }
  return value;
}

interface SpawnedApp {
  child: ChildProcess;
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  waitForExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnApp(environment: Record<string, string>): SpawnedApp {
  if (!existsSync(simulatorEntry)) {
    throw new Error(`Missing compiled entry ${simulatorEntry}; run "pnpm build" first`);
  }
  const child = spawn(process.execPath, [simulatorEntry], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let resolveExit: ((state: { code: number | null; signal: NodeJS.Signals | null }) => void) | null =
    null;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveExit = resolve;
    },
  );
  const listeners = new Set<() => void>();

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const listener of listeners) {
      listener();
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    exitState = { code, signal };
    resolveExit?.(exitState);
    for (const listener of listeners) {
      listener();
    }
  });

  const waitForOutput = (pattern: RegExp, timeoutMs = 15000): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(stdout);
        if (match) {
          cleanup();
          resolve(match);
          return;
        }
        if (exitState) {
          cleanup();
          reject(
            new Error(
              `Process exited before matching ${String(pattern)}. stdout: ${stdout} stderr: ${stderr}`,
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${String(pattern)}. stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });

  const waitForExit = (
    timeoutMs = 10000,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (exitState) {
      return Promise.resolve(exitState);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for process exit. stdout: ${stdout} stderr: ${stderr}`));
      }, timeoutMs);
      void exitPromise.then((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  };

  return {
    child,
    waitForOutput,
    waitForExit,
  };
}

async function stopApp(app: SpawnedApp): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    app.child.kill('SIGTERM');
  }
  const exit = await app.waitForExit();
  expect(exit.code).toBe(0);
}

function appDatabaseClient(): Client {
  return new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
    password: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
    application_name: 'f08-command-receipts-app-test',
    connectionTimeoutMillis: 5000,
  });
}

async function withAppClient<T>(
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = appDatabaseClient();
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function databaseClient(): Client {
  return new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_USER'),
    password: requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD'),
    application_name: 'f08-command-receipts-test',
    connectionTimeoutMillis: 5000,
  });
}

let migrator: Client;
let app: SpawnedApp | null = null;
let appPort: number | null = null;

function simulatorEnvironment(): Record<string, string> {
  return {
    PORT: '0',
    ENTERPRISE_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    ENTERPRISE_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    ENTERPRISE_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    ENTERPRISE_APP_DB_USER: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
    ENTERPRISE_APP_DB_PASSWORD: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
    ENTERPRISE_SIM_READ_TOKEN: requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN'),
    ENTERPRISE_SIM_COMMAND_TOKEN: requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN'),
  };
}

async function startSimulator(): Promise<void> {
  const spawned = spawnApp(simulatorEnvironment());
  app = spawned;
  const ready = await spawned.waitForOutput(/ENTERPRISE_SIM_READY port=(\d+)/);
  const portText = ready[1];
  if (!portText) {
    throw new Error('Enterprise simulator readiness line did not include a port');
  }
  appPort = Number(portText);
}

function apiUrl(pathname: string): string {
  if (appPort === null) {
    throw new Error('Enterprise simulator is not running');
  }
  return `http://127.0.0.1:${appPort}${pathname}`;
}

async function dbQuery<T>(
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  const result = await migrator.query(sql, parameters);
  return result.rows as T[];
}

async function dbOne<T>(
  sql: string,
  parameters: unknown[] = [],
): Promise<T> {
  const rows = await dbQuery<T>(sql, parameters);
  const row = rows[0];
  if (!row) {
    throw new Error('Expected one database row');
  }
  return row;
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
  readonly includeInventory?: boolean;
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
    if (spec.includeInventory) {
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
  }
  return versions;
}

interface BuildCommandSpec {
  readonly kind: EnterpriseCommandRequest['payloadTemplate']['kind'];
  readonly revisionId: string;
  readonly itemId: string;
  readonly planHash?: string;
  readonly payloadTemplate: EnterpriseCommandRequest['payloadTemplate'];
  readonly bases: readonly EnterpriseBaseExpectedVersion[];
  readonly priorReceiptKeys?: readonly string[];
  readonly executeBefore?: string;
  readonly authorizationValidUntil?: string;
}

function buildCommand(spec: BuildCommandSpec): EnterpriseCommandRequest {
  const now = Date.now();
  return {
    sandboxId: SANDBOX_ID,
    actionRevisionId: spec.revisionId,
    itemId: spec.itemId,
    planHash: spec.planHash ?? planHashFor(`plan:${spec.revisionId}`),
    itemHash: itemHashFor(spec.payloadTemplate, spec.bases),
    baseExpectedVersions: [...spec.bases],
    payloadTemplate: spec.payloadTemplate,
    priorReceiptKeys: [...(spec.priorReceiptKeys ?? [])],
    executeBefore: spec.executeBefore ?? new Date(now + 10_000).toISOString(),
    authorizationValidUntil:
      spec.authorizationValidUntil ?? new Date(now + 20_000).toISOString(),
  };
}

async function postCommand(
  body: EnterpriseCommandRequest,
  token = requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN'),
): Promise<Response> {
  return fetch(apiUrl(`/v1/commands/${body.payloadTemplate.kind}`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-nexus-sandbox-id': SANDBOX_ID,
      'x-correlation-id': `f08-${randomUUID()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function getReceipt(
  key: string,
  token = requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN'),
): Promise<Response> {
  return fetch(apiUrl(`/v1/command-receipts/${encodeURIComponent(key)}`), {
    headers: {
      authorization: `Bearer ${token}`,
      'x-nexus-sandbox-id': SANDBOX_ID,
      'x-correlation-id': `f08-${randomUUID()}`,
    },
    signal: AbortSignal.timeout(10000),
  });
}

async function readInventory(token: string): Promise<Response> {
  return fetch(apiUrl(`/v1/inventory?productIds=${PRODUCT_MONITOR_27}`), {
    headers: {
      authorization: `Bearer ${token}`,
      'x-nexus-sandbox-id': SANDBOX_ID,
      'x-correlation-id': `f08-${randomUUID()}`,
    },
    signal: AbortSignal.timeout(10000),
  });
}

async function readPurchaseOrder(id: string): Promise<Response> {
  return fetch(apiUrl(`/v1/purchase-orders/${id}`), {
    headers: {
      authorization: `Bearer ${requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN')}`,
      'x-nexus-sandbox-id': SANDBOX_ID,
      'x-correlation-id': `f08-${randomUUID()}`,
    },
    signal: AbortSignal.timeout(10000),
  });
}

async function expectProblem(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { code?: string; requestId?: string };
  expect(body.code).toBe(code);
  expect(typeof body.requestId).toBe('string');
}

async function expectReceipt(response: Response): Promise<EnterpriseCommandReceipt> {
  expect(response.status).toBe(200);
  return EnterpriseCommandReceiptSchema.parse(await response.json());
}

function createOrderPayload(
  supplierId: string,
  agreementId: string,
  quantity: number,
  unitPriceMinor: string,
  expediteChargeMinor = '0',
  arrivalAt = '2026-11-04T09:00:00Z',
): EnterpriseCommandRequest['payloadTemplate'] {
  return {
    kind: 'enterprise.create_purchase_order',
    supplierId,
    sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
    lines: [
      {
        productId: PRODUCT_MONITOR_27,
        quantity,
        agreementId,
        unitPriceMinor,
        arrivalAt,
      },
    ],
    expediteChargeMinor,
  };
}

beforeAll(async () => {
  migrator = databaseClient();
  await migrator.connect();
  await applyMigrations(migrator, {
    schema: 'enterprise',
    migrations: loadMigrations(path.join(root, 'packages/enterprise-db/migrations')),
  });
  await seedEnterpriseSupply(migrator, { fixturesDirectory });
  await startSimulator();
}, 120000);

afterAll(async () => {
  if (app) {
    try {
      await stopApp(app);
    } finally {
      if (app.child.exitCode === null && app.child.signalCode === null) {
        app.child.kill('SIGKILL');
      }
    }
  }
  await migrator.end();
});

describe('F08 command receipts and supply mutations', () => {
  it('separates read and command credentials', async () => {
    const commandToken = requiredEnv('NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN');
    const readToken = requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN');
    await expectProblem(await readInventory(commandToken), 401, 'UNAUTHENTICATED');
    const payload = createOrderPayload(
      SUPPLIER_RHINE,
      AGREEMENT_RHINE_MONITOR,
      5,
      '17900',
    );
    const body = buildCommand({
      kind: payload.kind,
      revisionId: randomUUID(),
      itemId: randomUUID(),
      payloadTemplate: payload,
      bases: await baseVersions({
        supplierIds: [SUPPLIER_RHINE],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_RHINE_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
    });
    await expectProblem(await postCommand(body, readToken), 401, 'UNAUTHENTICATED');
  });

  it('creates one purchase order, receipt and origin-tagged inbound outbox effect', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const before = await dbOne<{
      source_version: number;
      inventory_version: number;
      on_hand: number;
      receipt_count: number;
      outbox_count: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT on_hand_quantity FROM enterprise.inventory WHERE product_id = $2) AS on_hand,
        (SELECT count(*)::int FROM enterprise.command_receipts) AS receipt_count,
        (SELECT count(*)::int FROM enterprise.event_outbox) AS outbox_count
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27]);
    const body = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: createOrderPayload(
        SUPPLIER_RHINE,
        AGREEMENT_RHINE_MONITOR,
        40,
        '17900',
        '2500',
      ),
      bases: await baseVersions({
        supplierIds: [SUPPLIER_RHINE],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_RHINE_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
    });
    const receipt = await expectReceipt(await postCommand(body));
    expect(receipt).toMatchObject({
      sandboxId: SANDBOX_ID,
      idempotencyKey: receiptKeyFor(
        SANDBOX_ID,
        revisionId,
        itemId,
        'enterprise.create_purchase_order',
      ),
      commandKind: 'enterprise.create_purchase_order',
      status: 'succeeded',
      result: { entityType: 'purchase_order', version: 1 },
    });
    expect(receipt.entityChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'purchase_order',
          id: receipt.result.id,
          beforeVersion: null,
          afterVersion: 1,
        }),
        expect.objectContaining({
          entityType: 'purchase_order',
          id: SOURCE_PURCHASE_ORDER,
          beforeVersion: before.source_version,
          afterVersion: before.source_version + 1,
        }),
        expect.objectContaining({
          entityType: 'inventory',
          id: PRODUCT_MONITOR_27,
          beforeVersion: before.inventory_version,
          afterVersion: before.inventory_version + 1,
        }),
      ]),
    );

    const stored = await dbOne<{
      reference: string;
      status: string;
      source_purchase_order_id: string;
      expedite_charge_minor: string;
      version: number;
    }>(
      `SELECT reference, status, source_purchase_order_id, expedite_charge_minor, version
       FROM enterprise.purchase_orders WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, receipt.result.id],
    );
    expect(stored).toMatchObject({
      status: 'open',
      source_purchase_order_id: SOURCE_PURCHASE_ORDER,
      expedite_charge_minor: '2500',
      version: 1,
    });
    const line = await dbOne<{
      agreement_id: string;
      ordered_quantity: number;
      received_quantity: number;
      unit_price_minor: string;
    }>(
      `SELECT agreement_id, ordered_quantity, received_quantity, unit_price_minor
       FROM enterprise.purchase_order_lines
       WHERE sandbox_id = $1 AND purchase_order_id = $2`,
      [SANDBOX_ID, receipt.result.id],
    );
    expect(line).toEqual({
      agreement_id: AGREEMENT_RHINE_MONITOR,
      ordered_quantity: 40,
      received_quantity: 0,
      unit_price_minor: '17900',
    });

    const after = await dbOne<{
      source_version: number;
      inventory_version: number;
      on_hand: number;
      receipt_count: number;
      outbox_count: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT on_hand_quantity FROM enterprise.inventory WHERE product_id = $2) AS on_hand,
        (SELECT count(*)::int FROM enterprise.command_receipts) AS receipt_count,
        (SELECT count(*)::int FROM enterprise.event_outbox) AS outbox_count
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27]);
    expect(after).toEqual({
      source_version: before.source_version + 1,
      inventory_version: before.inventory_version + 1,
      on_hand: before.on_hand,
      receipt_count: before.receipt_count + 1,
      outbox_count: before.outbox_count + 1,
    });

    const outbox = await dbOne<{
      id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      origin_action_revision_id: string;
      origin_item_id: string;
      origin_receipt_id: string;
      origin_receipt_key: string;
      payload: {
        entityType: string;
        version: number;
        purchaseOrderId: string;
        purchaseOrderReference: string;
        origin: { receiptId: string; receiptKey: string };
      };
    }>(
      `SELECT id, event_type, aggregate_type, aggregate_id, aggregate_version,
              origin_action_revision_id, origin_item_id, origin_receipt_id,
              origin_receipt_key, payload
       FROM enterprise.event_outbox
       WHERE sandbox_id = $1 AND origin_receipt_id = $2`,
      [SANDBOX_ID, receipt.id],
    );
    expect(outbox).toMatchObject({
      event_type: 'enterprise.inventory.changed.v1',
      aggregate_type: 'inventory',
      aggregate_id: PRODUCT_MONITOR_27,
      aggregate_version: after.inventory_version,
      origin_action_revision_id: revisionId,
      origin_item_id: itemId,
      origin_receipt_id: receipt.id,
      origin_receipt_key: receipt.idempotencyKey,
      payload: {
        entityType: 'inventory',
        version: after.inventory_version,
        purchaseOrderId: receipt.result.id,
        purchaseOrderReference: stored.reference,
        origin: { receiptId: receipt.id, receiptKey: receipt.idempotencyKey },
      },
    });

    const published = await withAppClient(async (client) => {
      await expect(
        client.query(
          "UPDATE enterprise.event_outbox SET event_type = 'enterprise.order.changed.v1' WHERE sandbox_id = $1 AND id = $2",
          [SANDBOX_ID, outbox.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const result = await client.query<{
        status: string;
        event_type: string;
        attempt_count: number;
        version: number;
      }>(
        `UPDATE enterprise.event_outbox
         SET status = 'published',
             attempt_count = 1,
             version = 1,
             next_attempt_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE sandbox_id = $1 AND id = $2
         RETURNING status, event_type, attempt_count, version`,
        [SANDBOX_ID, outbox.id],
      );
      return result.rows[0];
    });
    expect(published).toEqual({
      status: 'published',
      event_type: 'enterprise.inventory.changed.v1',
      attempt_count: 1,
      version: 1,
    });
    await migrator.query(
      `UPDATE enterprise.event_outbox
       SET status = 'pending',
           attempt_count = 0,
           version = 0,
           updated_at = clock_timestamp()
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, outbox.id],
    );
    const orderEvent = await migrator.query<{
      event_type: string;
      aggregate_type: string;
    }>(
      `UPDATE enterprise.event_outbox
       SET event_type = 'enterprise.order.changed.v1',
           aggregate_type = 'purchase_order'
       WHERE sandbox_id = $1 AND id = $2
       RETURNING event_type, aggregate_type`,
      [SANDBOX_ID, outbox.id],
    );
    expect(orderEvent.rows[0]).toEqual({
      event_type: 'enterprise.order.changed.v1',
      aggregate_type: 'purchase_order',
    });
    await migrator.query(
      `UPDATE enterprise.event_outbox
       SET event_type = 'enterprise.inventory.changed.v1',
           aggregate_type = 'inventory'
       WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, outbox.id],
    );

    const readOrder = await readPurchaseOrder(receipt.result.id);
    expect(readOrder.status).toBe(200);
    const readOrderBody = (await readOrder.json()) as {
      purchaseOrders: Array<{
        reference: string;
        sourcePurchaseOrderReference: string;
        expediteChargeMinor: string;
        lineCount?: number;
        lines: Array<{
          agreementId: string;
          agreementReference: string;
          agreementVersion: number;
          orderedQuantity: number;
        }>;
      }>;
    };
    expect(readOrderBody.purchaseOrders[0]).toMatchObject({
      reference: stored.reference,
      sourcePurchaseOrderReference: 'PO-2026-1001',
      expediteChargeMinor: '2500',
      lines: [
        {
          agreementId: AGREEMENT_RHINE_MONITOR,
          agreementReference: 'AGR-2026-0002',
          agreementVersion: 7,
          orderedQuantity: 40,
        },
      ],
    });

    const inventoryResponse = await readInventory(
      requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN'),
    );
    expect(inventoryResponse.status).toBe(200);
    const inventoryBody = (await inventoryResponse.json()) as {
      items: Array<{
        onHandQuantity: number;
        version: number;
        confirmedInbound: Array<{
          purchaseOrderId: string;
          unreceivedQuantity: number;
          confirmedArrivalAt: string;
        }>;
      }>;
    };
    expect(inventoryBody.items[0]).toMatchObject({
      onHandQuantity: before.on_hand,
      version: after.inventory_version,
    });
    expect(
      inventoryBody.items[0]?.confirmedInbound.some(
        (line) =>
          line.purchaseOrderId === receipt.result.id &&
          line.unreceivedQuantity === 40 &&
          line.confirmedArrivalAt === '2026-11-04T09:00:00.000Z',
      ),
    ).toBe(true);

    const receiptRead = await getReceipt(receipt.idempotencyKey);
    expect(await expectReceipt(receiptRead)).toEqual(receipt);

    const renewedDeadline = new Date(Date.now() + 15_000).toISOString();
    const renewed = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: body.payloadTemplate,
      bases: body.baseExpectedVersions,
      priorReceiptKeys: [
        receiptKeyFor(
          SANDBOX_ID,
          randomUUID(),
          randomUUID(),
          'enterprise.send_message',
        ),
      ],
      executeBefore: renewedDeadline,
      authorizationValidUntil: new Date(Date.now() + 25_000).toISOString(),
    });
    const replayed = await expectReceipt(await postCommand(renewed));
    expect(replayed).toEqual(receipt);
    const countsAfterReplay = await dbOne<{ receipts: number; orders: number }>(
      `SELECT
         (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
         (SELECT count(*)::int FROM enterprise.purchase_orders WHERE id = $1) AS orders`,
      [receipt.result.id],
    );
    expect(countsAfterReplay).toEqual({ receipts: after.receipt_count, orders: 1 });
  });

  it('serializes concurrent identical business requests into one receipt and one order', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const before = await dbOne<{
      source_version: number;
      inventory_version: number;
      supplier_orders: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT count(*)::int FROM enterprise.purchase_orders
          WHERE source_purchase_order_id = $1 AND supplier_id = $3) AS supplier_orders
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27, SUPPLIER_IBERIA]);
    const body = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: createOrderPayload(
        SUPPLIER_IBERIA,
        AGREEMENT_IBERIA_MONITOR,
        20,
        '17250',
      ),
      bases: await baseVersions({
        supplierIds: [SUPPLIER_IBERIA],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_IBERIA_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
    });
    const [left, right] = await Promise.all([
      postCommand(body),
      postCommand(body),
    ]);
    const leftReceipt = await expectReceipt(left);
    const rightReceipt = await expectReceipt(right);
    expect(rightReceipt).toEqual(leftReceipt);
    const after = await dbOne<{
      source_version: number;
      inventory_version: number;
      supplier_orders: number;
      receipts: number;
      outbox_events: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT count(*)::int FROM enterprise.purchase_orders
          WHERE source_purchase_order_id = $1 AND supplier_id = $3) AS supplier_orders,
        (SELECT count(*)::int FROM enterprise.command_receipts
          WHERE action_revision_id = $4) AS receipts,
        (SELECT count(*)::int FROM enterprise.event_outbox
          WHERE origin_receipt_id = $5) AS outbox_events
    `, [
      SOURCE_PURCHASE_ORDER,
      PRODUCT_MONITOR_27,
      SUPPLIER_IBERIA,
      revisionId,
      leftReceipt.id,
    ]);
    expect(after).toEqual({
      source_version: before.source_version + 1,
      inventory_version: before.inventory_version + 1,
      supplier_orders: before.supplier_orders + 1,
      receipts: 1,
      outbox_events: 1,
    });
  });

  it('returns 409 for changed business identity, planHash or base versions', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const bases = await baseVersions({
      supplierIds: [SUPPLIER_RHINE],
      sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
      agreementIds: [AGREEMENT_RHINE_MONITOR],
      productIds: [PRODUCT_MONITOR_27],
      includeInventory: true,
    });
    const body = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: createOrderPayload(
        SUPPLIER_RHINE,
        AGREEMENT_RHINE_MONITOR,
        7,
        '17900',
      ),
      bases,
    });
    const receipt = await expectReceipt(await postCommand(body));
    const before = await dbOne<{ receipts: number; orders: number }>(
      `SELECT
         (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
         (SELECT count(*)::int FROM enterprise.purchase_orders) AS orders`,
    );

    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId,
          payloadTemplate: createOrderPayload(
            SUPPLIER_RHINE,
            AGREEMENT_RHINE_MONITOR,
            8,
            '17900',
          ),
          bases,
        }),
      ),
      409,
      'IDEMPOTENCY_MISMATCH',
    );
    await expectProblem(
      await postCommand({
        ...body,
        planHash: planHashFor('different-plan'),
        executeBefore: new Date(Date.now() + 10_000).toISOString(),
        authorizationValidUntil: new Date(Date.now() + 20_000).toISOString(),
      }),
      409,
      'IDEMPOTENCY_MISMATCH',
    );
    const changedBase = bases.map((base) =>
      base.type === 'agreement' ? { ...base, version: base.version + 1 } : base,
    );
    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId,
          payloadTemplate: body.payloadTemplate,
          bases: changedBase,
        }),
      ),
      409,
      'IDEMPOTENCY_MISMATCH',
    );
    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId: randomUUID(),
          planHash: planHashFor('second-plan'),
          payloadTemplate: createOrderPayload(
            SUPPLIER_RHINE,
            AGREEMENT_RHINE_MONITOR,
            9,
            '17900',
          ),
          bases,
        }),
      ),
      409,
      'IDEMPOTENCY_MISMATCH',
    );

    const after = await dbOne<{ receipts: number; orders: number }>(
      `SELECT
         (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
         (SELECT count(*)::int FROM enterprise.purchase_orders) AS orders`,
    );
    expect(after).toEqual(before);
    expect(receipt.result.entityType).toBe('purchase_order');
  });

  it('rejects wrong price, capacity, external agreement version and frozen sandbox', async () => {
    const rejectedKey = async (
      payload: EnterpriseCommandRequest['payloadTemplate'],
      bases: readonly EnterpriseBaseExpectedVersion[],
    ): Promise<{ body: EnterpriseCommandRequest; key: string }> => {
      const revisionId = randomUUID();
      const itemId = randomUUID();
      const body = buildCommand({
        kind: payload.kind,
        revisionId,
        itemId,
        payloadTemplate: payload,
        bases,
      });
      return {
        body,
        key: receiptKeyFor(SANDBOX_ID, revisionId, itemId, payload.kind),
      };
    };

    const priceSpec = await rejectedKey(
      createOrderPayload(SUPPLIER_IBERIA, AGREEMENT_IBERIA_MONITOR, 5, '17000'),
      await baseVersions({
        supplierIds: [SUPPLIER_IBERIA],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_IBERIA_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
    );
    await expectProblem(await postCommand(priceSpec.body), 409, 'CONFLICT');
    expect(await getReceipt(priceSpec.key)).toMatchObject({ status: 404 });

    const capacitySpec = await rejectedKey(
      createOrderPayload(SUPPLIER_IBERIA, AGREEMENT_IBERIA_MONITOR, 61, '17250'),
      await baseVersions({
        supplierIds: [SUPPLIER_IBERIA],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_IBERIA_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
    );
    await expectProblem(await postCommand(capacitySpec.body), 409, 'CONFLICT');

    const agreementBefore = await dbOne<{ version: number }>(
      'SELECT version FROM enterprise.agreements WHERE id = $1',
      [AGREEMENT_IBERIA_MONITOR],
    );
    const staleBases = await baseVersions({
      supplierIds: [SUPPLIER_IBERIA],
      sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
      agreementIds: [AGREEMENT_IBERIA_MONITOR],
      productIds: [PRODUCT_MONITOR_27],
      includeInventory: true,
    });
    await migrator.query(
      'UPDATE enterprise.agreements SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1',
      [AGREEMENT_IBERIA_MONITOR],
    );
    try {
      const staleSpec = await rejectedKey(
        createOrderPayload(SUPPLIER_IBERIA, AGREEMENT_IBERIA_MONITOR, 5, '17250'),
        staleBases,
      );
      await expectProblem(await postCommand(staleSpec.body), 409, 'STALE_STATE');
    } finally {
      await migrator.query(
        'UPDATE enterprise.agreements SET version = $2, updated_at = clock_timestamp() WHERE id = $1',
        [AGREEMENT_IBERIA_MONITOR, agreementBefore.version],
      );
    }

    await migrator.query(
      "UPDATE enterprise.sandboxes SET status = 'retired', updated_at = clock_timestamp() WHERE id = $1",
      [SANDBOX_ID],
    );
    try {
      const frozenSpec = await rejectedKey(
        createOrderPayload(SUPPLIER_RHINE, AGREEMENT_RHINE_MONITOR, 5, '17900'),
        await baseVersions({
          supplierIds: [SUPPLIER_RHINE],
          sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
          agreementIds: [AGREEMENT_RHINE_MONITOR],
          productIds: [PRODUCT_MONITOR_27],
          includeInventory: true,
        }),
      );
      await expectProblem(await postCommand(frozenSpec.body), 409, 'STALE_STATE');
    } finally {
      await migrator.query(
        "UPDATE enterprise.sandboxes SET status = 'active', updated_at = clock_timestamp() WHERE id = $1",
        [SANDBOX_ID],
      );
    }

    await expect(
      migrator.query(
        "UPDATE enterprise.agreements SET currency = 'USD' WHERE id = $1",
        [AGREEMENT_IBERIA_MONITOR],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const extraField = {
      ...createOrderPayload(SUPPLIER_RHINE, AGREEMENT_RHINE_MONITOR, 5, '17900'),
      currency: 'USD',
    };
    const extraBase = await baseVersions({
      supplierIds: [SUPPLIER_RHINE],
      sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
      agreementIds: [AGREEMENT_RHINE_MONITOR],
      productIds: [PRODUCT_MONITOR_27],
      includeInventory: true,
    });
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const extraBody = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: extraField as EnterpriseCommandRequest['payloadTemplate'],
      bases: extraBase,
    });
    await expectProblem(await postCommand(extraBody), 400, 'VALIDATION_FAILED');
  });

  it('bounds command deadlines and still reads a past success', async () => {
    const bases = await baseVersions({
      supplierIds: [SUPPLIER_RHINE],
      sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
      agreementIds: [AGREEMENT_RHINE_MONITOR],
      productIds: [PRODUCT_MONITOR_27],
      includeInventory: true,
    });
    const payload = createOrderPayload(
      SUPPLIER_RHINE,
      AGREEMENT_RHINE_MONITOR,
      3,
      '17900',
    );
    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId: randomUUID(),
          itemId: randomUUID(),
          payloadTemplate: payload,
          bases,
          executeBefore: new Date(Date.now() - 1_000).toISOString(),
          authorizationValidUntil: new Date(Date.now() + 20_000).toISOString(),
        }),
      ),
      409,
      'APPROVAL_EXPIRED',
    );
    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId: randomUUID(),
          itemId: randomUUID(),
          payloadTemplate: payload,
          bases,
          executeBefore: new Date(Date.now() + 60_000).toISOString(),
          authorizationValidUntil: new Date(Date.now() + 90_000).toISOString(),
        }),
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId: randomUUID(),
          itemId: randomUUID(),
          payloadTemplate: payload,
          bases,
          executeBefore: new Date(Date.now() + 10_000).toISOString(),
          authorizationValidUntil: new Date(Date.now() + 5_000).toISOString(),
        }),
      ),
      400,
      'VALIDATION_FAILED',
    );

    const revisionId = randomUUID();
    const itemId = randomUUID();
    const shortBody = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: payload,
      bases,
      executeBefore: new Date(Date.now() + 1_500).toISOString(),
      authorizationValidUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    const receipt = await expectReceipt(await postCommand(shortBody));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await expectReceipt(await getReceipt(receipt.idempotencyKey))).toEqual(receipt);
    const renewed = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: payload,
      bases,
      executeBefore: new Date(Date.now() + 10_000).toISOString(),
      authorizationValidUntil: new Date(Date.now() + 20_000).toISOString(),
    });
    expect(await expectReceipt(await postCommand(renewed))).toEqual(receipt);

    await migrator.query(
      "UPDATE enterprise.sandboxes SET status = 'retired', updated_at = clock_timestamp() WHERE id = $1",
      [SANDBOX_ID],
    );
    try {
      expect(await expectReceipt(await postCommand(shortBody))).toEqual(receipt);
    } finally {
      await migrator.query(
        "UPDATE enterprise.sandboxes SET status = 'active', updated_at = clock_timestamp() WHERE id = $1",
        [SANDBOX_ID],
      );
    }
  });

  it('validates same-plan proof sets and keeps message sending simulated', async () => {
    const revisionId = randomUUID();
    const planHash = planHashFor(`proof-plan:${revisionId}`);
    const poOneItem = randomUUID();
    const poTwoItem = randomUUID();
    const poOne = await expectReceipt(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId: poOneItem,
          planHash,
          payloadTemplate: createOrderPayload(
            SUPPLIER_RHINE,
            AGREEMENT_RHINE_MONITOR,
            5,
            '17900',
          ),
          bases: await baseVersions({
            supplierIds: [SUPPLIER_RHINE],
            sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
            agreementIds: [AGREEMENT_RHINE_MONITOR],
            productIds: [PRODUCT_MONITOR_27],
            includeInventory: true,
          }),
        }),
      ),
    );
    const poTwo = await expectReceipt(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId: poTwoItem,
          planHash,
          payloadTemplate: createOrderPayload(
            SUPPLIER_IBERIA,
            AGREEMENT_IBERIA_MONITOR,
            5,
            '17250',
          ),
          bases: await baseVersions({
            supplierIds: [SUPPLIER_IBERIA],
            sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
            agreementIds: [AGREEMENT_IBERIA_MONITOR],
            productIds: [PRODUCT_MONITOR_27],
            includeInventory: true,
          }),
        }),
      ),
    );

    const messagePayload = (withReceiptFact = false): EnterpriseCommandRequest['payloadTemplate'] => ({
      kind: 'enterprise.send_message',
      recipient: {
        system: 'enterprise',
        type: 'supplier',
        id: SUPPLIER_RHINE,
        version: 4,
      },
      subject: 'F08 simulated procurement update',
      parts: withReceiptFact
        ? [
            {
              kind: 'receipt_fact',
              binding: {
                fromItemId: poOneItem,
                output: 'purchaseOrderId',
              },
              label: 'Purchase order',
            },
          ]
        : [
            { kind: 'text', text: 'The alternative purchase order is prepared.' },
            {
              kind: 'verified_claim',
              claimId: randomUUID(),
              text: 'The supplier was selected from approved agreements.',
            },
          ],
    });
    const messageBases = await baseVersions({ supplierIds: [SUPPLIER_RHINE] });
    const messagePayloadValue = messagePayload();

    const invalidProof = buildCommand({
      kind: 'enterprise.send_message',
      revisionId,
      itemId: randomUUID(),
      planHash,
      payloadTemplate: messagePayloadValue,
      bases: messageBases,
      priorReceiptKeys: [
        receiptKeyFor(
          SANDBOX_ID,
          randomUUID(),
          randomUUID(),
          'enterprise.create_purchase_order',
        ),
      ],
    });
    await expectProblem(await postCommand(invalidProof), 409, 'STALE_STATE');

    const suspendedRecipient = buildCommand({
      kind: 'enterprise.send_message',
      revisionId,
      itemId: randomUUID(),
      planHash,
      payloadTemplate: {
        kind: 'enterprise.send_message',
        recipient: {
          system: 'enterprise',
          type: 'supplier',
          id: '10000000-0000-4000-8000-000000000005',
          version: 5,
        },
        subject: 'Suspended supplier message',
        parts: [{ kind: 'text', text: 'This should not be persisted.' }],
      },
      bases: await baseVersions({
        supplierIds: ['10000000-0000-4000-8000-000000000005'],
      }),
      priorReceiptKeys: [poOne.idempotencyKey, poTwo.idempotencyKey],
    });
    await expectProblem(await postCommand(suspendedRecipient), 409, 'STALE_STATE');

    const receiptFactBody = buildCommand({
      kind: 'enterprise.send_message',
      revisionId,
      itemId: randomUUID(),
      planHash,
      payloadTemplate: messagePayload(true),
      bases: messageBases,
      priorReceiptKeys: [poOne.idempotencyKey, poTwo.idempotencyKey],
    });
    await expectProblem(await postCommand(receiptFactBody), 400, 'VALIDATION_FAILED');

    const messageItem = randomUUID();
    const messageBody = buildCommand({
      kind: 'enterprise.send_message',
      revisionId,
      itemId: messageItem,
      planHash,
      payloadTemplate: messagePayloadValue,
      bases: messageBases,
      priorReceiptKeys: [poOne.idempotencyKey, poTwo.idempotencyKey],
    });
    const messageReceipt = await expectReceipt(await postCommand(messageBody));
    expect(messageReceipt).toMatchObject({
      commandKind: 'enterprise.send_message',
      result: { entityType: 'communication', version: 1 },
      priorReceiptKeys: [poOne.idempotencyKey, poTwo.idempotencyKey].sort(),
    });

    const communication = await dbOne<{
      status: string;
      subject: string;
      recipient_reference: string;
      recipient_version: number;
      version: number;
    }>(
      `SELECT status, subject, recipient_reference, recipient_version, version
       FROM enterprise.communications WHERE sandbox_id = $1 AND id = $2`,
      [SANDBOX_ID, messageReceipt.result.id],
    );
    expect(communication).toEqual({
      status: 'simulated',
      subject: 'F08 simulated procurement update',
      recipient_reference: 'SUP-RHINE',
      recipient_version: 4,
      version: 1,
    });
    const parts = await dbQuery<{ ordinal: number; kind: string }>(
      `SELECT ordinal, kind FROM enterprise.communication_parts
       WHERE sandbox_id = $1 AND communication_id = $2 ORDER BY ordinal`,
      [SANDBOX_ID, messageReceipt.result.id],
    );
    expect(parts).toEqual([
      { ordinal: 0, kind: 'text' },
      { ordinal: 1, kind: 'verified_claim' },
    ]);
    const outbox = await dbOne<{
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      origin_action_revision_id: string;
      origin_item_id: string;
      payload: {
        version: number;
        changedFields: string[];
        entityType: string;
        entityId: string;
      };
    }>(
      `SELECT event_type, aggregate_type, aggregate_id, origin_action_revision_id,
              origin_item_id, payload
       FROM enterprise.event_outbox
       WHERE sandbox_id = $1 AND origin_receipt_id = $2`,
      [SANDBOX_ID, messageReceipt.id],
    );
    expect(outbox).toMatchObject({
      event_type: 'enterprise.communication.created.v1',
      aggregate_type: 'communication',
      aggregate_id: messageReceipt.result.id,
      origin_action_revision_id: revisionId,
      origin_item_id: messageItem,
      payload: {
        entityType: 'communication',
        entityId: messageReceipt.result.id,
        version: 1,
        changedFields: ['created'],
      },
    });

    const replay = buildCommand({
      kind: 'enterprise.send_message',
      revisionId,
      itemId: messageItem,
      planHash,
      payloadTemplate: messagePayloadValue,
      bases: messageBases,
      priorReceiptKeys: [poTwo.idempotencyKey, poOne.idempotencyKey],
      executeBefore: new Date(Date.now() + 20_000).toISOString(),
      authorizationValidUntil: new Date(Date.now() + 25_000).toISOString(),
    });
    expect(await expectReceipt(await postCommand(replay))).toEqual(messageReceipt);
  });

  it('rolls back all command evidence on failure and retries the same key after a lost response', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const body = buildCommand({
      kind: 'enterprise.create_purchase_order',
      revisionId,
      itemId,
      payloadTemplate: createOrderPayload(
        SUPPLIER_BALTIC,
        AGREEMENT_BALTIC_MONITOR,
        5,
        '18500',
        '0',
        '2026-11-07T09:00:00Z',
      ),
      bases: await baseVersions({
        supplierIds: [SUPPLIER_BALTIC],
        sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
        agreementIds: [AGREEMENT_BALTIC_MONITOR],
        productIds: [PRODUCT_MONITOR_27],
        includeInventory: true,
      }),
      executeBefore: new Date(Date.now() + 25_000).toISOString(),
      authorizationValidUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    const before = await dbOne<{
      source_version: number;
      inventory_version: number;
      receipts: number;
      orders: number;
      outbox_events: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
        (SELECT count(*)::int FROM enterprise.purchase_orders) AS orders,
        (SELECT count(*)::int FROM enterprise.event_outbox) AS outbox_events
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27]);

    await migrator.query(`
      CREATE OR REPLACE FUNCTION enterprise.f08_fail_inventory_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'enterprise.inventory.changed.v1' THEN
          RAISE EXCEPTION 'f08 injected outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await migrator.query(`
      CREATE TRIGGER f08_fail_inventory_outbox_trigger
      BEFORE INSERT ON enterprise.event_outbox
      FOR EACH ROW EXECUTE FUNCTION enterprise.f08_fail_inventory_outbox()
    `);
    try {
      const failed = await postCommand(body);
      await expectProblem(failed, 503, 'DEPENDENCY_UNAVAILABLE');
    } finally {
      await migrator.query(
        'DROP TRIGGER IF EXISTS f08_fail_inventory_outbox_trigger ON enterprise.event_outbox',
      );
      await migrator.query(
        'DROP FUNCTION IF EXISTS enterprise.f08_fail_inventory_outbox()',
      );
    }

    const afterFailure = await dbOne<{
      source_version: number;
      inventory_version: number;
      receipts: number;
      orders: number;
      outbox_events: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
        (SELECT count(*)::int FROM enterprise.purchase_orders) AS orders,
        (SELECT count(*)::int FROM enterprise.event_outbox) AS outbox_events
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27]);
    expect(afterFailure).toEqual(before);
    expect(
      await dbQuery(
        'SELECT id FROM enterprise.command_receipts WHERE action_revision_id = $1',
        [revisionId],
      ),
    ).toEqual([]);

    const receipt = await expectReceipt(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId,
          payloadTemplate: body.payloadTemplate,
          bases: body.baseExpectedVersions,
          executeBefore: new Date(Date.now() + 20_000).toISOString(),
          authorizationValidUntil: new Date(Date.now() + 30_000).toISOString(),
        }),
      ),
    );
    const afterRetry = await dbOne<{
      source_version: number;
      inventory_version: number;
      receipts: number;
      orders: number;
      outbox_events: number;
    }>(`
      SELECT
        (SELECT version FROM enterprise.purchase_orders WHERE id = $1) AS source_version,
        (SELECT version FROM enterprise.inventory WHERE product_id = $2) AS inventory_version,
        (SELECT count(*)::int FROM enterprise.command_receipts) AS receipts,
        (SELECT count(*)::int FROM enterprise.purchase_orders) AS orders,
        (SELECT count(*)::int FROM enterprise.event_outbox) AS outbox_events
    `, [SOURCE_PURCHASE_ORDER, PRODUCT_MONITOR_27]);
    expect(afterRetry).toEqual({
      source_version: before.source_version + 1,
      inventory_version: before.inventory_version + 1,
      receipts: before.receipts + 1,
      orders: before.orders + 1,
      outbox_events: before.outbox_events + 1,
    });
    const readBack = await getReceipt(receipt.idempotencyKey);
    expect(await expectReceipt(readBack)).toEqual(receipt);

    const afterLostResponse = await expectReceipt(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId,
          payloadTemplate: body.payloadTemplate,
          bases: body.baseExpectedVersions,
          executeBefore: new Date(Date.now() + 10_000).toISOString(),
          authorizationValidUntil: new Date(Date.now() + 20_000).toISOString(),
        }),
      ),
    );
    expect(afterLostResponse).toEqual(receipt);
    expect(
      await dbOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM enterprise.purchase_orders WHERE id = $1',
        [receipt.result.id],
      ),
    ).toEqual({ count: 1 });
  });

  it('retains receipts, records and read state across a simulator restart', async () => {
    const revisionId = randomUUID();
    const itemId = randomUUID();
    const receipt = await expectReceipt(
      await postCommand(
        buildCommand({
          kind: 'enterprise.create_purchase_order',
          revisionId,
          itemId,
          payloadTemplate: createOrderPayload(
            SUPPLIER_RHINE,
            AGREEMENT_RHINE_MONITOR,
            2,
            '17900',
          ),
          bases: await baseVersions({
            supplierIds: [SUPPLIER_RHINE],
            sourcePurchaseOrderId: SOURCE_PURCHASE_ORDER,
            agreementIds: [AGREEMENT_RHINE_MONITOR],
            productIds: [PRODUCT_MONITOR_27],
            includeInventory: true,
          }),
        }),
      ),
    );

    if (!app) {
      throw new Error('Simulator is not running');
    }
    await stopApp(app);
    app = null;
    appPort = null;
    await startSimulator();

    expect(await expectReceipt(await getReceipt(receipt.idempotencyKey))).toEqual(receipt);
    const order = await readPurchaseOrder(receipt.result.id);
    expect(order.status).toBe(200);
    const orderBody = (await order.json()) as {
      purchaseOrders: Array<{ id: string; version: number }>;
    };
    expect(orderBody.purchaseOrders[0]).toMatchObject({
      id: receipt.result.id,
      version: 1,
    });
    expect(
      await dbOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM enterprise.event_outbox WHERE origin_receipt_id = $1',
        [receipt.id],
      ),
    ).toEqual({ count: 1 });
  });
});

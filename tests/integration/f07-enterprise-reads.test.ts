import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations as applyNexusMigrations,
  loadMigrations as loadNexusMigrations,
} from '@nexus/db/migrate';
import {
  applyMigrations as applyEnterpriseMigrations,
  loadMigrations as loadEnterpriseMigrations,
} from '@nexus/enterprise-db/migrate';
import {
  INITIAL_ENTERPRISE_SANDBOX,
  loadSupplyFixtures,
  seedEnterpriseSupply,
  type EnterpriseSeedSummary,
} from '@nexus/enterprise-db/seed';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const simulatorEntry = path.join(root, 'apps/enterprise-sim/dist/main.js');
const fixturesDirectory = path.join(root, 'fixtures/company');
const fixtureFiles = [
  'products.json',
  'suppliers.json',
  'customers.json',
  'agreements.json',
  'purchase-orders.json',
  'sales-orders.json',
  'inventory.json',
] as const;
const PRODUCT_MONITOR_27 = '20000000-0000-4000-8000-000000000001';
const PRODUCT_MONITOR_32 = '20000000-0000-4000-8000-000000000002';
const PRODUCT_DOCK = '20000000-0000-4000-8000-000000000003';
const PRODUCT_CAMERA = '20000000-0000-4000-8000-000000000009';
const PRODUCT_DESK = '20000000-0000-4000-8000-000000000008';
const PURCHASE_ORDER_DELAYED = '50000000-0000-4000-8000-000000000001';
const SANDBOX_ID = INITIAL_ENTERPRISE_SANDBOX.id;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F07`);
  }
  return value;
}

function databasePort(): number {
  const port = Number(requiredEnv('NEXUS_TEST_PG_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NEXUS_TEST_PG_PORT is not a valid port');
  }
  return port;
}

function databaseClient(user: string, password: string): Client {
  return new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: databasePort(),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f07-enterprise-readers-test',
    connectionTimeoutMillis: 5000,
  });
}

function migratorClient(schema: 'nexus' | 'enterprise'): Client {
  if (schema === 'nexus') {
    return databaseClient(
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    );
  }
  return databaseClient(
    requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_USER'),
    requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD'),
  );
}

async function withClient<T>(
  client: Client,
  operation: (value: Client) => Promise<T>,
): Promise<T> {
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function expectPgError(
  client: Client,
  sql: string,
  code: string,
  parameters: unknown[] = [],
): Promise<void> {
  await expect(client.query(sql, parameters)).rejects.toMatchObject({ code });
}

interface SpawnedApp {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  waitForExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnApp(entry: string, environment: Record<string, string>): SpawnedApp {
  if (!existsSync(entry)) {
    throw new Error(`Missing compiled entry ${entry}; run "pnpm build" before integration tests`);
  }

  const child = spawn(process.execPath, [entry], {
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
    stdout: () => stdout,
    stderr: () => stderr,
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

interface GetOptions {
  token?: string | null;
  sandbox?: string | null;
  correlation?: string | null;
}

function apiUrl(pathname: string): string {
  if (appPort === null) {
    throw new Error('Enterprise simulator is not running');
  }
  return `http://127.0.0.1:${appPort}${pathname}`;
}

async function apiGet(pathname: string, options: GetOptions = {}): Promise<Response> {
  const headers = new Headers();
  const token =
    options.token === undefined ? requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN') : options.token;
  const sandbox = options.sandbox === undefined ? SANDBOX_ID : options.sandbox;
  const correlation =
    options.correlation === undefined ? `f07-${randomUUID()}` : options.correlation;
  if (token !== null) {
    headers.set('authorization', `Bearer ${token}`);
  }
  if (sandbox !== null) {
    headers.set('x-nexus-sandbox-id', sandbox);
  }
  if (correlation !== null) {
    headers.set('x-correlation-id', correlation);
  }
  return fetch(apiUrl(pathname), {
    headers,
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
  const body = (await response.json()) as {
    code?: string;
    message?: string;
    requestId?: string;
  };
  expect(body.code).toBe(code);
  expect(typeof body.requestId).toBe('string');
}

interface PurchaseOrderBody {
  sandboxId: string;
  businessEffectiveAt: string;
  purchaseOrders: Array<{
    id: string;
    reference: string;
    supplierReference: string | null;
    status: string;
    version: number;
    paymentTerms: string;
    deliveryTerms: string;
    supplier: {
      id: string;
      name: string;
      status: string;
      version: number;
    };
    lines: Array<{
      id: string;
      lineNumber: number;
      product: { id: string; status: string };
      orderedQuantity: number;
      receivedQuantity: number;
      unreceivedQuantity: number;
      unitPriceMinor: string;
      version: number;
    }>;
  }>;
}

interface InventoryBody {
  sandboxId: string;
  businessEffectiveAt: string;
  items: Array<{
    product: { id: string; status: string };
    onHandQuantity: number;
    activeReservations: number;
    availableForAllocation: number;
    reservations: Array<{
      id: string;
      status: string;
      quantity: number;
      version: number;
    }>;
    confirmedInbound: Array<{
      purchaseOrderId: string;
      purchaseOrderReference: string;
      purchaseOrderStatus: string;
      unreceivedQuantity: number;
      confirmedArrivalAt: string;
      version: number;
    }>;
    version: number;
  }>;
}

interface AffectedOrdersBody {
  sandboxId: string;
  businessEffectiveAt: string;
  requestedProductIds: string[];
  horizon: { from: string; to: string; days: number };
  orders: Array<{
    id: string;
    reference: string;
    status: string;
    exposedValueMinor: string;
    currency: string;
    contractualPenaltyDailyMinor: string | null;
    contractualPenaltyCapMinor: string | null;
    promisedDeliveryAt: string;
    version: number;
    lines: Array<{
      product: { id: string };
      quantity: number;
      unitPriceMinor: string;
    }>;
  }>;
  truncated: boolean;
}

interface AlternativesBody {
  sandboxId: string;
  businessEffectiveAt: string;
  deadline: string;
  products: Array<{
    product: { id: string; status: string };
    requestedQuantity: number;
    offersTruncated: boolean;
    offers: Array<{
      agreementId: string;
      agreementVersion: number;
      agreementStatus: string;
      currentlyValid: boolean;
      supplier: { id: string; status: string };
      unitPriceMinor: string;
      capacityQuantity: number;
      leadTimeDays: number;
      latestArrivalAt: string;
      validFrom: string;
      validTo: string;
    }>;
  }>;
}

let app: SpawnedApp | null = null;
let secondSeed: EnterpriseSeedSummary | null = null;
let appPort: number | null = null;

beforeAll(async () => {
  await withClient(migratorClient('nexus'), (client) =>
    applyNexusMigrations(client, {
      schema: 'nexus',
      migrations: loadNexusMigrations(path.join(root, 'packages/db/migrations')),
    }),
  );
  await withClient(migratorClient('enterprise'), (client) =>
    applyEnterpriseMigrations(client, {
      schema: 'enterprise',
      migrations: loadEnterpriseMigrations(path.join(root, 'packages/enterprise-db/migrations')),
    }),
  );

  await withClient(migratorClient('enterprise'), async (client) => {
    await seedEnterpriseSupply(client, { fixturesDirectory });
  });
  secondSeed = await withClient(migratorClient('enterprise'), (client) =>
    seedEnterpriseSupply(client, { fixturesDirectory }),
  );

  const spawned = spawnApp(simulatorEntry, {
    PORT: '0',
    ENTERPRISE_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    ENTERPRISE_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    ENTERPRISE_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    ENTERPRISE_APP_DB_USER: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
    ENTERPRISE_APP_DB_PASSWORD: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
    ENTERPRISE_SIM_READ_TOKEN: requiredEnv('NEXUS_TEST_ENTERPRISE_READ_TOKEN'),
  });
  app = spawned;
  const ready = await spawned.waitForOutput(/ENTERPRISE_SIM_READY port=(\d+)/);
  const portText = ready[1];
  if (!portText) {
    throw new Error('Enterprise simulator readiness line did not include a port');
  }
  appPort = Number(portText);
});

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
});

describe('F07 enterprise supply and sales read model', () => {
  it('seeds the exact baseline, shared business clock, coherent links and an idempotent repeat', async () => {
    await withClient(migratorClient('enterprise'), async (client) => {
      const counts = await client.query<{
        products: number;
        suppliers: number;
        customers: number;
        purchase_orders: number;
        sales_orders: number;
        agreements: number;
        inventory: number;
        reservations: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM enterprise.products) AS products,
          (SELECT count(*)::int FROM enterprise.suppliers) AS suppliers,
          (SELECT count(*)::int FROM enterprise.customers) AS customers,
          (SELECT count(*)::int FROM enterprise.purchase_orders) AS purchase_orders,
          (SELECT count(*)::int FROM enterprise.sales_orders) AS sales_orders,
          (SELECT count(*)::int FROM enterprise.agreements) AS agreements,
          (SELECT count(*)::int FROM enterprise.inventory) AS inventory,
          (SELECT count(*)::int FROM enterprise.inventory_reservations) AS reservations
      `);
      expect(counts.rows[0]).toEqual({
        products: 12,
        suppliers: 6,
        customers: 12,
        purchase_orders: 12,
        sales_orders: 24,
        agreements: 24,
        inventory: 12,
        reservations: 12,
      });

      const orphans = await client.query<{ count: number }>(`
        SELECT (
          (SELECT count(*) FROM enterprise.agreements a
            LEFT JOIN enterprise.suppliers s
              ON s.sandbox_id = a.sandbox_id AND s.id = a.supplier_id
            WHERE s.id IS NULL) +
          (SELECT count(*) FROM enterprise.purchase_order_lines l
            LEFT JOIN enterprise.purchase_orders po
              ON po.sandbox_id = l.sandbox_id AND po.id = l.purchase_order_id
            LEFT JOIN enterprise.products p
              ON p.sandbox_id = l.sandbox_id AND p.id = l.product_id
            WHERE po.id IS NULL OR p.id IS NULL) +
          (SELECT count(*) FROM enterprise.sales_order_lines l
            LEFT JOIN enterprise.sales_orders so
              ON so.sandbox_id = l.sandbox_id AND so.id = l.sales_order_id
            LEFT JOIN enterprise.products p
              ON p.sandbox_id = l.sandbox_id AND p.id = l.product_id
            WHERE so.id IS NULL OR p.id IS NULL) +
          (SELECT count(*) FROM enterprise.inventory i
            LEFT JOIN enterprise.products p
              ON p.sandbox_id = i.sandbox_id AND p.id = i.product_id
            WHERE p.id IS NULL)
        )::int AS count
      `);
      expect(orphans.rows[0]?.count).toBe(0);

      const lifecycle = await client.query<{
        delayed_orders: number;
        cancelled_orders: number;
        partial_orders: number;
        discontinued_products: number;
        delivered_sales: number;
        cancelled_sales: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM enterprise.purchase_orders WHERE status = 'delayed') AS delayed_orders,
          (SELECT count(*)::int FROM enterprise.purchase_orders WHERE status = 'cancelled') AS cancelled_orders,
          (SELECT count(*)::int FROM enterprise.purchase_orders WHERE status = 'partially_received') AS partial_orders,
          (SELECT count(*)::int FROM enterprise.products WHERE status = 'discontinued') AS discontinued_products,
          (SELECT count(*)::int FROM enterprise.sales_orders WHERE status = 'delivered') AS delivered_sales,
          (SELECT count(*)::int FROM enterprise.sales_orders WHERE status = 'cancelled') AS cancelled_sales
      `);
      expect(lifecycle.rows[0]).toEqual({
        delayed_orders: 1,
        cancelled_orders: 1,
        partial_orders: 1,
        discontinued_products: 2,
        delivered_sales: 4,
        cancelled_sales: 1,
      });
    });

    await withClient(migratorClient('nexus'), async (client) => {
      const nexusClock = await client.query<{ business_effective_at: Date }>(
        'SELECT business_effective_at FROM nexus.sandboxes WHERE id = $1',
        [SANDBOX_ID],
      );
      expect(nexusClock.rows[0]?.business_effective_at.toISOString()).toBe(
        '2026-11-02T09:00:00.000Z',
      );
    });

    expect(secondSeed?.inserted).toEqual({
      sandboxes: 0,
      suppliers: 0,
      products: 0,
      customers: 0,
      agreements: 0,
      purchaseOrders: 0,
      purchaseOrderLines: 0,
      salesOrders: 0,
      salesOrderLines: 0,
      inventory: 0,
      inventoryReservations: 0,
    });

    const response = await apiGet(
      `/v1/inventory?productIds=${PRODUCT_MONITOR_27}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as InventoryBody;
    expect(body.sandboxId).toBe(SANDBOX_ID);
    expect(body.businessEffectiveAt).toBe('2026-11-02T09:00:00.000Z');
  });

  it('rejects fixture line totals above the storage bound before writing', () => {
    for (const target of ['purchase-orders.json', 'sales-orders.json'] as const) {
      const directory = mkdtempSync(path.join(tmpdir(), 'f07-fixtures-'));
      try {
        for (const file of fixtureFiles) {
          cpSync(path.join(fixturesDirectory, file), path.join(directory, file));
        }
        const filePath = path.join(directory, target);
        const document = JSON.parse(readFileSync(filePath, 'utf8')) as {
          items: Array<{
            lines: Array<{
              orderedQuantity?: number;
              quantity?: number;
              unitPriceMinor: string;
            }>;
          }>;
        };
        const line = document.items[0]?.lines[0];
        if (!line) {
          throw new Error(`Fixture ${target} does not contain a line`);
        }
        if (target === 'purchase-orders.json') {
          line.orderedQuantity = 1_000_000;
        } else {
          line.quantity = 1_000_000;
        }
        line.unitPriceMinor = '1000000000';
        writeFileSync(filePath, JSON.stringify(document), 'utf8');
        expect(() => loadSupplyFixtures(directory)).toThrow(/money bound/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('returns exact purchase-order candidates without resolving an ambiguous reference', async () => {
    const byReference = await apiGet('/v1/purchase-orders/PO-2026-1001');
    expect(byReference.status).toBe(200);
    const byReferenceBody = (await byReference.json()) as PurchaseOrderBody;
    expect(byReferenceBody.purchaseOrders).toHaveLength(1);
    const order = byReferenceBody.purchaseOrders[0];
    expect(order).toMatchObject({
      reference: 'PO-2026-1001',
      supplierReference: 'BC-4417',
      status: 'delayed',
      version: 5,
      paymentTerms: 'Net 30',
      deliveryTerms: 'DAP Rotterdam',
      supplier: { id: '10000000-0000-4000-8000-000000000001', name: 'Baltic Components OU' },
    });
    expect(order?.lines).toHaveLength(2);
    expect(order?.lines[0]).toMatchObject({
      lineNumber: 1,
      orderedQuantity: 120,
      receivedQuantity: 0,
      unreceivedQuantity: 120,
      unitPriceMinor: '18500',
    });
    expect(order?.lines[1]).toMatchObject({
      lineNumber: 2,
      orderedQuantity: 40,
      receivedQuantity: 10,
      unreceivedQuantity: 30,
    });

    const byIdResponse = await apiGet(`/v1/purchase-orders/${PURCHASE_ORDER_DELAYED}`);
    expect(byIdResponse.status).toBe(200);
    const byIdBody = (await byIdResponse.json()) as PurchaseOrderBody;
    expect(byIdBody.purchaseOrders[0]?.reference).toBe('PO-2026-1001');

    const ambiguous = await apiGet('/v1/purchase-orders/BC-4417');
    expect(ambiguous.status).toBe(200);
    const ambiguousBody = (await ambiguous.json()) as PurchaseOrderBody;
    expect(
      ambiguousBody.purchaseOrders.map((candidate) => candidate.reference).sort(),
    ).toEqual(['PO-2026-1001', 'PO-2026-1012']);
    expect(ambiguousBody.purchaseOrders[0]?.id).not.toBe(
      ambiguousBody.purchaseOrders[1]?.id,
    );

    await expectProblem(
      await apiGet('/v1/purchase-orders/PO-2026-9999'),
      404,
      'NOT_FOUND',
    );
  });

  it('joins purchase-order demand to exact sales orders and their contract facts', async () => {
    const response = await apiGet(
      `/v1/affected-orders?purchaseOrderId=${PURCHASE_ORDER_DELAYED}&horizonDays=14`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AffectedOrdersBody;
    expect(body.requestedProductIds.sort()).toEqual([
      PRODUCT_MONITOR_27,
      PRODUCT_DOCK,
    ].sort());
    expect(body.horizon).toEqual({
      from: '2026-11-02T09:00:00.000Z',
      to: '2026-11-16T09:00:00.000Z',
      days: 14,
    });
    expect(body.orders.map((order) => order.reference)).toEqual([
      'SO-2026-2020',
      'SO-2026-2001',
      'SO-2026-2002',
      'SO-2026-2006',
      'SO-2026-2003',
      'SO-2026-2009',
    ]);
    for (const order of body.orders) {
      expect(
        order.lines.some((line) => line.product.id === PRODUCT_MONITOR_27 || line.product.id === PRODUCT_DOCK),
      ).toBe(true);
      expect(new Date(order.promisedDeliveryAt).getTime()).toBeGreaterThanOrEqual(
        Date.parse(body.horizon.from),
      );
      expect(new Date(order.promisedDeliveryAt).getTime()).toBeLessThanOrEqual(
        Date.parse(body.horizon.to),
      );
    }
    const multiLine = body.orders.find((order) => order.reference === 'SO-2026-2003');
    expect(multiLine?.lines).toHaveLength(2);
    expect(multiLine?.exposedValueMinor).toBe('1086500');
    expect(multiLine?.contractualPenaltyDailyMinor).toBeNull();
    expect(multiLine?.contractualPenaltyCapMinor).toBeNull();
    expect(body.truncated).toBe(false);

    const byProduct = await apiGet(
      `/v1/affected-orders?productIds=${PRODUCT_MONITOR_32}&horizonDays=14`,
    );
    expect(byProduct.status).toBe(200);
    const byProductBody = (await byProduct.json()) as AffectedOrdersBody;
    expect(byProductBody.orders.map((order) => order.reference).sort()).toEqual([
      'SO-2026-2004',
      'SO-2026-2021',
    ]);
    expect(
      byProductBody.orders.some((order) => order.reference === 'SO-2026-2008'),
    ).toBe(false);
  });

  it('reports on-hand availability separately from confirmed inbound coverage', async () => {
    const response = await apiGet(
      `/v1/inventory?productIds=${PRODUCT_MONITOR_27},${PRODUCT_MONITOR_32}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as InventoryBody;
    expect(body.items).toHaveLength(2);
    const monitor27 = body.items[0];
    expect(monitor27).toMatchObject({
      onHandQuantity: 55,
      activeReservations: 40,
      availableForAllocation: 15,
      confirmedInboundQuantity: 270,
      reservationsTruncated: false,
      confirmedInboundTruncated: false,
      version: 7,
    });
    expect(monitor27?.reservations.map((row) => [row.status, row.quantity, row.version])).toEqual([
      ['active', 40, 2],
      ['released', 20, 3],
    ]);
    expect(
      monitor27?.confirmedInbound.map((line) => [
        line.purchaseOrderReference,
        line.unreceivedQuantity,
        line.confirmedArrivalAt,
        line.purchaseOrderStatus,
        line.version,
      ]),
    ).toEqual([
      ['PO-2026-1002', 80, '2026-11-04T17:00:00.000Z', 'acknowledged', 2],
      ['PO-2026-1001', 120, '2026-11-06T17:00:00.000Z', 'delayed', 5],
      ['PO-2026-1003', 40, '2026-11-10T17:00:00.000Z', 'open', 1],
      ['PO-2026-1012', 30, '2026-11-17T17:00:00.000Z', 'open', 1],
    ]);
    const inboundTotal = (monitor27?.confirmedInbound ?? []).reduce(
      (sum, line) => sum + line.unreceivedQuantity,
      0,
    );
    expect(inboundTotal).toBe(270);
    expect(monitor27?.availableForAllocation).not.toBe(inboundTotal);

    const monitor32 = body.items[1];
    expect(monitor32).toMatchObject({
      onHandQuantity: 20,
      activeReservations: 5,
      availableForAllocation: 15,
    });
    expect(
      monitor32?.confirmedInbound.map((line) => [
        line.purchaseOrderReference,
        line.unreceivedQuantity,
      ]),
    ).toEqual([['PO-2026-1002', 60]]);
  });

  it('returns supplier price, capacity and versions with feasible and infeasible offers', async () => {
    const response = await apiGet(
      `/v1/alternatives?productIds=${PRODUCT_MONITOR_27}&quantities=40&deadline=2026-11-06T17:00:00Z`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AlternativesBody;
    const product = body.products[0];
    expect(product?.product.status).toBe('active');
    expect(product?.requestedQuantity).toBe(40);
    expect(product?.offersTruncated).toBe(false);
    expect(product?.offers.map((offer) => offer.supplier.id).sort()).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ]);
    const bySupplier = new Map(
      (product?.offers ?? []).map((offer) => [offer.supplier.id, offer]),
    );
    const feasible = bySupplier.get('10000000-0000-4000-8000-000000000002');
    expect(feasible).toMatchObject({
      agreementVersion: 7,
      agreementStatus: 'approved',
      currentlyValid: true,
      unitPriceMinor: '17900',
      capacityQuantity: 90,
      leadTimeDays: 2,
      latestArrivalAt: '2026-11-04T09:00:00.000Z',
    });
    expect((feasible?.latestArrivalAt ?? '') <= body.deadline).toBe(true);
    const late = bySupplier.get('10000000-0000-4000-8000-000000000003');
    expect((late?.latestArrivalAt ?? '') > body.deadline).toBe(true);
    const zeroCapacity = bySupplier.get('10000000-0000-4000-8000-000000000004');
    expect(zeroCapacity?.capacityQuantity).toBe(0);
    expect(
      (product?.offers ?? []).some(
        (offer) => offer.supplier.id === '10000000-0000-4000-8000-000000000005',
      ),
    ).toBe(false);

    const discontinued = await apiGet(
      `/v1/alternatives?productIds=${PRODUCT_CAMERA}&quantities=5&deadline=2026-11-20T17:00:00Z`,
    );
    expect(discontinued.status).toBe(200);
    const discontinuedBody = (await discontinued.json()) as AlternativesBody;
    expect(discontinuedBody.products[0]?.product.status).toBe('discontinued');
    expect(discontinuedBody.products[0]?.offers).toEqual([]);

    const expiredValidity = await apiGet(
      `/v1/alternatives?productIds=${PRODUCT_DESK}&quantities=1&deadline=2026-11-30T17:00:00Z`,
    );
    expect(expiredValidity.status).toBe(200);
    const expiredBody = (await expiredValidity.json()) as AlternativesBody;
    expect(expiredBody.products[0]?.offers).toHaveLength(1);
    expect(expiredBody.products[0]?.offers[0]?.currentlyValid).toBe(false);
  });

  it('rejects bad authentication, sandbox, correlation and bounded request values', async () => {
    await expectProblem(
      await apiGet('/v1/inventory?productIds=' + PRODUCT_MONITOR_27, { token: null }),
      401,
      'UNAUTHENTICATED',
    );
    await expectProblem(
      await apiGet('/v1/inventory?productIds=' + PRODUCT_MONITOR_27, {
        token: 'wrong-read-token-000000000000000000000000',
      }),
      401,
      'UNAUTHENTICATED',
    );
    await expectProblem(
      await apiGet('/v1/inventory?productIds=' + PRODUCT_MONITOR_27, { sandbox: null }),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet('/v1/inventory?productIds=' + PRODUCT_MONITOR_27, {
        sandbox: '00000000-0000-4000-8000-0000000000ff',
      }),
      404,
      'NOT_FOUND',
    );
    await expectProblem(
      await apiGet('/v1/inventory?productIds=' + PRODUCT_MONITOR_27, {
        correlation: null,
      }),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet('/v1/inventory?productIds=not-a-uuid'),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(`/v1/inventory?productIds=${PRODUCT_MONITOR_27},${PRODUCT_MONITOR_27}`),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/affected-orders?productIds=${PRODUCT_MONITOR_27}&horizonDays=-1`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/affected-orders?productIds=${PRODUCT_MONITOR_27}&horizonDays=366`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/affected-orders?purchaseOrderId=${PURCHASE_ORDER_DELAYED}&productIds=${PRODUCT_MONITOR_27}&horizonDays=14`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/alternatives?productIds=${PRODUCT_MONITOR_27}&quantities=-4&deadline=2026-11-06T17:00:00Z`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/alternatives?productIds=${PRODUCT_MONITOR_27}&quantities=1000001&deadline=2026-11-06T17:00:00Z`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/alternatives?productIds=${PRODUCT_MONITOR_27}&quantities=4&deadline=2026-11-06T17:00:00`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/alternatives?productIds=${PRODUCT_MONITOR_27}&quantities=4&deadline=2026-11-01T09:00:00Z`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(
        `/v1/alternatives?productIds=${PRODUCT_MONITOR_27},${PRODUCT_MONITOR_32}&quantities=4&deadline=2026-11-06T17:00:00Z`,
      ),
      400,
      'VALIDATION_FAILED',
    );
    await expectProblem(
      await apiGet(`/v1/inventory?productIds=${randomUUID()}`),
      404,
      'NOT_FOUND',
    );
    await expectProblem(await apiGet('/v1/not-a-route'), 404, 'NOT_FOUND');
  });

  it('keeps enterprise supply tables unreadable to nexus runtime roles and read-only to the simulator role', async () => {
    for (const [user, password] of [
      ['NEXUS_TEST_NEXUS_API_USER', 'NEXUS_TEST_NEXUS_API_PASSWORD'],
      ['NEXUS_TEST_NEXUS_WORKER_USER', 'NEXUS_TEST_NEXUS_WORKER_PASSWORD'],
    ] as const) {
      await withClient(
        databaseClient(requiredEnv(user), requiredEnv(password)),
        async (client) => {
          await expectPgError(
            client,
            'SELECT 1 FROM enterprise.suppliers LIMIT 1',
            '42501',
          );
        },
      );
    }

    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
        requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
      ),
      async (client) => {
        const count = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM enterprise.suppliers',
        );
        expect(count.rows[0]?.count).toBe(6);
        await expectPgError(
          client,
          `INSERT INTO enterprise.suppliers
             (id, sandbox_id, reference, name, status, currency, version, created_at, updated_at)
           VALUES ($1, $2, 'SUP-FORBIDDEN', 'Forbidden Supplier', 'active', 'EUR', 0, now(), now())`,
          '42501',
          [randomUUID(), SANDBOX_ID],
        );
        await expectPgError(
          client,
          'UPDATE enterprise.suppliers SET name = name WHERE sandbox_id = $1',
          '42501',
          [SANDBOX_ID],
        );
        await expectPgError(
          client,
          'DELETE FROM enterprise.suppliers WHERE sandbox_id = $1',
          '42501',
          [SANDBOX_ID],
        );
      },
    );

    await withClient(migratorClient('enterprise'), async (client) => {
      await expectPgError(
        client,
        `INSERT INTO enterprise.purchase_order_lines
           (id, sandbox_id, purchase_order_id, line_number, product_id, ordered_quantity,
            received_quantity, unit_price_minor, currency, confirmed_arrival_at, version,
            created_at, updated_at)
         VALUES ($1, $2, $3, 99, $4, -1, 0, 100, 'EUR', now(), 0, now(), now())`,
        '23514',
        [randomUUID(), SANDBOX_ID, PURCHASE_ORDER_DELAYED, PRODUCT_MONITOR_27],
      );
      await expectPgError(
        client,
        `INSERT INTO enterprise.purchase_order_lines
           (id, sandbox_id, purchase_order_id, line_number, product_id, ordered_quantity,
            received_quantity, unit_price_minor, currency, confirmed_arrival_at, version,
            created_at, updated_at)
         VALUES ($1, $2, $3, 99, $4, 1, 0, 1000000000001, 'EUR', now(), 0, now(), now())`,
        '23514',
        [randomUUID(), SANDBOX_ID, PURCHASE_ORDER_DELAYED, PRODUCT_MONITOR_27],
      );
      await expectPgError(
        client,
        `INSERT INTO enterprise.sales_order_lines
           (id, sandbox_id, sales_order_id, line_number, product_id, quantity,
            unit_price_minor, currency, version, created_at, updated_at)
         VALUES ($1, $2, $3, 99, $4, 2, 1000000000000, 'EUR', 0, now(), now())`,
        '23514',
        [
          randomUUID(),
          SANDBOX_ID,
          '60000000-0000-4000-8000-000000000001',
          PRODUCT_MONITOR_27,
        ],
      );
    });
  });
});

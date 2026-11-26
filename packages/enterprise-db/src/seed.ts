import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client, PoolClient } from 'pg';
import { z } from 'zod';

const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const IsoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const MoneyMinor = z.string().regex(/^(?:0|[1-9]\d{0,11}|1000000000000)$/);
const MONEY_CEILING = 1000000000000n;
const Quantity = z.number().int().min(0).max(1_000_000);
const PositiveQuantity = z.number().int().min(1).max(1_000_000);
const Version = z.number().int().min(0).max(2_147_483_647);

const SupplierSchema = z
  .object({
    id: Uuid,
    reference: Identifier,
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'inactive', 'suspended']),
    currency: z.literal('EUR'),
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict();

const ProductSchema = z
  .object({
    id: Uuid,
    sku: Identifier,
    name: z.string().min(1).max(200),
    category: z.string().min(1).max(100),
    status: z.enum(['active', 'discontinued']),
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict();

const CustomerSchema = z
  .object({
    id: Uuid,
    reference: Identifier,
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'inactive']),
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict();

const AgreementSchema = z
  .object({
    id: Uuid,
    reference: Identifier,
    supplierId: Uuid,
    productId: Uuid,
    status: z.enum(['pending', 'approved', 'expired', 'revoked']),
    unitPriceMinor: MoneyMinor,
    currency: z.literal('EUR'),
    capacityQuantity: Quantity,
    leadTimeDays: z.number().int().min(0).max(365),
    validFrom: IsoUtc,
    validTo: IsoUtc,
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict()
  .refine((value) => Date.parse(value.validTo) >= Date.parse(value.validFrom), {
    message: 'validTo must not precede validFrom',
    path: ['validTo'],
  });

const PurchaseOrderLineSchema = z
  .object({
    id: Uuid,
    lineNumber: z.number().int().min(1).max(999),
    productId: Uuid,
    orderedQuantity: PositiveQuantity,
    receivedQuantity: Quantity,
    unitPriceMinor: MoneyMinor,
    currency: z.literal('EUR'),
    confirmedArrivalAt: IsoUtc,
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict()
  .refine((value) => value.receivedQuantity <= value.orderedQuantity, {
    message: 'receivedQuantity must not exceed orderedQuantity',
    path: ['receivedQuantity'],
  })
  .refine(
    (value) =>
      BigInt(value.orderedQuantity) * BigInt(value.unitPriceMinor) <= MONEY_CEILING,
    {
      message: 'orderedQuantity * unitPriceMinor must not exceed the money bound',
      path: ['unitPriceMinor'],
    },
  );

const PurchaseOrderSchema = z
  .object({
    id: Uuid,
    reference: Identifier,
    supplierReference: Identifier.nullable(),
    supplierId: Uuid,
    status: z.enum([
      'open',
      'acknowledged',
      'delayed',
      'partially_received',
      'received',
      'cancelled',
    ]),
    paymentTerms: z.string().min(1).max(200),
    deliveryTerms: z.string().min(1).max(200),
    orderedAt: IsoUtc,
    expectedAt: IsoUtc,
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
    lines: z.array(PurchaseOrderLineSchema).min(1).max(100),
  })
  .strict();

const SalesOrderLineSchema = z
  .object({
    id: Uuid,
    lineNumber: z.number().int().min(1).max(999),
    productId: Uuid,
    quantity: PositiveQuantity,
    unitPriceMinor: MoneyMinor,
    currency: z.literal('EUR'),
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict()
  .refine(
    (value) => BigInt(value.quantity) * BigInt(value.unitPriceMinor) <= MONEY_CEILING,
    {
      message: 'quantity * unitPriceMinor must not exceed the money bound',
      path: ['unitPriceMinor'],
    },
  );

const SalesOrderSchema = z
  .object({
    id: Uuid,
    reference: Identifier,
    customerId: Uuid,
    status: z.enum(['confirmed', 'allocated', 'shipped', 'delivered', 'cancelled']),
    currency: z.literal('EUR'),
    orderedAt: IsoUtc,
    promisedDeliveryAt: IsoUtc,
    shippedAt: IsoUtc.nullable(),
    deliveredAt: IsoUtc.nullable(),
    contractualPenaltyDailyMinor: MoneyMinor.nullable(),
    contractualPenaltyCapMinor: MoneyMinor.nullable(),
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
    lines: z.array(SalesOrderLineSchema).min(1).max(100),
  })
  .strict();

const InventorySchema = z
  .object({
    id: Uuid,
    productId: Uuid,
    onHandQuantity: Quantity,
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict();

const ReservationSchema = z
  .object({
    id: Uuid,
    productId: Uuid,
    salesOrderId: Uuid.nullable(),
    status: z.enum(['active', 'released', 'fulfilled']),
    quantity: PositiveQuantity,
    version: Version,
    createdAt: IsoUtc,
    updatedAt: IsoUtc,
  })
  .strict();

const VersionedFileSchema = z.object({ version: z.literal(1) }).strict();

function fileSchema<T extends z.ZodType>(items: T) {
  return VersionedFileSchema.extend({ items: z.array(items).min(1) }).strict();
}

const InventoryFileSchema = VersionedFileSchema.extend({
  items: z.array(InventorySchema).min(1),
  reservations: z.array(ReservationSchema).min(1),
}).strict();

export interface SupplyFixtures {
  readonly suppliers: readonly z.infer<typeof SupplierSchema>[];
  readonly products: readonly z.infer<typeof ProductSchema>[];
  readonly customers: readonly z.infer<typeof CustomerSchema>[];
  readonly agreements: readonly z.infer<typeof AgreementSchema>[];
  readonly purchaseOrders: readonly z.infer<typeof PurchaseOrderSchema>[];
  readonly salesOrders: readonly z.infer<typeof SalesOrderSchema>[];
  readonly inventory: readonly z.infer<typeof InventorySchema>[];
  readonly reservations: readonly z.infer<typeof ReservationSchema>[];
}

export const INITIAL_ENTERPRISE_SANDBOX = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Initial sandbox',
  businessEffectiveAt: '2026-11-02T09:00:00Z',
} as const;

const EXPECTED_COUNTS = {
  products: 12,
  suppliers: 6,
  customers: 12,
  purchaseOrders: 12,
  salesOrders: 24,
  agreements: 24,
  inventory: 12,
  reservations: 12,
} as const;

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function parseFile<T extends z.ZodType>(schema: T, filePath: string): z.infer<T> {
  const parsed = schema.safeParse(readJson(filePath));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid company fixture ${path.basename(filePath)}: ${issues}`);
  }
  return parsed.data;
}

function requireUnique(
  values: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} in company fixtures: ${value}`);
    }
    seen.add(value);
  }
}

function requirePresent<T>(
  map: ReadonlyMap<string, T>,
  id: string,
  label: string,
): T {
  const value = map.get(id);
  if (!value) {
    throw new Error(`Company fixture references unknown ${label}: ${id}`);
  }
  return value;
}

function validateFixtureGraph(fixtures: SupplyFixtures): void {
  if (fixtures.products.length !== EXPECTED_COUNTS.products) {
    throw new Error(`Expected ${EXPECTED_COUNTS.products} products in the company fixtures`);
  }
  if (fixtures.suppliers.length !== EXPECTED_COUNTS.suppliers) {
    throw new Error(`Expected ${EXPECTED_COUNTS.suppliers} suppliers in the company fixtures`);
  }
  if (fixtures.customers.length !== EXPECTED_COUNTS.customers) {
    throw new Error(`Expected ${EXPECTED_COUNTS.customers} customers in the company fixtures`);
  }
  if (fixtures.purchaseOrders.length !== EXPECTED_COUNTS.purchaseOrders) {
    throw new Error(`Expected ${EXPECTED_COUNTS.purchaseOrders} purchase orders in the company fixtures`);
  }
  if (fixtures.salesOrders.length !== EXPECTED_COUNTS.salesOrders) {
    throw new Error(`Expected ${EXPECTED_COUNTS.salesOrders} sales orders in the company fixtures`);
  }
  if (fixtures.agreements.length !== EXPECTED_COUNTS.agreements) {
    throw new Error(`Expected ${EXPECTED_COUNTS.agreements} agreements in the company fixtures`);
  }
  if (fixtures.inventory.length !== EXPECTED_COUNTS.inventory) {
    throw new Error(`Expected ${EXPECTED_COUNTS.inventory} inventory rows in the company fixtures`);
  }
  if (fixtures.reservations.length !== EXPECTED_COUNTS.reservations) {
    throw new Error(`Expected ${EXPECTED_COUNTS.reservations} reservations in the company fixtures`);
  }

  requireUnique(fixtures.suppliers.map((row) => row.id), 'supplier id');
  requireUnique(fixtures.suppliers.map((row) => row.reference), 'supplier reference');
  requireUnique(fixtures.products.map((row) => row.id), 'product id');
  requireUnique(fixtures.products.map((row) => row.sku), 'product SKU');
  requireUnique(fixtures.customers.map((row) => row.id), 'customer id');
  requireUnique(fixtures.customers.map((row) => row.reference), 'customer reference');
  requireUnique(fixtures.agreements.map((row) => row.id), 'agreement id');
  requireUnique(fixtures.agreements.map((row) => row.reference), 'agreement reference');
  requireUnique(fixtures.purchaseOrders.map((row) => row.id), 'purchase order id');
  requireUnique(fixtures.purchaseOrders.map((row) => row.reference), 'purchase order reference');
  requireUnique(fixtures.salesOrders.map((row) => row.id), 'sales order id');
  requireUnique(fixtures.salesOrders.map((row) => row.reference), 'sales order reference');
  requireUnique(fixtures.inventory.map((row) => row.id), 'inventory id');
  requireUnique(fixtures.inventory.map((row) => row.productId), 'inventory product');
  requireUnique(fixtures.reservations.map((row) => row.id), 'reservation id');

  const suppliers = new Map(fixtures.suppliers.map((row) => [row.id, row]));
  const products = new Map(fixtures.products.map((row) => [row.id, row]));
  const customers = new Map(fixtures.customers.map((row) => [row.id, row]));
  const salesOrders = new Map(fixtures.salesOrders.map((row) => [row.id, row]));
  const inventoryByProduct = new Map(
    fixtures.inventory.map((row) => [row.productId, row]),
  );

  const agreementPairs = new Set<string>();
  for (const agreement of fixtures.agreements) {
    requirePresent(suppliers, agreement.supplierId, 'supplier');
    requirePresent(products, agreement.productId, 'product');
    const pair = `${agreement.supplierId}:${agreement.productId}`;
    if (agreementPairs.has(pair)) {
      throw new Error(`Duplicate supplier/product agreement in company fixtures: ${pair}`);
    }
    agreementPairs.add(pair);
  }

  const purchaseOrderLineIds = new Set<string>();
  for (const purchaseOrder of fixtures.purchaseOrders) {
    requirePresent(suppliers, purchaseOrder.supplierId, 'supplier');
    requireUnique(
      purchaseOrder.lines.map((line) => String(line.lineNumber)),
      `purchase order ${purchaseOrder.reference} line number`,
    );
    for (const line of purchaseOrder.lines) {
      requirePresent(products, line.productId, 'product');
      if (purchaseOrderLineIds.has(line.id)) {
        throw new Error(`Duplicate purchase order line id: ${line.id}`);
      }
      purchaseOrderLineIds.add(line.id);
    }
    if (
      purchaseOrder.status === 'received' &&
      purchaseOrder.lines.some((line) => line.receivedQuantity !== line.orderedQuantity)
    ) {
      throw new Error(`Received purchase order ${purchaseOrder.reference} has an unreceived line`);
    }
    if (
      purchaseOrder.status === 'partially_received' &&
      (purchaseOrder.lines.every((line) => line.receivedQuantity === 0) ||
        purchaseOrder.lines.every(
          (line) => line.receivedQuantity === line.orderedQuantity,
        ))
    ) {
      throw new Error(
        `Partially received purchase order ${purchaseOrder.reference} has no partial line`,
      );
    }
    if (
      purchaseOrder.status === 'cancelled' &&
      purchaseOrder.lines.some((line) => line.receivedQuantity > 0)
    ) {
      throw new Error(`Cancelled purchase order ${purchaseOrder.reference} has received stock`);
    }
  }

  const salesOrderLineIds = new Set<string>();
  for (const salesOrder of fixtures.salesOrders) {
    requirePresent(customers, salesOrder.customerId, 'customer');
    requireUnique(
      salesOrder.lines.map((line) => String(line.lineNumber)),
      `sales order ${salesOrder.reference} line number`,
    );
    for (const line of salesOrder.lines) {
      requirePresent(products, line.productId, 'product');
      if (salesOrderLineIds.has(line.id)) {
        throw new Error(`Duplicate sales order line id: ${line.id}`);
      }
      salesOrderLineIds.add(line.id);
    }
    if ((salesOrder.status === 'delivered') !== (salesOrder.deliveredAt !== null)) {
      throw new Error(`Sales order ${salesOrder.reference} delivery timestamp does not match its status`);
    }
    if (
      (salesOrder.status === 'shipped' || salesOrder.status === 'delivered') &&
      salesOrder.shippedAt === null
    ) {
      throw new Error(`Sales order ${salesOrder.reference} is shipped without a shipped timestamp`);
    }
    if (
      (salesOrder.status === 'confirmed' || salesOrder.status === 'allocated') &&
      (salesOrder.shippedAt !== null || salesOrder.deliveredAt !== null)
    ) {
      throw new Error(`Unshipped sales order ${salesOrder.reference} has shipment timestamps`);
    }
  }

  const activeReservations = new Map<string, number>();
  for (const reservation of fixtures.reservations) {
    requirePresent(products, reservation.productId, 'product');
    if (reservation.salesOrderId !== null) {
      requirePresent(salesOrders, reservation.salesOrderId, 'sales order');
    }
    if (reservation.status === 'active') {
      activeReservations.set(
        reservation.productId,
        (activeReservations.get(reservation.productId) ?? 0) + reservation.quantity,
      );
    }
  }
  for (const product of fixtures.products) {
    const inventory = inventoryByProduct.get(product.id);
    if (!inventory) {
      throw new Error(`Product ${product.sku} has no inventory row`);
    }
    const reserved = activeReservations.get(product.id) ?? 0;
    if (reserved > inventory.onHandQuantity) {
      throw new Error(
        `Active reservations for product ${product.sku} exceed on-hand quantity`,
      );
    }
  }
  if (inventoryByProduct.size !== fixtures.inventory.length) {
    throw new Error('Inventory rows do not cover exactly one row per product');
  }
}

export function loadSupplyFixtures(directory: string): SupplyFixtures {
  const products = parseFile(
    fileSchema(ProductSchema),
    path.join(directory, 'products.json'),
  );
  const suppliers = parseFile(
    fileSchema(SupplierSchema),
    path.join(directory, 'suppliers.json'),
  );
  const customers = parseFile(
    fileSchema(CustomerSchema),
    path.join(directory, 'customers.json'),
  );
  const agreements = parseFile(
    fileSchema(AgreementSchema),
    path.join(directory, 'agreements.json'),
  );
  const purchaseOrders = parseFile(
    fileSchema(PurchaseOrderSchema),
    path.join(directory, 'purchase-orders.json'),
  );
  const salesOrders = parseFile(
    fileSchema(SalesOrderSchema),
    path.join(directory, 'sales-orders.json'),
  );
  const inventory = parseFile(
    InventoryFileSchema,
    path.join(directory, 'inventory.json'),
  );

  const fixtures: SupplyFixtures = {
    products: products.items,
    suppliers: suppliers.items,
    customers: customers.items,
    agreements: agreements.items,
    purchaseOrders: purchaseOrders.items,
    salesOrders: salesOrders.items,
    inventory: inventory.items,
    reservations: inventory.reservations,
  };
  validateFixtureGraph(fixtures);
  return fixtures;
}

export interface EnterpriseSeedSummary {
  readonly sandboxId: string;
  readonly inserted: Readonly<Record<string, number>>;
}

export interface EnterpriseSeedOptions {
  readonly fixturesDirectory: string;
}

type SeedClient = Client | PoolClient;

function insertedCount(result: { rowCount: number | null }): number {
  return result.rowCount ?? 0;
}

async function insertSandbox(client: SeedClient): Promise<number> {
  const result = await client.query(
    `INSERT INTO enterprise.sandboxes
       (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, 0, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [
      INITIAL_ENTERPRISE_SANDBOX.id,
      INITIAL_ENTERPRISE_SANDBOX.name,
      INITIAL_ENTERPRISE_SANDBOX.businessEffectiveAt,
    ],
  );
  return insertedCount(result);
}

async function verifySandboxClock(client: SeedClient): Promise<void> {
  const result = await client.query<{ business_effective_at: Date }>(
    'SELECT business_effective_at FROM enterprise.sandboxes WHERE id = $1',
    [INITIAL_ENTERPRISE_SANDBOX.id],
  );
  const value = result.rows[0]?.business_effective_at;
  if (!(value instanceof Date)) {
    throw new Error('Enterprise sandbox seed row is missing');
  }
  if (value.getTime() !== Date.parse(INITIAL_ENTERPRISE_SANDBOX.businessEffectiveAt)) {
    throw new Error(
      'Enterprise sandbox business clock does not match the accepted scenario clock',
    );
  }
}

async function insertRows(
  client: SeedClient,
  sql: string,
  rows: readonly unknown[][],
): Promise<number> {
  let inserted = 0;
  for (const values of rows) {
    inserted += insertedCount(await client.query(sql, values));
  }
  return inserted;
}

export async function seedEnterpriseSupply(
  client: SeedClient,
  options: EnterpriseSeedOptions,
): Promise<EnterpriseSeedSummary> {
  const fixtures = loadSupplyFixtures(options.fixturesDirectory);
  const sandboxId = INITIAL_ENTERPRISE_SANDBOX.id;

  await client.query('BEGIN');
  try {
    const sandboxInserted = await insertSandbox(client);
    await verifySandboxClock(client);

    const supplierInserted = await insertRows(
      client,
      `INSERT INTO enterprise.suppliers
         (id, sandbox_id, reference, name, status, currency, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.suppliers.map((row) => [
        row.id,
        sandboxId,
        row.reference,
        row.name,
        row.status,
        row.currency,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const productInserted = await insertRows(
      client,
      `INSERT INTO enterprise.products
         (id, sandbox_id, sku, name, category, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.products.map((row) => [
        row.id,
        sandboxId,
        row.sku,
        row.name,
        row.category,
        row.status,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const customerInserted = await insertRows(
      client,
      `INSERT INTO enterprise.customers
         (id, sandbox_id, reference, name, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.customers.map((row) => [
        row.id,
        sandboxId,
        row.reference,
        row.name,
        row.status,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const agreementInserted = await insertRows(
      client,
      `INSERT INTO enterprise.agreements
         (id, sandbox_id, reference, supplier_id, product_id, status, unit_price_minor,
          currency, capacity_quantity, lead_time_days, valid_from, valid_to, version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.agreements.map((row) => [
        row.id,
        sandboxId,
        row.reference,
        row.supplierId,
        row.productId,
        row.status,
        row.unitPriceMinor,
        row.currency,
        row.capacityQuantity,
        row.leadTimeDays,
        row.validFrom,
        row.validTo,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const purchaseOrderInserted = await insertRows(
      client,
      `INSERT INTO enterprise.purchase_orders
         (id, sandbox_id, reference, supplier_reference, supplier_id, status, payment_terms,
          delivery_terms, ordered_at, expected_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.purchaseOrders.map((row) => [
        row.id,
        sandboxId,
        row.reference,
        row.supplierReference,
        row.supplierId,
        row.status,
        row.paymentTerms,
        row.deliveryTerms,
        row.orderedAt,
        row.expectedAt,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const purchaseOrderLines = fixtures.purchaseOrders.flatMap((row) =>
      row.lines.map((line) => ({ purchaseOrderId: row.id, line }))
    );
    const purchaseOrderLineInserted = await insertRows(
      client,
      `INSERT INTO enterprise.purchase_order_lines
         (id, sandbox_id, purchase_order_id, line_number, product_id, ordered_quantity,
          received_quantity, unit_price_minor, currency, confirmed_arrival_at, version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      purchaseOrderLines.map(({ purchaseOrderId, line }) => [
        line.id,
        sandboxId,
        purchaseOrderId,
        line.lineNumber,
        line.productId,
        line.orderedQuantity,
        line.receivedQuantity,
        line.unitPriceMinor,
        line.currency,
        line.confirmedArrivalAt,
        line.version,
        line.createdAt,
        line.updatedAt,
      ]),
    );

    const salesOrderInserted = await insertRows(
      client,
      `INSERT INTO enterprise.sales_orders
         (id, sandbox_id, reference, customer_id, status, currency, ordered_at,
          promised_delivery_at, shipped_at, delivered_at, contractual_penalty_daily_minor,
          contractual_penalty_cap_minor, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.salesOrders.map((row) => [
        row.id,
        sandboxId,
        row.reference,
        row.customerId,
        row.status,
        row.currency,
        row.orderedAt,
        row.promisedDeliveryAt,
        row.shippedAt,
        row.deliveredAt,
        row.contractualPenaltyDailyMinor,
        row.contractualPenaltyCapMinor,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const salesOrderLines = fixtures.salesOrders.flatMap((row) =>
      row.lines.map((line) => ({ salesOrderId: row.id, line }))
    );
    const salesOrderLineInserted = await insertRows(
      client,
      `INSERT INTO enterprise.sales_order_lines
         (id, sandbox_id, sales_order_id, line_number, product_id, quantity,
          unit_price_minor, currency, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      salesOrderLines.map(({ salesOrderId, line }) => [
        line.id,
        sandboxId,
        salesOrderId,
        line.lineNumber,
        line.productId,
        line.quantity,
        line.unitPriceMinor,
        line.currency,
        line.version,
        line.createdAt,
        line.updatedAt,
      ]),
    );

    const inventoryInserted = await insertRows(
      client,
      `INSERT INTO enterprise.inventory
         (id, sandbox_id, product_id, on_hand_quantity, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.inventory.map((row) => [
        row.id,
        sandboxId,
        row.productId,
        row.onHandQuantity,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    const reservationInserted = await insertRows(
      client,
      `INSERT INTO enterprise.inventory_reservations
         (id, sandbox_id, product_id, sales_order_id, status, quantity, version,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sandbox_id, id) DO NOTHING`,
      fixtures.reservations.map((row) => [
        row.id,
        sandboxId,
        row.productId,
        row.salesOrderId,
        row.status,
        row.quantity,
        row.version,
        row.createdAt,
        row.updatedAt,
      ]),
    );

    await client.query('COMMIT');
    return {
      sandboxId,
      inserted: {
        sandboxes: sandboxInserted,
        suppliers: supplierInserted,
        products: productInserted,
        customers: customerInserted,
        agreements: agreementInserted,
        purchaseOrders: purchaseOrderInserted,
        purchaseOrderLines: purchaseOrderLineInserted,
        salesOrders: salesOrderInserted,
        salesOrderLines: salesOrderLineInserted,
        inventory: inventoryInserted,
        inventoryReservations: reservationInserted,
      },
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original seed failure remains the actionable error.
    }
    throw error;
  }
}

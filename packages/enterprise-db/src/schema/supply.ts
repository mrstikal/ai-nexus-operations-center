import { sql } from 'drizzle-orm/sql';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const enterpriseSchema = pgSchema('enterprise');

const identifierPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
const moneyCeiling = 1000000000000;
const quantityCeiling = 1000000;

export const sandboxes = enterpriseSchema.table(
  'sandboxes',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    businessEffectiveAt: timestamp('business_effective_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('sandboxes_status_check', sql`${table.status} IN ('active', 'retired')`),
    check('sandboxes_version_check', sql`${table.version} >= 0`),
  ],
);

export const suppliers = enterpriseSchema.table(
  'suppliers',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    reference: text('reference').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    currency: text('currency').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('suppliers_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('suppliers_sandbox_id_reference_key').on(table.sandboxId, table.reference),
    check('suppliers_reference_check', sql`${table.reference} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check('suppliers_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check('suppliers_status_check', sql`${table.status} IN ('active', 'inactive', 'suspended')`),
    check('suppliers_currency_check', sql`${table.currency} = 'EUR'`),
    check('suppliers_version_check', sql`${table.version} >= 0`),
  ],
);

export const products = enterpriseSchema.table(
  'products',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('products_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('products_sandbox_id_sku_key').on(table.sandboxId, table.sku),
    check('products_sku_check', sql`${table.sku} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check('products_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check('products_category_check', sql`char_length(${table.category}) BETWEEN 1 AND 100`),
    check('products_status_check', sql`${table.status} IN ('active', 'discontinued')`),
    check('products_version_check', sql`${table.version} >= 0`),
  ],
);

export const customers = enterpriseSchema.table(
  'customers',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    reference: text('reference').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('customers_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('customers_sandbox_id_reference_key').on(table.sandboxId, table.reference),
    check('customers_reference_check', sql`${table.reference} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check('customers_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check('customers_status_check', sql`${table.status} IN ('active', 'inactive')`),
    check('customers_version_check', sql`${table.version} >= 0`),
  ],
);

export const agreements = enterpriseSchema.table(
  'agreements',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    reference: text('reference').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    productId: uuid('product_id').notNull(),
    status: text('status').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    capacityQuantity: integer('capacity_quantity').notNull(),
    leadTimeDays: integer('lead_time_days').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('agreements_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('agreements_sandbox_id_reference_key').on(table.sandboxId, table.reference),
    uniqueIndex('agreements_sandbox_supplier_product_key').on(
      table.sandboxId,
      table.supplierId,
      table.productId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.supplierId],
      foreignColumns: [suppliers.sandboxId, suppliers.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.productId],
      foreignColumns: [products.sandboxId, products.id],
    }),
    check('agreements_reference_check', sql`${table.reference} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check('agreements_status_check', sql`${table.status} IN ('pending', 'approved', 'expired', 'revoked')`),
    check(
      'agreements_unit_price_check',
      sql`${table.unitPriceMinor} >= 0 AND ${table.unitPriceMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check('agreements_currency_check', sql`${table.currency} = 'EUR'`),
    check(
      'agreements_capacity_check',
      sql`${table.capacityQuantity} >= 0 AND ${table.capacityQuantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check(
      'agreements_lead_time_check',
      sql`${table.leadTimeDays} >= 0 AND ${table.leadTimeDays} <= 365`,
    ),
    check('agreements_validity_check', sql`${table.validTo} >= ${table.validFrom}`),
    check('agreements_version_check', sql`${table.version} >= 0`),
  ],
);

export const purchaseOrders = enterpriseSchema.table(
  'purchase_orders',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    reference: text('reference').notNull(),
    supplierReference: text('supplier_reference'),
    supplierId: uuid('supplier_id').notNull(),
    sourcePurchaseOrderId: uuid('source_purchase_order_id').references(
      (): AnyPgColumn => purchaseOrders.id,
    ),
    expediteChargeMinor: bigint('expedite_charge_minor', { mode: 'bigint' }).notNull(),
    status: text('status').notNull(),
    paymentTerms: text('payment_terms').notNull(),
    deliveryTerms: text('delivery_terms').notNull(),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
    expectedAt: timestamp('expected_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('purchase_orders_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('purchase_orders_sandbox_id_reference_key').on(table.sandboxId, table.reference),
    index('purchase_orders_sandbox_source_idx').on(
      table.sandboxId,
      table.sourcePurchaseOrderId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.supplierId],
      foreignColumns: [suppliers.sandboxId, suppliers.id],
    }),
    check('purchase_orders_reference_check', sql`${table.reference} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check(
      'purchase_orders_supplier_reference_check',
      sql`${table.supplierReference} IS NULL OR ${table.supplierReference} ~ ${sql.raw(`'${identifierPattern}'`)}`,
    ),
    check(
      'purchase_orders_status_check',
      sql`${table.status} IN ('open', 'acknowledged', 'delayed', 'partially_received', 'received', 'cancelled')`,
    ),
    check('purchase_orders_payment_terms_check', sql`char_length(${table.paymentTerms}) BETWEEN 1 AND 200`),
    check('purchase_orders_delivery_terms_check', sql`char_length(${table.deliveryTerms}) BETWEEN 1 AND 200`),
    check(
      'purchase_orders_expedite_charge_check',
      sql`${table.expediteChargeMinor} >= 0 AND ${table.expediteChargeMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check(
      'purchase_orders_source_not_self_check',
      sql`${table.sourcePurchaseOrderId} IS NULL OR ${table.sourcePurchaseOrderId} <> ${table.id}`,
    ),
    check('purchase_orders_version_check', sql`${table.version} >= 0`),
  ],
);

export const purchaseOrderLines = enterpriseSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').notNull(),
    agreementId: uuid('agreement_id'),
    orderedQuantity: integer('ordered_quantity').notNull(),
    receivedQuantity: integer('received_quantity').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    confirmedArrivalAt: timestamp('confirmed_arrival_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('purchase_order_lines_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('purchase_order_lines_sandbox_order_line_key').on(
      table.sandboxId,
      table.purchaseOrderId,
      table.lineNumber,
    ),
    foreignKey({
      columns: [table.sandboxId, table.purchaseOrderId],
      foreignColumns: [purchaseOrders.sandboxId, purchaseOrders.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.productId],
      foreignColumns: [products.sandboxId, products.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.agreementId],
      foreignColumns: [agreements.sandboxId, agreements.id],
    }),
    index('purchase_order_lines_sandbox_agreement_idx').on(
      table.sandboxId,
      table.agreementId,
    ),
    check('purchase_order_lines_line_number_check', sql`${table.lineNumber} >= 1 AND ${table.lineNumber} <= 999`),
    check(
      'purchase_order_lines_ordered_quantity_check',
      sql`${table.orderedQuantity} >= 1 AND ${table.orderedQuantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check(
      'purchase_order_lines_received_quantity_check',
      sql`${table.receivedQuantity} >= 0 AND ${table.receivedQuantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check(
      'purchase_order_lines_received_not_over_ordered_check',
      sql`${table.receivedQuantity} <= ${table.orderedQuantity}`,
    ),
    check(
      'purchase_order_lines_unit_price_check',
      sql`${table.unitPriceMinor} >= 0 AND ${table.unitPriceMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check(
      'purchase_order_lines_total_value_check',
      sql`${table.orderedQuantity}::bigint * ${table.unitPriceMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check('purchase_order_lines_currency_check', sql`${table.currency} = 'EUR'`),
    check('purchase_order_lines_version_check', sql`${table.version} >= 0`),
  ],
);

export const salesOrders = enterpriseSchema.table(
  'sales_orders',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    reference: text('reference').notNull(),
    customerId: uuid('customer_id').notNull(),
    status: text('status').notNull(),
    currency: text('currency').notNull(),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
    promisedDeliveryAt: timestamp('promised_delivery_at', { withTimezone: true }).notNull(),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    contractualPenaltyDailyMinor: bigint('contractual_penalty_daily_minor', {
      mode: 'bigint',
    }),
    contractualPenaltyCapMinor: bigint('contractual_penalty_cap_minor', { mode: 'bigint' }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('sales_orders_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('sales_orders_sandbox_id_reference_key').on(table.sandboxId, table.reference),
    foreignKey({
      columns: [table.sandboxId, table.customerId],
      foreignColumns: [customers.sandboxId, customers.id],
    }),
    check('sales_orders_reference_check', sql`${table.reference} ~ ${sql.raw(`'${identifierPattern}'`)}`),
    check(
      'sales_orders_status_check',
      sql`${table.status} IN ('confirmed', 'allocated', 'shipped', 'delivered', 'cancelled')`,
    ),
    check('sales_orders_currency_check', sql`${table.currency} = 'EUR'`),
    check(
      'sales_orders_penalty_daily_check',
      sql`${table.contractualPenaltyDailyMinor} IS NULL OR (${table.contractualPenaltyDailyMinor} >= 0 AND ${table.contractualPenaltyDailyMinor} <= ${sql.raw(String(moneyCeiling))})`,
    ),
    check(
      'sales_orders_penalty_cap_check',
      sql`${table.contractualPenaltyCapMinor} IS NULL OR (${table.contractualPenaltyCapMinor} >= 0 AND ${table.contractualPenaltyCapMinor} <= ${sql.raw(String(moneyCeiling))})`,
    ),
    check('sales_orders_version_check', sql`${table.version} >= 0`),
  ],
);

export const salesOrderLines = enterpriseSchema.table(
  'sales_order_lines',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    salesOrderId: uuid('sales_order_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('sales_order_lines_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('sales_order_lines_sandbox_order_line_key').on(
      table.sandboxId,
      table.salesOrderId,
      table.lineNumber,
    ),
    foreignKey({
      columns: [table.sandboxId, table.salesOrderId],
      foreignColumns: [salesOrders.sandboxId, salesOrders.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.productId],
      foreignColumns: [products.sandboxId, products.id],
    }),
    check('sales_order_lines_line_number_check', sql`${table.lineNumber} >= 1 AND ${table.lineNumber} <= 999`),
    check(
      'sales_order_lines_quantity_check',
      sql`${table.quantity} >= 1 AND ${table.quantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check(
      'sales_order_lines_unit_price_check',
      sql`${table.unitPriceMinor} >= 0 AND ${table.unitPriceMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check(
      'sales_order_lines_total_value_check',
      sql`${table.quantity}::bigint * ${table.unitPriceMinor} <= ${sql.raw(String(moneyCeiling))}`,
    ),
    check('sales_order_lines_currency_check', sql`${table.currency} = 'EUR'`),
    check('sales_order_lines_version_check', sql`${table.version} >= 0`),
  ],
);

export const inventory = enterpriseSchema.table(
  'inventory',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    productId: uuid('product_id').notNull(),
    onHandQuantity: integer('on_hand_quantity').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('inventory_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('inventory_sandbox_id_product_id_key').on(table.sandboxId, table.productId),
    foreignKey({
      columns: [table.sandboxId, table.productId],
      foreignColumns: [products.sandboxId, products.id],
    }),
    check(
      'inventory_on_hand_quantity_check',
      sql`${table.onHandQuantity} >= 0 AND ${table.onHandQuantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check('inventory_version_check', sql`${table.version} >= 0`),
  ],
);

export const inventoryReservations = enterpriseSchema.table(
  'inventory_reservations',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    productId: uuid('product_id').notNull(),
    salesOrderId: uuid('sales_order_id'),
    status: text('status').notNull(),
    quantity: integer('quantity').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('inventory_reservations_sandbox_id_id_key').on(table.sandboxId, table.id),
    foreignKey({
      columns: [table.sandboxId, table.productId],
      foreignColumns: [products.sandboxId, products.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.salesOrderId],
      foreignColumns: [salesOrders.sandboxId, salesOrders.id],
    }),
    check(
      'inventory_reservations_status_check',
      sql`${table.status} IN ('active', 'released', 'fulfilled')`,
    ),
    check(
      'inventory_reservations_quantity_check',
      sql`${table.quantity} >= 1 AND ${table.quantity} <= ${sql.raw(String(quantityCeiling))}`,
    ),
    check('inventory_reservations_version_check', sql`${table.version} >= 0`),
  ],
);

export type SandboxRow = typeof sandboxes.$inferSelect;
export type SupplierRow = typeof suppliers.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type AgreementRow = typeof agreements.$inferSelect;
export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLineRow = typeof purchaseOrderLines.$inferSelect;
export type SalesOrderRow = typeof salesOrders.$inferSelect;
export type SalesOrderLineRow = typeof salesOrderLines.$inferSelect;
export type InventoryRow = typeof inventory.$inferSelect;
export type InventoryReservationRow = typeof inventoryReservations.$inferSelect;

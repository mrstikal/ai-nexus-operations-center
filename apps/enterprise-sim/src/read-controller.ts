import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  EnterpriseAffectedOrdersResponseSchema as AffectedOrdersResponseSchema,
  EnterpriseAlternativesResponseSchema as AlternativesResponseSchema,
  EnterpriseIdentifierSchema as IdentifierSchema,
  EnterpriseInventoryResponseSchema as InventoryResponseSchema,
  EnterprisePurchaseOrderResponseSchema as PurchaseOrderResponseSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
  type EnterpriseAffectedOrderSchema as AffectedOrderSchema,
  type EnterpriseCustomerSummarySchema as CustomerSummarySchema,
  type EnterpriseInboundLineSchema as InboundLineSchema,
  type EnterpriseProductSummarySchema as ProductSummarySchema,
  type EnterprisePurchaseOrderSchema as PurchaseOrderSchema,
  type EnterpriseReservationSchema as ReservationSchema,
  type EnterpriseSupplierOfferSchema as SupplierOfferSchema,
  type EnterpriseSupplierSummarySchema as SupplierSummarySchema,
} from '@nexus/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ENTERPRISE_DB_POOL,
  EnterpriseReadGuard,
  ProblemException,
  type EnterpriseReadContext,
  type EnterpriseRequest,
} from './auth.js';

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface SupplierRow {
  id: string;
  reference: string;
  name: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface CustomerRow {
  id: string;
  reference: string;
  name: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface PurchaseOrderRow {
  id: string;
  reference: string;
  supplier_reference: string | null;
  status: string;
  version: number;
  ordered_at: Date;
  expected_at: Date;
  source_purchase_order_id: string | null;
  source_reference: string | null;
  expedite_charge_minor: string;
  payment_terms: string;
  delivery_terms: string;
  created_at: Date;
  updated_at: Date;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_status: string;
  supplier_version: number;
  supplier_created_at: Date;
  supplier_updated_at: Date;
}

interface PurchaseOrderLineRow {
  id: string;
  purchase_order_id: string;
  line_number: number;
  ordered_quantity: number;
  received_quantity: number;
  unit_price_minor: string;
  currency: string;
  confirmed_arrival_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
  product_id: string;
  sku: string;
  product_name: string;
  category: string;
  product_status: string;
  product_version: number;
  product_created_at: Date;
  product_updated_at: Date;
  agreement_id: string | null;
  agreement_reference: string | null;
  agreement_version: number | null;
}

interface InventoryRow {
  id: string;
  product_id: string;
  on_hand_quantity: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ReservationRow {
  id: string;
  product_id: string;
  sales_order_id: string | null;
  status: string;
  quantity: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface InboundRow {
  purchase_order_id: string;
  purchase_order_reference: string;
  purchase_order_status: string;
  line_id: string;
  line_number: number;
  product_id: string;
  ordered_quantity: number;
  received_quantity: number;
  confirmed_arrival_at: Date;
  version: number;
  updated_at: Date;
}

interface BatchTotalRow {
  product_id: string;
  total_quantity: string;
}

interface SalesOrderRow {
  id: string;
  reference: string;
  status: string;
  version: number;
  ordered_at: Date;
  promised_delivery_at: Date;
  shipped_at: Date | null;
  delivered_at: Date | null;
  currency: string;
  contractual_penalty_daily_minor: string | null;
  contractual_penalty_cap_minor: string | null;
  created_at: Date;
  updated_at: Date;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  customer_status: string;
  customer_version: number;
  customer_created_at: Date;
  customer_updated_at: Date;
}

interface SalesOrderLineRow {
  id: string;
  sales_order_id: string;
  line_number: number;
  quantity: number;
  unit_price_minor: string;
  currency: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  product_id: string;
  sku: string;
  product_name: string;
  category: string;
  product_status: string;
  product_version: number;
  product_created_at: Date;
  product_updated_at: Date;
}

interface AgreementOfferRow {
  agreement_id: string;
  agreement_reference: string;
  agreement_version: number;
  agreement_status: string;
  unit_price_minor: string;
  currency: string;
  capacity_quantity: number;
  lead_time_days: number;
  valid_from: Date;
  valid_to: Date;
  agreement_created_at: Date;
  agreement_updated_at: Date;
  product_id: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_status: string;
  supplier_version: number;
  supplier_created_at: Date;
  supplier_updated_at: Date;
}

function requestContext(request: EnterpriseRequest): EnterpriseReadContext {
  if (!request.enterpriseContext) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Sandbox context is unavailable');
  }
  return request.enterpriseContext;
}

function invalid(message: string, path: (string | number)[] = []): ProblemException {
  return new ProblemException('VALIDATION_FAILED', message, [
    { path, message, code: 'invalid_request' },
  ]);
}

function validationProblem(error: z.ZodError): ProblemException {
  return new ProblemException(
    'VALIDATION_FAILED',
    'Invalid request',
    error.issues.map((issue) => ({
      path: issue.path.map((part) =>
        typeof part === 'symbol' ? String(part) : part,
      ),
      message: issue.message,
      code: issue.code,
    })),
  );
}

function uuidList(raw: string | undefined, name: string): string[] {
  if (!raw) {
    throw invalid(`Query parameter ${name} is required`, [name]);
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = z.array(UuidSchema).min(1).max(20).safeParse(values);
  if (!parsed.success) {
    throw validationProblem(parsed.error);
  }
  const unique = new Set(parsed.data);
  if (unique.size !== parsed.data.length) {
    throw invalid(`Query parameter ${name} contains duplicate identifiers`, [name]);
  }
  return [...parsed.data];
}

function quantityList(raw: string | undefined, name: string): number[] {
  if (!raw) {
    throw invalid(`Query parameter ${name} is required`, [name]);
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = z
    .array(z.string().regex(/^[1-9]\d{0,6}$/, 'Expected a positive integer quantity'))
    .min(1)
    .max(20)
    .safeParse(values);
  if (!parsed.success) {
    throw validationProblem(parsed.error);
  }
  const quantities = parsed.data.map(Number);
  if (quantities.some((value) => !Number.isSafeInteger(value) || value > 1_000_000)) {
    throw invalid(`Query parameter ${name} exceeds the quantity bound`, [name]);
  }
  return quantities;
}

function deadlineValue(raw: string | undefined, context: EnterpriseReadContext): Date {
  if (!raw) {
    throw invalid('Query parameter deadline is required', ['deadline']);
  }
  const parsed = IsoUtcTimestampSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationProblem(parsed.error);
  }
  const deadline = new Date(parsed.data);
  if (Number.isNaN(deadline.getTime())) {
    throw invalid('Query parameter deadline is not a valid timestamp', ['deadline']);
  }
  if (deadline.getTime() < context.businessEffectiveAt.getTime()) {
    throw invalid('Query parameter deadline precedes the sandbox business clock', ['deadline']);
  }
  return deadline;
}

function horizonDays(raw: string | undefined): number {
  if (!raw) {
    throw invalid('Query parameter horizonDays is required', ['horizonDays']);
  }
  const parsed = z
    .string()
    .regex(/^\d{1,3}$/, 'Expected a positive integer horizon')
    .safeParse(raw);
  if (!parsed.success) {
    throw validationProblem(parsed.error);
  }
  const value = Number(parsed.data);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw invalid('Query parameter horizonDays must be between 1 and 365', [
      'horizonDays',
    ]);
  }
  return value;
}

function asText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise read data is invalid',
    );
  }
  return value;
}

function asInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise read data is invalid',
    );
  }
  return parsed;
}

function asComputedMoney(value: unknown): string {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,14}|999000000000000)$/.test(value)) {
    return value;
  }
  throw new ProblemException(
    'DEPENDENCY_UNAVAILABLE',
    'Enterprise read data is invalid',
  );
}

function asMoney(value: unknown): string {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,11}|1000000000000)$/.test(value)) {
    return value;
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
  ) {
    return String(value);
  }
  throw new ProblemException(
    'DEPENDENCY_UNAVAILABLE',
    'Enterprise read data is invalid',
  );
}

function asIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise read data is invalid',
    );
  }
  return date.toISOString();
}

function checked<T>(schema: z.ZodType<T>, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise read response failed schema validation',
    );
  }
  return parsed.data;
}

async function queryRows<T>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<T[]> {
  try {
    const result = await pool.query(text, values);
    return result.rows as T[];
  } catch {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise read storage is unavailable',
    );
  }
}

function mapProduct(row: ProductRow): z.infer<typeof ProductSummarySchema> {
  return {
    id: asText(row.id),
    sku: asText(row.sku),
    name: asText(row.name),
    category: asText(row.category),
    status: asText(row.status) as z.infer<typeof ProductSummarySchema>['status'],
    version: asInteger(row.version),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapSupplier(row: SupplierRow): z.infer<typeof SupplierSummarySchema> {
  return {
    id: asText(row.id),
    reference: asText(row.reference),
    name: asText(row.name),
    status: asText(row.status) as z.infer<typeof SupplierSummarySchema>['status'],
    version: asInteger(row.version),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapCustomer(row: CustomerRow): z.infer<typeof CustomerSummarySchema> {
  return {
    id: asText(row.id),
    reference: asText(row.reference),
    name: asText(row.name),
    status: asText(row.status) as z.infer<typeof CustomerSummarySchema>['status'],
    version: asInteger(row.version),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function purchaseOrderProduct(row: PurchaseOrderLineRow) {
  return {
    id: asText(row.product_id),
    sku: asText(row.sku),
    name: asText(row.product_name),
    category: asText(row.category),
    status: asText(row.product_status) as z.infer<typeof ProductSummarySchema>['status'],
    version: asInteger(row.product_version),
    createdAt: asIso(row.product_created_at),
    updatedAt: asIso(row.product_updated_at),
  };
}

function salesOrderProduct(row: SalesOrderLineRow) {
  return {
    id: asText(row.product_id),
    sku: asText(row.sku),
    name: asText(row.product_name),
    category: asText(row.category),
    status: asText(row.product_status) as z.infer<typeof ProductSummarySchema>['status'],
    version: asInteger(row.product_version),
    createdAt: asIso(row.product_created_at),
    updatedAt: asIso(row.product_updated_at),
  };
}

@Controller('v1')
@UseGuards(EnterpriseReadGuard)
export class ReadController {
  constructor(@Inject(ENTERPRISE_DB_POOL) private readonly pool: Pool) {}

  @Get('purchase-orders/:identifier')
  @Header('Cache-Control', 'no-store')
  async purchaseOrders(
    @Param('identifier') identifier: string,
    @Req() request: EnterpriseRequest,
  ): Promise<z.infer<typeof PurchaseOrderResponseSchema>> {
    const context = requestContext(request);
    const exactIdentifier = IdentifierSchema.safeParse(identifier);
    if (!exactIdentifier.success) {
      throw validationProblem(exactIdentifier.error);
    }
    const asUuid = UuidSchema.safeParse(identifier);
    const rows = await queryRows<PurchaseOrderRow>(
      this.pool,
      `SELECT p.id, p.reference, p.supplier_reference, p.status, p.version,
              p.ordered_at, p.expected_at, p.source_purchase_order_id,
              p.expedite_charge_minor, p.payment_terms, p.delivery_terms,
              p.created_at, p.updated_at,
              src.reference AS source_reference,
              s.id AS supplier_id, s.reference AS supplier_code, s.name AS supplier_name,
              s.status AS supplier_status, s.version AS supplier_version,
              s.created_at AS supplier_created_at, s.updated_at AS supplier_updated_at
       FROM enterprise.purchase_orders p
       JOIN enterprise.suppliers s
         ON s.sandbox_id = p.sandbox_id AND s.id = p.supplier_id
       LEFT JOIN enterprise.purchase_orders src
         ON src.sandbox_id = p.sandbox_id AND src.id = p.source_purchase_order_id
       WHERE p.sandbox_id = $1
         AND (
           p.reference = $2
           OR p.supplier_reference = $2
           OR p.id = $3::uuid
         )
       ORDER BY p.reference, p.id
       LIMIT 11`,
      [context.sandboxId, exactIdentifier.data, asUuid.success ? asUuid.data : null],
    );
    if (rows.length === 0) {
      throw new ProblemException('NOT_FOUND', 'Purchase order was not found');
    }
    if (rows.length > 10) {
      throw new ProblemException(
        'CONFLICT',
        'Identifier matches too many purchase orders for an exact read',
      );
    }

    const ids = rows.map((row) => row.id);
    const lineRows = await queryRows<PurchaseOrderLineRow>(
      this.pool,
      `SELECT l.id, l.purchase_order_id, l.line_number, l.ordered_quantity,
              l.received_quantity, l.unit_price_minor, l.currency,
              l.confirmed_arrival_at, l.version, l.created_at, l.updated_at,
              l.agreement_id, a.reference AS agreement_reference,
              a.version AS agreement_version,
              pr.id AS product_id, pr.sku, pr.name AS product_name, pr.category,
              pr.status AS product_status, pr.version AS product_version,
              pr.created_at AS product_created_at, pr.updated_at AS product_updated_at
       FROM enterprise.purchase_order_lines l
       JOIN enterprise.products pr
         ON pr.sandbox_id = l.sandbox_id AND pr.id = l.product_id
       LEFT JOIN enterprise.agreements a
         ON a.sandbox_id = l.sandbox_id AND a.id = l.agreement_id
       WHERE l.sandbox_id = $1 AND l.purchase_order_id = ANY($2::uuid[])
       ORDER BY l.purchase_order_id, l.line_number`,
      [context.sandboxId, ids],
    );
    const linesByOrder = new Map<string, PurchaseOrderLineRow[]>();
    for (const line of lineRows) {
      const group = linesByOrder.get(line.purchase_order_id) ?? [];
      group.push(line);
      linesByOrder.set(line.purchase_order_id, group);
    }

    const purchaseOrders = rows.map((row) => {
      const supplier: SupplierRow = {
        id: row.supplier_id,
        reference: row.supplier_code,
        name: row.supplier_name,
        status: row.supplier_status,
        version: row.supplier_version,
        created_at: row.supplier_created_at,
        updated_at: row.supplier_updated_at,
      };
      const lines = (linesByOrder.get(row.id) ?? []).map((line) => ({
        id: asText(line.id),
        lineNumber: asInteger(line.line_number),
        product: purchaseOrderProduct(line),
        agreementId: line.agreement_id,
        agreementReference: line.agreement_reference,
        agreementVersion:
          line.agreement_version === null
            ? null
            : asInteger(line.agreement_version),
        orderedQuantity: asInteger(line.ordered_quantity),
        receivedQuantity: asInteger(line.received_quantity),
        unreceivedQuantity:
          asInteger(line.ordered_quantity) - asInteger(line.received_quantity),
        unitPriceMinor: asMoney(line.unit_price_minor),
        currency: 'EUR' as const,
        confirmedArrivalAt: asIso(line.confirmed_arrival_at),
        version: asInteger(line.version),
        createdAt: asIso(line.created_at),
        updatedAt: asIso(line.updated_at),
      }));
      return {
        id: asText(row.id),
        reference: asText(row.reference),
        supplierReference: row.supplier_reference,
        status: asText(row.status) as z.infer<typeof PurchaseOrderSchema>['status'],
        version: asInteger(row.version),
        orderedAt: asIso(row.ordered_at),
        expectedAt: asIso(row.expected_at),
        sourcePurchaseOrderId: row.source_purchase_order_id,
        sourcePurchaseOrderReference: row.source_reference,
        expediteChargeMinor: asMoney(row.expedite_charge_minor),
        paymentTerms: asText(row.payment_terms),
        deliveryTerms: asText(row.delivery_terms),
        supplier: mapSupplier(supplier),
        lines,
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at),
      };
    });

    return checked(PurchaseOrderResponseSchema, {
      sandboxId: context.sandboxId,
      businessEffectiveAt: context.businessEffectiveAt.toISOString(),
      purchaseOrders,
    });
  }

  @Get('inventory')
  @Header('Cache-Control', 'no-store')
  async inventory(
    @Query('productIds') productIds: string | undefined,
    @Req() request: EnterpriseRequest,
  ): Promise<z.infer<typeof InventoryResponseSchema>> {
    const context = requestContext(request);
    const ids = uuidList(productIds, 'productIds');

    const products = await queryRows<ProductRow>(
      this.pool,
      `SELECT id, sku, name, category, status, version, created_at, updated_at
       FROM enterprise.products
       WHERE sandbox_id = $1 AND id = ANY($2::uuid[])`,
      [context.sandboxId, ids],
    );
    if (products.length !== ids.length) {
      throw new ProblemException('NOT_FOUND', 'One or more products were not found');
    }
    const productById = new Map(products.map((row) => [row.id, row]));

    const inventoryRows = await queryRows<InventoryRow>(
      this.pool,
      `SELECT id, product_id, on_hand_quantity, version, created_at, updated_at
       FROM enterprise.inventory
       WHERE sandbox_id = $1 AND product_id = ANY($2::uuid[])`,
      [context.sandboxId, ids],
    );
    if (inventoryRows.length !== ids.length) {
      throw new ProblemException('NOT_FOUND', 'Inventory was not found for a product');
    }
    const inventoryByProduct = new Map(
      inventoryRows.map((row) => [row.product_id, row]),
    );

    const reservations = await queryRows<ReservationRow>(
      this.pool,
      `WITH ranked AS (
         SELECT id, product_id, sales_order_id, status, quantity, version,
                created_at, updated_at,
                row_number() OVER (
                  PARTITION BY product_id
                  ORDER BY (status = 'active') DESC, created_at, id
                ) AS row_number
         FROM enterprise.inventory_reservations
         WHERE sandbox_id = $1 AND product_id = ANY($2::uuid[])
       )
       SELECT id, product_id, sales_order_id, status, quantity, version,
              created_at, updated_at
       FROM ranked
       WHERE row_number <= 1001
       ORDER BY product_id, row_number`,
      [context.sandboxId, ids],
    );
    const reservationsByProduct = new Map<string, ReservationRow[]>();
    for (const reservation of reservations) {
      const group = reservationsByProduct.get(reservation.product_id) ?? [];
      group.push(reservation);
      reservationsByProduct.set(reservation.product_id, group);
    }
    const reservationTotals = await queryRows<BatchTotalRow>(
      this.pool,
      `SELECT product_id,
              COALESCE(sum(quantity) FILTER (WHERE status = 'active'), 0)::bigint
                AS total_quantity
       FROM enterprise.inventory_reservations
       WHERE sandbox_id = $1 AND product_id = ANY($2::uuid[])
       GROUP BY product_id`,
      [context.sandboxId, ids],
    );
    const activeReservationByProduct = new Map(
      reservationTotals.map((row) => [
        row.product_id,
        asInteger(row.total_quantity),
      ]),
    );

    const inbound = await queryRows<InboundRow>(
      this.pool,
      `WITH ranked AS (
         SELECT po.id AS purchase_order_id, po.reference AS purchase_order_reference,
                po.status AS purchase_order_status, l.id AS line_id, l.line_number,
                l.product_id, l.ordered_quantity, l.received_quantity,
                l.confirmed_arrival_at, l.version, l.updated_at,
                row_number() OVER (
                  PARTITION BY l.product_id
                  ORDER BY l.confirmed_arrival_at, po.reference, l.line_number
                ) AS row_number
         FROM enterprise.purchase_order_lines l
         JOIN enterprise.purchase_orders po
           ON po.sandbox_id = l.sandbox_id AND po.id = l.purchase_order_id
         WHERE l.sandbox_id = $1
           AND l.product_id = ANY($2::uuid[])
           AND po.status <> 'cancelled'
           AND l.received_quantity < l.ordered_quantity
           AND l.confirmed_arrival_at > $3
       )
       SELECT purchase_order_id, purchase_order_reference, purchase_order_status,
              line_id, line_number, product_id, ordered_quantity, received_quantity,
              confirmed_arrival_at, version, updated_at
       FROM ranked
       WHERE row_number <= 1001
       ORDER BY product_id, row_number`,
      [context.sandboxId, ids, context.businessEffectiveAt],
    );
    const inboundByProduct = new Map<string, InboundRow[]>();
    for (const line of inbound) {
      const group = inboundByProduct.get(line.product_id) ?? [];
      group.push(line);
      inboundByProduct.set(line.product_id, group);
    }
    const inboundTotals = await queryRows<BatchTotalRow>(
      this.pool,
      `SELECT l.product_id,
              COALESCE(sum(l.ordered_quantity - l.received_quantity), 0)::bigint
                AS total_quantity
       FROM enterprise.purchase_order_lines l
       JOIN enterprise.purchase_orders po
         ON po.sandbox_id = l.sandbox_id AND po.id = l.purchase_order_id
       WHERE l.sandbox_id = $1
         AND l.product_id = ANY($2::uuid[])
         AND po.status <> 'cancelled'
         AND l.received_quantity < l.ordered_quantity
         AND l.confirmed_arrival_at > $3
       GROUP BY l.product_id`,
      [context.sandboxId, ids, context.businessEffectiveAt],
    );
    const inboundQuantityByProduct = new Map(
      inboundTotals.map((row) => [
        row.product_id,
        asInteger(row.total_quantity),
      ]),
    );

    const items = ids.map((id) => {
      const product = productById.get(id);
      const inventory = inventoryByProduct.get(id);
      if (!product || !inventory) {
        throw new ProblemException('NOT_FOUND', 'Inventory was not found for a product');
      }
      const reservationRows = reservationsByProduct.get(id) ?? [];
      const productReservations = reservationRows.slice(0, 1000).map((row) => ({
        id: asText(row.id),
        salesOrderId: row.sales_order_id,
        status: asText(row.status) as z.infer<typeof ReservationSchema>['status'],
        quantity: asInteger(row.quantity),
        version: asInteger(row.version),
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at),
      }));
      const activeReservations = activeReservationByProduct.get(id) ?? 0;
      const inboundRows = inboundByProduct.get(id) ?? [];
      const onHandQuantity = asInteger(inventory.on_hand_quantity);
      return {
        product: mapProduct(product),
        onHandQuantity,
        activeReservations,
        availableForAllocation: Math.max(0, onHandQuantity - activeReservations),
        reservations: productReservations,
        reservationsTruncated: reservationRows.length > 1000,
        confirmedInboundQuantity: inboundQuantityByProduct.get(id) ?? 0,
        confirmedInbound: inboundRows.slice(0, 1000).map((row) => ({
          purchaseOrderId: asText(row.purchase_order_id),
          purchaseOrderReference: asText(row.purchase_order_reference),
          purchaseOrderStatus: asText(
            row.purchase_order_status,
          ) as z.infer<typeof InboundLineSchema>['purchaseOrderStatus'],
          lineId: asText(row.line_id),
          lineNumber: asInteger(row.line_number),
          unreceivedQuantity:
            asInteger(row.ordered_quantity) - asInteger(row.received_quantity),
          confirmedArrivalAt: asIso(row.confirmed_arrival_at),
          version: asInteger(row.version),
          updatedAt: asIso(row.updated_at),
        })),
        confirmedInboundTruncated: inboundRows.length > 1000,
        version: asInteger(inventory.version),
        createdAt: asIso(inventory.created_at),
        updatedAt: asIso(inventory.updated_at),
      };
    });

    return checked(InventoryResponseSchema, {
      sandboxId: context.sandboxId,
      businessEffectiveAt: context.businessEffectiveAt.toISOString(),
      items,
    });
  }

  @Get('affected-orders')
  @Header('Cache-Control', 'no-store')
  async affectedOrders(
    @Query('purchaseOrderId') purchaseOrderId: string | undefined,
    @Query('productIds') productIds: string | undefined,
    @Query('horizonDays') horizonDaysRaw: string | undefined,
    @Req() request: EnterpriseRequest,
  ): Promise<z.infer<typeof AffectedOrdersResponseSchema>> {
    const context = requestContext(request);
    const days = horizonDays(horizonDaysRaw);
    if ((purchaseOrderId === undefined) === (productIds === undefined)) {
      throw invalid('Provide exactly one of purchaseOrderId or productIds', [
        'purchaseOrderId',
        'productIds',
      ]);
    }

    let ids: string[];
    if (purchaseOrderId !== undefined) {
      const parsed = UuidSchema.safeParse(purchaseOrderId);
      if (!parsed.success) {
        throw validationProblem(parsed.error);
      }
      const exists = await queryRows<{ id: string }>(
        this.pool,
        `SELECT id FROM enterprise.purchase_orders
         WHERE sandbox_id = $1 AND id = $2`,
        [context.sandboxId, parsed.data],
      );
      if (exists.length === 0) {
        throw new ProblemException('NOT_FOUND', 'Purchase order was not found');
      }
      const productRows = await queryRows<{ product_id: string }>(
        this.pool,
        `SELECT DISTINCT product_id FROM enterprise.purchase_order_lines
         WHERE sandbox_id = $1 AND purchase_order_id = $2
         ORDER BY product_id`,
        [context.sandboxId, parsed.data],
      );
      ids = productRows.map((row) => row.product_id);
      if (ids.length === 0) {
        throw new ProblemException('NOT_FOUND', 'Purchase order has no lines');
      }
    } else {
      ids = uuidList(productIds, 'productIds');
      const products = await queryRows<ProductRow>(
        this.pool,
        `SELECT id, sku, name, category, status, version, created_at, updated_at
         FROM enterprise.products
         WHERE sandbox_id = $1 AND id = ANY($2::uuid[])`,
        [context.sandboxId, ids],
      );
      if (products.length !== ids.length) {
        throw new ProblemException('NOT_FOUND', 'One or more products were not found');
      }
    }

    const from = context.businessEffectiveAt;
    const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    const rows = await queryRows<SalesOrderRow>(
      this.pool,
      `SELECT so.id, so.reference, so.status, so.version, so.ordered_at,
              so.promised_delivery_at, so.shipped_at, so.delivered_at, so.currency,
              so.contractual_penalty_daily_minor, so.contractual_penalty_cap_minor,
              so.created_at, so.updated_at,
              c.id AS customer_id, c.reference AS customer_code, c.name AS customer_name,
              c.status AS customer_status, c.version AS customer_version,
              c.created_at AS customer_created_at, c.updated_at AS customer_updated_at
       FROM enterprise.sales_orders so
       JOIN enterprise.customers c
         ON c.sandbox_id = so.sandbox_id AND c.id = so.customer_id
       WHERE so.sandbox_id = $1
         AND so.status IN ('confirmed', 'allocated')
         AND so.promised_delivery_at >= $2
         AND so.promised_delivery_at <= $3
         AND EXISTS (
           SELECT 1
           FROM enterprise.sales_order_lines l
           WHERE l.sandbox_id = so.sandbox_id
             AND l.sales_order_id = so.id
             AND l.product_id = ANY($4::uuid[])
         )
       ORDER BY so.promised_delivery_at, so.id
       LIMIT 101`,
      [context.sandboxId, from, to, ids],
    );
    const truncated = rows.length > 100;
    const visibleRows = rows.slice(0, 100);
    const orderIds = visibleRows.map((row) => row.id);
    const lineRows =
      orderIds.length === 0
        ? []
        : await queryRows<SalesOrderLineRow>(
            this.pool,
            `SELECT l.id, l.sales_order_id, l.line_number, l.quantity,
                    l.unit_price_minor, l.currency, l.version, l.created_at,
                    l.updated_at,
                    pr.id AS product_id, pr.sku, pr.name AS product_name, pr.category,
                    pr.status AS product_status, pr.version AS product_version,
                    pr.created_at AS product_created_at,
                    pr.updated_at AS product_updated_at
             FROM enterprise.sales_order_lines l
             JOIN enterprise.products pr
               ON pr.sandbox_id = l.sandbox_id AND pr.id = l.product_id
             WHERE l.sandbox_id = $1 AND l.sales_order_id = ANY($2::uuid[])
             ORDER BY l.sales_order_id, l.line_number`,
            [context.sandboxId, orderIds],
          );
    const linesByOrder = new Map<string, SalesOrderLineRow[]>();
    for (const line of lineRows) {
      const group = linesByOrder.get(line.sales_order_id) ?? [];
      group.push(line);
      linesByOrder.set(line.sales_order_id, group);
    }

    const orders = visibleRows.map((row) => {
      const customer: CustomerRow = {
        id: row.customer_id,
        reference: row.customer_code,
        name: row.customer_name,
        status: row.customer_status,
        version: row.customer_version,
        created_at: row.customer_created_at,
        updated_at: row.customer_updated_at,
      };
      const lines = (linesByOrder.get(row.id) ?? []).map((line) => ({
        id: asText(line.id),
        lineNumber: asInteger(line.line_number),
        product: salesOrderProduct(line),
        quantity: asInteger(line.quantity),
        unitPriceMinor: asMoney(line.unit_price_minor),
        currency: 'EUR' as const,
        version: asInteger(line.version),
        createdAt: asIso(line.created_at),
        updatedAt: asIso(line.updated_at),
      }));
      const exposedValue = lines.reduce(
        (sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitPriceMinor),
        0n,
      );
      return {
        id: asText(row.id),
        reference: asText(row.reference),
        status: asText(row.status) as z.infer<typeof AffectedOrderSchema>['status'],
        version: asInteger(row.version),
        orderedAt: asIso(row.ordered_at),
        promisedDeliveryAt: asIso(row.promised_delivery_at),
        shippedAt: row.shipped_at === null ? null : asIso(row.shipped_at),
        deliveredAt: row.delivered_at === null ? null : asIso(row.delivered_at),
        exposedValueMinor: asComputedMoney(exposedValue.toString()),
        currency: 'EUR' as const,
        contractualPenaltyDailyMinor:
          row.contractual_penalty_daily_minor === null
            ? null
            : asMoney(row.contractual_penalty_daily_minor),
        contractualPenaltyCapMinor:
          row.contractual_penalty_cap_minor === null
            ? null
            : asMoney(row.contractual_penalty_cap_minor),
        customer: mapCustomer(customer),
        lines,
        createdAt: asIso(row.created_at),
        updatedAt: asIso(row.updated_at),
      };
    });

    return checked(AffectedOrdersResponseSchema, {
      sandboxId: context.sandboxId,
      businessEffectiveAt: context.businessEffectiveAt.toISOString(),
      requestedProductIds: ids,
      horizon: {
        from: from.toISOString(),
        to: to.toISOString(),
        days,
      },
      orders,
      truncated,
    });
  }

  @Get('alternatives')
  @Header('Cache-Control', 'no-store')
  async alternatives(
    @Query('productIds') productIds: string | undefined,
    @Query('quantities') quantitiesRaw: string | undefined,
    @Query('deadline') deadlineRaw: string | undefined,
    @Req() request: EnterpriseRequest,
  ): Promise<z.infer<typeof AlternativesResponseSchema>> {
    const context = requestContext(request);
    const ids = uuidList(productIds, 'productIds');
    const quantities = quantityList(quantitiesRaw, 'quantities');
    if (ids.length !== quantities.length) {
      throw invalid('productIds and quantities must contain the same number of values', [
        'productIds',
        'quantities',
      ]);
    }
    const deadline = deadlineValue(deadlineRaw, context);

    const products = await queryRows<ProductRow>(
      this.pool,
      `SELECT id, sku, name, category, status, version, created_at, updated_at
       FROM enterprise.products
       WHERE sandbox_id = $1 AND id = ANY($2::uuid[])`,
      [context.sandboxId, ids],
    );
    if (products.length !== ids.length) {
      throw new ProblemException('NOT_FOUND', 'One or more products were not found');
    }
    const productById = new Map(products.map((row) => [row.id, row]));

    const offers = await queryRows<AgreementOfferRow>(
      this.pool,
      `WITH ranked AS (
         SELECT a.id AS agreement_id, a.reference AS agreement_reference,
                a.version AS agreement_version, a.status AS agreement_status,
                a.unit_price_minor, a.currency, a.capacity_quantity, a.lead_time_days,
                a.valid_from, a.valid_to,
                a.created_at AS agreement_created_at,
                a.updated_at AS agreement_updated_at,
                a.product_id,
                s.id AS supplier_id, s.reference AS supplier_code,
                s.name AS supplier_name, s.status AS supplier_status,
                s.version AS supplier_version, s.created_at AS supplier_created_at,
                s.updated_at AS supplier_updated_at,
                row_number() OVER (
                  PARTITION BY a.product_id
                  ORDER BY a.unit_price_minor, s.id, a.id
                ) AS row_number
         FROM enterprise.agreements a
         JOIN enterprise.suppliers s
           ON s.sandbox_id = a.sandbox_id AND s.id = a.supplier_id
         JOIN enterprise.products p
           ON p.sandbox_id = a.sandbox_id AND p.id = a.product_id
         WHERE a.sandbox_id = $1
           AND a.product_id = ANY($2::uuid[])
           AND a.status = 'approved'
           AND s.status = 'active'
           AND p.status = 'active'
       )
       SELECT agreement_id, agreement_reference, agreement_version, agreement_status,
              unit_price_minor, currency, capacity_quantity, lead_time_days,
              valid_from, valid_to, agreement_created_at, agreement_updated_at,
              product_id, supplier_id, supplier_code, supplier_name, supplier_status,
              supplier_version, supplier_created_at, supplier_updated_at
       FROM ranked
       WHERE row_number <= 1001
       ORDER BY product_id, row_number`,
      [context.sandboxId, ids],
    );
    const offersByProduct = new Map<string, AgreementOfferRow[]>();
    for (const offer of offers) {
      const group = offersByProduct.get(offer.product_id) ?? [];
      group.push(offer);
      offersByProduct.set(offer.product_id, group);
    }

    const productsResponse = ids.map((id, index) => {
      const product = productById.get(id);
      if (!product) {
        throw new ProblemException('NOT_FOUND', 'Product was not found');
      }
      const offerRows = offersByProduct.get(id) ?? [];
      const productOffers = offerRows
        .slice(0, 1000)
        .sort((left, right) => {
          const priceOrder =
            BigInt(asMoney(left.unit_price_minor)) -
            BigInt(asMoney(right.unit_price_minor));
          if (priceOrder !== 0n) {
            return priceOrder < 0n ? -1 : 1;
          }
          const supplierOrder = left.supplier_id.localeCompare(right.supplier_id);
          if (supplierOrder !== 0) {
            return supplierOrder;
          }
          return left.agreement_id.localeCompare(right.agreement_id);
        })
        .map((offer) => {
          const supplier: SupplierRow = {
            id: offer.supplier_id,
            reference: offer.supplier_code,
            name: offer.supplier_name,
            status: offer.supplier_status,
            version: offer.supplier_version,
            created_at: offer.supplier_created_at,
            updated_at: offer.supplier_updated_at,
          };
          const validFrom = asIso(offer.valid_from);
          const validTo = asIso(offer.valid_to);
          const leadTimeDays = asInteger(offer.lead_time_days);
          return {
            agreementId: asText(offer.agreement_id),
            agreementReference: asText(offer.agreement_reference),
            agreementVersion: asInteger(offer.agreement_version),
            agreementStatus: asText(
              offer.agreement_status,
            ) as z.infer<typeof SupplierOfferSchema>['agreementStatus'],
            currentlyValid:
              Date.parse(validFrom) <= context.businessEffectiveAt.getTime() &&
              context.businessEffectiveAt.getTime() <= Date.parse(validTo),
            supplier: mapSupplier(supplier),
            unitPriceMinor: asMoney(offer.unit_price_minor),
            currency: 'EUR' as const,
            capacityQuantity: asInteger(offer.capacity_quantity),
            leadTimeDays,
            latestArrivalAt: new Date(
              context.businessEffectiveAt.getTime() +
                leadTimeDays * 24 * 60 * 60 * 1000,
            ).toISOString(),
            validFrom,
            validTo,
            createdAt: asIso(offer.agreement_created_at),
            updatedAt: asIso(offer.agreement_updated_at),
          };
        });

      return {
        product: mapProduct(product),
        requestedQuantity: quantities[index] ?? 0,
        offers: productOffers,
        offersTruncated: offerRows.length > 1000,
      };
    });

    return checked(AlternativesResponseSchema, {
      sandboxId: context.sandboxId,
      businessEffectiveAt: context.businessEffectiveAt.toISOString(),
      deadline: deadline.toISOString(),
      products: productsResponse,
    });
  }
}

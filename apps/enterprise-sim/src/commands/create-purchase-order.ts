import { randomUUID } from 'node:crypto';
import type { CreatePurchaseOrderPayload } from '@nexus/contracts';
import { ProblemException } from '../auth.js';
import type { CommandContext, CommandEffect, CommandOutboxEvent } from './transaction.js';

interface SupplierRow {
  id: string;
  reference: string;
  status: string;
  version: number;
}

interface ProductRow {
  id: string;
  sku: string;
  status: string;
  version: number;
}

interface AgreementRow {
  id: string;
  reference: string;
  supplier_id: string;
  product_id: string;
  status: string;
  unit_price_minor: string;
  currency: string;
  capacity_quantity: number;
  lead_time_days: number;
  valid_from: Date;
  valid_to: Date;
  version: number;
}

interface SourceOrderRow {
  id: string;
  reference: string;
  status: string;
  payment_terms: string;
  delivery_terms: string;
  version: number;
}

interface InventoryRow {
  id: string;
  product_id: string;
  version: number;
}

function conflict(message: string): ProblemException {
  return new ProblemException('CONFLICT', message);
}

function stale(message: string): ProblemException {
  return new ProblemException('STALE_STATE', message);
}

function invalid(message: string, issues?: unknown[]): ProblemException {
  return new ProblemException('VALIDATION_FAILED', message, issues);
}

function baseVersion(
  context: CommandContext,
  type: 'supplier' | 'purchase_order' | 'agreement',
  id: string,
): { reference: string | null; version: number } {
  const entry = context.baseExpectedVersions.find(
    (candidate) => candidate.type === type && candidate.id === id,
  );
  if (!entry) {
    throw stale(`A base expected version for ${type}:${id} is required`);
  }
  return { reference: entry.reference, version: entry.version };
}

export async function executeCreatePurchaseOrder(
  context: CommandContext,
  payload: CreatePurchaseOrderPayload,
): Promise<CommandEffect> {
  if (payload.expediteChargeMinor.startsWith('-')) {
    throw invalid('expediteChargeMinor must not be negative');
  }
  if (BigInt(payload.expediteChargeMinor) > 1_000_000_000_000n) {
    throw invalid('expediteChargeMinor exceeds the money bound');
  }

  const lineKeys = new Set<string>();
  for (const line of payload.lines) {
    const key = `${line.productId}:${line.agreementId}`;
    if (lineKeys.has(key)) {
      throw invalid('Purchase-order lines must not repeat a product and agreement pair');
    }
    lineKeys.add(key);
    if (BigInt(line.unitPriceMinor) < 0n) {
      throw invalid('Purchase-order unit prices must not be negative');
    }
    if (BigInt(line.quantity) * BigInt(line.unitPriceMinor) > 1_000_000_000_000n) {
      throw invalid('A purchase-order line total exceeds the money bound');
    }
    const arrival = Date.parse(line.arrivalAt);
    if (!Number.isFinite(arrival)) {
      throw invalid('Purchase-order arrivals must be valid timestamps');
    }
    if (arrival < context.businessEffectiveAt.getTime()) {
      throw invalid('Purchase-order arrivals must not precede the sandbox business clock');
    }
  }

  const supplierBase = baseVersion(context, 'supplier', payload.supplierId);
  const sourceBase = baseVersion(
    context,
    'purchase_order',
    payload.sourcePurchaseOrderId,
  );
  for (const line of payload.lines) {
    const agreementBase = baseVersion(context, 'agreement', line.agreementId);
    if (agreementBase.reference === null) {
      throw stale('Agreement base versions must include the agreement reference');
    }
  }

  const supplierResult = await context.client.query<SupplierRow>(
    `SELECT id, reference, status, version
     FROM enterprise.suppliers
     WHERE sandbox_id = $1 AND id = $2`,
    [context.sandboxId, payload.supplierId],
  );
  const supplier = supplierResult.rows[0];
  if (!supplier) {
    throw new ProblemException('NOT_FOUND', 'Supplier was not found');
  }
  if (
    supplier.status !== 'active' ||
    supplier.version !== supplierBase.version ||
    (supplierBase.reference !== null && supplier.reference !== supplierBase.reference)
  ) {
    throw stale('Supplier has changed or is not active');
  }

  const sourceResult = await context.client.query<SourceOrderRow>(
    `SELECT id, reference, status, payment_terms, delivery_terms, version
     FROM enterprise.purchase_orders
     WHERE sandbox_id = $1 AND id = $2
     FOR UPDATE`,
    [context.sandboxId, payload.sourcePurchaseOrderId],
  );
  const source = sourceResult.rows[0];
  if (!source) {
    throw new ProblemException('NOT_FOUND', 'Source purchase order was not found');
  }
  if (
    source.version !== sourceBase.version ||
    (sourceBase.reference !== null && source.reference !== sourceBase.reference)
  ) {
    throw stale('Source purchase order has changed');
  }
  if (['received', 'cancelled'].includes(source.status)) {
    throw stale('Source purchase order is not open for alternative procurement');
  }

  const agreementIds = [
    ...new Set(payload.lines.map((line) => line.agreementId)),
  ].sort();
  const agreementResult = await context.client.query<AgreementRow>(
    `SELECT id, reference, supplier_id, product_id, status, unit_price_minor,
            currency, capacity_quantity, lead_time_days, valid_from, valid_to, version
     FROM enterprise.agreements
     WHERE sandbox_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id`,
    [context.sandboxId, agreementIds],
  );
  if (agreementResult.rows.length !== agreementIds.length) {
    throw new ProblemException('NOT_FOUND', 'One or more agreements were not found');
  }
  const agreements = new Map(
    agreementResult.rows.map((agreement) => [agreement.id, agreement]),
  );

  const productIds = [...new Set(payload.lines.map((line) => line.productId))].sort();
  const productResult = await context.client.query<ProductRow>(
    `SELECT id, sku, status, version
     FROM enterprise.products
     WHERE sandbox_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id`,
    [context.sandboxId, productIds],
  );
  if (productResult.rows.length !== productIds.length) {
    throw new ProblemException('NOT_FOUND', 'One or more products were not found');
  }
  const products = new Map(productResult.rows.map((product) => [product.id, product]));

  const requestedByAgreement = new Map<string, number>();
  for (const line of payload.lines) {
    const agreement = agreements.get(line.agreementId);
    const product = products.get(line.productId);
    if (!agreement || !product) {
      throw new ProblemException('NOT_FOUND', 'Agreement or product was not found');
    }
    const base = baseVersion(context, 'agreement', agreement.id);
    if (
      agreement.version !== base.version ||
      base.reference === null ||
      agreement.reference !== base.reference
    ) {
      throw stale('Agreement has changed since the approved quote');
    }
    if (
      agreement.supplier_id !== payload.supplierId ||
      agreement.product_id !== line.productId
    ) {
      throw conflict('Agreement does not match the requested supplier and product');
    }
    if (agreement.status !== 'approved') {
      throw conflict('Agreement is not approved');
    }
    if (agreement.currency !== 'EUR') {
      throw conflict('Agreement currency is not EUR');
    }
    if (
      context.businessEffectiveAt.getTime() < agreement.valid_from.getTime() ||
      context.businessEffectiveAt.getTime() > agreement.valid_to.getTime()
    ) {
      throw conflict('Agreement is not valid at the sandbox business clock');
    }
    if (agreement.unit_price_minor !== line.unitPriceMinor) {
      throw conflict('Quoted unit price does not match the approved agreement');
    }
    if (product.status !== 'active') {
      throw conflict('Product is not active');
    }
    requestedByAgreement.set(
      agreement.id,
      (requestedByAgreement.get(agreement.id) ?? 0) + line.quantity,
    );
  }

  for (const [agreementId, requested] of requestedByAgreement) {
    const agreement = agreements.get(agreementId);
    if (!agreement) {
      throw new ProblemException('NOT_FOUND', 'Agreement was not found');
    }
    const committedResult = await context.client.query<{ committed: string }>(
      `SELECT COALESCE(sum(l.ordered_quantity), 0)::bigint AS committed
       FROM enterprise.purchase_order_lines l
       JOIN enterprise.purchase_orders po
         ON po.sandbox_id = l.sandbox_id AND po.id = l.purchase_order_id
       WHERE l.sandbox_id = $1
         AND l.agreement_id = $2
         AND po.status NOT IN ('cancelled', 'received')`,
      [context.sandboxId, agreementId],
    );
    const committed = Number(committedResult.rows[0]?.committed ?? '0');
    if (
      agreement.capacity_quantity <= 0 ||
      committed + requested > agreement.capacity_quantity
    ) {
      throw conflict('Requested quantity exceeds approved agreement capacity');
    }
  }

  const inventoryResult = await context.client.query<InventoryRow>(
    `SELECT id, product_id, version
     FROM enterprise.inventory
     WHERE sandbox_id = $1 AND product_id = ANY($2::uuid[])
     ORDER BY product_id
     FOR UPDATE`,
    [context.sandboxId, productIds],
  );
  if (inventoryResult.rows.length !== productIds.length) {
    throw new ProblemException('NOT_FOUND', 'Inventory was not found for a product');
  }
  const inventoryByProduct = new Map(
    inventoryResult.rows.map((row) => [row.product_id, row]),
  );

  const year = String(context.businessEffectiveAt.getUTCFullYear());
  const sequenceResult = await context.client.query<{ next_reference: number }>(
    `SELECT COALESCE(
              MAX((regexp_match(reference, '^PO-' || $2 || '-([0-9]{4,})$'))[1]::int),
              1000
            ) + 1 AS next_reference
     FROM enterprise.purchase_orders
     WHERE sandbox_id = $1`,
    [context.sandboxId, year],
  );
  const nextReference = sequenceResult.rows[0]?.next_reference;
  if (
    nextReference === undefined ||
    !Number.isSafeInteger(nextReference) ||
    nextReference < 1001
  ) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Could not allocate a purchase-order reference',
    );
  }
  const reference = `PO-${year}-${nextReference}`;
  const purchaseOrderId = randomUUID();
  const expectedAt = new Date(
    Math.max(...payload.lines.map((line) => Date.parse(line.arrivalAt))),
  );

  await context.client.query(
    `INSERT INTO enterprise.purchase_orders
       (id, sandbox_id, reference, supplier_reference, supplier_id,
        source_purchase_order_id, expedite_charge_minor, status, payment_terms,
        delivery_terms, ordered_at, expected_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, 'open', $7, $8, $9, $10, 1,
             clock_timestamp(), clock_timestamp())`,
    [
      purchaseOrderId,
      context.sandboxId,
      reference,
      payload.supplierId,
      payload.sourcePurchaseOrderId,
      payload.expediteChargeMinor,
      source.payment_terms,
      source.delivery_terms,
      context.businessEffectiveAt,
      expectedAt,
    ],
  );

  const lineIds: string[] = [];
  for (const [index, line] of payload.lines.entries()) {
    const lineId = randomUUID();
    lineIds.push(lineId);
    await context.client.query(
      `INSERT INTO enterprise.purchase_order_lines
         (id, sandbox_id, purchase_order_id, line_number, product_id, agreement_id,
          ordered_quantity, received_quantity, unit_price_minor, currency,
          confirmed_arrival_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'EUR', $9, 1,
               clock_timestamp(), clock_timestamp())`,
      [
        lineId,
        context.sandboxId,
        purchaseOrderId,
        index + 1,
        line.productId,
        line.agreementId,
        line.quantity,
        line.unitPriceMinor,
        line.arrivalAt,
      ],
    );
  }

  const sourceUpdate = await context.client.query<{ version: number }>(
    `UPDATE enterprise.purchase_orders
     SET version = version + 1, updated_at = clock_timestamp()
     WHERE sandbox_id = $1 AND id = $2 AND version = $3
     RETURNING version`,
    [context.sandboxId, source.id, source.version],
  );
  const sourceAfterVersion = sourceUpdate.rows[0]?.version;
  if (sourceAfterVersion === undefined) {
    throw stale('Source purchase order changed during the command');
  }

  const outboxEvents: CommandOutboxEvent[] = [];
  const inventoryChanges: Array<{
    productId: string;
    beforeVersion: number;
    afterVersion: number;
  }> = [];
  for (const productId of productIds) {
    const inventory = inventoryByProduct.get(productId);
    if (!inventory) {
      throw new ProblemException('NOT_FOUND', 'Inventory was not found for a product');
    }
    const update = await context.client.query<{ version: number }>(
      `UPDATE enterprise.inventory
       SET version = version + 1, updated_at = clock_timestamp()
       WHERE sandbox_id = $1 AND product_id = $2 AND version = $3
       RETURNING version`,
      [context.sandboxId, productId, inventory.version],
    );
    const afterVersion = update.rows[0]?.version;
    if (afterVersion === undefined) {
      throw stale('Inventory changed during the command');
    }
    inventoryChanges.push({
      productId,
      beforeVersion: inventory.version,
      afterVersion,
    });
    outboxEvents.push({
      eventType: 'enterprise.inventory.changed.v1',
      aggregateType: 'inventory',
      aggregateId: productId,
      aggregateVersion: afterVersion,
      payload: {
        entityType: 'inventory',
        entityId: productId,
        changedFields: ['inbound'],
        version: afterVersion,
        purchaseOrderId,
        purchaseOrderReference: reference,
        sourcePurchaseOrderId: source.id,
        onHandUnchanged: true,
      },
    });
  }

  return {
    resultEntityType: 'purchase_order',
    resultEntityId: purchaseOrderId,
    resultEntityVersion: 1,
    entityChanges: [
      {
        entityType: 'purchase_order',
        id: purchaseOrderId,
        beforeVersion: null,
        afterVersion: 1,
      },
      ...lineIds.map((id) => ({
        entityType: 'purchase_order_line' as const,
        id,
        beforeVersion: null,
        afterVersion: 1,
      })),
      {
        entityType: 'purchase_order',
        id: source.id,
        beforeVersion: source.version,
        afterVersion: sourceAfterVersion,
      },
      ...inventoryChanges.map((change) => ({
        entityType: 'inventory' as const,
        id: change.productId,
        beforeVersion: change.beforeVersion,
        afterVersion: change.afterVersion,
      })),
    ],
    outboxEvents,
  };
}

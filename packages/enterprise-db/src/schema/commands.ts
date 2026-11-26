import { sql } from 'drizzle-orm/sql';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers, enterpriseSchema, sandboxes, suppliers } from './supply.js';

const hashCheck = '^[a-f0-9]{64}$';

export const commandReceipts = enterpriseSchema.table(
  'command_receipts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    idempotencyKey: text('idempotency_key').notNull(),
    commandKind: text('command_kind').notNull(),
    actionRevisionId: uuid('action_revision_id').notNull(),
    itemId: uuid('item_id').notNull(),
    planHash: text('plan_hash').notNull(),
    itemHash: text('item_hash').notNull(),
    priorReceiptKeys: text('prior_receipt_keys').array().notNull().default(sql`'{}'::text[]`),
    executeBefore: timestamp('execute_before', { withTimezone: true }).notNull(),
    authorizationValidUntil: timestamp('authorization_valid_until', {
      withTimezone: true,
    }).notNull(),
    resultEntityType: text('result_entity_type').notNull(),
    resultEntityId: uuid('result_entity_id').notNull(),
    resultEntityVersion: integer('result_entity_version').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('command_receipts_sandbox_id_id_key').on(table.sandboxId, table.id),
    uniqueIndex('command_receipts_sandbox_id_idempotency_key_key').on(
      table.sandboxId,
      table.idempotencyKey,
    ),
    index('command_receipts_sandbox_revision_idx').on(
      table.sandboxId,
      table.actionRevisionId,
    ),
    index('command_receipts_sandbox_created_idx').on(
      table.sandboxId,
      table.createdAt,
      table.id,
    ),
    check(
      'command_receipts_kind_check',
      sql`${table.commandKind} IN ('enterprise.create_purchase_order', 'enterprise.send_message')`,
    ),
    check('command_receipts_plan_hash_check', sql`${table.planHash} ~ ${sql.raw(`'${hashCheck}'`)}`),
    check('command_receipts_item_hash_check', sql`${table.itemHash} ~ ${sql.raw(`'${hashCheck}'`)}`),
    check(
      'command_receipts_result_type_check',
      sql`${table.resultEntityType} IN ('purchase_order', 'communication')`,
    ),
    check(
      'command_receipts_result_version_check',
      sql`${table.resultEntityVersion} >= 1`,
    ),
    check('command_receipts_status_check', sql`${table.status} = 'succeeded'`),
    check(
      'command_receipts_idempotency_key_check',
      sql`${table.idempotencyKey} = ${table.sandboxId}::text || ':' || ${table.actionRevisionId}::text || ':' || ${table.itemId}::text || ':' || ${table.commandKind}`,
    ),
    check(
      'command_receipts_kind_result_check',
      sql`(${table.commandKind} = 'enterprise.create_purchase_order' AND ${table.resultEntityType} = 'purchase_order') OR (${table.commandKind} = 'enterprise.send_message' AND ${table.resultEntityType} = 'communication')`,
    ),
  ],
);

export const commandReceiptBaseVersions = enterpriseSchema.table(
  'command_receipt_base_versions',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    receiptId: uuid('receipt_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityReference: text('entity_reference'),
    expectedVersion: integer('expected_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('command_receipt_base_versions_receipt_ordinal_key').on(
      table.receiptId,
      table.ordinal,
    ),
    uniqueIndex('command_receipt_base_versions_receipt_entity_key').on(
      table.receiptId,
      table.entityType,
      table.entityId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.receiptId],
      foreignColumns: [commandReceipts.sandboxId, commandReceipts.id],
    }),
    check(
      'command_receipt_base_versions_ordinal_check',
      sql`${table.ordinal} >= 0 AND ${table.ordinal} < 50`,
    ),
    check(
      'command_receipt_base_versions_entity_type_check',
      sql`${table.entityType} IN ('sandbox', 'supplier', 'product', 'customer', 'agreement', 'purchase_order', 'inventory')`,
    ),
    check(
      'command_receipt_base_versions_reference_check',
      sql`${table.entityReference} IS NULL OR ${table.entityReference} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`,
    ),
    check(
      'command_receipt_base_versions_version_check',
      sql`${table.expectedVersion} >= 0`,
    ),
  ],
);

export const commandReceiptEntityChanges = enterpriseSchema.table(
  'command_receipt_entity_changes',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    receiptId: uuid('receipt_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    beforeVersion: integer('before_version'),
    afterVersion: integer('after_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('command_receipt_changes_receipt_ordinal_key').on(
      table.receiptId,
      table.ordinal,
    ),
    uniqueIndex('command_receipt_changes_receipt_entity_key').on(
      table.receiptId,
      table.entityType,
      table.entityId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.receiptId],
      foreignColumns: [commandReceipts.sandboxId, commandReceipts.id],
    }),
    check(
      'command_receipt_changes_ordinal_check',
      sql`${table.ordinal} >= 0 AND ${table.ordinal} < 100`,
    ),
    check(
      'command_receipt_changes_entity_type_check',
      sql`${table.entityType} IN ('purchase_order', 'purchase_order_line', 'inventory', 'communication')`,
    ),
    check(
      'command_receipt_changes_versions_check',
      sql`${table.beforeVersion} IS NULL OR ${table.afterVersion} = ${table.beforeVersion} + 1`,
    ),
  ],
);

export const communications = enterpriseSchema.table(
  'communications',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    recipientSupplierId: uuid('recipient_supplier_id'),
    recipientCustomerId: uuid('recipient_customer_id'),
    recipientReference: text('recipient_reference').notNull(),
    recipientVersion: integer('recipient_version').notNull(),
    subject: text('subject').notNull(),
    renderedText: text('rendered_text').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('communications_sandbox_id_id_key').on(table.sandboxId, table.id),
    index('communications_sandbox_created_idx').on(
      table.sandboxId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      columns: [table.sandboxId, table.recipientSupplierId],
      foreignColumns: [suppliers.sandboxId, suppliers.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.recipientCustomerId],
      foreignColumns: [customers.sandboxId, customers.id],
    }),
    check(
      'communications_recipient_check',
      sql`(${table.recipientSupplierId} IS NOT NULL AND ${table.recipientCustomerId} IS NULL) OR (${table.recipientSupplierId} IS NULL AND ${table.recipientCustomerId} IS NOT NULL)`,
    ),
    check('communications_reference_check', sql`${table.recipientReference} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`),
    check('communications_recipient_version_check', sql`${table.recipientVersion} >= 0`),
    check('communications_subject_check', sql`char_length(${table.subject}) BETWEEN 1 AND 200`),
    check('communications_text_check', sql`char_length(${table.renderedText}) BETWEEN 1 AND 5000`),
    check('communications_status_check', sql`${table.status} = 'simulated'`),
    check('communications_version_check', sql`${table.version} >= 1`),
  ],
);

export const communicationParts = enterpriseSchema.table(
  'communication_parts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    communicationId: uuid('communication_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    claimId: uuid('claim_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('communication_parts_communication_ordinal_key').on(
      table.communicationId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.sandboxId, table.communicationId],
      foreignColumns: [communications.sandboxId, communications.id],
    }),
    check(
      'communication_parts_ordinal_check',
      sql`${table.ordinal} >= 0 AND ${table.ordinal} < 20`,
    ),
    check(
      'communication_parts_kind_check',
      sql`${table.kind} IN ('text', 'verified_claim')`,
    ),
    check('communication_parts_text_check', sql`char_length(${table.text}) BETWEEN 1 AND 2000`),
    check(
      'communication_parts_claim_check',
      sql`(${table.kind} = 'verified_claim') = (${table.claimId} IS NOT NULL)`,
    ),
  ],
);

export const eventOutbox = enterpriseSchema.table(
  'event_outbox',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    eventType: text('event_type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateVersion: integer('aggregate_version').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    originActionRevisionId: uuid('origin_action_revision_id').notNull(),
    originItemId: uuid('origin_item_id').notNull(),
    originReceiptId: uuid('origin_receipt_id').notNull(),
    originReceiptKey: text('origin_receipt_key').notNull(),
  },
  (table) => [
    uniqueIndex('event_outbox_sandbox_id_id_key').on(table.sandboxId, table.id),
    index('event_outbox_status_next_attempt_idx').on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index('event_outbox_sandbox_origin_idx').on(
      table.sandboxId,
      table.originReceiptId,
    ),
    index('event_outbox_sandbox_aggregate_idx').on(
      table.sandboxId,
      table.aggregateType,
      table.aggregateId,
    ),
    foreignKey({
      columns: [table.sandboxId, table.originReceiptId],
      foreignColumns: [commandReceipts.sandboxId, commandReceipts.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.originReceiptKey],
      foreignColumns: [commandReceipts.sandboxId, commandReceipts.idempotencyKey],
    }),
    check(
      'event_outbox_type_check',
      sql`${table.eventType} IN ('enterprise.supplier.delay.v1', 'enterprise.inventory.changed.v1', 'enterprise.order.changed.v1', 'enterprise.invoice.changed.v1', 'enterprise.communication.created.v1')`,
    ),
    check('event_outbox_schema_version_check', sql`${table.schemaVersion} = 1`),
    check('event_outbox_correlation_check', sql`char_length(${table.correlationId}) BETWEEN 1 AND 128`),
    check(
      'event_outbox_aggregate_type_check',
      sql`${table.aggregateType} IN ('inventory', 'communication', 'purchase_order', 'supplier', 'invoice')`,
    ),
    check('event_outbox_aggregate_version_check', sql`${table.aggregateVersion} >= 1`),
    check(
      'event_outbox_status_check',
      sql`${table.status} IN ('pending', 'publishing', 'published', 'failed')`,
    ),
    check('event_outbox_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('event_outbox_version_check', sql`${table.version} >= 0`),
  ],
);

export type CommandReceiptRow = typeof commandReceipts.$inferSelect;
export type CommandReceiptBaseVersionRow = typeof commandReceiptBaseVersions.$inferSelect;
export type CommandReceiptEntityChangeRow = typeof commandReceiptEntityChanges.$inferSelect;
export type CommunicationRow = typeof communications.$inferSelect;
export type CommunicationPartRow = typeof communicationParts.$inferSelect;
export type EventOutboxRow = typeof eventOutbox.$inferSelect;

import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { cases, sandboxes } from './cases.js';

export const nexusSchema = pgSchema('nexus');

export const eventOutbox = nexusSchema.table(
  'event_outbox',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    eventType: text('event_type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    producer: text('producer').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateVersion: integer('aggregate_version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('event_outbox_sandbox_id_id_key').on(table.sandboxId, table.id),
    index('event_outbox_claim_idx').on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
  ],
);

export const eventInbox = nexusSchema.table(
  'event_inbox',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    producer: text('producer').notNull(),
    correlationId: text('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
    dispatchState: text('dispatch_state').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('event_inbox_consumer_event_key').on(
      table.consumerName,
      table.eventId,
    ),
    index('event_inbox_dispatch_idx').on(
      table.consumerName,
      table.dispatchState,
      table.nextAttemptAt,
      table.receivedAt,
    ),
  ],
);

export const deadLetters = nexusSchema.table(
  'dead_letters',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id'),
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id'),
    eventType: text('event_type'),
    exchange: text('exchange'),
    routingKey: text('routing_key'),
    producer: text('producer'),
    messageId: text('message_id'),
    bodySha256: text('body_sha256').notNull(),
    bodyBytes: integer('body_bytes').notNull(),
    reasonCode: text('reason_code').notNull(),
    reasonDetail: text('reason_detail').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('dead_letters_consumer_body_key').on(
      table.consumerName,
      table.bodySha256,
    ),
    index('dead_letters_created_idx').on(table.createdAt),
  ],
);

export const ingressKeys = nexusSchema.table(
  'ingress_keys',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    route: text('route').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    sourceType: text('source_type').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    caseId: uuid('case_id').notNull(),
    eventId: uuid('event_id').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('ingress_keys_actor_key').on(
      table.sandboxId,
      table.actorKind,
      table.actorId,
      table.route,
      table.idempotencyKey,
    ),
    uniqueIndex('ingress_keys_source_key').on(
      table.sandboxId,
      table.route,
      table.sourceType,
      table.sourceIdentity,
    ),
    foreignKey({
      columns: [table.sandboxId, table.caseId],
      foreignColumns: [cases.sandboxId, cases.id],
    }),
    foreignKey({
      columns: [table.sandboxId, table.eventId],
      foreignColumns: [eventOutbox.sandboxId, eventOutbox.id],
    }),
  ],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type EventInboxRow = typeof eventInbox.$inferSelect;
export type DeadLetterRow = typeof deadLetters.$inferSelect;
export type IngressKeyRow = typeof ingressKeys.$inferSelect;

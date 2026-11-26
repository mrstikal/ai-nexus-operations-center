import type { Pool } from 'pg';
import { EventPublisher, OutboxPublisher, type OutboxFailure, type OutboxRow, type OutboxStore } from '@nexus/messaging/publisher';
import {
  ENTERPRISE_EVENT_EXCHANGE,
  brokerConfigFromEnv,
  type BrokerConfig,
} from '@nexus/messaging/topology';
import { retryDelayMs } from '@nexus/messaging/retry';

interface EnterpriseOutboxDbRow {
  id: string;
  sandbox_id: string;
  event_type: string;
  schema_version: number;
  correlation_id: string;
  causation_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: Record<string, unknown>;
  attempt_count: number;
  version: number;
  created_at: Date;
  origin_action_revision_id: string;
  origin_item_id: string;
  origin_receipt_key: string;
  origin_receipt_id: string;
}

interface CommunicationDbRow {
  id: string;
  sandbox_id: string;
  recipient_customer_id: string | null;
  recipient_supplier_id: string | null;
  version: number;
  created_at: Date;
}

function normalizedPayload(
  row: EnterpriseOutboxDbRow,
  communication: CommunicationDbRow | undefined,
): Record<string, unknown> {
  if (row.event_type === 'enterprise.communication.created.v1') {
    return {
      communicationId: row.aggregate_id,
      customerId: communication?.recipient_customer_id ?? null,
      ...(communication?.recipient_supplier_id === null ||
      communication?.recipient_supplier_id === undefined
        ? {}
        : { supplierId: communication.recipient_supplier_id }),
      orderId: null,
      version: communication?.version ?? row.aggregate_version,
      createdAt: (communication?.created_at ?? row.created_at).toISOString(),
    };
  }
  if (row.event_type === 'enterprise.supplier.delay.v1') {
    return row.payload;
  }
  return {
    entityType: row.payload['entityType'],
    entityId: row.payload['entityId'],
    version: row.payload['version'] ?? row.aggregate_version,
    changedFields: row.payload['changedFields'],
    originatingRevisionId: row.origin_action_revision_id,
    originatingItemId: row.origin_item_id,
    originatingReceiptKey: row.origin_receipt_key,
  };
}

function toOutboxRow(
  row: EnterpriseOutboxDbRow,
  communication: CommunicationDbRow | undefined,
): OutboxRow {
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    producer: 'enterprise-sim',
    occurredAt: row.created_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    payload: normalizedPayload(row, communication),
    attemptCount: row.attempt_count,
    version: row.version,
  };
}

export function createEnterpriseOutboxStore(pool: Pool): OutboxStore {
  return {
    async claim(limit, claimTimeoutMs): Promise<OutboxRow[]> {
      const result = await pool.query<EnterpriseOutboxDbRow>(
        `WITH candidates AS (
           SELECT id
           FROM enterprise.event_outbox
           WHERE (status = 'pending' AND next_attempt_at <= clock_timestamp())
              OR (
                status = 'publishing'
                AND updated_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
              )
           ORDER BY created_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE enterprise.event_outbox AS outbox
         SET status = 'publishing',
             attempt_count = outbox.attempt_count + 1,
             version = outbox.version + 1,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.*`,
        [limit, claimTimeoutMs],
      );
      const communications = new Map<string, CommunicationDbRow>();
      const communicationRows = result.rows.filter(
        (row) => row.event_type === 'enterprise.communication.created.v1',
      );
      for (const candidate of communicationRows) {
        const rows = await pool.query<CommunicationDbRow>(
          `SELECT id, sandbox_id, recipient_customer_id, recipient_supplier_id,
                  version, created_at
           FROM enterprise.communications
           WHERE sandbox_id = $1 AND id = $2`,
          [candidate.sandbox_id, candidate.aggregate_id],
        );
        const row = rows.rows[0];
        if (row) {
          communications.set(row.id, row);
        }
      }
      return result.rows.map((row) => toOutboxRow(row, communications.get(row.aggregate_id)));
    },

    async markPublished(row): Promise<void> {
      await pool.query(
        `UPDATE enterprise.event_outbox
         SET status = 'published',
             last_error = NULL,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND version = $2 AND status = 'publishing'`,
        [row.id, row.version],
      );
    },

    async markFailed(row, failure: OutboxFailure): Promise<void> {
      if (!failure.retryable) {
        await pool.query(
          `UPDATE enterprise.event_outbox
           SET status = 'failed',
               last_error = $3,
               version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1 AND version = $2 AND status = 'publishing'`,
          [row.id, row.version, failure.code.slice(0, 200)],
        );
        return;
      }
      const delay = retryDelayMs(row.attemptCount);
      await pool.query(
        `UPDATE enterprise.event_outbox
         SET status = 'pending',
             last_error = $3,
             next_attempt_at = clock_timestamp() + make_interval(secs => $4::double precision / 1000.0),
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND version = $2 AND status = 'publishing'`,
        [row.id, row.version, failure.code.slice(0, 200), delay],
      );
    },
  };
}

export interface EnterpriseOutboxRuntime {
  stop(): Promise<void>;
}

export function startEnterpriseOutbox(
  pool: Pool,
  broker: BrokerConfig | null,
  options: { readonly claimTimeoutMs?: number } = {},
): EnterpriseOutboxRuntime | null {
  if (!broker) {
    return null;
  }
  const publisher = new OutboxPublisher(
    createEnterpriseOutboxStore(pool),
    new EventPublisher(broker),
    {
      exchange: ENTERPRISE_EVENT_EXCHANGE,
      claimTimeoutMs: options.claimTimeoutMs ?? 30_000,
      pollIntervalMs: 250,
      batchSize: 10,
    },
  );
  publisher.start();
  return {
    stop: () => publisher.stop(),
  };
}

export function enterpriseOutboxBroker(): BrokerConfig | null {
  return brokerConfigFromEnv();
}

import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  EventConsumer,
  InboxRejectedError,
  type InboxAcceptanceStore,
} from '@nexus/messaging/consumer';
import {
  EventPublisher,
  OutboxPublisher,
  type OutboxFailure,
  type OutboxRow,
  type OutboxStore,
} from '@nexus/messaging/publisher';
import {
  NEXUS_EVENT_EXCHANGE,
  brokerConfigFromEnv,
} from '@nexus/messaging/topology';
import { retryDelayMs } from '@nexus/messaging/retry';
import type {
  DeadLetterInput,
  DeadLetterStore,
} from '@nexus/messaging/dead-letter';
import type { EventEnvelope } from '@nexus/contracts';
import { createNexusPool } from '@nexus/db/connection';

const CONSUMER_NAME = 'nexus.worker.events.v1';
const OUTBOX_POLL_MS = 250;
const OUTBOX_BATCH_SIZE = 10;

interface OutboxDbRow {
  id: string;
  sandbox_id: string;
  event_type: string;
  schema_version: number;
  producer: string;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: Record<string, unknown>;
  attempt_count: number;
  version: number;
}

function toOutboxRow(row: OutboxDbRow): OutboxRow {
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    producer: row.producer,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    payload: row.payload,
    attemptCount: row.attempt_count,
    version: row.version,
  };
}

function createOutboxStore(pool: Pool): OutboxStore {
  return {
    async claim(limit, claimTimeoutMs): Promise<OutboxRow[]> {
      const result = await pool.query<OutboxDbRow>(
        `WITH candidates AS (
           SELECT id
           FROM nexus.event_outbox
           WHERE (status = 'pending' AND next_attempt_at <= clock_timestamp())
              OR (
                status = 'publishing'
                AND updated_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000.0)
              )
           ORDER BY created_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE nexus.event_outbox AS outbox
         SET status = 'publishing',
             attempt_count = outbox.attempt_count + 1,
             version = outbox.version + 1,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.*`,
        [limit, claimTimeoutMs],
      );
      return result.rows.map(toOutboxRow);
    },

    async markPublished(row): Promise<void> {
      await pool.query(
        `UPDATE nexus.event_outbox
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
          `UPDATE nexus.event_outbox
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
        `UPDATE nexus.event_outbox
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

function createInboxStore(pool: Pool): InboxAcceptanceStore {
  return {
    async accept(envelope: EventEnvelope<unknown>): Promise<'accepted' | 'duplicate'> {
      const sandbox = await pool.query(
        'SELECT 1 FROM nexus.sandboxes WHERE id = $1',
        [envelope.sandboxId],
      );
      if (sandbox.rowCount !== 1) {
        throw new InboxRejectedError(
          'UNKNOWN_SANDBOX',
          'Event references a sandbox that does not exist',
        );
      }
      const result = await pool.query(
        `INSERT INTO nexus.event_inbox
           (id, sandbox_id, consumer_name, event_id, event_type, producer,
            correlation_id, causation_id, occurred_at, envelope, dispatch_state,
            attempt_count, next_attempt_at, received_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending',
                 0, clock_timestamp(), clock_timestamp(), clock_timestamp())
         ON CONFLICT (consumer_name, event_id) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          envelope.sandboxId,
          CONSUMER_NAME,
          envelope.eventId,
          envelope.eventType,
          envelope.producer,
          envelope.correlationId,
          envelope.causationId,
          new Date(envelope.occurredAt),
          JSON.stringify(envelope),
        ],
      );
      return result.rowCount === 1 ? 'accepted' : 'duplicate';
    },
  };
}

function createDeadLetterStore(pool: Pool): DeadLetterStore {
  return {
    async record(input: DeadLetterInput & { readonly bodySha256: string }): Promise<void> {
      await pool.query(
        `INSERT INTO nexus.dead_letters
           (id, sandbox_id, consumer_name, event_id, event_type, exchange,
            routing_key, producer, message_id, body_sha256, body_bytes,
            reason_code, reason_detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (consumer_name, body_sha256) DO NOTHING`,
        [
          randomUUID(),
          input.sandboxId,
          input.consumerName,
          input.eventId,
          input.eventType,
          input.exchange,
          input.routingKey,
          input.producer,
          input.messageId,
          input.bodySha256,
          input.body.byteLength,
          input.reasonCode,
          input.reasonDetail,
        ],
      );
    },
  };
}

@Injectable()
export class MessagingRuntime implements OnModuleInit, OnModuleDestroy {
  #pool: Pool | null = null;
  #publisher: OutboxPublisher | null = null;
  #consumer: EventConsumer | null = null;

  onModuleInit(): void {
    let pool: Pool;
    try {
      pool = createNexusPool('worker');
    } catch {
      return;
    }
    const broker = brokerConfigFromEnv();
    if (!broker) {
      void pool.end();
      return;
    }
    const claimTimeoutRaw = process.env['NEXUS_OUTBOX_CLAIM_TIMEOUT_MS'] ?? '30000';
    const claimTimeoutMs = Number(claimTimeoutRaw);
    this.#pool = pool;
    this.#publisher = new OutboxPublisher(
      createOutboxStore(pool),
      new EventPublisher(broker),
      {
        exchange: NEXUS_EVENT_EXCHANGE,
        batchSize: OUTBOX_BATCH_SIZE,
        pollIntervalMs: OUTBOX_POLL_MS,
        claimTimeoutMs:
          Number.isInteger(claimTimeoutMs) && claimTimeoutMs >= 100
            ? claimTimeoutMs
            : 30_000,
      },
    );
    this.#consumer = new EventConsumer({
      config: broker,
      consumerName: CONSUMER_NAME,
      inbox: createInboxStore(pool),
      deadLetters: createDeadLetterStore(pool),
      prefetch: 8,
    });
    this.#consumer.start();
    this.#publisher.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#publisher?.stop();
    await this.#consumer?.stop();
    await this.#pool?.end();
    this.#publisher = null;
    this.#consumer = null;
    this.#pool = null;
  }
}

@Module({
  providers: [MessagingRuntime],
})
export class MessagingModule {}

import { connect } from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { parseEventEnvelope, type EventEnvelope } from '@nexus/contracts';
import {
  ENTERPRISE_EVENT_EXCHANGE,
  NEXUS_EVENT_EXCHANGE,
  assertExchangeForEnvelope,
  declareTopology,
  type BrokerConfig,
} from './topology.js';
import { retryDelayMs, sleep } from './retry.js';

export interface OutboxRow {
  readonly id: string;
  readonly sandboxId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Record<string, unknown>;
  readonly attemptCount: number;
  readonly version: number;
}

export interface OutboxFailure {
  readonly retryable: boolean;
  readonly code: string;
}

export interface OutboxStore {
  claim(limit: number, claimTimeoutMs: number): Promise<OutboxRow[]>;
  markPublished(row: OutboxRow): Promise<void>;
  markFailed(row: OutboxRow, failure: OutboxFailure): Promise<void>;
}

export interface OutboxPublisherOptions {
  readonly exchange: string;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly claimTimeoutMs?: number;
}

export function envelopeFromOutbox(row: OutboxRow): EventEnvelope<unknown> {
  return parseEventEnvelope({
    eventId: row.id,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    occurredAt: row.occurredAt.toISOString(),
    sandboxId: row.sandboxId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    producer: row.producer,
    payload: row.payload,
  });
}

export class EventPublisher {
  readonly #config: BrokerConfig;
  #connection: ChannelModel | null = null;
  #channel: ConfirmChannel | null = null;

  constructor(config: BrokerConfig) {
    this.#config = config;
  }

  async publish(
    exchange: string,
    envelope: EventEnvelope<unknown>,
  ): Promise<void> {
    assertExchangeForEnvelope(exchange, envelope);
    const channel = await this.#ensureChannel();
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');
    const accepted = channel.publish(exchange, envelope.eventType, body, {
      persistent: true,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      messageId: envelope.eventId,
      correlationId: envelope.correlationId,
      type: envelope.eventType,
      appId: envelope.producer,
      timestamp: Math.floor(Date.now() / 1000),
    });
    if (!accepted) {
      await new Promise<void>((resolve) => {
        channel.once('drain', () => resolve());
      });
    }
    await channel.waitForConfirms();
  }

  async close(): Promise<void> {
    const channel = this.#channel;
    const connection = this.#connection;
    this.#channel = null;
    this.#connection = null;
    if (channel) {
      try {
        await channel.close();
      } catch {
        // Closing a broken channel is best-effort.
      }
    }
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Closing a broken connection is best-effort.
      }
    }
  }

  async #ensureChannel(): Promise<ConfirmChannel> {
    if (this.#channel) {
      return this.#channel;
    }
    const connection = await connect({
      protocol: 'amqp',
      hostname: this.#config.host,
      port: this.#config.port,
      username: this.#config.username,
      password: this.#config.password,
      vhost: this.#config.vhost,
      heartbeat: this.#config.heartbeatSeconds ?? 10,
    });
    connection.on('error', () => undefined);
    connection.on('close', () => {
      this.#channel = null;
      if (this.#connection === connection) {
        this.#connection = null;
      }
    });
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => undefined);
    channel.on('close', () => {
      if (this.#channel === channel) {
        this.#channel = null;
      }
    });
    await declareTopology(channel);
    this.#connection = connection;
    this.#channel = channel;
    return channel;
  }
}

export class OutboxPublisher {
  readonly #store: OutboxStore;
  readonly #publisher: EventPublisher;
  readonly #exchange: string;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #claimTimeoutMs: number;
  #running = false;
  #failureCount = 0;
  #loop: Promise<void> | null = null;
  readonly #stopSignal: Promise<void>;
  #stopResolve: (() => void) | null = null;

  constructor(
    store: OutboxStore,
    publisher: EventPublisher,
    options: OutboxPublisherOptions,
  ) {
    this.#store = store;
    this.#publisher = publisher;
    this.#exchange = options.exchange;
    this.#batchSize = options.batchSize ?? 10;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
    this.#stopSignal = new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
    });
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopResolve?.();
    await this.#loop?.catch(() => undefined);
    await this.#publisher.close();
  }

  async #wait(milliseconds: number): Promise<void> {
    await Promise.race([sleep(milliseconds), this.#stopSignal]);
  }

  async #run(): Promise<void> {
    while (this.#running) {
      let rows: OutboxRow[];
      try {
        rows = await this.#store.claim(this.#batchSize, this.#claimTimeoutMs);
      } catch {
        await this.#backoff();
        continue;
      }
      if (rows.length === 0) {
        await this.#wait(this.#pollIntervalMs);
        continue;
      }
      for (const row of rows) {
        if (!this.#running) {
          return;
        }
        let envelope: EventEnvelope<unknown>;
        try {
          envelope = envelopeFromOutbox(row);
        } catch {
          await this.#store
            .markFailed(row, { retryable: false, code: 'SCHEMA_INVALID' })
            .catch(() => undefined);
          continue;
        }
        try {
          await this.#publisher.publish(this.#exchange, envelope);
        } catch {
          await this.#store
            .markFailed(row, { retryable: true, code: 'PUBLISH_FAILED' })
            .catch(() => undefined);
          await this.#backoff();
          break;
        }
        try {
          await this.#store.markPublished(row);
          this.#failureCount = 0;
        } catch {
          await this.#backoff();
          break;
        }
      }
    }
  }

  async #backoff(): Promise<void> {
    const delay = retryDelayMs(this.#failureCount + 1);
    this.#failureCount = Math.min(this.#failureCount + 1, 10);
    await this.#publisher.close();
    await this.#wait(delay);
  }
}

export const OUTBOX_EXCHANGES = {
  nexus: NEXUS_EVENT_EXCHANGE,
  enterprise: ENTERPRISE_EVENT_EXCHANGE,
} as const;

import { connect } from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import {
  parseEventEnvelope,
  type EventEnvelope,
} from '@nexus/contracts';
import {
  ENTERPRISE_EVENT_EXCHANGE,
  NEXUS_EVENT_EXCHANGE,
  WORK_EVENT_QUEUE,
  type BrokerConfig,
} from './topology.js';
import {
  bodySha256,
  boundedDeadLetterDetail,
  type DeadLetterReasonCode,
  type DeadLetterStore,
} from './dead-letter.js';
import { retryDelayMs, sleep } from './retry.js';
import { declareTopology } from './topology.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function boundedOrNull(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function producerOrNull(value: unknown): string | null {
  return value === 'api' || value === 'worker' || value === 'enterprise-sim'
    ? value
    : null;
}

export interface InboxAcceptanceStore {
  accept(envelope: EventEnvelope<unknown>): Promise<'accepted' | 'duplicate'>;
}

export class InboxRejectedError extends Error {
  readonly reasonCode: DeadLetterReasonCode;

  constructor(reasonCode: DeadLetterReasonCode, message: string) {
    super(message);
    this.name = 'InboxRejectedError';
    this.reasonCode = reasonCode;
  }
}

export interface EventConsumerOptions {
  readonly config: BrokerConfig;
  readonly consumerName: string;
  readonly inbox: InboxAcceptanceStore;
  readonly deadLetters: DeadLetterStore;
  readonly queue?: string;
  readonly prefetch?: number;
}

function parseBody(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8')) as unknown;
}

function reasonForParseError(error: unknown): DeadLetterReasonCode {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Unknown event type')) {
    return 'UNKNOWN_EVENT';
  }
  if (message.startsWith('Producer ')) {
    return 'PRODUCER_MISMATCH';
  }
  return 'SCHEMA_INVALID';
}

export class EventConsumer {
  readonly #options: EventConsumerOptions;
  readonly #queue: string;
  readonly #prefetch: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #connection: ChannelModel | null = null;
  #channel: Channel | null = null;
  #consumerTag: string | null = null;
  #closeWaiters = new Set<() => void>();
  #failureCount = 0;

  constructor(options: EventConsumerOptions) {
    this.#options = options;
    this.#queue = options.queue ?? WORK_EVENT_QUEUE;
    this.#prefetch = options.prefetch ?? 8;
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
    await this.#closeChannel();
    for (const resolve of this.#closeWaiters) {
      resolve();
    }
    this.#closeWaiters.clear();
    await this.#loop?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.#connectAndConsume();
      } catch {
        await this.#closeChannel();
      }
      if (!this.#running) {
        break;
      }
      this.#failureCount = Math.min(this.#failureCount + 1, 10);
      await sleep(retryDelayMs(this.#failureCount));
    }
  }

  async #connectAndConsume(): Promise<void> {
    const connection = await connect({
      protocol: 'amqp',
      hostname: this.#options.config.host,
      port: this.#options.config.port,
      username: this.#options.config.username,
      password: this.#options.config.password,
      vhost: this.#options.config.vhost,
      heartbeat: this.#options.config.heartbeatSeconds ?? 10,
    });
    connection.on('error', () => undefined);
    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    await declareTopology(channel);
    await channel.prefetch(this.#prefetch);
    this.#connection = connection;
    this.#channel = channel;

    const closed = new Promise<void>((resolve) => {
      this.#closeWaiters.add(resolve);
      connection.once('close', resolve);
      channel.once('close', resolve);
    });

    const consumer = await channel.consume(
      this.#queue,
      (message) => {
        if (!message) {
          return;
        }
        void this.#handleMessage(message).catch(async () => {
          await this.#closeChannel();
        });
      },
      { noAck: false },
    );
    this.#consumerTag = consumer.consumerTag;
    await closed;
    this.#closeWaiters.clear();
  }

  async #closeChannel(): Promise<void> {
    const channel = this.#channel;
    const connection = this.#connection;
    this.#channel = null;
    this.#connection = null;
    const consumerTag = this.#consumerTag;
    this.#consumerTag = null;
    if (channel) {
      if (consumerTag !== null) {
        try {
          await channel.cancel(consumerTag);
        } catch {
          // Cancelling a broken consumer is best-effort.
        }
      }
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
    for (const resolve of this.#closeWaiters) {
      resolve();
    }
  }

  async #handleMessage(message: ConsumeMessage): Promise<void> {
    const channel = this.#channel;
    if (!channel) {
      return;
    }
    const body = message.content;
    const exchange = message.fields.exchange;

    if (body.byteLength > MAX_MESSAGE_BYTES) {
      await this.#deadLetter(message, {
        parsedBody: null,
        reasonCode: 'PAYLOAD_TOO_LARGE',
        reasonDetail: `Message body exceeds ${MAX_MESSAGE_BYTES} bytes`,
      });
      channel.nack(message, false, false);
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseBody(body);
    } catch {
      await this.#deadLetter(message, {
        parsedBody: null,
        reasonCode: 'SCHEMA_INVALID',
        reasonDetail: 'Message body is not valid UTF-8 JSON',
      });
      channel.nack(message, false, false);
      return;
    }

    if (exchange !== NEXUS_EVENT_EXCHANGE && exchange !== ENTERPRISE_EVENT_EXCHANGE) {
      await this.#deadLetter(message, {
        parsedBody: parsed,
        reasonCode: 'EXCHANGE_MISMATCH',
        reasonDetail: 'Message arrived through an unrecognized exchange',
      });
      channel.nack(message, false, false);
      return;
    }

    const eventType =
      typeof parsed === 'object' && parsed !== null && 'eventType' in parsed
        ? (parsed as { eventType: unknown }).eventType
        : null;
    if (
      typeof eventType !== 'string' ||
      (exchange === NEXUS_EVENT_EXCHANGE && !eventType.startsWith('nexus.')) ||
      (exchange === ENTERPRISE_EVENT_EXCHANGE &&
        !eventType.startsWith('enterprise.'))
    ) {
      await this.#deadLetter(message, {
        parsedBody: parsed,
        reasonCode: 'EXCHANGE_MISMATCH',
        reasonDetail: 'Event type prefix does not match the source exchange',
      });
      channel.nack(message, false, false);
      return;
    }

    let envelope: EventEnvelope<unknown>;
    try {
      envelope = parseEventEnvelope(parsed);
    } catch (error) {
      await this.#deadLetter(message, {
        parsedBody: parsed,
        reasonCode: reasonForParseError(error),
        reasonDetail:
          error instanceof Error ? error.message : 'Envelope validation failed',
      });
      channel.nack(message, false, false);
      return;
    }

    try {
      await this.#options.inbox.accept(envelope);
      this.#failureCount = 0;
    } catch (error) {
      if (error instanceof InboxRejectedError) {
        await this.#deadLetter(message, {
          parsedBody: parsed,
          reasonCode: error.reasonCode,
          reasonDetail: error.message,
        });
        channel.nack(message, false, false);
        return;
      }
      throw error;
    }
    channel.ack(message);
  }

  async #deadLetter(
    message: ConsumeMessage,
    input: {
      readonly parsedBody: unknown;
      readonly reasonCode: DeadLetterReasonCode;
      readonly reasonDetail: string;
    },
  ): Promise<void> {
    const body = message.content;
    const parsed = message.properties;
    const envelope =
      typeof input.parsedBody === 'object' && input.parsedBody !== null
        ? (input.parsedBody as Record<string, unknown>)
        : null;
    const sandboxId = uuidOrNull(envelope?.['sandboxId']);
    const eventId = uuidOrNull(envelope?.['eventId']);
    const eventType = boundedOrNull(envelope?.['eventType'], 100);
    const producer = producerOrNull(envelope?.['producer']);
    await this.#options.deadLetters.record({
      consumerName: this.#options.consumerName,
      sandboxId,
      eventId,
      eventType,
      exchange: boundedOrNull(message.fields.exchange, 100),
      routingKey: boundedOrNull(message.fields.routingKey, 100),
      producer,
      messageId: boundedOrNull(parsed.messageId, 200),
      body,
      parsedBody: envelope,
      bodySha256: bodySha256(body),
      reasonCode: input.reasonCode,
      reasonDetail: boundedDeadLetterDetail(input.reasonDetail),
    });
  }
}

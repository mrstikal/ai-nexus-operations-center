import type { Channel, ConfirmChannel } from 'amqplib';
import type { EventEnvelope } from '@nexus/contracts';

export const NEXUS_EVENT_EXCHANGE = 'nexus.events';
export const ENTERPRISE_EVENT_EXCHANGE = 'enterprise.events';
export const WORK_EVENT_QUEUE = 'nexus.worker.events';
export const DEAD_LETTER_EXCHANGE = 'nexus.events.dlx';
export const DEAD_LETTER_QUEUE = 'nexus.worker.events.dlq';
export const DEAD_LETTER_ROUTING_KEY = 'dead';

export interface BrokerConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly vhost: string;
  readonly heartbeatSeconds?: number;
}

function required(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}

export function brokerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrokerConfig | null {
  const password = required(env, ['NEXUS_RABBIT_PASSWORD', 'RABBITMQ_DEFAULT_PASS']);
  if (password === null) {
    return null;
  }
  const portRaw = required(env, [
    'NEXUS_RABBIT_PORT',
    'NEXUS_RABBIT_DEV_PORT',
    'RABBITMQ_PORT',
  ]);
  const port = portRaw === null ? 5672 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('RabbitMQ port is invalid');
  }
  return {
    host: required(env, ['NEXUS_RABBIT_HOST', 'RABBITMQ_HOST']) ?? '127.0.0.1',
    port,
    username:
      required(env, ['NEXUS_RABBIT_USER', 'RABBITMQ_DEFAULT_USER']) ?? 'nexus_app',
    password,
    vhost: required(env, ['NEXUS_RABBIT_VHOST']) ?? '/nexus',
    heartbeatSeconds: 10,
  };
}

export function assertExchangeForEnvelope(
  exchange: string,
  envelope: EventEnvelope<unknown>,
): void {
  if (exchange === NEXUS_EVENT_EXCHANGE) {
    if (!envelope.eventType.startsWith('nexus.')) {
      throw new Error('A Nexus exchange accepts only Nexus event types');
    }
    if (envelope.producer === 'enterprise-sim') {
      throw new Error('A Nexus exchange rejects the enterprise producer');
    }
    return;
  }
  if (exchange === ENTERPRISE_EVENT_EXCHANGE) {
    if (!envelope.eventType.startsWith('enterprise.')) {
      throw new Error('An enterprise exchange accepts only enterprise event types');
    }
    if (envelope.producer !== 'enterprise-sim') {
      throw new Error('An enterprise exchange requires the enterprise producer');
    }
    return;
  }
  throw new Error(`Unknown event exchange ${exchange}`);
}

export async function declareTopology(
  channel: ConfirmChannel | Channel,
): Promise<void> {
  await channel.assertExchange(NEXUS_EVENT_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(ENTERPRISE_EVENT_EXCHANGE, 'topic', {
    durable: true,
  });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', {
    durable: true,
  });
  await channel.assertQueue(WORK_EVENT_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': DEAD_LETTER_ROUTING_KEY,
    },
  });
  await channel.bindQueue(WORK_EVENT_QUEUE, NEXUS_EVENT_EXCHANGE, '#');
  await channel.bindQueue(WORK_EVENT_QUEUE, ENTERPRISE_EVENT_EXCHANGE, '#');
  await channel.assertQueue(DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(
    DEAD_LETTER_QUEUE,
    DEAD_LETTER_EXCHANGE,
    DEAD_LETTER_ROUTING_KEY,
  );
}

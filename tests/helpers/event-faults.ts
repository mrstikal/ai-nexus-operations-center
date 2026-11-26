import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { declareTopology } from '@nexus/messaging/topology';

export interface TestBroker {
  readonly connection: ChannelModel;
  readonly channel: ConfirmChannel;
  close(): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F10`);
  }
  return value;
}

export function testBrokerEnv(): Record<string, string> {
  return {
    NEXUS_RABBIT_HOST: requiredEnv('NEXUS_TEST_RABBIT_HOST'),
    NEXUS_RABBIT_PORT: requiredEnv('NEXUS_TEST_RABBIT_PORT'),
    NEXUS_RABBIT_USER: requiredEnv('NEXUS_TEST_RABBIT_USER'),
    NEXUS_RABBIT_PASSWORD: requiredEnv('NEXUS_TEST_RABBIT_PASSWORD'),
    NEXUS_RABBIT_VHOST: requiredEnv('NEXUS_TEST_RABBIT_VHOST'),
  };
}

export async function connectTestBroker(): Promise<TestBroker> {
  const connection = await connect({
    protocol: 'amqp',
    hostname: requiredEnv('NEXUS_TEST_RABBIT_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_RABBIT_PORT')),
    username: requiredEnv('NEXUS_TEST_RABBIT_USER'),
    password: requiredEnv('NEXUS_TEST_RABBIT_PASSWORD'),
    vhost: requiredEnv('NEXUS_TEST_RABBIT_VHOST'),
  });
  const channel = await connection.createConfirmChannel();
  await declareTopology(channel);
  return {
    connection,
    channel,
    async close() {
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}

export async function publishRaw(
  broker: TestBroker,
  exchange: string,
  routingKey: string,
  body: unknown,
  messageId: string = randomUUID(),
): Promise<void> {
  broker.channel.publish(
    exchange,
    routingKey,
    Buffer.from(JSON.stringify(body), 'utf8'),
    {
      persistent: true,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      messageId,
      type: routingKey,
      appId: 'f10-test',
    },
  );
  await broker.channel.waitForConfirms();
}

export async function queueDepth(
  broker: TestBroker,
  queue: string,
): Promise<number> {
  const result = await broker.channel.checkQueue(queue);
  return result.messageCount;
}

export async function waitFor<T>(
  operation: () => Promise<T | null>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for the expected event state');
}

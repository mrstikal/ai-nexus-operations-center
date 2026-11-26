import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createApiApp } from './app.js';

const port = Number(process.env['PORT'] ?? '3001');

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env['PORT'] ?? ''}`);
}

const app = await createApiApp();
await app.listen(port, '127.0.0.1');

const address = app.getHttpServer().address() as AddressInfo | string | null;

if (!address || typeof address === 'string') {
  throw new Error('API did not expose a TCP address');
}

let stopping = false;

const stop = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }

  stopping = true;
  console.log(`NEXUS_API_STOPPING signal=${signal}`);
  await app.close();
  console.log('NEXUS_API_STOPPED');
  process.exit(0);
};

process.on('SIGTERM', () => {
  void stop('SIGTERM');
});

process.on('SIGINT', () => {
  void stop('SIGINT');
});

console.log(`NEXUS_API_READY port=${address.port}`);

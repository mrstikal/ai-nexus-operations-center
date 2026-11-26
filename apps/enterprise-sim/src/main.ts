import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createEnterprisePool } from '@nexus/enterprise-db/connection';
import type { Pool } from 'pg';
import {
  configuredReadToken,
  ENTERPRISE_DB_POOL,
  EnterpriseReadGuard,
  ProblemFilter,
} from './auth.js';
import { ReadController } from './read-controller.js';

@Module({
  controllers: [ReadController],
  providers: [
    {
      provide: ENTERPRISE_DB_POOL,
      useFactory: (): Pool => createEnterprisePool(),
    },
    EnterpriseReadGuard,
  ],
})
class EnterpriseSimulatorModule {}

const port = Number(process.env['PORT'] ?? '3002');

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env['PORT'] ?? ''}`);
}

configuredReadToken();

const app = await NestFactory.create(EnterpriseSimulatorModule, { logger: false });
app.useGlobalFilters(new ProblemFilter());
await app.listen(port, '127.0.0.1');

const address = app.getHttpServer().address() as AddressInfo | string | null;

if (!address || typeof address === 'string') {
  throw new Error('Enterprise simulator did not expose a TCP address');
}

const pool = app.get<Pool>(ENTERPRISE_DB_POOL);
let stopping = false;

const stop = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }

  stopping = true;
  console.log(`ENTERPRISE_SIM_STOPPING signal=${signal}`);
  await app.close();
  await pool.end();
  console.log('ENTERPRISE_SIM_STOPPED');
  process.exit(0);
};

process.on('SIGTERM', () => {
  void stop('SIGTERM');
});

process.on('SIGINT', () => {
  void stop('SIGINT');
});

console.log(`ENTERPRISE_SIM_READY port=${address.port}`);

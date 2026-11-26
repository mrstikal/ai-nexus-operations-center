import { Inject, Injectable, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MessagingModule } from './messaging.module.js';

export const WORKER_PROVIDER = 'NEXUS_WORKER_PROVIDER';

export interface WorkerProvider {
  readonly name: string;
  readonly ready: boolean;
}

@Injectable()
export class WorkerStatus {
  constructor(@Inject(WORKER_PROVIDER) readonly provider: WorkerProvider) {}
}

@Module({
  imports: [MessagingModule],
  providers: [
    {
      provide: WORKER_PROVIDER,
      useFactory: (): WorkerProvider => ({ name: 'f01-worker-provider', ready: true }),
    },
    WorkerStatus,
  ],
})
export class WorkerModule {}

export async function createWorkerContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule, { logger: false });
}

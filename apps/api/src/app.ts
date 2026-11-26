import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthModule } from './auth/module.js';
import { CasesModule } from './cases/module.js';
import { ActionsModule } from './actions.module.js';
import { IngressModule } from './ingress/module.js';
import { ProposalsModule } from './proposals/module.js';
import { RunsModule } from './runs/module.js';
import { ProblemFilter } from './errors.js';

export const HEALTH_PROVIDER = 'NEXUS_HEALTH_PROVIDER';

export interface HealthProvider {
  readonly name: string;
  readonly ready: boolean;
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'api';
  readonly provider: string;
  readonly ready: boolean;
  readonly injected: true;
}

@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_PROVIDER) private readonly provider: HealthProvider) {}

  @Get()
  read(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      provider: this.provider.name,
      ready: this.provider.ready,
      injected: true,
    };
  }
}

@Module({
  imports: [AuthModule, ActionsModule, CasesModule, IngressModule, RunsModule, ProposalsModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_PROVIDER,
      useFactory: (): HealthProvider => ({ name: 'f01-injected-provider', ready: true }),
    },
  ],
})
export class ApiModule {}

export async function createApiApp(): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule, { logger: false });
  app.useGlobalFilters(new ProblemFilter());
  return app;
}

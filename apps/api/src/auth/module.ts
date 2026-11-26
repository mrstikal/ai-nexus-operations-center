import { Module } from '@nestjs/common';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createIdentityStore } from '@nexus/db/repositories/identity';
import type { IdentityStore } from '@nexus/application/identity/sessions';
import { LoginRateLimiter } from '@nexus/integrations/rate-limits';
import { AuthController } from './controller.js';
import {
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
} from './guards.js';
import { LOGIN_RATE_LIMITER, NEXUS_DB } from './tokens.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: NEXUS_DB,
      useFactory: (): IdentityStore | null => {
        try {
          return createIdentityStore(createNexusDb(createNexusPool()));
        } catch {
          return null;
        }
      },
    },
    {
      provide: LOGIN_RATE_LIMITER,
      useFactory: (): LoginRateLimiter => LoginRateLimiter.fromEnv(),
    },
    SessionAuthGuard,
    SessionCsrfGuard,
    RolesGuard,
  ],
  exports: [
    NEXUS_DB,
    LOGIN_RATE_LIMITER,
    SessionAuthGuard,
    SessionCsrfGuard,
    RolesGuard,
  ],
})
export class AuthModule {}

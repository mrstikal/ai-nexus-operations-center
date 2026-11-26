import { Module } from '@nestjs/common';
import { IngressService } from '@nexus/application/ingress/service';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createIngressStore } from '@nexus/db/repositories/ingress';
import { AuthModule } from '../auth/module.js';
import { IngressController } from './controller.js';
import { NEXUS_INGRESS } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [IngressController],
  providers: [
    {
      provide: NEXUS_INGRESS,
      useFactory: (): IngressService | null => {
        try {
          return new IngressService(
            createIngressStore(createNexusDb(createNexusPool())),
          );
        } catch {
          return null;
        }
      },
    },
  ],
})
export class IngressModule {}

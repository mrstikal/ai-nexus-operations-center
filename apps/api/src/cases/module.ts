import { Module } from '@nestjs/common';
import { CaseService } from '@nexus/application/cases/service';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createCaseStore } from '@nexus/db/repositories/cases';
import { AuthModule } from '../auth/module.js';
import { CasesController } from './controller.js';
import { NEXUS_CASES } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [CasesController],
  providers: [
    {
      provide: NEXUS_CASES,
      useFactory: (): CaseService | null => {
        try {
          return new CaseService(createCaseStore(createNexusDb(createNexusPool())));
        } catch {
          return null;
        }
      },
    },
  ],
})
export class CasesModule {}

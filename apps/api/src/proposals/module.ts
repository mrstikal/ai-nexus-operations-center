import { Module } from '@nestjs/common';
import {
  ProposalService,
  createEmptyPriorCommitmentPort,
} from '@nexus/application/actions/proposals';
import { createFilePolicySource } from '@nexus/application/actions/policy-source';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { AuthModule } from '../auth/module.js';
import { ProposalsController } from './controller.js';
import { NEXUS_PROPOSALS } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [ProposalsController],
  providers: [
    {
      provide: NEXUS_PROPOSALS,
      useFactory: (): ProposalService | null => {
        try {
          const store = createActionProposalStore(
            createNexusDb(createNexusPool('api')),
          );
          return new ProposalService(
            store,
            createFilePolicySource(),
            createEmptyPriorCommitmentPort(),
          );
        } catch {
          return null;
        }
      },
    },
  ],
})
export class ProposalsModule {}

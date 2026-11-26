import { Module } from '@nestjs/common';
import { ProposalService } from '@nexus/application/actions/proposals';
import { createFilePolicySource } from '@nexus/application/actions/policy-source';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createActionProposalStore } from '@nexus/db/repositories/actions';
import { createExecutionStore } from '@nexus/db/repositories/executions';
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
          const db = createNexusDb(createNexusPool('api'));
          const store = createActionProposalStore(db);
          const executions = createExecutionStore(db);
          return new ProposalService(store, createFilePolicySource(), {
            successfulAdditionalProcurementMinor: (input) =>
              executions.priorSuccessfulAdditionalProcurementMinor(input),
          });
        } catch {
          return null;
        }
      },
    },
  ],
})
export class ProposalsModule {}

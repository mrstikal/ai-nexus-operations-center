import { Module } from '@nestjs/common';
import { DecisionService } from '@nexus/application/actions/decisions';
import {
  ClarificationService,
} from '@nexus/application/actions/clarification';
import { ReanalysisService } from '@nexus/application/actions/reanalysis';
import { NoActionService } from '@nexus/application/cases/no-action';
import { createFilePolicySource } from '@nexus/application/actions/policy-source';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createApprovalStore } from '@nexus/db/repositories/approvals';
import { createExecutionStore } from '@nexus/db/repositories/executions';
import { AuthModule } from './auth/module.js';
import { ApprovalsController } from './approvals/controller.js';
import { CaseControlController } from './cases/control-controller.js';
import { ProposalControlController } from './proposals/control-controller.js';

export const NEXUS_APPROVAL_STORE = Symbol('NEXUS_APPROVAL_STORE');

@Module({
  imports: [AuthModule],
  controllers: [
    ApprovalsController,
    ProposalControlController,
    CaseControlController,
  ],
  providers: [
    {
      provide: NEXUS_APPROVAL_STORE,
      useFactory: () => {
        try {
          const db = createNexusDb(createNexusPool('api'));
          return {
            approvals: createApprovalStore(db),
            executions: createExecutionStore(db),
          };
        } catch {
          return null;
        }
      },
    },
    {
      provide: DecisionService,
      inject: [NEXUS_APPROVAL_STORE],
      useFactory: (
        bundle: {
          approvals: ReturnType<typeof createApprovalStore>;
          executions: ReturnType<typeof createExecutionStore>;
        } | null,
      ) =>
        bundle
          ? new DecisionService(
              bundle.approvals,
              {
                getRevisionExecutionState: (input) =>
                  bundle.executions.getRevisionExecutionState(input),
              },
              createFilePolicySource(),
            )
          : null,
    },
    {
      provide: ClarificationService,
      inject: [NEXUS_APPROVAL_STORE],
      useFactory: (bundle: { approvals: ReturnType<typeof createApprovalStore> } | null) =>
        bundle ? new ClarificationService(bundle.approvals) : null,
    },
    {
      provide: ReanalysisService,
      inject: [NEXUS_APPROVAL_STORE],
      useFactory: (bundle: { approvals: ReturnType<typeof createApprovalStore> } | null) =>
        bundle ? new ReanalysisService(bundle.approvals) : null,
    },
    {
      provide: NoActionService,
      inject: [NEXUS_APPROVAL_STORE],
      useFactory: (bundle: { approvals: ReturnType<typeof createApprovalStore>; executions: ReturnType<typeof createExecutionStore> } | null) =>
        bundle
          ? new NoActionService(bundle.approvals, {
              getRevisionExecutionState: (input) => bundle.executions.getRevisionExecutionState(input),
            })
          : null,
    },
  ],
})
export class ActionsModule {}

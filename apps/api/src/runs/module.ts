import { Module } from '@nestjs/common';
import { CancellationService } from '@nexus/application/workflows/cancellation';
import { RunQueryService } from '@nexus/application/workflows/queries';
import { ResumeService } from '@nexus/application/workflows/resume';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createWorkflowControlStore } from '@nexus/db/repositories/workflow-control';
import { createRunQueryStore } from '@nexus/db/repositories/run-queries';
import { AuthModule } from '../auth/module.js';
import { RunControlController, type RunControlServices } from './controller.js';
import { RunQueryController, type RunQueryServices } from './query-controller.js';
import { NEXUS_RUN_CONTROL, NEXUS_RUN_QUERY } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [RunControlController, RunQueryController],
  providers: [
    {
      provide: NEXUS_RUN_QUERY,
      useFactory: (): RunQueryServices | null => {
        try {
          return {
            service: new RunQueryService(
              createRunQueryStore(createNexusDb(createNexusPool('api'))),
            ),
          };
        } catch {
          return null;
        }
      },
    },
    {
      provide: NEXUS_RUN_CONTROL,
      useFactory: (): RunControlServices | null => {
        try {
          const store = createWorkflowControlStore(
            createNexusDb(createNexusPool('api')),
          );
          return {
            store,
            resume: new ResumeService(store),
            cancellation: new CancellationService(store),
          };
        } catch {
          return null;
        }
      },
    },
  ],
})
export class RunsModule {}

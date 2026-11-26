import { Module } from '@nestjs/common';
import { CancellationService } from '@nexus/application/workflows/cancellation';
import { ResumeService } from '@nexus/application/workflows/resume';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createWorkflowControlStore } from '@nexus/db/repositories/workflow-control';
import { AuthModule } from '../auth/module.js';
import { RunControlController, type RunControlServices } from './controller.js';
import { NEXUS_RUN_CONTROL } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [RunControlController],
  providers: [
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

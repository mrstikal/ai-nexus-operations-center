import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  createDefaultTriggerMap,
  createDefaultWorkflowRegistry,
} from '@nexus/application/workflows/definitions';
import { WorkflowRunner } from '@nexus/application/workflows/runner';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createWorkflowJournal } from '@nexus/db/repositories/workflows';

@Injectable()
export class WorkflowRuntime implements OnModuleInit, OnModuleDestroy {
  #runner: WorkflowRunner | null = null;
  #pool: ReturnType<typeof createNexusPool> | null = null;

  onModuleInit(): void {
    let pool: ReturnType<typeof createNexusPool>;
    try {
      pool = createNexusPool('worker');
    } catch {
      return;
    }
    const registry = createDefaultWorkflowRegistry(process.env);
    const triggerMap = createDefaultTriggerMap(process.env);
    const runner = new WorkflowRunner({
      journal: createWorkflowJournal(createNexusDb(pool)),
      registry,
      triggerMap,
      ownerId: `workflow-worker-${process.pid}`,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      maxParallel: 4,
    });
    this.#pool = pool;
    this.#runner = runner;
    runner.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#runner?.stop();
    await this.#pool?.end();
    this.#runner = null;
    this.#pool = null;
  }
}

@Module({
  providers: [WorkflowRuntime],
})
export class WorkflowModule {}

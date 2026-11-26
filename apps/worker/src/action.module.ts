import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createFilePolicySource } from '@nexus/application/actions/policy-source';
import { ActionExecutor } from '@nexus/application/actions/executor';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createExecutionStore } from '@nexus/db/repositories/executions';
import { createEnterpriseCommandPort } from '@nexus/integrations/enterprise/commands';

@Injectable()
export class ActionRuntime implements OnModuleInit, OnModuleDestroy {
  #running = false;
  #loop: Promise<void> | null = null;
  #stopSignal: Promise<void>;
  #stopResolve: (() => void) | null = null;
  #pool: ReturnType<typeof createNexusPool> | null = null;

  constructor() {
    this.#stopSignal = new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
    });
  }

  onModuleInit(): void {
    let pool: ReturnType<typeof createNexusPool>;
    let commandPort: ReturnType<typeof createEnterpriseCommandPort>;
    try {
      pool = createNexusPool('worker');
      commandPort = createEnterpriseCommandPort(process.env);
    } catch {
      return;
    }
    const executor = new ActionExecutor(
      createExecutionStore(createNexusDb(pool)),
      commandPort,
      createFilePolicySource(),
    );
    this.#pool = pool;
    this.#running = true;
    this.#loop = this.#run(executor);
  }

  async onModuleDestroy(): Promise<void> {
    this.#running = false;
    this.#stopResolve?.();
    await this.#loop?.catch(() => undefined);
    await this.#pool?.end();
    this.#pool = null;
  }

  async #run(executor: ActionExecutor): Promise<void> {
    while (this.#running) {
      try {
        await executor.processOnce();
      } catch {
        // The next tick retries; no effect is claimed without a durable attempt row.
      }
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        this.#stopSignal,
      ]);
    }
  }
}

@Module({
  providers: [ActionRuntime],
})
export class ActionModule {}

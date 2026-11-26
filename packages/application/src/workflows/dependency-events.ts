export interface DependencyEventStore {
  processDependencyEvents(limit: number): Promise<number>;
  expireDependencies(limit: number): Promise<number>;
}

export class DependencyCoordinator {
  readonly #store: DependencyEventStore;
  readonly #intervalMs: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #stopSignal: Promise<void>;
  #stopResolve: (() => void) | null = null;

  constructor(store: DependencyEventStore, intervalMs = 1_000) {
    this.#store = store;
    this.#intervalMs = intervalMs;
    this.#stopSignal = new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
    });
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopResolve?.();
    await this.#loop?.catch(() => undefined);
  }

  async processOnce(limit = 10): Promise<number> {
    const events = await this.#store.processDependencyEvents(limit);
    const expired = await this.#store.expireDependencies(limit);
    return events + expired;
  }

  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.processOnce();
      } catch {
        // The next tick retries; durable state remains queryable.
      }
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, this.#intervalMs)),
        this.#stopSignal,
      ]);
    }
  }
}

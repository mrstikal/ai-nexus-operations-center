import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { parseEventEnvelope, type EnterpriseChangePayload } from '@nexus/contracts/events';
import { invalidateAffectedProposals } from '@nexus/application/actions/invalidation';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import {
  createActionProposalStore,
  type ProposalStoreBundle,
} from '@nexus/db/repositories/actions';

class ProposalEventProcessor {
  readonly #store: ProposalStoreBundle;
  #running = false;
  #loop: Promise<void> | null = null;
  #stopSignal: Promise<void>;
  #stopResolve: (() => void) | null = null;

  constructor(store: ProposalStoreBundle) {
    this.#store = store;
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

  async processOnce(): Promise<number> {
    const claim = await this.#store.claimPendingProposalEvent();
    if (!claim) {
      return 0;
    }
    let envelope;
    try {
      envelope = parseEventEnvelope(claim.envelope);
    } catch {
      await this.#store.failProposalEvent(claim.inboxId);
      return 0;
    }
    const payload = envelope.payload as EnterpriseChangePayload;
    try {
      await invalidateAffectedProposals(this.#store, {
        sandboxId: claim.sandboxId,
        entityRef: {
          system: 'enterprise',
          type: payload.entityType,
          id: payload.entityId,
          version: payload.version,
        },
        changedFields: payload.changedFields,
        originatingRevisionId: payload.originatingRevisionId ?? null,
        origin: {
          ...(payload.originatingItemId === undefined
            ? {}
            : { itemId: payload.originatingItemId }),
          ...(payload.originatingReceiptKey === undefined
            ? {}
            : { receiptKey: payload.originatingReceiptKey }),
        },
        requestId: `proposal-event-${claim.eventId}`.slice(0, 128),
        correlationId: claim.correlationId,
      });
      await this.#store.completeProposalEvent(claim.inboxId);
      return 1;
    } catch {
      return 0;
    }
  }

  async #run(): Promise<void> {
    while (this.#running) {
      try {
        await this.processOnce();
      } catch {
        // The next tick retries; the inbox row remains recoverable.
      }
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        this.#stopSignal,
      ]);
    }
  }
}

@Injectable()
export class ProposalEventsRuntime implements OnModuleInit, OnModuleDestroy {
  #processor: ProposalEventProcessor | null = null;
  #pool: ReturnType<typeof createNexusPool> | null = null;

  onModuleInit(): void {
    let pool: ReturnType<typeof createNexusPool>;
    try {
      pool = createNexusPool('worker');
    } catch {
      return;
    }
    const processor = new ProposalEventProcessor(
      createActionProposalStore(createNexusDb(pool)),
    );
    this.#pool = pool;
    this.#processor = processor;
    processor.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#processor?.stop();
    await this.#pool?.end();
    this.#processor = null;
    this.#pool = null;
  }
}

@Module({
  providers: [ProposalEventsRuntime],
})
export class ProposalEventsModule {}

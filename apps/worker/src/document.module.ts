import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { blobAdmissionBytesFromEnv } from '@nexus/application/documents/admission';
import { FileBlobStore } from '@nexus/application/documents/blob-store';
import { HttpDocumentExtractor } from '@nexus/application/documents/extractor-client';
import { DocumentProcessingService } from '@nexus/application/documents/processing';
import { DOCUMENT_PARSER_VERSION } from '@nexus/contracts';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createDocumentProcessingStore } from '@nexus/db/repositories/document-processing';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class DocumentRuntime implements OnModuleInit, OnModuleDestroy {
  #pool: ReturnType<typeof createNexusPool> | null = null;
  #service: DocumentProcessingService | null = null;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;

  onModuleInit(): void {
    const extractorUrl = process.env['NEXUS_EXTRACTOR_URL'];
    if (typeof extractorUrl !== 'string' || extractorUrl.trim() === '') {
      return;
    }
    let pool: ReturnType<typeof createNexusPool>;
    try {
      pool = createNexusPool('worker');
    } catch {
      return;
    }
    const timeoutMs = positiveInteger(
      process.env['NEXUS_EXTRACTOR_TIMEOUT_MS'],
      120_000,
    );
    const service = new DocumentProcessingService(
      createDocumentProcessingStore(createNexusDb(pool), {
        blobAdmissionBytes: blobAdmissionBytesFromEnv(),
      }),
      FileBlobStore.fromEnv(),
      new HttpDocumentExtractor(extractorUrl, timeoutMs),
      {
        ownerId: `document-worker-${process.pid}`,
        leaseMs: timeoutMs + 30_000,
        heartbeatMs: 10_000,
        retryDelayMs: 2_000,
        parserVersion: DOCUMENT_PARSER_VERSION,
      },
    );
    this.#pool = pool;
    this.#service = service;
    this.#timer = setInterval(() => {
      void this.tick();
    }, 500);
    this.#timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#active?.catch(() => undefined);
    this.#active = null;
    await this.#pool?.end();
    this.#pool = null;
    this.#service = null;
  }

  private async tick(): Promise<void> {
    if (this.#active || !this.#service) {
      return;
    }
    this.#active = this.#service
      .processNext()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.#active = null;
      });
    await this.#active;
  }
}

@Module({
  providers: [DocumentRuntime],
})
export class DocumentModule {}

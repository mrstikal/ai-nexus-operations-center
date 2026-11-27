import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_DOCUMENT_BYTES,
  type DocumentExtractionResult,
  type DocumentExtractionStatus,
  type DocumentMediaType,
  type ExtractionReasonCode,
  type ExtractedPage,
} from '@nexus/contracts';
import {
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentValidationError,
  sanitizeDisplayFilename,
  validateUploadBytes,
} from './admission.js';
import type { BlobStore } from './blob-store.js';
import {
  ExtractorPermanentError,
  ExtractorUnavailableError,
  type DocumentExtractor,
} from './extractor-client.js';

export interface ExtractionJobClaim {
  readonly jobId: string;
  readonly sandboxId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly blobSha256: string;
  readonly blobSizeBytes: number;
  readonly storageKey: string;
  readonly filename: string;
  readonly mediaType: DocumentMediaType;
  readonly caseId: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface ProcessingAttachment {
  readonly filename: string;
  readonly mediaType: DocumentMediaType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly content: Buffer | null;
  readonly storageKey: string | null;
  readonly blobId: string | null;
  readonly existingDocumentVersionId: string | null;
}

export interface ProcessingOutcome {
  readonly status: DocumentExtractionStatus;
  readonly reasonCode: ExtractionReasonCode | null;
  readonly format: DocumentExtractionResult['format'];
  readonly parserVersion: string;
  readonly pageCount: number;
  readonly pages: ExtractedPage[];
  readonly attachments: ProcessingAttachment[];
}

export interface CachedExtraction {
  readonly format: DocumentExtractionResult['format'];
  readonly status: DocumentExtractionStatus;
  readonly reasonCode: ExtractionReasonCode | null;
  readonly parserVersion: string;
  readonly pageCount: number;
  readonly pages: ExtractedPage[];
  readonly attachments: Array<{
    readonly filename: string;
    readonly mediaType: DocumentMediaType;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }>;
}

export type CompleteJobResult =
  | { readonly kind: 'completed'; readonly unusedStorageKeys: string[] }
  | { readonly kind: 'admission_exceeded' }
  | { readonly kind: 'lease_lost' };

export interface DocumentProcessingStore {
  claimJob(ownerId: string, leaseMs: number): Promise<ExtractionJobClaim | null>;
  heartbeat(claim: ExtractionJobClaim, leaseMs: number): Promise<boolean>;
  reapExhausted(ownerId: string): Promise<number>;
  findCachedExtraction(input: {
    readonly sandboxId: string;
    readonly sha256: string;
    readonly parserVersion: string;
  }): Promise<CachedExtraction | null>;
  completeJob(
    claim: ExtractionJobClaim,
    outcome: ProcessingOutcome,
    attachments: readonly ProcessingAttachment[],
  ): Promise<CompleteJobResult>;
  rejectJob(
    claim: ExtractionJobClaim,
    outcome: ProcessingOutcome,
  ): Promise<CompleteJobResult>;
  failJob(
    claim: ExtractionJobClaim,
    message: string,
    retryable: boolean,
    retryDelayMs: number,
  ): Promise<void>;
}

export interface DocumentProcessingConfig {
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly retryDelayMs: number;
  readonly parserVersion: string;
}

export type ProcessNextResult =
  | 'idle'
  | 'completed'
  | 'needs_review'
  | 'rejected'
  | 'retry_scheduled'
  | 'failed'
  | 'lease_lost';

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readBlob(
  blobs: BlobStore,
  storageKey: string,
  expectedSize: number,
): Promise<Buffer> {
  const info = await blobs.stat(storageKey);
  if (info.sizeBytes !== expectedSize) {
    throw new DocumentStorageError('Stored blob size does not match metadata');
  }
  const stream = await blobs.openRead(storageKey);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_DOCUMENT_BYTES) {
      throw new DocumentTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function pagesHaveContent(pages: readonly ExtractedPage[]): boolean {
  return pages.some((page) => /\S/u.test(page.text));
}

function rejectionOutcome(
  format: DocumentExtractionResult['format'],
  parserVersion: string,
  reasonCode: ExtractionReasonCode,
): ProcessingOutcome {
  return {
    status: 'rejected',
    reasonCode,
    format,
    parserVersion,
    pageCount: 1,
    pages: [{ page: 1, text: '', charCount: 0 }],
    attachments: [],
  };
}

export class DocumentProcessingService {
  constructor(
    private readonly store: DocumentProcessingStore,
    private readonly blobs: BlobStore,
    private readonly extractor: DocumentExtractor,
    private readonly config: DocumentProcessingConfig,
  ) {}

  async processNext(): Promise<ProcessNextResult> {
    const claim = await this.store.claimJob(
      this.config.ownerId,
      this.config.leaseMs,
    );
    if (!claim) {
      await this.store.reapExhausted(this.config.ownerId);
      return 'idle';
    }

    let heartbeat: NodeJS.Timeout | null = null;
    let finished = false;
    try {
      heartbeat = setInterval(() => {
        void this.store
          .heartbeat(claim, this.config.leaseMs)
          .catch(() => undefined);
      }, this.config.heartbeatMs);
      heartbeat.unref();

      const bytes = await readBlob(
        this.blobs,
        claim.storageKey,
        claim.blobSizeBytes,
      );
      if (sha256Hex(bytes) !== claim.blobSha256) {
        throw new DocumentStorageError('Stored blob hash does not match metadata');
      }

      const cached = await this.store.findCachedExtraction({
        sandboxId: claim.sandboxId,
        sha256: claim.blobSha256,
        parserVersion: this.config.parserVersion,
      });
      let outcome: ProcessingOutcome;
      if (cached) {
        outcome = {
          status: cached.status,
          reasonCode: cached.reasonCode,
          format: cached.format,
          parserVersion: cached.parserVersion,
          pageCount: cached.pageCount,
          pages: cached.pages,
          attachments: cached.attachments.map((attachment) => ({
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
            content: null,
            storageKey: null,
            blobId: null,
            existingDocumentVersionId: attachment.documentVersionId,
          })),
        };
      } else {
        let extracted: DocumentExtractionResult;
        try {
          extracted = await this.extractor.extract({
            jobToken: claim.jobId,
            mediaType: claim.mediaType,
            bytes,
          });
        } catch (error) {
          if (error instanceof ExtractorPermanentError) {
            const rejected = rejectionOutcome(
              claim.mediaType === 'application/pdf'
                ? 'digital_pdf'
                : claim.mediaType === 'message/rfc822'
                  ? 'email'
                  : 'text',
              this.config.parserVersion,
              'MALFORMED',
            );
            const result = await this.store.rejectJob(claim, rejected);
            finished = true;
            return result.kind === 'lease_lost' ? 'lease_lost' : 'rejected';
          }
          throw error;
        }
        try {
          outcome = this.prepareExtractorOutcome(extracted, claim);
        } catch (error) {
          if (
            error instanceof ExtractorPermanentError ||
            isDocumentValidationFailure(error)
          ) {
            outcome = {
              status: 'needs_review',
              reasonCode: 'UNSUPPORTED_ATTACHMENT',
              format: extracted.format,
              parserVersion: extracted.parserVersion,
              pageCount: extracted.pageCount,
              pages: extracted.pages,
              attachments: [],
            };
          } else {
            throw error;
          }
        }
      }

      if (outcome.status === 'ready' && !pagesHaveContent(outcome.pages)) {
        outcome = {
          ...outcome,
          status: 'needs_review',
          reasonCode: 'NO_TEXT',
        };
      }

      if (outcome.status === 'rejected') {
        const result = await this.store.rejectJob(claim, outcome);
        finished = true;
        return result.kind === 'lease_lost' ? 'lease_lost' : 'rejected';
      }

      const finalized = await this.finalizeAttachments(outcome.attachments);
      let completion: CompleteJobResult;
      try {
        completion = await this.store.completeJob(
          claim,
          outcome,
          finalized,
        );
      } catch (error) {
        await this.removeFinalized(finalized);
        throw error;
      }
      if (completion.kind === 'admission_exceeded') {
        await this.removeFinalized(finalized);
        const downgraded: ProcessingOutcome = {
          ...outcome,
          status: 'needs_review',
          reasonCode: 'ATTACHMENT_LIMIT',
          attachments: [],
        };
        completion = await this.store.completeJob(claim, downgraded, []);
      }
      finished = true;
      if (completion.kind === 'lease_lost') {
        await this.removeFinalized(finalized);
        return 'lease_lost';
      }
      if (completion.kind === 'completed') {
        for (const storageKey of completion.unusedStorageKeys) {
          await this.blobs.remove(storageKey).catch(() => undefined);
        }
      }
      return completion.kind === 'completed' && outcome.status === 'ready'
        ? 'completed'
        : 'needs_review';
    } catch (error) {
      if (!finished) {
        const retryable =
          error instanceof ExtractorUnavailableError ||
          error instanceof DocumentStorageError;
        await this.store
          .failJob(
            claim,
            error instanceof Error ? error.message : 'Processing failed',
            retryable,
            this.config.retryDelayMs,
          )
          .catch(() => undefined);
      }
      return 'failed';
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }

  private prepareExtractorOutcome(
    result: DocumentExtractionResult,
    claim: ExtractionJobClaim,
  ): ProcessingOutcome {
    if (result.jobToken !== claim.jobId) {
      throw new ExtractorPermanentError('Extraction token mismatch');
    }
    return {
      status: result.status,
      reasonCode: result.reasonCode,
      format: result.format,
      parserVersion: result.parserVersion,
      pageCount: result.pageCount,
      pages: result.pages,
      attachments:
        result.status === 'rejected'
          ? []
          : result.attachments.map((attachment) =>
              this.prepareAttachment(attachment),
            ),
    };
  }

  private prepareAttachment(
    attachment: DocumentExtractionResult['attachments'][number],
  ): ProcessingAttachment {
    const content = Buffer.from(attachment.contentBase64, 'base64');
    if (content.length !== attachment.sizeBytes) {
      throw new ExtractorPermanentError('Attachment size mismatch');
    }
    if (sha256Hex(content) !== attachment.sha256) {
      throw new ExtractorPermanentError('Attachment hash mismatch');
    }
    const filename = sanitizeDisplayFilename(attachment.filename);
    const mediaType = validateUploadBytes({
      declaredMediaType: attachment.mediaType,
      filename,
      bytes: content,
    });
    return {
      filename,
      mediaType,
      sizeBytes: content.length,
      sha256: attachment.sha256,
      content,
      storageKey: null,
      blobId: null,
      existingDocumentVersionId: null,
    };
  }

  private async finalizeAttachments(
    attachments: readonly ProcessingAttachment[],
  ): Promise<ProcessingAttachment[]> {
    const finalized: ProcessingAttachment[] = [];
    try {
      for (const attachment of attachments) {
        if (attachment.existingDocumentVersionId !== null) {
          finalized.push(attachment);
          continue;
        }
        if (attachment.content === null) {
          throw new DocumentStorageError('Attachment content is missing');
        }
        const writer = await this.blobs.createQuarantineWriter(
          MAX_DOCUMENT_BYTES,
        );
        try {
          await writer.write(attachment.content);
          const quarantine = await writer.finish();
          if (
            quarantine.sizeBytes !== attachment.sizeBytes ||
            quarantine.sha256 !== attachment.sha256
          ) {
            await this.blobs.discard(quarantine.quarantineKey);
            throw new DocumentStorageError('Attachment quarantine mismatch');
          }
          const storageKey = randomUUID();
          await this.blobs.finalize(quarantine.quarantineKey, storageKey);
          finalized.push({
            ...attachment,
            content: null,
            storageKey,
            blobId: randomUUID(),
          });
        } catch (error) {
          await writer.abort().catch(() => undefined);
          throw error;
        }
      }
      return finalized;
    } catch (error) {
      await this.removeFinalized(finalized);
      throw error;
    }
  }

  private async removeFinalized(
    attachments: readonly ProcessingAttachment[],
  ): Promise<void> {
    for (const attachment of attachments) {
      if (attachment.storageKey !== null) {
        await this.blobs.remove(attachment.storageKey).catch(() => undefined);
      }
    }
  }
}

export function isDocumentValidationFailure(error: unknown): boolean {
  return (
    error instanceof DocumentValidationError ||
    error instanceof DocumentTooLargeError
  );
}

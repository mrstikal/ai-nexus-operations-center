import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DocumentListResponseSchema,
  DocumentUploadResponseSchema,
  DocumentVersionSchema,
  EntityIdSchema,
  IsoUtcTimestampSchema,
  MAX_DOCUMENT_BYTES,
  UuidSchema,
  type Actor,
  type DocumentListResponse,
  type DocumentMediaType,
  type DocumentUploadResponse,
  type DocumentVersion,
  type SandboxSummary,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  requireActiveSandbox,
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from '../cases/context.js';
import {
  DocumentAdmissionError,
  DocumentConflictError,
  DocumentIdempotencyMismatchError,
  DocumentNotFoundError,
  DocumentStorageError,
  DocumentValidationError,
  sanitizeDisplayFilename,
  validateUploadBytes,
} from './admission.js';
import type { BlobStore, QuarantineResult } from './blob-store.js';

export interface DocumentUploadScope {
  readonly sandboxId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface CompleteDocumentUploadInput extends DocumentUploadScope {
  readonly uploadId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly jobId: string;
  readonly blobId: string;
  readonly storageKey: string;
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
  readonly filename: string;
  readonly mediaType: DocumentMediaType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly caseId: string | null;
  readonly requestHash: string;
  readonly blobAdmissionBytes: number;
}

export interface DocumentUploadCursor {
  readonly createdAt: string;
  readonly documentId: string;
}

export interface DocumentStore extends SandboxResolver {
  findUpload(scope: DocumentUploadScope): Promise<DocumentUploadResponse | null>;
  completeUpload(input: CompleteDocumentUploadInput): Promise<
    | { readonly kind: 'created'; readonly response: DocumentUploadResponse }
    | { readonly kind: 'existing'; readonly response: DocumentUploadResponse }
    | { readonly kind: 'idempotency_mismatch' }
    | { readonly kind: 'case_not_found' }
    | { readonly kind: 'admission_exceeded' }
    | { readonly kind: 'conflict' }
  >;
  listDocuments(input: {
    readonly sandboxId: string;
    readonly limit: number;
    readonly after?: DocumentUploadCursor;
  }): Promise<{ items: DocumentVersion[]; hasMore: boolean }>;
  getDocument(
    sandboxId: string,
    documentId: string,
  ): Promise<DocumentVersion | null>;
  getDownload(
    sandboxId: string,
    documentId: string,
  ): Promise<{ document: DocumentVersion; storageKey: string } | null>;
}

export interface DocumentIntakeConfig {
  readonly blobAdmissionBytes: number;
}

export interface DocumentUploadInput {
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string | null | undefined;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly caseId: string | null;
  readonly quarantine: QuarantineResult;
}

function encodeCursor(cursor: DocumentUploadCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDocumentCursor(cursor: string): DocumentUploadCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      documentId?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.documentId !== 'string' ||
      !IsoUtcTimestampSchema.safeParse(parsed.createdAt).success ||
      !EntityIdSchema.safeParse(parsed.documentId).success
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, documentId: parsed.documentId };
  } catch {
    throw new DocumentValidationError('Invalid document cursor');
  }
}

function parseLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new DocumentValidationError('Limit must be an integer from 1 to 100');
  }
  return value;
}

function parseDocumentId(value: string): string {
  const parsed = EntityIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DocumentValidationError('Invalid document identifier');
  }
  return parsed.data;
}

export class DocumentIntakeService {
  constructor(
    private readonly store: DocumentStore,
    private readonly blobs: BlobStore,
    private readonly config: DocumentIntakeConfig,
  ) {
    if (
      !Number.isSafeInteger(config.blobAdmissionBytes) ||
      config.blobAdmissionBytes < 1
    ) {
      throw new DocumentValidationError('Invalid blob admission configuration');
    }
  }

  async getActiveSandbox(): Promise<SandboxSummary> {
    return requireActiveSandbox(this.store);
  }

  async upload(input: DocumentUploadInput): Promise<DocumentUploadResponse> {
    try {
      return await this.uploadImpl(input);
    } catch (error) {
      await this.blobs
        .discard(input.quarantine.quarantineKey)
        .catch(() => undefined);
      throw error;
    }
  }

  private async uploadImpl(
    input: DocumentUploadInput,
  ): Promise<DocumentUploadResponse> {
    const key = UuidSchema.safeParse(input.idempotencyKey ?? '');
    if (!key.success) {
      throw new DocumentValidationError(
        'A UUID Idempotency-Key header is required for document uploads',
      );
    }
    if (input.filename.length === 0 || input.filename.length > 1000) {
      throw new DocumentValidationError('Invalid uploaded filename');
    }
    let caseId: string | null = null;
    if (input.caseId !== null && input.caseId !== '') {
      caseId = parseDocumentId(input.caseId);
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const filename = sanitizeDisplayFilename(input.filename);
    const bytes = await this.blobs.readQuarantine(
      input.quarantine.quarantineKey,
      MAX_DOCUMENT_BYTES,
    );
    if (bytes.length !== input.quarantine.sizeBytes) {
      throw new DocumentStorageError('Quarantined upload size did not match');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== input.quarantine.sha256) {
      throw new DocumentStorageError('Quarantined upload hash did not match');
    }
    const mediaType = validateUploadBytes({
      declaredMediaType: input.declaredMediaType,
      filename,
      bytes,
    });
    const requestHash = canonicalJsonSha256({
      kind: 'document.upload.v1',
      filename,
      mediaType,
      sizeBytes: bytes.length,
      sha256: digest,
      caseId,
    });
    const scope: DocumentUploadScope = {
      sandboxId: sandbox.id,
      actorId: input.actor.id,
      idempotencyKey: key.data,
    };
    const existing = await this.store.findUpload(scope);
    if (existing) {
      if (!this.sameRequest(existing, digest, bytes.length, mediaType, filename, caseId)) {
        throw new DocumentIdempotencyMismatchError();
      }
      await this.blobs.discard(input.quarantine.quarantineKey);
      return DocumentUploadResponseSchema.parse(existing);
    }
    const storageKey = randomUUID();
    await this.blobs.finalize(input.quarantine.quarantineKey, storageKey);
    const completeInput: CompleteDocumentUploadInput = {
      ...scope,
      uploadId: randomUUID(),
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      jobId: randomUUID(),
      blobId: randomUUID(),
      storageKey,
      actor: input.actor,
      requestId: input.requestId,
      correlationId: input.correlationId,
      filename,
      mediaType,
      sizeBytes: bytes.length,
      sha256: digest,
      caseId,
      requestHash,
      blobAdmissionBytes: this.config.blobAdmissionBytes,
    };
    let result: Awaited<ReturnType<DocumentStore['completeUpload']>>;
    try {
      result = await this.store.completeUpload(completeInput);
    } catch (error) {
      await this.blobs.remove(storageKey);
      throw error;
    }
    if (result.kind === 'created') {
      return DocumentUploadResponseSchema.parse(result.response);
    }
    await this.blobs.remove(storageKey);
    if (result.kind === 'existing') {
      if (!this.sameRequest(result.response, digest, bytes.length, mediaType, filename, caseId)) {
        throw new DocumentIdempotencyMismatchError();
      }
      return DocumentUploadResponseSchema.parse(result.response);
    }
    if (result.kind === 'admission_exceeded') {
      throw new DocumentAdmissionError();
    }
    if (result.kind === 'case_not_found') {
      throw new DocumentNotFoundError('Case was not found in this sandbox');
    }
    if (result.kind === 'idempotency_mismatch') {
      throw new DocumentIdempotencyMismatchError();
    }
    throw new DocumentConflictError();
  }

  async list(input: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DocumentListResponse> {
    const sandbox = await this.getActiveSandbox();
    const limit = parseLimit(input.limit);
    const after =
      input.cursor === undefined ? undefined : decodeDocumentCursor(input.cursor);
    const result = await this.store.listDocuments({
      sandboxId: sandbox.id,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    const items = result.items.map((item) => DocumentVersionSchema.parse(item));
    const last = items.at(-1);
    return DocumentListResponseSchema.parse({
      items,
      nextCursor:
        result.hasMore && last
          ? encodeCursor({
              createdAt: last.createdAt,
              documentId: last.documentId,
            })
          : null,
    });
  }

  async get(documentId: string): Promise<DocumentVersion> {
    const id = parseDocumentId(documentId);
    const sandbox = await this.getActiveSandbox();
    const found = await this.store.getDocument(sandbox.id, id);
    if (!found) {
      throw new DocumentNotFoundError();
    }
    return DocumentVersionSchema.parse(found);
  }

  async download(documentId: string): Promise<{
    document: DocumentVersion;
    stream: Readable;
  }> {
    const id = parseDocumentId(documentId);
    const sandbox = await this.getActiveSandbox();
    const found = await this.store.getDownload(sandbox.id, id);
    if (!found) {
      throw new DocumentNotFoundError();
    }
    const document = DocumentVersionSchema.parse(found.document);
    const info = await this.blobs.stat(found.storageKey);
    if (info.sizeBytes !== document.sizeBytes) {
      throw new DocumentStorageError('Stored blob size does not match metadata');
    }
    return { document, stream: await this.blobs.openRead(found.storageKey) };
  }

  private sameRequest(
    existing: DocumentUploadResponse,
    sha256: string,
    sizeBytes: number,
    mediaType: DocumentMediaType,
    filename: string,
    caseId: string | null,
  ): boolean {
    const document = existing.document;
    return (
      document.blobHash === sha256 &&
      document.sizeBytes === sizeBytes &&
      document.mediaType === mediaType &&
      document.originalFilename === filename &&
      document.caseId === caseId
    );
  }
}

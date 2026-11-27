import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ActorSchema,
  MAX_DOCUMENT_BYTES,
  TOOL_CORRELATION_PATTERN,
  type DocumentListResponse,
  type DocumentUploadResponse,
  type DocumentVersion,
} from '@nexus/contracts';
import {
  DocumentIntakeService,
  type DocumentStore,
} from '@nexus/application/documents/upload';
import {
  FileBlobStore,
  blobRootFromEnv,
} from '@nexus/application/documents/blob-store';
import {
  DocumentAdmissionError,
  DocumentConflictError,
  DocumentIdempotencyMismatchError,
  DocumentNotFoundError,
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentUnsupportedMediaError,
  DocumentValidationError,
  blobAdmissionBytesFromEnv,
  encodeContentDisposition,
} from '@nexus/application/documents/admission';
import {
  SandboxInactiveError,
  SandboxUnavailableError,
} from '@nexus/application/cases/context';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';
import { NEXUS_DOCUMENTS } from './tokens.js';
import { QuarantineStorageEngine } from './storage-engine.js';

interface QuarantinedFile {
  readonly quarantineKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly originalname: string;
  readonly mimetype: string;
}

function requireService(
  service: DocumentIntakeService | null,
): DocumentIntakeService {
  if (!service) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Document storage is not configured',
    );
  }
  return service;
}

function headerValue(
  request: RequestLike,
  name: string,
): string | undefined {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestId(request: RequestLike): string {
  const value = headerValue(request, 'x-request-id');
  return value !== undefined && value.length > 0 && value.length <= 128
    ? value
    : randomUUID();
}

function correlationId(request: RequestLike): string {
  const value = headerValue(request, 'x-correlation-id');
  return value !== undefined && TOOL_CORRELATION_PATTERN.test(value)
    ? value
    : randomUUID();
}

function quarantinedFile(file: unknown): QuarantinedFile {
  if (typeof file !== 'object' || file === null) {
    throw new ProblemException(
      'VALIDATION_FAILED',
      'A multipart file field named "file" is required',
    );
  }
  const record = file as Record<string, unknown>;
  const quarantineKey = record['quarantineKey'];
  const sizeBytes = record['sizeBytes'];
  const sha256 = record['sha256'];
  if (
    typeof quarantineKey !== 'string' ||
    typeof sizeBytes !== 'number' ||
    typeof sha256 !== 'string'
  ) {
    throw new ProblemException(
      'VALIDATION_FAILED',
      'The uploaded document was not quarantined',
    );
  }
  return {
    quarantineKey,
    sizeBytes,
    sha256,
    originalname:
      typeof record['originalname'] === 'string'
        ? record['originalname']
        : 'document',
    mimetype:
      typeof record['mimetype'] === 'string'
        ? record['mimetype']
        : 'application/octet-stream',
  };
}

function problemFor(error: unknown): never {
  if (error instanceof ProblemException) {
    throw error;
  }
  if (error instanceof DocumentValidationError) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  if (error instanceof DocumentUnsupportedMediaError) {
    throw new ProblemException('UNSUPPORTED_MEDIA', error.message);
  }
  if (
    error instanceof DocumentTooLargeError ||
    error instanceof DocumentAdmissionError
  ) {
    throw new ProblemException('PAYLOAD_TOO_LARGE', error.message);
  }
  if (error instanceof DocumentIdempotencyMismatchError) {
    throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
  }
  if (error instanceof DocumentNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof DocumentConflictError) {
    throw new ProblemException('CONFLICT', error.message);
  }
  if (error instanceof DocumentStorageError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  if (error instanceof SandboxInactiveError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof SandboxUnavailableError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  throw new ProblemException(
    'DEPENDENCY_UNAVAILABLE',
    'Document storage is unavailable',
  );
}

const quarantineEngine = new QuarantineStorageEngine(
  new FileBlobStore({ root: blobRootFromEnv() }),
);

export function createDocumentIntakeService(
  store: DocumentStore,
): DocumentIntakeService {
  return new DocumentIntakeService(
    store,
    new FileBlobStore({ root: blobRootFromEnv() }),
    { blobAdmissionBytes: blobAdmissionBytesFromEnv() },
  );
}

@Controller('api/v1')
export class DocumentsController {
  constructor(
    @Inject(NEXUS_DOCUMENTS) private readonly service: DocumentIntakeService | null,
  ) {}

  @Post('documents')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: quarantineEngine,
      limits: {
        fileSize: MAX_DOCUMENT_BYTES,
        files: 1,
        fields: 4,
        parts: 8,
      },
    }),
  )
  async upload(
    @Req() request: RequestLike,
    @UploadedFile() file: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Query('caseId') queryCaseId: string | undefined,
  ): Promise<DocumentUploadResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const parsed = quarantinedFile(file);
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    const body = (
      request as unknown as { body?: Record<string, unknown> }
    ).body;
    const bodyCaseId =
      typeof body === 'object' && body !== null ? body['caseId'] : undefined;
    const caseId =
      typeof bodyCaseId === 'string'
        ? bodyCaseId
        : queryCaseId !== undefined
          ? queryCaseId
          : null;
    try {
      return await requireService(this.service).upload({
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
        idempotencyKey,
        filename: parsed.originalname,
        declaredMediaType: parsed.mimetype,
        caseId,
        quarantine: {
          quarantineKey: parsed.quarantineKey,
          sizeBytes: parsed.sizeBytes,
          sha256: parsed.sha256,
        },
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('documents')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async list(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<DocumentListResponse> {
    try {
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      return await requireService(this.service).list({
        cursor,
        limit: parsedLimit,
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('documents/:documentId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async detail(@Param('documentId') documentId: string): Promise<DocumentVersion> {
    try {
      return await requireService(this.service).get(documentId);
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('documents/:documentId/content')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async content(
    @Param('documentId') documentId: string,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await requireService(this.service).download(documentId);
      response.status(200);
      response.setHeader('Content-Type', result.document.mediaType);
      response.setHeader('Content-Length', String(result.document.sizeBytes));
      response.setHeader(
        'Content-Disposition',
        encodeContentDisposition(result.document.originalFilename),
      );
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Download-Options', 'noopen');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      result.stream.on('error', () => {
        if (!response.headersSent) {
          response.status(503).end();
        } else {
          response.destroy();
        }
      });
      result.stream.pipe(response);
    } catch (error) {
      problemFor(error);
    }
  }
}

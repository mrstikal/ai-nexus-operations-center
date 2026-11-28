import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  Headers,
  Inject,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  DocumentExtractionCorrectionRequestSchema,
  TOOL_CORRELATION_PATTERN,
  type DocumentExtractionRevision,
} from '@nexus/contracts';
import {
  DocumentCorrectionConflictError,
  DocumentExtractionNotFoundError,
} from '@nexus/application/documents/correct';
import type { DocumentCorrectionService } from '@nexus/application/documents/correct';
import { DocumentExtractionValidationError } from '@nexus/application/documents/validate-fields';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';
import { NEXUS_DOCUMENT_CORRECTIONS } from './tokens.js';

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

function problemFor(error: unknown): never {
  if (error instanceof ProblemException) {
    throw error;
  }
  if (error instanceof DocumentExtractionNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof DocumentCorrectionConflictError) {
    throw new ProblemException(
      error.code === 'REVISION_CONFLICT' ? 'STALE_STATE' : 'CONFLICT',
      error.message,
    );
  }
  if (error instanceof DocumentExtractionValidationError) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  throw new ProblemException(
    'DEPENDENCY_UNAVAILABLE',
    'Document extraction is unavailable',
  );
}

@Controller('api/v1')
export class DocumentCorrectionsController {
  constructor(
    @Inject(NEXUS_DOCUMENT_CORRECTIONS)
    private readonly service: DocumentCorrectionService | null,
  ) {}

  @Patch('documents/:documentId/extraction')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async correct(
    @Req() request: RequestLike,
    @Param('documentId') documentId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<DocumentExtractionRevision> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    if (this.service === null) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Document extraction is not configured',
      );
    }
    if (ifMatch === undefined || !/^[1-9]\d{0,6}$/u.test(ifMatch)) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'If-Match must carry the current extraction revision number',
      );
    }
    const parsed = DocumentExtractionCorrectionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Extraction correction does not match its contract',
        { issues: parsed.error.issues },
      );
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      return await this.service.correct({
        sandboxId: null,
        documentId,
        actorId: actor.id,
        expectedRevisionNumber: Number(ifMatch),
        reason: parsed.data.reason,
        fields: parsed.data.fields,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
    } catch (error) {
      problemFor(error);
    }
  }
}

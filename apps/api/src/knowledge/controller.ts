import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  KnowledgeIngestRequestSchema,
  KnowledgeRevokeRequestSchema,
  KnowledgeSearchRequestSchema,
  TOOL_CORRELATION_PATTERN,
  UuidSchema,
  type KnowledgeIngestResponse,
  type KnowledgeListResponse,
  type KnowledgePublicationResponse,
  type KnowledgeSearchResponse,
} from '@nexus/contracts';
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeSourceError,
  KnowledgeValidationError,
} from '@nexus/application/knowledge/errors';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';
import { NEXUS_KNOWLEDGE, type KnowledgeApi } from './tokens.js';

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
  if (error instanceof KnowledgeNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof KnowledgeConflictError) {
    throw new ProblemException('CONFLICT', error.message);
  }
  if (
    error instanceof KnowledgeValidationError ||
    error instanceof KnowledgeSourceError
  ) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  throw new ProblemException(
    'DEPENDENCY_UNAVAILABLE',
    'Knowledge storage is unavailable',
  );
}

function requireService(api: KnowledgeApi | null): KnowledgeApi {
  if (api === null) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Knowledge storage is not configured',
    );
  }
  return api;
}

function requireDocumentId(documentId: string): string {
  if (!UuidSchema.safeParse(documentId).success) {
    throw new ProblemException('VALIDATION_FAILED', 'documentId must be a UUID');
  }
  return documentId;
}

@Controller('api/v1')
export class KnowledgeController {
  constructor(
    @Inject(NEXUS_KNOWLEDGE) private readonly api: KnowledgeApi | null,
  ) {}

  @Get('knowledge')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async list(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<KnowledgeListResponse> {
    try {
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      return await requireService(this.api).catalog.list({
        cursor,
        limit: parsedLimit,
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('knowledge')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('admin')
  async ingest(
    @Req() request: RequestLike,
    @Body() body: unknown,
  ): Promise<KnowledgeIngestResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const parsed = KnowledgeIngestRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Knowledge ingest request does not match its contract',
        { issues: parsed.error.issues },
      );
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      return await requireService(this.api).ingest.ingest({
        sandboxId: null,
        kind: parsed.data.kind,
        policyId: parsed.data.policyId ?? null,
        sourcePath: parsed.data.path,
        effectiveFrom: parsed.data.effectiveFrom ?? null,
        actorId: actor.id,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('knowledge/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('operator')
  async search(@Body() body: unknown): Promise<KnowledgeSearchResponse> {
    const parsed = KnowledgeSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Knowledge search request does not match its contract',
        { issues: parsed.error.issues },
      );
    }
    try {
      return await requireService(this.api).search.search(parsed.data);
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('knowledge/:documentId/publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('admin')
  async publish(
    @Req() request: RequestLike,
    @Param('documentId') documentId: string,
  ): Promise<KnowledgePublicationResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      return await requireService(this.api).publish.publish({
        sandboxId: null,
        documentId: requireDocumentId(documentId),
        actorId: actor.id,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('knowledge/:documentId/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('admin')
  async revoke(
    @Req() request: RequestLike,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ): Promise<KnowledgePublicationResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const parsed = KnowledgeRevokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Knowledge revocation request does not match its contract',
        { issues: parsed.error.issues },
      );
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      return await requireService(this.api).publish.revoke({
        sandboxId: null,
        documentId: requireDocumentId(documentId),
        versionId: parsed.data.versionId ?? null,
        reason: parsed.data.reason,
        actorId: actor.id,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
    } catch (error) {
      problemFor(error);
    }
  }
}

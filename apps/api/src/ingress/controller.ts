import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  CaseIntakeResponseSchema,
  TOOL_CORRELATION_PATTERN,
  type CaseIntakeResponse,
} from '@nexus/contracts';
import type { IngressService } from '@nexus/application/ingress/service';
import {
  DocumentReferenceNotFoundError,
  IngressIdempotencyMismatchError,
  IngressValidationError,
} from '@nexus/application/ingress/service';
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
import { NEXUS_INGRESS } from './tokens.js';

function requireService(service: IngressService | null): IngressService {
  if (!service) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Case intake storage is not configured',
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

function problemFor(error: unknown): never {
  if (error instanceof ProblemException) {
    throw error;
  }
  if (error instanceof IngressValidationError) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  if (error instanceof IngressIdempotencyMismatchError) {
    throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
  }
  if (error instanceof DocumentReferenceNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof SandboxInactiveError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof SandboxUnavailableError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Case intake is unavailable');
}

@Controller('api/v1')
export class IngressController {
  constructor(@Inject(NEXUS_INGRESS) private readonly service: IngressService | null) {}

  @Post('cases')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async intake(
    @Req() request: RequestLike,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CaseIntakeResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const response = await requireService(this.service).intake({
        body,
        idempotencyKey,
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
      return CaseIntakeResponseSchema.parse(response);
    } catch (error) {
      problemFor(error);
    }
  }
}

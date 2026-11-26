import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  NoActionResponseSchema,
  TOOL_CORRELATION_PATTERN,
  type NoActionResponse,
} from '@nexus/contracts';
import {
  NoActionError,
  NoActionService,
} from '@nexus/application/cases/no-action';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';

function headerValue(request: RequestLike, name: string): string | undefined {
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
  if (error instanceof NoActionError) {
    switch (error.code) {
      case 'CASE_NOT_FOUND':
        throw new ProblemException('NOT_FOUND', error.message);
      case 'CASE_TERMINAL':
      case 'NO_ACTIVE_RUN':
      case 'EXECUTION_STATE_PRESENT':
        throw new ProblemException('CONFLICT', error.message);
      case 'IDEMPOTENCY_MISMATCH':
        throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
      case 'NO_ACTION_NOT_ALLOWED':
        throw new ProblemException('VALIDATION_FAILED', error.message);
    }
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'No-action control is unavailable');
}

@Controller('api/v1')
export class CaseControlController {
  constructor(
    @Inject(NoActionService) private readonly service: NoActionService | null,
  ) {}

  @Post('cases/:caseId/resolve-no-action')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async resolveNoAction(
    @Req() request: RequestLike,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<NoActionResponse> {
    if (!this.service) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'No-action storage is not configured',
      );
    }
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const result = await this.service.resolve(caseId, body, idempotencyKey, {
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
      return NoActionResponseSchema.parse(result);
    } catch (error) {
      problemFor(error);
    }
  }
}

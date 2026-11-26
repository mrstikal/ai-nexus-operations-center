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
  ActionRevisionRequestResponseSchema,
  ActorSchema,
  TOOL_CORRELATION_PATTERN,
  type ActionRevisionRequestResponse,
} from '@nexus/contracts';
import {
  ClarificationService,
  RevisionRequestError,
} from '@nexus/application/actions/clarification';
import { ReanalysisService } from '@nexus/application/actions/reanalysis';
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
  if (error instanceof RevisionRequestError) {
    switch (error.code) {
      case 'INVALID_REQUEST':
        throw new ProblemException('VALIDATION_FAILED', error.message);
      case 'PROPOSAL_NOT_FOUND':
        throw new ProblemException('NOT_FOUND', error.message);
      case 'APPROVAL_EXPIRED':
        throw new ProblemException('APPROVAL_EXPIRED', error.message);
      case 'IDEMPOTENCY_MISMATCH':
        throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
      case 'REVISION_MISMATCH':
      case 'PLAN_HASH_MISMATCH':
      case 'REQUEST_NOT_ALLOWED':
      case 'REQUEST_CONFLICT':
        throw new ProblemException('STALE_STATE', error.message);
    }
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Proposal control is unavailable');
}

@Controller('api/v1')
export class ProposalControlController {
  constructor(
    @Inject(ClarificationService)
    private readonly clarification: ClarificationService | null,
    @Inject(ReanalysisService)
    private readonly reanalysis: ReanalysisService | null,
  ) {}

  @Post('proposals/:proposalId/clarification')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async clarify(
    @Req() request: RequestLike,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ActionRevisionRequestResponse> {
    if (!this.clarification) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Clarification storage is not configured',
      );
    }
    return this.#run(request, this.clarification, proposalId, body, idempotencyKey);
  }

  @Post('proposals/:proposalId/reanalyse')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async reanalyse(
    @Req() request: RequestLike,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ActionRevisionRequestResponse> {
    if (!this.reanalysis) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Reanalysis storage is not configured',
      );
    }
    return this.#run(request, this.reanalysis, proposalId, body, idempotencyKey);
  }

  async #run(
    request: RequestLike,
    service: ClarificationService | ReanalysisService,
    proposalId: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<ActionRevisionRequestResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const result = await service.request(proposalId, body, idempotencyKey, {
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
      return ActionRevisionRequestResponseSchema.parse(result);
    } catch (error) {
      problemFor(error);
    }
  }
}

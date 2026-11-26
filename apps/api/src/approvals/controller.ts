import { randomUUID } from 'node:crypto';
import {
  Body,
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
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  ApprovalDecisionResultSchema,
  ApprovalQueueResponseSchema,
  TOOL_CORRELATION_PATTERN,
  type ApprovalDecisionResult,
  type ApprovalQueueResponse,
} from '@nexus/contracts';
import {
  DecisionError,
  DecisionService,
} from '@nexus/application/actions/decisions';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';

function requireService(service: DecisionService | null): DecisionService {
  if (!service) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Approval storage is not configured',
    );
  }
  return service;
}

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
  if (error instanceof DecisionError) {
    switch (error.code) {
      case 'INVALID_REQUEST':
        throw new ProblemException('VALIDATION_FAILED', error.message);
      case 'PROPOSAL_NOT_FOUND':
        throw new ProblemException('NOT_FOUND', error.message);
      case 'SELF_APPROVAL':
      case 'ACTOR_ALREADY_DECIDED':
      case 'ROLE_NOT_ELIGIBLE':
        throw new ProblemException('FORBIDDEN', error.message);
      case 'APPROVAL_EXPIRED':
        throw new ProblemException('APPROVAL_EXPIRED', error.message);
      case 'POLICY_CHANGED':
        throw new ProblemException('STALE_STATE', error.message);
      case 'POLICY_UNAVAILABLE':
        throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
      case 'IDEMPOTENCY_MISMATCH':
        throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
      case 'PLAN_HASH_MISMATCH':
      case 'REVISION_MISMATCH':
      case 'PROPOSAL_NOT_PENDING':
      case 'DECISION_CONFLICT':
      case 'EXECUTION_STATE_PRESENT':
        throw new ProblemException('STALE_STATE', error.message);
      case 'NO_HUMAN_APPROVAL_REQUIRED':
      case 'CASE_TERMINAL':
        throw new ProblemException('CONFLICT', error.message);
    }
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Approvals are unavailable');
}

@Controller('api/v1')
export class ApprovalsController {
  constructor(
    @Inject(DecisionService) private readonly service: DecisionService | null,
  ) {}

  @Get('approvals')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('approver_ops', 'approver_finance')
  async list(
    @Req() request: RequestLike,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ): Promise<ApprovalQueueResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const parsedLimit = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(parsedLimit)) {
      throw new ProblemException('VALIDATION_FAILED', 'Limit is invalid');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const result = await requireService(this.service).list(
        actor,
        parsedLimit,
        cursor,
      );
      return ApprovalQueueResponseSchema.parse(result);
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('proposals/:proposalId/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('approver_ops', 'approver_finance')
  async approve(
    @Req() request: RequestLike,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ApprovalDecisionResult> {
    return this.#decide(request, proposalId, body, idempotencyKey, 'approve');
  }

  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('approver_ops', 'approver_finance')
  async reject(
    @Req() request: RequestLike,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ApprovalDecisionResult> {
    return this.#decide(request, proposalId, body, idempotencyKey, 'reject');
  }

  async #decide(
    request: RequestLike,
    proposalId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    decision: 'approve' | 'reject',
  ): Promise<ApprovalDecisionResult> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const result = await requireService(this.service).decide(
        proposalId,
        decision,
        body,
        idempotencyKey,
        {
          actor,
          requestId: requestId(request),
          correlationId: correlationId(request),
        },
      );
      return ApprovalDecisionResultSchema.parse(result);
    } catch (error) {
      problemFor(error);
    }
  }
}

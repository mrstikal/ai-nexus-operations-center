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
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActionProposalDetailSchema,
  ActionProposalListResponseSchema,
  ActorSchema,
  RevisionPreconditionSchema,
  TOOL_CORRELATION_PATTERN,
  type ActionProposalDetail,
  type ActionProposalListResponse,
} from '@nexus/contracts';
import {
  ProposalConflictError,
  ProposalIdempotencyMismatchError,
  ProposalNotFoundError,
  ProposalPolicyUnavailableError,
  ProposalStaleError,
  ProposalValidationError,
  type ProposalService,
} from '@nexus/application/actions/proposals';
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
import { NEXUS_PROPOSALS } from './tokens.js';

function requireService(service: ProposalService | null): ProposalService {
  if (!service) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Proposal storage is not configured',
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

function revisionPrecondition(ifMatch: string | undefined): number {
  const parsed = RevisionPreconditionSchema.safeParse(ifMatch);
  if (!parsed.success) {
    throw new ProblemException(
      'VALIDATION_FAILED',
      'A positive If-Match revision precondition is required',
    );
  }
  return Number(parsed.data.replaceAll('"', ''));
}

function problemFor(error: unknown): never {
  if (error instanceof ProblemException) {
    throw error;
  }
  if (error instanceof ProposalValidationError) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  if (error instanceof ProposalIdempotencyMismatchError) {
    throw new ProblemException('IDEMPOTENCY_MISMATCH', error.message);
  }
  if (error instanceof ProposalNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof ProposalConflictError) {
    throw new ProblemException('CONFLICT', error.message);
  }
  if (error instanceof ProposalStaleError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof ProposalPolicyUnavailableError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  if (error instanceof SandboxInactiveError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof SandboxUnavailableError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Proposals are unavailable');
}

@Controller('api/v1')
export class ProposalsController {
  constructor(
    @Inject(NEXUS_PROPOSALS) private readonly service: ProposalService | null,
  ) {}

  @Post('cases/:caseId/proposals')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async create(
    @Req() request: RequestLike,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ActionProposalDetail> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const detail = await requireService(this.service).create(
        caseId,
        body,
        idempotencyKey,
        {
          actor,
          requestId: requestId(request),
          correlationId: correlationId(request),
        },
      );
      return ActionProposalDetailSchema.parse(detail);
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('cases/:caseId/proposals')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async list(
    @Param('caseId') caseId: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ): Promise<ActionProposalListResponse> {
    const parsedLimit = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(parsedLimit)) {
      throw new ProblemException('VALIDATION_FAILED', 'Limit is invalid');
    }
    try {
      const result = await requireService(this.service).list(
        caseId,
        parsedLimit,
        cursor,
      );
      return ActionProposalListResponseSchema.parse(result);
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('proposals/:proposalId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async read(@Param('proposalId') proposalId: string): Promise<ActionProposalDetail> {
    try {
      const detail = await requireService(this.service).get(proposalId);
      return ActionProposalDetailSchema.parse(detail);
    } catch (error) {
      problemFor(error);
    }
  }

  @Patch('proposals/:proposalId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async revise(
    @Req() request: RequestLike,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<ActionProposalDetail> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const detail = await requireService(this.service).revise(
        proposalId,
        revisionPrecondition(ifMatch),
        body,
        {
          actor,
          requestId: requestId(request),
          correlationId: correlationId(request),
        },
      );
      return ActionProposalDetailSchema.parse(detail);
    } catch (error) {
      problemFor(error);
    }
  }
}

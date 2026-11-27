import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ActorSchema,
  RunCancelRequestSchema,
  RunControlResponseSchema,
  RunResumeRequestSchema,
  TOOL_CORRELATION_PATTERN,
  UuidSchema,
  type RunControlResponse,
} from '@nexus/contracts';
import type { CancellationService } from '@nexus/application/workflows/cancellation';
import type { ResumeService } from '@nexus/application/workflows/resume';
import { RunControlError } from '@nexus/application/workflows/waits';
import { CaseWorkflowTransitionError } from '@nexus/db/repositories/workflow-case';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from '../auth/guards.js';
import { NEXUS_RUN_CONTROL } from './tokens.js';

export interface RunControlServices {
  readonly store: {
    getActiveSandboxId(): Promise<string | null>;
  };
  readonly resume: ResumeService;
  readonly cancellation: CancellationService;
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
  if (error instanceof CaseWorkflowTransitionError) {
    throw new ProblemException('CONFLICT', error.message);
  }
  if (error instanceof RunControlError) {
    switch (error.code) {
      case 'RUN_NOT_FOUND':
        throw new ProblemException('NOT_FOUND', error.message);
      case 'RUN_TERMINAL':
      case 'ILLEGAL_WAKE':
      case 'UNSUPPORTED_CAUSE':
      case 'DUPLICATE_CANCELLATION':
      case 'RECONCILIATION_REQUIRED':
      case 'DEPENDENCY_MISMATCH':
      case 'DEPENDENCY_DEPTH_EXCEEDED':
      case 'DEPENDENCY_CHILD_TERMINAL':
      case 'CASE_TRANSITION_REJECTED':
        throw new ProblemException('CONFLICT', error.message);
    }
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Run control is unavailable');
}

@Controller('api/v1')
export class RunControlController {
  constructor(
    @Inject(NEXUS_RUN_CONTROL)
    private readonly services: RunControlServices | null,
  ) {}

  @Post('runs/:runId/resume')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async resume(
    @Req() request: RequestLike,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<RunControlResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    if (!this.services) {
      throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Run control is unavailable');
    }
    if (!UuidSchema.safeParse(runId).success) {
      throw new ProblemException('VALIDATION_FAILED', 'Run ID is invalid');
    }
    let parsed;
    try {
      parsed = RunResumeRequestSchema.parse(body);
    } catch {
      throw new ProblemException('VALIDATION_FAILED', 'Run resume request is invalid');
    }
    let sandboxId: string | null;
    try {
      sandboxId = await this.services.store.getActiveSandboxId();
    } catch {
      throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Run control storage is unavailable');
    }
    if (!sandboxId) {
      throw new ProblemException('STALE_STATE', 'No active sandbox is available');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const response = await this.services.resume.resume({
        sandboxId,
        runId,
        request: parsed,
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
      return RunControlResponseSchema.parse(response);
    } catch (error) {
      problemFor(error);
    }
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  async cancel(
    @Req() request: RequestLike,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ): Promise<RunControlResponse> {
    if (!request.auth) {
      throw new ProblemException('UNAUTHENTICATED', 'Authentication is required');
    }
    if (!this.services) {
      throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Run control is unavailable');
    }
    if (!UuidSchema.safeParse(runId).success) {
      throw new ProblemException('VALIDATION_FAILED', 'Run ID is invalid');
    }
    let parsed;
    try {
      parsed = RunCancelRequestSchema.parse(body);
    } catch {
      throw new ProblemException('VALIDATION_FAILED', 'Run cancel request is invalid');
    }
    let sandboxId: string | null;
    try {
      sandboxId = await this.services.store.getActiveSandboxId();
    } catch {
      throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Run control storage is unavailable');
    }
    if (!sandboxId) {
      throw new ProblemException('STALE_STATE', 'No active sandbox is available');
    }
    const actor = ActorSchema.parse({
      kind: 'human',
      id: request.auth.userId,
      roles: request.auth.roles,
    });
    try {
      const response = await this.services.cancellation.cancel({
        sandboxId,
        runId,
        request: parsed,
        actor,
        requestId: requestId(request),
        correlationId: correlationId(request),
      });
      return RunControlResponseSchema.parse(response);
    } catch (error) {
      problemFor(error);
    }
  }
}

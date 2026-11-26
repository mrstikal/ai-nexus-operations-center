import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  CaseDetail,
  CaseHistoryResponse,
  CaseListResponse,
  Evidence,
  SandboxSummary,
} from '@nexus/contracts';
import type { CaseService } from '@nexus/application/cases/service';
import {
  CaseNotFoundError,
  CaseValidationError,
  CaseVersionConflictError,
} from '@nexus/application/cases/service';
import {
  SandboxInactiveError,
  SandboxUnavailableError,
} from '@nexus/application/cases/context';
import { ProblemException } from '../errors.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
} from '../auth/guards.js';
import { NEXUS_CASES } from './tokens.js';

function requireService(service: CaseService | null): CaseService {
  if (!service) {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Case storage is not configured',
    );
  }
  return service;
}

function problemFor(error: unknown): never {
  if (error instanceof ProblemException) {
    throw error;
  }
  if (error instanceof CaseNotFoundError) {
    throw new ProblemException('NOT_FOUND', error.message);
  }
  if (error instanceof CaseVersionConflictError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof CaseValidationError) {
    throw new ProblemException('VALIDATION_FAILED', error.message);
  }
  if (error instanceof SandboxInactiveError) {
    throw new ProblemException('STALE_STATE', error.message);
  }
  if (error instanceof SandboxUnavailableError) {
    throw new ProblemException('DEPENDENCY_UNAVAILABLE', error.message);
  }
  throw new ProblemException('DEPENDENCY_UNAVAILABLE', 'Case storage is unavailable');
}

@Controller('api/v1')
export class CasesController {
  constructor(@Inject(NEXUS_CASES) private readonly service: CaseService | null) {}

  @Get('sandbox')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async sandbox(): Promise<SandboxSummary> {
    try {
      return await requireService(this.service).getActiveSandbox();
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('cases')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async listCases(
    @Query('status') status: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<CaseListResponse> {
    try {
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      return await requireService(this.service).listCases({
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('cases/:caseId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async detail(@Param('caseId') caseId: string): Promise<CaseDetail> {
    try {
      return await requireService(this.service).getCase(caseId);
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('cases/:caseId/history')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async history(
    @Param('caseId') caseId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<CaseHistoryResponse> {
    try {
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      return await requireService(this.service).getHistory({
        caseId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      });
    } catch (error) {
      problemFor(error);
    }
  }

  @Get('evidence/:evidenceId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('viewer')
  async evidence(@Param('evidenceId') evidenceId: string): Promise<Evidence> {
    try {
      return await requireService(this.service).getEvidence(evidenceId);
    } catch (error) {
      problemFor(error);
    }
  }
}

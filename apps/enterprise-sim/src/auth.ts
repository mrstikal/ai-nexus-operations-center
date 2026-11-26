import {
  Catch,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ErrorCode } from '@nexus/contracts';
import { ERROR_STATUS } from '@nexus/contracts';
import { UuidSchema } from '@nexus/contracts';
import type { Pool } from 'pg';

export const ENTERPRISE_DB_POOL = Symbol('ENTERPRISE_DB_POOL');
export const ENTERPRISE_READ_TOKEN_ENV = 'ENTERPRISE_SIM_READ_TOKEN';
export const ENTERPRISE_COMMAND_TOKEN_ENV = 'ENTERPRISE_SIM_COMMAND_TOKEN';
const TOKEN_MINIMUM_LENGTH = 32;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface EnterpriseReadContext {
  readonly sandboxId: string;
  readonly businessEffectiveAt: Date;
  readonly correlationId: string;
}

export interface EnterpriseRequest {
  headers: Record<string, string | string[] | undefined>;
  enterpriseContext?: EnterpriseReadContext;
}

export class ProblemException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = 'ProblemException';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

function singleHeader(
  request: EnterpriseRequest,
  name: string,
): string | undefined {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function correlationId(request: EnterpriseRequest): string {
  const value = singleHeader(request, 'x-correlation-id');
  return value && CORRELATION_ID_PATTERN.test(value) ? value : 'unavailable';
}

function writeProblem(
  response: {
    status(code: number): {
      setHeader(name: string, value: string): void;
      json(body: unknown): void;
    };
  },
  code: ErrorCode,
  message: string,
  requestId: string,
  issues?: unknown[],
): void {
  const target = response.status(ERROR_STATUS[code]);
  target.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  target.setHeader('Cache-Control', 'no-store');
  target.json({
    code,
    message,
    requestId,
    ...(issues && issues.length > 0 ? { issues } : {}),
  });
}

function httpErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'DEPENDENCY_UNAVAILABLE';
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<EnterpriseRequest>();
    const response = context.getResponse<{
      status(code: number): {
        setHeader(name: string, value: string): void;
        json(body: unknown): void;
      };
    }>();
    const requestId = correlationId(request);

    if (error instanceof ProblemException) {
      writeProblem(response, error.code, error.message, requestId, error.issues);
      return;
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      writeProblem(
        response,
        httpErrorCode(status),
        status === 404 ? 'Request route was not found' : error.message,
        requestId,
      );
      return;
    }

    writeProblem(
      response,
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise simulator storage is unavailable',
      requestId,
    );
  }
}

function configuredToken(
  name: string,
  env: NodeJS.ProcessEnv,
): string {
  const token = env[name];
  if (typeof token !== 'string' || token.length < TOKEN_MINIMUM_LENGTH) {
    throw new Error(
      `${name} must contain at least ${TOKEN_MINIMUM_LENGTH} characters`,
    );
  }
  return token;
}

export function configuredReadToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredToken(ENTERPRISE_READ_TOKEN_ENV, env);
}

export function configuredCommandToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredToken(ENTERPRISE_COMMAND_TOKEN_ENV, env);
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

interface SandboxRow {
  id: string;
  business_effective_at: Date;
}

async function authorizeEnterpriseRequest(
  context: ExecutionContext,
  pool: Pool,
  expectedDigest: Buffer,
  tokenLabel: string,
): Promise<boolean> {
  const request = context.switchToHttp().getRequest<EnterpriseRequest>();
  const token = bearerToken(singleHeader(request, 'authorization'));
  if (!token || !timingSafeEqual(tokenDigest(token), expectedDigest)) {
    throw new ProblemException(
      'UNAUTHENTICATED',
      `A valid ${tokenLabel} token is required`,
    );
  }

  const sandboxHeader = singleHeader(request, 'x-nexus-sandbox-id');
  const sandbox = UuidSchema.safeParse(sandboxHeader);
  if (!sandbox.success) {
    throw new ProblemException(
      'VALIDATION_FAILED',
      'A valid X-Nexus-Sandbox-Id header is required',
    );
  }

  const correlation = singleHeader(request, 'x-correlation-id');
  if (!correlation || !CORRELATION_ID_PATTERN.test(correlation)) {
    throw new ProblemException(
      'VALIDATION_FAILED',
      'A valid X-Correlation-Id header is required',
    );
  }

  let rows: SandboxRow[];
  try {
    const result = await pool.query<SandboxRow>(
      'SELECT id, business_effective_at FROM enterprise.sandboxes WHERE id = $1',
      [sandbox.data],
    );
    rows = result.rows;
  } catch {
    throw new ProblemException(
      'DEPENDENCY_UNAVAILABLE',
      'Enterprise sandbox storage is unavailable',
    );
  }
  const row = rows[0];
  if (!row) {
    throw new ProblemException('NOT_FOUND', 'Enterprise sandbox was not found');
  }

  request.enterpriseContext = {
    sandboxId: row.id,
    businessEffectiveAt: row.business_effective_at,
    correlationId: correlation,
  };
  return true;
}

@Injectable()
export class EnterpriseReadGuard implements CanActivate {
  private readonly expectedDigest = tokenDigest(configuredReadToken());

  constructor(@Inject(ENTERPRISE_DB_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return authorizeEnterpriseRequest(
      context,
      this.pool,
      this.expectedDigest,
      'read',
    );
  }
}

@Injectable()
export class EnterpriseCommandGuard implements CanActivate {
  private readonly expectedDigest = tokenDigest(configuredCommandToken());

  constructor(@Inject(ENTERPRISE_DB_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return authorizeEnterpriseRequest(
      context,
      this.pool,
      this.expectedDigest,
      'command',
    );
  }
}

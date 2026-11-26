import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ERROR_STATUS, type ErrorCode } from '@nexus/contracts';

export class ProblemException extends Error {
  readonly code: ErrorCode;
  readonly issues: unknown[] | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { issues?: unknown[]; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ProblemException';
    this.code = code;
    this.issues = options.issues;
    this.retryAfterMs = options.retryAfterMs;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

interface ProblemRequest {
  headers?: Record<string, string | string[] | undefined>;
}

interface ProblemResponse {
  status(code: number): ProblemResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requestIdFor(request: ProblemRequest): string {
  const provided = headerValue(request.headers ?? {}, 'x-request-id');
  return provided && provided.length <= 128 ? provided : randomUUID();
}

function codeForStatus(status: number): string {
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
    case 503:
      return 'DEPENDENCY_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<ProblemRequest>();
    const response = context.getResponse<ProblemResponse>();
    const requestId = requestIdFor(request);

    if (error instanceof ProblemException) {
      if (error.retryAfterMs !== undefined) {
        response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      }
      response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.status(error.status).send({
        code: error.code,
        message: error.message,
        requestId,
        ...(error.issues === undefined ? {} : { issues: error.issues }),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      });
      return;
    }

    const status = error instanceof HttpException ? error.getStatus() : 500;
    response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).send({
      code: codeForStatus(status),
      message: status >= 500 ? 'Internal server error' : 'Request failed',
      requestId,
    });
  }
}

import { ERROR_STATUS, type ErrorCode } from '@nexus/contracts';

export const ENTERPRISE_CLIENT_ERROR_CODES = [
  'TIMEOUT',
  'NETWORK',
  'ABORTED',
  'MALFORMED_RESPONSE',
  'RESPONSE_TOO_LARGE',
  'SANDBOX_MISMATCH',
  'UNKNOWN_PROBLEM_CODE',
] as const;

export type EnterpriseClientErrorCode =
  | ErrorCode
  | (typeof ENTERPRISE_CLIENT_ERROR_CODES)[number];

const RETRYABLE_CODES = new Set<EnterpriseClientErrorCode>([
  'TIMEOUT',
  'NETWORK',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
]);

export function isRetryableClientCode(
  code: EnterpriseClientErrorCode,
): boolean {
  return RETRYABLE_CODES.has(code);
}

export function problemCodeForClientCode(
  code: EnterpriseClientErrorCode,
): ErrorCode {
  switch (code) {
    case 'TIMEOUT':
    case 'NETWORK':
    case 'MALFORMED_RESPONSE':
      return 'DEPENDENCY_UNAVAILABLE';
    case 'ABORTED':
      return 'DEPENDENCY_UNAVAILABLE';
    case 'RESPONSE_TOO_LARGE':
      return 'PAYLOAD_TOO_LARGE';
    case 'SANDBOX_MISMATCH':
      return 'FORBIDDEN';
    case 'UNKNOWN_PROBLEM_CODE':
      return 'DEPENDENCY_UNAVAILABLE';
    default:
      return code;
  }
}

export interface EnterpriseClientErrorOptions {
  readonly status?: number | null;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly problemCode?: string | null;
  readonly cause?: unknown;
}

export class EnterpriseClientError extends Error {
  readonly code: EnterpriseClientErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly problemCode: string | null;

  constructor(
    code: EnterpriseClientErrorCode,
    message: string,
    options: EnterpriseClientErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EnterpriseClientError';
    this.code = code;
    this.retryable = isRetryableClientCode(code);
    this.status =
      options.status === undefined
        ? ERROR_STATUS[problemCodeForClientCode(code)]
        : options.status;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.problemCode = options.problemCode ?? null;
  }
}

export function asEnterpriseClientError(error: unknown): EnterpriseClientError {
  if (error instanceof EnterpriseClientError) {
    return error;
  }
  return new EnterpriseClientError(
    'NETWORK',
    'Enterprise simulator request failed',
    { cause: error },
  );
}

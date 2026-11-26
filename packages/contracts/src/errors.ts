import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_STATE',
  'IDEMPOTENCY_MISMATCH',
  'APPROVAL_EXPIRED',
  'UNSUPPORTED_MEDIA',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'BUDGET_EXHAUSTED',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_STATE: 409,
  IDEMPOTENCY_MISMATCH: 409,
  APPROVAL_EXPIRED: 409,
  UNSUPPORTED_MEDIA: 415,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  BUDGET_EXHAUSTED: 409,
};

export const ValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string().max(128), z.number().int().nonnegative()])).max(20),
    message: z.string().min(1).max(1000),
    code: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

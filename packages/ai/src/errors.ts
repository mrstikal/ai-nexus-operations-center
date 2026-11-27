import type { ModelFailureCode } from '@nexus/contracts';

/**
 * Failures that may justify the single configured fallback attempt.
 * Authorization, moderation, context, privacy, schema and deterministic
 * business failures are never retried automatically.
 */
export const FALLBACK_ELIGIBLE_CODES: ReadonlySet<ModelFailureCode> = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'UNAVAILABLE',
]);

export function isRetryableCode(code: ModelFailureCode): boolean {
  return FALLBACK_ELIGIBLE_CODES.has(code);
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

export class ModelLimitError extends Error {
  constructor(
    readonly kind: 'physical_attempt' | 'tool_round' | 'tool_call',
    message: string,
  ) {
    super(message);
    this.name = 'ModelLimitError';
  }
}

export class BudgetAdmissionError extends Error {
  constructor(
    readonly reason: 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_CLOSED' | 'CAP_EXCEEDED' | 'INVALID_AMOUNT' | 'SANDBOX_MISMATCH' | 'DEPTH_EXCEEDED' | 'PARENT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetAdmissionError';
  }
}

export class ReplayMissError extends Error {
  constructor(readonly replayKey: string) {
    super('No replay record matches the normalized semantic request');
    this.name = 'ReplayMissError';
  }
}

export class ReplayManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayManifestError';
  }
}

export class ModelCallLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCallLedgerError';
  }
}

export const AUDIT_ALLOWED_KEYS = [
  'caseId',
  'caseVersion',
  'caseStatus',
  'evidenceId',
  'entityType',
  'entityId',
  'entityVersion',
  'action',
  'outcome',
  'status',
  'reasonCode',
  'sourceKind',
  'contentHash',
  'sequence',
  'proposalId',
  'actionRevisionId',
  'planHash',
  'policyRevision',
  'policyContentHash',
  'role',
  'decision',
] as const;
export type AuditDetailKey = (typeof AUDIT_ALLOWED_KEYS)[number];
export type AuditDetails = Partial<Record<AuditDetailKey, string | number | boolean | null>>;

export class RedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionError';
  }
}

function cleanValue(key: string, value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RedactionError(`Audit value ${key} must be finite`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 500) {
      throw new RedactionError(`Audit value ${key} exceeds its length bound`);
    }
    if ([...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) {
      throw new RedactionError(`Audit value ${key} contains control characters`);
    }
    return value;
  }
  throw new RedactionError(`Audit value ${key} must be a primitive`);
}

export function sanitizeAuditDetails(input: unknown): AuditDetails {
  if (input === undefined) {
    return {};
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RedactionError('Audit details must be a plain object');
  }
  const result: AuditDetails = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!AUDIT_ALLOWED_KEYS.includes(key as AuditDetailKey)) {
      throw new RedactionError(`Audit detail ${key} is not allowlisted`);
    }
    result[key as AuditDetailKey] = cleanValue(key, value);
  }
  return result;
}

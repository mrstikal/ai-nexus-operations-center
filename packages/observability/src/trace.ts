export const TRACE_ALLOWED_KEYS = [
  'event',
  'step',
  'status',
  'durationMs',
  'attempt',
  'count',
  'errorClass',
  'entityType',
  'entityId',
  'version',
  'model',
  'provider',
  'inputTokens',
  'outputTokens',
  'costMicrousd',
  'retry',
  'requestId',
  'correlationId',
] as const;
export type TraceDataKey = (typeof TRACE_ALLOWED_KEYS)[number];
export type TraceData = Partial<Record<TraceDataKey, string | number | boolean | null>>;

export class TraceRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceRedactionError';
  }
}

function cleanTraceValue(key: string, value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TraceRedactionError(`Trace value ${key} must be finite`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 200) {
      throw new TraceRedactionError(`Trace value ${key} exceeds its length bound`);
    }
    if ([...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) {
      throw new TraceRedactionError(`Trace value ${key} contains control characters`);
    }
    return value;
  }
  throw new TraceRedactionError(`Trace value ${key} must be a primitive`);
}

export function sanitizeTraceData(input: unknown): TraceData {
  if (input === undefined) {
    return {};
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TraceRedactionError('Trace data must be a plain object');
  }
  const result: TraceData = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!TRACE_ALLOWED_KEYS.includes(key as TraceDataKey)) {
      throw new TraceRedactionError(`Trace key ${key} is not allowlisted`);
    }
    result[key as TraceDataKey] = cleanTraceValue(key, value);
  }
  return result;
}

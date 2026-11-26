export const DEFAULT_BUSINESS_EFFECTIVE_AT = '2026-11-02T09:00:00Z';

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export interface Clock {
  now(): Date;
}

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

export function assertIsoUtc(value: string): string {
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ClockError(`Expected an ISO-8601 UTC timestamp ending in Z: ${value}`);
  }
  return value;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: string): Clock {
  const milliseconds = Date.parse(assertIsoUtc(at));
  return {
    now: () => new Date(milliseconds),
  };
}

export interface BusinessClock {
  readonly effectiveAt: string;
  readonly real: Clock;
}

export function businessClock(
  effectiveAt: string = DEFAULT_BUSINESS_EFFECTIVE_AT,
  real: Clock = systemClock,
): BusinessClock {
  return { effectiveAt: assertIsoUtc(effectiveAt), real };
}

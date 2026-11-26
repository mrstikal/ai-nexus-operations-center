export const MAX_ABS_MINOR = 1_000_000_000_000n;
export const BASIS_POINTS_DENOMINATOR = 10_000n;

const MINOR_PATTERN = /^-?(?:0|[1-9]\d*)$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertMinorBound(value: bigint): bigint {
  const absolute = value < 0n ? -value : value;
  if (absolute > MAX_ABS_MINOR) {
    throw new MoneyError(`Money amount exceeds the absolute bound ${MAX_ABS_MINOR.toString()}`);
  }
  return value;
}

export function parseMinor(value: string): bigint {
  if (!MINOR_PATTERN.test(value) || value === '-0' || value.length > 14) {
    throw new MoneyError(`Invalid minor amount ${JSON.stringify(value)}`);
  }
  return assertMinorBound(BigInt(value));
}

export function formatMinor(value: bigint): string {
  assertMinorBound(value);
  return value.toString();
}

export function addMinor(...values: readonly bigint[]): bigint {
  return assertMinorBound(values.reduce((total, value) => total + value, 0n));
}

export function negateMinor(value: bigint): bigint {
  return assertMinorBound(-value);
}

export function absMinor(value: bigint): bigint {
  return assertMinorBound(value < 0n ? -value : value);
}

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new MoneyError('Denominator must be positive');
  }
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function assertBasisPoints(rate: number): number {
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    throw new MoneyError('Tax rate must be integer basis points from 0 to 10000');
  }
  return rate;
}

export function taxMinor(netMinor: bigint, rateBasisPoints: number): bigint {
  const rate = BigInt(assertBasisPoints(rateBasisPoints));
  return assertMinorBound(
    roundHalfUp(assertMinorBound(netMinor) * rate, BASIS_POINTS_DENOMINATOR),
  );
}

export function grossMinor(netMinor: bigint, rateBasisPoints: number): bigint {
  return addMinor(netMinor, taxMinor(netMinor, rateBasisPoints));
}

export interface PenaltyInput {
  readonly lateDays: number;
  readonly dailyMinor: bigint;
  readonly capMinor: bigint;
}

export function penaltyMinor({ lateDays, dailyMinor, capMinor }: PenaltyInput): bigint {
  if (!Number.isInteger(lateDays) || lateDays < 0) {
    throw new MoneyError('Late days must be a non-negative integer');
  }
  if (dailyMinor < 0n || capMinor < 0n) {
    throw new MoneyError('Daily penalty and cap must be non-negative');
  }
  const raw = assertMinorBound(BigInt(lateDays) * dailyMinor);
  return assertMinorBound(raw < capMinor ? raw : capMinor);
}

export function sumTaxedLines(
  lines: readonly { readonly netMinor: bigint; readonly taxRateBps: number }[],
): { readonly netMinor: bigint; readonly taxMinor: bigint; readonly grossMinor: bigint } {
  let net = 0n;
  let tax = 0n;
  for (const line of lines) {
    net = addMinor(net, line.netMinor);
    tax = addMinor(tax, taxMinor(line.netMinor, line.taxRateBps));
  }
  return { netMinor: net, taxMinor: tax, grossMinor: addMinor(net, tax) };
}

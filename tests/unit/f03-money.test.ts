import { describe, expect, it } from 'vitest';
import {
  MAX_ABS_MINOR,
  MoneyError,
  addMinor,
  formatMinor,
  grossMinor,
  parseMinor,
  penaltyMinor,
  roundHalfUp,
  sumTaxedLines,
  taxMinor,
} from '@nexus/domain/money';

describe('F03 money and tax vectors', () => {
  it('parses and formats canonical signed minor strings exactly', () => {
    expect(parseMinor('0')).toBe(0n);
    expect(parseMinor('123456')).toBe(123456n);
    expect(parseMinor('-500')).toBe(-500n);
    expect(formatMinor(-500n)).toBe('-500');
    expect(formatMinor(MAX_ABS_MINOR)).toBe('1000000000000');
  });

  it('rejects non-canonical, oversized and negative-zero amounts', () => {
    for (const value of ['01', '-0', '1e3', '1.5', '+5', ' 5', '1000000000001']) {
      expect(() => parseMinor(value), value).toThrow(MoneyError);
    }
    expect(() => formatMinor(MAX_ABS_MINOR + 1n)).toThrow(MoneyError);
    expect(() => addMinor(MAX_ABS_MINOR, 1n)).toThrow(MoneyError);
  });

  it('rounds half up once per line, including negative credit amounts', () => {
    expect(taxMinor(1050n, 1900)).toBe(200n);
    expect(taxMinor(1001n, 1900)).toBe(190n);
    expect(taxMinor(-1050n, 1900)).toBe(-200n);
    expect(grossMinor(1050n, 1900)).toBe(1250n);
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(4n, 2n)).toBe(2n);
    expect(() => roundHalfUp(1n, 0n)).toThrow(MoneyError);
  });

  it('sums already-rounded line taxes exactly', () => {
    const result = sumTaxedLines([
      { netMinor: 333n, taxRateBps: 1900 },
      { netMinor: 333n, taxRateBps: 1900 },
      { netMinor: -100n, taxRateBps: 1900 },
    ]);
    expect(result).toEqual({ netMinor: 566n, taxMinor: 107n, grossMinor: 673n });
  });

  it('computes penalty as whole days times daily amount capped exactly', () => {
    expect(penaltyMinor({ lateDays: 3, dailyMinor: 1000n, capMinor: 2500n })).toBe(2500n);
    expect(penaltyMinor({ lateDays: 2, dailyMinor: 1000n, capMinor: 2500n })).toBe(2000n);
    expect(penaltyMinor({ lateDays: 0, dailyMinor: 1000n, capMinor: 2500n })).toBe(0n);
    expect(() => penaltyMinor({ lateDays: -1, dailyMinor: 1000n, capMinor: 2500n })).toThrow(
      MoneyError,
    );
  });

  it('rejects invalid tax rates and bounds operation results', () => {
    expect(() => taxMinor(100n, 10_001)).toThrow(MoneyError);
    expect(() => taxMinor(100n, 1.5)).toThrow(MoneyError);
    expect(() => grossMinor(MAX_ABS_MINOR, 10_000)).toThrow(MoneyError);
  });
});

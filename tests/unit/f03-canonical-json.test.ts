import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJsonBytes,
  canonicalJsonSha256,
  canonicalizeJson,
} from '@nexus/domain/canonical-json';

describe('F03 canonical JSON', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ z: [{ b: 1, a: 2 }] })).toBe('{"z":[{"a":2,"b":1}]}');
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalizeJson([1, 3, 2])).not.toBe(canonicalizeJson([3, 1, 2]));
  });

  it('hashes the same value identically regardless of object key order', () => {
    expect(canonicalJsonSha256({ b: [1, 2], a: { d: true, c: null } })).toBe(
      canonicalJsonSha256({ a: { c: null, d: true }, b: [1, 2] }),
    );
  });

  it('rejects undefined, non-finite numbers, non-plain objects and cycles', () => {
    expect(() => canonicalizeJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalizeJson({ a: new Date('2026-11-02T09:00:00Z') })).toThrow(
      CanonicalJsonError,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it('normalizes negative zero and hashes UTF-8 bytes', () => {
    expect(canonicalizeJson(-0)).toBe('0');
    const bytes = canonicalJsonBytes({ currency: '€' });
    expect(new TextDecoder().decode(bytes)).toBe('{"currency":"€"}');
    expect(canonicalJsonSha256({ currency: '€' })).toMatch(/^[a-f0-9]{64}$/);
  });
});

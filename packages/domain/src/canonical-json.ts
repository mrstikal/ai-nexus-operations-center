import { createHash } from 'node:crypto';

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('Non-finite numbers are not canonical JSON');
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'undefined':
      throw new CanonicalJsonError('Undefined is not canonical JSON');
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not canonical JSON`);
    case 'object':
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new CanonicalJsonError('Circular references are not canonical JSON');
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Only plain objects are canonical JSON');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => {
      if (record[key] === undefined) {
        throw new CanonicalJsonError(`Undefined value at key ${key} is not canonical JSON`);
      }
      return `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
}

export function assertCanonicalJsonSerializable(value: unknown): void {
  canonicalizeJson(value);
}

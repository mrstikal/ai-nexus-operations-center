import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export interface ScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

export interface PasswordHashRecord {
  readonly hash: string;
  readonly salt: string;
  readonly params: ScryptParams;
}

export const SCRYPT_MEMORY_ALLOWANCE = 64 * 1024 * 1024;
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  n: 32768,
  r: 8,
  p: 1,
  keylen: 64,
};

function validateParams(params: ScryptParams): ScryptParams {
  if (
    !Number.isInteger(params.n) ||
    params.n < 16384 ||
    params.n > 65536 ||
    (params.n & (params.n - 1)) !== 0 ||
    !Number.isInteger(params.r) ||
    params.r < 1 ||
    params.r > 16 ||
    !Number.isInteger(params.p) ||
    params.p < 1 ||
    params.p > 4 ||
    !Number.isInteger(params.keylen) ||
    params.keylen < 32 ||
    params.keylen > 64
  ) {
    throw new Error('Unsupported password hash parameters');
  }
  const requiredMemory = 128 * params.n * params.r;
  if (requiredMemory > SCRYPT_MEMORY_ALLOWANCE) {
    throw new Error('Password hash memory requirement exceeds the configured allowance');
  }
  return params;
}

function assertPasswordInput(password: string): void {
  if (password.length < 1 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Invalid password length');
  }
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<PasswordHashRecord> {
  assertPasswordInput(password);
  const validated = validateParams(params);
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, validated.keylen, {
    N: validated.n,
    r: validated.r,
    p: validated.p,
    maxmem: SCRYPT_MEMORY_ALLOWANCE,
  });
  return {
    hash: derived.toString('base64url'),
    salt: salt.toString('base64url'),
    params: validated,
  };
}

export async function verifyPassword(
  password: string,
  record: PasswordHashRecord,
): Promise<boolean> {
  assertPasswordInput(password);
  const params = validateParams(record.params);
  const expected = Buffer.from(record.hash, 'base64url');
  const salt = Buffer.from(record.salt, 'base64url');
  if (expected.length !== params.keylen || salt.length < 16) {
    return false;
  }
  const actual = await scryptAsync(password, salt, expected.length, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MEMORY_ALLOWANCE,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

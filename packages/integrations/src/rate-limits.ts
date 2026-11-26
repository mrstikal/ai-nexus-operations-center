import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

export interface LoginRateLimitConfig {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly usernameLimit: number;
  readonly ipLimit: number;
  readonly windowSeconds: number;
}

export interface LoginAttemptKey {
  readonly ip: string;
  readonly username: string;
}

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Too many login attempts');
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimitUnavailableError extends Error {
  constructor(message = 'Login admission cache is unavailable') {
    super(message);
    this.name = 'RateLimitUnavailableError';
  }
}

export const LOGIN_USERNAME_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const RESERVE_SCRIPT = `
local failures = tonumber(redis.call('GET', KEYS[1]) or '0')
local active = tonumber(redis.call('GET', KEYS[2]) or '0')
local attempts = tonumber(redis.call('GET', KEYS[3]) or '0')
if failures + active >= tonumber(ARGV[1]) or attempts >= tonumber(ARGV[2]) then
  return 0
end
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 120)
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], ARGV[3])
return 1
`;

const FAILURE_SCRIPT = `
local active = tonumber(redis.call('GET', KEYS[2]) or '0')
if active > 0 then
  redis.call('DECR', KEYS[2])
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1
`;

const SUCCESS_SCRIPT = `
local active = tonumber(redis.call('GET', KEYS[2]) or '0')
if active > 0 then
  redis.call('DECR', KEYS[2])
end
redis.call('DEL', KEYS[1])
return 1
`;

const CHALLENGE_RELEASE_SCRIPT = `
local active = tonumber(redis.call('GET', KEYS[1]) or '0')
if active > 0 then
  redis.call('DECR', KEYS[1])
end
return 1
`;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '6379');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid VALKEY_PORT');
  }
  return port;
}

export class LoginRateLimiter {
  private clientInstance: Redis | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly config: LoginRateLimitConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LoginRateLimiter {
    return new LoginRateLimiter({
      host: env['VALKEY_HOST'] ?? '127.0.0.1',
      port: parsePort(env['VALKEY_PORT']),
      password: env['VALKEY_PASSWORD'] ?? '',
      usernameLimit: LOGIN_USERNAME_LIMIT,
      ipLimit: LOGIN_IP_LIMIT,
      windowSeconds: LOGIN_WINDOW_SECONDS,
    });
  }

  private keys(attempt: LoginAttemptKey): {
    failuresKey: string;
    activeKey: string;
    ipKey: string;
  } {
    const userHash = hash(attempt.username.toLowerCase());
    return {
      failuresKey: `login:user:failures:${userHash}`,
      activeKey: `login:user:active:${userHash}`,
      ipKey: `login:ip:attempts:${hash(attempt.ip)}`,
    };
  }

  private client(): Redis {
    if (!this.config.password) {
      throw new RateLimitUnavailableError('VALKEY_PASSWORD is not configured');
    }
    if (!this.clientInstance) {
      this.clientInstance = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        commandTimeout: 1000,
      });
      this.clientInstance.on('error', () => undefined);
    }
    return this.clientInstance;
  }

  private async readyClient(): Promise<Redis> {
    const client = this.client();
    if (client.status === 'ready') {
      return client;
    }
    if (!this.connectPromise) {
      this.connectPromise = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          client.off('ready', onReady);
          client.off('error', onError);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new RateLimitUnavailableError());
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new RateLimitUnavailableError('Valkey connection timed out'));
        }, 2000);
        client.once('ready', onReady);
        client.once('error', onError);
        if (client.status === 'wait') {
          void client.connect().catch(() => onError());
        }
      }).finally(() => {
        this.connectPromise = null;
      });
    }
    try {
      await this.connectPromise;
    } catch {
      throw new RateLimitUnavailableError();
    }
    return client;
  }

  async admit(attempt: LoginAttemptKey): Promise<void> {
    try {
      const client = await this.readyClient();
      const { failuresKey, activeKey, ipKey } = this.keys(attempt);
      const reserved = await client.eval(
        RESERVE_SCRIPT,
        3,
        failuresKey,
        activeKey,
        ipKey,
        String(this.config.usernameLimit),
        String(this.config.ipLimit),
        String(this.config.windowSeconds),
      );
      if (Number(reserved) !== 1) {
        throw new RateLimitedError(this.config.windowSeconds * 1000);
      }
    } catch (error) {
      if (error instanceof RateLimitedError) {
        throw error;
      }
      throw new RateLimitUnavailableError();
    }
  }

  async recordFailure(attempt: LoginAttemptKey): Promise<void> {
    try {
      const client = await this.readyClient();
      const { failuresKey, activeKey } = this.keys(attempt);
      await client.eval(
        FAILURE_SCRIPT,
        2,
        failuresKey,
        activeKey,
        String(this.config.windowSeconds),
      );
    } catch {
      throw new RateLimitUnavailableError();
    }
  }

  async recordSuccess(attempt: LoginAttemptKey): Promise<void> {
    try {
      const client = await this.readyClient();
      const { failuresKey, activeKey } = this.keys(attempt);
      await client.eval(SUCCESS_SCRIPT, 2, failuresKey, activeKey);
    } catch {
      // A failed reset cannot grant a privilege; the conservative failure count remains.
    }
  }

  async releaseChallenge(attempt: LoginAttemptKey): Promise<void> {
    try {
      const client = await this.readyClient();
      await client.eval(CHALLENGE_RELEASE_SCRIPT, 1, this.keys(attempt).activeKey);
    } catch {
      // A failed release only leaves a conservative active reservation in place.
    }
  }

  async admitMutation(): Promise<void> {
    try {
      const client = await this.readyClient();
      const pong = await client.ping();
      if (pong !== 'PONG') {
        throw new RateLimitUnavailableError();
      }
    } catch {
      throw new RateLimitUnavailableError('Mutation admission cache is unavailable');
    }
  }

  async close(): Promise<void> {
    if (this.clientInstance) {
      try {
        await this.clientInstance.quit();
      } finally {
        this.clientInstance = null;
      }
    }
  }
}

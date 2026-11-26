import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RoleSchema, type Role } from '@nexus/contracts';
import {
  applyMigrations,
  loadMigrations,
} from '@nexus/db/migrate';
import {
  createNexusDb,
  createNexusPool,
} from '@nexus/db/connection';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';
import { hasPermission } from '@nexus/application/identity/permissions';
import { pauseService, unpauseService } from '../../tools/lib/infra.mjs';

const { Client: PgClient } = pg;
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const allowedOrigin = 'http://127.0.0.1:3000';
const testPassword = 'f04-test-password-only';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F04`);
  }
  return value;
}

function pgConfig(user: string, password: string): ConstructorParameters<typeof PgClient>[0] {
  return {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f04-auth-test',
    connectionTimeoutMillis: 5000,
  };
}

function superuserClient(): Client {
  return new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
      requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    ),
  );
}

async function withClient<T>(client: Client, operation: (value: Client) => Promise<T>): Promise<T> {
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function applyIdentityMigrations(): Promise<void> {
  await withClient(
    new PgClient(
      pgConfig(
        requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
        requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
      ),
    ),
    async (client) => {
      await applyMigrations(client, {
        schema: 'nexus',
        migrations: loadMigrations(path.join(repoRoot, 'packages/db/migrations')),
      });
    },
  );
}

interface SeedFixture {
  users: Array<{ username: string; displayName: string; roles: string[] }>;
}

async function seedIdentity(): Promise<void> {
  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, 'fixtures/users/roles.json'), 'utf8'),
  ) as SeedFixture;
  const pool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  try {
    const db = createNexusDb(pool);
    for (const user of fixture.users) {
      const roles: Role[] = RoleSchema.array().parse(user.roles);
      const password = await hashPassword(testPassword);
      await createIdentityUser(db, {
        username: user.username,
        displayName: user.displayName,
        roles,
        password,
      });
    }
  } finally {
    await pool.end();
  }
}

interface SpawnedApp {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitForReady: () => Promise<number>;
}

function spawnAuthApp(): SpawnedApp {
  const entry = path.join(repoRoot, 'apps/api/dist/auth/test-app.js');
  if (!existsSync(entry)) {
    throw new Error('Compiled auth test app is missing; run pnpm build first');
  }
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
      NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
      NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
      NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
      NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
      VALKEY_HOST: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
      VALKEY_PORT: requiredEnv('NEXUS_TEST_VALKEY_PORT'),
      VALKEY_PASSWORD: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
      NEXUS_ALLOWED_ORIGINS: allowedOrigin,
      NEXUS_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const waitForReady = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Auth test app did not start. stdout: ${stdout} stderr: ${stderr}`));
      }, 15000);
      const check = () => {
        const match = /NEXUS_AUTH_TEST_READY port=(\d+)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          const value = Number(match[1]);
          if (!Number.isInteger(value) || value < 1) {
            reject(new Error('Auth test app returned an invalid port'));
          } else {
            resolve(value);
          }
          return;
        }
        if (child.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error(`Auth test app exited early. stderr: ${stderr}`));
        }
      };
      child.stdout?.on('data', check);
      check();
    });
  return { child, stdout: () => stdout, stderr: () => stderr, waitForReady };
}

async function stopAuthApp(app: SpawnedApp): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    app.child.kill('SIGTERM');
  }
  await new Promise<void>((resolve) => {
    if (app.child.exitCode !== null || app.child.signalCode !== null) {
      resolve();
      return;
    }
    app.child.once('exit', () => resolve());
    setTimeout(() => {
      if (app.child.exitCode === null && app.child.signalCode === null) {
        app.child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
  });
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  setCookie: string | null;
}

async function request(
  baseUrl: string,
  route: string,
  options: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { status: response.status, headers: response.headers, body, setCookie };
}

async function obtainCsrf(baseUrl: string, cookie?: string): Promise<string> {
  const response = await request(baseUrl, '/api/v1/auth/csrf', {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : {},
  });
  expect(response.status).toBe(200);
  const body = response.body as { csrfToken: string };
  expect(typeof body.csrfToken).toBe('string');
  return body.csrfToken;
}

async function loginAttempt(
  baseUrl: string,
  username: string,
  password: string,
  options: { origin?: string | null; csrfToken?: string; csrf?: string } = {},
): Promise<ApiResponse> {
  const csrf = options.csrf ?? (await obtainCsrf(baseUrl));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': options.csrfToken ?? csrf,
  };
  if (options.origin !== null) {
    headers['Origin'] = options.origin ?? allowedOrigin;
  }
  return request(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password }),
  });
}

function cookieFrom(response: ApiResponse): string {
  expect(response.setCookie).not.toBeNull();
  return response.setCookie!.split(';')[0] ?? '';
}

function cookieAttributes(response: ApiResponse): string {
  return response.setCookie ?? '';
}

async function flushRateLimits(): Promise<void> {
  const redis = new Redis({
    host: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_VALKEY_PORT')),
    password: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

function sessionDigest(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

async function waitForValkey(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const redis = new Redis({
      host: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
      port: Number(requiredEnv('NEXUS_TEST_VALKEY_PORT')),
      password: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      const pong = await redis.ping();
      redis.disconnect();
      if (pong === 'PONG') {
        return;
      }
    } catch {
      redis.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Valkey did not recover within the test timeout');
}

let authApp: SpawnedApp;
let baseUrl = '';
let superuser: Client;

beforeAll(async () => {
  expect(requiredEnv('NEXUS_TEST_PG_HOST')).toBe('127.0.0.1');
  expect(requiredEnv('NEXUS_TEST_VALKEY_HOST')).toBe('127.0.0.1');
  expect(requiredEnv('NEXUS_TEST_COMPOSE_PROJECT')).toMatch(/^nexus-test-/);
  if (!existsSync(path.join(repoRoot, 'apps/api/dist/auth/test-app.js'))) {
    throw new Error('Compiled auth test app is missing; run pnpm build first');
  }
  await applyIdentityMigrations();
  await seedIdentity();
  superuser = superuserClient();
  await superuser.connect();
  authApp = spawnAuthApp();
  const port = await authApp.waitForReady();
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await flushRateLimits();
});

afterAll(async () => {
  if (authApp) {
    await stopAuthApp(authApp);
  }
  if (superuser) {
    await superuser.end();
  }
});

describe('F04 authentication and authorization', () => {
  it('matches the viewer/operator permission matrix without implicit approvals', () => {
    expect(hasPermission(['viewer'], 'document:read')).toBe(true);
    expect(hasPermission(['viewer'], 'document:upload')).toBe(false);
    expect(hasPermission(['operator'], 'proposal:clarify')).toBe(true);
    expect(hasPermission(['admin'], 'approval:finance')).toBe(false);
  });

  it('logs in a real user, sets a host-only session cookie, and serves identity only', async () => {
    const response = await loginAttempt(baseUrl, 'operator', testPassword);
    expect(response.status).toBe(200);
    const body = response.body as {
      user: { username: string; roles: string[] };
      csrfToken: string;
      expiresAt: string;
    };
    expect(body.user).toMatchObject({
      username: 'operator',
      roles: ['operator', 'viewer'],
    });
    expect(body.csrfToken.length).toBeGreaterThanOrEqual(16);
    expect(body.expiresAt).toMatch(/Z$/);
    expect(JSON.stringify(body)).not.toContain('sandbox');

    const attributes = cookieAttributes(response);
    expect(attributes).toContain('HttpOnly');
    expect(attributes).toContain('SameSite=Lax');
    expect(attributes).toContain('Path=/');
    expect(attributes).toContain('Max-Age=28800');
    expect(attributes).not.toContain('Domain=');
    expect(attributes).not.toContain('Secure');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const cookie = cookieFrom(response);
    const sessionToken = cookie.slice(cookie.indexOf('=') + 1);
    const session = await superuser.query<{
      token_digest: string;
      csrf_digest: string;
      ttl_seconds: number;
    }>(
      `SELECT token_digest, csrf_digest,
              extract(epoch FROM (expires_at - created_at))::int AS ttl_seconds
       FROM nexus.sessions
       WHERE token_digest = $1`,
      [sessionDigest(sessionToken)],
    );
    expect(session.rows[0]?.token_digest).not.toBe(sessionToken);
    expect(session.rows[0]?.token_digest).toHaveLength(64);
    expect(session.rows[0]?.csrf_digest).not.toBe(body.csrfToken);
    expect(session.rows[0]?.ttl_seconds).toBe(28800);

    const storedPassword = await superuser.query<{ password_hash: string }>(
      "SELECT password_hash FROM nexus.users WHERE lower(username) = 'operator'",
    );
    expect(storedPassword.rows[0]?.password_hash).not.toBe(testPassword);
    expect(storedPassword.rows[0]?.password_hash).not.toContain(testPassword);

    const me = await request(baseUrl, '/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { username: 'operator', roles: ['operator', 'viewer'] },
    });
    expect(JSON.stringify(me.body)).not.toContain('sandbox');
  });

  it('denies anonymous, wrong-role and forged-header requests using server roles', async () => {
    const anonymous = await request(baseUrl, '/api/v1/auth/_test/read');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toContain('application/problem+json');

    const operatorLogin = await loginAttempt(baseUrl, 'operator', testPassword);
    const operatorCookie = cookieFrom(operatorLogin);
    const operatorRead = await request(baseUrl, '/api/v1/auth/_test/operator', {
      headers: { Cookie: operatorCookie, 'X-Nexus-Roles': 'admin' },
    });
    expect(operatorRead.status).toBe(200);

    const operatorFinance = await request(baseUrl, '/api/v1/auth/_test/finance', {
      headers: { Cookie: operatorCookie, 'X-Nexus-Roles': 'admin' },
    });
    expect(operatorFinance.status).toBe(403);

    const financeLogin = await loginAttempt(baseUrl, 'finance.admin', testPassword);
    const financeCookie = cookieFrom(financeLogin);
    const financeRoute = await request(baseUrl, '/api/v1/auth/_test/finance', {
      headers: { Cookie: financeCookie },
    });
    expect(financeRoute.status).toBe(200);

    const forgedBody = await loginAttempt(baseUrl, 'operator', testPassword, {
      csrfToken: '',
    });
    expect(forgedBody.status).toBe(403);

    const bodyWithRoles = await request(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        'X-CSRF-Token': await obtainCsrf(baseUrl),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'operator', password: testPassword, roles: ['admin'] }),
    });
    expect(bodyWithRoles.status).toBe(400);
  });

  it('rejects missing/wrong Origin and CSRF, replayed and expired challenges', async () => {
    const noOrigin = await loginAttempt(baseUrl, 'operator', testPassword, { origin: null });
    expect(noOrigin.status).toBe(403);

    const wrongOrigin = await loginAttempt(baseUrl, 'operator', testPassword, {
      origin: 'http://evil.test',
    });
    expect(wrongOrigin.status).toBe(403);

    const challenge = await obtainCsrf(baseUrl);
    const missingCsrf = await loginAttempt(baseUrl, 'operator', testPassword, { csrfToken: '' });
    expect(missingCsrf.status).toBe(403);

    const wrongCsrf = await loginAttempt(baseUrl, 'operator', testPassword, {
      csrfToken: 'not-the-challenge',
    });
    expect(wrongCsrf.status).toBe(403);

    const replay = await loginAttempt(baseUrl, 'operator', testPassword, { csrf: challenge });
    expect(replay.status).toBe(200);
    const replayed = await loginAttempt(baseUrl, 'operator', testPassword, { csrf: challenge });
    expect(replayed.status).toBe(403);

    const rotationLogin = await loginAttempt(baseUrl, 'operator', testPassword);
    const rotationCookie = cookieFrom(rotationLogin);
    const crossSiteRefresh = await request(baseUrl, '/api/v1/auth/csrf', {
      headers: { Cookie: rotationCookie, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSiteRefresh.status).toBe(403);
    const sameOriginRefresh = await request(baseUrl, '/api/v1/auth/csrf', {
      headers: { Cookie: rotationCookie, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(sameOriginRefresh.status).toBe(200);

    const expiredChallenge = await obtainCsrf(baseUrl);
    await superuser.query(
      `UPDATE nexus.preauth_challenges
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE token_digest = $1`,
      [sessionDigest(expiredChallenge)],
    );
    const expired = await loginAttempt(baseUrl, 'operator', testPassword, {
      csrf: expiredChallenge,
    });
    expect(expired.status).toBe(403);
  });

  it('invalidates the session on logout and rejects a missing CSRF logout', async () => {
    const login = await loginAttempt(baseUrl, 'operator', testPassword);
    const cookie = cookieFrom(login);
    const csrfToken = (login.body as { csrfToken: string }).csrfToken;

    const withoutCsrf = await request(baseUrl, '/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: allowedOrigin },
    });
    expect(withoutCsrf.status).toBe(403);

    const logout = await request(baseUrl, '/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: allowedOrigin,
        'X-CSRF-Token': csrfToken,
      },
    });
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ loggedOut: true });

    const me = await request(baseUrl, '/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(401);

    const token = cookie.slice(cookie.indexOf('=') + 1);
    const session = await superuser.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM nexus.sessions WHERE token_digest = $1',
      [sessionDigest(token)],
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
  });

  it('rejects an expired session and rechecks roles on each protected request', async () => {
    const login = await loginAttempt(baseUrl, 'operator', testPassword);
    const cookie = cookieFrom(login);
    const token = cookie.slice(cookie.indexOf('=') + 1);

    const operatorBefore = await request(baseUrl, '/api/v1/auth/_test/operator', {
      headers: { Cookie: cookie },
    });
    expect(operatorBefore.status).toBe(200);

    await superuser.query(
      "DELETE FROM nexus.user_roles WHERE user_id = (SELECT id FROM nexus.users WHERE lower(username) = 'operator') AND role = 'operator'",
    );
    try {
      const operatorAfter = await request(baseUrl, '/api/v1/auth/_test/operator', {
        headers: { Cookie: cookie },
      });
      expect(operatorAfter.status).toBe(403);
      const meAfter = await request(baseUrl, '/api/v1/auth/me', {
        headers: { Cookie: cookie },
      });
      expect(meAfter.status).toBe(200);
    } finally {
      await superuser.query(
        "INSERT INTO nexus.user_roles (user_id, role) SELECT id, 'operator' FROM nexus.users WHERE lower(username) = 'operator' ON CONFLICT DO NOTHING",
      );
    }

    await superuser.query(
      "UPDATE nexus.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_digest = $1",
      [sessionDigest(token)],
    );
    const expired = await request(baseUrl, '/api/v1/auth/me', {
      headers: { Cookie: cookie },
    });
    expect(expired.status).toBe(401);
  });

  it('grants the worker only the readonly approver role view', async () => {
    await withClient(
      new PgClient(
        pgConfig(
          requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
          requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
        ),
      ),
      async (client) => {
        const view = await client.query<{ roles: string[]; is_active: boolean }>(
          'SELECT roles, is_active FROM nexus.approver_role_view LIMIT 5',
        );
        expect(view.rows.length).toBeGreaterThan(0);
        await expect(
          client.query('SELECT password_hash FROM nexus.users LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          client.query('SELECT token_digest FROM nexus.sessions LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );
  });

  it('releases the reservation when the CSRF challenge is invalid', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await loginAttempt(baseUrl, 'operator', testPassword, {
        csrfToken: 'invalid-challenge',
      });
      expect(rejected.status).toBe(403);
    }
    const valid = await loginAttempt(baseUrl, 'operator', testPassword);
    expect(valid.status).toBe(200);
  });

  it('clears prior username failures after a successful login', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await loginAttempt(baseUrl, 'operator', 'wrong-password');
      expect(failed.status).toBe(401);
    }
    const success = await loginAttempt(baseUrl, 'operator', testPassword);
    expect(success.status).toBe(200);

    const afterSuccess = await loginAttempt(baseUrl, 'operator', 'wrong-password');
    expect(afterSuccess.status).toBe(401);
    const recovered = await loginAttempt(baseUrl, 'operator', testPassword);
    expect(recovered.status).toBe(200);
  });

  it('rate-limits repeated failed logins and recovers after the counters are cleared', async () => {
    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(await loginAttempt(baseUrl, 'operator', 'wrong-password'));
    }
    expect(responses.every((response) => response.status === 401)).toBe(true);

    const limited = await loginAttempt(baseUrl, 'operator', 'wrong-password');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });

    await flushRateLimits();
    const recovered = await loginAttempt(baseUrl, 'operator', testPassword);
    expect(recovered.status).toBe(200);
  });

  it('rate-limits by client IP across distinct usernames', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await loginAttempt(baseUrl, `missing-${attempt}`, 'wrong-password');
      expect(response.status).toBe(401);
    }
    const limited = await loginAttempt(baseUrl, 'missing-final', 'wrong-password');
    expect(limited.status).toBe(429);
    await flushRateLimits();
  });

  it('keeps authenticated reads working while login fails closed during a Valkey outage', async () => {
    const login = await loginAttempt(baseUrl, 'operator', testPassword);
    const cookie = cookieFrom(login);

    pauseService(
      requiredEnv('NEXUS_TEST_COMPOSE_PROJECT'),
      requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE'),
      [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')],
      'valkey',
      {},
    );
    try {
      const me = await request(baseUrl, '/api/v1/auth/me', {
        headers: { Cookie: cookie },
      });
      expect(me.status).toBe(200);

      const csrf = await obtainCsrf(baseUrl);
      const unavailable = await loginAttempt(baseUrl, 'operator', testPassword, { csrf });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });

      const sessionCsrf = (login.body as { csrfToken: string }).csrfToken;
      const blockedLogout = await request(baseUrl, '/api/v1/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: allowedOrigin,
          'X-CSRF-Token': sessionCsrf,
        },
      });
      expect(blockedLogout.status).toBe(503);
      expect(blockedLogout.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    } finally {
      unpauseService(
        requiredEnv('NEXUS_TEST_COMPOSE_PROJECT'),
        requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE'),
        [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')],
        'valkey',
        {},
      );
      await waitForValkey();
    }

    const deadline = Date.now() + 15000;
    let recoveredStatus = 0;
    while (Date.now() < deadline && recoveredStatus !== 200) {
      const response = await loginAttempt(baseUrl, 'operator', testPassword);
      recoveredStatus = response.status;
      if (recoveredStatus !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(recoveredStatus).toBe(200);
  });

  it('does not expose passwords or session material in errors or captured logs', async () => {
    const response = await loginAttempt(baseUrl, 'operator', 'super-secret-wrong-password');
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('super-secret-wrong-password');
    expect(JSON.stringify(response.body)).not.toContain('f04-test-password-only');
    expect(JSON.stringify(response.body)).not.toContain('nexus_session');
    const logs = `${authApp.stdout()}\n${authApp.stderr()}`;
    expect(logs).not.toContain('super-secret-wrong-password');
    expect(logs).not.toContain('f04-test-password-only');
    expect(logs).not.toContain('nexus_session');
  });
});

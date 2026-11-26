import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import pg from 'pg';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createIdentityUser } from '@nexus/db/repositories/identity';
import { hashPassword } from '@nexus/application/identity/passwords';
import { RoleSchema, type Role } from '@nexus/contracts';
import { pauseService, unpauseService } from '../../tools/lib/infra.mjs';

const { Client: PgClient } = pg;
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const testPassword = 'f06-e2e-password-only';
const webPort = requiredEnv('NEXUS_E2E_PORT');
const webOrigin = `http://127.0.0.1:${webPort}`;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:e2e F06`);
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
    application_name: 'f06-shell-test',
    connectionTimeoutMillis: 5000,
  };
}

interface SeedUser {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

let seedPool: ReturnType<typeof createNexusPool> | null = null;

async function applySchemaAndSeed(): Promise<void> {
  const migrator = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    ),
  );
  await migrator.connect();
  try {
    await applyMigrations(migrator, {
      schema: 'nexus',
      migrations: loadMigrations(path.join(repoRoot, 'packages/db/migrations')),
    });
  } finally {
    await migrator.end();
  }

  const fixture = JSON.parse(
    readFileSync(path.join(repoRoot, 'fixtures/users/roles.json'), 'utf8'),
  ) as { users: SeedUser[] };
  const users: SeedUser[] = [
    ...fixture.users,
    { username: 'no-viewer', displayName: 'E2E No Viewer', roles: ['operator'] },
  ];

  seedPool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  const db = createNexusDb(seedPool);
  for (const user of users) {
    const roles: Role[] = RoleSchema.array().parse(user.roles);
    await createIdentityUser(db, {
      username: user.username,
      displayName: user.displayName,
      roles,
      password: await hashPassword(testPassword),
    });
  }
  await seedPool.query(
    `DELETE FROM nexus.user_roles
     WHERE user_id = (SELECT id FROM nexus.users WHERE username = $1)`,
    ['no-viewer'],
  );
}

test.beforeAll(async () => {
  await applySchemaAndSeed();
});

test.afterAll(async () => {
  await seedPool?.end();
});

function trackExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return;
    }
    try {
      if (new URL(url).origin !== webOrigin) {
        external.push(url);
      }
    } catch {
      external.push(url);
    }
  });
  return external;
}

async function signIn(page: Page, username = 'operator'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(testPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.getByTestId('account-name')).toBeVisible();
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
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Valkey did not recover after the E2E cache-outage check');
}

function walkFiles(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, result);
      continue;
    }
    if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

test('anonymous deep link redirects to login without exposing account or sandbox data', async ({
  page,
}) => {
  const external = trackExternalRequests(page);

  await page.goto('/');

  await expect(page).toHaveURL(`${webOrigin}/login`);
  await expect(page.getByTestId('login-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByTestId('account-name')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-name')).toHaveCount(0);
  await expect(page.getByText('Local Operator')).toHaveCount(0);
  await expect(page.getByText('Replay', { exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test('a seeded account signs in, survives refresh, and signs out', async ({ page }) => {
  const external = trackExternalRequests(page);

  await signIn(page);
  await expect(page.getByTestId('role-list')).toContainText('operator');
  await expect(page.getByTestId('sandbox-name')).toContainText('Initial sandbox');
  await expect(page.getByTestId('sandbox-business-date')).toBeVisible();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByText('Replay', { exact: true })).toBeVisible();

  const browserStorage = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie,
  }));
  expect(browserStorage.local).toEqual([]);
  expect(browserStorage.session).toEqual([]);
  expect(browserStorage.cookie).not.toContain('nexus_session');

  await page.reload();
  await expect(page.getByTestId('account-name')).toBeVisible();
  await expect(page.getByTestId('sandbox-name')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${webOrigin}/login`);

  await page.goto('/');
  await expect(page).toHaveURL(`${webOrigin}/login`);
  expect(external).toEqual([]);
});

test('a stale login form in a second tab can authenticate after another tab signs in', async ({
  page,
  context,
}) => {
  await page.goto('/login');
  const staleTab = await context.newPage();
  await staleTab.goto('/login');
  await expect(staleTab.getByTestId('login-form')).toBeVisible();

  await signIn(page);
  await staleTab.getByLabel('Username').fill('operator');
  await staleTab.getByLabel('Password').fill(testPassword);
  await staleTab.getByRole('button', { name: 'Sign in' }).click();

  try {
    await expect(staleTab).toHaveURL(`${webOrigin}/`);
    await expect(staleTab.getByTestId('account-name')).toBeVisible();
  } finally {
    await staleTab.close();
  }
});

test('a mutation without a CSRF token is rejected and leaves the session intact', async ({
  page,
}) => {
  await signIn(page);

  const result = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/logout', { method: 'POST' });
    const body: unknown = await response.json();
    return { status: response.status, body };
  });

  expect(result.status).toBe(403);
  expect(result.body).toMatchObject({ code: 'FORBIDDEN' });

  await page.reload();
  await expect(page.getByTestId('account-name')).toBeVisible();
});

test('the proxy uses a fixed API target and rejects arbitrary upstream paths', async ({
  page,
}) => {
  await signIn(page);
  const external = trackExternalRequests(page);

  const blocked = await page.evaluate(async () => {
    const response = await fetch('/api/https://example.com');
    const body: unknown = await response.json();
    return { status: response.status, body };
  });
  expect(blocked.status).toBe(400);
  expect(blocked.body).toMatchObject({ code: 'VALIDATION_FAILED' });

  const traversal = await page.evaluate(async () => {
    const response = await fetch('/api/v1/%2e%2e/auth/me');
    return { status: response.status };
  });
  expect([400, 404]).toContain(traversal.status);

  const fixed = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/me?target=https://example.com');
    const body = (await response.json()) as { user?: { username?: string } };
    return { status: response.status, username: body.user?.username };
  });
  expect(fixed.status).toBe(200);
  expect(fixed.username).toBe('operator');

  expect(external).toEqual([]);
});

test('the shell keeps a usable layout at 1440 and 360 widths', async ({ page }) => {
  await signIn(page);

  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopRail = await page.getByTestId('shell-rail').boundingBox();
  expect(desktopRail).not.toBeNull();
  expect(desktopRail?.width ?? 0).toBeGreaterThan(200);

  await page.setViewportSize({ width: 360, height: 800 });
  const mobileRail = await page.getByTestId('shell-rail').boundingBox();
  const mobileMain = await page.getByTestId('shell-main').boundingBox();
  expect(mobileRail).not.toBeNull();
  expect(mobileMain).not.toBeNull();
  expect(mobileRail?.width ?? 0).toBeLessThanOrEqual(360);
  expect(mobileRail?.width ?? 0).toBeGreaterThan(300);
  expect(mobileMain?.y ?? 0).toBeGreaterThanOrEqual(
    (mobileRail?.y ?? 0) + (mobileRail?.height ?? 0) - 1,
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('account-name')).toBeVisible();
  await expect(page.getByTestId('sandbox-name')).toBeVisible();
});

test('keyboard-only sign-in and primary navigation keep a visible focus order', async ({
  page,
}) => {
  await page.goto('/login');

  const username = page.getByLabel('Username');
  const password = page.getByLabel('Password');
  const submit = page.getByRole('button', { name: 'Sign in' });

  await expect(username).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();

  await username.focus();
  await page.keyboard.type('operator');
  await page.keyboard.press('Tab');
  await page.keyboard.type(testPassword);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.getByTestId('account-name')).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Overview' })).toBeFocused();
});

test('an authenticated account without the viewer role gets an explicit 403 state', async ({
  page,
}) => {
  await signIn(page, 'no-viewer');

  await expect(page.getByTestId('access-denied')).toBeVisible();
  await expect(page.getByTestId('access-denied')).toContainText('Viewer role required');
  await expect(page.getByTestId('sandbox-name')).toHaveCount(0);
  await expect(page.getByTestId('role-list')).toContainText('No roles assigned');
});

test('client bundles and browser storage expose no server secret', async ({ page }) => {
  const secretNames = [
    'NEXUS_TEST_SUPERUSER_PASSWORD',
    'NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD',
    'NEXUS_TEST_NEXUS_API_PASSWORD',
    'NEXUS_TEST_NEXUS_WORKER_PASSWORD',
    'NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD',
    'NEXUS_TEST_ENTERPRISE_APP_PASSWORD',
    'NEXUS_TEST_RABBIT_PASSWORD',
    'NEXUS_TEST_VALKEY_PASSWORD',
    'NEXUS_API_DB_PASSWORD',
    'VALKEY_PASSWORD',
  ];
  const secrets = secretNames
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === 'string' && value.length >= 8);
  expect(secrets.length).toBeGreaterThanOrEqual(5);

  const forbiddenMarkers = [
    'NEXUS_API_ORIGIN',
    'NEXUS_API_DB_PASSWORD',
    'NEXUS_TEST_',
    'VALKEY_PASSWORD',
  ];
  const staticDir = path.join(repoRoot, 'apps/web/.next/static');
  const textFiles = walkFiles(staticDir).filter((file) =>
    /\.(?:css|js|json|map|txt)$/.test(file),
  );
  const leakedFiles = textFiles
    .filter((file) => {
      const content = readFileSync(file, 'utf8');
      return (
        secrets.some((secret) => content.includes(secret)) ||
        forbiddenMarkers.some((marker) => content.includes(marker))
      );
    })
    .map((file) => path.relative(repoRoot, file));
  expect(leakedFiles).toEqual([]);

  await signIn(page);
  const html = await page.content();
  expect(secrets.filter((secret) => html.includes(secret))).toEqual([]);
  const storage = await page.evaluate(() => ({
    local: Object.entries(window.localStorage),
    session: Object.entries(window.sessionStorage),
    cookie: document.cookie,
  }));
  expect(storage.local).toEqual([]);
  expect(storage.session).toEqual([]);
  expect(storage.cookie).not.toContain('nexus_session');
});

test('concurrent sign-out from two tabs ends without a spurious CSRF error', async ({
  page,
  context,
}) => {
  await signIn(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByTestId('account-name')).toBeVisible();

  try {
    await Promise.all([
      page.getByRole('button', { name: 'Sign out' }).click(),
      second.getByRole('button', { name: 'Sign out' }).click(),
    ]);

    await expect(page).toHaveURL(`${webOrigin}/login`, { timeout: 20000 });
    await expect(second).toHaveURL(`${webOrigin}/login`, { timeout: 20000 });
    await expect(page.getByTestId('signout-error')).toHaveCount(0);
    await expect(second.getByTestId('signout-error')).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test('login admission outage shows an explicit read-only state and recovers', async ({
  page,
}) => {
  const project = requiredEnv('NEXUS_TEST_COMPOSE_PROJECT');
  const envFile = requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE');
  const overrides = [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')];

  pauseService(project, envFile, overrides, 'valkey', {});
  try {
    await page.goto('/login');
    await page.getByLabel('Username').fill('operator');
    await page.getByLabel('Password').fill(testPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('login-readonly')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('login-readonly')).toContainText('Read-only');
    await expect(page.getByTestId('login-error')).toHaveCount(0);
  } finally {
    unpauseService(project, envFile, overrides, 'valkey', {});
    await waitForValkey();
  }

  await page.getByLabel('Password').fill(testPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${webOrigin}/`);
  await expect(page.getByTestId('account-name')).toBeVisible();
});

test('a cache outage shows an explicit read-only state and recovers', async ({ page }) => {
  await signIn(page);

  pauseService(
    requiredEnv('NEXUS_TEST_COMPOSE_PROJECT'),
    requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE'),
    [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')],
    'valkey',
    {},
  );
  try {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('readonly-state')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('readonly-state')).toContainText('Read-only');

    await page.reload();
    await expect(page.getByTestId('account-name')).toBeVisible();
    await expect(page.getByTestId('sandbox-name')).toBeVisible();
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

  await expect(async () => {
    if (page.url() === `${webOrigin}/login`) {
      return;
    }
    const button = page.getByRole('button', { name: 'Sign out' });
    if (await button.isEnabled()) {
      await button.click();
    }
    expect(page.url()).toBe(`${webOrigin}/login`);
  }).toPass({ timeout: 30000 });
});

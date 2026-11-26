import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp from 'amqplib';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { Client, Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createNexusPool } from '@nexus/db/connection';
import { createEnterprisePool } from '@nexus/enterprise-db/connection';
import {
  MigrationError,
  applyMigrations,
  loadMigrations,
} from '@nexus/db/migrate';
import type { MigrationResult } from '@nexus/db/migrate';
import {
  applyMigrations as applyEnterpriseMigrations,
  loadMigrations as loadEnterpriseMigrations,
} from '@nexus/enterprise-db/migrate';
import { restartService, composePort } from '../../tools/lib/infra.mjs';

const { Client: PgClient } = pg;
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F02`);
  }
  return value;
}

function databasePort(): number {
  const port = Number(requiredEnv('NEXUS_TEST_PG_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('NEXUS_TEST_PG_PORT is not a valid port');
  }
  return port;
}

function databaseClient(user: string, password: string): Client {
  return new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: databasePort(),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f02-infrastructure-test',
    connectionTimeoutMillis: 5000,
  });
}

function nexusMigratorClient(): Client {
  return databaseClient(
    requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
    requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
  );
}

function enterpriseMigratorClient(): Client {
  return databaseClient(
    requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_USER'),
    requiredEnv('NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD'),
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

async function runNexusMigrations(): Promise<MigrationResult> {
  return withClient(nexusMigratorClient(), (client) =>
    applyMigrations(client, {
      schema: 'nexus',
      migrations: loadMigrations(path.join(repoRoot, 'packages/db/migrations')),
    }),
  );
}

async function runEnterpriseMigrations(): Promise<MigrationResult> {
  return withClient(enterpriseMigratorClient(), (client) =>
    applyEnterpriseMigrations(client, {
      schema: 'enterprise',
      migrations: loadEnterpriseMigrations(
        path.join(repoRoot, 'packages/enterprise-db/migrations'),
      ),
    }),
  );
}

async function expectPgError(
  client: Client,
  sql: string,
  code: string,
  parameters: unknown[] = [],
): Promise<void> {
  await expect(client.query(sql, parameters)).rejects.toMatchObject({ code });
}

async function expectPoolIdentity(
  pool: Pool,
  expectedUser: string,
  expectedSchema: string,
  expectedApplicationName: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{
      current_user: string;
      search_path: string;
      application_name: string;
    }>(
      "SELECT current_user AS current_user, current_setting('search_path') AS search_path, current_setting('application_name') AS application_name",
    );
    expect(identity.rows[0]?.current_user).toBe(expectedUser);
    expect(
      identity.rows[0]?.search_path.split(',').map((part) => part.trim()),
    ).toEqual([expectedSchema, 'pg_catalog']);
    expect(identity.rows[0]?.application_name).toBe(expectedApplicationName);
  } finally {
    client.release();
  }
}

let initialNexus: MigrationResult;
let initialEnterprise: MigrationResult;

beforeAll(async () => {
  expect(requiredEnv('NEXUS_TEST_PG_HOST')).toBe('127.0.0.1');
  expect(requiredEnv('NEXUS_TEST_RABBIT_HOST')).toBe('127.0.0.1');
  expect(requiredEnv('NEXUS_TEST_VALKEY_HOST')).toBe('127.0.0.1');
  expect(requiredEnv('NEXUS_TEST_COMPOSE_PROJECT')).toMatch(/^nexus-test-/);
  initialNexus = await runNexusMigrations();
  initialEnterprise = await runEnterpriseMigrations();
});

describe('F02 infrastructure', () => {
  it('reports the pinned PostgreSQL, pgvector, schemas and roles', async () => {
    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
        requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
      ),
      async (client) => {
        const version = await client.query<{ server_version: string }>(
          "SELECT current_setting('server_version') AS server_version",
        );
        expect(version.rows[0]?.server_version.split(' ')[0]).toBe('18.7');

        const extension = await client.query<{ extversion: string; nspname: string }>(`
          SELECT e.extversion, n.nspname
          FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = 'vector'
        `);
        expect(extension.rows[0]).toEqual({ extversion: '0.8.7', nspname: 'nexus' });

        const roles = await client.query<{ rolname: string }>(`
          SELECT rolname
          FROM pg_roles
          WHERE rolname IN (
            'nexus_migrator','nexus_api','nexus_worker','enterprise_migrator','enterprise_app'
          )
          ORDER BY rolname
        `);
        expect(roles.rows.map((row) => row.rolname)).toEqual([
          'enterprise_app',
          'enterprise_migrator',
          'nexus_api',
          'nexus_migrator',
          'nexus_worker',
        ]);

        const schemas = await client.query<{ nspname: string; owner: string }>(`
          SELECT nspname, pg_get_userbyid(nspowner) AS owner
          FROM pg_namespace
          WHERE nspname IN ('nexus','enterprise')
          ORDER BY nspname
        `);
        expect(schemas.rows).toEqual([
          { nspname: 'enterprise', owner: 'enterprise_migrator' },
          { nspname: 'nexus', owner: 'nexus_migrator' },
        ]);
      },
    );
  });

  it('applies both migration sets and a repeated run is a no-op', async () => {
    expect(initialNexus.applied).toContain('0001');
    expect(initialEnterprise.applied).toContain('0001');

    const repeatedNexus = await runNexusMigrations();
    const repeatedEnterprise = await runEnterpriseMigrations();
    expect(repeatedNexus.applied).toEqual([]);
    expect(repeatedNexus.skipped).toContain('0001');
    expect(repeatedEnterprise.applied).toEqual([]);
    expect(repeatedEnterprise.skipped).toContain('0001');

    await withClient(nexusMigratorClient(), async (client) => {
      const ledger = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM nexus.schema_migrations',
      );
      expect(ledger.rows[0]?.count).toBe(initialNexus.applied.length);
      const metadata = await client.query<{ metadata_value: string }>(
        "SELECT metadata_value FROM nexus.infrastructure_metadata WHERE metadata_key = 'bootstrap'",
      );
      expect(metadata.rows[0]?.metadata_value).toBe('F02');
    });

    await withClient(enterpriseMigratorClient(), async (client) => {
      const ledger = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM enterprise.schema_migrations',
      );
      expect(ledger.rows[0]?.count).toBe(1);
      const metadata = await client.query<{ metadata_value: string }>(
        "SELECT metadata_value FROM enterprise.infrastructure_metadata WHERE metadata_key = 'bootstrap'",
      );
      expect(metadata.rows[0]?.metadata_value).toBe('F02');
    });
  });

  it('stops on an invalid migration without recording it or leaking its partial effects', async () => {
    const schema = `f02_migration_${randomBytes(5).toString('hex')}`;
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-f02-migrations-'));
    const superuser = databaseClient(
      requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
      requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    );

    try {
      await withClient(superuser, (client) =>
        client.query(`CREATE SCHEMA ${schema} AUTHORIZATION nexus_migrator`),
      );
      writeFileSync(
        path.join(tempDir, '0001_ok.sql'),
        `CREATE TABLE ${schema}.probe (id integer PRIMARY KEY);\n`,
      );
      writeFileSync(
        path.join(tempDir, '0002_invalid.sql'),
        `CREATE TABLE ${schema}.should_rollback (id integer);\nSELECT definitely_missing_f02_function();\n`,
      );

      const migrations = loadMigrations(tempDir);
      await expect(
        withClient(nexusMigratorClient(), (client) =>
          applyMigrations(client, { schema, migrations }),
        ),
      ).rejects.toBeInstanceOf(MigrationError);

      await withClient(nexusMigratorClient(), async (client) => {
        const ledger = await client.query<{ version: string }>(
          `SELECT version FROM ${schema}.schema_migrations ORDER BY version`,
        );
        expect(ledger.rows.map((row) => row.version)).toEqual(['0001']);
        const rolledBack = await client.query<{ present: string | null }>(
          `SELECT to_regclass('${schema}.should_rollback')::text AS present`,
        );
        expect(rolledBack.rows[0]?.present).toBeNull();
      });
    } finally {
      try {
        await withClient(superuser, (client) =>
          client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
        );
      } catch {
        // Cleanup failure is reported by the test run, not hidden by assertions.
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prevents runtime roles from creating tables, crossing schemas, or assuming migration roles', async () => {
    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
        requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
      ),
      async (client) => {
        await expectPgError(client, 'CREATE TABLE nexus.f02_forbidden (id integer)', '42501');
        await expectPgError(client, 'SELECT 1 FROM enterprise.infrastructure_metadata', '42501');
        await expectPgError(client, 'SET ROLE nexus_migrator', '42501');
        await expectPgError(client, 'CREATE SCHEMA f02_forbidden_schema', '42501');
      },
    );

    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
        requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
      ),
      async (client) => {
        await expectPgError(client, 'CREATE TABLE nexus.f02_worker_forbidden (id integer)', '42501');
      },
    );

    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
        requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
      ),
      async (client) => {
        await expectPgError(client, 'CREATE TABLE enterprise.f02_forbidden (id integer)', '42501');
        await expectPgError(client, 'SELECT 1 FROM nexus.infrastructure_metadata', '42501');
        await expectPgError(client, 'SET ROLE enterprise_migrator', '42501');
      },
    );

    await withClient(
      databaseClient(
        requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
        requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
      ),
      async (client) => {
        const memberships = await client.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM pg_auth_members m
          JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted ON granted.oid = m.roleid
          WHERE member.rolname IN ('nexus_api','nexus_worker','enterprise_app')
            AND granted.rolname IN ('nexus_migrator','enterprise_migrator')
        `);
        expect(memberships.rows[0]?.count).toBe(0);
      },
    );
  });

  it('rejects a non-conforming migration filename instead of silently skipping it', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-f02-bad-name-'));
    try {
      writeFileSync(path.join(directory, '0001_ok.sql'), 'SELECT 1;\n');
      writeFileSync(path.join(directory, '0002_Add_User_Index.sql'), 'SELECT 2;\n');
      expect(() => loadMigrations(directory)).toThrow(MigrationError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the nexus and enterprise migration-runner copies identical', () => {
    const nexusRunner = readFileSync(path.join(repoRoot, 'packages/db/src/migrate.ts'), 'utf8');
    const enterpriseRunner = readFileSync(
      path.join(repoRoot, 'packages/enterprise-db/src/migrate.ts'),
      'utf8',
    );
    expect(enterpriseRunner).toBe(nexusRunner);
  });

  it('opens role-specific runtime pools with explicit search paths', async () => {
    const runtimeEnv = {
      NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
      NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
      NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
      NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
      NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
      NEXUS_WORKER_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
      NEXUS_WORKER_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
    };
    const enterpriseEnv = {
      ENTERPRISE_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
      ENTERPRISE_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
      ENTERPRISE_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
      ENTERPRISE_APP_DB_USER: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_USER'),
      ENTERPRISE_APP_DB_PASSWORD: requiredEnv('NEXUS_TEST_ENTERPRISE_APP_PASSWORD'),
    };

    const apiPool = createNexusPool('api', runtimeEnv);
    const workerPool = createNexusPool('worker', runtimeEnv);
    const enterprisePool = createEnterprisePool(enterpriseEnv);
    try {
      await expectPoolIdentity(apiPool, 'nexus_api', 'nexus', 'nexus');
      await expectPoolIdentity(workerPool, 'nexus_worker', 'nexus', 'nexus');
      await expectPoolIdentity(enterprisePool, 'enterprise_app', 'enterprise', 'nexus-enterprise');

      const apiClient = await apiPool.connect();
      try {
        await expect(
          apiClient.query('CREATE TABLE nexus.f02_pool_forbidden (id integer)'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        apiClient.release();
      }

      const enterpriseClient = await enterprisePool.connect();
      try {
        await expect(
          enterpriseClient.query('SELECT 1 FROM nexus.infrastructure_metadata'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        enterpriseClient.release();
      }
    } finally {
      await apiPool.end();
      await workerPool.end();
      await enterprisePool.end();
    }
  });

  it('persists a RabbitMQ message across a broker restart', async () => {
    const host = requiredEnv('NEXUS_TEST_RABBIT_HOST');
    const port = requiredEnv('NEXUS_TEST_RABBIT_PORT');
    const user = encodeURIComponent(requiredEnv('NEXUS_TEST_RABBIT_USER'));
    const password = encodeURIComponent(requiredEnv('NEXUS_TEST_RABBIT_PASSWORD'));
    const vhost = encodeURIComponent(requiredEnv('NEXUS_TEST_RABBIT_VHOST'));
    const url = `amqp://${user}:${password}@${host}:${port}/${vhost}`;
    const queue = `f02-persist-${randomBytes(6).toString('hex')}`;
    const payload = `persistent-${Date.now()}`;

    const first = await amqp.connect(url);
    try {
      const channel = await first.createConfirmChannel();
      await channel.assertQueue(queue, { durable: true });
      channel.sendToQueue(queue, Buffer.from(payload), { persistent: true });
      await channel.waitForConfirms();
      await channel.close();
    } finally {
      await first.close();
    }

    restartService(
      requiredEnv('NEXUS_TEST_COMPOSE_PROJECT'),
      requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE'),
      [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')],
      'rabbitmq',
      {},
    );

    const restartedPort = composePort(
      requiredEnv('NEXUS_TEST_COMPOSE_PROJECT'),
      requiredEnv('NEXUS_TEST_COMPOSE_ENV_FILE'),
      [requiredEnv('NEXUS_TEST_COMPOSE_OVERRIDE')],
      'rabbitmq',
      5672,
      {},
    );
    const restartedUrl = `amqp://${user}:${password}@${host}:${restartedPort}/${vhost}`;

    let second: Awaited<ReturnType<typeof amqp.connect>> | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        second = await amqp.connect(restartedUrl);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    expect(second).not.toBeNull();

    try {
      const channel = await second!.createChannel();
      await channel.assertQueue(queue, { durable: true });
      let message = await channel.get(queue, { noAck: false });
      for (let attempt = 0; attempt < 20 && !message; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        message = await channel.get(queue, { noAck: false });
      }
      expect(message).toBeTruthy();
      if (!message) {
        throw new Error('Persistent RabbitMQ message was not recovered after restart');
      }
      expect(message.content.toString()).toBe(payload);
      channel.ack(message);
      await channel.deleteQueue(queue);
      await channel.close();
    } finally {
      await second!.close();
    }
  });

  it('loses no database data when the cache is flushed', async () => {
    const key = `f02_cache_${randomBytes(6).toString('hex')}`;
    const value = `db-value-${Date.now()}`;

    await withClient(nexusMigratorClient(), async (client) => {
      await client.query(
        'INSERT INTO nexus.infrastructure_metadata (metadata_key, metadata_value) VALUES ($1, $2)',
        [key, value],
      );

      const redis = new Redis({
        host: requiredEnv('NEXUS_TEST_VALKEY_HOST'),
        port: Number(requiredEnv('NEXUS_TEST_VALKEY_PORT')),
        password: requiredEnv('NEXUS_TEST_VALKEY_PASSWORD'),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      await redis.connect();
      try {
        await redis.set('f02:cache-probe', value);
        expect(await redis.get('f02:cache-probe')).toBe(value);
        await redis.flushall();
        expect(await redis.get('f02:cache-probe')).toBeNull();
      } finally {
        await redis.quit();
      }

      const stored = await client.query<{ metadata_value: string }>(
        'SELECT metadata_value FROM nexus.infrastructure_metadata WHERE metadata_key = $1',
        [key],
      );
      expect(stored.rows[0]?.metadata_value).toBe(value);
      await client.query('DELETE FROM nexus.infrastructure_metadata WHERE metadata_key = $1', [key]);
    });
  });
});

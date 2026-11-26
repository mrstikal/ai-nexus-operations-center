import pg from 'pg';
import type { Pool as PgPool, PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as identitySchema from './schema/identity.js';

const { Pool } = pg;

export type NexusRuntimeRole = 'api' | 'worker';

export interface DatabaseTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required database environment variable ${name}`);
  }
  return value;
}

function parsePort(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requireValue(env, name);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid database port in ${name}`);
  }
  return port;
}

function rolePrefix(role: NexusRuntimeRole): string {
  if (role === 'api') {
    return 'NEXUS_API';
  }
  if (role === 'worker') {
    return 'NEXUS_WORKER';
  }
  throw new Error(`Unknown nexus runtime role: ${String(role)}`);
}

function poolConfig(
  target: DatabaseTarget,
  applicationName: string,
  schema: string,
  env: NodeJS.ProcessEnv,
): PoolConfig {
  const maxRaw = env['NEXUS_DB_POOL_SIZE'] ?? '5';
  const max = Number(maxRaw);
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error('NEXUS_DB_POOL_SIZE must be an integer from 1 to 20');
  }
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: `-c search_path=${schema},pg_catalog`,
  };
}

export function nexusDatabaseFromEnv(
  role: NexusRuntimeRole = 'api',
  env: NodeJS.ProcessEnv = process.env,
): DatabaseTarget {
  const prefix = rolePrefix(role);
  const password =
    env[`${prefix}_DB_PASSWORD`] ?? env[`${prefix}_PASSWORD`];
  if (typeof password !== 'string' || password.trim() === '') {
    throw new Error(`Missing required database environment variable ${prefix}_DB_PASSWORD`);
  }
  return {
    host: env['NEXUS_DB_HOST'] ?? '127.0.0.1',
    port: parsePort(
      { ...env, NEXUS_DB_PORT: env['NEXUS_DB_PORT'] ?? '5432' },
      'NEXUS_DB_PORT',
    ),
    database: env['NEXUS_DB_NAME'] ?? 'nexus',
    user: env[`${prefix}_DB_USER`] ?? `nexus_${role}`,
    password,
  };
}

export function createNexusPool(
  role: NexusRuntimeRole = 'api',
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DatabaseTarget> = {},
): PgPool {
  return new Pool(
    poolConfig({ ...nexusDatabaseFromEnv(role, env), ...overrides }, 'nexus', 'nexus', env),
  );
}

export function describeDatabaseTarget(target: DatabaseTarget): string {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

export type NexusDb = NodePgDatabase<typeof identitySchema>;

export function createNexusDb(pool: PgPool): NexusDb {
  return drizzle(pool, { schema: identitySchema });
}

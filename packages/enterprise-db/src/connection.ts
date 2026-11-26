import pg from 'pg';
import type { Pool as PgPool, PoolConfig } from 'pg';

const { Pool } = pg;

export interface EnterpriseDatabaseTarget {
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

function poolConfig(
  target: EnterpriseDatabaseTarget,
  env: NodeJS.ProcessEnv,
): PoolConfig {
  const maxRaw = env['ENTERPRISE_DB_POOL_SIZE'] ?? '5';
  const max = Number(maxRaw);
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error('ENTERPRISE_DB_POOL_SIZE must be an integer from 1 to 20');
  }
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    max,
    application_name: 'nexus-enterprise',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: '-c search_path=enterprise,pg_catalog',
  };
}

export function enterpriseDatabaseFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseDatabaseTarget {
  const password =
    env['ENTERPRISE_APP_DB_PASSWORD'] ?? env['ENTERPRISE_APP_PASSWORD'];
  if (typeof password !== 'string' || password.trim() === '') {
    throw new Error('Missing required database environment variable ENTERPRISE_APP_DB_PASSWORD');
  }
  return {
    host: env['ENTERPRISE_DB_HOST'] ?? '127.0.0.1',
    port: parsePort(
      { ...env, ENTERPRISE_DB_PORT: env['ENTERPRISE_DB_PORT'] ?? '5432' },
      'ENTERPRISE_DB_PORT',
    ),
    database: env['ENTERPRISE_DB_NAME'] ?? 'nexus',
    user: env['ENTERPRISE_APP_DB_USER'] ?? 'enterprise_app',
    password,
  };
}

export function createEnterprisePool(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<EnterpriseDatabaseTarget> = {},
): PgPool {
  return new Pool(
    poolConfig({ ...enterpriseDatabaseFromEnv(env), ...overrides }, env),
  );
}

export function describeEnterpriseTarget(target: EnterpriseDatabaseTarget): string {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

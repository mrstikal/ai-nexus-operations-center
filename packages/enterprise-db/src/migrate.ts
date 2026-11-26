import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filePath: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface MigrationOptions {
  readonly schema: string;
  readonly directory?: string;
  readonly migrations?: readonly MigrationFile[];
  readonly log?: (message: string) => void;
}

export class MigrationError extends Error {
  readonly migration: string | undefined;

  constructor(message: string, migration?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function loadMigrations(directory: string): MigrationFile[] {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.sql'));

  const migrations = entries.map((name) => {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match) {
      throw new MigrationError(
        `Invalid migration filename ${name}; expected NNNN_lowercase_name.sql`,
      );
    }
    const version = match[1];
    const migrationName = match[2];
    if (version === undefined || migrationName === undefined) {
      throw new MigrationError(`Invalid migration filename ${name}`);
    }
    const filePath = path.join(directory, name);
    const sql = readFileSync(filePath, 'utf8');
    if (sql.trim() === '') {
      throw new MigrationError(`Migration ${name} is empty`, name);
    }
    return {
      version,
      name: migrationName,
      filePath,
      sql,
      checksum: checksum(sql),
    };
  });

  migrations.sort((left, right) => {
    const numeric = Number(left.version) - Number(right.version);
    return numeric !== 0 ? numeric : left.version.localeCompare(right.version);
  });

  const seenVersions = new Set<string>();
  for (const migration of migrations) {
    const numericVersion = String(Number(migration.version));
    if (seenVersions.has(numericVersion)) {
      throw new MigrationError(`Duplicate migration version ${migration.version}`, migration.version);
    }
    seenVersions.add(numericVersion);
  }

  return migrations;
}

function assertSchema(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new MigrationError(`Invalid migration schema name: ${schema}`);
  }
}

interface AppliedRow {
  readonly version: string;
  readonly checksum: string;
}

export async function applyMigrations(
  client: MigrationClient,
  options: MigrationOptions,
): Promise<MigrationResult> {
  assertSchema(options.schema);
  if (options.migrations === undefined && options.directory === undefined) {
    throw new MigrationError('Provide migrations or a migrations directory');
  }
  const migrations = options.migrations ?? loadMigrations(options.directory ?? '');
  const schema = `"${options.schema}"`;
  const lockKey = `nexus:${options.schema}:migrations`;

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    const stored = (await client.query(
      `SELECT version, checksum FROM ${schema}.schema_migrations ORDER BY version`,
    )) as { rows: AppliedRow[] };
    const applied = new Map(stored.rows.map((row) => [row.version, row.checksum]));

    const appliedNow: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new MigrationError(
            `Migration ${options.schema}:${migration.version} was changed after it was applied; add a new migration instead`,
            `${options.schema}:${migration.version}`,
          );
        }
        skipped.push(migration.version);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${schema}.schema_migrations (version, checksum) VALUES ($1, $2)`,
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original migration error is the actionable failure.
        }
        throw new MigrationError(
          `Migration ${options.schema}:${migration.version} failed; setup stopped before later migrations`,
          `${options.schema}:${migration.version}`,
          error,
        );
      }

      appliedNow.push(migration.version);
      options.log?.(`Applied ${options.schema}:${migration.version}`);
    }

    return { applied: appliedNow, skipped };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    } catch {
      // A failed unlock must not hide the migration result.
    }
  }
}

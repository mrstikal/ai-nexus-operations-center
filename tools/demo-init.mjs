import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  REPO_ROOT,
  restoreDefaultInfrastructure,
  startMigrationInfrastructure,
} from './lib/infra.mjs';

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

async function loadMigrations() {
  const nexusPath = path.join(REPO_ROOT, 'packages/db/dist/migrate.js');
  const enterprisePath = path.join(REPO_ROOT, 'packages/enterprise-db/dist/migrate.js');
  try {
    const nexus = await import(nexusPath);
    const enterprise = await import(enterprisePath);
    return { nexus, enterprise };
  } catch (error) {
    throw new Error(
      `Compiled migration modules are missing. Run pnpm build first.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function migrate({ port, user, password, schema, directory, migrationModule }) {
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    database: 'nexus',
    user,
    password,
    application_name: `nexus-migrate-${schema}`,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const migrations = migrationModule.loadMigrations(directory);
    const result = await migrationModule.applyMigrations(client, {
      schema,
      migrations,
      log: (message) => console.log(message),
    });
    return result;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let migrateOnly = false;
  for (const argument of args) {
    if (argument === '--migrate-only') {
      migrateOnly = true;
      continue;
    }
    throw new Error(`Unknown argument ${argument}. Usage: pnpm demo:init [--migrate-only]`);
  }

  let infrastructure = null;
  try {
    infrastructure = startMigrationInfrastructure();
    const port = infrastructure.port;

    const modules = await loadMigrations();
    const nexusResult = await migrate({
      port,
      user: 'nexus_migrator',
      password: infrastructure.env.NEXUS_MIGRATOR_PASSWORD,
      schema: 'nexus',
      directory: path.join(REPO_ROOT, 'packages/db/migrations'),
      migrationModule: modules.nexus,
    });
    const enterpriseResult = await migrate({
      port,
      user: 'enterprise_migrator',
      password: infrastructure.env.ENTERPRISE_MIGRATOR_PASSWORD,
      schema: 'enterprise',
      directory: path.join(REPO_ROOT, 'packages/enterprise-db/migrations'),
      migrationModule: modules.enterprise,
    });

    console.log(
      `Migrations complete: nexus applied=${nexusResult.applied.length} skipped=${nexusResult.skipped.length}; ` +
        `enterprise applied=${enterpriseResult.applied.length} skipped=${enterpriseResult.skipped.length}.`,
    );
    if (!migrateOnly) {
      console.log('Initial demo initialization is complete. No seed registrations exist in F02.');
      console.log('Replay asset validation starts with the replay fixture phases; it is NOT RUN in F02.');
    }
  } finally {
    if (infrastructure) {
      try {
        restoreDefaultInfrastructure();
        console.log(
          'Default infrastructure restored without host ports. Rerun pnpm infra:up --dev-ports if host access is needed.',
        );
      } catch (error) {
        console.error(
          `Failed to restore default infrastructure: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
  }
}

if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

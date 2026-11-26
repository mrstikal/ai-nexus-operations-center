import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  REPO_ROOT,
  parseEnvFile,
  restoreDefaultInfrastructure,
  startMigrationInfrastructure,
  writeEnvFile,
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

async function seedLocalIdentity({ port, env }) {
  let dbModule;
  let identityModule;
  let passwordModule;
  try {
    dbModule = await import('@nexus/db/connection');
    identityModule = await import('@nexus/db/repositories/identity');
    passwordModule = await import('@nexus/application/identity/passwords');
  } catch (error) {
    throw new Error(
      `Compiled identity seed modules are missing. Run pnpm build first.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const fixture = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'fixtures/users/roles.json'), 'utf8'),
  );
  const localEnvPath = path.join(REPO_ROOT, '.env.local');
  const localValues = fs.existsSync(localEnvPath) ? parseEnvFile(localEnvPath) : {};
  const passwordFor = (username) =>
    `NEXUS_LOCAL_PASSWORD_${username.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const pool = dbModule.createNexusPool('api', {
    NEXUS_DB_HOST: '127.0.0.1',
    NEXUS_DB_PORT: String(port),
    NEXUS_DB_NAME: 'nexus',
    NEXUS_API_DB_USER: 'nexus_api',
    NEXUS_API_DB_PASSWORD: env.NEXUS_API_PASSWORD,
  });
  const db = dbModule.createNexusDb(pool);
  const created = [];
  try {
    for (const user of fixture.users) {
      const key = passwordFor(user.username);
      const password = localValues[key] || randomBytes(24).toString('base64url');
      const passwordRecord = await passwordModule.hashPassword(password);
      if (
        await identityModule.createIdentityUser(db, {
          username: user.username,
          displayName: user.displayName,
          roles: user.roles,
          password: passwordRecord,
        })
      ) {
        localValues[key] = password;
        created.push({ username: user.username, password });
      }
    }
  } finally {
    await pool.end();
  }

  if (created.length > 0) {
    writeEnvFile(localEnvPath, localValues);
    console.log(
      `Seeded local identity accounts: ${created.map((entry) => entry.username).join(', ')}.`,
    );
    console.log('Local passwords were stored in ignored .env.local (not displayed in captured logs).');
    if (process.stdout.isTTY) {
      for (const entry of created) {
        console.log(`${entry.username}: ${entry.password}`);
      }
    }
  } else {
    console.log('Local identity accounts already exist; passwords were not changed.');
  }
}

async function seedEnterpriseSupply({ port, env }) {
  let seedModule;
  try {
    seedModule = await import('@nexus/enterprise-db/seed');
  } catch (error) {
    throw new Error(
      `Compiled enterprise seed module is missing. Run pnpm build first.\n${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    database: 'nexus',
    user: 'enterprise_migrator',
    password: env.ENTERPRISE_MIGRATOR_PASSWORD,
    application_name: 'nexus-demo-seed-enterprise',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await seedModule.seedEnterpriseSupply(client, {
      fixturesDirectory: path.join(REPO_ROOT, 'fixtures/company'),
    });
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
      await seedLocalIdentity({ port, env: infrastructure.env });
      const enterpriseSeed = await seedEnterpriseSupply({
        port,
        env: infrastructure.env,
      });
      console.log(
        `Enterprise supply seed complete for sandbox ${enterpriseSeed.sandboxId}: ` +
          `${enterpriseSeed.inserted.products ?? 0} new products, ` +
          `${enterpriseSeed.inserted.suppliers ?? 0} new suppliers, ` +
          `${enterpriseSeed.inserted.customers ?? 0} new customers, ` +
          `${enterpriseSeed.inserted.purchaseOrders ?? 0} new purchase orders, ` +
          `${enterpriseSeed.inserted.salesOrders ?? 0} new sales orders.`,
      );
      console.log('Initial demo initialization is complete. Local identity accounts, the F07 enterprise supply seed and the F08 command schema are ready.');
      console.log('Scenario records and replay asset validation start with later fixture phases; they are NOT RUN in F08.');
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

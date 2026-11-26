import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const COMPOSE_FILE = path.join(REPO_ROOT, 'infra/compose.yaml');
export const DEV_OVERRIDE = path.join(REPO_ROOT, 'infra/compose.dev.yaml');
export const TEST_OVERRIDE = path.join(REPO_ROOT, 'infra/compose.test.yaml');
export const MIGRATE_OVERRIDE = path.join(REPO_ROOT, 'infra/compose.migrate.yaml');
export const LOCAL_ENV_FILE = path.join(REPO_ROOT, '.env');

const REQUIRED_ENV_KEYS = [
  'POSTGRES_SUPERUSER_PASSWORD',
  'NEXUS_MIGRATOR_PASSWORD',
  'NEXUS_API_PASSWORD',
  'NEXUS_WORKER_PASSWORD',
  'ENTERPRISE_MIGRATOR_PASSWORD',
  'ENTERPRISE_APP_PASSWORD',
  'RABBITMQ_DEFAULT_USER',
  'RABBITMQ_DEFAULT_PASS',
  'VALKEY_PASSWORD',
  'VALKEY_HOST',
  'VALKEY_PORT',
  'NEXUS_COOKIE_SECURE',
  'NEXUS_DB_HOST',
  'NEXUS_DB_PORT',
  'NEXUS_DB_NAME',
  'NEXUS_API_DB_USER',
  'NEXUS_API_DB_PASSWORD',
  'NEXUS_WORKER_DB_USER',
  'NEXUS_WORKER_DB_PASSWORD',
  'ENTERPRISE_DB_HOST',
  'ENTERPRISE_DB_PORT',
  'ENTERPRISE_DB_NAME',
  'ENTERPRISE_APP_DB_USER',
  'ENTERPRISE_APP_DB_PASSWORD',
  'ENTERPRISE_SIM_READ_TOKEN',
  'ENTERPRISE_SIM_COMMAND_TOKEN',
];

const DEV_PORT_KEYS = [
  'NEXUS_PG_DEV_PORT',
  'NEXUS_RABBIT_DEV_PORT',
  'NEXUS_RABBIT_MANAGEMENT_DEV_PORT',
  'NEXUS_VALKEY_DEV_PORT',
];

function secret() {
  return randomBytes(32).toString('base64url');
}

export function generateLocalEnv() {
  const nexusApiPassword = secret();
  const nexusWorkerPassword = secret();
  const enterpriseAppPassword = secret();
  return {
    POSTGRES_SUPERUSER_PASSWORD: secret(),
    NEXUS_MIGRATOR_PASSWORD: secret(),
    NEXUS_API_PASSWORD: nexusApiPassword,
    NEXUS_WORKER_PASSWORD: nexusWorkerPassword,
    ENTERPRISE_MIGRATOR_PASSWORD: secret(),
    ENTERPRISE_APP_PASSWORD: enterpriseAppPassword,
    RABBITMQ_DEFAULT_USER: 'nexus_app',
    RABBITMQ_DEFAULT_PASS: secret(),
    VALKEY_PASSWORD: secret(),
    VALKEY_HOST: '127.0.0.1',
    VALKEY_PORT: '56379',
    NEXUS_COOKIE_SECURE: 'false',
    NEXUS_DB_HOST: '127.0.0.1',
    NEXUS_DB_PORT: '55432',
    NEXUS_DB_NAME: 'nexus',
    NEXUS_API_DB_USER: 'nexus_api',
    NEXUS_API_DB_PASSWORD: nexusApiPassword,
    NEXUS_WORKER_DB_USER: 'nexus_worker',
    NEXUS_WORKER_DB_PASSWORD: nexusWorkerPassword,
    ENTERPRISE_DB_HOST: '127.0.0.1',
    ENTERPRISE_DB_PORT: '55432',
    ENTERPRISE_DB_NAME: 'nexus',
    ENTERPRISE_APP_DB_USER: 'enterprise_app',
    ENTERPRISE_APP_DB_PASSWORD: enterpriseAppPassword,
    ENTERPRISE_SIM_READ_TOKEN: secret(),
    ENTERPRISE_SIM_COMMAND_TOKEN: secret(),
    NEXUS_OWNER: 'local',
    NEXUS_PG_DEV_PORT: '55432',
    NEXUS_RABBIT_DEV_PORT: '55672',
    NEXUS_RABBIT_MANAGEMENT_DEV_PORT: '55673',
    NEXUS_VALKEY_DEV_PORT: '56379',
  };
}

export function parseEnvFile(filePath) {
  const values = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== '') {
      values[key] = value;
    }
  }
  return values;
}

export function validateEnv(values) {
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = values[key];
    return typeof value !== 'string' || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`Missing local infrastructure values: ${missing.join(', ')}`);
  }
  const placeholders = REQUIRED_ENV_KEYS.filter((key) =>
    (values[key] ?? '').includes('replace-with'),
  );
  if (placeholders.length > 0) {
    throw new Error(
      `Local infrastructure values still contain placeholders: ${placeholders.join(', ')}. ` +
        'Generate .env with pnpm infra:up instead of copying .env.example secrets.',
    );
  }
}

export function writeEnvFile(filePath, values) {
  const order = [...REQUIRED_ENV_KEYS, 'NEXUS_OWNER', ...DEV_PORT_KEYS];
  const keys = [
    ...order.filter((key) => values[key] !== undefined),
    ...Object.keys(values).filter((key) => !order.includes(key)),
  ];
  const text = keys.map((key) => `${key}=${values[key]}`).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${text}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function defaultVolumesExist() {
  const result = spawnSync('docker', ['volume', 'ls', '-q'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  const names = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return ['nexus_postgres_data', 'nexus_rabbitmq_data', 'nexus_valkey_data'].some((name) =>
    names.includes(name),
  );
}

function backfillDerivedEnv(values) {
  const derived = {
    NEXUS_DB_HOST: values.NEXUS_DB_HOST || '127.0.0.1',
    NEXUS_DB_PORT: values.NEXUS_DB_PORT || values.NEXUS_PG_DEV_PORT || '55432',
    NEXUS_DB_NAME: values.NEXUS_DB_NAME || 'nexus',
    NEXUS_API_DB_USER: values.NEXUS_API_DB_USER || 'nexus_api',
    NEXUS_API_DB_PASSWORD: values.NEXUS_API_DB_PASSWORD || values.NEXUS_API_PASSWORD,
    NEXUS_WORKER_DB_USER: values.NEXUS_WORKER_DB_USER || 'nexus_worker',
    NEXUS_WORKER_DB_PASSWORD: values.NEXUS_WORKER_DB_PASSWORD || values.NEXUS_WORKER_PASSWORD,
    ENTERPRISE_DB_HOST: values.ENTERPRISE_DB_HOST || '127.0.0.1',
    ENTERPRISE_DB_PORT: values.ENTERPRISE_DB_PORT || values.NEXUS_PG_DEV_PORT || '55432',
    ENTERPRISE_DB_NAME: values.ENTERPRISE_DB_NAME || 'nexus',
    ENTERPRISE_APP_DB_USER: values.ENTERPRISE_APP_DB_USER || 'enterprise_app',
    ENTERPRISE_APP_DB_PASSWORD:
      values.ENTERPRISE_APP_DB_PASSWORD || values.ENTERPRISE_APP_PASSWORD,
    ENTERPRISE_SIM_READ_TOKEN:
      values.ENTERPRISE_SIM_READ_TOKEN || secret(),
    ENTERPRISE_SIM_COMMAND_TOKEN:
      values.ENTERPRISE_SIM_COMMAND_TOKEN || secret(),
    VALKEY_HOST: values.VALKEY_HOST || '127.0.0.1',
    VALKEY_PORT: values.VALKEY_PORT || '56379',
    NEXUS_COOKIE_SECURE: values.NEXUS_COOKIE_SECURE || 'false',
  };

  const added = {};
  for (const [key, value] of Object.entries(derived)) {
    if (
      (values[key] === undefined || values[key] === '') &&
      typeof value === 'string' &&
      value !== ''
    ) {
      values[key] = value;
      added[key] = value;
    }
  }
  return added;
}

function applyEnvAdditions(envFile, added) {
  const text = fs.readFileSync(envFile, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (text.endsWith(eol)) {
    lines.pop();
  }
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      return line;
    }
    const key = match[2];
    if (!Object.hasOwn(added, key)) {
      return line;
    }
    seen.add(key);
    return `${match[1]}${key}=${added[key]}`;
  });
  for (const [key, value] of Object.entries(added)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(envFile, `${updated.join(eol)}${eol}`, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
}

export function ensureLocalEnv(envFile = LOCAL_ENV_FILE) {
  if (!fs.existsSync(envFile)) {
    if (defaultVolumesExist()) {
      throw new Error(
        'Existing nexus infrastructure volumes were found but .env is missing. ' +
          'Restore the original .env credentials; generating new passwords would not match the existing database/roles.',
      );
    }
    const values = generateLocalEnv();
    writeEnvFile(envFile, values);
    console.log(`Generated local credentials in ${path.relative(REPO_ROOT, envFile)} (not displayed).`);
    return values;
  }
  const values = parseEnvFile(envFile);
  const added = backfillDerivedEnv(values);
  if (Object.keys(added).length > 0) {
    applyEnvAdditions(envFile, added);
    console.log(
      `Augmented ${path.relative(REPO_ROOT, envFile)} with derived runtime connection keys (not displayed).`,
    );
  }
  validateEnv(values);
  return values;
}

function redact(text, env) {
  let output = text;
  for (const value of Object.values(env)) {
    if (typeof value === 'string' && value.length >= 8) {
      output = output.split(value).join('[redacted]');
    }
  }
  return output;
}

export function dockerPreflight() {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (version.error || version.status !== 0) {
    throw new Error(
      'Docker is not available. Start a Docker Engine/Compose environment before running infrastructure commands.',
    );
  }
  const compose = spawnSync('docker', ['compose', 'version'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (compose.error || compose.status !== 0) {
    throw new Error('Docker Compose is not available. Install a Compose-capable Docker environment.');
  }
}

function composeBase(options) {
  const args = [
    'compose',
    '--project-name',
    options.project,
    '--env-file',
    path.resolve(options.envFile),
    '-f',
    COMPOSE_FILE,
  ];
  for (const override of options.overrides) {
    args.push('-f', path.resolve(override));
  }
  return args;
}

function envFileRedactionValues(args) {
  const index = args.indexOf('--env-file');
  if (index === -1 || !args[index + 1]) {
    return {};
  }
  const filePath = args[index + 1];
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return parseEnvFile(filePath);
  } catch {
    return {};
  }
}

function runDocker(args, env, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if ((result.status ?? 1) !== 0 && !options.allowFailure) {
    const redactionValues = { ...envFileRedactionValues(args), ...env };
    const diagnostic = redact(`${stderr}\n${stdout}`.trim(), redactionValues);
    throw new Error(`Docker command failed: docker ${args.join(' ')}\n${diagnostic}`);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function composeRun(options, args, commandOptions = {}) {
  return runDocker([...composeBase(options), ...args], options.env, commandOptions);
}

function composeExecCapture(options, service, command) {
  return composeRun(options, ['exec', '-T', service, ...command]).stdout.trim();
}

function applyRolesAndDefinitions(options) {
  composeRun(options, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'nexus',
    '-f',
    '/docker-entrypoint-initdb.d/010-init-roles.sql',
  ]);
  composeRun(options, [
    'exec',
    '-T',
    'rabbitmq',
    'rabbitmqctl',
    'import_definitions',
    '/opt/nexus/definitions.json',
  ]);
}

function verifyInfrastructure(options) {
  const extensionVersion = composeExecCapture(options, 'postgres', [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nexus',
    '-tAc',
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  ]);
  if (extensionVersion !== '0.8.7') {
    throw new Error(`pgvector extension version mismatch: expected 0.8.7, found ${extensionVersion || 'missing'}`);
  }

  const roles = composeExecCapture(options, 'postgres', [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nexus',
    '-tAc',
    "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('nexus_migrator','nexus_api','nexus_worker','enterprise_migrator','enterprise_app')",
  ]);
  const expectedRoles = 'enterprise_app,enterprise_migrator,nexus_api,nexus_migrator,nexus_worker';
  if (roles !== expectedRoles) {
    throw new Error(`Infrastructure roles are incomplete: expected ${expectedRoles}, found ${roles || 'none'}`);
  }

  const schemaOwners = composeExecCapture(options, 'postgres', [
    'psql',
    '-U',
    'postgres',
    '-d',
    'nexus',
    '-tAc',
    "SELECT string_agg(nspname || '=' || pg_get_userbyid(nspowner), ',' ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('nexus','enterprise')",
  ]);
  if (schemaOwners !== 'enterprise=enterprise_migrator,nexus=nexus_migrator') {
    throw new Error(`Schema ownership is incorrect: ${schemaOwners || 'schemas missing'}`);
  }

  composeRun(options, [
    'exec',
    '-T',
    'valkey',
    'sh',
    '-c',
    'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" ping',
  ]);
}

function startCompose(options) {
  try {
    composeRun(options, ['--profile', 'infra', 'up', '-d', '--wait']);
  } catch (error) {
    const sections = [];
    try {
      sections.push(
        `compose ps:\n${composeRun(options, ['--profile', 'infra', 'ps', '-a'], { allowFailure: true }).stdout}`,
      );
    } catch {
      // Keep the original startup error actionable.
    }
    for (const service of ['postgres', 'rabbitmq', 'valkey']) {
      try {
        sections.push(
          `${service} logs:\n${
            composeRun(
              options,
              ['--profile', 'infra', 'logs', '--no-color', '--tail=80', service],
              { allowFailure: true },
            ).stdout
          }`,
        );
      } catch {
        // Service logs are best-effort diagnostics.
      }
    }
    const diagnostics = redact(sections.join('\n'), {
      ...envFileRedactionValues(composeBase(options)),
      ...options.env,
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- infrastructure diagnostics ---\n${diagnostics}`,
      { cause: error },
    );
  }
  applyRolesAndDefinitions(options);
  verifyInfrastructure(options);
}

export function composePort(project, envFile, overrides, service, containerPort, env) {
  const result = composeRun(
    { project, envFile, overrides, env },
    ['port', service, String(containerPort)],
  );
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(line);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error(`Service ${service} did not publish a loopback port ${containerPort}: ${redact(result.stdout, env)}`);
}

export function restartService(project, envFile, overrides, service, env) {
  composeRun({ project, envFile, overrides, env }, ['restart', service]);
}

export function stopService(project, envFile, overrides, service, env) {
  composeRun({ project, envFile, overrides, env }, ['stop', service]);
}

export function pauseService(project, envFile, overrides, service, env) {
  composeRun({ project, envFile, overrides, env }, ['pause', service]);
}

export function unpauseService(project, envFile, overrides, service, env) {
  composeRun({ project, envFile, overrides, env }, ['unpause', service]);
}

export function startService(project, envFile, overrides, service, env) {
  composeRun({ project, envFile, overrides, env }, ['start', service]);
}

export function startDefaultInfrastructure(options = {}) {
  dockerPreflight();
  const env = ensureLocalEnv();
  const overrides = options.devPorts ? [DEV_OVERRIDE] : [];
  const project = 'nexus';
  startCompose({ project, envFile: LOCAL_ENV_FILE, overrides, env });

  if (options.devPorts) {
    const ports = {
      postgres: composePort(project, LOCAL_ENV_FILE, overrides, 'postgres', 5432, env),
      rabbitmq: composePort(project, LOCAL_ENV_FILE, overrides, 'rabbitmq', 5672, env),
      rabbitmqManagement: composePort(project, LOCAL_ENV_FILE, overrides, 'rabbitmq', 15672, env),
      valkey: composePort(project, LOCAL_ENV_FILE, overrides, 'valkey', 6379, env),
    };
    console.log(
      `Development loopback ports: postgres=${ports.postgres}, ` +
        `rabbitmq=${ports.rabbitmq}, rabbitmq-management=${ports.rabbitmqManagement}, valkey=${ports.valkey}`,
    );
  }

  return { project, envFile: LOCAL_ENV_FILE, overrides, env };
}

export function startMigrationInfrastructure() {
  dockerPreflight();
  const env = ensureLocalEnv();
  const overrides = [MIGRATE_OVERRIDE];
  const project = 'nexus';
  startCompose({ project, envFile: LOCAL_ENV_FILE, overrides, env });
  try {
    const port = composePort(project, LOCAL_ENV_FILE, overrides, 'postgres', 5432, env);
    return { project, envFile: LOCAL_ENV_FILE, overrides, env, port };
  } catch (error) {
    try {
      restoreDefaultInfrastructure();
      console.log(
        'Default infrastructure restored without host ports after migration-port discovery failure.',
      );
    } catch (restoreError) {
      console.error(
        `Failed to restore the no-port project after migration-port discovery: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      );
    }
    throw error;
  }
}

export function restoreDefaultInfrastructure() {
  const env = ensureLocalEnv();
  const overrides = [];
  const project = 'nexus';
  startCompose({ project, envFile: LOCAL_ENV_FILE, overrides, env });
  return { project, envFile: LOCAL_ENV_FILE, overrides, env };
}

export function startTestInfrastructure(phase) {
  dockerPreflight();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f02-'));
  const envFile = path.join(tempDir, 'infra.env');
  const env = { ...generateLocalEnv(), NEXUS_OWNER: 'test' };
  writeEnvFile(envFile, env);
  const safePhase = phase.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const project = `nexus-test-${safePhase}-${randomBytes(5).toString('hex')}`;
  const overrides = [TEST_OVERRIDE];

  const teardown = () => {
    try {
      if (!project.startsWith('nexus-test-')) {
        throw new Error(`Refusing to remove non-test Compose project ${project}`);
      }
      const all = runDocker(
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
        env,
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .sort();
      const owned = runDocker(
        [
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
          '--filter',
          'label=nexus.owner=test',
        ],
        env,
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .sort();
      if (all.length !== owned.length || all.some((id, index) => id !== owned[index])) {
        throw new Error(`Refusing to remove Compose project ${project}: ownership labels do not match`);
      }
      const down = composeRun(
        { project, envFile, overrides, env },
        ['--profile', 'infra', 'down', '--volumes', '--remove-orphans'],
        { allowFailure: true },
      );
      if (down.status !== 0) {
        throw new Error(
          `Test infrastructure teardown failed with exit code ${down.status}:\n${redact(
            `${down.stderr}\n${down.stdout}`.trim(),
            env,
          )}`,
        );
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  try {
    startCompose({ project, envFile, overrides, env });
    const postgresPort = composePort(project, envFile, overrides, 'postgres', 5432, env);
    const rabbitPort = composePort(project, envFile, overrides, 'rabbitmq', 5672, env);
    const valkeyPort = composePort(project, envFile, overrides, 'valkey', 6379, env);

    const testEnv = {
      NEXUS_TEST_PG_HOST: '127.0.0.1',
      NEXUS_TEST_PG_PORT: String(postgresPort),
      NEXUS_TEST_PG_DATABASE: 'nexus',
      NEXUS_TEST_SUPERUSER_USER: 'postgres',
      NEXUS_TEST_SUPERUSER_PASSWORD: env.POSTGRES_SUPERUSER_PASSWORD,
      NEXUS_TEST_NEXUS_MIGRATOR_USER: 'nexus_migrator',
      NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD: env.NEXUS_MIGRATOR_PASSWORD,
      NEXUS_TEST_NEXUS_API_USER: 'nexus_api',
      NEXUS_TEST_NEXUS_API_PASSWORD: env.NEXUS_API_PASSWORD,
      NEXUS_TEST_NEXUS_WORKER_USER: 'nexus_worker',
      NEXUS_TEST_NEXUS_WORKER_PASSWORD: env.NEXUS_WORKER_PASSWORD,
      NEXUS_TEST_ENTERPRISE_MIGRATOR_USER: 'enterprise_migrator',
      NEXUS_TEST_ENTERPRISE_MIGRATOR_PASSWORD: env.ENTERPRISE_MIGRATOR_PASSWORD,
      NEXUS_TEST_ENTERPRISE_APP_USER: 'enterprise_app',
      NEXUS_TEST_ENTERPRISE_APP_PASSWORD: env.ENTERPRISE_APP_PASSWORD,
      NEXUS_TEST_ENTERPRISE_READ_TOKEN: env.ENTERPRISE_SIM_READ_TOKEN,
      NEXUS_TEST_ENTERPRISE_COMMAND_TOKEN: env.ENTERPRISE_SIM_COMMAND_TOKEN,
      NEXUS_TEST_RABBIT_HOST: '127.0.0.1',
      NEXUS_TEST_RABBIT_PORT: String(rabbitPort),
      NEXUS_TEST_RABBIT_USER: env.RABBITMQ_DEFAULT_USER,
      NEXUS_TEST_RABBIT_PASSWORD: env.RABBITMQ_DEFAULT_PASS,
      NEXUS_TEST_RABBIT_VHOST: '/nexus',
      NEXUS_TEST_VALKEY_HOST: '127.0.0.1',
      NEXUS_TEST_VALKEY_PORT: String(valkeyPort),
      NEXUS_TEST_VALKEY_PASSWORD: env.VALKEY_PASSWORD,
      NEXUS_TEST_COMPOSE_PROJECT: project,
      NEXUS_TEST_COMPOSE_ENV_FILE: envFile,
      NEXUS_TEST_COMPOSE_OVERRIDE: TEST_OVERRIDE,
    };

    console.log(`Started isolated test infrastructure project ${project}.`);

    return { project, envFile, overrides, env, testEnv, teardown };
  } catch (error) {
    try {
      teardown();
    } catch (teardownError) {
      console.error(
        `Test infrastructure cleanup also failed: ${
          teardownError instanceof Error ? teardownError.message : String(teardownError)
        }`,
      );
    }
    throw error;
  }
}

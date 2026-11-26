import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadManifest,
  parseStageSpec,
  requireRegisteredChecks,
  selectStageSuites,
  validateRegisteredFiles,
} from './lib/phase.mjs';
import { startTestInfrastructure } from './lib/infra.mjs';

function parseArgs(argv) {
  const args = [];
  let manifestPath = path.resolve('tools/phase-checks.json');
  let separatorConsumed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && !separatorConsumed) {
      separatorConsumed = true;
      continue;
    }
    if (argument === '--manifest') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--manifest requires a path');
      }
      manifestPath = path.resolve(value);
      index += 1;
      continue;
    }
    args.push(argument);
  }

  if (args.length !== 1) {
    throw new Error('Usage: pnpm test:e2e [--] <phase ID or Fx-Fy range> [--manifest path]');
  }

  return { manifestPath, spec: args[0] };
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port for an E2E server'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main() {
  let exitCode = 0;
  let infrastructure = null;
  try {
    const options = parseArgs(process.argv.slice(2));
    const loaded = loadManifest(options.manifestPath);
    const selectedIds = parseStageSpec(options.spec, loaded.manifest.stages, loaded.idToIndex);
    requireRegisteredChecks(loaded.manifest, selectedIds);
    const paths = selectStageSuites(loaded.manifest, selectedIds, 'e2eTests');
    validateRegisteredFiles(process.cwd(), paths, 'E2E');

    const positions = new Map(loaded.manifest.stages.map((stage) => [stage.id, stage]));
    const requiresInfrastructure = selectedIds.some(
      (id) => positions.get(id).requiresInfrastructure === true,
    );

    const build = spawnSync('pnpm', ['build'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    if (build.error) {
      throw build.error;
    }
    if ((build.status ?? 1) !== 0) {
      exitCode = build.status ?? 1;
      return;
    }

    const configuredPort = process.env['NEXUS_E2E_PORT'];
    const port = configuredPort ? Number(configuredPort) : await allocateLoopbackPort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid NEXUS_E2E_PORT value: ${configuredPort ?? String(port)}`);
    }

    const testEnv = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      NEXUS_E2E_PORT: String(port),
    };

    if (requiresInfrastructure) {
      infrastructure = startTestInfrastructure(selectedIds.join('-'));
      const apiPort = await allocateLoopbackPort();
      Object.assign(testEnv, infrastructure.testEnv, {
        NEXUS_E2E_API_PORT: String(apiPort),
        NEXUS_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        NEXUS_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        NEXUS_COOKIE_SECURE: 'false',
        NEXUS_DB_HOST: infrastructure.testEnv.NEXUS_TEST_PG_HOST,
        NEXUS_DB_PORT: infrastructure.testEnv.NEXUS_TEST_PG_PORT,
        NEXUS_DB_NAME: infrastructure.testEnv.NEXUS_TEST_PG_DATABASE,
        NEXUS_API_DB_USER: infrastructure.testEnv.NEXUS_TEST_NEXUS_API_USER,
        NEXUS_API_DB_PASSWORD: infrastructure.testEnv.NEXUS_TEST_NEXUS_API_PASSWORD,
        VALKEY_HOST: infrastructure.testEnv.NEXUS_TEST_VALKEY_HOST,
        VALKEY_PORT: infrastructure.testEnv.NEXUS_TEST_VALKEY_PORT,
        VALKEY_PASSWORD: infrastructure.testEnv.NEXUS_TEST_VALKEY_PASSWORD,
      });
      console.log('Isolated test infrastructure is running for E2E. The runner owns its teardown.');
    } else {
      console.log('This phase requires no Compose infrastructure for E2E.');
    }

    const result = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', 'playwright.config.ts', ...paths],
      {
        cwd: process.cwd(),
        env: testEnv,
        stdio: 'inherit',
      },
    );
    if (result.error) {
      throw result.error;
    }
    exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    if (infrastructure) {
      try {
        infrastructure.teardown();
        console.log('E2E test infrastructure teardown completed.');
      } catch (error) {
        console.error(
          `E2E test infrastructure teardown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (exitCode === 0) {
          exitCode = 1;
        }
      }
    }
    process.exitCode = exitCode;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  void main();
}

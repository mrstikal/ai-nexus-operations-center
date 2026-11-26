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
        reject(new Error('Could not allocate a loopback port for the E2E web server'));
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
  try {
    const options = parseArgs(process.argv.slice(2));
    const loaded = loadManifest(options.manifestPath);
    const selectedIds = parseStageSpec(options.spec, loaded.manifest.stages, loaded.idToIndex);
    requireRegisteredChecks(loaded.manifest, selectedIds);
    const paths = selectStageSuites(loaded.manifest, selectedIds, 'e2eTests');
    validateRegisteredFiles(process.cwd(), paths, 'E2E');

    const configuredPort = process.env['NEXUS_E2E_PORT'];
    const port = configuredPort ? Number(configuredPort) : await allocateLoopbackPort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid NEXUS_E2E_PORT value: ${configuredPort ?? String(port)}`);
    }

    const result = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', 'playwright.config.ts', ...paths],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          NEXUS_E2E_PORT: String(port),
        },
        stdio: 'inherit',
      },
    );
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  void main();
}

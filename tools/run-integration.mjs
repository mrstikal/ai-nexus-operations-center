import { spawnSync } from 'node:child_process';
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
    throw new Error('Usage: pnpm test:integration [--] <phase ID or Fx-Fy range> [--manifest path]');
  }

  return { manifestPath, spec: args[0] };
}

function runVitest(paths, env) {
  return spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'integration', ...paths], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
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
    const paths = selectStageSuites(loaded.manifest, selectedIds, 'integrationTests');
    validateRegisteredFiles(process.cwd(), paths, 'Integration');

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

    const positions = new Map(loaded.manifest.stages.map((stage) => [stage.id, stage]));
    const requiresInfrastructure = selectedIds.some(
      (id) => positions.get(id).requiresInfrastructure === true,
    );

    let testEnv = process.env;
    if (requiresInfrastructure) {
      infrastructure = startTestInfrastructure(selectedIds.join('-'));
      testEnv = { ...process.env, ...infrastructure.testEnv };
      console.log(
        'Isolated test infrastructure is running. The runner owns its teardown.',
      );
    } else {
      console.log('This phase requires no Compose infrastructure.');
    }

    const result = runVitest(paths, testEnv);
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
        console.log('Test infrastructure teardown completed.');
      } catch (error) {
        console.error(
          `Test infrastructure teardown failed: ${
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

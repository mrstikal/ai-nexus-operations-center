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

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const loaded = loadManifest(options.manifestPath);
    const selectedIds = parseStageSpec(options.spec, loaded.manifest.stages, loaded.idToIndex);
    requireRegisteredChecks(loaded.manifest, selectedIds);
    const paths = selectStageSuites(loaded.manifest, selectedIds, 'integrationTests');
    validateRegisteredFiles(process.cwd(), paths, 'Integration');

    console.log(
      'Integration infrastructure provisioning begins in F02. F01 suites run without Compose or a database.',
    );
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'integration', ...paths], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
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
  main();
}

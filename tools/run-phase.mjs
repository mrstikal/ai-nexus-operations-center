import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectDependencyClosure,
  collectSuiteStageIds,
  collectUnitPaths,
  loadManifest,
  parseStageSpec,
  requireRegisteredChecks,
  validateArtifacts,
  validateRegisteredFiles,
  validateManifest,
} from './lib/phase.mjs';

export function defaultCommandRunner(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function buildVerifyPlan({
  manifestPath = path.resolve('tools/phase-checks.json'),
  manifest = null,
  spec,
  rootDir = process.cwd(),
}) {
  const loaded = manifest ? validateManifest(manifest, manifestPath) : loadManifest(manifestPath);
  const selectedIds = parseStageSpec(spec, loaded.manifest.stages, loaded.idToIndex);
  requireRegisteredChecks(loaded.manifest, selectedIds);
  collectDependencyClosure(loaded.manifest, selectedIds);

  const positions = loaded.idToIndex;
  const throughIndex = Math.max(...selectedIds.map((id) => positions.get(id)));
  const unitPaths = collectUnitPaths(loaded.manifest, throughIndex);
  validateRegisteredFiles(rootDir, unitPaths, 'Cumulative unit test');

  const { integrationIds, e2eIds } = collectSuiteStageIds(loaded.manifest, selectedIds);
  for (const id of integrationIds) {
    const stage = loaded.manifest.stages[positions.get(id)];
    validateRegisteredFiles(rootDir, stage.integrationTests, `Integration suite ${id}`);
  }
  for (const id of e2eIds) {
    const stage = loaded.manifest.stages[positions.get(id)];
    validateRegisteredFiles(rootDir, stage.e2eTests, `E2E suite ${id}`);
  }

  const artifacts = [];
  for (const id of selectedIds) {
    for (const artifact of loaded.manifest.stages[positions.get(id)].artifacts) {
      if (!artifacts.some((candidate) => candidate.path === artifact.path)) {
        artifacts.push(artifact);
      }
    }
  }

  const steps = [
    { name: 'lint', command: 'pnpm', args: ['lint'] },
    { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
    { name: 'build', command: 'pnpm', args: ['build'] },
  ];

  if (unitPaths.length > 0) {
    steps.push({
      name: 'unit',
      command: 'pnpm',
      args: ['exec', 'vitest', 'run', '--project', 'unit', ...unitPaths],
    });
  }
  for (const id of integrationIds) {
    steps.push({ name: `integration:${id}`, command: 'pnpm', args: ['test:integration', id] });
  }
  for (const id of e2eIds) {
    steps.push({ name: `e2e:${id}`, command: 'pnpm', args: ['test:e2e', id] });
  }

  return {
    manifest: loaded.manifest,
    selectedIds,
    artifacts,
    unitPaths,
    integrationIds,
    e2eIds,
    steps,
  };
}

export function verifyPhase({
  manifestPath = path.resolve('tools/phase-checks.json'),
  manifest = null,
  spec,
  rootDir = process.cwd(),
  runCommand = defaultCommandRunner,
  dryRun = false,
  log = console.log,
}) {
  const plan = buildVerifyPlan({ manifestPath, manifest, spec, rootDir });

  if (dryRun) {
    log(`Phase selection: ${plan.selectedIds.join(', ')}`);
    for (const artifact of plan.artifacts) {
      log(`artifact: ${artifact.path} (at least ${artifact.minBytes} bytes)`);
    }
    for (const step of plan.steps) {
      log(`step: ${step.name} -> ${step.command} ${step.args.join(' ')}`);
    }
    return { code: 0, executed: [], plan };
  }

  validateArtifacts(rootDir, plan.artifacts);

  const executed = [];
  for (const step of plan.steps) {
    executed.push(step.name);
    log(`Running ${step.name}: ${step.command} ${step.args.join(' ')}`);
    const code = runCommand(step.command, step.args, { rootDir, step: step.name });
    if (code !== 0) {
      return { code, executed, failedStep: step.name, plan };
    }
  }

  return { code: 0, executed, plan };
}

function parseVerifyArgs(argv) {
  const args = [];
  let manifestPath = path.resolve('tools/phase-checks.json');
  let dryRun = false;
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
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    args.push(argument);
  }

  if (args.length !== 1) {
    throw new Error('Usage: pnpm verify:phase [--] <phase ID or Fx-Fy range> [--manifest path] [--dry-run]');
  }

  return { manifestPath, spec: args[0], dryRun };
}

function main() {
  try {
    const options = parseVerifyArgs(process.argv.slice(2));
    const result = verifyPhase(options);
    if (result.code !== 0) {
      console.error(`Phase verification failed in step ${result.failedStep ?? 'unknown'} with exit code ${result.code}`);
      process.exitCode = result.code;
      return;
    }
    console.log('Phase verification passed.');
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

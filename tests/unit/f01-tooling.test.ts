import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadManifest,
  parseStageSpec,
  stageHasChecks,
} from '../../tools/lib/phase.mjs';
import { ensureLocalEnv } from '../../tools/lib/infra.mjs';
import { buildVerifyPlan, verifyPhase } from '../../tools/run-phase.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = path.join(root, 'tools/phase-checks.json');

function runCli(script: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'tools', script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function stageList(ids: string[]) {
  return ids.map((id) => ({ id }));
}

function indexOf(ids: string[]) {
  return new Map(ids.map((id, index) => [id, index]));
}

describe('F01 phase manifest and selection', () => {
  it('parses exact IDs, leading separators, and ranges in manifest order', () => {
    const ids = ['F01', 'F02', 'F03', 'F03A', 'F04'];
    const stages = stageList(ids);
    const idToIndex = indexOf(ids);

    expect(parseStageSpec('F03', stages, idToIndex)).toEqual(['F03']);
    expect(parseStageSpec('--F03A', stages, idToIndex)).toEqual(['F03A']);
    expect(parseStageSpec('F02-F03A', stages, idToIndex)).toEqual(['F02', 'F03', 'F03A']);
    expect(parseStageSpec('F03A-F04', stages, idToIndex)).toEqual(['F03A', 'F04']);
  });

  it('rejects unknown, malformed, and reversed phase selections', () => {
    const ids = ['F01', 'F02', 'F03'];
    const stages = stageList(ids);
    const idToIndex = indexOf(ids);

    expect(() => parseStageSpec('F99', stages, idToIndex)).toThrow(/Unknown phase F99/);
    expect(() => parseStageSpec('f01', stages, idToIndex)).toThrow(/Invalid phase ID/);
    expect(() => parseStageSpec('F03-F01', stages, idToIndex)).toThrow(/canonical manifest order/);
    expect(() => parseStageSpec('F01-F02-F03', stages, idToIndex)).toThrow(/Invalid phase range/);
  });

  it('keeps the canonical 74-stage manifest ordered with backward dependencies', () => {
    const { manifest } = loadManifest(manifestPath);
    const ids: string[] = manifest.stages.map((stage: { id: string }) => stage.id);
    const index = new Map<string, number>(ids.map((id: string, position: number) => [id, position]));

    expect(ids).toHaveLength(74);
    expect(ids[0]).toBe('F01');
    expect(ids.at(-1)).toBe('F52');
    expect(new Set(ids).size).toBe(74);

    for (const stage of manifest.stages) {
      const stageIndex = index.get(stage.id) ?? -1;
      for (const dependency of stage.dependencies) {
        const dependencyIndex = index.get(dependency) ?? -1;
        expect(dependencyIndex).toBeGreaterThanOrEqual(0);
        expect(dependencyIndex).toBeLessThan(stageIndex);
      }
    }

    expect(stageHasChecks(manifest.stages[0])).toBe(true);
    expect(manifest.stages[0].unitTests).toContain('tests/unit/f01-tooling.test.ts');
  });

  it('rejects a phase with no registered checks through the CLI', () => {
    const result = runCli('run-phase.mjs', [
      '--manifest',
      path.join(root, 'tests/fixtures/phases/empty-stage.json'),
      'F01',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no registered checks');
  });

  it('rejects an unknown phase through the CLI', () => {
    const result = runCli('run-phase.mjs', ['F99']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown phase F99');
  });

  it('selects the F01 registered suites and artifacts', () => {
    const plan = buildVerifyPlan({ manifestPath, spec: 'F01', rootDir: root });

    expect(plan.selectedIds).toEqual(['F01']);
    expect(plan.unitPaths).toEqual(['tests/unit/f01-tooling.test.ts']);
    expect(plan.integrationIds).toEqual(['F01']);
    expect(plan.e2eIds).toEqual(['F01']);
    expect(plan.artifacts.length).toBeGreaterThan(0);
  });

  it('propagates a failing stage suite exit code and stops later steps', () => {
    const result = verifyPhase({
      manifestPath: path.join(root, 'tests/fixtures/phases/executable-stage.json'),
      spec: 'F01',
      rootDir: root,
      log: () => undefined,
      runCommand: (_command, _args, options) => (options.step === 'unit' ? 7 : 0),
    });

    expect(result.code).toBe(7);
    expect(result.failedStep).toBe('unit');
    expect(result.executed).toEqual(['lint', 'typecheck', 'build', 'unit']);
  });

  it('fails artifact assertions before running commands', () => {
    let commandsRun = 0;

    expect(() =>
      verifyPhase({
        manifestPath: path.join(root, 'tests/fixtures/phases/missing-artifact-stage.json'),
        spec: 'F01',
        rootDir: root,
        log: () => undefined,
        runCommand: () => {
          commandsRun += 1;
          return 0;
        },
      }),
    ).toThrow(/Artifact assertions failed/);
    expect(commandsRun).toBe(0);
  });
});

describe('F01 local infrastructure environment backfill', () => {
  it('backfills derived runtime keys into an existing .env without changing role passwords', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-env-'));
    const envFile = path.join(directory, '.env');
    try {
      writeFileSync(
        envFile,
        [
          'POSTGRES_SUPERUSER_PASSWORD=superuser-secret',
          'NEXUS_MIGRATOR_PASSWORD=migrator-secret',
          'NEXUS_API_PASSWORD=api-secret',
          'NEXUS_WORKER_PASSWORD=worker-secret',
          'ENTERPRISE_MIGRATOR_PASSWORD=enterprise-migrator-secret',
          'ENTERPRISE_APP_PASSWORD=enterprise-app-secret',
          'RABBITMQ_DEFAULT_USER=nexus_app',
          'RABBITMQ_DEFAULT_PASS=rabbit-secret',
          'VALKEY_PASSWORD=valkey-secret',
          'NEXUS_PG_DEV_PORT=55432',
          'NEXUS_DB_HOST=127.0.0.1',
          'NEXUS_DB_HOST=',
          '  NEXUS_DB_NAME=',
          '# keep this local maintenance note',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );

      ensureLocalEnv(envFile);

      const rewritten = readFileSync(envFile, 'utf8');
      expect(rewritten).toContain('# keep this local maintenance note');
      expect(rewritten.match(/^NEXUS_DB_HOST=/gm)).toHaveLength(2);
      expect(rewritten.match(/^NEXUS_DB_HOST=127\.0\.0\.1$/gm)).toHaveLength(2);
      expect(rewritten.match(/^ {2}NEXUS_DB_NAME=nexus$/gm)).toHaveLength(1);
      const values = Object.fromEntries(
        readFileSync(envFile, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      expect(values['NEXUS_DB_HOST']).toBe('127.0.0.1');
      expect(values['NEXUS_DB_PORT']).toBe('55432');
      expect(values['NEXUS_API_DB_PASSWORD']).toBe('api-secret');
      expect(values['NEXUS_WORKER_DB_PASSWORD']).toBe('worker-secret');
      expect(values['ENTERPRISE_APP_DB_PASSWORD']).toBe('enterprise-app-secret');
      expect(values['NEXUS_API_PASSWORD']).toBe('api-secret');
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('F01 dependency boundary checker', () => {
  it('rejects the checked-in invalid workspace fixture', () => {
    const result = runCli('check-boundaries.mjs', [
      '--root',
      path.join(root, 'tests/fixtures/boundaries/invalid'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/contracts may depend only on Zod');
    expect(result.stderr).toContain('apps/web must not import DB');
  });

  it('accepts the checked-in valid workspace fixture', () => {
    const result = runCli('check-boundaries.mjs', [
      '--root',
      path.join(root, 'tests/fixtures/boundaries/valid'),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dependency boundary check passed');
  });
});

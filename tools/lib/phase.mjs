import fs from 'node:fs';
import path from 'node:path';

const PHASE_ID_PATTERN = /^F\d{2}[A-Z]?$/;
const SUITE_KINDS = ['unitTests', 'integrationTests', 'e2eTests'];

function fail(message) {
  throw new Error(message);
}

export function stageHasChecks(stage) {
  return (
    stage.unitTests.length > 0 ||
    stage.integrationTests.length > 0 ||
    stage.e2eTests.length > 0 ||
    stage.artifacts.length > 0
  );
}

export function normalizeArtifact(artifact) {
  if (typeof artifact === 'string') {
    return { path: artifact, minBytes: 1 };
  }
  return artifact;
}

export function validateManifest(manifest, manifestPath = 'tools/phase-checks.json') {
  if (!manifest || typeof manifest !== 'object') {
    fail(`${manifestPath}: manifest must be a JSON object`);
  }
  if (manifest.version !== 1) {
    fail(`${manifestPath}: unsupported manifest version ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
    fail(`${manifestPath}: manifest must contain a non-empty stages array`);
  }

  const idToIndex = new Map();
  manifest.stages.forEach((stage, index) => {
    if (!stage || typeof stage !== 'object') {
      fail(`${manifestPath}: stage at index ${index} must be an object`);
    }
    if (typeof stage.id !== 'string' || !PHASE_ID_PATTERN.test(stage.id)) {
      fail(`${manifestPath}: invalid stage id at index ${index}: ${String(stage.id)}`);
    }
    if (idToIndex.has(stage.id)) {
      fail(`${manifestPath}: duplicate stage id ${stage.id}`);
    }
    idToIndex.set(stage.id, index);
    if (typeof stage.name !== 'string' || stage.name.trim() === '') {
      fail(`${manifestPath}: stage ${stage.id} needs a non-empty name`);
    }
    if (!Array.isArray(stage.dependencies)) {
      fail(`${manifestPath}: stage ${stage.id} needs a dependencies array`);
    }
    for (const kind of SUITE_KINDS) {
      if (!Array.isArray(stage[kind])) {
        fail(`${manifestPath}: stage ${stage.id} needs a ${kind} array`);
      }
    }
    if (!Array.isArray(stage.artifacts)) {
      fail(`${manifestPath}: stage ${stage.id} needs an artifacts array`);
    }
    stage.artifacts = stage.artifacts.map((artifact) => normalizeArtifact(artifact));
    for (const artifact of stage.artifacts) {
      if (
        !artifact ||
        typeof artifact.path !== 'string' ||
        artifact.path.trim() === '' ||
        !Number.isFinite(artifact.minBytes) ||
        artifact.minBytes < 0
      ) {
        fail(`${manifestPath}: stage ${stage.id} has an invalid artifact assertion`);
      }
    }
    if (typeof stage.checkpoint !== 'boolean') {
      fail(`${manifestPath}: stage ${stage.id} needs a boolean checkpoint flag`);
    }
  });

  manifest.stages.forEach((stage, index) => {
    const seen = new Set();
    for (const dependency of stage.dependencies) {
      if (typeof dependency !== 'string' || !PHASE_ID_PATTERN.test(dependency)) {
        fail(`${manifestPath}: stage ${stage.id} has an invalid dependency ${String(dependency)}`);
      }
      if (seen.has(dependency)) {
        fail(`${manifestPath}: stage ${stage.id} lists ${dependency} more than once`);
      }
      seen.add(dependency);
      const dependencyIndex = idToIndex.get(dependency);
      if (dependencyIndex === undefined) {
        fail(`${manifestPath}: stage ${stage.id} depends on unknown stage ${dependency}`);
      }
      if (dependencyIndex >= index) {
        fail(`${manifestPath}: stage ${stage.id} must not depend forward on ${dependency}`);
      }
    }
  });

  return { manifest, idToIndex };
}

export function loadManifest(manifestPath = path.resolve('tools/phase-checks.json')) {
  const absolutePath = path.resolve(manifestPath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${absolutePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(parsed, absolutePath);
}

export function stripOneLeadingSeparator(value) {
  return value.startsWith('--') ? value.slice(2) : value;
}

export function parseStageSpec(rawSpec, stages, idToIndex) {
  if (typeof rawSpec !== 'string' || rawSpec.trim() === '') {
    fail('A phase ID is required');
  }
  const spec = stripOneLeadingSeparator(rawSpec.trim());
  if (spec.includes('-')) {
    const parts = spec.split('-');
    if (parts.length !== 2 || !PHASE_ID_PATTERN.test(parts[0]) || !PHASE_ID_PATTERN.test(parts[1])) {
      fail(`Invalid phase range "${spec}"; use an exact ID such as F11A or a range such as F01-F03`);
    }
    const startIndex = idToIndex.get(parts[0]);
    const endIndex = idToIndex.get(parts[1]);
    if (startIndex === undefined) {
      fail(`Unknown phase ${parts[0]}`);
    }
    if (endIndex === undefined) {
      fail(`Unknown phase ${parts[1]}`);
    }
    if (startIndex > endIndex) {
      fail(`Invalid phase range "${spec}"; ranges follow the canonical manifest order`);
    }
    return stages.slice(startIndex, endIndex + 1).map((stage) => stage.id);
  }
  if (!PHASE_ID_PATTERN.test(spec)) {
    fail(`Invalid phase ID "${spec}"; expected an ID such as F01 or F11A`);
  }
  if (!idToIndex.has(spec)) {
    fail(`Unknown phase ${spec}`);
  }
  return [spec];
}

export function requireRegisteredChecks(manifest, selectedIds) {
  for (const id of selectedIds) {
    const stage = manifest.stages.find((candidate) => candidate.id === id);
    if (!stage) {
      fail(`Unknown phase ${id}`);
    }
    if (!stageHasChecks(stage)) {
      fail(
        `Phase ${id} has no registered checks. A selected but empty phase is an error; register real suites or artifact assertions when that phase is implemented.`,
      );
    }
  }
}

export function collectDependencyClosure(manifest, selectedIds) {
  const index = new Map(manifest.stages.map((stage, position) => [stage.id, position]));
  const closure = new Set();
  const visit = (id) => {
    if (closure.has(id)) {
      return;
    }
    const stage = manifest.stages[index.get(id)];
    if (!stage) {
      fail(`Unknown phase ${id}`);
    }
    for (const dependency of stage.dependencies) {
      const dependencyStage = manifest.stages[index.get(dependency)];
      if (!dependencyStage) {
        fail(`Phase ${id} depends on unknown phase ${dependency}`);
      }
      if (!stageHasChecks(dependencyStage)) {
        fail(
          `Phase ${id} depends on ${dependency}, which has no registered checks. Future dependencies cannot satisfy a verification gate.`,
        );
      }
      visit(dependency);
    }
    closure.add(id);
  };
  for (const id of selectedIds) {
    visit(id);
  }
  return [...closure];
}

export function collectUnitPaths(manifest, throughIndex) {
  const paths = [];
  for (let index = 0; index <= throughIndex; index += 1) {
    for (const testPath of manifest.stages[index].unitTests) {
      if (!paths.includes(testPath)) {
        paths.push(testPath);
      }
    }
  }
  return paths;
}

export function collectSuiteStageIds(manifest, selectedIds) {
  const index = new Map(manifest.stages.map((stage, position) => [stage.id, position]));
  const integrationIds = new Set();
  const e2eIds = new Set();
  for (const id of selectedIds) {
    const position = index.get(id);
    const stage = manifest.stages[position];
    if (stage.integrationTests.length > 0) {
      integrationIds.add(id);
    }
    if (stage.e2eTests.length > 0) {
      e2eIds.add(id);
    }
    if (stage.checkpoint) {
      for (let prior = 0; prior <= position; prior += 1) {
        const priorStage = manifest.stages[prior];
        if (priorStage.integrationTests.length > 0) {
          integrationIds.add(priorStage.id);
        }
        if (priorStage.e2eTests.length > 0) {
          e2eIds.add(priorStage.id);
        }
      }
    }
  }
  return {
    integrationIds: manifest.stages
      .map((stage) => stage.id)
      .filter((id) => integrationIds.has(id)),
    e2eIds: manifest.stages.map((stage) => stage.id).filter((id) => e2eIds.has(id)),
  };
}

export function validateRegisteredFiles(rootDir, relativePaths, label) {
  const root = path.resolve(rootDir);
  const problems = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      problems.push(`${relativePath}: path escapes the repository root`);
      continue;
    }
    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      problems.push(`${relativePath}: file does not exist`);
      continue;
    }
    if (!stats.isFile() || stats.size === 0) {
      problems.push(`${relativePath}: file is missing or empty`);
    }
  }
  if (problems.length > 0) {
    fail(`${label} selection is invalid:\n- ${problems.join('\n- ')}`);
  }
}

export function validateArtifacts(rootDir, artifacts) {
  const root = path.resolve(rootDir);
  const problems = [];
  for (const artifact of artifacts) {
    const absolutePath = path.resolve(root, artifact.path);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      problems.push(`${artifact.path}: path escapes the repository root`);
      continue;
    }
    let stats;
    try {
      stats = fs.statSync(absolutePath);
    } catch {
      problems.push(`${artifact.path}: missing`);
      continue;
    }
    if (!stats.isFile()) {
      problems.push(`${artifact.path}: not a file`);
      continue;
    }
    if (stats.size < artifact.minBytes) {
      problems.push(`${artifact.path}: ${stats.size} bytes is below the required ${artifact.minBytes}`);
    }
  }
  if (problems.length > 0) {
    fail(`Artifact assertions failed:\n- ${problems.join('\n- ')}`);
  }
}

export function selectStageSuites(manifest, selectedIds, kind) {
  const index = new Map(manifest.stages.map((stage, position) => [stage.id, position]));
  const paths = [];
  for (const id of selectedIds) {
    const stage = manifest.stages[index.get(id)];
    if (stage[kind].length === 0) {
      fail(`Phase ${id} has no ${kind} registered; a selected but empty suite is an error`);
    }
    for (const testPath of stage[kind]) {
      if (!paths.includes(testPath)) {
        paths.push(testPath);
      }
    }
  }
  return paths;
}

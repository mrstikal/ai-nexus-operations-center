import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'PostgreSQL',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);
const WORKSPACE_PREFIXES = ['@nexus/'];

function isInstalledPackageManifest(filePath) {
  const parts = filePath.split(path.sep);
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex === -1) {
    return false;
  }
  const tail = parts.slice(nodeModulesIndex + 1);
  return tail.length === 2 || (tail.length === 3 && tail[0].startsWith('@'));
}

function collectPackageJsonFiles(directory, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectPackageJsonFiles(path.join(directory, entry.name), result);
      continue;
    }
    if (entry.name === 'package.json') {
      const filePath = path.join(directory, entry.name);
      if (isInstalledPackageManifest(filePath)) {
        result.push(filePath);
      }
    }
  }
  return result;
}

function normalizeLicense(pkg) {
  const raw = pkg.license ?? pkg.licenses;
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.type === 'string') {
    return raw.type.trim();
  }
  if (Array.isArray(raw)) {
    const values = raw
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim();
        }
        if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
          return entry.type.trim();
        }
        return '';
      })
      .filter(Boolean);
    return values.join(' OR ');
  }
  return '';
}

function licenseTokens(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .replace(/\b(AND|OR|WITH)\b/g, ' ')
    .split(/[\s/]+/)
    .map((token) => token.replace(/\*$/, '').trim())
    .filter(Boolean);
}

function isAllowedExpression(expression) {
  if (!expression) {
    return false;
  }
  const tokens = licenseTokens(expression);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => ALLOWED_LICENSES.has(token));
}

function readWorkspaceManifests() {
  const manifests = [{ file: path.join(ROOT, 'package.json'), json: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) }];
  const appsDir = path.join(ROOT, 'apps');
  if (fs.existsSync(appsDir)) {
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(appsDir, entry.name, 'package.json');
      if (fs.existsSync(manifestPath)) {
        manifests.push({ file: manifestPath, json: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) });
      }
    }
  }
  const packagesDir = path.join(ROOT, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(packagesDir, entry.name, 'package.json');
      if (fs.existsSync(manifestPath)) {
        manifests.push({ file: manifestPath, json: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) });
      }
    }
  }
  return manifests;
}

function resolveDirectDependencies(manifests, problems) {
  const resolved = new Map();
  for (const { file, json } of manifests) {
    const workspaceDir = path.dirname(file);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = json[field];
      if (!dependencies || typeof dependencies !== 'object') {
        continue;
      }
      for (const name of Object.keys(dependencies)) {
        if (WORKSPACE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
          continue;
        }
        const packageJsonPath = path.join(workspaceDir, 'node_modules', ...name.split('/'), 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
          problems.push(
            `${path.relative(ROOT, file)}: direct dependency ${name} is not installed in the workspace`,
          );
          continue;
        }
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (typeof pkg.version !== 'string') {
          problems.push(`${name}: installed package has no version`);
          continue;
        }
        resolved.set(`${name}@${pkg.version}`, {
          name,
          version: pkg.version,
          license: normalizeLicense(pkg),
        });
      }
    }
  }
  return [...resolved.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

function parseNoticeRows(notices, problems) {
  const rows = new Map();
  for (const line of notices.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!match) {
      continue;
    }
    const key = `${match[1]}@${match[2].trim()}`;
    const license = match[3].trim();
    if (rows.has(key) && rows.get(key) !== license) {
      problems.push(`THIRD_PARTY_NOTICES.md has conflicting license rows for ${key}`);
      continue;
    }
    rows.set(key, license);
  }
  return rows;
}

function main() {
  const noticesPath = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
  const licensePath = path.join(ROOT, 'LICENSE');
  const problems = [];

  if (!fs.existsSync(noticesPath)) {
    problems.push('THIRD_PARTY_NOTICES.md is missing');
  }
  if (!fs.existsSync(licensePath)) {
    problems.push('LICENSE is missing');
  } else if (!/MIT License/i.test(fs.readFileSync(licensePath, 'utf8'))) {
    problems.push('LICENSE does not contain the MIT license text');
  }

  const manifests = readWorkspaceManifests();
  const direct = resolveDirectDependencies(manifests, problems);

  const packageFiles = collectPackageJsonFiles(path.join(ROOT, 'node_modules/.pnpm'));
  const installed = new Map();
  for (const packageFile of packageFiles) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    } catch {
      problems.push(`${path.relative(ROOT, packageFile)}: invalid JSON`);
      continue;
    }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      continue;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (!installed.has(key)) {
      installed.set(key, { name: pkg.name, version: pkg.version, license: normalizeLicense(pkg) });
    }
  }

  const noticesText = fs.existsSync(noticesPath) ? fs.readFileSync(noticesPath, 'utf8') : '';
  if (noticesText !== '') {
    const noticeRows = parseNoticeRows(noticesText, problems);
    for (const dependency of direct) {
      const key = `${dependency.name}@${dependency.version}`;
      const recordedLicense = noticeRows.get(key);
      if (recordedLicense === undefined) {
        problems.push(`THIRD_PARTY_NOTICES.md is missing row ${key}`);
        continue;
      }
      if (recordedLicense !== dependency.license) {
        problems.push(
          `THIRD_PARTY_NOTICES.md records ${key} as ${recordedLicense}, but the installed license is ${dependency.license || '(missing)'}`,
        );
      }
      if (!installed.has(key)) {
        problems.push(`Direct dependency ${key} is not present in the installed graph`);
      }
    }
  }

  const unknown = [];
  const licenseCounts = new Map();
  for (const pkg of installed.values()) {
    if (!isAllowedExpression(pkg.license)) {
      unknown.push(pkg);
      continue;
    }
    const key = pkg.license || '(missing)';
    licenseCounts.set(key, (licenseCounts.get(key) ?? 0) + 1);
  }

  if (unknown.length > 0) {
    for (const pkg of unknown) {
      problems.push(
        `Unapproved or unknown license for ${pkg.name}@${pkg.version}: ${pkg.license || '(missing)'}`,
      );
    }
  }

  const containerImages = [];
  const versionsPath = path.join(ROOT, 'infra/versions.json');
  if (fs.existsSync(versionsPath)) {
    const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
    const composePath = path.join(ROOT, 'infra/compose.yaml');
    const compose = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf8') : '';
    const dockerfilePath = path.join(ROOT, 'infra/Dockerfile.postgres');
    const dockerfile = fs.existsSync(dockerfilePath)
      ? fs.readFileSync(dockerfilePath, 'utf8')
      : '';
    for (const [name, entry] of Object.entries(versions)) {
      if (
        !entry ||
        typeof entry.tag !== 'string' ||
        typeof entry.digest !== 'string' ||
        typeof entry.license !== 'string'
      ) {
        problems.push(`infra/versions.json entry ${name} is incomplete`);
        continue;
      }
      const imageRef = `${entry.tag}@${entry.digest}`;
      containerImages.push(imageRef);
      if (!isAllowedExpression(entry.license)) {
        problems.push(`Unapproved container license for ${entry.tag}: ${entry.license}`);
      }
      if (!noticesText.includes(entry.tag) || !noticesText.includes(entry.license)) {
        problems.push(`THIRD_PARTY_NOTICES.md is missing container notice for ${entry.tag}`);
      }
      if (name === 'postgres') {
        if (
          !entry.pgvector ||
          typeof entry.pgvector.version !== 'string' ||
          typeof entry.pgvector.sha256 !== 'string' ||
          typeof entry.pgvector.license !== 'string'
        ) {
          problems.push('infra/versions.json is missing the pgvector source pin');
        } else {
          if (!isAllowedExpression(entry.pgvector.license)) {
            problems.push(`Unapproved pgvector license: ${entry.pgvector.license}`);
          }
          if (
            typeof entry.pgvector.buildFlags !== 'string' ||
            entry.pgvector.buildFlags === ''
          ) {
            problems.push('infra/versions.json is missing the pgvector buildFlags pin');
          }
          if (
            !dockerfile.includes(entry.digest) ||
            !dockerfile.includes(entry.pgvector.version) ||
            !dockerfile.includes(entry.pgvector.sha256) ||
            (typeof entry.pgvector.buildFlags === 'string' &&
              entry.pgvector.buildFlags !== '' &&
              !dockerfile.includes(entry.pgvector.buildFlags))
          ) {
            problems.push('infra/Dockerfile.postgres does not match the pinned PostgreSQL/pgvector versions');
          }
          if (!noticesText.includes(entry.pgvector.version)) {
            problems.push('THIRD_PARTY_NOTICES.md is missing the pgvector notice');
          }
        }
      } else if (!compose.includes(entry.digest)) {
        problems.push(`infra/compose.yaml does not reference the pinned digest for ${entry.tag}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`License check failed with ${problems.length} problem(s).`);
    process.exitCode = 1;
    return;
  }

  const summary = [...licenseCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([license, count]) => `${license}: ${count}`)
    .join(', ');
  console.log(`License check passed for ${installed.size} installed package version(s).`);
  console.log(`Licenses: ${summary}`);
  console.log(`Direct dependencies verified against notices: ${direct.length}`);
  console.log(
    containerImages.length === 0
      ? 'Container images: none declared.'
      : `Container images verified against notices and pins: ${containerImages.join(', ')}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

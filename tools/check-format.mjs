import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const INCLUDED_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.svg',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const INCLUDED_NAMES = new Set(['.gitignore', '.node-version', '.npmrc', '.nvmrc', 'LICENSE']);
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.next',
  'agent-memory',
  'blob-report',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const SKIP_FILES = new Set([
  'AGENTS.md',
  'NEXUS_IMPLEMENTATION_PLAN_base.md',
  'NEXUS_IMPLEMENTATION_PLAN_final.md',
  'pnpm-lock.yaml',
]);

function shouldCheck(filePath) {
  const basename = path.basename(filePath);
  if (SKIP_FILES.has(basename)) {
    return false;
  }
  if (INCLUDED_NAMES.has(basename)) {
    return true;
  }
  return INCLUDED_EXTENSIONS.has(path.extname(basename));
}

function walk(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        walk(path.join(directory, entry.name), result);
      }
      continue;
    }
    const filePath = path.join(directory, entry.name);
    if (shouldCheck(filePath)) {
      result.push(filePath);
    }
  }
  return result;
}

function checkFile(filePath) {
  const problems = [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.startsWith('\uFEFF')) {
    problems.push('contains a byte-order mark');
  }
  if (text.includes('\r')) {
    problems.push('contains CR characters; use LF line endings');
  }
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      problems.push(`line ${index + 1} has trailing whitespace`);
    }
  });
  if (!text.endsWith('\n')) {
    problems.push('file does not end with a newline');
  } else if (text.endsWith('\n\n')) {
    problems.push('file ends with more than one newline');
  }
  return problems;
}

function main() {
  const files = walk(ROOT).sort();
  const violations = [];

  for (const file of files) {
    const problems = checkFile(file);
    for (const problem of problems) {
      violations.push(`${path.relative(ROOT, file)}: ${problem}`);
    }
  }

  if (violations.length > 0) {
    for (const violation of violations.slice(0, 40)) {
      console.error(violation);
    }
    if (violations.length > 40) {
      console.error(`... and ${violations.length - 40} more formatting violation(s)`);
    }
    console.error(`Format check failed with ${violations.length} violation(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Format check passed for ${files.length} file(s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import fs from 'node:fs';
import path from 'node:path';
import { loadManifest } from './lib/phase.mjs';

const ROOT = process.cwd();
const REQUIRED_FILES = [
  'docs/PROGRESS.md',
  'docs/DEVELOPMENT.md',
  'docs/adr/001-workspace.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
const PLAN_PATH = 'NEXUS_IMPLEMENTATION_PLAN_final.md';

function walkMarkdown(directory, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkMarkdown(path.join(directory, entry.name), result);
      continue;
    }
    if (entry.name.endsWith('.md')) {
      result.push(path.join(directory, entry.name));
    }
  }
  return result;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function headingSlugs(markdown) {
  const slugs = new Set();
  const lines = markdown.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (match) {
      slugs.add(slugify(match[1]));
    }
  }
  return slugs;
}

function localLinks(markdown) {
  const links = [];
  const lines = markdown.split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      let target = match[1].trim();
      if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1);
      }
      target = target.split(/\s+/)[0];
      links.push({ target, line: index + 1 });
    }
  }
  return links;
}

function checkLocalLinks() {
  const problems = [];
  const markdownFiles = walkMarkdown(path.join(ROOT, 'docs'));
  for (const file of markdownFiles) {
    const markdown = fs.readFileSync(file, 'utf8');
    for (const link of localLinks(markdown)) {
      if (
        link.target === '' ||
        link.target.startsWith('#') ||
        /^[a-z][a-z0-9+.-]*:/i.test(link.target) ||
        link.target.startsWith('//')
      ) {
        if (link.target.startsWith('#')) {
          const slugs = headingSlugs(markdown);
          if (!slugs.has(decodeURIComponent(link.target.slice(1)))) {
            problems.push(`${path.relative(ROOT, file)}:${link.line} missing heading ${link.target}`);
          }
        }
        continue;
      }
      const [rawTargetPath, rawAnchor] = link.target.split('#');
      const decodedPath = decodeURIComponent(rawTargetPath);
      const absoluteTarget = path.resolve(path.dirname(file), decodedPath);
      if (!absoluteTarget.startsWith(ROOT)) {
        problems.push(`${path.relative(ROOT, file)}:${link.line} link escapes the repository: ${link.target}`);
        continue;
      }
      if (!fs.existsSync(absoluteTarget)) {
        problems.push(`${path.relative(ROOT, file)}:${link.line} missing link target ${link.target}`);
        continue;
      }
      if (rawAnchor && fs.statSync(absoluteTarget).isFile() && absoluteTarget.endsWith('.md')) {
        const targetMarkdown = fs.readFileSync(absoluteTarget, 'utf8');
        if (!headingSlugs(targetMarkdown).has(decodeURIComponent(rawAnchor))) {
          problems.push(`${path.relative(ROOT, file)}:${link.line} missing heading #${rawAnchor} in ${decodedPath}`);
        }
      }
    }
  }
  return problems;
}

function planStageIds() {
  const plan = fs.readFileSync(path.join(ROOT, PLAN_PATH), 'utf8');
  const ids = [];
  for (const line of plan.split('\n')) {
    const match = line.match(/^### (F\d{2}[A-Z]?) - /);
    if (match) {
      ids.push(match[1]);
    }
  }
  return ids;
}

function checkOpenApi() {
  const generatedPath = path.join(ROOT, 'docs/openapi.json');
  const generatorPath = path.join(ROOT, 'tools/generate-openapi.mjs');
  if (!fs.existsSync(generatedPath)) {
    return 'OpenAPI drift check: not applicable until F03 generates docs/openapi.json.';
  }
  if (!fs.existsSync(generatorPath)) {
    throw new Error('docs/openapi.json exists but tools/generate-openapi.mjs is missing');
  }
  const document = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  if (typeof document !== 'object' || document === null || !('openapi' in document) || !('paths' in document)) {
    throw new Error('docs/openapi.json is not a valid OpenAPI document');
  }
  return 'OpenAPI document present; drift verification is owned by the F03 generator.';
}

function main() {
  const problems = [];
  for (const required of REQUIRED_FILES) {
    const absolutePath = path.join(ROOT, required);
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {
      problems.push(`Required file ${required} is missing or empty`);
    }
  }

  const { manifest } = loadManifest(path.join(ROOT, 'tools/phase-checks.json'));
  const manifestIds = manifest.stages.map((stage) => stage.id);
  const planIds = planStageIds();

  if (planIds.length !== manifestIds.length) {
    problems.push(
      `Plan lists ${planIds.length} stages but tools/phase-checks.json lists ${manifestIds.length}`,
    );
  }
  const mismatchIndex = planIds.findIndex((id, index) => manifestIds[index] !== id);
  if (mismatchIndex !== -1) {
    problems.push(
      `Phase order mismatch at position ${mismatchIndex + 1}: plan has ${planIds[mismatchIndex]}, manifest has ${manifestIds[mismatchIndex]}`,
    );
  }

  problems.push(...checkLocalLinks());

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`Documentation check failed with ${problems.length} problem(s).`);
    process.exitCode = 1;
    return;
  }

  const openApiStatus = checkOpenApi();
  console.log(`Documentation check passed for ${planIds.length} stages.`);
  console.log(openApiStatus);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

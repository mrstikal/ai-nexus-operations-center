import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);
const SERVER_ONLY_PACKAGES = new Set([
  'packages/ai',
  'packages/application',
  'packages/db',
  'packages/enterprise-db',
  'packages/integrations',
  'packages/messaging',
  'packages/observability',
]);
const SERVER_ONLY_EXTERNALS = [
  '@nestjs/',
  'amqplib',
  'drizzle-orm',
  'ioredis',
  'pg',
];

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--root requires a path');
      }
      root = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${argv[index]}`);
  }
  return { root };
}

function readWorkspaces(root) {
  const workspaces = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = path.join(root, group);
    if (!fs.existsSync(groupDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(groupDir, entry.name);
      const manifestPath = path.join(directory, 'package.json');
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || manifest.name === '') {
        continue;
      }
      workspaces.push({
        name: manifest.name,
        directory,
        relativeDirectory: normalizeRelative(path.relative(root, directory)),
        kind: group === 'apps' ? 'app' : 'package',
      });
    }
  }
  return workspaces;
}

function walkSourceFiles(directory, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        walkSourceFiles(path.join(directory, entry.name), result);
      }
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(path.join(directory, entry.name));
    }
  }
  return result;
}

function workspaceForPath(absolutePath, workspaces) {
  let match = null;
  for (const workspace of workspaces) {
    if (
      absolutePath === workspace.directory ||
      absolutePath.startsWith(`${workspace.directory}${path.sep}`)
    ) {
      if (!match || workspace.directory.length > match.directory.length) {
        match = workspace;
      }
    }
  }
  return match;
}

function workspaceForSpecifier(specifier, workspaces) {
  let match = null;
  for (const workspace of workspaces) {
    if (specifier === workspace.name || specifier.startsWith(`${workspace.name}/`)) {
      if (!match || workspace.name.length > match.name.length) {
        match = workspace;
      }
    }
  }
  return match;
}

function externalName(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  if (specifier.startsWith('node:')) {
    return specifier;
  }
  return specifier.split('/')[0];
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
}

function importIsTypeOnly(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) {
      return true;
    }
    if (!ts.isImportDeclaration(node)) {
      return false;
    }
    const clause = node.importClause;
    if (!clause) {
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    if (clause.name) {
      return false;
    }
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) {
      return false;
    }
    return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return node.isTypeOnly;
  }
  return false;
}

function collectImports(sourceFile) {
  const imports = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        typeOnly: importIsTypeOnly(node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({
        specifier: node.moduleReference.expression.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        typeOnly: importIsTypeOnly(node),
      });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const firstArgument = node.arguments[0];
      if (
        (isDynamicImport || isRequire) &&
        firstArgument &&
        ts.isStringLiteral(firstArgument)
      ) {
        imports.push({
          specifier: firstArgument.text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          typeOnly: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function isZodSpecifier(specifier) {
  return specifier === 'zod' || specifier.startsWith('zod/');
}

function isWorkspaceRelative(workspace, relativePath) {
  return workspace.relativeDirectory === relativePath;
}

function checkImport({ from, specifier, typeOnly, workspaces }) {
  const targetWorkspace = isRelativeSpecifier(specifier)
    ? workspaceForPath(path.resolve(path.dirname(from.file), specifier), workspaces)
    : workspaceForSpecifier(specifier, workspaces);
  const targetIsApp = targetWorkspace?.kind === 'app';
  const targetRelative = targetWorkspace?.relativeDirectory;
  const fromRelative = from.workspace.relativeDirectory;

  if (targetIsApp && targetWorkspace !== from.workspace) {
    return `workspace code must not import an application (${targetRelative})`;
  }

  if (targetRelative === 'packages/enterprise-db' && fromRelative !== 'apps/enterprise-sim') {
    return 'only apps/enterprise-sim may import packages/enterprise-db';
  }

  if (!targetWorkspace) {
    const external = externalName(specifier);
    if (isWorkspaceRelative(from.workspace, 'packages/contracts') && !isZodSpecifier(external)) {
      return 'packages/contracts may depend only on Zod';
    }
    if (
      isWorkspaceRelative(from.workspace, 'packages/domain') &&
      (external.startsWith('@nestjs/') || ['drizzle-orm', 'pg', '@nexus/ai', '@nexus/db'].includes(external))
    ) {
      return 'packages/domain must not depend on Nest, DB, or AI packages';
    }
    if (
      ['packages/ai', 'packages/integrations', 'packages/messaging', 'packages/observability'].includes(
        fromRelative,
      ) &&
      external.startsWith('@nestjs/')
    ) {
      return 'AI, integration, messaging, and observability code must use contracts and ports, not Nest controllers';
    }
    if (
      fromRelative === 'packages/application' &&
      (external.startsWith('@nestjs/') ||
        ['drizzle-orm', 'pg', '@nexus/db', '@nexus/ai', '@nexus/integrations'].includes(external))
    ) {
      return 'packages/application declares ports and must not import adapters, DB, AI, or Nest';
    }
    if (isWorkspaceRelative(from.workspace, 'packages/ui') && external.startsWith('node:')) {
      return 'packages/ui must remain browser-safe and must not import Node built-ins';
    }
    if (
      fromRelative === 'apps/web' &&
      SERVER_ONLY_EXTERNALS.some(
        (prefix) => external === prefix || (prefix.endsWith('/') && external.startsWith(prefix)),
      )
    ) {
      return 'apps/web must not import server-only adapters or secrets';
    }
    return null;
  }

  if (targetWorkspace === from.workspace) {
    return null;
  }

  if (isWorkspaceRelative(from.workspace, 'packages/contracts')) {
    return 'packages/contracts may depend only on Zod';
  }

  if (isWorkspaceRelative(from.workspace, 'packages/domain')) {
    if (targetRelative !== 'packages/contracts') {
      return 'packages/domain may depend only on packages/contracts';
    }
    return null;
  }

  if (fromRelative === 'packages/application') {
    if (targetRelative !== 'packages/contracts' && targetRelative !== 'packages/domain') {
      return 'packages/application may depend only on contracts and domain ports';
    }
    return null;
  }

  if (fromRelative === 'packages/db' && targetRelative === 'packages/application') {
    if (!typeOnly) {
      return 'packages/db may import application repository ports only through type-only imports';
    }
    return null;
  }

  if (['packages/ai', 'packages/integrations'].includes(fromRelative)) {
    if (
      !['packages/contracts', 'packages/domain', 'packages/application'].includes(targetRelative)
    ) {
      return 'AI and integrations may depend only on contracts, domain, and application ports';
    }
    return null;
  }

  if (fromRelative === 'apps/web' && SERVER_ONLY_PACKAGES.has(targetRelative)) {
    return 'apps/web must not import DB, server AI adapters, application executors, or server-only packages';
  }

  if (isWorkspaceRelative(from.workspace, 'packages/ui') && SERVER_ONLY_PACKAGES.has(targetRelative)) {
    return 'packages/ui must remain browser-safe and must not import server-only packages';
  }

  if (fromRelative === 'apps/enterprise-sim') {
    if (!['packages/contracts', 'packages/enterprise-db'].includes(targetRelative)) {
      return 'apps/enterprise-sim may depend only on contracts and enterprise-db';
    }
    return null;
  }

  return null;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(root)) {
    throw new Error(`Boundary root does not exist: ${root}`);
  }

  const workspaces = readWorkspaces(root);
  const violations = [];

  for (const workspace of workspaces) {
    const files = walkSourceFiles(workspace.directory);
    for (const file of files) {
      const sourceText = fs.readFileSync(file, 'utf8');
      const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
      for (const imported of collectImports(sourceFile)) {
        const message = checkImport({
          from: { file, workspace },
          specifier: imported.specifier,
          typeOnly: imported.typeOnly,
          workspaces,
        });
        if (message) {
          violations.push({
            file: normalizeRelative(path.relative(root, file)),
            line: imported.line,
            specifier: imported.specifier,
            message,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line} ${violation.message} (import "${violation.specifier}")`,
      );
    }
    console.error(`Dependency boundary check failed with ${violations.length} violation(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Dependency boundary check passed for ${workspaces.length} workspace(s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

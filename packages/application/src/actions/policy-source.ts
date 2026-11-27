import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PolicyBundle } from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { validatePolicyBundle } from '@nexus/domain/policies/action-validation';

export const DEFAULT_POLICY_BUNDLE_PATH = 'config/policies/northstar-v1.json';

export interface LoadedPolicyBundle {
  readonly bundle: PolicyBundle;
  readonly contentHash: string;
  readonly canonicalTextPath: string;
  readonly canonicalTextHash: string;
}

export interface PolicyBundleSource {
  load(): Promise<LoadedPolicyBundle>;
}

export interface FilePolicyBundleSourceOptions {
  readonly root?: string;
  readonly bundlePath?: string;
  readonly cache?: boolean;
}

export function createFilePolicySource(
  options: FilePolicyBundleSourceOptions = {},
): PolicyBundleSource {
  const root = options.root ?? process.cwd();
  const bundlePath = path.resolve(
    root,
    options.bundlePath ?? DEFAULT_POLICY_BUNDLE_PATH,
  );
  const cacheEnabled = options.cache ?? true;
  let cached: Promise<LoadedPolicyBundle> | null = null;
  return {
    load(): Promise<LoadedPolicyBundle> {
      if (!cacheEnabled) {
        return loadPolicyFiles(bundlePath);
      }
      if (!cached) {
        cached = loadPolicyFiles(bundlePath);
      }
      return cached;
    },
  };
}

async function loadPolicyFiles(bundlePath: string): Promise<LoadedPolicyBundle> {
  const bundleText = await readFile(bundlePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleText);
  } catch {
    throw new Error('Policy bundle is not valid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { revision?: unknown }).revision !== 'string' ||
    typeof (parsed as { canonicalText?: unknown }).canonicalText !== 'object' ||
    (parsed as { canonicalText: { path?: unknown } }).canonicalText === null ||
    typeof (parsed as { canonicalText: { path?: unknown } }).canonicalText.path !==
      'string'
  ) {
    throw new Error('Policy bundle shape is invalid');
  }
  const canonicalTextPath = path.resolve(
    path.dirname(bundlePath),
    '..',
    '..',
    (parsed as { canonicalText: { path: string } }).canonicalText.path,
  );
  const canonicalBytes = await readFile(canonicalTextPath);
  const canonicalTextHash = createHash('sha256')
    .update(canonicalBytes)
    .digest('hex');
  const bundle = validatePolicyBundle(parsed, canonicalTextHash);
  return {
    bundle,
    contentHash: canonicalJsonSha256(bundle),
    canonicalTextPath: bundle.canonicalText.path,
    canonicalTextHash,
  };
}

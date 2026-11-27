import { createHash } from 'node:crypto';
import type { ModelRole } from '@nexus/contracts';
import { classifyPromptV1 } from './classify/v1.js';
import { extractPromptV1 } from './extract/v1.js';
import { visionPromptV1 } from './vision/v1.js';
import { embedPromptV1 } from './embed/v1.js';
import { analysePromptV1 } from './analyse/v1.js';
import { verifyPromptV1 } from './verify/v1.js';
import { writePromptV1 } from './write/v1.js';

export interface PromptDefinition {
  readonly role: ModelRole;
  readonly version: string;
  readonly instructions: string;
}

export interface ResolvedPrompt extends PromptDefinition {
  /** SHA-256 of the exact trusted instruction text. */
  readonly contentHash: string;
}

const PROMPTS: Record<ModelRole, PromptDefinition> = {
  classify: classifyPromptV1,
  extract: extractPromptV1,
  vision: visionPromptV1,
  embed: embedPromptV1,
  analyse: analysePromptV1,
  verify: verifyPromptV1,
  write: writePromptV1,
};

export function promptContentHash(prompt: PromptDefinition): string {
  return createHash('sha256').update(prompt.instructions, 'utf8').digest('hex');
}

export function resolvePrompt(
  role: ModelRole,
  version: string,
): ResolvedPrompt | null {
  const prompt = PROMPTS[role];
  if (!prompt || prompt.version !== version) {
    return null;
  }
  return { ...prompt, contentHash: promptContentHash(prompt) };
}

export function listPromptVersions(): Record<ModelRole, string> {
  return {
    classify: promptContentHash(classifyPromptV1),
    extract: promptContentHash(extractPromptV1),
    vision: promptContentHash(visionPromptV1),
    embed: promptContentHash(embedPromptV1),
    analyse: promptContentHash(analysePromptV1),
    verify: promptContentHash(verifyPromptV1),
    write: promptContentHash(writePromptV1),
  };
}

export {
  classifyPromptV1,
  extractPromptV1,
  visionPromptV1,
  embedPromptV1,
  analysePromptV1,
  verifyPromptV1,
  writePromptV1,
};

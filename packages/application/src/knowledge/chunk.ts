import { createHash } from 'node:crypto';
import type { KnowledgeChunkLocator } from '@nexus/contracts';
import { KnowledgeValidationError } from './errors.js';

export const KNOWLEDGE_CHUNK_TARGET_TOKENS = 600;
export const KNOWLEDGE_CHUNK_OVERLAP_TOKENS = 80;
export const KNOWLEDGE_CHUNK_MAX_TOKENS = 1200;
export const KNOWLEDGE_SOURCE_MAX_BYTES = 1_048_576;

export interface KnowledgeChunkDraft {
  readonly index: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly locator: KnowledgeChunkLocator;
  readonly charCount: number;
  readonly tokenCount: number;
  readonly contentSha256: string;
}

interface Section {
  readonly headingPath: readonly string[];
  readonly start: number;
  readonly end: number;
}

interface Token {
  readonly codePointStart: number;
  readonly codePointEnd: number;
}

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu;

function codePointOffsets(text: string): number[] {
  const offsets = new Array<number>(text.length + 1);
  let codePoint = 0;
  let index = 0;
  while (index < text.length) {
    offsets[index] = codePoint;
    const code = text.codePointAt(index);
    const width = code !== undefined && code > 0xffff ? 2 : 1;
    index += width;
    codePoint += 1;
  }
  offsets[text.length] = codePoint;
  return offsets;
}

function sectionsOf(text: string): Section[] {
  const headings: Array<{
    readonly level: number;
    readonly title: string;
    readonly start: number;
    readonly end: number;
  }> = [];
  for (const match of text.matchAll(HEADING_PATTERN)) {
    const start = match.index ?? 0;
    headings.push({
      level: match[1]!.length,
      title: match[2]!.trim(),
      start,
      end: start + match[0].length,
    });
  }
  const sections: Section[] = [];
  const stack: Array<{ readonly level: number; readonly title: string }> = [];
  const firstHeading = headings[0];
  if (firstHeading && firstHeading.start > 0) {
    const prelude = text.slice(0, firstHeading.start);
    if (/\S/u.test(prelude)) {
      sections.push({ headingPath: [], start: 0, end: firstHeading.start });
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop();
    }
    stack.push({ level: heading.level, title: heading.title });
    const next = headings[index + 1];
    const end = next ? next.start : text.length;
    if (end > heading.start && /\S/u.test(text.slice(heading.start, end))) {
      sections.push({
        headingPath: stack.map((entry) => entry.title),
        start: heading.start,
        end,
      });
    }
  }
  if (sections.length === 0 && /\S/u.test(text)) {
    sections.push({ headingPath: [], start: 0, end: text.length });
  }
  return sections;
}

function tokensOf(
  text: string,
  section: Section,
  offsets: readonly number[],
): Token[] {
  const sectionText = text.slice(section.start, section.end);
  const tokens: Token[] = [];
  for (const match of sectionText.matchAll(/\S+/gu)) {
    const start = section.start + (match.index ?? 0);
    const end = start + match[0].length;
    tokens.push({
      codePointStart: offsets[start]!,
      codePointEnd: offsets[end]!,
    });
  }
  return tokens;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function chunkKnowledgeText(input: {
  readonly sourcePath: string;
  readonly text: string;
}): KnowledgeChunkDraft[] {
  const { text, sourcePath } = input;
  if (!/\S/u.test(text)) {
    throw new KnowledgeValidationError('Knowledge source contains no text');
  }
  const offsets = codePointOffsets(text);
  const codePoints = Array.from(text);
  const chunks: KnowledgeChunkDraft[] = [];
  for (const section of sectionsOf(text)) {
    const tokens = tokensOf(text, section, offsets);
    if (tokens.length === 0) {
      continue;
    }
    let start = 0;
    while (start < tokens.length) {
      const end = Math.min(start + KNOWLEDGE_CHUNK_TARGET_TOKENS, tokens.length);
      const first = tokens[start]!;
      const last = tokens[end - 1]!;
      const chunkText = codePoints
        .slice(first.codePointStart, last.codePointEnd)
        .join('');
      const tokenCount = end - start;
      if (tokenCount > KNOWLEDGE_CHUNK_MAX_TOKENS) {
        throw new KnowledgeValidationError(
          'Knowledge chunk exceeds the maximum token count',
        );
      }
      chunks.push({
        index: chunks.length,
        headingPath: section.headingPath,
        text: chunkText,
        locator: {
          sourcePath,
          headingPath: [...section.headingPath],
          startOffset: first.codePointStart,
          endOffset: last.codePointEnd,
        },
        charCount: [...chunkText].length,
        tokenCount,
        contentSha256: hashText(chunkText),
      });
      if (end >= tokens.length) {
        break;
      }
      const next = end - KNOWLEDGE_CHUNK_OVERLAP_TOKENS;
      start = next > start ? next : end;
    }
  }
  if (chunks.length === 0) {
    throw new KnowledgeValidationError('Knowledge source produced no chunks');
  }
  return chunks;
}

export function sliceKnowledgeText(
  text: string,
  locator: { readonly startOffset: number; readonly endOffset: number },
): string {
  return Array.from(text)
    .slice(locator.startOffset, locator.endOffset)
    .join('');
}

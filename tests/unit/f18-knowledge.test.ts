import { describe, expect, it } from 'vitest';
import {
  chunkKnowledgeText,
  sliceKnowledgeText,
} from '@nexus/application/knowledge/chunk';

function words(count: number, prefix: string): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(4, '0')}`,
  ).join(' ');
}

describe('F18 deterministic knowledge chunking', () => {
  it('splits by section with a 600-token target, 80-token overlap and exact locators', () => {
    const text = [
      '# Guide',
      '',
      'intro line',
      '',
      '## Section A',
      '',
      words(600, 'alpha'),
      '',
      '## Section B',
      '',
      'quokka logistics note',
      '',
    ].join('\n');
    const chunks = chunkKnowledgeText({
      sourcePath: 'fixtures/knowledge/support-guide.md',
      text,
    });
    expect(chunks).toHaveLength(4);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ['Guide'],
      ['Guide', 'Section A'],
      ['Guide', 'Section A'],
      ['Guide', 'Section B'],
    ]);
    expect(chunks[1]!.tokenCount).toBe(600);
    expect(chunks[2]!.tokenCount).toBe(83);
    const firstTokens = chunks[1]!.text.split(/\s+/u);
    const secondTokens = chunks[2]!.text.split(/\s+/u);
    expect(secondTokens.slice(0, 80)).toEqual(firstTokens.slice(-80));
    for (const chunk of chunks) {
      expect(chunk.locator.sourcePath).toBe('fixtures/knowledge/support-guide.md');
      expect(sliceKnowledgeText(text, chunk.locator)).toBe(chunk.text);
      expect(chunk.tokenCount).toBeLessThanOrEqual(600);
      expect(chunk.charCount).toBe([...chunk.text].length);
    }
  });

  it('keeps code-point offsets for non-BMP source text', () => {
    const text = '# Unicode\n\n𝟙𝟚𝟛 quokka logistics\n';
    const chunks = chunkKnowledgeText({
      sourcePath: 'fixtures/knowledge/support-guide.md',
      text,
    });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(sliceKnowledgeText(text, chunk.locator)).toBe(chunk.text);
    expect(chunk.locator.startOffset).toBe(0);
    expect(chunk.locator.endOffset).toBe([...text.trimEnd()].length);
  });

  it('rejects a source with no text', () => {
    expect(() =>
      chunkKnowledgeText({
        sourcePath: 'fixtures/knowledge/support-guide.md',
        text: ' \n\n ',
      }),
    ).toThrow(/no text/u);
  });
});

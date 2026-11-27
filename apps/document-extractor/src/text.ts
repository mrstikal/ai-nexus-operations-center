import {
  DOCUMENT_PARSER_VERSION,
  type DocumentExtractionResult,
} from '@nexus/contracts';
import {
  ExtractorRejection,
  buildPage,
  countNonWhitespace,
} from './validate.js';

export function extractText(input: {
  readonly bytes: Buffer;
  readonly jobToken: string;
}): DocumentExtractionResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    throw new ExtractorRejection('MALFORMED', 'Text document is not valid UTF-8');
  }
  if (text.includes('\u0000')) {
    throw new ExtractorRejection('MALFORMED', 'Text document contains NUL bytes');
  }
  const page = buildPage(1, text);
  const hasContent = countNonWhitespace(page.text) > 0;
  return {
    jobToken: input.jobToken,
    parserVersion: DOCUMENT_PARSER_VERSION,
    format: 'text',
    status: hasContent ? 'ready' : 'needs_review',
    reasonCode: hasContent ? null : 'NO_TEXT',
    pageCount: 1,
    pages: [page],
    attachments: [],
  };
}

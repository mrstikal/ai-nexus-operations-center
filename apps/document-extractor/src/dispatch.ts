import {
  DOCUMENT_PARSER_VERSION,
  type DocumentExtractionResult,
  type DocumentMediaType,
} from '@nexus/contracts';
import { extractDigitalPdf } from './digital-pdf.js';
import { extractEmail } from './email.js';
import { extractText } from './text.js';

export interface ExtractionInput {
  readonly jobToken: string;
  readonly mediaType: DocumentMediaType;
  readonly bytes: Buffer;
}

export function ocrRequiredResult(
  jobToken: string,
  format: DocumentExtractionResult['format'],
): DocumentExtractionResult {
  return {
    jobToken,
    parserVersion: DOCUMENT_PARSER_VERSION,
    format,
    status: 'needs_review',
    reasonCode: 'OCR_REQUIRED',
    pageCount: 1,
    pages: [{ page: 1, text: '', charCount: 0 }],
    attachments: [],
  };
}

export function formatFor(
  mediaType: DocumentMediaType,
): DocumentExtractionResult['format'] {
  if (mediaType === 'application/pdf') {
    return 'digital_pdf';
  }
  if (mediaType === 'message/rfc822') {
    return 'email';
  }
  return mediaType === 'text/plain' ? 'text' : 'image';
}

export async function dispatch(
  input: ExtractionInput,
): Promise<DocumentExtractionResult> {
  switch (input.mediaType) {
    case 'application/pdf':
      return extractDigitalPdf(input);
    case 'message/rfc822':
      return extractEmail(input);
    case 'text/plain':
      return extractText(input);
    case 'image/png':
    case 'image/jpeg':
      return ocrRequiredResult(input.jobToken, 'image');
    default:
      throw new Error('Unsupported document media type');
  }
}

import { createHash } from 'node:crypto';
import {
  DOCUMENT_MEDIA_TYPES,
  DOCUMENT_TEXT_DENSITY_MIN_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_FILENAME_LENGTH,
  MAX_EXTRACTED_PAGES,
  MAX_PAGE_TEXT_CHARS,
  type DocumentExtractionResult,
  type DocumentMediaType,
  type ExtractionReasonCode,
  type ExtractedAttachment,
  type ExtractedPage,
} from '@nexus/contracts';

export class ExtractorRejection extends Error {
  constructor(
    readonly reasonCode: ExtractionReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractorRejection';
  }
}

export function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return [...normalized]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code === 0 ||
        (code <= 31 && code !== 9 && code !== 10 && code !== 13) ||
        code === 127
      );
    })
    .join('');
}

export function countNonWhitespace(value: string): number {
  return [...value].filter((character) => !/\s/u.test(character)).length;
}

export function buildPage(pageNumber: number, value: string): ExtractedPage {
  const text = normalizeText(value);
  const charCount = [...text].length;
  if (charCount > MAX_PAGE_TEXT_CHARS) {
    throw new ExtractorRejection(
      'TEXT_LIMIT',
      `Page ${pageNumber} exceeds the ${MAX_PAGE_TEXT_CHARS} character limit`,
    );
  }
  return { page: pageNumber, text, charCount };
}

export function validatePages(
  pages: ExtractedPage[],
  pageCount: number,
): ExtractedPage[] {
  if (pageCount < 1 || pageCount > MAX_EXTRACTED_PAGES) {
    throw new ExtractorRejection(
      'PAGE_LIMIT',
      `Document has ${pageCount} pages; the limit is ${MAX_EXTRACTED_PAGES}`,
    );
  }
  if (pages.length !== pageCount) {
    throw new ExtractorRejection(
      'MALFORMED',
      'Extracted page count does not match the document page count',
    );
  }
  const ordered = [...pages].sort((left, right) => left.page - right.page);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.page !== index + 1) {
      throw new ExtractorRejection(
        'MALFORMED',
        'Extracted pages are not contiguous',
      );
    }
  }
  return ordered;
}

export function hasInsufficientText(pages: ExtractedPage[]): boolean {
  return pages.some(
    (page) => countNonWhitespace(page.text) < DOCUMENT_TEXT_DENSITY_MIN_CHARS,
  );
}

export function validateDocumentResult(
  result: DocumentExtractionResult,
): DocumentExtractionResult {
  if (result.pages.some((page) => page.charCount !== [...page.text].length)) {
    throw new ExtractorRejection('MALFORMED', 'Page text length mismatch');
  }
  for (const attachment of result.attachments) {
    validateAttachment(attachment);
  }
  return result;
}

export function validateAttachment(attachment: ExtractedAttachment): ExtractedAttachment {
  if (!DOCUMENT_MEDIA_TYPES.includes(attachment.mediaType)) {
    throw new ExtractorRejection(
      'UNSUPPORTED_ATTACHMENT',
      'Attachment media type is not allowed',
    );
  }
  if (
    attachment.sizeBytes < 1 ||
    attachment.sizeBytes > MAX_DOCUMENT_BYTES ||
    attachment.filename.length < 1 ||
    attachment.filename.length > MAX_DOCUMENT_FILENAME_LENGTH ||
    !/^[a-f0-9]{64}$/.test(attachment.sha256)
  ) {
    throw new ExtractorRejection('ATTACHMENT_LIMIT', 'Attachment metadata is invalid');
  }
  const content = Buffer.from(attachment.contentBase64, 'base64');
  if (content.length !== attachment.sizeBytes) {
    throw new ExtractorRejection('MALFORMED', 'Attachment size does not match its bytes');
  }
  if (sha256Hex(content) !== attachment.sha256) {
    throw new ExtractorRejection('MALFORMED', 'Attachment hash does not match its bytes');
  }
  return attachment;
}

export function extensionMediaType(filename: string): DocumentMediaType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (lower.endsWith('.eml')) {
    return 'message/rfc822';
  }
  if (lower.endsWith('.txt')) {
    return 'text/plain';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  return null;
}

export function sanitizeAttachmentFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[/\\]+/g, '_').replace(/^\.+/, '');
  const cleaned = [...trimmed]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  return (cleaned === '' ? 'attachment' : cleaned).slice(
    0,
    MAX_DOCUMENT_FILENAME_LENGTH,
  );
}

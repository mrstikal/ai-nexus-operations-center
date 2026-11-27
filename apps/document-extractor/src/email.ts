import {
  DOCUMENT_PARSER_VERSION,
  MAX_DOCUMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS,
  type DocumentExtractionResult,
  type ExtractedAttachment,
} from '@nexus/contracts';
import { simpleParser } from 'mailparser';
import {
  ExtractorRejection,
  buildPage,
  countNonWhitespace,
  extensionMediaType,
  sanitizeAttachmentFilename,
  sha256Hex,
} from './validate.js';

export async function extractEmail(input: {
  readonly bytes: Buffer;
  readonly jobToken: string;
}): Promise<DocumentExtractionResult> {
  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  try {
    parsed = await simpleParser(input.bytes, {
      skipImageLinks: true,
      skipTextToHtml: true,
    });
  } catch {
    throw new ExtractorRejection('MALFORMED', 'Email message could not be parsed');
  }

  const body = typeof parsed.text === 'string' ? parsed.text : '';
  const page = buildPage(1, body);
  const attachments: ExtractedAttachment[] = [];
  let reasonCode: DocumentExtractionResult['reasonCode'] = null;

  if (countNonWhitespace(page.text) === 0) {
    reasonCode = 'NO_TEXT';
  }

  for (const attachment of parsed.attachments) {
    if (attachments.length >= MAX_EMAIL_ATTACHMENTS) {
      reasonCode = 'ATTACHMENT_LIMIT';
      break;
    }
    const filename = sanitizeAttachmentFilename(attachment.filename ?? 'attachment');
    const mediaType = extensionMediaType(filename);
    const content = attachment.content;
    if (
      mediaType === null ||
      content.length < 1 ||
      content.length > MAX_DOCUMENT_BYTES
    ) {
      reasonCode = 'UNSUPPORTED_ATTACHMENT';
      continue;
    }
    attachments.push({
      filename,
      mediaType,
      sizeBytes: content.length,
      sha256: sha256Hex(content),
      contentBase64: content.toString('base64'),
    });
  }

  return {
    jobToken: input.jobToken,
    parserVersion: DOCUMENT_PARSER_VERSION,
    format: 'email',
    status: reasonCode === null ? 'ready' : 'needs_review',
    reasonCode,
    pageCount: 1,
    pages: [page],
    attachments,
  };
}

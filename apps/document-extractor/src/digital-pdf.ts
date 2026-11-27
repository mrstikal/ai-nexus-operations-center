import {
  DOCUMENT_PARSER_VERSION,
  MAX_EXTRACTED_PAGES,
  type DocumentExtractionResult,
  type ExtractedPage,
} from '@nexus/contracts';
import {
  ExtractorRejection,
  buildPage,
  hasInsufficientText,
  validatePages,
} from './validate.js';

const MAX_PAGE_PIXELS = 40_000_000;

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PasswordException'
  );
}

function isMalformedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return (
    name === 'InvalidPDFException' ||
    name === 'MissingPDFException' ||
    name === 'UnexpectedResponseException' ||
    name === 'FormatError'
  );
}

export async function extractDigitalPdf(input: {
  readonly bytes: Buffer;
  readonly jobToken: string;
}): Promise<DocumentExtractionResult> {
  const trailer = input.bytes
    .subarray(Math.max(0, input.bytes.length - 8192))
    .toString('latin1');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(trailer)) {
    throw new ExtractorRejection('ENCRYPTED', 'Encrypted PDFs are rejected');
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let task: ReturnType<typeof pdfjs.getDocument> | null = null;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      stopAtErrors: false,
      maxImageSize: MAX_PAGE_PIXELS,
      verbosity: 0,
    });
    const document = await task.promise;
    if (document.numPages > MAX_EXTRACTED_PAGES) {
      throw new ExtractorRejection(
        'PAGE_LIMIT',
        `Document has ${document.numPages} pages; the limit is ${MAX_EXTRACTED_PAGES}`,
      );
    }
    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.width * viewport.height > MAX_PAGE_PIXELS
      ) {
        throw new ExtractorRejection(
          'PIXEL_LIMIT',
          `Page ${pageNumber} exceeds the pixel limit`,
        );
      }
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item && typeof item.str === 'string') {
          text += item.str;
          if ('hasEOL' in item && item.hasEOL === true) {
            text += '\n';
          }
        }
      }
      page.cleanup();
      pages.push(buildPage(pageNumber, text));
    }
    const ordered = validatePages(pages, document.numPages);
    const needsReview = hasInsufficientText(ordered);
    return {
      jobToken: input.jobToken,
      parserVersion: DOCUMENT_PARSER_VERSION,
      format: 'digital_pdf',
      status: needsReview ? 'needs_review' : 'ready',
      reasonCode: needsReview ? 'OCR_REQUIRED' : null,
      pageCount: ordered.length,
      pages: ordered,
      attachments: [],
    };
  } catch (error) {
    if (error instanceof ExtractorRejection) {
      throw error;
    }
    if (isPasswordError(error)) {
      throw new ExtractorRejection('ENCRYPTED', 'Encrypted PDFs are rejected');
    }
    if (isMalformedError(error)) {
      throw new ExtractorRejection('MALFORMED', 'PDF could not be parsed');
    }
    throw new ExtractorRejection('MALFORMED', 'PDF extraction failed safely');
  } finally {
    if (task) {
      await task.destroy().catch(() => undefined);
    }
  }
}

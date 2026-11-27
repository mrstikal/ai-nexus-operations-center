import {
  DOCUMENT_PARSER_VERSION,
  DocumentExtractionResultSchema,
  EXTRACTOR_JOB_TOKEN_HEADER,
  EXTRACTOR_MEDIA_TYPE_HEADER,
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_DOCUMENT_BYTES,
  type DocumentExtractionResult,
  type DocumentMediaType,
} from '@nexus/contracts';

export const MAX_EXTRACTION_RESPONSE_BYTES =
  (MAX_ATTACHMENT_BASE64_CHARS + MAX_DOCUMENT_BYTES * 2) * 2 + 65_536;

export interface DocumentExtractionRequest {
  readonly jobToken: string;
  readonly mediaType: DocumentMediaType;
  readonly bytes: Buffer;
}

export interface DocumentExtractor {
  extract(request: DocumentExtractionRequest): Promise<DocumentExtractionResult>;
}

export class ExtractorUnavailableError extends Error {
  constructor(message = 'Document extractor is unavailable') {
    super(message);
    this.name = 'ExtractorUnavailableError';
  }
}

export class ExtractorProtocolError extends Error {
  constructor(message = 'Document extractor returned an invalid result') {
    super(message);
    this.name = 'ExtractorProtocolError';
  }
}

export class ExtractorPermanentError extends Error {
  constructor(message = 'Document extractor rejected the request') {
    super(message);
    this.name = 'ExtractorPermanentError';
  }
}

export class HttpDocumentExtractor implements DocumentExtractor {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw new Error('Extractor URL must use HTTP');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Extractor timeout must be positive');
    }
  }

  async extract(
    request: DocumentExtractionRequest,
  ): Promise<DocumentExtractionResult> {
    let response: Response;
    try {
      response = await fetch(new URL('/v1/extract', this.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(request.bytes.length),
          [EXTRACTOR_JOB_TOKEN_HEADER]: request.jobToken,
          [EXTRACTOR_MEDIA_TYPE_HEADER]: request.mediaType,
        },
        body: new Uint8Array(request.bytes),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ExtractorUnavailableError();
    }

    if (response.status === 413) {
      throw new ExtractorPermanentError(
        'Extractor rejected an oversized document',
      );
    }
    if (!response.ok) {
      throw new ExtractorUnavailableError(
        `Document extractor failed with status ${response.status}`,
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ExtractorUnavailableError(
        'Document extractor response could not be read',
      );
    }
    if (text.length > MAX_EXTRACTION_RESPONSE_BYTES) {
      throw new ExtractorProtocolError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ExtractorProtocolError();
    }
    const result = DocumentExtractionResultSchema.safeParse(parsed);
    if (!result.success) {
      throw new ExtractorProtocolError();
    }
    if (result.data.jobToken !== request.jobToken) {
      throw new ExtractorProtocolError();
    }
    if (result.data.parserVersion !== DOCUMENT_PARSER_VERSION) {
      throw new ExtractorProtocolError();
    }
    if (result.data.format !== formatFor(request.mediaType)) {
      throw new ExtractorProtocolError();
    }
    return result.data;
  }
}

function formatFor(
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

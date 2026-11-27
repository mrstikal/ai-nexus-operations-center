import {
  DOCUMENT_MEDIA_TYPES,
  DocumentMediaTypeSchema,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_FILENAME_LENGTH,
  type DocumentMediaType,
} from '@nexus/contracts';

export const DEFAULT_BLOB_ADMISSION_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_BLOB_ADMISSION_BYTES = 1024 * 1024 * 1024 * 1024;

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

export class DocumentUnsupportedMediaError extends Error {
  constructor(message = 'Unsupported document media type') {
    super(message);
    this.name = 'DocumentUnsupportedMediaError';
  }
}

export class DocumentTooLargeError extends Error {
  constructor(message = 'Document exceeds the 15 MiB size limit') {
    super(message);
    this.name = 'DocumentTooLargeError';
  }
}

export class DocumentAdmissionError extends Error {
  constructor(message = 'Blob storage admission cap exceeded') {
    super(message);
    this.name = 'DocumentAdmissionError';
  }
}

export class DocumentIdempotencyMismatchError extends Error {
  constructor(message = 'Idempotency key was reused with a different document') {
    super(message);
    this.name = 'DocumentIdempotencyMismatchError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(message = 'Document was not found') {
    super(message);
    this.name = 'DocumentNotFoundError';
  }
}

export class DocumentStorageError extends Error {
  constructor(message = 'Document storage is unavailable') {
    super(message);
    this.name = 'DocumentStorageError';
  }
}

export class DocumentConflictError extends Error {
  constructor(message = 'Document upload conflicted with another request') {
    super(message);
    this.name = 'DocumentConflictError';
  }
}

export function blobAdmissionBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['NEXUS_BLOB_ADMISSION_BYTES'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_BLOB_ADMISSION_BYTES;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_BLOB_ADMISSION_BYTES
  ) {
    throw new DocumentValidationError(
      'NEXUS_BLOB_ADMISSION_BYTES must be a positive integer below 1 TiB',
    );
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

export function sanitizeDisplayFilename(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    return 'document';
  }
  const withoutPath = trimmed
    .replace(/[/\\]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const cleaned = [...withoutPath]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('');
  const value = cleaned === '' ? 'document' : cleaned;
  return value.slice(0, MAX_DOCUMENT_FILENAME_LENGTH);
}

export function encodeContentDisposition(filename: string): string {
  const sanitized = sanitizeDisplayFilename(filename).replace(/["\\]/g, '_');
  const asciiFallback = sanitized.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(sanitized).replace(
    /['()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function extensionMediaType(filename: string): DocumentMediaType | null {
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

function detectBinaryMediaType(bytes: Buffer): DocumentMediaType | null {
  if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return 'application/pdf';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

function assertValidText(bytes: Buffer, declared: DocumentMediaType): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentValidationError('Text document is not valid UTF-8');
  }
  if (text.includes('\u0000')) {
    throw new DocumentValidationError('Text document contains NUL bytes');
  }
  if (hasControlCharacters(text)) {
    throw new DocumentValidationError('Text document contains control characters');
  }
  if (declared === 'message/rfc822') {
    const headerSection = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
    const headerLines = headerSection.split(/\r?\n/);
    const hasHeader = headerLines.some(
      (line) => /^[A-Za-z][A-Za-z0-9-]{0,77}:\s?/.test(line),
    );
    if (!hasHeader) {
      throw new DocumentValidationError(
        'Email document does not contain a valid header section',
      );
    }
  }
}

export function validateUploadBytes(input: {
  readonly declaredMediaType: string;
  readonly filename: string;
  readonly bytes: Buffer;
}): DocumentMediaType {
  if (input.bytes.length === 0) {
    throw new DocumentValidationError('Uploaded document is empty');
  }
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError();
  }
  const declared = DocumentMediaTypeSchema.safeParse(input.declaredMediaType);
  if (!declared.success) {
    throw new DocumentUnsupportedMediaError(
      `Unsupported media type; allowed types are ${DOCUMENT_MEDIA_TYPES.join(', ')}`,
    );
  }
  const detected = detectBinaryMediaType(input.bytes);
  if (detected !== null && detected !== declared.data) {
    throw new DocumentValidationError(
      'Document content signature does not match the declared media type',
    );
  }
  if (
    detected === null &&
    declared.data !== 'text/plain' &&
    declared.data !== 'message/rfc822'
  ) {
    throw new DocumentValidationError(
      'Document content signature does not match the declared media type',
    );
  }
  if (detected === null) {
    assertValidText(input.bytes, declared.data);
  }
  const fromExtension = extensionMediaType(input.filename);
  if (fromExtension !== null && fromExtension !== declared.data) {
    throw new DocumentValidationError(
      'Document filename extension does not match the declared media type',
    );
  }
  return declared.data;
}

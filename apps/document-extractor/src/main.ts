import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Worker } from 'node:worker_threads';
import {
  DOCUMENT_PARSER_VERSION,
  DocumentExtractionResultSchema,
  DocumentMediaTypeSchema,
  EXTRACTOR_JOB_TOKEN_HEADER,
  EXTRACTOR_MEDIA_TYPE_HEADER,
  MAX_DOCUMENT_BYTES,
  UuidSchema,
  type DocumentExtractionResult,
  type ExtractionReasonCode,
} from '@nexus/contracts';
import { formatFor, type ExtractionInput } from './dispatch.js';
import {
  ExtractorRejection,
  validateDocumentResult,
} from './validate.js';

class BodyTooLargeError extends Error {}

class ExtractorTimeoutError extends Error {}

interface WorkerMessage {
  readonly ok?: unknown;
  readonly kind?: unknown;
  readonly reasonCode?: unknown;
  readonly message?: unknown;
  readonly result?: unknown;
}

const DEFAULT_PORT = 8091;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CONFIGURED_BODY_BYTES = 64 * 1024 * 1024;
const WORKER_MEMORY_MB = 256;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function portValue(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : DEFAULT_PORT;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rejectedResult(
  jobToken: string,
  format: DocumentExtractionResult['format'],
  reasonCode: ExtractionReasonCode,
): DocumentExtractionResult {
  return {
    jobToken,
    parserVersion: DOCUMENT_PARSER_VERSION,
    format,
    status: 'rejected',
    reasonCode,
    pageCount: 1,
    pages: [{ page: 1, text: '', charCount: 0 }],
    attachments: [],
  };
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendProblem(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(response, status, { status, message });
}

function runExtraction(
  input: ExtractionInput,
  timeoutMs: number,
): Promise<DocumentExtractionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    });
    let settled = false;
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      if (!settled) {
        finish();
        reject(new ExtractorTimeoutError());
      }
    }, timeoutMs);
    worker.once('message', (message: WorkerMessage) => {
      if (settled) {
        return;
      }
      try {
        if (message.ok === true) {
          const parsed = DocumentExtractionResultSchema.parse(message.result);
          resolve(validateDocumentResult(parsed));
        } else if (message.kind === 'rejection' && typeof message.reasonCode === 'string') {
          reject(
            new ExtractorRejection(
              message.reasonCode as ExtractionReasonCode,
              typeof message.message === 'string'
                ? message.message
                : 'Document was rejected',
            ),
          );
        } else {
          reject(new Error('Extraction failed safely'));
        }
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error('Extraction failed safely'),
        );
      } finally {
        finish();
      }
    });
    worker.once('error', () => {
      if (!settled) {
        finish();
        reject(new Error('Extraction failed safely'));
      }
    });
    worker.once('exit', (code) => {
      if (!settled) {
        finish();
        reject(
          code === 0
            ? new Error('Extraction worker exited without a result')
            : new Error('Extraction failed safely'),
        );
      }
    });
  });
}

export interface ExtractorOptions {
  readonly port: number;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export function createExtractorServer(options: ExtractorOptions) {
  return createServer((request, response) => {
    void handle(request, response, options);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ExtractorOptions,
): Promise<void> {
  if (request.method === 'GET' && request.url === '/healthz') {
    sendJson(response, 200, {
      status: 'ok',
      parserVersion: DOCUMENT_PARSER_VERSION,
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/extract') {
    sendProblem(response, 404, 'Not found');
    return;
  }

  const jobToken = headerValue(request, EXTRACTOR_JOB_TOKEN_HEADER);
  const mediaTypeValue = headerValue(request, EXTRACTOR_MEDIA_TYPE_HEADER);
  if (!jobToken || !UuidSchema.safeParse(jobToken).success) {
    sendProblem(response, 400, 'A UUID job token header is required');
    return;
  }
  const mediaType = DocumentMediaTypeSchema.safeParse(mediaTypeValue);
  if (!mediaType.success) {
    sendProblem(response, 415, 'Unsupported document media type');
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readBody(request, options.maxBodyBytes);
  } catch (error) {
    sendProblem(
      response,
      error instanceof BodyTooLargeError ? 413 : 400,
      error instanceof BodyTooLargeError
        ? 'Document exceeds the extractor body limit'
        : 'Document body could not be read',
    );
    return;
  }
  if (bytes.length === 0) {
    sendProblem(response, 400, 'Document body is empty');
    return;
  }

  try {
    const result = await runExtraction(
      { jobToken, mediaType: mediaType.data, bytes },
      options.timeoutMs,
    );
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof ExtractorTimeoutError) {
      sendProblem(response, 504, 'Extraction timed out');
      return;
    }
    if (error instanceof ExtractorRejection) {
      sendJson(
        response,
        200,
        rejectedResult(jobToken, formatFor(mediaType.data), error.reasonCode),
      );
      return;
    }
    sendProblem(response, 500, 'Extraction failed safely');
  }
}

function main(): void {
  const port = portValue(process.env['PORT']);
  const timeoutMs = positiveInteger(
    process.env['NEXUS_EXTRACTOR_TIMEOUT_MS'],
    DEFAULT_TIMEOUT_MS,
  );
  const configuredMaxBody = positiveInteger(
    process.env['NEXUS_EXTRACTOR_MAX_BODY_BYTES'],
    MAX_DOCUMENT_BYTES,
  );
  const maxBodyBytes = Math.min(configuredMaxBody, MAX_CONFIGURED_BODY_BYTES);
  const server = createExtractorServer({ port, timeoutMs, maxBodyBytes });
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const actualPort =
      address !== null && typeof address === 'object' ? address.port : port;
    console.log(`NEXUS_EXTRACTOR_READY port=${actualPort}`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();

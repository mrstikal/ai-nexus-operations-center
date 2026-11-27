import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, Pool as PgPoolType } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_PARSER_VERSION,
  DocumentReadyPayloadSchema,
  type DocumentMediaType,
} from '@nexus/contracts';
import {
  FileBlobStore,
} from '@nexus/application/documents/blob-store';
import {
  HttpDocumentExtractor,
  type DocumentExtractionRequest,
  type DocumentExtractor,
} from '@nexus/application/documents/extractor-client';
import {
  DocumentProcessingService,
  type DocumentProcessingStore,
} from '@nexus/application/documents/processing';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import { createDocumentProcessingStore } from '@nexus/db/repositories/document-processing';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const extractorEntry = path.join(root, 'apps/document-extractor/dist/main.js');
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const ADMISSION_BYTES = 5 * 1024 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F16`);
  }
  return value;
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SpawnedExtractor {
  readonly url: string;
  stop(): Promise<void>;
}

async function startExtractor(options?: {
  readonly timeoutMs?: number;
}): Promise<SpawnedExtractor> {
  if (!existsSync(extractorEntry)) {
    throw new Error('Compiled extractor is missing; run pnpm build first');
  }
  const child: ChildProcess = spawn(process.execPath, [extractorEntry], {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: tmpdir(),
      NODE_ENV: 'test',
      PORT: '0',
      NEXUS_EXTRACTOR_TIMEOUT_MS: String(options?.timeoutMs ?? 30_000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 15_000;
  let url = '';
  while (Date.now() < deadline) {
    const match = /NEXUS_EXTRACTOR_READY port=(\d+)/.exec(stdout);
    if (match) {
      url = `http://127.0.0.1:${match[1]}`;
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`Extractor exited early. stderr: ${stderr}`);
    }
    await delay(50);
  }
  if (url === '') {
    child.kill('SIGKILL');
    throw new Error(`Extractor did not become ready. stderr: ${stderr}`);
  }
  return {
    url,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
    },
  };
}

let superuser: Client;
let workerPool: PgPoolType;
let store: DocumentProcessingStore;
let blobs: FileBlobStore;
let blobRoot: string;
let extractor: SpawnedExtractor;
let timeoutExtractor: SpawnedExtractor;
let trapServer: Server;
let trapOrigin: string;
const trapHits: string[] = [];

class CountingExtractor implements DocumentExtractor {
  calls = 0;
  constructor(private readonly inner: DocumentExtractor) {}
  async extract(request: DocumentExtractionRequest) {
    this.calls += 1;
    return this.inner.extract(request);
  }
}

function serviceFor(extractorClient: DocumentExtractor): DocumentProcessingService {
  return new DocumentProcessingService(store, blobs, extractorClient, {
    ownerId: `f16-test-${randomUUID()}`,
    leaseMs: 10_000,
    heartbeatMs: 1_000,
    retryDelayMs: 1,
    parserVersion: DOCUMENT_PARSER_VERSION,
  });
}

function blobPath(storageKey: string): string {
  return path.join(blobRoot, 'blobs', storageKey.slice(0, 2), storageKey);
}

async function dbAll<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await superuser.query(text, values);
  return result.rows as T[];
}

async function dbOne<T>(text: string, values: unknown[] = []): Promise<T> {
  const rows = await dbAll<T>(text, values);
  const row = rows[0];
  if (!row) {
    throw new Error('Expected one database row');
  }
  return row;
}

interface SeededDocument {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly jobId: string;
  readonly sha256: string;
}

async function seedDocument(input: {
  readonly fixture: string;
  readonly mediaType: DocumentMediaType;
  readonly filename: string;
  readonly bytes?: Buffer;
}): Promise<SeededDocument> {
  const bytes =
    input.bytes ??
    readFileSync(path.join(root, 'fixtures', input.fixture));
  const digest = sha256Hex(bytes);
  const documentId = randomUUID();
  const documentVersionId = randomUUID();
  const jobId = randomUUID();
  const existingBlob = await dbAll<{ id: string; storage_key: string }>(
    `SELECT id, storage_key
     FROM nexus.blobs
     WHERE sandbox_id = $1 AND sha256 = $2 AND state = 'available'
     LIMIT 1`,
    [SANDBOX_ID, digest],
  );
  let blobId = existingBlob[0]?.id;
  if (!blobId) {
    blobId = randomUUID();
    const storageKey = randomUUID();
    mkdirSync(path.dirname(blobPath(storageKey)), { recursive: true });
    writeFileSync(blobPath(storageKey), bytes);
    await superuser.query(
      `INSERT INTO nexus.blobs (
         id, sandbox_id, sha256, size_bytes, media_type, storage_key, state, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'available', clock_timestamp())`,
      [blobId, SANDBOX_ID, digest, bytes.length, input.mediaType, storageKey],
    );
  }
  await superuser.query(
    `INSERT INTO nexus.documents (id, sandbox_id, case_id, status, version, created_at, updated_at)
     VALUES ($1, $2, NULL, 'uploaded', 1, clock_timestamp(), clock_timestamp())`,
    [documentId, SANDBOX_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.document_versions (
       id, sandbox_id, document_id, version_no, blob_id, filename, media_type,
       size_bytes, sha256, status, page_count, parser_version, created_at
     ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 'uploaded', NULL, NULL, clock_timestamp())`,
    [
      documentVersionId,
      SANDBOX_ID,
      documentId,
      blobId,
      input.filename,
      input.mediaType,
      bytes.length,
      digest,
    ],
  );
  await superuser.query(
    `INSERT INTO nexus.extraction_jobs (
       id, sandbox_id, document_version_id, state, attempt_count, max_attempts,
       available_at, lease_owner, lease_expires_at, last_error, version, created_at, updated_at
     ) VALUES ($1, $2, $3, 'pending', 0, 3, clock_timestamp(), NULL, NULL, NULL, 0,
               clock_timestamp(), clock_timestamp())`,
    [jobId, SANDBOX_ID, documentVersionId],
  );
  return { documentId, documentVersionId, jobId, sha256: digest };
}

async function versionStatus(documentVersionId: string): Promise<{
  status: string;
  page_count: number | null;
  parser_version: string | null;
}> {
  return dbOne(
    `SELECT status, page_count, parser_version
     FROM nexus.document_versions
     WHERE sandbox_id = $1 AND id = $2`,
    [SANDBOX_ID, documentVersionId],
  );
}

async function pageTexts(documentVersionId: string): Promise<
  Array<{ page_no: number; text: string; char_count: number }>
> {
  return dbAll(
    `SELECT page_no, text, char_count
     FROM nexus.document_page_texts
     WHERE sandbox_id = $1 AND document_version_id = $2
     ORDER BY page_no ASC`,
    [SANDBOX_ID, documentVersionId],
  );
}

async function jobState(jobId: string): Promise<{
  state: string;
  attempt_count: number;
  last_error: string | null;
}> {
  return dbOne(
    `SELECT state, attempt_count, last_error
     FROM nexus.extraction_jobs
     WHERE id = $1`,
    [jobId],
  );
}

async function readyEvents(): Promise<
  Array<{ aggregate_id: string; payload: unknown }>
> {
  return dbAll(
    `SELECT aggregate_id, payload
     FROM nexus.event_outbox
     WHERE event_type = 'nexus.document.ready.v1'
     ORDER BY created_at ASC`,
  );
}

beforeAll(async () => {
  blobRoot = mkdtempSync(path.join(tmpdir(), 'nexus-f16-blobs-'));
  superuser = new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
    password: requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    application_name: 'f16-extraction-test',
    connectionTimeoutMillis: 5000,
  });
  await superuser.connect();
  const migrator = new PgClient({
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
    password: requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    application_name: 'f16-migrator',
    connectionTimeoutMillis: 5000,
  });
  await migrator.connect();
  try {
    await applyMigrations(migrator, {
      schema: 'nexus',
      migrations: loadMigrations(path.join(root, 'packages/db/migrations')),
    });
  } finally {
    await migrator.end();
  }
  workerPool = createNexusPool('worker', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_WORKER_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_WORKER_USER'),
    NEXUS_WORKER_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_WORKER_PASSWORD'),
  });
  store = createDocumentProcessingStore(createNexusDb(workerPool), {
    blobAdmissionBytes: ADMISSION_BYTES,
  });
  blobs = new FileBlobStore({ root: blobRoot });
  extractor = await startExtractor();
  timeoutExtractor = await startExtractor({ timeoutMs: 1 });

  trapServer = createServer((request, response) => {
    trapHits.push(request.url ?? '');
    response.statusCode = 200;
    response.end('trap');
  });
  await new Promise<void>((resolve) => {
    trapServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = trapServer.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('Trap server did not bind');
  }
  trapOrigin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await extractor?.stop();
  await timeoutExtractor?.stop();
  await new Promise<void>((resolve) => {
    if (trapServer) {
      trapServer.close(() => resolve());
    } else {
      resolve();
    }
  });
  await workerPool?.end();
  await superuser?.end();
  rmSync(blobRoot, { recursive: true, force: true });
}, 60_000);

afterEach(() => {
  trapHits.length = 0;
});

beforeEach(async () => {
  rmSync(path.join(blobRoot, 'blobs'), { recursive: true, force: true });
  rmSync(path.join(blobRoot, 'quarantine'), { recursive: true, force: true });
  await superuser.query(
    `TRUNCATE TABLE
       nexus.document_attachments,
       nexus.document_page_texts,
       nexus.document_extraction_cache,
       nexus.document_uploads,
       nexus.extraction_jobs,
       nexus.document_versions,
       nexus.documents,
       nexus.blobs,
       nexus.event_outbox,
       nexus.audit_events
     CASCADE`,
  );
  await superuser.query(
    `UPDATE nexus.blob_storage_state SET used_bytes = 0, updated_at = clock_timestamp()`,
  );
});

function injectTrap(bytes: Buffer): Buffer {
  return Buffer.from(
    bytes.toString('latin1').split('http://127.0.0.1:9').join(trapOrigin),
    'latin1',
  );
}

function utf16BeHex(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    throw new Error('Empty character');
  }
  if (codePoint <= 0xffff) {
    return codePoint.toString(16).padStart(4, '0').toUpperCase();
  }
  const offset = codePoint - 0x10000;
  const high = 0xd800 + (offset >> 10);
  const low = 0xdc00 + (offset & 0x3ff);
  return `${high.toString(16).padStart(4, '0')}${low
    .toString(16)
    .padStart(4, '0')}`.toUpperCase();
}

// Builds a one-page PDF whose text uses an Identity-H Type0 font with a
// ToUnicode map, so it can carry characters outside the Basic Multilingual
// Plane without embedding a font program.
function buildPdfWithText(text: string): Buffer {
  const characters = [...text];
  const cids = characters.map((_, index) =>
    (index + 1).toString(16).padStart(4, '0'),
  );
  const bfchars = cids
    .map((cid, index) => `<${cid}> <${utf16BeHex(characters[index]!)}>`)
    .join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${cids.length} beginbfchar
${bfchars}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const content = `BT /F1 12 Tf 100 700 Td <${cids.join('')}> Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Emoji /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Emoji /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /Emoji /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('F16 isolated digital extraction', () => {
  it('extracts digital PDF page text, locators, audit and one ready event', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'supplier-notice.pdf',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');

    const status = await versionStatus(seeded.documentVersionId);
    expect(status).toEqual({
      status: 'ready',
      page_count: 2,
      parser_version: DOCUMENT_PARSER_VERSION,
    });
    const pages = await pageTexts(seeded.documentVersionId);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.page_no).toBe(1);
    expect(pages[0]?.text).toContain('SUPPLIER DELAY NOTICE');
    expect(pages[0]?.text).toContain('PO-2026-0001');
    expect(pages[0]?.char_count).toBe([...pages[0]!.text].length);
    expect(pages[1]?.text).toContain('AFFECTED LINE ITEMS');

    expect(await jobState(seeded.jobId)).toMatchObject({
      state: 'succeeded',
      attempt_count: 1,
    });
    const events = await readyEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.aggregate_id).toBe(seeded.documentId);
    expect(DocumentReadyPayloadSchema.parse(events[0]?.payload)).toEqual({
      documentId: seeded.documentId,
      documentVersionId: seeded.documentVersionId,
      contentHash: seeded.sha256,
    });
    const audit = await dbOne<{ action: string; after_hash: string | null }>(
      `SELECT action, after_hash
       FROM nexus.audit_events
       WHERE target_id = $1
       ORDER BY sequence DESC
       LIMIT 1`,
      [seeded.documentId],
    );
    expect(audit.action).toBe('document.extracted');
    expect(audit.after_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extracts UTF-8 text into a single ready page', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'supplier-delay.txt',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');
    const pages = await pageTexts(seeded.documentVersionId);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain('Purchase order PO-2026-0001');
    expect(await readyEvents()).toHaveLength(1);
  });

  it('stores bounded email attachments through the intake tables', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/email/po-delay.eml',
      mediaType: 'message/rfc822',
      filename: 'po-delay.eml',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');

    const parentStatus = await versionStatus(seeded.documentVersionId);
    expect(parentStatus.status).toBe('ready');
    const attachments = await dbAll<{
      filename: string;
      media_type: string;
      sha256: string;
      size_bytes: string;
      attachment_document_version_id: string;
      document_id: string;
      state: string;
    }>(
      `SELECT a.filename, a.media_type, a.sha256, a.size_bytes::text,
              a.attachment_document_version_id, v.document_id, j.state
       FROM nexus.document_attachments a
       JOIN nexus.document_versions v
         ON v.sandbox_id = a.sandbox_id AND v.id = a.attachment_document_version_id
       JOIN nexus.extraction_jobs j
         ON j.sandbox_id = v.sandbox_id AND j.document_version_id = v.id
       WHERE a.sandbox_id = $1 AND a.parent_document_version_id = $2
       ORDER BY a.filename ASC`,
      [SANDBOX_ID, seeded.documentVersionId],
    );
    expect(attachments.map((attachment) => attachment.filename)).toEqual([
      'delivery-notes.txt',
      'supplier-notice.pdf',
    ]);
    expect(attachments.every((attachment) => attachment.state === 'pending')).toBe(true);
    expect(attachments[1]?.sha256).toBe(
      sha256Hex(readFileSync(path.join(root, 'fixtures/documents/digital/supplier-notice.pdf'))),
    );
    expect(await readyEvents()).toHaveLength(1);

    // Child documents have their own queued jobs and are extracted on a later poll.
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('idle');
    const childStatuses = await dbAll<{ status: string }>(
      `SELECT status FROM nexus.document_versions
       WHERE sandbox_id = $1 AND id = ANY($2::uuid[])`,
      [SANDBOX_ID, attachments.map((attachment) => attachment.attachment_document_version_id)],
    );
    expect(childStatuses).toHaveLength(2);
    expect(childStatuses.every((row) => row.status === 'ready')).toBe(true);
    expect(await readyEvents()).toHaveLength(3);
  });

  it('keeps injection email inert, skips disallowed attachments and never fetches URLs', async () => {
    const bytes = injectTrap(
      readFileSync(path.join(root, 'fixtures/security/inject-email.eml')),
    );
    const seeded = await seedDocument({
      fixture: 'security/inject-email.eml',
      mediaType: 'message/rfc822',
      filename: 'inject-email.eml',
      bytes,
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('needs_review');

    const status = await versionStatus(seeded.documentVersionId);
    expect(status.status).toBe('needs_review');
    const pages = await pageTexts(seeded.documentVersionId);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain('Plain text invoice summary');
    expect(pages[0]?.text).not.toContain('<script');
    const attachmentCount = await dbOne<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM nexus.document_attachments
       WHERE sandbox_id = $1 AND parent_document_version_id = $2`,
      [SANDBOX_ID, seeded.documentVersionId],
    );
    expect(attachmentCount.count).toBe(0);
    expect(await readyEvents()).toHaveLength(0);
    await delay(200);
    expect(trapHits).toEqual([]);
  });

  it('reads injected PDF text without executing actions or fetching URLs', async () => {
    const bytes = injectTrap(
      readFileSync(path.join(root, 'fixtures/security/inject-pdf.pdf')),
    );
    const seeded = await seedDocument({
      fixture: 'security/inject-pdf.pdf',
      mediaType: 'application/pdf',
      filename: 'inject-pdf.pdf',
      bytes,
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');
    const pages = await pageTexts(seeded.documentVersionId);
    expect(pages[0]?.text).toContain('INJECTION TEST DOCUMENT');
    expect(await readyEvents()).toHaveLength(1);
    await delay(200);
    expect(trapHits).toEqual([]);
  });

  it('rejects encrypted and malformed PDFs with typed outcomes and no ready event', async () => {
    const encrypted = await seedDocument({
      fixture: 'documents/digital/encrypted.pdf',
      mediaType: 'application/pdf',
      filename: 'encrypted.pdf',
    });
    const malformed = await seedDocument({
      fixture: 'documents/digital/malformed.pdf',
      mediaType: 'application/pdf',
      filename: 'malformed.pdf',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('rejected');
    expect(await service.processNext()).toBe('rejected');

    expect((await versionStatus(encrypted.documentVersionId)).status).toBe('rejected');
    expect((await versionStatus(malformed.documentVersionId)).status).toBe('rejected');
    expect(await pageTexts(encrypted.documentVersionId)).toEqual([]);
    expect(await readyEvents()).toHaveLength(0);
    const reasons = await dbAll<{ reason_code: string }>(
      `SELECT reason_code FROM nexus.document_extraction_cache
       WHERE sandbox_id = $1
       ORDER BY reason_code ASC`,
      [SANDBOX_ID],
    );
    expect(reasons.map((row) => row.reason_code)).toEqual([
      'ENCRYPTED',
      'MALFORMED',
    ]);
    expect((await jobState(encrypted.jobId)).state).toBe('failed');
    expect((await jobState(malformed.jobId)).state).toBe('failed');
  });

  it('marks a scanned page needs_review with OCR_REQUIRED and never ready', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/scan-empty.pdf',
      mediaType: 'application/pdf',
      filename: 'scan-empty.pdf',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('needs_review');
    const status = await versionStatus(seeded.documentVersionId);
    expect(status.status).toBe('needs_review');
    const pages = await pageTexts(seeded.documentVersionId);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toBe('');
    expect(await readyEvents()).toHaveLength(0);
    const cache = await dbOne<{ status: string; reason_code: string }>(
      `SELECT status, reason_code FROM nexus.document_extraction_cache
       WHERE sandbox_id = $1 AND source_document_version_id = $2`,
      [SANDBOX_ID, seeded.documentVersionId],
    );
    expect(cache).toEqual({ status: 'needs_review', reason_code: 'OCR_REQUIRED' });
  });

  it('retries after an extractor timeout, then succeeds with the healthy parser', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'supplier-notice.pdf',
    });
    const timedOut = serviceFor(new HttpDocumentExtractor(timeoutExtractor.url, 30_000));
    expect(await timedOut.processNext()).toBe('failed');
    expect(await jobState(seeded.jobId)).toMatchObject({
      state: 'pending',
      attempt_count: 1,
    });
    expect((await versionStatus(seeded.documentVersionId)).status).toBe('uploaded');
    expect(await pageTexts(seeded.documentVersionId)).toEqual([]);

    const healthy = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await healthy.processNext()).toBe('completed');
    expect(await pageTexts(seeded.documentVersionId)).toHaveLength(2);
    expect(await readyEvents()).toHaveLength(1);
  });

  it('retries after the extractor process is killed', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'supplier-delay.txt',
    });
    const killed = await startExtractor();
    const failing = serviceFor(new HttpDocumentExtractor(killed.url, 10_000));
    await killed.stop();
    expect(await failing.processNext()).toBe('failed');
    expect((await jobState(seeded.jobId)).state).toBe('pending');

    const healthy = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await healthy.processNext()).toBe('completed');
    expect(await pageTexts(seeded.documentVersionId)).toHaveLength(1);
  });

  it('reclaims an expired lease without duplicating page text or ready events', async () => {
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'supplier-notice.pdf',
    });
    const crashed = await store.claimJob('crashed-worker', 100);
    expect(crashed?.jobId).toBe(seeded.jobId);
    await delay(200);

    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('idle');
    expect(await pageTexts(seeded.documentVersionId)).toHaveLength(2);
    expect(await readyEvents()).toHaveLength(1);
    expect((await jobState(seeded.jobId)).attempt_count).toBe(2);
  });

  it('reuses the cached extraction for duplicate bytes without another parser call', async () => {
    const bytes = readFileSync(
      path.join(root, 'fixtures/documents/digital/supplier-notice.pdf'),
    );
    await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'first-copy.pdf',
      bytes,
    });
    const counting = new CountingExtractor(
      new HttpDocumentExtractor(extractor.url, 30_000),
    );
    const service = serviceFor(counting);
    expect(await service.processNext()).toBe('completed');
    expect(counting.calls).toBe(1);

    const duplicate = await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'second-copy.pdf',
      bytes,
    });
    expect(await service.processNext()).toBe('completed');
    expect(counting.calls).toBe(1);
    expect(await pageTexts(duplicate.documentVersionId)).toHaveLength(2);
    expect(await readyEvents()).toHaveLength(2);
  });

  it('accepts non-BMP characters in text, email and PDF page text', async () => {
    const textDocument = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'emoji.txt',
      bytes: Buffer.from(
        'Supplier delay notice \u{1F600} for PO-2026-0001.\n',
        'utf8',
      ),
    });
    const emailDocument = await seedDocument({
      fixture: 'documents/email/po-delay.eml',
      mediaType: 'message/rfc822',
      filename: 'emoji.eml',
      bytes: Buffer.from(
        [
          'From: supplier@example.test',
          'To: operations@example.test',
          'Subject: Delay for PO-2026-0001',
          'Date: Mon, 02 Nov 2026 09:00:00 +0000',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          'Supplier delay notice \u{1F600} for PO-2026-0001.',
          '',
        ].join('\r\n'),
        'utf8',
      ),
    });
    const pdfText =
      'SUPPLIER\u{1F600}DELAYNOTICEPO20260001ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const pdfDocument = await seedDocument({
      fixture: 'documents/digital/supplier-notice.pdf',
      mediaType: 'application/pdf',
      filename: 'emoji.pdf',
      bytes: buildPdfWithText(pdfText),
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('completed');
    expect(await service.processNext()).toBe('idle');

    for (const seeded of [textDocument, emailDocument, pdfDocument]) {
      expect((await versionStatus(seeded.documentVersionId)).status).toBe('ready');
      const pages = await pageTexts(seeded.documentVersionId);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.text).toContain('\u{1F600}');
      expect(pages[0]?.char_count).toBe([...pages[0]!.text].length);
    }
    const events = await readyEvents();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.aggregate_id).sort()).toEqual(
      [textDocument.documentId, emailDocument.documentId, pdfDocument.documentId].sort(),
    );
  });

  it('keeps whitespace-only text and email in needs_review without a ready event', async () => {
    const textDocument = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'blank.txt',
      bytes: Buffer.from('   \n\t  \n \r\n', 'utf8'),
    });
    const emailDocument = await seedDocument({
      fixture: 'documents/email/po-delay.eml',
      mediaType: 'message/rfc822',
      filename: 'blank.eml',
      bytes: Buffer.from(
        [
          'From: supplier@example.test',
          'To: operations@example.test',
          'Subject: Empty message',
          'Date: Mon, 02 Nov 2026 09:00:00 +0000',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          '   \t ',
          ' \t  ',
          '',
        ].join('\r\n'),
        'utf8',
      ),
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('needs_review');
    expect(await service.processNext()).toBe('needs_review');

    for (const seeded of [textDocument, emailDocument]) {
      expect((await versionStatus(seeded.documentVersionId)).status).toBe('needs_review');
      const cache = await dbOne<{ status: string; reason_code: string | null }>(
        `SELECT status, reason_code FROM nexus.document_extraction_cache
         WHERE sandbox_id = $1 AND source_document_version_id = $2`,
        [SANDBOX_ID, seeded.documentVersionId],
      );
      expect(cache).toEqual({ status: 'needs_review', reason_code: 'NO_TEXT' });
    }
    expect(await readyEvents()).toHaveLength(0);
  });

  it('downgrades a ready extractor result whose pages contain only whitespace', async () => {
    class WhitespaceReadyExtractor implements DocumentExtractor {
      async extract(request: DocumentExtractionRequest) {
        return {
          jobToken: request.jobToken,
          parserVersion: DOCUMENT_PARSER_VERSION,
          format: 'text' as const,
          status: 'ready' as const,
          reasonCode: null,
          pageCount: 1,
          pages: [{ page: 1, text: ' \n\t ', charCount: 4 }],
          attachments: [],
        };
      }
    }
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'blank.txt',
      bytes: Buffer.from(' \n\t ', 'utf8'),
    });
    const service = serviceFor(new WhitespaceReadyExtractor());
    expect(await service.processNext()).toBe('needs_review');
    expect((await versionStatus(seeded.documentVersionId)).status).toBe('needs_review');
    expect(await pageTexts(seeded.documentVersionId)).toHaveLength(1);
    const cache = await dbOne<{ status: string; reason_code: string | null }>(
      `SELECT status, reason_code FROM nexus.document_extraction_cache
       WHERE sandbox_id = $1 AND source_document_version_id = $2`,
      [SANDBOX_ID, seeded.documentVersionId],
    );
    expect(cache).toEqual({ status: 'needs_review', reason_code: 'NO_TEXT' });
    expect(await readyEvents()).toHaveLength(0);
  });

  it('reschedules when the extractor response body is truncated after headers', async () => {
    const truncated = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': '4096',
        Connection: 'close',
      });
      response.write('{"jobToken":"');
      setTimeout(() => response.destroy(), 50);
    });
    await new Promise<void>((resolve) => truncated.listen(0, '127.0.0.1', resolve));
    const address = truncated.address();
    if (address === null || typeof address !== 'object') {
      truncated.close();
      throw new Error('Truncating extractor did not bind');
    }
    try {
      const seeded = await seedDocument({
        fixture: 'documents/digital/supplier-delay.txt',
        mediaType: 'text/plain',
        filename: 'supplier-delay.txt',
      });
      const service = serviceFor(
        new HttpDocumentExtractor(`http://127.0.0.1:${address.port}`, 10_000),
      );
      expect(await service.processNext()).toBe('failed');
      expect(await jobState(seeded.jobId)).toMatchObject({
        state: 'pending',
        attempt_count: 1,
      });
      expect((await versionStatus(seeded.documentVersionId)).status).toBe('uploaded');
      expect(await pageTexts(seeded.documentVersionId)).toEqual([]);

      const healthy = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
      expect(await healthy.processNext()).toBe('completed');
      expect((await versionStatus(seeded.documentVersionId)).status).toBe('ready');
    } finally {
      truncated.closeAllConnections();
      await new Promise<void>((resolve) => truncated.close(() => resolve()));
    }
  });

  it('reschedules when the extractor stalls while streaming the response body', async () => {
    const stalled = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      response.write('{"jobToken":"');
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const address = stalled.address();
    if (address === null || typeof address !== 'object') {
      stalled.close();
      throw new Error('Stalled extractor did not bind');
    }
    try {
      const seeded = await seedDocument({
        fixture: 'documents/digital/supplier-delay.txt',
        mediaType: 'text/plain',
        filename: 'supplier-delay.txt',
      });
      const service = serviceFor(
        new HttpDocumentExtractor(`http://127.0.0.1:${address.port}`, 200),
      );
      expect(await service.processNext()).toBe('failed');
      expect(await jobState(seeded.jobId)).toMatchObject({
        state: 'pending',
        attempt_count: 1,
      });
      expect((await versionStatus(seeded.documentVersionId)).status).toBe('uploaded');
      expect(await readyEvents()).toHaveLength(0);
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it('runs the extractor without database, blob or model credentials and with no forbidden imports', async () => {
    const sourceRoot = path.join(root, 'apps/document-extractor/src');
    const files = ['main.ts', 'validate.ts', 'digital-pdf.ts', 'email.ts', 'text.ts'];
    const forbidden = ['@nexus/db', '@nexus/ai', '@nexus/messaging', '@nexus/integrations', 'ioredis', 'amqplib'];
    for (const file of files) {
      const source = readFileSync(path.join(sourceRoot, file), 'utf8');
      for (const specifier of forbidden) {
        expect(source.includes(`'${specifier}`), `${file} imports ${specifier}`).toBe(false);
      }
    }
    // The spawn helper passes only PATH/HOME/NODE_ENV/PORT/extractor limits: no DB,
    // blob, enterprise or model credentials are available to the parser process.
    const seeded = await seedDocument({
      fixture: 'documents/digital/supplier-delay.txt',
      mediaType: 'text/plain',
      filename: 'supplier-delay.txt',
    });
    const service = serviceFor(new HttpDocumentExtractor(extractor.url, 30_000));
    expect(await service.processNext()).toBe('completed');
    expect((await versionStatus(seeded.documentVersionId)).status).toBe('ready');
  });
});

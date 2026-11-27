import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentValidationError,
} from './admission.js';

const KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface QuarantineResult {
  readonly quarantineKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface QuarantineWriter {
  readonly quarantineKey: string;
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<QuarantineResult>;
  abort(): Promise<void>;
}

export interface BlobStore {
  createQuarantineWriter(maxBytes: number): Promise<QuarantineWriter>;
  finalize(quarantineKey: string, storageKey: string): Promise<void>;
  discard(quarantineKey: string): Promise<void>;
  readQuarantine(quarantineKey: string, maxBytes: number): Promise<Buffer>;
  statQuarantine(quarantineKey: string): Promise<{ sizeBytes: number }>;
  openRead(storageKey: string): Promise<ReadStream>;
  stat(storageKey: string): Promise<{ sizeBytes: number }>;
  remove(storageKey: string): Promise<void>;
  listQuarantine(): Promise<string[]>;
}

export function blobRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['NEXUS_BLOB_ROOT'];
  const value =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim()
      : '.data/blobs';
  return path.resolve(value);
}

function requireKey(value: string): string {
  if (!KEY_PATTERN.test(value)) {
    throw new DocumentValidationError('Invalid blob storage identifier');
  }
  return value;
}

class FileQuarantineWriter implements QuarantineWriter {
  readonly quarantineKey: string;
  private bytes = 0;
  private closed = false;
  private readonly hash = createHash('sha256');

  constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly filePath: string,
    private readonly maxBytes: number,
  ) {
    this.quarantineKey = path.basename(filePath, '.part');
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.closed) {
      throw new DocumentStorageError('Quarantine writer is closed');
    }
    if (chunk.length === 0) {
      return;
    }
    if (this.bytes + chunk.length > this.maxBytes) {
      throw new DocumentTooLargeError();
    }
    await this.handle.write(chunk);
    this.hash.update(chunk);
    this.bytes += chunk.length;
  }

  async finish(): Promise<QuarantineResult> {
    if (this.closed) {
      throw new DocumentStorageError('Quarantine writer is closed');
    }
    this.closed = true;
    await this.handle.sync().catch(() => undefined);
    await this.handle.close();
    if (this.bytes === 0) {
      await rm(this.filePath, { force: true }).catch(() => undefined);
      throw new DocumentValidationError('Uploaded document is empty');
    }
    return {
      quarantineKey: this.quarantineKey,
      sizeBytes: this.bytes,
      sha256: this.hash.digest('hex'),
    };
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }
}

export class FileBlobStore implements BlobStore {
  private readonly root: string;
  private readonly quarantineDirectory: string;
  private readonly blobDirectory: string;

  constructor(options: { readonly root: string }) {
    this.root = path.resolve(options.root);
    this.quarantineDirectory = path.join(this.root, 'quarantine');
    this.blobDirectory = path.join(this.root, 'blobs');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FileBlobStore {
    return new FileBlobStore({ root: blobRootFromEnv(env) });
  }

  async createQuarantineWriter(maxBytes: number): Promise<QuarantineWriter> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new DocumentValidationError('Invalid quarantine byte limit');
    }
    await mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const filePath = path.join(this.quarantineDirectory, `${key}.part`);
    const handle = await open(filePath, 'wx', 0o600);
    return new FileQuarantineWriter(handle, filePath, maxBytes);
  }

  async finalize(quarantineKey: string, storageKey: string): Promise<void> {
    const source = this.quarantinePath(quarantineKey);
    const target = this.blobPath(storageKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await rename(source, target);
    } catch {
      throw new DocumentStorageError('Blob finalize failed');
    }
  }

  async discard(quarantineKey: string): Promise<void> {
    await rm(this.quarantinePath(quarantineKey), { force: true }).catch(
      () => undefined,
    );
  }

  async readQuarantine(
    quarantineKey: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const filePath = this.quarantinePath(quarantineKey);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size === 0) {
      throw new DocumentStorageError('Quarantined upload is missing');
    }
    if (info.size > maxBytes) {
      throw new DocumentTooLargeError();
    }
    return readFile(filePath);
  }

  async statQuarantine(quarantineKey: string): Promise<{ sizeBytes: number }> {
    const info = await stat(this.quarantinePath(quarantineKey)).catch(
      () => null,
    );
    if (!info) {
      throw new DocumentStorageError('Quarantined upload is missing');
    }
    return { sizeBytes: info.size };
  }

  async openRead(storageKey: string): Promise<ReadStream> {
    return createReadStream(this.blobPath(storageKey));
  }

  async stat(storageKey: string): Promise<{ sizeBytes: number }> {
    const info = await stat(this.blobPath(storageKey)).catch(() => null);
    if (!info || !info.isFile()) {
      throw new DocumentStorageError('Stored blob is missing');
    }
    return { sizeBytes: info.size };
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.blobPath(storageKey), { force: true }).catch(() => undefined);
  }

  async listQuarantine(): Promise<string[]> {
    const entries = await readdir(this.quarantineDirectory).catch(() => []);
    return entries.filter((entry) => entry.endsWith('.part'));
  }

  private quarantinePath(key: string): string {
    return path.join(this.quarantineDirectory, `${requireKey(key)}.part`);
  }

  private blobPath(key: string): string {
    const validated = requireKey(key);
    return path.join(
      this.blobDirectory,
      validated.slice(0, 2),
      validated,
    );
  }
}

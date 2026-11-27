import type { Readable } from 'node:stream';
import { PayloadTooLargeException } from '@nestjs/common';
import { MAX_DOCUMENT_BYTES } from '@nexus/contracts';
import type {
  BlobStore,
  QuarantineResult,
  QuarantineWriter,
} from '@nexus/application/documents/blob-store';
import {
  DocumentStorageError,
  DocumentTooLargeError,
} from '@nexus/application/documents/admission';

interface MulterFileLike {
  stream: Readable;
  originalname?: string;
  mimetype?: string;
  quarantineKey?: string;
}

type MulterCallback = (
  error: Error | null,
  info?: Partial<QuarantineResult>,
) => void;

export class QuarantineStorageEngine {
  constructor(private readonly store: BlobStore) {}

  async _handleFile(
    _request: unknown,
    file: MulterFileLike,
    callback: MulterCallback,
  ): Promise<void> {
    let writer: QuarantineWriter | null = null;
    try {
      writer = await this.store.createQuarantineWriter(MAX_DOCUMENT_BYTES);
      file.quarantineKey = writer.quarantineKey;
      for await (const chunk of file.stream) {
        await writer.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const result = await writer.finish();
      callback(null, result);
    } catch (error) {
      if (writer) {
        await writer.abort();
      }
      if (error instanceof DocumentTooLargeError) {
        callback(
          new PayloadTooLargeException(
            'Document exceeds the 15 MiB size limit',
          ),
        );
        return;
      }
      callback(
        error instanceof Error
          ? error
          : new DocumentStorageError('Document upload failed'),
      );
    }
  }

  _removeFile(
    _request: unknown,
    file: { quarantineKey?: string },
    callback: (error: Error | null) => void,
  ): void {
    const key = file.quarantineKey;
    if (!key) {
      callback(null);
      return;
    }
    this.store
      .discard(key)
      .then(
        () => callback(null),
        () => callback(null),
      );
  }
}

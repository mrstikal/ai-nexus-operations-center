import { parentPort, workerData } from 'node:worker_threads';
import type { DocumentMediaType } from '@nexus/contracts';
import { ExtractorRejection } from './validate.js';
import { dispatch } from './dispatch.js';

interface WorkerInput {
  readonly jobToken: string;
  readonly mediaType: DocumentMediaType;
  readonly bytes: Uint8Array;
}

if (!parentPort) {
  throw new Error('Extractor worker must run as a worker thread');
}

const input = workerData as WorkerInput;
void dispatch({
  jobToken: input.jobToken,
  mediaType: input.mediaType,
  bytes: Buffer.from(input.bytes),
})
  .then((result) => {
    parentPort?.postMessage({ ok: true, result });
  })
  .catch((error: unknown) => {
    if (error instanceof ExtractorRejection) {
      parentPort?.postMessage({
        ok: false,
        kind: 'rejection',
        reasonCode: error.reasonCode,
        message: error.message,
      });
      return;
    }
    parentPort?.postMessage({
      ok: false,
      kind: 'failure',
      message: 'Extraction failed safely',
    });
  });

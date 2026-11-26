import 'reflect-metadata';
import { createWorkerContext, WorkerStatus } from './app.js';

const app = await createWorkerContext();
const status = app.get(WorkerStatus);

const keepAlive = setInterval(() => undefined, 60000);
let stopping = false;

const stop = async (signal: string): Promise<void> => {
  if (stopping) {
    return;
  }

  stopping = true;
  console.log(`NEXUS_WORKER_STOPPING signal=${signal}`);
  clearInterval(keepAlive);
  await app.close();
  console.log('NEXUS_WORKER_STOPPED');
  process.exit(0);
};

process.on('SIGTERM', () => {
  void stop('SIGTERM');
});

process.on('SIGINT', () => {
  void stop('SIGINT');
});

console.log(`NEXUS_WORKER_READY provider=${status.provider.name} ready=${status.provider.ready}`);

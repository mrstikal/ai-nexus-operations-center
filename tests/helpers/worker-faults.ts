import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  WorkflowFaultInfo,
  WorkflowFaultPoint,
  WorkflowFaults,
} from '@nexus/application/workflows/journal';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export interface WorkerCrashPoint {
  readonly point: WorkflowFaultPoint;
  readonly stepKey?: string;
}

export interface WorkerCrashFixture {
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly points: readonly WorkerCrashPoint[];
}

export class SimulatedWorkerCrash extends Error {
  constructor(readonly point: WorkflowFaultPoint) {
    super(`Simulated worker crash at ${point}`);
    this.name = 'SimulatedWorkerCrash';
  }
}

export function loadWorkerCrashFixture(): WorkerCrashFixture {
  return JSON.parse(
    readFileSync(path.join(root, 'fixtures/failures/worker-crash.json'), 'utf8'),
  ) as WorkerCrashFixture;
}

export function createFaultController(
  points: readonly WorkerCrashPoint[],
): WorkflowFaults {
  return {
    async at(info: WorkflowFaultInfo): Promise<void> {
      const match = points.some(
        (candidate) =>
          candidate.point === info.point &&
          (candidate.stepKey === undefined || candidate.stepKey === info.stepKey),
      );
      if (match) {
        throw new SimulatedWorkerCrash(info.point);
      }
    },
  };
}

export function singleFault(
  point: WorkflowFaultPoint,
  stepKey?: string,
): WorkflowFaults {
  return createFaultController([{ point, ...(stepKey === undefined ? {} : { stepKey }) }]);
}

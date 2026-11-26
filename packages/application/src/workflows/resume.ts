import {
  RunControlResponseSchema,
  type Actor,
  type CaseStatus,
  type RunControlResponse,
  type RunResumeRequest,
  type WaitReason,
  type WorkflowStatus,
} from '@nexus/contracts';
import { caseStatusForWorkflowStatus } from '../cases/state.js';
import {
  RunControlError,
  type RunControlErrorCode,
  validateResume,
} from './waits.js';

export interface RunControlSnapshot {
  readonly runId: string;
  readonly caseId: string;
  readonly status: WorkflowStatus;
  readonly waitReason: WaitReason | null;
}

export type ControlStoreResult =
  | { readonly ok: true; readonly response: RunControlResponse }
  | { readonly ok: false; readonly code: RunControlErrorCode };

export interface ResumeRunStoreInput {
  readonly runId: string;
  readonly sandboxId: string;
  readonly actor: Actor;
  readonly request: RunResumeRequest;
  readonly requestId: string;
  readonly correlationId: string;
  readonly caseStatusAfter: CaseStatus;
}

export interface ResumeStore {
  getRunForControl(
    sandboxId: string,
    runId: string,
  ): Promise<RunControlSnapshot | null>;
  resumeRun(input: ResumeRunStoreInput): Promise<ControlStoreResult>;
}

function throwControl(code: RunControlErrorCode): never {
  throw new RunControlError(code, code);
}

export class ResumeService {
  constructor(private readonly store: ResumeStore) {}

  async resume(input: {
    readonly sandboxId: string;
    readonly runId: string;
    readonly request: RunResumeRequest;
    readonly actor: Actor;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<RunControlResponse> {
    const run = await this.store.getRunForControl(input.sandboxId, input.runId);
    if (!run) {
      throw new RunControlError('RUN_NOT_FOUND', 'Run was not found');
    }
    validateResume(run.status, run.waitReason, input.request);
    const result = await this.store.resumeRun({
      runId: input.runId,
      sandboxId: input.sandboxId,
      actor: input.actor,
      request: input.request,
      requestId: input.requestId,
      correlationId: input.correlationId,
      caseStatusAfter:
        caseStatusForWorkflowStatus('queued') ?? 'investigating',
    });
    if (!result.ok) {
      throwControl(result.code);
    }
    return RunControlResponseSchema.parse(result.response);
  }
}

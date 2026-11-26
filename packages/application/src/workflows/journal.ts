import type {
  CaseStatus,
  RunResumeCause,
  WaitReason,
  WorkflowStatus,
  WorkflowStepStatus,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type {
  RedactedOutput,
  StepExecution,
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
  WorkflowStepKind,
  WorkflowTriggerMap,
} from './definitions.js';
import type { WorkflowJobClaim, WorkflowJobState } from './leases.js';

export interface WorkflowRunSnapshot {
  readonly id: string;
  readonly sandboxId: string;
  readonly caseId: string;
  readonly triggerEventId: string;
  readonly correlationId: string;
  readonly resumeCause: RunResumeCause | null;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly status: WorkflowStatus;
  readonly ingress: Record<string, unknown>;
  readonly ingressHash: string;
  readonly waitReason: WaitReason | null;
  readonly policyRevision: string;
  readonly modelRevision: string;
  readonly configRevision: string;
  readonly promptRevision: string | null;
  readonly activeMsLimit: number;
  readonly activeMsUsed: number;
  readonly deadlineAt: Date;
  readonly cancelRequested: boolean;
  readonly version: number;
}

export interface WorkflowStepSnapshot {
  readonly id: string;
  readonly stepKey: string;
  readonly stepKind: WorkflowStepKind;
  readonly status: WorkflowStepStatus;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly output: RedactedOutput | null;
  readonly evidenceRefs: readonly string[];
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly errorClass: string | null;
}

export interface WorkflowRunContext {
  readonly run: WorkflowRunSnapshot;
  readonly steps: ReadonlyMap<string, WorkflowStepSnapshot>;
}

export interface SchedulePendingInput {
  readonly triggerMap: WorkflowTriggerMap;
  readonly registry: WorkflowDefinitionRegistry;
  readonly limit?: number;
}

export interface ScheduleOutcome {
  readonly inboxId: string;
  readonly eventId: string;
  readonly runId: string | null;
  readonly outcome: 'scheduled' | 'blocked' | 'duplicate';
}

export type JobAction = 'continue' | 'retry' | 'wait' | 'fail';

export interface CommitStepInput {
  readonly claim: WorkflowJobClaim;
  readonly context: WorkflowRunContext;
  readonly stepKey: string;
  readonly stepKind: WorkflowStepKind;
  readonly inputHash: string;
  readonly attemptNo: number;
  readonly maxAttempts: number;
  readonly outcomeStatus: 'succeeded' | 'waiting' | 'retryable_failure' | 'permanent_failure';
  readonly output: RedactedOutput | null;
  readonly outputHash: string | null;
  readonly evidenceRefs: readonly string[];
  readonly errorClass: string | null;
  readonly waitReason: WaitReason | null;
  readonly runStatusAfter: WorkflowStatus;
  readonly jobAction: JobAction;
  readonly retryAt: Date | null;
  readonly caseStatusAfter: CaseStatus;
  readonly dependencyKeys: readonly string[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly activeMs: number;
}

export interface CommitStepResult {
  readonly reused: boolean;
  readonly step: WorkflowStepSnapshot;
  readonly runStatus: WorkflowStatus;
  readonly jobState: WorkflowJobState;
}

export interface CompleteJobInput {
  readonly claim: WorkflowJobClaim;
  readonly runStatus: WorkflowStatus;
  readonly jobState: 'succeeded' | 'failed' | 'cancelled';
  readonly errorClass?: string | null;
  readonly caseStatusAfter: CaseStatus;
}

export interface CompleteJobResult {
  readonly runStatus: WorkflowStatus;
  readonly jobState: 'succeeded' | 'failed' | 'cancelled';
}

export interface WorkflowJournal {
  currentTime(): Promise<Date>;
  schedulePendingInbox(input: SchedulePendingInput): Promise<ScheduleOutcome[]>;
  claimJob(ownerId: string, leaseMs: number): Promise<WorkflowJobClaim | null>;
  heartbeat(claim: WorkflowJobClaim, leaseMs: number): Promise<boolean>;
  markRunning(claim: WorkflowJobClaim, caseStatusAfter: CaseStatus): Promise<WorkflowRunContext>;
  loadContext(claim: WorkflowJobClaim): Promise<WorkflowRunContext>;
  commitStep(input: CommitStepInput): Promise<CommitStepResult>;
  completeJob(input: CompleteJobInput): Promise<CompleteJobResult>;
  markBudgetExhausted(
    claim: WorkflowJobClaim,
    context: WorkflowRunContext,
    errorClass: string,
    caseStatusAfter: CaseStatus,
  ): Promise<void>;
  markBlocked(
    claim: WorkflowJobClaim,
    context: WorkflowRunContext,
    errorClass: string,
    caseStatusAfter: CaseStatus,
  ): Promise<void>;
}

export interface WorkflowFaultInfo {
  readonly point: WorkflowFaultPoint;
  readonly claim: WorkflowJobClaim;
  readonly stepKey?: string;
}

export type WorkflowFaultPoint =
  | 'after_claim'
  | 'before_step_commit'
  | 'after_step_commit'
  | 'after_run_complete';

export interface WorkflowFaults {
  at(info: WorkflowFaultInfo): Promise<void>;
}

export interface DependencyHash {
  readonly key: string;
  readonly outputHash: string;
}

export function computeStepInputHash(input: {
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly ingressHash: string;
  readonly stepKey: string;
  readonly dependencies: readonly DependencyHash[];
}): string {
  const dependencies = [...input.dependencies].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  return canonicalJsonSha256({
    definition: {
      name: input.definitionName,
      version: input.definitionVersion,
    },
    ingressHash: input.ingressHash,
    stepKey: input.stepKey,
    dependencies,
  });
}

export function computeOutputHash(output: RedactedOutput): string {
  return canonicalJsonSha256(output);
}

export function dependencyHashes(
  definition: WorkflowDefinition,
  stepKey: string,
  steps: ReadonlyMap<string, WorkflowStepSnapshot>,
): DependencyHash[] {
  const step = definition.steps.find((candidate) => candidate.key === stepKey);
  if (!step) {
    throw new Error(`Unknown workflow step ${stepKey}`);
  }
  return [...step.dependsOn]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => {
      const dependency = steps.get(key);
      if (!dependency || dependency.status !== 'succeeded' || dependency.outputHash === null) {
        throw new Error(`Step ${stepKey} dependency ${key} is not succeeded`);
      }
      return { key, outputHash: dependency.outputHash };
    });
}

export function dependencyOutputs(
  definition: WorkflowDefinition,
  stepKey: string,
  steps: ReadonlyMap<string, WorkflowStepSnapshot>,
): Record<string, RedactedOutput> {
  const step = definition.steps.find((candidate) => candidate.key === stepKey);
  if (!step) {
    throw new Error(`Unknown workflow step ${stepKey}`);
  }
  const outputs: Record<string, RedactedOutput> = {};
  for (const key of [...step.dependsOn].sort((left, right) => left.localeCompare(right))) {
    const dependency = steps.get(key);
    if (!dependency || dependency.status !== 'succeeded' || dependency.output === null) {
      throw new Error(`Step ${stepKey} dependency ${key} has no output`);
    }
    outputs[key] = dependency.output;
  }
  return outputs;
}

export function waitReasonFromExecution(
  execution: StepExecution,
): WaitReason | null {
  return execution.status === 'waiting' ? execution.wait : null;
}

export function evidenceRefsFromExecution(
  execution: StepExecution,
): readonly string[] {
  return execution.evidenceRefs ?? [];
}

export function outputFromExecution(
  execution: StepExecution,
): RedactedOutput | null {
  return execution.output ?? null;
}

export function errorClassFromExecution(
  execution: StepExecution,
): string | null {
  return execution.status === 'retryable_failure' ||
    execution.status === 'permanent_failure'
    ? execution.errorClass
    : null;
}

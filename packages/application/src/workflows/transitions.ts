import type {
  WorkflowStatus,
  WorkflowStepStatus,
  WaitReason,
} from '@nexus/contracts';
import type { StepExecution, WorkflowStepKind } from './definitions.js';

export const MAX_PARALLEL_STEPS = 4;
export const DEFAULT_STEP_MAX_ATTEMPTS = 3;
export const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export function workflowRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? 30_000;
}

export function maxAttemptsForKind(kind: WorkflowStepKind): number {
  return kind === 'external' ? 1 : DEFAULT_STEP_MAX_ATTEMPTS;
}

export function retryAllowedForKind(kind: WorkflowStepKind): boolean {
  return kind === 'pure' || kind === 'read';
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'budget_exhausted'
  );
}

export function workflowStatusForWait(wait: WaitReason): WorkflowStatus {
  switch (wait.kind) {
    case 'human_input':
      return 'waiting_input';
    case 'approval':
      return 'waiting_approval';
    case 'dependency':
      return 'waiting_dependency';
    case 'budget':
      return 'budget_exhausted';
  }
}

export function stepStatusForExecution(execution: StepExecution): WorkflowStepStatus {
  switch (execution.status) {
    case 'succeeded':
      return 'succeeded';
    case 'waiting':
      return 'waiting';
    case 'retryable_failure':
      return 'retryable_failure';
    case 'permanent_failure':
      return 'permanent_failure';
  }
}

const RUN_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  queued: ['running', 'blocked', 'failed', 'budget_exhausted', 'cancel_requested'],
  running: [
    'waiting_input',
    'waiting_approval',
    'waiting_dependency',
    'blocked',
    'budget_exhausted',
    'completed',
    'failed',
    'cancel_requested',
  ],
  waiting_input: ['queued', 'cancel_requested', 'failed'],
  waiting_approval: ['queued', 'cancel_requested', 'failed'],
  waiting_dependency: ['queued', 'cancel_requested', 'failed'],
  blocked: ['queued', 'cancel_requested', 'failed'],
  budget_exhausted: ['queued', 'cancel_requested', 'failed'],
  completed: [],
  failed: [],
  cancel_requested: ['cancelled', 'failed'],
  cancelled: [],
};

export function canTransitionRun(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export class WorkflowTransitionError extends Error {
  constructor(
    readonly from: WorkflowStatus,
    readonly to: WorkflowStatus,
  ) {
    super(`Workflow status cannot transition from ${from} to ${to}`);
    this.name = 'WorkflowTransitionError';
  }
}

export function assertRunTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): void {
  if (!canTransitionRun(from, to)) {
    throw new WorkflowTransitionError(from, to);
  }
}

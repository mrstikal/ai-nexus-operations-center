import type {
  CaseStatus,
  RunResumeRequest,
  WaitReason,
  WorkflowStatus,
} from '@nexus/contracts';

export const DEPENDENCY_TIMEOUT_MS = 48 * 60 * 60 * 1000;
export const DEPENDENCY_MAX_DEPTH = 1;

export type RunControlErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_TERMINAL'
  | 'ILLEGAL_WAKE'
  | 'UNSUPPORTED_CAUSE'
  | 'DUPLICATE_CANCELLATION'
  | 'RECONCILIATION_REQUIRED'
  | 'DEPENDENCY_MISMATCH'
  | 'DEPENDENCY_DEPTH_EXCEEDED'
  | 'DEPENDENCY_CHILD_TERMINAL'
  | 'CASE_TRANSITION_REJECTED';

export class RunControlError extends Error {
  constructor(
    readonly code: RunControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunControlError';
  }
}

export interface PartialEffect {
  readonly kind: string;
  readonly reference: string;
}

export interface ResumeValidation {
  readonly cause: RunResumeRequest['cause'];
}

function matchesApproval(
  wait: WaitReason,
  request: Extract<RunResumeRequest, { cause: 'approval_completed' }>,
): boolean {
  return (
    wait.kind === 'approval' &&
    wait.proposalId === request.proposalId &&
    wait.actionRevisionId === request.actionRevisionId
  );
}

export function validateResume(
  status: WorkflowStatus,
  waitReason: WaitReason | null,
  request: RunResumeRequest,
): ResumeValidation {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    throw new RunControlError('RUN_TERMINAL', 'A terminal run cannot resume');
  }
  if (request.cause === 'budget_extension') {
    throw new RunControlError(
      'UNSUPPORTED_CAUSE',
      'Budget extension is not available in this stage',
    );
  }
  if (status === 'waiting_input') {
    if (request.cause === 'human_input') {
      return { cause: request.cause };
    }
    throw new RunControlError('ILLEGAL_WAKE', 'Human wait requires human input');
  }
  if (status === 'waiting_approval') {
    if (
      request.cause === 'approval_completed' &&
      waitReason !== null &&
      matchesApproval(waitReason, request)
    ) {
      return { cause: request.cause };
    }
    throw new RunControlError('ILLEGAL_WAKE', 'Approval wait does not match');
  }
  if (status === 'waiting_dependency') {
    throw new RunControlError(
      'ILLEGAL_WAKE',
      'Dependency waits wake only from a validated child completion',
    );
  }
  throw new RunControlError('ILLEGAL_WAKE', 'Run is not in a resumable wait');
}

export function validateCancellation(status: WorkflowStatus): void {
  if (status === 'cancelled' || status === 'completed' || status === 'failed') {
    throw new RunControlError('RUN_TERMINAL', 'A terminal run cannot be cancelled');
  }
  if (status === 'cancel_requested') {
    throw new RunControlError(
      'DUPLICATE_CANCELLATION',
      'Cancellation is already requested',
    );
  }
}

export function dependencyExpiryAt(now: Date): Date {
  return new Date(now.getTime() + DEPENDENCY_TIMEOUT_MS);
}

export function dependencyOutcomeForChildStatus(
  status: CaseStatus,
): 'resolved' | 'escalated' | null {
  if (status === 'resolved') {
    return 'resolved';
  }
  if (status === 'escalated' || status === 'cancelled') {
    return 'escalated';
  }
  return null;
}

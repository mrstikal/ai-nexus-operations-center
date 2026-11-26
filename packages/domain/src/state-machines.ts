export const WORKFLOW_STATUSES = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_dependency',
  'blocked',
  'budget_exhausted',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const CASE_STATUSES = [
  'new',
  'investigating',
  'needs_input',
  'needs_approval',
  'executing',
  'resolved',
  'escalated',
  'cancelled',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'superseded',
  'expired',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'pending',
  'in_progress',
  'succeeded',
  'retryable_failure',
  'unknown',
  'permanent_failure',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const DOCUMENT_STATUSES = [
  'uploaded',
  'validating',
  'extracting',
  'needs_review',
  'ready',
  'rejected',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  queued: ['running', 'cancel_requested'],
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
  waiting_input: ['queued', 'cancel_requested'],
  waiting_approval: ['waiting_input', 'queued', 'cancel_requested'],
  waiting_dependency: ['queued', 'cancel_requested'],
  blocked: ['queued', 'cancel_requested'],
  budget_exhausted: ['queued', 'cancel_requested'],
  completed: [],
  failed: [],
  cancel_requested: ['cancelled'],
  cancelled: [],
};

export const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  new: ['investigating', 'cancelled'],
  investigating: [
    'needs_input',
    'needs_approval',
    'executing',
    'resolved',
    'escalated',
    'cancelled',
  ],
  needs_input: ['investigating', 'cancelled'],
  needs_approval: ['investigating', 'executing', 'escalated', 'cancelled'],
  executing: ['resolved', 'escalated', 'cancelled'],
  resolved: [],
  escalated: [],
  cancelled: [],
};

export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  draft: ['pending_approval', 'superseded', 'expired'],
  pending_approval: ['approved', 'rejected', 'superseded', 'expired'],
  approved: ['superseded'],
  rejected: [],
  superseded: [],
  expired: [],
};

export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: [
    'succeeded',
    'retryable_failure',
    'unknown',
    'permanent_failure',
    'cancelled',
  ],
  retryable_failure: ['in_progress', 'cancelled'],
  unknown: ['succeeded', 'permanent_failure', 'cancelled'],
  succeeded: [],
  permanent_failure: [],
  cancelled: [],
};

export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  uploaded: ['validating', 'rejected', 'failed'],
  validating: ['extracting', 'rejected', 'failed'],
  extracting: ['needs_review', 'ready', 'rejected', 'failed'],
  needs_review: ['extracting', 'ready', 'rejected', 'failed'],
  ready: [],
  rejected: [],
  failed: [],
};

export const STATE_MACHINES = {
  workflow: { statuses: WORKFLOW_STATUSES, transitions: WORKFLOW_TRANSITIONS },
  case: { statuses: CASE_STATUSES, transitions: CASE_TRANSITIONS },
  proposal: { statuses: PROPOSAL_STATUSES, transitions: PROPOSAL_TRANSITIONS },
  execution: { statuses: EXECUTION_STATUSES, transitions: EXECUTION_TRANSITIONS },
  document: { statuses: DOCUMENT_STATUSES, transitions: DOCUMENT_TRANSITIONS },
} as const;

export type StateMachineName = keyof typeof STATE_MACHINES;

export class IllegalStateTransitionError extends Error {
  constructor(
    readonly machine: StateMachineName,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${machine} transition from ${from} to ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export function canTransition(machine: StateMachineName, from: string, to: string): boolean {
  const definition = STATE_MACHINES[machine];
  const statuses = definition.statuses as readonly string[];
  if (!statuses.includes(from) || !statuses.includes(to)) {
    return false;
  }
  const transitions = definition.transitions as Record<string, readonly string[]>;
  return transitions[from]?.includes(to) === true;
}

export function assertTransition(machine: StateMachineName, from: string, to: string): void {
  if (!canTransition(machine, from, to)) {
    throw new IllegalStateTransitionError(machine, from, to);
  }
}

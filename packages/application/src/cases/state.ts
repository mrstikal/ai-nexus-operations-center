import {
  CASE_TRANSITIONS,
  type CaseStatus,
  type WorkflowStatus,
} from '@nexus/domain/state-machines';

export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = [
  'resolved',
  'escalated',
  'cancelled',
];

export function isTerminalCaseStatus(status: CaseStatus): boolean {
  return TERMINAL_CASE_STATUSES.includes(status);
}

export function caseTransitionPath(
  from: CaseStatus,
  to: CaseStatus,
): CaseStatus[] | null {
  if (from === to) {
    return [];
  }
  const queue: CaseStatus[][] = [[from]];
  const visited = new Set<CaseStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) {
      break;
    }
    const current = path[path.length - 1];
    if (!current) {
      continue;
    }
    for (const next of CASE_TRANSITIONS[current]) {
      if (visited.has(next)) {
        continue;
      }
      const nextPath = [...path, next];
      if (next === to) {
        return nextPath.slice(1);
      }
      visited.add(next);
      queue.push(nextPath);
    }
  }
  return null;
}

export function caseStatusForWorkflowStatus(
  status: WorkflowStatus,
  options: { readonly outcomeEscalated?: boolean } = {},
): CaseStatus | null {
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting_dependency':
      return 'investigating';
    case 'waiting_input':
      return 'needs_input';
    case 'waiting_approval':
      return 'needs_approval';
    case 'blocked':
      return 'investigating';
    case 'budget_exhausted':
    case 'failed':
      return 'escalated';
    case 'completed':
      return options.outcomeEscalated === true ? 'escalated' : 'resolved';
    case 'cancel_requested':
    case 'cancelled':
      return 'cancelled';
  }
}

export function caseStatusForDependencyOutcome(
  outcome: 'resolved' | 'escalated' | 'cancelled' | 'expired',
): CaseStatus {
  return outcome === 'resolved' ? 'investigating' : 'escalated';
}

export function isTerminalCaseTransition(
  from: CaseStatus,
  to: CaseStatus,
): boolean {
  return !isTerminalCaseStatus(from) && isTerminalCaseStatus(to);
}

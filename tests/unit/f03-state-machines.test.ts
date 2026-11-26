import { describe, expect, it } from 'vitest';
import {
  CASE_STATUSES as CONTRACT_CASE_STATUSES,
  ACTION_EXECUTION_STATUSES,
  ACTION_PROPOSAL_STATUSES,
  DOCUMENT_STATUSES as CONTRACT_DOCUMENT_STATUSES,
  WORKFLOW_STATUSES as CONTRACT_WORKFLOW_STATUSES,
} from '@nexus/contracts';
import {
  CASE_STATUSES,
  DOCUMENT_STATUSES,
  EXECUTION_STATUSES,
  IllegalStateTransitionError,
  PROPOSAL_STATUSES,
  WORKFLOW_STATUSES,
  assertTransition,
  canTransition,
} from '@nexus/domain/state-machines';

describe('F03 state machines', () => {
  it('keeps domain and contract status vocabularies identical', () => {
    expect([...WORKFLOW_STATUSES]).toEqual([...CONTRACT_WORKFLOW_STATUSES]);
    expect([...CASE_STATUSES]).toEqual([...CONTRACT_CASE_STATUSES]);
    expect([...PROPOSAL_STATUSES]).toEqual([...ACTION_PROPOSAL_STATUSES]);
    expect([...EXECUTION_STATUSES]).toEqual([...ACTION_EXECUTION_STATUSES]);
    expect([...DOCUMENT_STATUSES]).toEqual([...CONTRACT_DOCUMENT_STATUSES]);
  });

  it('allows the documented workflow transitions', () => {
    expect(canTransition('workflow', 'queued', 'running')).toBe(true);
    expect(canTransition('workflow', 'running', 'waiting_approval')).toBe(true);
    expect(canTransition('workflow', 'waiting_approval', 'queued')).toBe(true);
    expect(canTransition('workflow', 'running', 'cancel_requested')).toBe(true);
    expect(canTransition('workflow', 'cancel_requested', 'cancelled')).toBe(true);
    expect(canTransition('workflow', 'budget_exhausted', 'queued')).toBe(true);
  });

  it('rejects illegal and unknown workflow transitions', () => {
    expect(canTransition('workflow', 'queued', 'completed')).toBe(false);
    expect(canTransition('workflow', 'running', 'cancelled')).toBe(false);
    expect(canTransition('workflow', 'completed', 'running')).toBe(false);
    expect(canTransition('workflow', 'nonsense', 'running')).toBe(false);
    expect(() => assertTransition('workflow', 'completed', 'running')).toThrow(
      IllegalStateTransitionError,
    );
  });

  it('separates proposal approval state from execution state', () => {
    expect(canTransition('proposal', 'draft', 'pending_approval')).toBe(true);
    expect(canTransition('proposal', 'approved', 'superseded')).toBe(true);
    expect(canTransition('proposal', 'rejected', 'approved')).toBe(false);
    expect(canTransition('execution', 'pending', 'in_progress')).toBe(true);
    expect(canTransition('execution', 'unknown', 'succeeded')).toBe(true);
    expect(canTransition('execution', 'succeeded', 'in_progress')).toBe(false);
    expect(canTransition('execution', 'unknown', 'in_progress')).toBe(false);
  });

  it('rejects terminal case and document regressions', () => {
    expect(canTransition('case', 'resolved', 'investigating')).toBe(false);
    expect(canTransition('case', 'escalated', 'executing')).toBe(false);
    expect(canTransition('document', 'ready', 'validating')).toBe(false);
    expect(canTransition('document', 'failed', 'extracting')).toBe(false);
  });
});

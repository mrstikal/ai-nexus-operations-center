import { describe, expect, it } from 'vitest';
import {
  caseStatusForDependencyOutcome,
  caseStatusForWorkflowStatus,
  caseTransitionPath,
  isTerminalCaseTransition,
} from '@nexus/application/cases/state';
import { RunResumeRequestSchema } from '@nexus/contracts';
import {
  RunControlError,
  dependencyExpiryAt,
  dependencyOutcomeForChildStatus,
  validateCancellation,
  validateResume,
} from '@nexus/application/workflows/waits';

describe('F11A case reducer and wait controls', () => {
  it('builds legal case paths and refuses terminal resurrection', () => {
    expect(caseTransitionPath('new', 'resolved')).toEqual(['investigating', 'resolved']);
    expect(caseTransitionPath('needs_input', 'escalated')).toEqual([
      'investigating',
      'escalated',
    ]);
    expect(caseTransitionPath('resolved', 'cancelled')).toBeNull();
    expect(isTerminalCaseTransition('investigating', 'resolved')).toBe(true);
    expect(isTerminalCaseTransition('resolved', 'escalated')).toBe(false);
  });

  it('maps workflow and dependency states to case statuses', () => {
    expect(caseStatusForWorkflowStatus('running')).toBe('investigating');
    expect(caseStatusForWorkflowStatus('waiting_input')).toBe('needs_input');
    expect(caseStatusForWorkflowStatus('waiting_approval')).toBe('needs_approval');
    expect(caseStatusForWorkflowStatus('completed')).toBe('resolved');
    expect(caseStatusForWorkflowStatus('completed', { outcomeEscalated: true })).toBe('escalated');
    expect(caseStatusForWorkflowStatus('failed')).toBe('escalated');
    expect(caseStatusForWorkflowStatus('cancelled')).toBe('cancelled');
    expect(caseStatusForDependencyOutcome('resolved')).toBe('investigating');
    expect(caseStatusForDependencyOutcome('cancelled')).toBe('escalated');
    expect(caseStatusForDependencyOutcome('expired')).toBe('escalated');
    expect(dependencyOutcomeForChildStatus('resolved')).toBe('resolved');
    expect(dependencyOutcomeForChildStatus('cancelled')).toBe('escalated');
    expect(dependencyOutcomeForChildStatus('investigating')).toBeNull();
  });

  it('accepts only the exact wait cause and rejects unrelated wakes', () => {
    expect(
      validateResume('waiting_input', { kind: 'human_input', prompt: 'Need input' }, {
        cause: 'human_input',
      }).cause,
    ).toBe('human_input');
    expect(() =>
      validateResume('waiting_input', { kind: 'human_input', prompt: 'Need input' }, {
        cause: 'approval_completed',
        proposalId: 'p',
        actionRevisionId: 'r',
      }),
    ).toThrow(RunControlError);
    expect(() =>
      validateResume('waiting_approval', {
        kind: 'approval',
        proposalId: 'p',
        actionRevisionId: 'r',
      }, {
        cause: 'approval_completed',
        proposalId: 'other',
        actionRevisionId: 'r',
      }),
    ).toThrow(RunControlError);
    expect(() =>
      validateResume('waiting_dependency', {
        kind: 'dependency',
        childCaseId: '00000000-0000-4000-8000-000000000002',
        childTriggerEventId: '00000000-0000-4000-8000-000000000001',
      }, {
        cause: 'human_input',
      }),
    ).toThrow(RunControlError);
    expect(
      RunResumeRequestSchema.safeParse({
        cause: 'dependency_retry',
        childCaseId: '00000000-0000-4000-8000-000000000002',
        childTriggerEventId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(() =>
      validateResume('completed', null, { cause: 'human_input' }),
    ).toThrow(RunControlError);
  });

  it('rejects terminal and duplicate cancellation and uses the 48-hour dependency timeout', () => {
    expect(() => validateCancellation('waiting_input')).not.toThrow();
    expect(() => validateCancellation('cancelled')).toThrow(RunControlError);
    expect(() => validateCancellation('cancel_requested')).toThrow(RunControlError);
    const now = new Date('2026-11-26T00:00:00Z');
    expect(dependencyExpiryAt(now).getTime() - now.getTime()).toBe(
      48 * 60 * 60 * 1000,
    );
  });
});

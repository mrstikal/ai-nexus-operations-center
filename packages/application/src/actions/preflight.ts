import type { ActionPlanItem, PolicyBundle, Role } from '@nexus/contracts';
import { isPolicyAutomatic } from '@nexus/domain/policies/action-validation';
import type { ItemExecutionState } from './action-dag.js';

export type ExecutionBlockReason =
  | 'OK'
  | 'POLICY_CHANGED'
  | 'APPROVAL_EXPIRED'
  | 'NOT_APPROVED'
  | 'MISSING_DECISIONS'
  | 'AUTO_NOT_ALLOWED'
  | 'EVIDENCE_UNAVAILABLE'
  | 'EXECUTION_UNKNOWN'
  | 'CASE_TERMINAL'
  | 'NO_ITEMS';

export interface ActionExecutionSnapshot {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly proposalStatus: string;
  readonly revisionId: string;
  readonly revisionState: string;
  readonly revisionNumber: number;
  readonly items: readonly ActionPlanItem[];
  readonly planHash: string;
  readonly requiredRoles: readonly Role[];
  readonly filledRoles: readonly Role[];
  readonly policyRevision: string;
  readonly policyContentHash: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly executions: readonly ItemExecutionState[];
  readonly references: Readonly<Record<string, string>>;
  readonly caseStatus: string;
  readonly evidenceAvailable: boolean;
}

export interface ExecutionPreflight {
  readonly allowed: boolean;
  readonly reason: ExecutionBlockReason;
  readonly basis: 'human' | 'policy_auto';
}

export function evaluateExecutionPreflight(
  snapshot: ActionExecutionSnapshot,
  policy: { readonly bundle: PolicyBundle; readonly contentHash: string },
): ExecutionPreflight {
  if (snapshot.items.length === 0) {
    return { allowed: false, reason: 'NO_ITEMS', basis: 'human' };
  }
  if (
    snapshot.policyRevision !== policy.bundle.revision ||
    snapshot.policyContentHash !== policy.contentHash
  ) {
    return { allowed: false, reason: 'POLICY_CHANGED', basis: 'human' };
  }
  if (new Date(snapshot.expiresAt).getTime() <= new Date(snapshot.now).getTime()) {
    return { allowed: false, reason: 'APPROVAL_EXPIRED', basis: 'human' };
  }
  if (
    snapshot.caseStatus === 'resolved' ||
    snapshot.caseStatus === 'escalated' ||
    snapshot.caseStatus === 'cancelled'
  ) {
    return { allowed: false, reason: 'CASE_TERMINAL', basis: 'human' };
  }
  if (!snapshot.evidenceAvailable) {
    return { allowed: false, reason: 'EVIDENCE_UNAVAILABLE', basis: 'human' };
  }
  if (snapshot.executions.some((execution) => execution.state === 'unknown')) {
    return { allowed: false, reason: 'EXECUTION_UNKNOWN', basis: 'human' };
  }
  const autoNoteOnly = snapshot.items.every(
    (item) =>
      item.payload.kind === 'case.add_internal_note' &&
      isPolicyAutomatic(item.payload.kind, policy.bundle),
  );
  if (autoNoteOnly) {
    return { allowed: true, reason: 'OK', basis: 'policy_auto' };
  }
  if (
    snapshot.proposalStatus !== 'approved' ||
    snapshot.revisionState !== 'approved'
  ) {
    return { allowed: false, reason: 'NOT_APPROVED', basis: 'human' };
  }
  const missing = snapshot.requiredRoles.filter(
    (role) => !snapshot.filledRoles.includes(role),
  );
  if (snapshot.requiredRoles.length === 0 || missing.length > 0) {
    return { allowed: false, reason: 'MISSING_DECISIONS', basis: 'human' };
  }
  if (
    snapshot.items.some(
      (item) =>
        item.payload.kind === 'case.add_internal_note' &&
        !isPolicyAutomatic(item.payload.kind, policy.bundle),
    )
  ) {
    return { allowed: false, reason: 'AUTO_NOT_ALLOWED', basis: 'human' };
  }
  return { allowed: true, reason: 'OK', basis: 'human' };
}

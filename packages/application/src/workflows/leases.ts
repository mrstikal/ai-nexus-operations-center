export type WorkflowJobState =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkflowJobClaim {
  readonly jobId: string;
  readonly sandboxId: string;
  readonly runId: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly fencingToken: number;
  readonly attemptCount: number;
}

export class LeaseLostError extends Error {
  constructor(message = 'Workflow lease is no longer held by this worker') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export function isLeaseActive(claim: WorkflowJobClaim, now: Date): boolean {
  return claim.leaseExpiresAt.getTime() > now.getTime();
}

export function assertLeaseActive(claim: WorkflowJobClaim, now: Date): void {
  if (!isLeaseActive(claim, now)) {
    throw new LeaseLostError('Workflow lease expired');
  }
}

export function nextFencingToken(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('Invalid workflow fencing token');
  }
  return current + 1;
}

import {
  EnterpriseCommandRequestSchema,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandReceipt,
} from '@nexus/contracts';
import type { EnterpriseCommandPort } from '../ports/enterprise.js';
import type { PolicyBundleSource } from './policy-source.js';

export interface RecoverableAttempt {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly actionRevisionId: string;
  readonly itemId: string;
  readonly attemptNumber: number;
  readonly attemptState: string;
  readonly commandKind: string;
  readonly receiptKey: string;
  readonly planHash: string;
  readonly itemHash: string;
  readonly executeBefore: string;
  readonly authorizationValidUntil: string;
  readonly policyRevision: string;
  readonly policyContentHash: string;
  readonly payload: Record<string, unknown>;
  readonly baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[];
  readonly priorReceiptKeys: readonly string[];
}

export type ReconciliationResult = 'unknown' | 'absent_final' | 'found';

export class ReconcileError extends Error {
  constructor(
    readonly code:
      | 'ATTEMPT_NOT_FOUND'
      | 'RETRY_LIMIT'
      | 'REISSUE_NOT_ALLOWED'
      | 'REQUEST_INVALID'
      | 'RECEIPT_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'ReconcileError';
  }
}

export interface ReconciliationStore {
  findRecoverableAttempt(): Promise<RecoverableAttempt | null>;
  databaseNow(): Promise<string>;
  recordProbe(input: {
    readonly attempt: RecoverableAttempt;
    readonly result: ReconciliationResult;
    readonly dbNow: string;
    readonly detail?: string;
  }): Promise<void>;
  recordFoundReceipt(input: {
    readonly attempt: RecoverableAttempt;
    readonly receipt: EnterpriseCommandReceipt;
  }): Promise<void>;
  recordDeterministicFailure(input: {
    readonly attempt: RecoverableAttempt;
    readonly errorCode: string;
  }): Promise<void>;
  cancelAfterAbsent(input: {
    readonly attempt: RecoverableAttempt;
    readonly reason: string;
  }): Promise<void>;
  canReissue(
    attempt: RecoverableAttempt,
    policy: { readonly revision: string; readonly contentHash: string },
  ): Promise<boolean>;
  createRetryAttempt(input: {
    readonly attempt: RecoverableAttempt;
    readonly executeBefore: string;
    readonly authorizationValidUntil: string;
    readonly policy: { readonly revision: string; readonly contentHash: string };
  }): Promise<RecoverableAttempt | null>;
}

const ABSENCE_GRACE_MS = 10_000;
const RETRY_DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 3;

export class ReconcileService {
  constructor(
    private readonly store: ReconciliationStore,
    private readonly commandPort: EnterpriseCommandPort,
    private readonly policySource: PolicyBundleSource,
  ) {}

  async processOnce(): Promise<boolean> {
    const attempt = await this.store.findRecoverableAttempt();
    if (!attempt) {
      return false;
    }
    try {
      const receipt = await this.commandPort.getCommandReceipt(attempt.receiptKey, {
        sandboxId: attempt.sandboxId,
        correlationId: `reconcile-${attempt.executionId}`.slice(0, 128),
      });
      await this.store.recordFoundReceipt({ attempt, receipt });
      return true;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'UNKNOWN';
      if (code !== 'NOT_FOUND') {
        const now = await this.store.databaseNow();
        await this.store.recordProbe({
          attempt,
          result: 'unknown',
          dbNow: now,
          detail: code.slice(0, 100),
        });
        return false;
      }
    }
    const now = await this.store.databaseNow();
    const absentAfter = new Date(attempt.executeBefore).getTime() + ABSENCE_GRACE_MS;
    if (new Date(now).getTime() < absentAfter) {
      await this.store.recordProbe({
        attempt,
        result: 'unknown',
        dbNow: now,
        detail: 'absence_before_grace',
      });
      return false;
    }
    await this.store.recordProbe({
      attempt,
      result: 'absent_final',
      dbNow: now,
      detail: 'absent_after_grace',
    });
    if (attempt.attemptNumber >= MAX_ATTEMPTS) {
      await this.store.cancelAfterAbsent({ attempt, reason: 'attempt_limit' });
      return true;
    }
    let policy;
    try {
      policy = await this.policySource.load();
    } catch {
      await this.store.cancelAfterAbsent({
        attempt,
        reason: 'policy_unavailable',
      });
      return true;
    }
    if (
      attempt.policyRevision !== policy.bundle.revision ||
      attempt.policyContentHash !== policy.contentHash ||
      !(await this.store.canReissue(attempt, {
        revision: policy.bundle.revision,
        contentHash: policy.contentHash,
      }))
    ) {
      await this.store.cancelAfterAbsent({
        attempt,
        reason: 'authorization_no_longer_valid',
      });
      return true;
    }
    const executeBefore = new Date(
      Math.min(
        new Date(now).getTime() + RETRY_DEADLINE_MS,
        new Date(attempt.authorizationValidUntil).getTime(),
      ),
    );
    if (executeBefore.getTime() <= new Date(now).getTime()) {
      await this.store.cancelAfterAbsent({ attempt, reason: 'deadline_unavailable' });
      return true;
    }
    const retry = await this.store.createRetryAttempt({
      attempt,
      executeBefore: executeBefore.toISOString(),
      authorizationValidUntil: executeBefore.toISOString(),
      policy: {
        revision: policy.bundle.revision,
        contentHash: policy.contentHash,
      },
    });
    if (!retry) {
      await this.store.cancelAfterAbsent({ attempt, reason: 'retry_not_created' });
      return true;
    }
    const request = EnterpriseCommandRequestSchema.safeParse({
      sandboxId: retry.sandboxId,
      actionRevisionId: retry.actionRevisionId,
      itemId: retry.itemId,
      planHash: retry.planHash,
      itemHash: retry.itemHash,
      baseExpectedVersions: retry.baseExpectedVersions,
      payloadTemplate: retry.payload,
      priorReceiptKeys: retry.priorReceiptKeys,
      executeBefore: retry.executeBefore,
      authorizationValidUntil: retry.authorizationValidUntil,
    });
    if (!request.success) {
      await this.store.cancelAfterAbsent({ attempt: retry, reason: 'request_invalid' });
      return true;
    }
    try {
      const receipt = await this.commandPort.executeCommand(request.data, {
        sandboxId: retry.sandboxId,
        correlationId: `reconcile-retry-${retry.executionId}`.slice(0, 128),
        timeoutMs: 10_000,
      });
      await this.store.recordFoundReceipt({ attempt: retry, receipt });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'UNKNOWN';
      if (
        [
          'FORBIDDEN',
          'VALIDATION_FAILED',
          'IDEMPOTENCY_MISMATCH',
          'CONFLICT',
          'NOT_FOUND',
          'APPROVAL_EXPIRED',
          'STALE_STATE',
        ].includes(code)
      ) {
        await this.store.recordDeterministicFailure({
          attempt: retry,
          errorCode: code,
        });
        return true;
      }
      const now2 = await this.store.databaseNow();
      await this.store.recordProbe({
        attempt: retry,
        result: 'unknown',
        dbNow: now2,
        detail: code.slice(0, 100),
      });
    }
    return true;
  }
}

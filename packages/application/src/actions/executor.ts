import { createHash } from 'node:crypto';
import {
  EnterpriseCommandRequestSchema,
  receiptKeyFor,
  type ActionPlanItem,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandKind,
  type EnterpriseCommandReceipt,
  type PolicyBundle,
} from '@nexus/contracts';
import { canonicalizeEnterpriseCommandItem } from '@nexus/contracts';
import {
  BindingError,
  advanceBaseVersions,
  resolveMessagePayload,
  type EntityChange,
} from '@nexus/domain/actions/bindings';
import { computeActionItemHash } from './revision-hash.js';
import type { PolicyBundleSource } from './policy-source.js';
import {
  evaluateExecutionPreflight,
  type ActionExecutionSnapshot,
  type ExecutionPreflight,
} from './preflight.js';
import { nextRunnableItem, priorReceiptKeys } from './action-dag.js';
import type { EnterpriseCommandPort } from '../ports/enterprise.js';

export interface ExecutionCandidate {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly revisionId: string;
}

export interface ClaimedExecution {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly item: ActionPlanItem;
  readonly executionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly authorizationBasis: 'human' | 'policy_auto';
  readonly policyRevision: string;
  readonly policyContentHash: string;
  readonly planHash: string;
  readonly itemHash: string;
  readonly payload: unknown;
  readonly baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[];
  readonly priorReceiptKeys: readonly string[];
  readonly executeBefore: string;
  readonly authorizationValidUntil: string;
  readonly requestHash: string;
}

export interface CommandSuccessInput {
  readonly claimed: ClaimedExecution;
  readonly receipt: EnterpriseCommandReceipt;
}

export interface CommandFailureInput {
  readonly claimed: ClaimedExecution;
  readonly errorCode: string;
  readonly permanent: boolean;
  readonly unknown?: boolean;
}

export interface NoteSuccessInput {
  readonly claimed: ClaimedExecution;
  readonly text: string;
  readonly policyRevision: string;
  readonly policyContentHash: string;
}

export interface ActionExecutionStore {
  findCandidate(): Promise<ExecutionCandidate | null>;
  loadExecutionSnapshot(
    candidate: ExecutionCandidate,
  ): Promise<ActionExecutionSnapshot | null>;
  claimItem(input: {
    readonly candidate: ExecutionCandidate;
    readonly item: ActionPlanItem;
    readonly authorizationBasis: 'human' | 'policy_auto';
    readonly policyRevision: string;
    readonly policyContentHash: string;
    readonly currentPolicyRevision: string;
    readonly currentPolicyContentHash: string;
    readonly planHash: string;
    readonly itemHash: string;
    readonly payload: unknown;
    readonly baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[];
    readonly priorReceiptKeys: readonly string[];
    readonly executeBefore: string;
    readonly authorizationValidUntil: string;
    readonly requestHash: string;
    readonly committedMinor: string | null;
  }): Promise<ClaimedExecution | null>;
  recordCommandSuccess(input: CommandSuccessInput): Promise<void>;
  recordCommandFailure(input: CommandFailureInput): Promise<void>;
  recordNoteSuccess(input: NoteSuccessInput): Promise<void>;
  blockUnavailableEvidence(candidate: ExecutionCandidate): Promise<void>;
}

function itemHash(
  payload: unknown,
  baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[],
): string {
  return createHash('sha256')
    .update(
      canonicalizeEnterpriseCommandItem({
        payloadTemplate: payload as never,
        baseExpectedVersions,
      }),
      'utf8',
    )
    .digest('hex');
}

function commandKind(kind: string): EnterpriseCommandKind {
  if (
    kind !== 'enterprise.create_purchase_order' &&
    kind !== 'enterprise.send_message'
  ) {
    throw new Error(`Unsupported enterprise execution kind ${kind}`);
  }
  return kind;
}

function enterpriseBaseVersions(
  item: ActionPlanItem,
  changes: readonly EntityChange[],
  references: Readonly<Record<string, string>>,
): EnterpriseBaseExpectedVersion[] {
  const advanced = advanceBaseVersions(item.baseExpectedVersions, changes);
  return advanced.map((ref) => {
    const reference = references[`${ref.type}:${ref.id}`] ?? null;
    if (ref.type === 'agreement' && reference === null) {
      throw new BindingError(
        'BINDING_FORBIDDEN',
        'Agreement reference is missing from the approved evidence',
      );
    }
    return {
      system: 'enterprise' as const,
      type: ref.type as EnterpriseBaseExpectedVersion['type'],
      id: ref.id,
      reference,
      version: ref.version,
    };
  });
}

export class ActionExecutor {
  constructor(
    private readonly store: ActionExecutionStore,
    private readonly commandPort: EnterpriseCommandPort,
    private readonly policySource: PolicyBundleSource,
  ) {}

  async preflight(): Promise<{
    readonly candidate: ExecutionCandidate;
    readonly snapshot: ActionExecutionSnapshot;
    readonly preflight: ExecutionPreflight;
  } | null> {
    const candidate = await this.store.findCandidate();
    if (!candidate) {
      return null;
    }
    const snapshot = await this.store.loadExecutionSnapshot(candidate);
    if (!snapshot) {
      return null;
    }
    let policy: { bundle: PolicyBundle; contentHash: string };
    try {
      policy = await this.policySource.load();
    } catch {
      return null;
    }
    return {
      candidate,
      snapshot,
      preflight: evaluateExecutionPreflight(snapshot, policy),
    };
  }

  async processOnce(): Promise<boolean> {
    const preflight = await this.preflight();
    if (!preflight) {
      return false;
    }
    if (!preflight.preflight.allowed) {
      if (preflight.preflight.reason === 'EVIDENCE_UNAVAILABLE') {
        await this.store.blockUnavailableEvidence(preflight.candidate).catch(() => undefined);
      }
      return false;
    }
    const { candidate, snapshot } = preflight;
    const item = nextRunnableItem(snapshot.items, snapshot.executions);
    if (!item) {
      return false;
    }
    const succeeded = snapshot.executions.filter(
      (execution) => execution.state === 'succeeded' && execution.receiptKey,
    );
    const receipts: EnterpriseCommandReceipt[] = [];
    try {
      for (const execution of succeeded) {
        receipts.push(
          await this.commandPort.getCommandReceipt(execution.receiptKey as string, {
            sandboxId: snapshot.sandboxId,
            correlationId: `action-preflight-${snapshot.revisionId}`.slice(0, 128),
          }),
        );
      }
    } catch {
      return false;
    }
    const changes = receipts.flatMap((receipt) =>
      receipt.entityChanges.map((change) => ({
        entityType: change.entityType,
        entityId: change.id,
        beforeVersion: change.beforeVersion,
        afterVersion: change.afterVersion,
      })),
    );
    const priorKeys = priorReceiptKeys(snapshot.items, item, snapshot.executions);
    if (priorKeys.some((key) => !receipts.some((receipt) => receipt.idempotencyKey === key))) {
      return false;
    }
    const fresh = await this.store.loadExecutionSnapshot(candidate);
    if (!fresh) {
      return false;
    }
    let currentPolicy;
    try {
      currentPolicy = await this.policySource.load();
    } catch {
      return false;
    }
    if (
      fresh.policyRevision !== currentPolicy.bundle.revision ||
      fresh.policyContentHash !== currentPolicy.contentHash
    ) {
      return false;
    }
    const now = new Date(fresh.now);
    const expiresAt = new Date(fresh.expiresAt);
    const executeBefore = new Date(
      Math.min(now.getTime() + 30_000, expiresAt.getTime()),
    );
    if (executeBefore.getTime() <= now.getTime()) {
      return false;
    }
    if (item.payload.kind === 'case.add_internal_note') {
      const claimed = await this.store.claimItem({
        candidate,
        item,
        authorizationBasis: 'policy_auto',
        policyRevision: currentPolicy.bundle.revision,
        policyContentHash: currentPolicy.contentHash,
        currentPolicyRevision: currentPolicy.bundle.revision,
        currentPolicyContentHash: currentPolicy.contentHash,
        planHash: snapshot.planHash,
        itemHash: computeActionItemHash(item),
        payload: item.payload,
        baseExpectedVersions: [],
        priorReceiptKeys: [],
        executeBefore: expiresAt.toISOString(),
        authorizationValidUntil: expiresAt.toISOString(),
        requestHash: itemHash(item.payload, []),
        committedMinor: null,
      });
      if (!claimed) {
        return false;
      }
      await this.store.recordNoteSuccess({
        claimed,
        text: item.payload.text,
        policyRevision: snapshot.policyRevision,
        policyContentHash: snapshot.policyContentHash,
      });
      return true;
    }
    const kind = commandKind(item.payload.kind);
    let payload = item.payload;
    if (item.payload.kind === 'enterprise.send_message') {
      try {
        payload = resolveMessagePayload(
          item,
          succeeded.map((execution) => ({
            itemId: execution.itemId,
            commandKind:
              snapshot.items.find((candidateItem) => candidateItem.itemId === execution.itemId)
                ?.payload.kind ?? '',
            resultEntityType: execution.resultEntityType ?? '',
            resultEntityId: execution.resultEntityId ?? '',
            resultEntityVersion: execution.resultEntityVersion ?? 0,
          })),
        ).payload;
      } catch {
        return false;
      }
    }
    let baseVersions;
    try {
      baseVersions = enterpriseBaseVersions(item, changes, snapshot.references);
    } catch {
      return false;
    }
    const itemHashValue = itemHash(payload, baseVersions);
    const receiptKey = receiptKeyFor(
      candidate.sandboxId,
      candidate.revisionId,
      item.itemId,
      kind,
    );
    const request = EnterpriseCommandRequestSchema.safeParse({
      sandboxId: candidate.sandboxId,
      actionRevisionId: candidate.revisionId,
      itemId: item.itemId,
      planHash: snapshot.planHash,
      itemHash: itemHashValue,
      baseExpectedVersions: baseVersions,
      payloadTemplate: payload,
      priorReceiptKeys: priorKeys,
      executeBefore: executeBefore.toISOString(),
      authorizationValidUntil: executeBefore.toISOString(),
    });
    if (!request.success) {
      return false;
    }
    const claimed = await this.store.claimItem({
      candidate,
      item,
      authorizationBasis: preflight.preflight.basis,
      policyRevision: currentPolicy.bundle.revision,
      policyContentHash: currentPolicy.contentHash,
      currentPolicyRevision: currentPolicy.bundle.revision,
      currentPolicyContentHash: currentPolicy.contentHash,
      planHash: snapshot.planHash,
      itemHash: itemHashValue,
      payload,
      baseExpectedVersions: baseVersions,
      priorReceiptKeys: priorKeys,
      executeBefore: executeBefore.toISOString(),
      authorizationValidUntil: executeBefore.toISOString(),
      requestHash: createHash('sha256')
        .update(canonicalizeEnterpriseCommandItem({
          payloadTemplate: payload as never,
          baseExpectedVersions: baseVersions,
        }))
        .digest('hex'),
      committedMinor:
        item.payload.kind === 'enterprise.create_purchase_order'
          ? String(
              item.payload.lines.reduce(
                (total, line) =>
                  total + BigInt(line.quantity) * BigInt(line.unitPriceMinor),
                BigInt(item.payload.expediteChargeMinor),
              ),
            )
          : null,
    });
    if (!claimed) {
      return false;
    }
    try {
      const receipt = await this.commandPort.executeCommand(request.data, {
        sandboxId: candidate.sandboxId,
        correlationId: `action-${candidate.revisionId}-${item.itemId}`.slice(0, 128),
        timeoutMs: 10_000,
      });
      if (receipt.idempotencyKey !== receiptKey) {
        await this.store.recordCommandFailure({
          claimed,
          errorCode: 'RECEIPT_KEY_MISMATCH',
          permanent: true,
        });
        return true;
      }
      try {
        await this.store.recordCommandSuccess({ claimed, receipt });
      } catch {
        await this.store
          .recordCommandFailure({
            claimed,
            errorCode: 'LOCAL_RECEIPT_PERSISTENCE_FAILED',
            permanent: false,
            unknown: true,
          })
          .catch(() => undefined);
      }
      return true;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'UNKNOWN';
      await this.store.recordCommandFailure({
        claimed,
        errorCode: code,
        permanent: [
          'FORBIDDEN',
          'VALIDATION_FAILED',
          'IDEMPOTENCY_MISMATCH',
          'CONFLICT',
          'NOT_FOUND',
          'APPROVAL_EXPIRED',
        ].includes(code),
        unknown: [
          'TIMEOUT',
          'NETWORK',
          'ABORTED',
          'DEPENDENCY_UNAVAILABLE',
          'UNKNOWN',
          'MALFORMED_RESPONSE',
          'RESPONSE_TOO_LARGE',
          'SANDBOX_MISMATCH',
        ].includes(code),
      });
      return true;
    }
  }
}

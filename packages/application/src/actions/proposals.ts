import { randomUUID } from 'node:crypto';
import {
  ActionProposalCreateInputSchema,
  ActionProposalDetailSchema,
  ActionProposalEditInputSchema,
  ActionProposalListResponseSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
  type ActionPlanItem,
  type ActionProposalDetail,
  type ActionProposalListResponse,
  type ActionProposalStatus,
  type Actor,
  type CaseStatus,
  type Evidence,
  type PolicyBundle,
  type Role,
  type SandboxSummary,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  PolicyValidationError,
  assertActionKindEnabled,
  assertActionPlan,
  assertPlanEvidence,
  assertPlanFinancialSemantics,
  enterpriseReferencesForPayload,
} from '@nexus/domain/policies/action-validation';
import {
  computeRequiredApprovalRoles,
  isProcurementPlan,
} from '@nexus/domain/policies/approvals';
import { MoneyError, parseMinor } from '@nexus/domain/money';
import {
  SandboxInactiveError,
  SandboxUnavailableError,
  requireActiveSandbox,
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from '../cases/context.js';
import { isTerminalCaseStatus } from '../cases/state.js';
import { computePlanHash } from './revision-hash.js';
import type { LoadedPolicyBundle, PolicyBundleSource } from './policy-source.js';

export const PROPOSAL_CREATE_ROUTE = '/api/v1/cases/:caseId/proposals';

export class ProposalValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProposalValidationError';
  }
}

export class ProposalNotFoundError extends Error {
  constructor(message = 'Proposal was not found in the active sandbox') {
    super(message);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalConflictError extends Error {
  constructor(message = 'The case already has an open procurement proposal') {
    super(message);
    this.name = 'ProposalConflictError';
  }
}

export class ProposalStaleError extends Error {
  constructor(message = 'Proposal revision is no longer editable') {
    super(message);
    this.name = 'ProposalStaleError';
  }
}

export class ProposalPolicyUnavailableError extends Error {
  constructor(message = 'Policy bundle is unavailable') {
    super(message);
    this.name = 'ProposalPolicyUnavailableError';
  }
}

export class ProposalIdempotencyMismatchError extends Error {
  constructor(message = 'Idempotency key was reused with a different request body') {
    super(message);
    this.name = 'ProposalIdempotencyMismatchError';
  }
}

function isEditableProposalStatus(status: ActionProposalStatus): boolean {
  return status === 'draft' || status === 'pending_approval' || status === 'approved';
}

export interface ProposalWriteContext {
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface ProposalCaseSnapshot {
  readonly id: string;
  readonly status: CaseStatus;
  readonly version: number;
}

export interface CreateProposalStoreInput {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly planHash: string;
  readonly items: readonly ActionPlanItem[];
  readonly requiredRoles: readonly Role[];
  readonly aggregateImpactMinor: string | null;
  readonly isProcurement: boolean;
  readonly policyRevision: string;
  readonly policyContentHash: string;
  readonly rationale: string;
  readonly ttlHours: number;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface ReviseProposalStoreInput {
  readonly sandboxId: string;
  readonly proposalId: string;
  readonly expectedRevisionNumber: number;
  readonly revisionId: string;
  readonly planHash: string;
  readonly items: readonly ActionPlanItem[];
  readonly requiredRoles: readonly Role[];
  readonly aggregateImpactMinor: string | null;
  readonly isProcurement: boolean;
  readonly policyRevision: string;
  readonly policyContentHash: string;
  readonly rationale: string;
  readonly ttlHours: number;
  readonly actor: Actor;
  readonly requestId: string;
  readonly correlationId: string;
}

export type ProposalCreateStoreResult =
  | { readonly status: 'created'; readonly detail: ActionProposalDetail }
  | { readonly status: 'duplicate'; readonly detail: ActionProposalDetail }
  | {
      readonly status:
        | 'sandbox_inactive'
        | 'sandbox_unavailable'
        | 'case_not_found'
        | 'open_procurement_conflict'
        | 'idempotency_conflict'
        | 'evidence_unavailable';
    };

export type ProposalReviseStoreResult =
  | { readonly status: 'revised'; readonly detail: ActionProposalDetail }
  | {
      readonly status:
        | 'not_found'
        | 'stale'
        | 'sandbox_inactive'
        | 'sandbox_unavailable'
        | 'open_procurement_conflict'
        | 'evidence_unavailable';
    };

export interface PolicyBundleRegistration {
  readonly bundle: PolicyBundle;
  readonly contentHash: string;
  readonly canonicalTextPath: string;
  readonly canonicalTextHash: string;
}

export interface ProposalListCursor {
  readonly createdAt: string;
  readonly id: string;
}

function encodeProposalCursor(cursor: ProposalListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeProposalCursor(value: string | undefined): ProposalListCursor | null {
  if (value === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new ProposalValidationError('VALIDATION_FAILED', 'Proposal cursor is invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProposalValidationError('VALIDATION_FAILED', 'Proposal cursor is invalid');
  }
  const record = parsed as { createdAt?: unknown; id?: unknown };
  if (
    !IsoUtcTimestampSchema.safeParse(record.createdAt).success ||
    !UuidSchema.safeParse(record.id).success
  ) {
    throw new ProposalValidationError('VALIDATION_FAILED', 'Proposal cursor is invalid');
  }
  return { createdAt: record.createdAt as string, id: record.id as string };
}

export interface ProposalStore extends SandboxResolver {
  getCaseForAction(
    sandboxId: string,
    caseId: string,
  ): Promise<ProposalCaseSnapshot | null>;
  getEvidenceForAction(
    sandboxId: string,
    evidenceIds: readonly string[],
  ): Promise<Evidence[]>;
  registerPolicyBundle(input: PolicyBundleRegistration): Promise<void>;
  findIdempotentProposal(input: {
    readonly sandboxId: string;
    readonly route: string;
    readonly idempotencyKey: string;
    readonly actor: Actor;
  }): Promise<{ readonly requestHash: string; readonly detail: ActionProposalDetail } | null>;
  createProposal(
    input: CreateProposalStoreInput,
  ): Promise<ProposalCreateStoreResult>;
  getProposal(
    sandboxId: string,
    proposalId: string,
  ): Promise<ActionProposalDetail | null>;
  reviseProposal(
    input: ReviseProposalStoreInput,
  ): Promise<ProposalReviseStoreResult>;
  listProposals(
    sandboxId: string,
    caseId: string,
    limit: number,
    cursor: ProposalListCursor | null,
  ): Promise<{ readonly items: ActionProposalDetail[]; readonly hasMore: boolean }>;
}

export interface PriorCommitmentPort {
  successfulAdditionalProcurementMinor(input: {
    readonly sandboxId: string;
    readonly caseId: string;
  }): Promise<bigint>;
}

export function createEmptyPriorCommitmentPort(): PriorCommitmentPort {
  return {
    async successfulAdditionalProcurementMinor(): Promise<bigint> {
      return 0n;
    },
  };
}

interface PreparedPlan {
  readonly items: ActionPlanItem[];
  readonly requiredRoles: Role[];
  readonly aggregateImpactMinor: string | null;
  readonly isProcurement: boolean;
  readonly planHash: string;
}

interface PreparedPlanOptions {
  readonly sandbox: SandboxSummary;
  readonly caseId: string;
  readonly policy: LoadedPolicyBundle;
}

export class ProposalService {
  readonly #store: ProposalStore;
  readonly #policySource: PolicyBundleSource;
  readonly #priorCommitments: PriorCommitmentPort;

  constructor(
    store: ProposalStore,
    policySource: PolicyBundleSource,
    priorCommitments: PriorCommitmentPort = createEmptyPriorCommitmentPort(),
  ) {
    this.#store = store;
    this.#policySource = policySource;
    this.#priorCommitments = priorCommitments;
  }

  async create(
    caseId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    context: ProposalWriteContext,
  ): Promise<ActionProposalDetail> {
    if (!UuidSchema.safeParse(caseId).success) {
      throw new ProposalValidationError('VALIDATION_FAILED', 'Case id is invalid');
    }
    const parsed = ActionProposalCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProposalValidationError(
        'VALIDATION_FAILED',
        'Proposal draft is invalid',
      );
    }
    let idempotency: string;
    try {
      idempotency = UuidSchema.parse(idempotencyKey).toLowerCase();
    } catch {
      throw new ProposalValidationError(
        'VALIDATION_FAILED',
        'A valid Idempotency-Key header is required',
      );
    }
    const input = parsed.data;
    const requestHash = canonicalJsonSha256({ caseId, plan: input.plan });
    const sandbox = await this.#mutationSandbox();
    const existing = await this.#store.findIdempotentProposal({
      sandboxId: sandbox.id,
      route: PROPOSAL_CREATE_ROUTE,
      idempotencyKey: idempotency,
      actor: context.actor,
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProposalIdempotencyMismatchError();
      }
      return ActionProposalDetailSchema.parse(existing.detail);
    }
    const caseSnapshot = await this.#store.getCaseForAction(sandbox.id, caseId);
    if (!caseSnapshot) {
      throw new ProposalNotFoundError('Case was not found in the active sandbox');
    }
    if (isTerminalCaseStatus(caseSnapshot.status)) {
      throw new ProposalValidationError(
        'CASE_TERMINAL',
        'A terminal case cannot receive a new proposal',
      );
    }
    const policy = await this.#loadPolicy();
    const items = input.plan.items.map((item) => ({
      itemId: randomUUID(),
      target: item.target,
      evidenceIds: [...item.evidenceIds],
      payload: item.payload,
      dependsOnItemIds: [] as string[],
      baseExpectedVersions: [],
    }));
    const prepared = await this.#preparePlan(
      items,
      input.plan.rationale,
      { sandbox, caseId, policy },
    );
    const result = await this.#store.createProposal({
      sandboxId: sandbox.id,
      caseId,
      proposalId: randomUUID(),
      revisionId: randomUUID(),
      planHash: prepared.planHash,
      items: prepared.items,
      requiredRoles: prepared.requiredRoles,
      aggregateImpactMinor: prepared.aggregateImpactMinor,
      isProcurement: prepared.isProcurement,
      policyRevision: policy.bundle.revision,
      policyContentHash: policy.contentHash,
      rationale: input.plan.rationale,
      ttlHours: policy.bundle.approval.ttlHours,
      route: PROPOSAL_CREATE_ROUTE,
      idempotencyKey: idempotency,
      requestHash,
      actor: context.actor,
      requestId: context.requestId,
      correlationId: context.correlationId,
    });
    return this.#createResult(result);
  }

  async revise(
    proposalId: string,
    expectedRevisionNumber: number,
    body: unknown,
    context: ProposalWriteContext,
  ): Promise<ActionProposalDetail> {
    if (!UuidSchema.safeParse(proposalId).success) {
      throw new ProposalValidationError('VALIDATION_FAILED', 'Proposal id is invalid');
    }
    if (
      !Number.isInteger(expectedRevisionNumber) ||
      expectedRevisionNumber < 1 ||
      expectedRevisionNumber > 2_147_483_647
    ) {
      throw new ProposalValidationError(
        'VALIDATION_FAILED',
        'A positive If-Match revision precondition is required',
      );
    }
    const parsed = ActionProposalEditInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProposalValidationError(
        'VALIDATION_FAILED',
        'Proposal revision is invalid',
      );
    }
    const input = parsed.data;
    const sandbox = await this.#mutationSandbox();
    const current = await this.#store.getProposal(sandbox.id, proposalId);
    if (!current) {
      throw new ProposalNotFoundError();
    }
    if (!isEditableProposalStatus(current.proposal.status)) {
      throw new ProposalStaleError();
    }
    if (current.revision.revisionNumber !== expectedRevisionNumber) {
      throw new ProposalStaleError();
    }
    const existingById = new Map(
      current.revision.items.map((item) => [item.itemId, item]),
    );
    if (
      input.items.length !== existingById.size ||
      input.items.some((item) => !existingById.has(item.itemId))
    ) {
      throw new ProposalValidationError(
        'VALIDATION_FAILED',
        'A proposal edit must keep every existing item identifier',
      );
    }
    const caseSnapshot = await this.#store.getCaseForAction(
      sandbox.id,
      current.proposal.caseId,
    );
    if (!caseSnapshot) {
      throw new ProposalNotFoundError('Case was not found in the active sandbox');
    }
    if (isTerminalCaseStatus(caseSnapshot.status)) {
      throw new ProposalStaleError();
    }
    const policy = await this.#loadPolicy();
    const items = input.items.map((item) => ({
      itemId: item.itemId,
      target: item.target,
      evidenceIds: [...item.evidenceIds],
      payload: item.payload,
      dependsOnItemIds: [
        ...(existingById.get(item.itemId)?.dependsOnItemIds ?? []),
      ],
      baseExpectedVersions: [],
    }));
    const prepared = await this.#preparePlan(
      items,
      input.rationale,
      { sandbox, caseId: current.proposal.caseId, policy },
    );
    const result = await this.#store.reviseProposal({
      sandboxId: sandbox.id,
      proposalId,
      expectedRevisionNumber,
      revisionId: randomUUID(),
      planHash: prepared.planHash,
      items: prepared.items,
      requiredRoles: prepared.requiredRoles,
      aggregateImpactMinor: prepared.aggregateImpactMinor,
      isProcurement: prepared.isProcurement,
      policyRevision: policy.bundle.revision,
      policyContentHash: policy.contentHash,
      rationale: input.rationale,
      ttlHours: policy.bundle.approval.ttlHours,
      actor: context.actor,
      requestId: context.requestId,
      correlationId: context.correlationId,
    });
    return this.#reviseResult(result);
  }

  async get(
    proposalId: string,
    sandboxResolver: SandboxResolver = this.#store,
  ): Promise<ActionProposalDetail> {
    if (!UuidSchema.safeParse(proposalId).success) {
      throw new ProposalValidationError('VALIDATION_FAILED', 'Proposal id is invalid');
    }
    const sandbox = await this.#readSandbox(sandboxResolver);
    const detail = await this.#store.getProposal(sandbox.id, proposalId);
    if (!detail) {
      throw new ProposalNotFoundError();
    }
    return ActionProposalDetailSchema.parse(detail);
  }

  async list(
    caseId: string,
    limit: number,
    cursor: string | undefined,
    sandboxResolver: SandboxResolver = this.#store,
  ): Promise<ActionProposalListResponse> {
    if (!UuidSchema.safeParse(caseId).success) {
      throw new ProposalValidationError('VALIDATION_FAILED', 'Case id is invalid');
    }
    const bounded = Math.min(Math.max(limit, 1), 50);
    const parsedCursor = decodeProposalCursor(cursor);
    const sandbox = await this.#readSandbox(sandboxResolver);
    const caseSnapshot = await this.#store.getCaseForAction(sandbox.id, caseId);
    if (!caseSnapshot) {
      throw new ProposalNotFoundError('Case was not found in the active sandbox');
    }
    const result = await this.#store.listProposals(
      sandbox.id,
      caseId,
      bounded,
      parsedCursor,
    );
    const last = result.items.at(-1);
    return ActionProposalListResponseSchema.parse({
      items: result.items,
      nextCursor:
        result.hasMore && last
          ? encodeProposalCursor({
              createdAt: last.proposal.createdAt,
              id: last.proposal.id,
            })
          : null,
    });
  }

  async #mutationSandbox(): Promise<SandboxSummary> {
    try {
      return await requireActiveSandboxForMutation(this.#store);
    } catch (error) {
      if (error instanceof SandboxInactiveError || error instanceof SandboxUnavailableError) {
        throw error;
      }
      throw new SandboxUnavailableError();
    }
  }

  async #readSandbox(resolver: SandboxResolver): Promise<SandboxSummary> {
    return requireActiveSandbox(resolver);
  }

  async #loadPolicy(): Promise<LoadedPolicyBundle> {
    try {
      const policy = await this.#policySource.load();
      await this.#store.registerPolicyBundle(policy);
      return policy;
    } catch (error) {
      if (error instanceof PolicyValidationError &&
          error.code === 'POLICY_REVISION_CONFLICT') {
        throw new ProposalPolicyUnavailableError(error.message);
      }
      if (error instanceof ProposalPolicyUnavailableError) {
        throw error;
      }
      throw new ProposalPolicyUnavailableError();
    }
  }

  async #preparePlan(
    items: ActionPlanItem[],
    rationale: string,
    options: PreparedPlanOptions,
  ): Promise<PreparedPlan> {
    try {
      for (const item of items) {
        assertActionKindEnabled(item.payload.kind, options.policy.bundle);
        if (item.payload.kind === 'case.add_internal_note') {
          if (
            item.payload.caseId !== options.caseId ||
            item.target.system !== 'nexus' ||
            item.target.type !== 'case' ||
            item.target.id !== options.caseId
          ) {
            throw new PolicyValidationError(
              'ACTION_PAYLOAD_INVALID',
              'An internal note must target the proposal case',
            );
          }
        }
      }
      assertPlanEvidence(items);
      const evidenceById = await this.#loadEvidence(options.sandbox.id, items);
      this.#validateEvidenceScope(evidenceById, options.caseId);
      const withVersions = this.#bindBaseVersions(items, evidenceById);
      assertActionPlan(withVersions);
      assertPlanFinancialSemantics(withVersions);
      const prior = await this.#priorCommitments.successfulAdditionalProcurementMinor({
        sandboxId: options.sandbox.id,
        caseId: options.caseId,
      });
      const approval = computeRequiredApprovalRoles({
        items: withVersions,
        priorProcurementMinor: prior,
        financeThresholdMinor: parseMinor(
          options.policy.bundle.supplyApproval.financeThresholdMinor,
        ),
      });
      const planHash = computePlanHash({
        items: withVersions,
        policyRevision: options.policy.bundle.revision,
        policyContentHash: options.policy.contentHash,
      });
      return {
        items: withVersions,
        requiredRoles: approval.requiredRoles,
        aggregateImpactMinor:
          approval.aggregateImpact === null
            ? null
            : approval.aggregateImpact.amountMinor,
        isProcurement: isProcurementPlan(withVersions),
        planHash,
      };
    } catch (error) {
      if (error instanceof ProposalValidationError) {
        throw error;
      }
      if (error instanceof MoneyError) {
        throw new ProposalValidationError(
          'ACTION_PAYLOAD_INVALID',
          'Action money is outside the supported bounds',
        );
      }
      if (error instanceof PolicyValidationError) {
        if (
          error.code === 'POLICY_BUNDLE_INVALID' ||
          error.code === 'POLICY_THRESHOLD_WIDENED' ||
          error.code === 'POLICY_TTL_WIDENED' ||
          error.code === 'POLICY_AUTOMATION_INVALID'
        ) {
          throw new ProposalPolicyUnavailableError(error.message);
        }
        throw new ProposalValidationError(error.code, error.message);
      }
      throw error;
    }
  }

  async #loadEvidence(
    sandboxId: string,
    items: readonly ActionPlanItem[],
  ): Promise<Map<string, Evidence>> {
    const ids = [...new Set(items.flatMap((item) => item.evidenceIds))];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.#store.getEvidenceForAction(sandboxId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      const evidence = byId.get(id);
      if (!evidence) {
        throw new PolicyValidationError(
          'ACTION_EVIDENCE_MISSING',
          'Action item references evidence that does not exist',
        );
      }
      if (evidence.sourceStatus !== 'available') {
        throw new PolicyValidationError(
          'ACTION_EVIDENCE_MISSING',
          'Action item references evidence whose source is missing',
        );
      }
    }
    return byId;
  }

  #validateEvidenceScope(
    evidenceById: Map<string, Evidence>,
    caseId: string,
  ): void {
    for (const evidence of evidenceById.values()) {
      if (evidence.caseId !== null && evidence.caseId !== caseId) {
        throw new PolicyValidationError(
          'ACTION_EVIDENCE_SCOPE',
          'Action item references evidence from another case',
        );
      }
    }
  }

  #bindBaseVersions(
    items: readonly ActionPlanItem[],
    evidenceById: Map<string, Evidence>,
  ): ActionPlanItem[] {
    return items.map((item) => {
      const required = new Map<string, { readonly type: string; readonly id: string }>();
      const addRequired = (type: string, id: string): void => {
        required.set(`${type}:${id}`, { type, id });
      };
      const targetKey =
        item.target.system === 'enterprise'
          ? `${item.target.type}:${item.target.id}`
          : null;
      if (targetKey && item.target.system === 'enterprise') {
        addRequired(item.target.type, item.target.id);
      }
      for (const reference of enterpriseReferencesForPayload(item.payload)) {
        addRequired(reference.type, reference.id);
      }
      const evidenceVersions = new Map<
        string,
        { readonly type: string; readonly id: string; readonly version: number }
      >();
      for (const evidenceId of item.evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        const source = evidence?.sourceRef;
        if (!source || source.system !== 'enterprise') {
          continue;
        }
        const key = `${source.type}:${source.id}`;
        const existing = evidenceVersions.get(key);
        if (existing && existing.version !== source.version) {
          throw new PolicyValidationError(
            'ACTION_BASE_VERSION_CONFLICT',
            'Evidence binds conflicting versions of the same entity',
          );
        }
        evidenceVersions.set(key, {
          type: source.type,
          id: source.id,
          version: source.version,
        });
      }
      const versions = [];
      for (const key of required.keys()) {
        const bound = evidenceVersions.get(key);
        if (!bound) {
          throw new PolicyValidationError(
            'ACTION_EVIDENCE_REQUIRED',
            'Every referenced enterprise entity requires evidence binding its version',
          );
        }
        if (key === targetKey && item.target.version !== bound.version) {
          throw new PolicyValidationError(
            'ACTION_BASE_VERSION_CONFLICT',
            'A target version must match its evidence version',
          );
        }
        versions.push({
          system: 'enterprise' as const,
          type: bound.type,
          id: bound.id,
          version: bound.version,
        });
      }
      return {
        ...item,
        baseExpectedVersions: versions.sort((left, right) => {
          const leftKey = `${left.system}\u0000${left.type}\u0000${left.id}`;
          const rightKey = `${right.system}\u0000${right.type}\u0000${right.id}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
      };
    });
  }

  #createResult(result: ProposalCreateStoreResult): ActionProposalDetail {
    switch (result.status) {
      case 'created':
      case 'duplicate':
        return ActionProposalDetailSchema.parse(result.detail);
      case 'idempotency_conflict':
        throw new ProposalIdempotencyMismatchError();
      case 'case_not_found':
        throw new ProposalNotFoundError('Case was not found in the active sandbox');
      case 'evidence_unavailable':
        throw new ProposalValidationError(
          'ACTION_EVIDENCE_MISSING',
          'Action item references evidence that is no longer available',
        );
      case 'open_procurement_conflict':
        throw new ProposalConflictError();
      case 'sandbox_inactive':
        throw new SandboxInactiveError();
      case 'sandbox_unavailable':
        throw new SandboxUnavailableError();
    }
  }

  #reviseResult(result: ProposalReviseStoreResult): ActionProposalDetail {
    switch (result.status) {
      case 'revised':
        return ActionProposalDetailSchema.parse(result.detail);
      case 'not_found':
        throw new ProposalNotFoundError();
      case 'stale':
        throw new ProposalStaleError();
      case 'evidence_unavailable':
        throw new ProposalValidationError(
          'ACTION_EVIDENCE_MISSING',
          'Action item references evidence that is no longer available',
        );
      case 'open_procurement_conflict':
        throw new ProposalConflictError();
      case 'sandbox_inactive':
        throw new SandboxInactiveError();
      case 'sandbox_unavailable':
        throw new SandboxUnavailableError();
    }
  }
}

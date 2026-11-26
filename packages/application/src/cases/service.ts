import { randomUUID } from 'node:crypto';
import {
  CaseCreateInputSchema,
  CaseDetailSchema,
  CaseHistoryItemSchema,
  CaseListResponseSchema,
  CaseStatusSchema,
  CaseSummarySchema,
  CaseUpdateInputSchema,
  EntityIdSchema,
  EvidenceCreateInputSchema,
  EvidenceSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  SandboxSummarySchema,
  type CaseDetail,
  type CaseHistoryItem,
  type CaseHistoryResponse,
  type CaseListResponse,
  type CaseStatus,
  type CaseSummary,
  type Evidence,
  type SandboxSummary,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { assertTransition } from '@nexus/domain/state-machines';
import {
  sanitizeAuditDetails,
  type AuditDetails,
} from '@nexus/observability/redaction';
import {
  requireActiveSandbox,
  requireActiveSandboxForMutation,
  type SandboxResolver,
} from './context.js';

export interface CaseCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface CaseAuditInput {
  readonly action: string;
  readonly outcome: 'succeeded' | 'failed' | 'denied';
  readonly details: AuditDetails;
}

export interface CaseWriteContext {
  readonly actor: { kind: 'human' | 'workflow' | 'service'; id: string; roles: string[] };
  readonly requestId: string;
  readonly correlationId: string;
}

export interface CreateCaseStoreInput extends CaseWriteContext {
  readonly caseId: string;
  readonly sandboxId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly audit: CaseAuditInput;
}

export interface UpdateCaseStoreInput extends CaseWriteContext {
  readonly caseId: string;
  readonly sandboxId: string;
  readonly expectedVersion: number;
  readonly status: CaseStatus;
  readonly terminalReason: string | null;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly audit: CaseAuditInput;
}

export interface InsertEvidenceStoreInput extends CaseWriteContext {
  readonly evidenceId: string;
  readonly sandboxId: string;
  readonly caseId: string | null;
  readonly kind: Evidence['kind'];
  readonly sourceStatus: Evidence['sourceStatus'];
  readonly sourceRef: Evidence['sourceRef'];
  readonly sourceSandboxId: string | null;
  readonly contentHash: string;
  readonly locator: Evidence['locator'];
  readonly capturedFacts: Evidence['capturedFacts'];
  readonly missingReason: string | null;
  readonly audit: CaseAuditInput;
}

export interface AppendAuditStoreInput extends CaseWriteContext {
  readonly sandboxId: string;
  readonly runId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly targetVersion: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly outcome: 'succeeded' | 'failed' | 'denied';
  readonly details: AuditDetails;
}

export interface CaseStore extends SandboxResolver {
  listCases(input: {
    readonly sandboxId: string;
    readonly status?: CaseStatus;
    readonly limit: number;
    readonly after?: CaseCursor;
  }): Promise<{ items: CaseSummary[]; hasMore: boolean }>;
  getCase(sandboxId: string, caseId: string): Promise<CaseDetail | null>;
  listHistory(input: {
    readonly sandboxId: string;
    readonly caseId: string;
    readonly limit: number;
    readonly afterSequence?: number;
  }): Promise<{
    items: CaseHistoryItem[];
    hasMore: boolean;
    lastSequence: number | null;
  }>;
  getEvidence(sandboxId: string, evidenceId: string): Promise<Evidence | null>;
  createCase(input: CreateCaseStoreInput): Promise<CaseDetail>;
  updateCase(input: UpdateCaseStoreInput): Promise<CaseDetail | null>;
  insertEvidence(input: InsertEvidenceStoreInput): Promise<Evidence>;
  appendAudit(input: AppendAuditStoreInput): Promise<void>;
}

export class CaseNotFoundError extends Error {
  constructor(message = 'Case or evidence was not found') {
    super(message);
    this.name = 'CaseNotFoundError';
  }
}

export class CaseVersionConflictError extends Error {
  constructor(message = 'Case version conflict') {
    super(message);
    this.name = 'CaseVersionConflictError';
  }
}

export class CaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaseValidationError';
  }
}

function encodeCursor(cursor: CaseCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCaseCursor(cursor: string): CaseCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !IsoUtcTimestampSchema.safeParse(parsed.createdAt).success ||
      !EntityIdSchema.safeParse(parsed.id).success
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new CaseValidationError('Invalid case cursor');
  }
}

function encodeHistoryCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      sequence?: unknown;
    };
    if (!Number.isInteger(parsed.sequence) || (parsed.sequence as number) < 1) {
      throw new Error('invalid history cursor');
    }
    return parsed.sequence as number;
  } catch {
    throw new CaseValidationError('Invalid history cursor');
  }
}

function parseEntityId(value: string): string {
  const parsed = EntityIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new CaseValidationError('Invalid identifier');
  }
  return parsed.data;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function validateAuditAction(value: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(value)) {
    throw new CaseValidationError('Invalid audit action');
  }
  return value;
}

function validateAuditTarget(value: string | null, maxLength: number): string | null {
  if (value === null) {
    return null;
  }
  if (value.length < 1 || value.length > maxLength || hasControlCharacters(value)) {
    throw new CaseValidationError('Invalid audit target value');
  }
  return value;
}

function parseLimit(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new CaseValidationError('Limit must be an integer from 1 to 100');
  }
  return value;
}

export class CaseService {
  constructor(private readonly store: CaseStore) {}

  async getActiveSandbox(): Promise<SandboxSummary> {
    return SandboxSummarySchema.parse(await requireActiveSandbox(this.store));
  }

  async listCases(input: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CaseListResponse> {
    const sandbox = await this.getActiveSandbox();
    const limit = parseLimit(input.limit);
    let status: CaseStatus | undefined;
    try {
      status = input.status === undefined ? undefined : CaseStatusSchema.parse(input.status);
    } catch {
      throw new CaseValidationError('Invalid case status filter');
    }
    const after = input.cursor === undefined ? undefined : decodeCaseCursor(input.cursor);
    const result = await this.store.listCases({
      sandboxId: sandbox.id,
      ...(status === undefined ? {} : { status }),
      limit,
      ...(after === undefined ? {} : { after }),
    });
    const items = result.items.map((item) => CaseSummarySchema.parse(item));
    const last = items.at(-1);
    return CaseListResponseSchema.parse({
      items,
      nextCursor: result.hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    });
  }

  async getCase(caseId: string): Promise<CaseDetail> {
    const id = parseEntityId(caseId);
    const sandbox = await this.getActiveSandbox();
    const found = await this.store.getCase(sandbox.id, id);
    if (!found) {
      throw new CaseNotFoundError();
    }
    return CaseDetailSchema.parse(found);
  }

  async getHistory(input: {
    caseId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CaseHistoryResponse> {
    const caseId = parseEntityId(input.caseId);
    const sandbox = await this.getActiveSandbox();
    const existing = await this.store.getCase(sandbox.id, caseId);
    if (!existing) {
      throw new CaseNotFoundError();
    }
    const limit = parseLimit(input.limit);
    const afterSequence = input.cursor === undefined
      ? undefined
      : decodeHistoryCursor(input.cursor);
    const result = await this.store.listHistory({
      sandboxId: sandbox.id,
      caseId,
      limit,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
    const items = result.items.map((item) => CaseHistoryItemSchema.parse(item));
    return {
      items,
      nextCursor: result.hasMore && result.lastSequence !== null
        ? encodeHistoryCursor(result.lastSequence)
        : null,
    };
  }

  async getEvidence(evidenceId: string): Promise<Evidence> {
    const id = parseEntityId(evidenceId);
    const sandbox = await this.getActiveSandbox();
    const found = await this.store.getEvidence(sandbox.id, id);
    if (!found) {
      throw new CaseNotFoundError('Evidence was not found');
    }
    return EvidenceSchema.parse(found);
  }

  async createCase(
    input: { title: string; summary: string | null },
    write: CaseWriteContext,
  ): Promise<CaseDetail> {
    let parsed;
    try {
      parsed = CaseCreateInputSchema.parse(input);
    } catch {
      throw new CaseValidationError('Invalid case input');
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const caseId = randomUUID();
    return CaseDetailSchema.parse(
      await this.store.createCase({
        ...write,
        caseId,
        sandboxId: sandbox.id,
        title: parsed.title,
        summary: parsed.summary,
        audit: {
          action: 'case.created',
          outcome: 'succeeded',
          details: sanitizeAuditDetails({
            caseId,
            caseStatus: 'new',
            caseVersion: 1,
            action: 'case.created',
            outcome: 'succeeded',
          }),
        },
      }),
    );
  }

  async updateCase(
    caseId: string,
    input: { expectedVersion: number; status: string; terminalReason: string | null },
    write: CaseWriteContext,
  ): Promise<CaseDetail> {
    const id = parseEntityId(caseId);
    let parsed;
    try {
      parsed = CaseUpdateInputSchema.parse(input);
    } catch {
      throw new CaseValidationError('Invalid case update');
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const current = await this.store.getCase(sandbox.id, id);
    if (!current) {
      throw new CaseNotFoundError();
    }
    if (current.version !== parsed.expectedVersion) {
      throw new CaseVersionConflictError();
    }
    try {
      assertTransition('case', current.status, parsed.status);
    } catch {
      throw new CaseValidationError('Illegal case status transition');
    }
    const beforeHash = canonicalJsonSha256({
      status: current.status,
      version: current.version,
    });
    const afterHash = canonicalJsonSha256({
      status: parsed.status,
      version: parsed.expectedVersion + 1,
    });
    const result = await this.store.updateCase({
      ...write,
      caseId: id,
      sandboxId: sandbox.id,
      expectedVersion: parsed.expectedVersion,
      status: parsed.status,
      terminalReason: parsed.terminalReason,
      beforeHash,
      afterHash,
      audit: {
        action: 'case.status_changed',
        outcome: 'succeeded',
        details: sanitizeAuditDetails({
          caseId: id,
          caseStatus: parsed.status,
          caseVersion: parsed.expectedVersion + 1,
          action: 'case.status_changed',
          outcome: 'succeeded',
        }),
      },
    });
    if (!result) {
      throw new CaseVersionConflictError();
    }
    return CaseDetailSchema.parse(result);
  }

  async addEvidence(
    input: {
      caseId: string | null;
      kind: Evidence['kind'];
      sourceStatus: Evidence['sourceStatus'];
      sourceRef: Evidence['sourceRef'];
      sourceSandboxId: string | null;
      contentHash: string | null;
      locator: Evidence['locator'];
      capturedFacts: Evidence['capturedFacts'];
      missingReason: string | null;
    },
    write: CaseWriteContext,
  ): Promise<Evidence> {
    let parsed;
    try {
      parsed = EvidenceCreateInputSchema.parse(input);
    } catch {
      throw new CaseValidationError('Invalid evidence input');
    }
    const sandbox = await requireActiveSandboxForMutation(this.store);
    let linkedCase: CaseDetail | null = null;
    if (parsed.caseId !== null) {
      linkedCase = await this.store.getCase(sandbox.id, parsed.caseId);
      if (!linkedCase) {
        throw new CaseNotFoundError();
      }
    }
    if (parsed.sourceStatus === 'available' && parsed.sourceSandboxId !== sandbox.id) {
      throw new CaseValidationError('Evidence source belongs to another sandbox');
    }
    if (
      parsed.sourceStatus === 'available' &&
      parsed.sourceRef?.system === 'nexus' &&
      parsed.sourceRef.type === 'case'
    ) {
      const sourceCase = await this.store.getCase(sandbox.id, parsed.sourceRef.id);
      if (!sourceCase || parsed.sourceRef.version > sourceCase.version) {
        throw new CaseValidationError('Evidence source case is not valid in this sandbox');
      }
    }
    const contentHash = parsed.contentHash ?? canonicalJsonSha256(parsed.capturedFacts);
    HashSchema.parse(contentHash);
    const evidenceId = randomUUID();
    const stored = await this.store.insertEvidence({
      ...write,
      evidenceId,
      sandboxId: sandbox.id,
      caseId: parsed.caseId,
      kind: parsed.kind,
      sourceStatus: parsed.sourceStatus,
      sourceRef: parsed.sourceRef,
      sourceSandboxId: parsed.sourceSandboxId,
      contentHash,
      locator: parsed.locator,
      capturedFacts: parsed.capturedFacts,
      missingReason: parsed.missingReason,
      audit: {
        action: 'evidence.created',
        outcome: 'succeeded',
        details: sanitizeAuditDetails({
          evidenceId,
          caseId: parsed.caseId,
          ...(linkedCase === null
            ? {}
            : { caseStatus: linkedCase.status, caseVersion: linkedCase.version }),
          sourceKind: parsed.kind,
          contentHash,
          status: parsed.sourceStatus,
          action: 'evidence.created',
          outcome: 'succeeded',
        }),
      },
    });
    return EvidenceSchema.parse(stored);
  }

  async appendAudit(
    input: {
      runId: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      targetVersion: string | null;
      beforeHash: string | null;
      afterHash: string | null;
      outcome: 'succeeded' | 'failed' | 'denied';
      details: unknown;
    },
    write: CaseWriteContext,
  ): Promise<void> {
    const sandbox = await requireActiveSandboxForMutation(this.store);
    const details = sanitizeAuditDetails(input.details);
    if (typeof details.caseStatus === 'string') {
      try {
        CaseStatusSchema.parse(details.caseStatus);
      } catch {
        throw new CaseValidationError('Invalid audit case status');
      }
    }
    await this.store.appendAudit({
      ...write,
      sandboxId: sandbox.id,
      runId: input.runId,
      action: validateAuditAction(input.action),
      targetType: validateAuditTarget(input.targetType, 100),
      targetId: input.targetId,
      targetVersion: validateAuditTarget(input.targetVersion, 100),
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      outcome: input.outcome,
      details,
    });
  }


}

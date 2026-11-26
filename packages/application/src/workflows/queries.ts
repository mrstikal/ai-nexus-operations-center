import {
  CaseStatusSchema,
  RunDetailSchema,
  RunEventSchema,
  RunEventsPageSchema,
  RunFinalEventDataSchema,
  RunStatusEventDataSchema,
  RunStepEventDataSchema,
  RunTextDeltaEventDataSchema,
  WorkflowStatusSchema,
  WorkflowStepStatusSchema,
  type RunDetail,
  type RunEvent,
  type RunEventsPage,
} from '@nexus/contracts';

export interface TraceEventRow {
  readonly sequence: number;
  readonly event: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RunDetailRow {
  readonly id: string;
  readonly sandboxId: string;
  readonly caseId: string;
  readonly caseStatus: string;
  readonly caseVersion: number;
  readonly definitionName: string;
  readonly definitionVersion: string;
  readonly status: string;
  readonly waitReason: unknown;
  readonly effectiveAt: Date;
  readonly activeMsLimit: number;
  readonly activeMsUsed: number;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly steps: ReadonlyArray<{
    readonly stepKey: string;
    readonly stepKind: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly errorClass: string | null;
    readonly startedAt: Date | null;
    readonly finishedAt: Date | null;
  }>;
}

export interface RunEventPageRow {
  readonly rows: readonly TraceEventRow[];
  readonly hasMore: boolean;
}

export interface RunQueryStore {
  getActiveSandboxId(): Promise<string | null>;
  getRunDetail(sandboxId: string, runId: string): Promise<RunDetailRow | null>;
  listTraceEvents(
    sandboxId: string,
    runId: string,
    after: number,
    limit: number,
  ): Promise<RunEventPageRow>;
}

function stringValue(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

function numberValue(value: unknown, minimum = 0, maximum = 600_000): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function eventSuffix(event: string): string {
  const parts = event.split('.');
  return parts[parts.length - 1] ?? event;
}

export function mapTraceEvent(row: TraceEventRow): RunEvent | null {
  const data = row.data;
  const commonStatus = stringValue(data['status'], 100);
  if (row.event.startsWith('workflow.step.')) {
    const step = stringValue(data['step'], 100);
    const status = WorkflowStepStatusSchema.safeParse(data['status']);
    if (!step || !status.success) {
      return null;
    }
    const attempt = numberValue(data['attempt'], 0, 10) ?? 0;
    const durationMs = numberValue(data['durationMs'], 0, 600_000);
    const count = numberValue(data['count'], 0, 1_000) ?? 0;
    const parsed = RunStepEventDataSchema.safeParse({
      step,
      status: status.data,
      attempt,
      durationMs,
      errorClass: stringValue(data['errorClass'], 100),
      count,
    });
    return parsed.success
      ? { id: row.sequence, event: 'step', data: parsed.data }
      : null;
  }
  if (row.event === 'workflow.case.completed') {
    const caseStatus = CaseStatusSchema.safeParse(data['status']);
    const caseVersion = numberValue(data['version'], 1, 2_147_483_647);
    if (!caseStatus.success || caseVersion === null) {
      return null;
    }
    const parsed = RunFinalEventDataSchema.safeParse({
      caseStatus: caseStatus.data,
      caseVersion,
      evidenceCount: numberValue(data['count'], 0, 100) ?? 0,
    });
    return parsed.success
      ? { id: row.sequence, event: 'final', data: parsed.data }
      : null;
  }
  if (
    row.event === 'model.delta' ||
    row.event === 'text.delta' ||
    row.event === 'assistant.delta'
  ) {
    const text = stringValue(data['text'], 2_000);
    if (!text) {
      return null;
    }
    const parsed = RunTextDeltaEventDataSchema.safeParse({
      text,
      provisional: true,
    });
    return parsed.success
      ? { id: row.sequence, event: 'text_delta', data: parsed.data }
      : null;
  }
  if (
    row.event.startsWith('workflow.scheduled') ||
    row.event.startsWith('workflow.run.') ||
    row.event.startsWith('workflow.dependency.')
  ) {
    const status =
      commonStatus ??
      (WorkflowStatusSchema.safeParse(eventSuffix(row.event)).success
        ? eventSuffix(row.event)
        : null);
    if (!status) {
      return null;
    }
    const parsed = RunStatusEventDataSchema.safeParse({
      status,
      caseStatus: CaseStatusSchema.safeParse(data['caseStatus']).success
        ? data['caseStatus']
        : null,
      waitReason: null,
      errorClass: stringValue(data['errorClass'], 100),
      count: numberValue(data['count'], 0, 1_000),
    });
    return parsed.success
      ? { id: row.sequence, event: 'status', data: parsed.data }
      : null;
  }
  if (row.event.startsWith('workflow.')) {
    const status = commonStatus ?? eventSuffix(row.event);
    const parsed = RunStatusEventDataSchema.safeParse({
      status,
      caseStatus: null,
      waitReason: null,
      errorClass: stringValue(data['errorClass'], 100),
      count: numberValue(data['count'], 0, 1_000),
    });
    return parsed.success
      ? { id: row.sequence, event: 'status', data: parsed.data }
      : null;
  }
  return null;
}

function waitReasonFrom(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

export class RunQueryService {
  constructor(private readonly store: RunQueryStore) {}

  async getActiveSandboxId(): Promise<string | null> {
    return this.store.getActiveSandboxId();
  }

  async getDetail(sandboxId: string, runId: string): Promise<RunDetail | null> {
    const row = await this.store.getRunDetail(sandboxId, runId);
    if (!row) {
      return null;
    }
    return RunDetailSchema.parse({
      id: row.id,
      sandboxId: row.sandboxId,
      caseId: row.caseId,
      caseStatus: row.caseStatus,
      caseVersion: row.caseVersion,
      definitionName: row.definitionName,
      definitionVersion: row.definitionVersion,
      status: row.status,
      waitReason: waitReasonFrom(row.waitReason),
      effectiveAt: row.effectiveAt.toISOString(),
      activeMsLimit: row.activeMsLimit,
      activeMsUsed: row.activeMsUsed,
      deadlineAt: row.deadlineAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      steps: row.steps.map((step) => ({
        stepKey: step.stepKey,
        stepKind: step.stepKind,
        status: step.status,
        attemptCount: step.attemptCount,
        maxAttempts: step.maxAttempts,
        errorClass: step.errorClass,
        startedAt: step.startedAt?.toISOString() ?? null,
        finishedAt: step.finishedAt?.toISOString() ?? null,
      })),
    });
  }

  async listEvents(
    sandboxId: string,
    runId: string,
    after: number,
    limit = 100,
  ): Promise<RunEventsPage> {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const page = await this.store.listTraceEvents(
      sandboxId,
      runId,
      Math.max(after, 0),
      pageSize,
    );
    const items: RunEvent[] = [];
    let nextAfter: number | null = after > 0 ? after : null;
    for (const row of page.rows) {
      nextAfter = row.sequence;
      const event = mapTraceEvent(row);
      if (event) {
        items.push(RunEventSchema.parse(event));
      }
    }
    return RunEventsPageSchema.parse({
      items,
      nextAfter,
      hasMore: page.hasMore,
    });
  }
}

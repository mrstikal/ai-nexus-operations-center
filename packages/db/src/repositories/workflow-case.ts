import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  CASE_TRANSITIONS,
  type CaseStatus,
} from '@nexus/domain/state-machines';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { appendAuditInTransaction } from './audit.js';
import { appendTraceEventInTransaction } from './trace.js';
import { cases } from '../schema/cases.js';
import { eventOutbox } from '../schema/events.js';
import type { DbTransaction } from './types.js';

const EVENT_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CaseWorkflowTransitionError extends Error {
  readonly code = 'CASE_TRANSITION_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'CaseWorkflowTransitionError';
  }
}

function transitionPath(from: CaseStatus, to: CaseStatus): CaseStatus[] | null {
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

function isTerminal(status: CaseStatus): boolean {
  return status === 'resolved' || status === 'escalated' || status === 'cancelled';
}

function safeCorrelation(value: string, fallback: string): string {
  return EVENT_CORRELATION_PATTERN.test(value) ? value : fallback;
}

export interface CaseTransitionInput {
  readonly sandboxId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly triggerEventId: string;
  readonly targetStatus: CaseStatus;
  readonly reason: string;
  readonly correlationId: string;
}

export interface CaseTransitionResult {
  readonly status: CaseStatus;
  readonly version: number;
  readonly changed: boolean;
  readonly terminalEventEmitted: boolean;
}

export async function applyCaseTransition(
  tx: DbTransaction,
  input: CaseTransitionInput,
): Promise<CaseTransitionResult> {
  const rows = await tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.sandboxId, input.sandboxId),
        eq(cases.id, input.caseId),
      ),
    )
    .for('update')
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new CaseWorkflowTransitionError('Workflow case was not found');
  }
  if (current.status === input.targetStatus) {
    return {
      status: current.status as CaseStatus,
      version: current.version,
      changed: false,
      terminalEventEmitted: false,
    };
  }
  if (isTerminal(current.status as CaseStatus)) {
    throw new CaseWorkflowTransitionError('Terminal case cannot change status');
  }
  const path = transitionPath(current.status as CaseStatus, input.targetStatus);
  if (!path) {
    throw new CaseWorkflowTransitionError(
      `Case cannot transition from ${current.status} to ${input.targetStatus}`,
    );
  }
  let status = current.status as CaseStatus;
  let version = current.version;
  for (const next of path) {
    const beforeHash = canonicalJsonSha256({ status, version });
    version += 1;
    const afterHash = canonicalJsonSha256({ status: next, version });
    await tx
      .update(cases)
      .set({
        status: next,
        version,
        terminalReason: isTerminal(next) ? input.reason.slice(0, 500) : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(cases.id, current.id));
    await appendAuditInTransaction(tx, {
      actor: { kind: 'workflow', id: input.runId, roles: [] },
      requestId: `workflow:${input.runId}`,
      correlationId: input.correlationId,
      sandboxId: input.sandboxId,
      runId: input.runId,
      targetType: 'case',
      targetId: input.caseId,
      targetVersion: String(version),
      action: 'case.workflow_status',
      beforeHash,
      afterHash,
      outcome: 'succeeded',
      details: {
        caseId: input.caseId,
        caseStatus: next,
        caseVersion: version,
        action: 'case.workflow_status',
        outcome: 'succeeded',
      },
    });
    status = next;
  }

  let terminalEventEmitted = false;
  if (isTerminal(status)) {
    const evidenceRows = await tx.execute(sql`
      SELECT DISTINCT evidence.evidence_id
      FROM nexus.workflow_attempt_evidence AS evidence
      JOIN nexus.workflow_step_attempts AS attempt ON attempt.id = evidence.attempt_id
      WHERE attempt.run_id = ${input.runId}
      LIMIT 100
    `);
    const evidenceIds = evidenceRows.rows
      .map((row) => row['evidence_id'])
      .filter((value): value is string => typeof value === 'string');
    await tx.insert(eventOutbox).values({
      id: randomUUID(),
      sandboxId: input.sandboxId,
      eventType: 'nexus.case.completed.v1',
      schemaVersion: 1,
      producer: 'worker',
      occurredAt: new Date(),
      correlationId: safeCorrelation(input.correlationId, input.runId),
      causationId: input.triggerEventId,
      aggregateType: 'case',
      aggregateId: input.caseId,
      aggregateVersion: version,
      payload: {
        caseId: input.caseId,
        terminalRunId: input.runId,
        terminalTriggerEventId: input.triggerEventId,
        terminalCaseVersion: version,
        terminalStatus: status,
        outcomeEvidenceIds: evidenceIds,
      },
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: sql`clock_timestamp()`,
      lastError: null,
      version: 0,
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
    await appendTraceEventInTransaction(tx, {
      sandboxId: input.sandboxId,
      runId: input.runId,
      level: 'info',
      event: 'workflow.case.completed',
      data: {
        status,
        entityType: 'case',
        entityId: input.caseId,
        version,
      },
    });
    terminalEventEmitted = true;
  }

  return {
    status,
    version,
    changed: true,
    terminalEventEmitted,
  };
}

import { and, eq, gt } from 'drizzle-orm';
import type {
  RunDetailRow,
  RunEventPageRow,
  RunQueryStore,
  TraceEventRow,
} from '@nexus/application/workflows/queries';
import type { NexusDb } from '../connection.js';
import { activeSandbox, cases, sandboxes } from '../schema/cases.js';
import { traceEvents } from '../schema/trace.js';
import { workflowRuns, workflowSteps } from '../schema/workflows.js';

export function createRunQueryStore(db: NexusDb): RunQueryStore {
  return {
    async getActiveSandboxId(): Promise<string | null> {
      const rows = await db
        .select({ id: sandboxes.id })
        .from(activeSandbox)
        .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
        .where(eq(sandboxes.status, 'active'))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async getRunDetail(
      sandboxId: string,
      runId: string,
    ): Promise<RunDetailRow | null> {
      const rows = await db
        .select({
          run: workflowRuns,
          caseStatus: cases.status,
          caseVersion: cases.version,
        })
        .from(workflowRuns)
        .innerJoin(
          cases,
          and(
            eq(cases.sandboxId, workflowRuns.sandboxId),
            eq(cases.id, workflowRuns.caseId),
          ),
        )
        .where(
          and(
            eq(workflowRuns.sandboxId, sandboxId),
            eq(workflowRuns.id, runId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      const steps = await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.runId, runId))
        .orderBy(workflowSteps.stepKey);
      return {
        id: row.run.id,
        sandboxId: row.run.sandboxId,
        caseId: row.run.caseId,
        caseStatus: row.caseStatus,
        caseVersion: row.caseVersion,
        definitionName: row.run.definitionName,
        definitionVersion: row.run.definitionVersion,
        status: row.run.status,
        waitReason: row.run.waitReason,
        effectiveAt: row.run.effectiveAt,
        activeMsLimit: row.run.activeMsLimit,
        activeMsUsed: row.run.activeMsUsed,
        deadlineAt: row.run.deadlineAt,
        createdAt: row.run.createdAt,
        updatedAt: row.run.updatedAt,
        steps: steps.map((step) => ({
          stepKey: step.stepKey,
          stepKind: step.stepKind,
          status: step.status,
          attemptCount: step.attemptCount,
          maxAttempts: step.maxAttempts,
          errorClass: step.errorClass,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
        })),
      };
    },

    async listTraceEvents(
      sandboxId: string,
      runId: string,
      after: number,
      limit: number,
    ): Promise<RunEventPageRow> {
      const rows = await db
        .select({
          sequence: traceEvents.sequence,
          event: traceEvents.event,
          data: traceEvents.data,
          createdAt: traceEvents.createdAt,
        })
        .from(traceEvents)
        .where(
          and(
            eq(traceEvents.sandboxId, sandboxId),
            eq(traceEvents.runId, runId),
            gt(traceEvents.sequence, after),
          ),
        )
        .orderBy(traceEvents.sequence)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        rows: page.map(
          (row): TraceEventRow => ({
            sequence: Number(row.sequence),
            event: row.event,
            data: row.data,
            createdAt: row.createdAt,
          }),
        ),
        hasMore,
      };
    },
  };
}

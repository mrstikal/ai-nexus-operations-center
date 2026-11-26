import { describe, expect, it } from 'vitest';
import {
  RunDetailSchema,
  RunEventSchema,
  RunEventsPageSchema,
} from '@nexus/contracts';
import {
  RunQueryService,
  mapTraceEvent,
  type RunQueryStore,
} from '@nexus/application/workflows/queries';

describe('F11B run events and read contracts', () => {
  it('maps step, status and final trace rows into bounded SSE events', () => {
    const step = mapTraceEvent({
      sequence: 3,
      event: 'workflow.step.succeeded',
      data: {
        step: 'alpha',
        status: 'succeeded',
        attempt: 1,
        durationMs: 4,
        count: 0,
        retry: false,
        secret: 'must-not-leak',
      },
      createdAt: new Date(),
    });
    expect(step).toEqual({
      id: 3,
      event: 'step',
      data: {
        step: 'alpha',
        status: 'succeeded',
        attempt: 1,
        durationMs: 4,
        errorClass: null,
        count: 0,
      },
    });
    expect(JSON.stringify(step)).not.toContain('must-not-leak');

    const status = mapTraceEvent({
      sequence: 4,
      event: 'workflow.run.waiting_input',
      data: { status: 'waiting_input' },
      createdAt: new Date(),
    });
    expect(status?.event).toBe('status');
    expect(RunEventSchema.safeParse(status).success).toBe(true);

    const final = mapTraceEvent({
      sequence: 5,
      event: 'workflow.case.completed',
      data: {
        status: 'resolved',
        version: 3,
        count: 2,
        entityType: 'case',
        entityId: 'x',
      },
      createdAt: new Date(),
    });
    expect(final).toEqual({
      id: 5,
      event: 'final',
      data: { caseStatus: 'resolved', caseVersion: 3, evidenceCount: 2 },
    });

    const dependency = mapTraceEvent({
      sequence: 6,
      event: 'workflow.dependency.escalated',
      data: {
        status: 'cancelled',
        caseStatus: 'escalated',
        errorClass: 'DEPENDENCY_TIMEOUT',
      },
      createdAt: new Date(),
    });
    expect(dependency).toMatchObject({
      id: 6,
      event: 'status',
      data: { status: 'cancelled', caseStatus: 'escalated' },
    });
    expect(
      RunEventSchema.safeParse({ ...final, extra: true }).success,
    ).toBe(false);
  });

  it('rejects malformed trace data and unknown event names', () => {
    expect(
      mapTraceEvent({
        sequence: 1,
        event: 'workflow.step.succeeded',
        data: { step: 'alpha', status: 'not-a-step-status' },
        createdAt: new Date(),
      }),
    ).toBeNull();
    expect(
      mapTraceEvent({
        sequence: 1,
        event: 'unrelated.event',
        data: { status: 'running' },
        createdAt: new Date(),
      }),
    ).toBeNull();
    expect(
      RunEventSchema.safeParse({
        id: 1,
        event: 'status',
        data: { status: 'running', extra: true },
      }).success,
    ).toBe(false);
  });

  it('bounds event pages and advances the cursor even for skipped rows', async () => {
    const rows = [
      {
        sequence: 10,
        event: 'workflow.scheduled',
        data: { status: 'queued' },
        createdAt: new Date(),
      },
      {
        sequence: 11,
        event: 'unrelated.event',
        data: { status: 'ignored' },
        createdAt: new Date(),
      },
      {
        sequence: 12,
        event: 'workflow.run.completed',
        data: { status: 'completed' },
        createdAt: new Date(),
      },
    ];
    const store: RunQueryStore = {
      getActiveSandboxId: async () => 'sandbox',
      getRunDetail: async () => null,
      listTraceEvents: async (_sandbox, _run, after, limit) => ({
        rows: rows.filter((row) => row.sequence > after).slice(0, limit),
        hasMore: rows.filter((row) => row.sequence > after).length > limit,
      }),
    };
    const service = new RunQueryService(store);
    const page = await service.listEvents('sandbox', 'run', 0, 1);
    expect(RunEventsPageSchema.safeParse(page).success).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(10);
    expect(page.hasMore).toBe(true);
    const second = await service.listEvents('sandbox', 'run', page.nextAfter ?? 0, 200);
    expect(second.items.map((event) => event.id)).toEqual([12]);
    expect(second.nextAfter).toBe(12);
    expect(second.hasMore).toBe(false);
  });

  it('validates the run detail shape without raw payloads', () => {
    const detail = {
      id: '00000000-0000-4000-8000-000000000010',
      sandboxId: '00000000-0000-4000-8000-000000000001',
      caseId: '00000000-0000-4000-8000-000000000011',
      caseStatus: 'investigating',
      caseVersion: 2,
      definitionName: 'test-three-step',
      definitionVersion: 'v1',
      status: 'waiting_input',
      waitReason: { kind: 'human_input', prompt: 'Need input' },
      effectiveAt: '2026-11-02T09:00:00.000Z',
      activeMsLimit: 300000,
      activeMsUsed: 10,
      deadlineAt: '2026-11-02T11:00:00.000Z',
      createdAt: '2026-11-02T09:00:00.000Z',
      updatedAt: '2026-11-02T09:00:01.000Z',
      steps: [
        {
          stepKey: 'wait',
          stepKind: 'pure',
          status: 'waiting',
          attemptCount: 1,
          maxAttempts: 3,
          errorClass: null,
          startedAt: '2026-11-02T09:00:00.000Z',
          finishedAt: '2026-11-02T09:00:01.000Z',
        },
      ],
    };
    expect(RunDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      RunDetailSchema.safeParse({
        ...detail,
        rawPayload: { secret: 'x' },
      }).success,
    ).toBe(false);
  });
});

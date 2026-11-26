import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ActionDraftPlanSchema,
  ActionPayloadSchema,
  AuthMeResponseSchema,
  CaseDetailSchema,
  CostSchema,
  EVENT_TYPES,
  GatewayFailureSchema,
  GatewayRequestSchema,
  MoneySchema,
  parseEventEnvelope,
  ProblemSchema,
  RequestContextSchema,
  ReviewerOutputSchema,
  SseEventSchema,
  ToolNameSchema,
  UiDescriptorSchema,
  ValidationIssueSchema,
} from '@nexus/contracts';

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/f03',
);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
}

describe('F03 stable contracts and examples', () => {
  const examples = readJson('api-examples.json') as Record<string, unknown>;
  const events = readJson('events.json') as unknown[];

  it('compiles API examples against their shared schemas', () => {
    expect(MoneySchema.parse(examples['money'])).toEqual({
      amountMinor: '123456',
      currency: 'EUR',
    });
    expect(CostSchema.safeParse(examples['cost']).success).toBe(true);
    expect(RequestContextSchema.safeParse(examples['requestContext']).success).toBe(true);
    expect(ProblemSchema.safeParse(examples['problem']).success).toBe(true);
    expect(CaseDetailSchema.safeParse(examples['caseDetail']).success).toBe(true);
    expect(ActionDraftPlanSchema.safeParse(examples['actionDraft']).success).toBe(true);
    expect(UiDescriptorSchema.safeParse(examples['uiDescriptor']).success).toBe(true);
    expect(GatewayRequestSchema.safeParse(examples['gatewayRequest']).success).toBe(true);
    expect(ReviewerOutputSchema.safeParse(examples['reviewerOutput']).success).toBe(true);
    expect(AuthMeResponseSchema.safeParse(examples['authMe']).success).toBe(true);
    const problem = examples['problem'] as { issues: unknown[] };
    expect(ValidationIssueSchema.safeParse(problem.issues[0]).success).toBe(true);
  });

  it('compiles every registered event example and rejects unknown types/producers', () => {
    expect(events).toHaveLength(EVENT_TYPES.length);
    const seen = new Set<string>();
    for (const event of events) {
      const parsed = parseEventEnvelope(event) as { eventType: string };
      seen.add(parsed.eventType);
    }
    expect([...seen].sort()).toEqual([...EVENT_TYPES].sort());

    const base = structuredClone(events[0]) as Record<string, unknown>;
    expect(() =>
      parseEventEnvelope({ ...base, eventType: 'nexus.unknown.v1' }),
    ).toThrow(/Unknown event type/);
    expect(() => parseEventEnvelope({ ...base, producer: 'worker' })).toThrow(
      /not allowed/,
    );
  });

  it('rejects inherited object names as event types with a typed unknown-event error', () => {
    const base = structuredClone(events[0]) as Record<string, unknown>;
    for (const eventType of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(() => parseEventEnvelope({ ...base, eventType })).toThrow(/Unknown event type/);
    }
  });

  it('accepts gateway failures with revisions and diagnostics', () => {
    expect(
      GatewayFailureSchema.safeParse({
        ok: false,
        code: 'TIMEOUT',
        message: 'Provider timed out.',
        provider: null,
        model: null,
        attemptIds: [],
        retryable: true,
        cost: null,
        promptVersion: null,
        configRevision: null,
        diagnostics: [],
      }).success,
    ).toBe(true);
  });

  it('cannot express approval, roles or executable state through an action draft', () => {
    const draft = structuredClone(examples['actionDraft']) as {
      items: Record<string, unknown>[];
      rationale: string;
    };

    expect(ActionDraftPlanSchema.safeParse({ ...draft, approved: true }).success).toBe(false);
    expect(ActionDraftPlanSchema.safeParse({ ...draft, status: 'approved' }).success).toBe(false);
    expect(
      ActionDraftPlanSchema.safeParse({
        ...draft,
        items: [{ ...draft.items[0], status: 'approved' }],
      }).success,
    ).toBe(false);
    expect(
      ActionDraftPlanSchema.safeParse({
        ...draft,
        items: [
          {
            ...draft.items[0],
            payload: {
              ...(draft.items[0]?.['payload'] as Record<string, unknown>),
              supplierApproved: true,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown event, tool, UI, action and SSE kinds', () => {
    expect(ToolNameSchema.safeParse('enterprise.run_sql').success).toBe(false);
    expect(ActionPayloadSchema.safeParse({ kind: 'enterprise.run_sql' }).success).toBe(false);
    expect(UiDescriptorSchema.safeParse({ kind: 'html_panel' }).success).toBe(false);
    expect(
      UiDescriptorSchema.safeParse({
        kind: 'evidence_list',
        title: '<script>alert(1)</script>',
        items: [],
      }).success,
    ).toBe(false);
    expect(
      UiDescriptorSchema.safeParse({
        kind: 'alternatives_table',
        title: 'Alternatives',
        columns: [{ key: 'supplier', label: 'Supplier' }],
        rows: [['<img src=x onerror=alert(1)>']],
        rejectedReasons: [],
      }).success,
    ).toBe(false);
    expect(
      SseEventSchema.safeParse({ id: 1, event: 'chain_of_thought', data: {} }).success,
    ).toBe(false);
  });

  it('rejects extra privileged fields and preserves null versus missing', () => {
    const caseDetail = structuredClone(examples['caseDetail']) as Record<string, unknown>;
    expect(CaseDetailSchema.safeParse({ ...caseDetail, approved: true }).success).toBe(false);

    const withoutTerminal = { ...caseDetail };
    delete withoutTerminal['terminalReason'];
    expect(CaseDetailSchema.safeParse(withoutTerminal).success).toBe(false);
    expect(CaseDetailSchema.safeParse({ ...caseDetail, terminalReason: null }).success).toBe(true);

    const envelope = structuredClone(events[1]) as Record<string, unknown>;
    const withoutCausation = { ...envelope };
    delete withoutCausation['causationId'];
    expect(() => parseEventEnvelope(withoutCausation)).toThrow();
    expect(() => parseEventEnvelope({ ...envelope, causationId: null })).not.toThrow();
  });

  it('rejects oversized money values', () => {
    expect(
      MoneySchema.safeParse({ amountMinor: '1000000000001', currency: 'EUR' }).success,
    ).toBe(false);
    expect(
      MoneySchema.safeParse({ amountMinor: '1000000000000', currency: 'EUR' }).success,
    ).toBe(true);
  });
});

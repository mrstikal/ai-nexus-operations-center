import { describe, expect, it } from 'vitest';
import {
  CaseIntakeRequestSchema,
  CaseIntakeSourceSchema,
  CommunicationCreatedPayloadSchema,
  IdempotencyKeySchema,
  caseIntakeSourceIdentity,
  normalizeCaseIntakeSource,
  parseEventEnvelope,
} from '@nexus/contracts';
import { boundedDeadLetterDetail } from '@nexus/messaging/dead-letter';
import { retryDelayMs } from '@nexus/messaging/retry';

const envelope = {
  eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  eventType: 'nexus.case.created.v1',
  schemaVersion: 1,
  occurredAt: '2026-11-02T09:30:00.000Z',
  sandboxId: '00000000-0000-4000-8000-000000000001',
  correlationId: 'f10-bounded-correlation',
  causationId: null,
  producer: 'api',
  payload: {
    caseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    title: 'Case title',
  },
};

describe('F10 event envelope and intake contracts', () => {
  it('accepts bounded non-UUID correlation identifiers and rejects unsafe ones', () => {
    expect(parseEventEnvelope(envelope).correlationId).toBe(
      'f10-bounded-correlation',
    );
    expect(() =>
      parseEventEnvelope({ ...envelope, correlationId: 'bad correlation with spaces' }),
    ).toThrow();
    expect(() =>
      parseEventEnvelope({ ...envelope, correlationId: 'x'.repeat(129) }),
    ).toThrow();
  });

  it('accepts customer and supplier communication payloads with one recipient', () => {
    const base = {
      communicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      orderId: null,
      version: 1,
      createdAt: '2026-11-02T09:30:00.000Z',
    };
    expect(
      CommunicationCreatedPayloadSchema.safeParse({
        ...base,
        customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      }).success,
    ).toBe(true);
    expect(
      CommunicationCreatedPayloadSchema.safeParse({
        ...base,
        customerId: null,
        supplierId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      }).success,
    ).toBe(true);
    expect(
      CommunicationCreatedPayloadSchema.safeParse({
        ...base,
        customerId: null,
      }).success,
    ).toBe(false);
    expect(
      CommunicationCreatedPayloadSchema.safeParse({
        ...base,
        customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        supplierId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      }).success,
    ).toBe(false);
  });

  it('normalizes source identity and validates idempotency keys', () => {
    const source = CaseIntakeSourceSchema.parse({
      type: 'email',
      messageId: ' <F10@Example.COM> ',
    });
    expect(normalizeCaseIntakeSource(source)).toEqual({
      type: 'email',
      messageId: '<f10@example.com>',
    });
    expect(caseIntakeSourceIdentity(source)).toBe('email:<f10@example.com>');
    expect(
      CaseIntakeRequestSchema.safeParse({
        title: 'Intake title',
        summary: null,
        source: { type: 'text', identity: ' f10-source ' },
      }).success,
    ).toBe(true);
    expect(IdempotencyKeySchema.safeParse('f10-key:1').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('bad key').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('uses the bounded retry schedule and redacts dead-letter detail', () => {
    expect([1, 2, 3, 4, 10].map(retryDelayMs)).toEqual([
      1_000,
      5_000,
      30_000,
      30_000,
      30_000,
    ]);
    const detail = boundedDeadLetterDetail(`bad\n${'x'.repeat(600)}`);
    expect(detail).not.toContain('\n');
    expect(detail.length).toBeLessThanOrEqual(500);
  });
});

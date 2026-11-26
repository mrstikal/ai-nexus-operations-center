import { z } from 'zod';
import { CaseDetailSchema } from './cases.js';
import { UuidSchema, plainTextSchema } from './common.js';

export const INGRESS_CASE_ROUTE = '/api/v1/cases';

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
    'Expected a bounded idempotency key',
  );
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const CaseIntakeSourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('email'),
      messageId: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .regex(/^[\x21-\x7e]+$/, 'Expected a normalized email message ID'),
    })
    .strict(),
  z
    .object({
      type: z.literal('document'),
      documentId: UuidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      identity: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[\x20-\x7e]+$/, 'Expected a printable text source identity'),
    })
    .strict(),
]);
export type CaseIntakeSource = z.infer<typeof CaseIntakeSourceSchema>;

export const CaseIntakeRequestSchema = z
  .object({
    title: plainTextSchema(200),
    summary: z.string().min(1).max(5000).nullable(),
    source: CaseIntakeSourceSchema,
  })
  .strict();
export type CaseIntakeRequest = z.infer<typeof CaseIntakeRequestSchema>;

export const CaseIntakeResponseSchema = z
  .object({
    case: CaseDetailSchema,
    eventId: UuidSchema,
    eventType: z.literal('nexus.case.created.v1'),
    queued: z.literal(true),
    deduplicated: z.boolean(),
  })
  .strict();
export type CaseIntakeResponse = z.infer<typeof CaseIntakeResponseSchema>;

export function caseIntakeSourceIdentity(source: CaseIntakeSource): string {
  switch (source.type) {
    case 'email':
      return `email:${source.messageId.trim().toLowerCase()}`;
    case 'document':
      return `document:${source.documentId}`;
    case 'text':
      return `text:${source.identity.trim()}`;
  }
}

export function normalizeCaseIntakeSource(
  source: CaseIntakeSource,
): CaseIntakeSource {
  switch (source.type) {
    case 'email':
      return {
        type: 'email',
        messageId: source.messageId.trim().toLowerCase(),
      };
    case 'document':
      return { type: 'document', documentId: source.documentId };
    case 'text':
      return { type: 'text', identity: source.identity.trim() };
  }
}

import { createHash } from 'node:crypto';

export const DEAD_LETTER_REASON_CODES = [
  'SCHEMA_INVALID',
  'UNKNOWN_EVENT',
  'PRODUCER_MISMATCH',
  'EXCHANGE_MISMATCH',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'UNKNOWN_SANDBOX',
] as const;

export type DeadLetterReasonCode =
  (typeof DEAD_LETTER_REASON_CODES)[number];

export interface DeadLetterInput {
  readonly consumerName: string;
  readonly sandboxId: string | null;
  readonly eventId: string | null;
  readonly eventType: string | null;
  readonly exchange: string | null;
  readonly routingKey: string | null;
  readonly producer: string | null;
  readonly messageId: string | null;
  readonly body: Uint8Array;
  readonly parsedBody: unknown;
  readonly reasonCode: DeadLetterReasonCode;
  readonly reasonDetail: string;
}

export function boundedDeadLetterDetail(detail: string): string {
  const cleaned = [...detail]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') {
    return 'Message was rejected';
  }
  return cleaned.slice(0, 500);
}

export function bodySha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface DeadLetterStore {
  record(input: DeadLetterInput & { readonly bodySha256: string }): Promise<void>;
}

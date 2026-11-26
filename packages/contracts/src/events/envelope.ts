import { z } from 'zod';
import { IsoUtcTimestampSchema, UuidSchema } from '../common.js';

export const EVENT_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const EVENT_PRODUCERS = ['api', 'worker', 'enterprise-sim'] as const;
export const EventProducerSchema = z.enum(EVENT_PRODUCERS);
export type EventProducer = z.infer<typeof EventProducerSchema>;

export function EventEnvelopeSchema<T extends z.ZodType>(payloadSchema: T) {
  return z
    .object({
      eventId: UuidSchema,
      eventType: z.string().min(1).max(100),
      schemaVersion: z.literal(1),
      occurredAt: IsoUtcTimestampSchema,
      sandboxId: UuidSchema,
      correlationId: z
        .string()
        .regex(EVENT_CORRELATION_PATTERN, 'Expected a bounded correlation identifier'),
      causationId: UuidSchema.nullable(),
      producer: EventProducerSchema,
      payload: payloadSchema,
    })
    .strict();
}

export type EventEnvelope<T> = {
  eventId: string;
  eventType: string;
  schemaVersion: 1;
  occurredAt: string;
  sandboxId: string;
  correlationId: string;
  causationId: string | null;
  producer: EventProducer;
  payload: T;
};

import { z } from 'zod';
import { IsoUtcTimestampSchema, UuidSchema } from '../common.js';

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
      correlationId: UuidSchema,
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

import { z } from 'zod';
import { JsonValueSchema } from '../common.js';
import { EventEnvelopeSchema, type EventEnvelope, type EventProducer } from './envelope.js';
import {
  ActionRequestedPayloadSchema,
  CaseCompletedPayloadSchema,
  CaseCreatedPayloadSchema,
  CommunicationCreatedPayloadSchema,
  DocumentReadyPayloadSchema,
  EnterpriseChangePayloadSchema,
  KnowledgeChangedPayloadSchema,
  SupplierDelayPayloadSchema,
  WorkflowResumePayloadSchema,
} from './payloads.js';

export const EVENT_TYPES = [
  'nexus.case.created.v1',
  'nexus.case.completed.v1',
  'nexus.document.ready.v1',
  'nexus.workflow.resume.v1',
  'nexus.action.requested.v1',
  'nexus.knowledge.changed.v1',
  'enterprise.supplier.delay.v1',
  'enterprise.inventory.changed.v1',
  'enterprise.order.changed.v1',
  'enterprise.invoice.changed.v1',
  'enterprise.communication.created.v1',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

interface EventRegistration {
  readonly payload: z.ZodType;
  readonly producers: readonly EventProducer[];
}

export const EVENT_REGISTRY: Record<EventType, EventRegistration> = {
  'nexus.case.created.v1': { payload: CaseCreatedPayloadSchema, producers: ['api'] },
  'nexus.case.completed.v1': { payload: CaseCompletedPayloadSchema, producers: ['worker'] },
  'nexus.document.ready.v1': { payload: DocumentReadyPayloadSchema, producers: ['worker'] },
  'nexus.workflow.resume.v1': {
    payload: WorkflowResumePayloadSchema,
    producers: ['api', 'worker'],
  },
  'nexus.action.requested.v1': {
    payload: ActionRequestedPayloadSchema,
    producers: ['worker'],
  },
  'nexus.knowledge.changed.v1': {
    payload: KnowledgeChangedPayloadSchema,
    producers: ['api', 'worker'],
  },
  'enterprise.supplier.delay.v1': {
    payload: SupplierDelayPayloadSchema,
    producers: ['enterprise-sim'],
  },
  'enterprise.inventory.changed.v1': {
    payload: EnterpriseChangePayloadSchema,
    producers: ['enterprise-sim'],
  },
  'enterprise.order.changed.v1': {
    payload: EnterpriseChangePayloadSchema,
    producers: ['enterprise-sim'],
  },
  'enterprise.invoice.changed.v1': {
    payload: EnterpriseChangePayloadSchema,
    producers: ['enterprise-sim'],
  },
  'enterprise.communication.created.v1': {
    payload: CommunicationCreatedPayloadSchema,
    producers: ['enterprise-sim'],
  },
};

export const BaseEventEnvelopeSchema = EventEnvelopeSchema(JsonValueSchema);

export function parseEventEnvelope(input: unknown): EventEnvelope<unknown> {
  const base = BaseEventEnvelopeSchema.parse(input);
  const eventType = base.eventType as EventType;
  if (!Object.hasOwn(EVENT_REGISTRY, eventType)) {
    throw new Error(`Unknown event type ${base.eventType}`);
  }
  const registration = EVENT_REGISTRY[eventType];
  if (!registration.producers.includes(base.producer)) {
    throw new Error(
      `Producer ${base.producer} is not allowed for event type ${base.eventType}`,
    );
  }
  const payload = registration.payload.parse(base.payload);
  return { ...base, payload };
}

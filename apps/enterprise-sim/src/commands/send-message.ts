import { randomUUID } from 'node:crypto';
import type { SendMessagePayload } from '@nexus/contracts';
import { ProblemException } from '../auth.js';
import type { CommandContext, CommandEffect } from './transaction.js';

interface RecipientSupplierRow {
  id: string;
  reference: string;
  status: string;
  version: number;
}

interface RecipientCustomerRow {
  id: string;
  reference: string;
  status: string;
  version: number;
}

function invalid(message: string): ProblemException {
  return new ProblemException('VALIDATION_FAILED', message);
}

export async function executeSendMessage(
  context: CommandContext,
  payload: SendMessagePayload,
): Promise<CommandEffect> {
  if (payload.recipient.system !== 'enterprise') {
    throw invalid('Message recipient must be an enterprise entity');
  }
  if (!['supplier', 'customer'].includes(payload.recipient.type)) {
    throw invalid('Message recipient type must be supplier or customer');
  }
  const messageParts: Array<{
    kind: 'text' | 'verified_claim';
    text: string;
    claimId?: string;
  }> = [];
  for (const part of payload.parts) {
    if (part.kind === 'receipt_fact') {
      throw invalid(
        'Deferred receipt bindings are not supported until F13A',
      );
    }
    messageParts.push(part);
  }

  let recipientReference: string;
  let recipientVersion: number;
  let supplierId: string | null = null;
  let customerId: string | null = null;

  if (payload.recipient.type === 'supplier') {
    const result = await context.client.query<RecipientSupplierRow>(
      `SELECT id, reference, status, version
       FROM enterprise.suppliers
       WHERE sandbox_id = $1 AND id = $2`,
      [context.sandboxId, payload.recipient.id],
    );
    const recipient = result.rows[0];
    if (!recipient) {
      throw new ProblemException('NOT_FOUND', 'Supplier recipient was not found');
    }
    if (
      recipient.status !== 'active' ||
      recipient.version !== payload.recipient.version
    ) {
      throw new ProblemException(
        'STALE_STATE',
        'Supplier recipient has changed or is not active',
      );
    }
    recipientReference = recipient.reference;
    recipientVersion = recipient.version;
    supplierId = recipient.id;
  } else {
    const result = await context.client.query<RecipientCustomerRow>(
      `SELECT id, reference, status, version
       FROM enterprise.customers
       WHERE sandbox_id = $1 AND id = $2`,
      [context.sandboxId, payload.recipient.id],
    );
    const recipient = result.rows[0];
    if (!recipient) {
      throw new ProblemException('NOT_FOUND', 'Customer recipient was not found');
    }
    if (
      recipient.status !== 'active' ||
      recipient.version !== payload.recipient.version
    ) {
      throw new ProblemException(
        'STALE_STATE',
        'Customer recipient has changed or is not active',
      );
    }
    recipientReference = recipient.reference;
    recipientVersion = recipient.version;
    customerId = recipient.id;
  }

  const renderedText = messageParts.map((part) => part.text).join('\n');
  if (renderedText.length === 0 || renderedText.length > 5000) {
    throw invalid('Rendered message must contain between 1 and 5,000 characters');
  }

  const communicationId = randomUUID();
  await context.client.query(
    `INSERT INTO enterprise.communications
       (id, sandbox_id, recipient_supplier_id, recipient_customer_id,
        recipient_reference, recipient_version, subject, rendered_text, status,
        version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'simulated', 1,
             clock_timestamp(), clock_timestamp())`,
    [
      communicationId,
      context.sandboxId,
      supplierId,
      customerId,
      recipientReference,
      recipientVersion,
      payload.subject,
      renderedText,
    ],
  );

  for (const [ordinal, part] of messageParts.entries()) {
    await context.client.query(
      `INSERT INTO enterprise.communication_parts
         (id, sandbox_id, communication_id, ordinal, kind, text, claim_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        context.sandboxId,
        communicationId,
        ordinal,
        part.kind,
        part.text,
        part.kind === 'verified_claim' ? (part.claimId ?? null) : null,
      ],
    );
  }

  return {
    resultEntityType: 'communication',
    resultEntityId: communicationId,
    resultEntityVersion: 1,
    entityChanges: [
      {
        entityType: 'communication',
        id: communicationId,
        beforeVersion: null,
        afterVersion: 1,
      },
    ],
    outboxEvents: [
      {
        eventType: 'enterprise.communication.created.v1',
        aggregateType: 'communication',
        aggregateId: communicationId,
        aggregateVersion: 1,
        payload: {
          entityType: 'communication',
          entityId: communicationId,
          version: 1,
          changedFields: ['created'],
          recipientType: payload.recipient.type,
          recipientId: payload.recipient.id,
          subject: payload.subject,
          partCount: payload.parts.length,
        },
      },
    ],
  };
}

import type {
  ActionPlanItem,
  DeferredBinding,
  EntityRef,
  SendMessagePayload,
} from '@nexus/contracts';

export interface ExecutedItemResult {
  readonly itemId: string;
  readonly commandKind: string;
  readonly resultEntityType: string;
  readonly resultEntityId: string;
  readonly resultEntityVersion: number;
}

export interface EntityChange {
  readonly entityType: string;
  readonly entityId: string;
  readonly beforeVersion: number | null;
  readonly afterVersion: number;
}

export class BindingError extends Error {
  constructor(
    readonly code:
      | 'BINDING_SOURCE_MISSING'
      | 'BINDING_KIND_MISMATCH'
      | 'BINDING_OUTPUT_MISMATCH'
      | 'BINDING_FORBIDDEN'
      | 'BASE_VERSION_CHAIN_GAP',
    message: string,
  ) {
    super(message);
    this.name = 'BindingError';
  }
}

const OUTPUTS: Record<
  DeferredBinding['output'],
  { readonly commandKind: string; readonly entityType: string }
> = {
  purchaseOrderId: {
    commandKind: 'enterprise.create_purchase_order',
    entityType: 'purchase_order',
  },
  shipmentId: {
    commandKind: 'enterprise.create_replacement_shipment',
    entityType: 'shipment',
  },
  returnAuthorizationId: {
    commandKind: 'enterprise.create_return_authorization',
    entityType: 'return_authorization',
  },
  creditDraftId: {
    commandKind: 'enterprise.create_credit_note_draft',
    entityType: 'credit_draft',
  },
};

export function resolveMessagePayload(
  item: ActionPlanItem,
  results: readonly ExecutedItemResult[],
): { payload: SendMessagePayload; usedItemIds: string[] } {
  if (item.payload.kind !== 'enterprise.send_message') {
    throw new BindingError(
      'BINDING_FORBIDDEN',
      'Receipt bindings are permitted only on message items',
    );
  }
  const byItemId = new Map(results.map((result) => [result.itemId, result]));
  const usedItemIds: string[] = [];
  const parts = item.payload.parts.map((part) => {
    if (part.kind !== 'receipt_fact') {
      return part;
    }
    const source = byItemId.get(part.binding.fromItemId);
    if (!source) {
      throw new BindingError(
        'BINDING_SOURCE_MISSING',
        'A receipt binding source has no committed result',
      );
    }
    const expected = OUTPUTS[part.binding.output];
    if (source.commandKind !== expected.commandKind) {
      throw new BindingError(
        'BINDING_KIND_MISMATCH',
        'A receipt binding source has the wrong command kind',
      );
    }
    if (source.resultEntityType !== expected.entityType) {
      throw new BindingError(
        'BINDING_OUTPUT_MISMATCH',
        'A receipt binding output does not match the committed result',
      );
    }
    usedItemIds.push(source.itemId);
    return {
      kind: 'text' as const,
      text: `${part.label}: ${source.resultEntityId}`,
    };
  });
  return {
    payload: { ...item.payload, parts },
    usedItemIds: [...new Set(usedItemIds)],
  };
}

export function advanceBaseVersions(
  baseExpectedVersions: readonly EntityRef[],
  changes: readonly EntityChange[],
): EntityRef[] {
  return baseExpectedVersions.map((ref) => {
    let version = ref.version;
    for (const change of changes) {
      if (
        change.entityType === ref.type &&
        change.entityId === ref.id &&
        change.beforeVersion === version
      ) {
        version = change.afterVersion;
      }
    }
    return { ...ref, version };
  });
}

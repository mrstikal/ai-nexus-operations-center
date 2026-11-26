import {
  ActionPlanItemSchema,
  PolicyBundleSchema,
  type ActionKind,
  type ActionPayload,
  type ActionPlanItem,
  type PolicyBundle,
  type Role,
} from '@nexus/contracts';
import { addMinor, assertMinorBound, parseMinor } from '../money.js';

export const MAX_ACTION_PLAN_ITEMS = 6;
export const HARD_FINANCE_THRESHOLD_MINOR = 50_000n;
export const HARD_APPROVAL_TTL_HOURS = 24;

export type CompiledActionHandler = 'internal_note' | 'purchase_order' | 'message';

export interface CompiledActionRule {
  readonly handler: CompiledActionHandler;
  readonly approvalRoles: readonly Role[];
  readonly automaticAllowed: boolean;
  readonly financeThresholdApplies: boolean;
}

export const ACTION_HANDLER_CATALOG = {
  'case.add_internal_note': {
    handler: 'internal_note',
    approvalRoles: [],
    automaticAllowed: true,
    financeThresholdApplies: false,
  },
  'enterprise.create_purchase_order': {
    handler: 'purchase_order',
    approvalRoles: ['approver_ops'],
    automaticAllowed: false,
    financeThresholdApplies: true,
  },
  'enterprise.send_message': {
    handler: 'message',
    approvalRoles: ['approver_ops'],
    automaticAllowed: false,
    financeThresholdApplies: false,
  },
} as const satisfies Partial<Record<ActionKind, CompiledActionRule>>;

export type SupportedActionKind = keyof typeof ACTION_HANDLER_CATALOG;

export type PolicyValidationCode =
  | 'POLICY_BUNDLE_INVALID'
  | 'POLICY_THRESHOLD_WIDENED'
  | 'POLICY_TTL_WIDENED'
  | 'POLICY_AUTOMATION_INVALID'
  | 'POLICY_REVISION_CONFLICT'
  | 'ACTION_KIND_UNSUPPORTED'
  | 'ACTION_KIND_NOT_ENABLED'
  | 'ACTION_PAYLOAD_INVALID'
  | 'ACTION_EVIDENCE_REQUIRED'
  | 'ACTION_EVIDENCE_MISSING'
  | 'ACTION_EVIDENCE_SCOPE'
  | 'ACTION_ITEM_LIMIT'
  | 'ACTION_ITEM_DUPLICATE'
  | 'ACTION_DEPENDENCY_MISSING'
  | 'ACTION_DEPENDENCY_CYCLE'
  | 'ACTION_BINDING_INVALID'
  | 'ACTION_BASE_VERSION_CONFLICT';

export class PolicyValidationError extends Error {
  constructor(
    readonly code: PolicyValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

export function isSupportedActionKind(kind: string): kind is SupportedActionKind {
  return Object.hasOwn(ACTION_HANDLER_CATALOG, kind);
}

export function assertSupportedActionKind(kind: string): SupportedActionKind {
  if (!isSupportedActionKind(kind)) {
    throw new PolicyValidationError(
      'ACTION_KIND_UNSUPPORTED',
      `Action kind ${kind} has no implemented policy handler`,
    );
  }
  return kind;
}

export function assertActionKindEnabled(
  kind: string,
  bundle: PolicyBundle,
): SupportedActionKind {
  const supported = assertSupportedActionKind(kind);
  if (!bundle.enabledActionKinds.includes(supported)) {
    throw new PolicyValidationError(
      'ACTION_KIND_NOT_ENABLED',
      `Action kind ${kind} is not enabled by the policy bundle`,
    );
  }
  return supported;
}

export function isPolicyAutomatic(kind: string, bundle: PolicyBundle): boolean {
  return (
    kind === 'case.add_internal_note' &&
    bundle.lowRiskAutomation.enabled &&
    bundle.lowRiskAutomation.actionKinds.includes('case.add_internal_note') &&
    bundle.enabledActionKinds.includes('case.add_internal_note')
  );
}

export function validatePolicyBundle(
  input: unknown,
  canonicalTextHash: string,
): PolicyBundle {
  const parsed = PolicyBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new PolicyValidationError(
      'POLICY_BUNDLE_INVALID',
      'Policy bundle failed schema validation',
    );
  }
  const bundle = parsed.data;
  const expectedTextPath = `fixtures/knowledge/${bundle.revision}.md`;
  if (bundle.canonicalText.path !== expectedTextPath) {
    throw new PolicyValidationError(
      'POLICY_BUNDLE_INVALID',
      'Policy bundle canonical text path does not match its revision',
    );
  }
  if (bundle.canonicalText.sha256 !== canonicalTextHash) {
    throw new PolicyValidationError(
      'POLICY_BUNDLE_INVALID',
      'Policy bundle canonical text hash does not match the source file',
    );
  }
  if (parseMinor(bundle.supplyApproval.financeThresholdMinor) > HARD_FINANCE_THRESHOLD_MINOR) {
    throw new PolicyValidationError(
      'POLICY_THRESHOLD_WIDENED',
      'Policy bundle cannot widen the compiled finance threshold',
    );
  }
  if (bundle.approval.ttlHours > HARD_APPROVAL_TTL_HOURS) {
    throw new PolicyValidationError(
      'POLICY_TTL_WIDENED',
      'Policy bundle cannot widen the compiled approval lifetime',
    );
  }
  for (const kind of bundle.enabledActionKinds) {
    assertSupportedActionKind(kind);
  }
  if (bundle.lowRiskAutomation.enabled) {
    if (
      bundle.lowRiskAutomation.actionKinds.length !== 1 ||
      bundle.lowRiskAutomation.actionKinds[0] !== 'case.add_internal_note' ||
      !bundle.enabledActionKinds.includes('case.add_internal_note')
    ) {
      throw new PolicyValidationError(
        'POLICY_AUTOMATION_INVALID',
        'Low-risk automation can only cover the internal-note action',
      );
    }
  } else if (bundle.lowRiskAutomation.actionKinds.length !== 0) {
    throw new PolicyValidationError(
      'POLICY_AUTOMATION_INVALID',
      'Disabled low-risk automation must name no action kinds',
    );
  }
  return bundle;
}

export function assertPlanEvidence(items: readonly ActionPlanItem[]): void {
  for (const item of items) {
    if (item.payload.kind !== 'case.add_internal_note' && item.evidenceIds.length === 0) {
      throw new PolicyValidationError(
        'ACTION_EVIDENCE_REQUIRED',
        'Enterprise action items require at least one evidence reference',
      );
    }
  }
}

export function assertPlanFinancialSemantics(items: readonly ActionPlanItem[]): void {
  for (const item of items) {
    if (item.payload.kind !== 'enterprise.create_purchase_order') {
      continue;
    }
    const expedite = parseMinor(item.payload.expediteChargeMinor);
    if (expedite < 0n) {
      throw new PolicyValidationError(
        'ACTION_PAYLOAD_INVALID',
        'Purchase-order expedite charge must be non-negative',
      );
    }
    let total = 0n;
    for (const line of item.payload.lines) {
      const unitPrice = parseMinor(line.unitPriceMinor);
      if (unitPrice <= 0n) {
        throw new PolicyValidationError(
          'ACTION_PAYLOAD_INVALID',
          'Purchase-order unit prices must be positive',
        );
      }
      total = addMinor(total, assertMinorBound(BigInt(line.quantity) * unitPrice));
    }
    addMinor(total, expedite);
  }
}

export function assertActionPlan(items: readonly ActionPlanItem[]): void {
  if (items.length < 1 || items.length > MAX_ACTION_PLAN_ITEMS) {
    throw new PolicyValidationError(
      'ACTION_ITEM_LIMIT',
      `An action plan must contain between 1 and ${MAX_ACTION_PLAN_ITEMS} items`,
    );
  }
  const parsed = ActionPlanItemSchema.array().safeParse(items);
  if (!parsed.success) {
    throw new PolicyValidationError(
      'ACTION_PAYLOAD_INVALID',
      'Action plan items failed schema validation',
    );
  }
  const plan = parsed.data;
  const byId = new Map<string, ActionPlanItem>();
  for (const item of plan) {
    if (byId.has(item.itemId)) {
      throw new PolicyValidationError(
        'ACTION_ITEM_DUPLICATE',
        'Action plan item identifiers must be unique',
      );
    }
    byId.set(item.itemId, item);
  }
  for (const item of plan) {
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length) {
      throw new PolicyValidationError(
        'ACTION_PAYLOAD_INVALID',
        'Action item evidence references must be unique',
      );
    }
    if (new Set(item.dependsOnItemIds).size !== item.dependsOnItemIds.length) {
      throw new PolicyValidationError(
        'ACTION_PAYLOAD_INVALID',
        'Action item dependencies must be unique',
      );
    }
    const seenRefs = new Set<string>();
    for (const ref of item.baseExpectedVersions) {
      const key = `${ref.system}:${ref.type}:${ref.id}`;
      if (seenRefs.has(key)) {
        throw new PolicyValidationError(
          'ACTION_BASE_VERSION_CONFLICT',
          'An item cannot bind the same entity version more than once',
        );
      }
      seenRefs.add(key);
    }
    for (const dependencyId of item.dependsOnItemIds) {
      if (dependencyId === item.itemId || !byId.has(dependencyId)) {
        throw new PolicyValidationError(
          'ACTION_DEPENDENCY_MISSING',
          'Action dependencies must reference a distinct item in the same plan',
        );
      }
    }
  }
  const visitState = new Map<string, 'visiting' | 'visited'>();
  const visit = (itemId: string): void => {
    const state = visitState.get(itemId);
    if (state === 'visiting') {
      throw new PolicyValidationError(
        'ACTION_DEPENDENCY_CYCLE',
        'Action plan dependencies must be acyclic',
      );
    }
    if (state === 'visited') {
      return;
    }
    visitState.set(itemId, 'visiting');
    const item = byId.get(itemId);
    if (!item) {
      throw new PolicyValidationError(
        'ACTION_DEPENDENCY_MISSING',
        'Action dependency references a missing item',
      );
    }
    for (const dependencyId of item.dependsOnItemIds) {
      visit(dependencyId);
    }
    visitState.set(itemId, 'visited');
  };
  for (const item of plan) {
    visit(item.itemId);
  }
  for (const item of plan) {
    if (item.payload.kind !== 'enterprise.send_message') {
      continue;
    }
    for (const part of item.payload.parts) {
      if (part.kind !== 'receipt_fact') {
        continue;
      }
      const source = byId.get(part.binding.fromItemId);
      if (!source || !dependsTransitively(source, item.itemId, byId)) {
        throw new PolicyValidationError(
          'ACTION_BINDING_INVALID',
          'Receipt bindings must reference a predecessor item',
        );
      }
      const expectedKind = bindingKindForOutput(part.binding.output);
      if (source.payload.kind !== expectedKind) {
        throw new PolicyValidationError(
          'ACTION_BINDING_INVALID',
          'Receipt binding output does not match the predecessor action kind',
        );
      }
    }
  }
}

function dependsTransitively(
  candidate: ActionPlanItem,
  itemId: string,
  byId: Map<string, ActionPlanItem>,
): boolean {
  const stack = [...(byId.get(itemId)?.dependsOnItemIds ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) {
      continue;
    }
    if (next === candidate.itemId) {
      return true;
    }
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOnItemIds ?? []));
  }
  return false;
}

function bindingKindForOutput(output: string): ActionKind {
  switch (output) {
    case 'purchaseOrderId':
      return 'enterprise.create_purchase_order';
    case 'shipmentId':
      return 'enterprise.create_replacement_shipment';
    case 'returnAuthorizationId':
      return 'enterprise.create_return_authorization';
    case 'creditDraftId':
      return 'enterprise.create_credit_note_draft';
    default:
      throw new PolicyValidationError(
        'ACTION_BINDING_INVALID',
        'Receipt binding output is not supported',
      );
  }
}

export interface EnterpriseEntityReference {
  readonly type: string;
  readonly id: string;
}

export function enterpriseReferencesForPayload(
  payload: ActionPayload,
): EnterpriseEntityReference[] {
  const refs: EnterpriseEntityReference[] = [];
  const add = (type: string, id: string): void => {
    refs.push({ type, id });
  };
  switch (payload.kind) {
    case 'case.add_internal_note':
      break;
    case 'enterprise.create_purchase_order':
      add('supplier', payload.supplierId);
      add('purchase_order', payload.sourcePurchaseOrderId);
      for (const line of payload.lines) {
        add('product', line.productId);
        add('agreement', line.agreementId);
      }
      break;
    case 'enterprise.send_message':
      if (payload.recipient.system === 'enterprise') {
        add(payload.recipient.type, payload.recipient.id);
      }
      break;
    case 'enterprise.mark_invoice_reconciled':
    case 'enterprise.hold_invoice':
      add('invoice', payload.invoiceId);
      break;
    case 'enterprise.post_goods_receipt':
      add('purchase_order', payload.purchaseOrderId);
      break;
    case 'enterprise.create_replacement_shipment':
    case 'enterprise.create_return_authorization':
      add('sales_order', payload.orderId);
      add('delivery', payload.deliveryId);
      break;
    case 'enterprise.create_credit_note_draft':
      add('invoice', payload.invoiceId);
      break;
    case 'enterprise.change_delivery_address':
      add('sales_order', payload.orderId);
      break;
  }
  return refs;
}

import { z } from 'zod';
import {
  CreatePurchaseOrderPayloadSchema,
  SendMessagePayloadSchema,
} from './actions.js';
import {
  HashSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
} from './common.js';

export const ENTERPRISE_COMMAND_KINDS = [
  'enterprise.create_purchase_order',
  'enterprise.send_message',
] as const;

export const EnterpriseCommandKindSchema = z.enum(ENTERPRISE_COMMAND_KINDS);
export type EnterpriseCommandKind = z.infer<typeof EnterpriseCommandKindSchema>;

export const ENTERPRISE_COMMAND_ENTITY_TYPES = [
  'sandbox',
  'supplier',
  'product',
  'customer',
  'agreement',
  'purchase_order',
  'inventory',
] as const;

export const EnterpriseCommandEntityTypeSchema = z.enum(
  ENTERPRISE_COMMAND_ENTITY_TYPES,
);
export type EnterpriseCommandEntityType = z.infer<
  typeof EnterpriseCommandEntityTypeSchema
>;

const CommandReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const EnterpriseBaseExpectedVersionSchema = z
  .object({
    system: z.literal('enterprise'),
    type: EnterpriseCommandEntityTypeSchema,
    id: UuidSchema,
    reference: CommandReferenceSchema.nullable(),
    version: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();
export type EnterpriseBaseExpectedVersion = z.infer<
  typeof EnterpriseBaseExpectedVersionSchema
>;

export const EnterpriseReceiptKeySchema = z
  .string()
  .min(1)
  .max(400)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:enterprise\.(?:create_purchase_order|send_message)$/i,
    'Expected the composite sandbox:revision:item:command receipt key',
  );

export const EnterpriseCommandPayloadSchema = z.union([
  CreatePurchaseOrderPayloadSchema,
  SendMessagePayloadSchema,
]);
export type EnterpriseCommandPayload = z.infer<
  typeof EnterpriseCommandPayloadSchema
>;

export const EnterpriseCommandRequestSchema = z
  .object({
    sandboxId: UuidSchema,
    actionRevisionId: UuidSchema,
    itemId: UuidSchema,
    planHash: HashSchema,
    itemHash: HashSchema,
    baseExpectedVersions: z.array(EnterpriseBaseExpectedVersionSchema).max(50),
    payloadTemplate: EnterpriseCommandPayloadSchema,
    priorReceiptKeys: z.array(EnterpriseReceiptKeySchema).max(20),
    executeBefore: IsoUtcTimestampSchema,
    authorizationValidUntil: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseCommandRequest = z.infer<
  typeof EnterpriseCommandRequestSchema
>;

export const EnterpriseCommandEntityChangeSchema = z
  .object({
    entityType: z.enum([
      'purchase_order',
      'purchase_order_line',
      'inventory',
      'communication',
    ]),
    id: UuidSchema,
    beforeVersion: z.number().int().min(0).max(2_147_483_647).nullable(),
    afterVersion: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();
export type EnterpriseCommandEntityChange = z.infer<
  typeof EnterpriseCommandEntityChangeSchema
>;

export const EnterpriseCommandReceiptSchema = z
  .object({
    id: UuidSchema,
    sandboxId: UuidSchema,
    idempotencyKey: EnterpriseReceiptKeySchema,
    commandKind: EnterpriseCommandKindSchema,
    actionRevisionId: UuidSchema,
    itemId: UuidSchema,
    planHash: HashSchema,
    itemHash: HashSchema,
    status: z.literal('succeeded'),
    executeBefore: IsoUtcTimestampSchema,
    authorizationValidUntil: IsoUtcTimestampSchema,
    baseExpectedVersions: z.array(EnterpriseBaseExpectedVersionSchema).max(50),
    priorReceiptKeys: z.array(EnterpriseReceiptKeySchema).max(20),
    result: z
      .object({
        entityType: z.enum(['purchase_order', 'communication']),
        id: UuidSchema,
        version: z.number().int().min(1).max(2_147_483_647),
      })
      .strict(),
    entityChanges: z.array(EnterpriseCommandEntityChangeSchema).min(1).max(100),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type EnterpriseCommandReceipt = z.infer<
  typeof EnterpriseCommandReceiptSchema
>;

export function receiptKeyFor(
  sandboxId: string,
  actionRevisionId: string,
  itemId: string,
  commandKind: EnterpriseCommandKind,
): string {
  return `${sandboxId}:${actionRevisionId}:${itemId}:${commandKind}`;
}

function canonicalNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error('Enterprise command canonical JSON requires safe integers');
  }
  return String(value);
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return canonicalNumber(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Circular enterprise command value');
    }
    seen.add(value);
    const result = `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('Circular enterprise command value');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Enterprise command canonical JSON requires plain objects');
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result = `{${Object.keys(record)
      .sort()
      .map((key) => {
        const child = record[key];
        if (child === undefined) {
          throw new Error(`Undefined enterprise command value at ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalize(child, seen)}`;
      })
      .join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw new Error('Unsupported enterprise command canonical value');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function sortEnterpriseBaseVersions(
  versions: readonly EnterpriseBaseExpectedVersion[],
): EnterpriseBaseExpectedVersion[] {
  return [...versions].sort((left, right) => {
    const typeOrder = compareCodeUnits(left.type, right.type);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    const idOrder = compareCodeUnits(left.id, right.id);
    if (idOrder !== 0) {
      return idOrder;
    }
    const versionOrder = left.version - right.version;
    if (versionOrder !== 0) {
      return versionOrder;
    }
    return compareCodeUnits(left.reference ?? '', right.reference ?? '');
  });
}

export function canonicalizeEnterpriseCommandItem(item: {
  readonly payloadTemplate: EnterpriseCommandPayload;
  readonly baseExpectedVersions: readonly EnterpriseBaseExpectedVersion[];
}): string {
  return canonicalize(
    {
      kind: item.payloadTemplate.kind,
      payloadTemplate: item.payloadTemplate,
      baseExpectedVersions: sortEnterpriseBaseVersions(
        item.baseExpectedVersions,
      ),
    },
    new Set(),
  );
}

import { z } from 'zod';

export const UuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Expected a UUID',
  );

export const EntityIdSchema = UuidSchema;
export type EntityId = z.infer<typeof EntityIdSchema>;

export const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    'Expected an ISO-8601 UTC timestamp ending in Z',
  );

export const HashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 hex digest');

export const ROLE_VALUES = [
  'viewer',
  'operator',
  'approver_ops',
  'approver_finance',
  'admin',
] as const;

export const RoleSchema = z.enum(ROLE_VALUES);
export type Role = z.infer<typeof RoleSchema>;


const MONEY_MINOR_PATTERN =
  /^(?:0|-[1-9]\d{0,11}|-1000000000000|[1-9]\d{0,11}|1000000000000)$/;
const MICROUSD_PATTERN = /^(?:0|[1-9]\d{0,14}|1000000000000000)$/;

export const MoneyAmountMinorSchema = z
  .string()
  .max(14)
  .regex(MONEY_MINOR_PATTERN, 'Expected a signed decimal integer within the money bound');

export const NonNegativeMicrousdSchema = z
  .string()
  .max(16)
  .regex(MICROUSD_PATTERN, 'Expected a non-negative decimal integer within the cost bound');

export const MoneySchema = z
  .object({
    amountMinor: MoneyAmountMinorSchema,
    currency: z.literal('EUR'),
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;

export const CostSchema = z
  .object({
    amountMicrousd: NonNegativeMicrousdSchema,
    basis: z.enum(['estimated', 'reported', 'replay']),
  })
  .strict();
export type Cost = z.infer<typeof CostSchema>;

export const EntityRefSchema = z
  .object({
    system: z.enum(['nexus', 'enterprise']),
    type: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    id: EntityIdSchema,
    version: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const ActorSchema = z
  .object({
    kind: z.enum(['human', 'workflow', 'service']),
    id: z.string().min(1).max(128),
    roles: z.array(RoleSchema).max(10),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

export const RequestContextSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    correlationId: z.string().min(1).max(128),
    sandboxId: EntityIdSchema,
    actor: ActorSchema,
  })
  .strict();
export type RequestContext = z.infer<typeof RequestContextSchema>;

export const ProblemSchema = z
  .object({
    code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1).max(2000),
    requestId: z.string().min(1).max(128),
    issues: z.array(z.unknown()).max(50).optional(),
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  })
  .strict();
export type Problem = z.infer<typeof ProblemSchema>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema).max(100),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export function plainTextSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) =>
        !/<[A-Za-z!/][^>]*>/.test(value) &&
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
        }),
      'Expected plain text without HTML tags or control characters',
    );
}

export function CursorPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema).max(100),
      nextCursor: z.string().max(512).nullable(),
    })
    .strict();
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

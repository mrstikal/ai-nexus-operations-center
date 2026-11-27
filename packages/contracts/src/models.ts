import { z } from 'zod';
import {
  CostSchema,
  EntityIdSchema,
  JsonValueSchema,
  RoleSchema,
} from './common.js';

export const MODEL_ROLES = [
  'classify',
  'extract',
  'vision',
  'embed',
  'analyse',
  'verify',
  'write',
] as const;
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const MODEL_CAPABILITIES = [
  'structured_json',
  'tool',
  'vision',
  'embedding',
  'streaming',
] as const;
export const ModelCapabilitySchema = z.enum(MODEL_CAPABILITIES);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const TOOL_NAMES = [
  'enterprise.get_purchase_order',
  'enterprise.get_inventory',
  'enterprise.get_affected_orders',
  'enterprise.list_alternatives',
  'enterprise.get_customer_context',
  'enterprise.get_invoice_context',
  'domain.calculate_supply_options',
  'domain.reconcile_document',
  'knowledge.search',
  'actions.propose',
  'cases.add_internal_note',
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolClassSchema = z.enum(['read', 'compute', 'propose', 'auto_note']);
export type ToolClass = z.infer<typeof ToolClassSchema>;

export const ToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    schemaVersion: z.number().int().positive(),
    permission: z.array(RoleSchema).min(1).max(5),
    toolClass: ToolClassSchema,
    supportedScenarios: z.array(z.string().min(1).max(100)).max(10),
    maxResults: z.number().int().positive().max(1000),
    timeoutMs: z.number().int().positive().max(120_000),
    retryable: z.boolean(),
    redaction: z
      .object({
        mode: z.enum(['none', 'allowlist']),
        allowedFields: z.array(z.string().min(1).max(100)).max(50),
      })
      .strict(),
    budgetWeight: z.number().int().nonnegative().max(100),
  })
  .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ModelMessageContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(16_000) }).strict(),
  z
    .object({
      kind: z.literal('image_ref'),
      documentVersionId: EntityIdSchema,
      page: z.number().int().positive().max(1000),
    })
    .strict(),
]);
export type ModelMessageContent = z.infer<typeof ModelMessageContentSchema>;

/**
 * Caller-supplied messages. The `system` role is deliberately absent: trusted
 * instructions live in the versioned prompt owned by the gateway, so document
 * or email text can never be submitted as a system instruction. Provider
 * adapters place the resolved prompt in their own system slot.
 */
export const ModelMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.array(ModelMessageContentSchema).min(1).max(50),
  })
  .strict();
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const GatewayRequestSchema = z
  .object({
    role: ModelRoleSchema,
    capabilities: z.array(ModelCapabilitySchema).max(5),
    messages: z.array(ModelMessageSchema).min(1).max(50),
    outputSchemaId: z.string().min(1).max(100),
    allowedToolNames: z.array(ToolNameSchema).max(20),
    workflowRunId: EntityIdSchema.nullable(),
    budgetAccountId: EntityIdSchema.nullable(),
    maxOutputTokens: z.number().int().positive().max(4000),
    stream: z.boolean(),
  })
  .strict();
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const MODEL_FAILURE_CODES = [
  'UNAUTHORIZED',
  'MODERATION',
  'CONTEXT_LENGTH',
  'PRIVACY_POLICY',
  'RATE_LIMIT',
  'TIMEOUT',
  'UNAVAILABLE',
  'SCHEMA_INVALID',
  'TOOL_LIMIT',
  'BUDGET',
  'CANCELLED',
  'UNKNOWN',
] as const;
export const ModelFailureCodeSchema = z.enum(MODEL_FAILURE_CODES);
export type ModelFailureCode = z.infer<typeof ModelFailureCodeSchema>;

export const ModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

export const GatewaySuccessSchema = z
  .object({
    ok: z.literal(true),
    output: JsonValueSchema,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    attemptIds: z.array(EntityIdSchema).min(1).max(2),
    usage: ModelUsageSchema.nullable(),
    cost: CostSchema,
    promptVersion: z.string().min(1).max(100),
    configRevision: z.string().min(1).max(100),
    diagnostics: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export type GatewaySuccess = z.infer<typeof GatewaySuccessSchema>;

export const GatewayFailureSchema = z
  .object({
    ok: z.literal(false),
    code: ModelFailureCodeSchema,
    message: z.string().min(1).max(2000),
    provider: z.string().min(1).max(100).nullable(),
    model: z.string().min(1).max(200).nullable(),
    attemptIds: z.array(EntityIdSchema).max(2),
    retryable: z.boolean(),
    cost: CostSchema.nullable(),
    promptVersion: z.string().min(1).max(100).nullable(),
    configRevision: z.string().min(1).max(100).nullable(),
    diagnostics: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export type GatewayFailure = z.infer<typeof GatewayFailureSchema>;

export const GatewayResultSchema = z.discriminatedUnion('ok', [
  GatewaySuccessSchema,
  GatewayFailureSchema,
]);
export type GatewayResult = z.infer<typeof GatewayResultSchema>;

export const ReviewerFindingSchema = z
  .object({
    code: z.string().min(1).max(100),
    evidenceIds: z.array(EntityIdSchema).max(20),
    message: z.string().min(1).max(2000),
  })
  .strict();
export type ReviewerFinding = z.infer<typeof ReviewerFindingSchema>;

export const ReviewerOutputSchema = z
  .object({
    verdict: z.enum(['supported', 'disputed', 'insufficient']),
    findings: z.array(ReviewerFindingSchema).max(50),
    missingFields: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export const ToolCallSchema = z
  .object({
    name: ToolNameSchema,
    arguments: JsonValueSchema,
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;

export interface GatewayInvocationOptions {
  /**
   * Stable logical attempt identity supplied by a workflow or retry loop.
   * Reusing it returns the recorded attempt instead of issuing provider I/O
   * again. When absent, the gateway generates one for a single invocation.
   */
  readonly invocationId?: string | null;
  /** Aborts admission before a reservation and is forwarded to provider I/O. */
  readonly signal?: AbortSignal | undefined;
}

export interface ModelGateway {
  invoke(
    request: GatewayRequest,
    options?: GatewayInvocationOptions,
  ): Promise<GatewayResult>;
  stream(
    request: GatewayRequest,
    options?: GatewayInvocationOptions,
  ): AsyncIterable<
    | { kind: 'text_delta'; text: string }
    | { kind: 'status'; status: string }
    | { kind: 'final'; result: GatewayResult }
  >;
}

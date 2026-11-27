import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  MODEL_CAPABILITIES,
  MODEL_ROLES,
  type GatewayRequest,
  type ModelCapability,
  type ModelRole,
} from '@nexus/contracts';
import {
  type GatewayLimits,
  type ModelPricing,
} from './budgets.js';
import { ModelConfigError } from './errors.js';
import { resolvePrompt, type ResolvedPrompt } from './prompts/index.js';

export const REQUIRED_CAPABILITIES: Readonly<
  Record<ModelRole, readonly ModelCapability[]>
> = {
  classify: ['structured_json'],
  extract: ['structured_json'],
  vision: ['structured_json', 'vision'],
  embed: ['embedding'],
  analyse: ['structured_json'],
  verify: ['structured_json'],
  write: ['structured_json'],
};

const TokenPriceSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,8})$/, 'Expected a non-negative token price in USD micro-units');

export const ModelPricingSchema = z
  .object({
    inputMicrousdPerToken: TokenPriceSchema,
    outputMicrousdPerToken: TokenPriceSchema,
  })
  .strict();

export const ModelRouteSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    capabilities: z.array(z.enum(MODEL_CAPABILITIES)).min(1).max(5),
    promptVersion: z.string().min(1).max(100),
    maxOutputTokens: z.number().int().positive().max(4000),
    pricing: ModelPricingSchema,
  })
  .strict();

export const FallbackRouteSchema = ModelRouteSchema.omit({ promptVersion: true, maxOutputTokens: true });

export const ModelConfigSchema = z
  .object({
    revision: z.string().min(1).max(100),
    mode: z.enum(['replay', 'live']),
    roles: z.record(z.enum(MODEL_ROLES), ModelRouteSchema),
    fallback: FallbackRouteSchema.nullable(),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

const MicroUsdSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,15})$/, 'Expected a non-negative USD micro-unit amount');

export const GatewayLimitsSchema = z
  .object({
    revision: z.string().min(1).max(100),
    maxPhysicalAttempts: z.number().int().min(1).max(2),
    maxToolRounds: z.number().int().min(0).max(2),
    maxToolCalls: z.number().int().min(0).max(12),
    maxInputTokens: z.number().int().min(1).max(16000),
    maxOutputTokens: z.number().int().min(1).max(4000),
    imageInputTokenEstimate: z.number().int().min(1).max(10000),
    messageOverheadTokens: z.number().int().min(0).max(1000),
    maxPriceMicrousdPerCall: MicroUsdSchema,
    maxAccountDepth: z.number().int().min(1).max(3),
    maxActiveMs: z.number().int().min(1000).max(300000),
  })
  .strict();
export type GatewayLimitsConfig = z.infer<typeof GatewayLimitsSchema>;

export function parseModelConfig(value: unknown): ModelConfig {
  const parsed = ModelConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ModelConfigError(
      `Invalid model configuration: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const config = parsed.data;
  if (!config.roles.classify) {
    throw new ModelConfigError('Model configuration must route the classify role');
  }
  validateRoute('classify', config.roles.classify);
  for (const [role, route] of Object.entries(config.roles)) {
    validateRoute(role as ModelRole, route);
  }
  if (config.fallback) {
    for (const role of Object.keys(config.roles)) {
      const required = REQUIRED_CAPABILITIES[role as ModelRole];
      for (const capability of required) {
        if (!config.fallback.capabilities.includes(capability)) {
          throw new ModelConfigError(
            `Fallback route lacks capability ${capability} required by role ${role}`,
          );
        }
      }
    }
  }
  return config;
}

function validateRoute(role: ModelRole, route: ModelRoute): void {
  const maxOutputTokens = role === 'analyse' ? 4000 : 2000;
  if (route.maxOutputTokens > maxOutputTokens) {
    throw new ModelConfigError(
      `Route for ${role} exceeds the ${maxOutputTokens} output-token bound`,
    );
  }
  for (const capability of REQUIRED_CAPABILITIES[role]) {
    if (!route.capabilities.includes(capability)) {
      throw new ModelConfigError(
        `Route for ${role} lacks required capability ${capability}`,
      );
    }
  }
  if (!resolvePrompt(role, route.promptVersion)) {
    throw new ModelConfigError(
      `Route for ${role} references an unknown prompt version ${route.promptVersion}`,
    );
  }
}

export function parseGatewayLimits(value: unknown): GatewayLimits {
  const parsed = GatewayLimitsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ModelConfigError(
      `Invalid gateway limits: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function loadModelConfig(path: string): ModelConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ModelConfigError(
      `Cannot read model configuration at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseModelConfig(raw);
}

export function loadGatewayLimits(path: string): GatewayLimits {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ModelConfigError(
      `Cannot read gateway limits at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseGatewayLimits(raw);
}

export interface ResolvedRoute {
  readonly role: ModelRole;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly ModelCapability[];
  readonly prompt: ResolvedPrompt;
  readonly maxOutputTokens: number;
  readonly pricing: ModelPricing;
  readonly isFallback: boolean;
}

export function resolveRoute(
  config: ModelConfig,
  role: ModelRole,
  requestedCapabilities: readonly ModelCapability[],
  fallback = false,
): ResolvedRoute {
  const primary = config.roles[role];
  if (!primary) {
    throw new ModelConfigError(`No model route is configured for role ${role}`);
  }
  const route = fallback && config.fallback
    ? {
        ...config.fallback,
        promptVersion: primary.promptVersion,
        maxOutputTokens: primary.maxOutputTokens,
      }
    : primary;
  for (const capability of requestedCapabilities) {
    if (!route.capabilities.includes(capability)) {
      throw new ModelConfigError(
        `Route ${route.provider}/${route.model} does not support capability ${capability}`,
      );
    }
  }
  const prompt = resolvePrompt(role, route.promptVersion);
  if (!prompt) {
    throw new ModelConfigError(
      `Route for ${role} references an unknown prompt version ${route.promptVersion}`,
    );
  }
  return {
    role,
    provider: route.provider,
    model: route.model,
    capabilities: [...route.capabilities],
    prompt,
    maxOutputTokens: route.maxOutputTokens,
    pricing: route.pricing,
    isFallback: fallback,
  };
}

export function assertRequestCapabilities(request: GatewayRequest): void {
  const supported = REQUIRED_CAPABILITIES[request.role];
  for (const capability of supported) {
    if (!request.capabilities.includes(capability)) {
      throw new ModelConfigError(
        `Request for ${request.role} must declare capability ${capability}`,
      );
    }
  }
}

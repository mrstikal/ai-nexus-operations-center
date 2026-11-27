import type {
  GatewayRequest,
  ModelFailureCode,
  ModelUsage,
} from '@nexus/contracts';
import { ModelUsageSchema } from '@nexus/contracts';
import { BudgetAdmissionError, ModelLimitError } from './errors.js';

export const BUDGET_OWNER_KINDS = [
  'case',
  'run',
  'document',
  'evaluation',
  'assistant',
  'briefing',
  'indexing',
] as const;
export type BudgetOwnerKind = (typeof BUDGET_OWNER_KINDS)[number];

export type BudgetAccountState = 'active' | 'closed';

/**
 * Safety constants from the plan, not configuration knobs. A deployment may
 * lower an account cap but cannot raise these ceilings or remove the buffer.
 */
export const BUDGET_BUFFER_PERCENT = 20 as const;
export const TOOL_DEFINITION_TOKEN_UPPER_BOUND = 2000 as const;
export const HARD_BUDGET_CEILINGS_MICROUSD: Readonly<
  Record<BudgetOwnerKind, string>
> = Object.freeze({
  case: '200000',
  run: '200000',
  document: '50000',
  evaluation: '5000000',
  assistant: '50000',
  briefing: '30000',
  indexing: '500000',
});

export function hardBudgetCeilingMicrousd(kind: BudgetOwnerKind): string {
  return HARD_BUDGET_CEILINGS_MICROUSD[kind];
}

export interface BudgetAccount {
  readonly id: string;
  readonly sandboxId: string;
  readonly ownerKind: BudgetOwnerKind;
  readonly ownerId: string;
  readonly parentAccountId: string | null;
  readonly capMicrousd: string;
  readonly usedMicrousd: string;
  readonly reservedMicrousd: string;
  readonly state: BudgetAccountState;
  readonly depth: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBudgetAccountInput {
  readonly sandboxId: string;
  readonly ownerKind: BudgetOwnerKind;
  readonly ownerId: string;
  readonly parentAccountId: string | null;
  readonly capMicrousd: string;
  readonly maxDepth: number;
}

export interface ModelPricing {
  readonly inputMicrousdPerToken: string;
  readonly outputMicrousdPerToken: string;
}

export interface AccountReservation {
  readonly accountId: string;
  readonly reservedMicrousd: string;
}

export interface ReserveModelCallInput {
  readonly sandboxId: string;
  readonly accountId: string;
  readonly gatewayInvocationId: string;
  readonly physicalAttempt: number;
  readonly workflowRunId: string | null;
  readonly role: string;
  readonly outputSchemaId: string;
  readonly schemaVersion: number;
  readonly promptVersion: string;
  readonly configRevision: string;
  readonly provider: string;
  readonly model: string;
  readonly mode: 'replay' | 'live';
  readonly replayKey: string;
  readonly requestHash: string;
  readonly reservedMicrousd: string;
  readonly maxDepth: number;
}

export interface ReserveModelCallResult {
  readonly callId: string;
  readonly reservedMicrousd: string;
  readonly accounts: readonly AccountReservation[];
  readonly state: 'reserved' | 'settled' | 'failed' | 'uncertain';
  /** True when an existing attempt row was returned instead of reserving anew. */
  readonly reused: boolean;
}

export interface SettleModelCallInput {
  readonly sandboxId: string;
  readonly callId: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly actualMicrousd: string;
  readonly usage: ModelUsage | null;
  readonly failureCode: ModelFailureCode | null;
  readonly diagnostics: readonly string[];
  readonly latencyMs: number;
  readonly traceEvent: string;
  readonly traceLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly traceData: Readonly<Record<string, unknown>>;
}

export interface MarkUncertainInput {
  readonly sandboxId: string;
  readonly callId: string;
  readonly failureCode: ModelFailureCode;
  readonly diagnostics: readonly string[];
  readonly traceEvent: string;
  readonly traceLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly traceData: Readonly<Record<string, unknown>>;
}

export interface FinalizeUncertainInput {
  readonly sandboxId: string;
  readonly callId: string;
  readonly actualMicrousd: string | null;
}

export interface ModelCallLedger {
  createAccount(input: CreateBudgetAccountInput): Promise<BudgetAccount>;
  getAccount(id: string): Promise<BudgetAccount | null>;
  reserveCall(input: ReserveModelCallInput): Promise<ReserveModelCallResult>;
  settleCall(input: SettleModelCallInput): Promise<void>;
  markUncertain(input: MarkUncertainInput): Promise<void>;
  finalizeUncertain(input: FinalizeUncertainInput): Promise<void>;
}

export interface GatewayLimits {
  readonly revision: string;
  readonly maxPhysicalAttempts: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly imageInputTokenEstimate: number;
  readonly messageOverheadTokens: number;
  readonly maxPriceMicrousdPerCall: string;
  readonly maxAccountDepth: number;
  readonly maxActiveMs: number;
}

const TOKEN_PRICE_PATTERN = /^(?:0|[1-9]\d{0,8})$/;
const MICROUSD_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,15})$/;

export function parseUsdMicrousd(value: string): bigint {
  if (!MICROUSD_AMOUNT_PATTERN.test(value)) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Expected a non-negative USD micro-unit amount',
    );
  }
  return BigInt(value);
}

export function formatUsdMicrousd(value: bigint): string {
  if (value < 0n) {
    throw new BudgetAdmissionError('INVALID_AMOUNT', 'Cost cannot be negative');
  }
  return value.toString();
}

function parseTokenPrice(value: string): bigint {
  if (!TOKEN_PRICE_PATTERN.test(value)) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Expected a non-negative token price in USD micro-units',
    );
  }
  return BigInt(value);
}

export interface ReservationInputs {
  /** Trusted prompt instructions resolved for the selected route. */
  readonly promptInstructions: string;
  /** Maximum output tokens allowed by the selected route. */
  readonly maxRouteOutputTokens: number;
  /** Tool names whose schemas are sent with the provider request. */
  readonly toolNames: readonly string[];
}

/**
 * Tokenizer-independent upper bound. One token per UTF-8 byte is at least as
 * large as the token count produced by the supported model tokenizers for the
 * same text, so an admission check cannot understate billable input.
 */
export function estimateTokenUpperBound(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function estimateInputTokens(
  request: GatewayRequest,
  limits: Pick<GatewayLimits, 'imageInputTokenEstimate' | 'messageOverheadTokens'>,
  inputs: Pick<ReservationInputs, 'promptInstructions' | 'toolNames'>,
): number {
  let tokens = estimateTokenUpperBound(inputs.promptInstructions);
  for (const toolName of inputs.toolNames) {
    tokens += TOOL_DEFINITION_TOKEN_UPPER_BOUND + estimateTokenUpperBound(toolName);
  }
  let images = 0;
  for (const message of request.messages) {
    tokens += limits.messageOverheadTokens + estimateTokenUpperBound(message.role);
    for (const content of message.content) {
      if (content.kind === 'text') {
        tokens += estimateTokenUpperBound(content.text);
      } else {
        images += 1;
      }
    }
  }
  if (images > 0 && limits.imageInputTokenEstimate <= 0) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Image input token bound is unavailable; refusing the call',
    );
  }
  return tokens + images * limits.imageInputTokenEstimate;
}

/**
 * Conservative pre-call reservation: an upper-bound input estimate, including
 * the trusted prompt and any tool schemas the provider receives, plus the
 * effective maximum output at the selected tariff, raised by the fixed 20%
 * buffer. Both bounds must be known; an unknown tariff refuses the route.
 */
export function estimateReservationMicrousd(
  request: GatewayRequest,
  pricing: ModelPricing,
  limits: Pick<
    GatewayLimits,
    | 'maxInputTokens'
    | 'maxOutputTokens'
    | 'imageInputTokenEstimate'
    | 'messageOverheadTokens'
    | 'maxPriceMicrousdPerCall'
  >,
  inputs: ReservationInputs,
): bigint {
  const inputTokens = estimateInputTokens(request, limits, inputs);
  if (inputTokens > limits.maxInputTokens) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      `Estimated input of ${inputTokens} tokens exceeds the ${limits.maxInputTokens} token bound`,
    );
  }
  const outputTokens = Math.min(
    request.maxOutputTokens,
    inputs.maxRouteOutputTokens,
    limits.maxOutputTokens,
  );
  const inputPrice = parseTokenPrice(pricing.inputMicrousdPerToken);
  const outputPrice = parseTokenPrice(pricing.outputMicrousdPerToken);
  const raw = BigInt(inputTokens) * inputPrice + BigInt(outputTokens) * outputPrice;
  const buffered = (raw * BigInt(100 + BUDGET_BUFFER_PERCENT) + 99n) / 100n;
  if (buffered > parseUsdMicrousd(limits.maxPriceMicrousdPerCall)) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Estimated call cost exceeds the configured per-call price cap',
    );
  }
  return buffered;
}

export interface ModelCapsLimits {
  readonly maxPhysicalAttempts: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
}

export interface ModelCapsSnapshot {
  readonly physicalAttemptsUsed: number;
  readonly toolRoundsUsed: number;
  readonly toolCallsUsed: number;
  readonly maxPhysicalAttempts: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
}

/**
 * Per-invocation/run ceiling counter. Fallback, repair and tool rounds all
 * consume the same counters; nothing can multiply a lower-level retry.
 */
export class RunModelCaps {
  #physicalAttemptsUsed = 0;
  #toolRoundsUsed = 0;
  #toolCallsUsed = 0;

  constructor(readonly limits: ModelCapsLimits) {}

  consumePhysicalAttempt(): void {
    if (this.#physicalAttemptsUsed >= this.limits.maxPhysicalAttempts) {
      throw new ModelLimitError(
        'physical_attempt',
        `Physical model attempt limit ${this.limits.maxPhysicalAttempts} reached`,
      );
    }
    this.#physicalAttemptsUsed += 1;
  }

  consumeToolRound(): void {
    if (this.#toolRoundsUsed >= this.limits.maxToolRounds) {
      throw new ModelLimitError(
        'tool_round',
        `Model tool round limit ${this.limits.maxToolRounds} reached`,
      );
    }
    this.#toolRoundsUsed += 1;
  }

  consumeToolCall(): void {
    if (this.#toolCallsUsed >= this.limits.maxToolCalls) {
      throw new ModelLimitError(
        'tool_call',
        `Model tool call limit ${this.limits.maxToolCalls} reached`,
      );
    }
    this.#toolCallsUsed += 1;
  }

  get snapshot(): ModelCapsSnapshot {
    return {
      physicalAttemptsUsed: this.#physicalAttemptsUsed,
      toolRoundsUsed: this.#toolRoundsUsed,
      toolCallsUsed: this.#toolCallsUsed,
      maxPhysicalAttempts: this.limits.maxPhysicalAttempts,
      maxToolRounds: this.limits.maxToolRounds,
      maxToolCalls: this.limits.maxToolCalls,
    };
  }
}

export function assertModelUsage(value: unknown): ModelUsage {
  const parsed = ModelUsageSchema.safeParse(value);
  if (!parsed.success) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Model usage must contain non-negative integer token counts',
    );
  }
  return parsed.data;
}

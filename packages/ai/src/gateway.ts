import { randomUUID } from 'node:crypto';
import {
  EntityIdSchema,
  GatewayRequestSchema,
  type Cost,
  type GatewayFailure,
  type GatewayInvocationOptions,
  type GatewayRequest,
  type GatewayResult,
  type GatewaySuccess,
  type JsonValue,
  type ModelFailureCode,
  type ModelGateway,
  type ModelUsage,
} from '@nexus/contracts';
import {
  AiOutputError,
  findAiOutputRegistration,
  parseAiOutput,
} from '@nexus/contracts/ai-outputs';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  assertModelUsage,
  estimateReservationMicrousd,
  type GatewayLimits,
  type ModelCallLedger,
  type ReserveModelCallResult,
  type RunModelCaps,
} from './budgets.js';
import {
  BudgetAdmissionError,
  isRetryableCode,
} from './errors.js';
import type { ModelConfig, ResolvedRoute } from './router.js';
import { assertRequestCapabilities, resolveRoute } from './router.js';
import type { ReplayAdapter } from './replay.js';

const REPAIR_INSTRUCTION =
  'The previous response did not validate against the requested output schema. Return only a JSON value that validates against that exact schema; do not repeat this instruction.';

export interface GatewayProviderResponse {
  readonly output: unknown;
  readonly usage: ModelUsage | null;
  /** Provider-reported actual cost, or null to settle from the token tariff. */
  readonly actualCostMicrousd: string | null;
  readonly providerRequestId?: string | null;
}

export interface GatewayProvider {
  invoke(input: {
    readonly route: ResolvedRoute;
    readonly request: GatewayRequest;
    readonly signal?: AbortSignal | undefined;
  }): Promise<GatewayProviderResponse>;
}

export interface GatewayProviderErrorDetails {
  readonly usage?: ModelUsage | null;
  readonly actualCostMicrousd?: string | null;
}

export class GatewayProviderError extends Error {
  readonly usage: ModelUsage | null;
  readonly actualCostMicrousd: string | null;

  constructor(
    readonly code: ModelFailureCode,
    message: string,
    readonly retryable = isRetryableCode(code),
    details: GatewayProviderErrorDetails = {},
  ) {
    super(message);
    this.name = 'GatewayProviderError';
    this.usage = details.usage ?? null;
    this.actualCostMicrousd = details.actualCostMicrousd ?? null;
  }
}

export interface SharedModelGatewayOptions {
  readonly config: ModelConfig;
  readonly limits: GatewayLimits;
  readonly ledger: ModelCallLedger;
  readonly replay?: ReplayAdapter | null;
  readonly provider?: GatewayProvider | null;
  readonly caps?: RunModelCaps | null;
  readonly now?: () => Date;
}

interface AttemptOutcome {
  readonly callId: string;
  readonly outcome: 'succeeded' | 'failed' | 'uncertain';
  readonly output?: JsonValue;
  readonly usage: ModelUsage | null;
  readonly costMicrousd: string;
  readonly costBasis: 'reported' | 'estimated' | null;
  readonly failureCode: ModelFailureCode | null;
  readonly message: string | null;
  readonly retryable: boolean;
  readonly repairEligible: boolean;
  readonly diagnostics: readonly string[];
}

function replayCost(): Cost {
  return { amountMicrousd: '0', basis: 'replay' };
}

function failure(
  code: ModelFailureCode,
  message: string,
  options: {
    readonly attemptIds?: readonly string[];
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly retryable?: boolean;
    readonly cost?: Cost | null;
    readonly promptVersion?: string | null;
    readonly configRevision?: string | null;
    readonly diagnostics?: readonly string[];
  } = {},
): GatewayFailure {
  return {
    ok: false,
    code,
    message: message.slice(0, 2000),
    provider: options.provider ?? null,
    model: options.model ?? null,
    attemptIds: [...(options.attemptIds ?? [])],
    retryable: options.retryable ?? isRetryableCode(code),
    cost: options.cost ?? null,
    promptVersion: options.promptVersion ?? null,
    configRevision: options.configRevision ?? null,
    diagnostics: [...(options.diagnostics ?? [])]
      .map((entry) => entry.slice(0, 1000))
      .slice(0, 20),
  };
}

function repairRequest(
  request: GatewayRequest,
  schemaId: string,
): GatewayRequest | null {
  if (request.messages.length >= 50) {
    return null;
  }
  return GatewayRequestSchema.parse({
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'user',
        content: [
          {
            kind: 'text',
            text: `${REPAIR_INSTRUCTION} Schema: ${schemaId}`,
          },
        ],
      },
    ],
  });
}

function actualCostFromUsage(
  usage: ModelUsage,
  pricing: ResolvedRoute['pricing'],
): bigint {
  return (
    BigInt(usage.inputTokens) * BigInt(pricing.inputMicrousdPerToken) +
    BigInt(usage.outputTokens) * BigInt(pricing.outputMicrousdPerToken)
  );
}

function assertActualCost(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)) {
    throw new BudgetAdmissionError(
      'INVALID_AMOUNT',
      'Provider-reported cost must be a non-negative USD micro-unit amount',
    );
  }
  return BigInt(value);
}

export class SharedModelGateway implements ModelGateway {
  readonly #config: ModelConfig;
  readonly #limits: GatewayLimits;
  readonly #ledger: ModelCallLedger;
  readonly #replay: ReplayAdapter | null;
  readonly #provider: GatewayProvider | null;
  readonly #caps: RunModelCaps | null;
  readonly #now: () => Date;

  constructor(options: SharedModelGatewayOptions) {
    this.#config = options.config;
    this.#limits = options.limits;
    this.#ledger = options.ledger;
    this.#replay = options.replay ?? null;
    this.#provider = options.provider ?? null;
    this.#caps = options.caps ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  async invoke(
    rawRequest: GatewayRequest,
    options: GatewayInvocationOptions = {},
  ): Promise<GatewayResult> {
    if (options.signal?.aborted) {
      return failure('CANCELLED', 'Model invocation was cancelled before admission', {
        retryable: false,
      });
    }
    if (
      options.invocationId !== undefined &&
      options.invocationId !== null &&
      !EntityIdSchema.safeParse(options.invocationId).success
    ) {
      return failure('SCHEMA_INVALID', 'invocationId must be a UUID', {
        retryable: false,
      });
    }
    const parsed = GatewayRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return failure('SCHEMA_INVALID', 'Gateway request does not match its contract');
    }
    const request = parsed.data;
    if (!request.budgetAccountId) {
      return failure('BUDGET', 'A budget account is required before a model call');
    }
    if (request.workflowRunId !== null && !this.#caps) {
      return failure(
        'TOOL_LIMIT',
        'A shared run attempt counter is required for a workflow-bound model call',
        { retryable: false, diagnostics: ['run_counter_required'] },
      );
    }

    const registration = findAiOutputRegistration(request.outputSchemaId);
    if (!registration) {
      return failure(
        'SCHEMA_INVALID',
        `No validated output schema is registered for ${request.outputSchemaId}`,
      );
    }
    if (registration.role !== request.role) {
      return failure(
        'SCHEMA_INVALID',
        `Output schema ${request.outputSchemaId} is not available to role ${request.role}`,
      );
    }
    try {
      assertRequestCapabilities(request);
    } catch (error) {
      return failure(
        'SCHEMA_INVALID',
        error instanceof Error ? error.message : String(error),
      );
    }

    let primaryRoute: ResolvedRoute;
    try {
      primaryRoute = resolveRoute(this.#config, request.role, request.capabilities, false);
    } catch (error) {
      return failure('UNAVAILABLE', error instanceof Error ? error.message : String(error), {
        retryable: false,
      });
    }

    const roleOutputBound = request.role === 'analyse' ? 4000 : 2000;
    const requestOutputBound = Math.min(
      roleOutputBound,
      primaryRoute.maxOutputTokens,
      this.#limits.maxOutputTokens,
    );
    if (request.maxOutputTokens > requestOutputBound) {
      return failure(
        'SCHEMA_INVALID',
        `Requested output of ${request.maxOutputTokens} tokens exceeds the ${requestOutputBound} token bound for ${request.role}`,
        { retryable: false },
      );
    }

    const mode = this.#config.mode;
    if (mode === 'replay' && !this.#replay) {
      return failure('UNAVAILABLE', 'Replay adapter is not configured', { retryable: false });
    }
    if (mode === 'live' && !this.#provider) {
      return failure('UNAVAILABLE', 'Live provider adapter is not configured', {
        retryable: false,
      });
    }

    let sandboxId: string;
    try {
      sandboxId = await this.#resolveSandbox(request);
    } catch (error) {
      return failure(
        'BUDGET',
        error instanceof Error ? error.message : String(error),
        { diagnostics: ['budget:ACCOUNT_NOT_FOUND'] },
      );
    }

    const gatewayInvocationId = options.invocationId ?? randomUUID();
    const attemptIds: string[] = [];
    const startedAt = this.#now();
    let attemptRequest = request;
    let attemptRoute = primaryRoute;
    let repaired = false;
    let usedFallback = false;
    let lastFailure: GatewayFailure | null = null;
    const maxAttempts = Math.min(
      this.#limits.maxPhysicalAttempts,
      this.#caps ? this.#caps.limits.maxPhysicalAttempts : this.#limits.maxPhysicalAttempts,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return failure('CANCELLED', 'Model invocation was cancelled before provider I/O', {
          attemptIds,
          provider: attemptRoute.provider,
          model: attemptRoute.model,
          retryable: false,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
        });
      }
      if (
        this.#caps &&
        this.#caps.snapshot.physicalAttemptsUsed >=
          this.#caps.limits.maxPhysicalAttempts
      ) {
        return failure(
          'TOOL_LIMIT',
          `Physical model attempt limit ${this.#caps.limits.maxPhysicalAttempts} reached`,
          {
            attemptIds,
            provider: attemptRoute.provider,
            model: attemptRoute.model,
            promptVersion: attemptRoute.prompt.contentHash,
            configRevision: this.#config.revision,
            diagnostics: ['physical_attempt_limit'],
          },
        );
      }

      let reservation: ReserveModelCallResult;
      try {
        const estimate = estimateReservationMicrousd(
          attemptRequest,
          attemptRoute.pricing,
          this.#limits,
          {
            promptInstructions: attemptRoute.prompt.instructions,
            maxRouteOutputTokens: attemptRoute.maxOutputTokens,
            toolNames: attemptRequest.allowedToolNames,
          },
        );
        reservation = await this.#ledger.reserveCall({
          sandboxId,
          accountId: request.budgetAccountId,
          gatewayInvocationId,
          physicalAttempt: attempt,
          workflowRunId: request.workflowRunId,
          role: request.role,
          outputSchemaId: request.outputSchemaId,
          schemaVersion: registration.version,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
          provider: attemptRoute.provider,
          model: attemptRoute.model,
          mode,
          replayKey: this.#replay
            ? this.#replay.keyFor(attemptRequest, {
                promptVersion: attemptRoute.prompt.contentHash,
                configRevision: this.#config.revision,
                schemaVersion: registration.version,
                route: {
                  provider: attemptRoute.provider,
                  model: attemptRoute.model,
                },
              })
            : canonicalJsonSha256(attemptRequest),
          requestHash: canonicalJsonSha256(attemptRequest),
          reservedMicrousd: estimate.toString(),
          maxDepth: this.#limits.maxAccountDepth,
        });
      } catch (error) {
        if (error instanceof BudgetAdmissionError) {
          return failure('BUDGET', error.message, {
            attemptIds,
            provider: attemptRoute.provider,
            model: attemptRoute.model,
            promptVersion: attemptRoute.prompt.contentHash,
            configRevision: this.#config.revision,
            diagnostics: [`budget:${error.reason}`],
          });
        }
        return failure('UNKNOWN', error instanceof Error ? error.message : String(error), {
          attemptIds,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
        });
      }
      attemptIds.push(reservation.callId);

      if (reservation.reused) {
        return failure(
          'UNKNOWN',
          'Model attempt identity was already recorded; provider I/O was not repeated',
          {
            attemptIds,
            provider: attemptRoute.provider,
            model: attemptRoute.model,
            retryable: false,
            promptVersion: attemptRoute.prompt.contentHash,
            configRevision: this.#config.revision,
            diagnostics: ['attempt_reused', `attempt_state:${reservation.state}`],
          },
        );
      }

      if (options.signal?.aborted) {
        await this.#ledger.settleCall({
          sandboxId,
          callId: reservation.callId,
          outcome: 'failed',
          actualMicrousd: '0',
          usage: null,
          failureCode: 'CANCELLED',
          diagnostics: ['cancelled_before_provider_io'],
          latencyMs: this.#now().getTime() - startedAt.getTime(),
          traceEvent: 'model.call.failed',
          traceLevel: 'warn',
          traceData: {
            mode,
            provider: attemptRoute.provider,
            model: attemptRoute.model,
            failureCode: 'CANCELLED',
          },
        });
        return failure('CANCELLED', 'Model invocation was cancelled before provider I/O', {
          attemptIds,
          provider: attemptRoute.provider,
          model: attemptRoute.model,
          retryable: false,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
          diagnostics: ['cancelled_before_provider_io'],
        });
      }

      if (this.#caps) {
        try {
          this.#caps.consumePhysicalAttempt();
        } catch (error) {
          await this.#ledger.settleCall({
            sandboxId,
            callId: reservation.callId,
            outcome: 'failed',
            actualMicrousd: '0',
            usage: null,
            failureCode: 'TOOL_LIMIT',
            diagnostics: ['physical_attempt_limit'],
            latencyMs: this.#now().getTime() - startedAt.getTime(),
            traceEvent: 'model.call.failed',
            traceLevel: 'warn',
            traceData: {
              mode,
              provider: attemptRoute.provider,
              model: attemptRoute.model,
              failureCode: 'TOOL_LIMIT',
            },
          });
          return failure(
            'TOOL_LIMIT',
            error instanceof Error ? error.message : String(error),
            {
              attemptIds,
              provider: attemptRoute.provider,
              model: attemptRoute.model,
              promptVersion: attemptRoute.prompt.contentHash,
              configRevision: this.#config.revision,
              diagnostics: ['physical_attempt_limit'],
            },
          );
        }
      }

      let outcome: AttemptOutcome;
      try {
        outcome = await this.#executeAttempt({
          sandboxId,
          attemptRequest,
          attemptRoute,
          mode,
          schemaVersion: registration.version,
          reservation,
          startedAt,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof GatewayProviderError) {
          const aborted = options.signal?.aborted === true;
          const failureCode: ModelFailureCode = aborted ? 'CANCELLED' : error.code;
          const hadReportedAccounting =
            error.usage !== null || error.actualCostMicrousd !== null;
          let reportedUsage: ModelUsage | null = null;
          let chargedMicrousd = 0n;
          let chargeBasis: 'reported' | 'estimated' | null = null;
          let accountingValid = true;
          try {
            if (error.usage !== null) {
              reportedUsage = assertModelUsage(error.usage);
            }
            if (error.actualCostMicrousd !== null) {
              chargedMicrousd = assertActualCost(error.actualCostMicrousd);
              chargeBasis = 'reported';
            } else if (reportedUsage !== null) {
              chargedMicrousd = actualCostFromUsage(
                reportedUsage,
                attemptRoute.pricing,
              );
              chargeBasis = 'estimated';
            }
          } catch {
            accountingValid = false;
          }
          const uncertain =
            !accountingValid ||
            (!hadReportedAccounting &&
              (failureCode === 'TIMEOUT' ||
                failureCode === 'UNAVAILABLE' ||
                failureCode === 'UNKNOWN' ||
                failureCode === 'CANCELLED'));
          if (uncertain) {
            await this.#ledger.markUncertain({
              sandboxId,
              callId: reservation.callId,
              failureCode,
              diagnostics: ['uncertain_reservation_retained'],
              traceEvent: 'model.call.failed',
              traceLevel: 'warn',
              traceData: {
                mode,
                provider: attemptRoute.provider,
                model: attemptRoute.model,
                failureCode,
                uncertain: true,
              },
            });
          } else {
            await this.#ledger.settleCall({
              sandboxId,
              callId: reservation.callId,
              outcome: 'failed',
              actualMicrousd: chargedMicrousd.toString(),
              usage: reportedUsage,
              failureCode,
              diagnostics: hadReportedAccounting
                ? ['reported_failure_charge']
                : ['release_unspent_reservation'],
              latencyMs: this.#now().getTime() - startedAt.getTime(),
              traceEvent: 'model.call.failed',
              traceLevel: 'warn',
              traceData: {
                mode,
                provider: attemptRoute.provider,
                model: attemptRoute.model,
                failureCode,
                costMicrousd: chargedMicrousd.toString(),
                costBasis: chargeBasis,
                uncertain: false,
              },
            });
          }
          outcome = {
            callId: reservation.callId,
            outcome: uncertain ? 'uncertain' : 'failed',
            usage: reportedUsage,
            costMicrousd: chargedMicrousd.toString(),
            costBasis: chargeBasis,
            failureCode,
            message: error.message,
            retryable: aborted ? false : error.retryable,
            repairEligible: false,
            diagnostics: uncertain
              ? ['uncertain_reservation_retained']
              : hadReportedAccounting
                ? ['reported_failure_charge']
                : ['release_unspent_reservation'],
          };
        } else {
          // The request may already have reached the provider. Keep the full
          // reservation as an operator-visible uncertain charge and trace it.
          const aborted =
            options.signal?.aborted === true ||
            (error instanceof Error && error.name === 'AbortError');
          const failureCode: ModelFailureCode = aborted ? 'CANCELLED' : 'UNKNOWN';
          await this.#ledger.markUncertain({
            sandboxId,
            callId: reservation.callId,
            failureCode,
            diagnostics: ['uncertain_reservation_retained'],
            traceEvent: 'model.call.failed',
            traceLevel: 'warn',
            traceData: {
              mode,
              provider: attemptRoute.provider,
              model: attemptRoute.model,
              failureCode,
              uncertain: true,
            },
          });
          return failure(
            failureCode,
            error instanceof Error ? error.message : String(error),
            {
              attemptIds,
              provider: attemptRoute.provider,
              model: attemptRoute.model,
              retryable: false,
              promptVersion: attemptRoute.prompt.contentHash,
              configRevision: this.#config.revision,
              diagnostics: ['uncertain_reservation_retained'],
            },
          );
        }
      }

      if (outcome.outcome === 'succeeded') {
        const cost: Cost = mode === 'replay'
          ? replayCost()
          : {
              amountMicrousd: outcome.costMicrousd,
              basis: outcome.costBasis ?? 'estimated',
            };
        return {
          ok: true,
          output: outcome.output as JsonValue,
          provider: attemptRoute.provider,
          model: attemptRoute.model,
          attemptIds: [...attemptIds],
          usage: outcome.usage,
          cost,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
          diagnostics: attempt > 1
            ? [repaired ? 'schema_repair_attempt' : 'fallback_attempt']
            : [],
        } satisfies GatewaySuccess;
      }

      const cost: Cost | null = mode === 'replay'
        ? replayCost()
        : outcome.costMicrousd === '0'
          ? null
          : {
              amountMicrousd: outcome.costMicrousd,
              basis: outcome.costBasis ?? 'estimated',
            };
      lastFailure = failure(
        outcome.failureCode ?? 'UNKNOWN',
        outcome.message ?? 'Model call failed',
        {
          attemptIds,
          provider: attemptRoute.provider,
          model: attemptRoute.model,
          retryable: outcome.retryable,
          cost,
          promptVersion: attemptRoute.prompt.contentHash,
          configRevision: this.#config.revision,
          diagnostics: [
            ...outcome.diagnostics,
            attempt === 1 ? 'primary_attempt' : 'second_attempt',
          ],
        },
      );

      if (attempt >= maxAttempts) {
        break;
      }
      if (
        outcome.repairEligible &&
        !repaired &&
        !usedFallback
      ) {
        const repairedRequest = repairRequest(request, request.outputSchemaId);
        if (!repairedRequest) {
          break;
        }
        repaired = true;
        attemptRequest = repairedRequest;
        attemptRoute = primaryRoute;
        continue;
      }
      if (
        outcome.retryable &&
        this.#config.fallback &&
        !repaired &&
        !usedFallback &&
        isRetryableCode(outcome.failureCode ?? 'UNKNOWN')
      ) {
        usedFallback = true;
        try {
          attemptRoute = resolveRoute(
            this.#config,
            request.role,
            request.capabilities,
            true,
          );
        } catch (error) {
          return failure(
            'UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            {
              attemptIds,
              provider: attemptRoute.provider,
              model: attemptRoute.model,
            },
          );
        }
        attemptRequest = request;
        continue;
      }
      break;
    }

    return lastFailure ?? failure('UNKNOWN', 'Model call failed without a typed outcome', {
      attemptIds,
    });
  }

  async *stream(
    request: GatewayRequest,
    options: GatewayInvocationOptions = {},
  ): AsyncIterable<
    | { kind: 'text_delta'; text: string }
    | { kind: 'status'; status: string }
    | { kind: 'final'; result: GatewayResult }
  > {
    yield { kind: 'status', status: 'invoking' };
    yield { kind: 'final', result: await this.invoke(request, options) };
  }

  async #executeAttempt(input: {
    readonly sandboxId: string;
    readonly attemptRequest: GatewayRequest;
    readonly attemptRoute: ResolvedRoute;
    readonly mode: 'replay' | 'live';
    readonly schemaVersion: number;
    readonly reservation: ReserveModelCallResult;
    readonly startedAt: Date;
    readonly signal?: AbortSignal | undefined;
  }): Promise<AttemptOutcome> {
    const startedAt = this.#now();
    const latencyMs = (): number => Math.max(0, this.#now().getTime() - startedAt.getTime());
    const baseTrace = {
      modelRole: input.attemptRequest.role,
      outputSchemaId: input.attemptRequest.outputSchemaId,
      provider: input.attemptRoute.provider,
      model: input.attemptRoute.model,
      mode: input.mode,
    };

    if (input.mode === 'replay') {
      if (!this.#replay) {
        throw new GatewayProviderError('UNAVAILABLE', 'Replay adapter is not configured', false);
      }
      const context = {
        promptVersion: input.attemptRoute.prompt.contentHash,
        configRevision: this.#config.revision,
        schemaVersion: input.schemaVersion,
        route: {
          provider: input.attemptRoute.provider,
          model: input.attemptRoute.model,
        },
      };
      const lookup = this.#replay.lookup(input.attemptRequest, context);
      if (!lookup) {
        const replayKey = this.#replay.keyFor(input.attemptRequest, context);
        await this.#ledger.settleCall({
          sandboxId: input.sandboxId,
          callId: input.reservation.callId,
          outcome: 'failed',
          actualMicrousd: '0',
          usage: null,
          failureCode: 'UNAVAILABLE',
          diagnostics: ['replay_miss'],
          latencyMs: latencyMs(),
          traceEvent: 'model.call.failed',
          traceLevel: 'warn',
          traceData: {
            ...baseTrace,
            replayKey,
            failureCode: 'UNAVAILABLE',
          },
        });
        return {
          callId: input.reservation.callId,
          outcome: 'failed',
          usage: null,
          costMicrousd: '0',
          costBasis: null,
          failureCode: 'UNAVAILABLE',
          message: 'No replay record matches the normalized semantic request',
          retryable: false,
          repairEligible: false,
          diagnostics: ['replay_miss'],
        };
      }
      const record = lookup.record;
      if (record.outcome.kind === 'failure') {
        await this.#ledger.settleCall({
          sandboxId: input.sandboxId,
          callId: input.reservation.callId,
          outcome: 'failed',
          actualMicrousd: '0',
          usage: null,
          failureCode: record.outcome.code,
          diagnostics: ['replay_fixture', record.recordId],
          latencyMs: latencyMs(),
          traceEvent: 'model.call.failed',
          traceLevel: 'warn',
          traceData: {
            ...baseTrace,
            replayKey: lookup.replayKey,
            failureCode: record.outcome.code,
            fixture: record.recordId,
          },
        });
        return {
          callId: input.reservation.callId,
          outcome: 'failed',
          usage: null,
          costMicrousd: '0',
          costBasis: null,
          failureCode: record.outcome.code,
          message: record.outcome.message,
          retryable: record.outcome.retryable,
          repairEligible: false,
          diagnostics: ['replay_fixture', record.recordId],
        };
      }
      let output: JsonValue;
      try {
        output = parseAiOutput(
          input.attemptRequest.outputSchemaId,
          input.attemptRequest.role,
          record.outcome.output,
        );
      } catch (error) {
        const message = error instanceof AiOutputError
          ? error.message
          : 'AI output failed schema validation';
        await this.#ledger.settleCall({
          sandboxId: input.sandboxId,
          callId: input.reservation.callId,
          outcome: 'failed',
          actualMicrousd: '0',
          usage: record.outcome.recordedUsage,
          failureCode: 'SCHEMA_INVALID',
          diagnostics: ['replay_fixture', record.recordId],
          latencyMs: latencyMs(),
          traceEvent: 'model.call.failed',
          traceLevel: 'warn',
          traceData: {
            ...baseTrace,
            replayKey: lookup.replayKey,
            failureCode: 'SCHEMA_INVALID',
            fixture: record.recordId,
            usageBasis: 'demo_recorded',
          },
        });
        return {
          callId: input.reservation.callId,
          outcome: 'failed',
          usage: record.outcome.recordedUsage,
          costMicrousd: '0',
          costBasis: null,
          failureCode: 'SCHEMA_INVALID',
          message,
          retryable: false,
          repairEligible: true,
          diagnostics: ['replay_fixture', record.recordId],
        };
      }
      await this.#ledger.settleCall({
        sandboxId: input.sandboxId,
        callId: input.reservation.callId,
        outcome: 'succeeded',
        actualMicrousd: '0',
        usage: record.outcome.recordedUsage,
        failureCode: null,
        diagnostics: ['replay_fixture', record.recordId],
        latencyMs: latencyMs(),
        traceEvent: 'model.call.succeeded',
        traceLevel: 'info',
        traceData: {
          ...baseTrace,
          replayKey: lookup.replayKey,
          costMicrousd: '0',
          costBasis: 'replay',
          usageBasis: 'demo_recorded',
          fixture: record.recordId,
          inputTokens: record.outcome.recordedUsage?.inputTokens ?? null,
          outputTokens: record.outcome.recordedUsage?.outputTokens ?? null,
        },
      });
      return {
        callId: input.reservation.callId,
        outcome: 'succeeded',
        output,
        usage: record.outcome.recordedUsage,
        costMicrousd: '0',
        costBasis: 'reported',
        failureCode: null,
        message: null,
        retryable: false,
        repairEligible: false,
        diagnostics: ['replay_fixture', record.recordId],
      };
    }

    if (!this.#provider) {
      throw new GatewayProviderError('UNAVAILABLE', 'Live provider adapter is not configured', false);
    }
    const response = await this.#provider.invoke({
      route: input.attemptRoute,
      request: input.attemptRequest,
      signal: input.signal,
    });
    if (response.usage) {
      assertModelUsage(response.usage);
    }
    if (!response.usage && response.actualCostMicrousd === null) {
      throw new GatewayProviderError(
        'UNAVAILABLE',
        'Provider returned neither usage nor a reported cost; the reservation remains uncertain',
        false,
      );
    }
    const cost = response.actualCostMicrousd !== null
      ? assertActualCost(response.actualCostMicrousd)
      : actualCostFromUsage(
          assertModelUsage(response.usage),
          input.attemptRoute.pricing,
        );
    const costBasis = response.actualCostMicrousd !== null ? 'reported' : 'estimated';
    let output: JsonValue;
    try {
      output = parseAiOutput(
        input.attemptRequest.outputSchemaId,
        input.attemptRequest.role,
        response.output,
      );
    } catch (error) {
      await this.#ledger.settleCall({
        sandboxId: input.sandboxId,
        callId: input.reservation.callId,
        outcome: 'failed',
        actualMicrousd: cost.toString(),
        usage: response.usage,
        failureCode: 'SCHEMA_INVALID',
        diagnostics: ['provider_output_schema_invalid'],
        latencyMs: latencyMs(),
        traceEvent: 'model.call.failed',
        traceLevel: 'warn',
        traceData: {
          ...baseTrace,
          costMicrousd: cost.toString(),
          costBasis,
          failureCode: 'SCHEMA_INVALID',
        },
      });
      return {
        callId: input.reservation.callId,
        outcome: 'failed',
        usage: response.usage,
        costMicrousd: cost.toString(),
        costBasis,
        failureCode: 'SCHEMA_INVALID',
        message: error instanceof Error ? error.message : 'AI output failed schema validation',
        retryable: false,
        repairEligible: true,
        diagnostics: ['provider_output_schema_invalid'],
      };
    }
    await this.#ledger.settleCall({
      sandboxId: input.sandboxId,
      callId: input.reservation.callId,
      outcome: 'succeeded',
      actualMicrousd: cost.toString(),
      usage: response.usage,
      failureCode: null,
      diagnostics: response.providerRequestId
        ? [`provider_request:${response.providerRequestId}`.slice(0, 1000)]
        : [],
      latencyMs: latencyMs(),
      traceEvent: 'model.call.succeeded',
      traceLevel: 'info',
      traceData: {
        ...baseTrace,
        costMicrousd: cost.toString(),
        costBasis,
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
      },
    });
    return {
      callId: input.reservation.callId,
      outcome: 'succeeded',
      output,
      usage: response.usage,
      costMicrousd: cost.toString(),
      costBasis,
      failureCode: null,
      message: null,
      retryable: false,
      repairEligible: false,
      diagnostics: [],
    };
  }

  async #resolveSandbox(request: GatewayRequest): Promise<string> {
    if (!request.budgetAccountId) {
      throw new BudgetAdmissionError('ACCOUNT_NOT_FOUND', 'Budget account is required');
    }
    const account = await this.#ledger.getAccount(request.budgetAccountId);
    if (!account) {
      throw new BudgetAdmissionError('ACCOUNT_NOT_FOUND', 'Budget account does not exist');
    }
    return account.sandboxId;
  }
}

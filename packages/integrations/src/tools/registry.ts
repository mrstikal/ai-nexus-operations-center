import {
  ACTION_KINDS,
  RegisteredToolDefinitionSchema,
  TOOL_REGISTRY_ERROR_STATUS,
  ToolInvocationContextSchema,
  type RegisteredToolDefinition,
  type ToolErrorCode,
  type ToolInvocationContext,
  type ToolTrace,
} from '@nexus/contracts';
import type {
  ToolCallContext,
  ToolExecutionOptions,
  ToolExecutionOutcome,
  ToolRegistryPort,
} from '@nexus/application/ports/tools';
import type { ZodType } from 'zod';
import { EnterpriseClientError } from '../enterprise/errors.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/;
const WRITE_ACTION_NAMES = new Set<string>(ACTION_KINDS);

export interface ToolDefinition {
  readonly descriptor: RegisteredToolDefinition;
  readonly argumentSchema: ZodType;
  readonly resultSchema: ZodType;
  readonly countResults: (result: unknown) => number;
  readonly execute: (
    args: unknown,
    context: ToolCallContext,
  ) => Promise<unknown>;
}

export interface ToolRegistryErrorOptions {
  readonly retryable?: boolean;
  readonly causeCode?: string | null;
}

export class ToolRegistryError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly trace: ToolTrace | null;
  readonly causeCode: string | null;

  constructor(
    code: ToolErrorCode,
    message: string,
    trace: ToolTrace | null,
    options: ToolRegistryErrorOptions = {},
  ) {
    super(message);
    this.name = 'ToolRegistryError';
    this.code = code;
    this.retryable = options.retryable ?? trace?.retryable === true;
    this.status = TOOL_REGISTRY_ERROR_STATUS[code];
    this.trace = trace;
    this.causeCode = options.causeCode ?? null;
  }
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function baseTrace(
  context: ToolInvocationContext,
  toolName: string | null,
  descriptor: RegisteredToolDefinition | null,
): ToolTrace {
  return {
    toolName:
      toolName !== null && TOOL_NAME_PATTERN.test(toolName) ? toolName : null,
    schemaVersion: descriptor?.schemaVersion ?? null,
    toolClass: descriptor?.toolClass ?? null,
    requestId: context.requestId,
    correlationId: context.correlationId,
    sandboxId: context.sandboxId,
    scenario: context.scenario,
    workflowStep: context.workflowStep,
    outcome: 'failed',
    errorCode: null,
    causeCode: null,
    retryable: null,
    durationMs: 0,
    argumentBytes: 0,
    resultBytes: null,
    resultCount: null,
  };
}

function validateDefinitions(
  definitions: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    const parsed = RegisteredToolDefinitionSchema.safeParse(definition.descriptor);
    if (!parsed.success) {
      throw new Error('Tool registry metadata failed contract validation');
    }
    const name = parsed.data.name;
    if (WRITE_ACTION_NAMES.has(name)) {
      throw new Error(`Write action ${name} must not be registered as an AI tool`);
    }
    if (registry.has(name)) {
      throw new Error(`Tool ${name} is registered more than once`);
    }
    registry.set(name, {
      ...definition,
      descriptor: parsed.data,
    });
  }
  return registry;
}

class ToolRegistry implements ToolRegistryPort {
  readonly #definitions: Map<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[]) {
    this.#definitions = validateDefinitions(definitions);
  }

  listTools(): RegisteredToolDefinition[] {
    return [...this.#definitions.values()].map((definition) =>
      structuredClone(definition.descriptor),
    );
  }

  async executeTool(
    name: string,
    args: unknown,
    contextInput: ToolInvocationContext,
    options: ToolExecutionOptions = {},
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    const contextResult = ToolInvocationContextSchema.safeParse(contextInput);
    if (!contextResult.success) {
      throw new ToolRegistryError(
        'TOOL_INVALID_CONTEXT',
        'Tool invocation context is invalid',
        null,
      );
    }
    const context = contextResult.data;
    const definition = this.#definitions.get(name);
    const trace = baseTrace(context, name, definition?.descriptor ?? null);

    const fail = (
      code: ToolErrorCode,
      message: string,
      extra: ToolRegistryErrorOptions = {},
      patch: Partial<ToolTrace> = {},
    ): never => {
      trace.durationMs = Date.now() - startedAt;
      trace.outcome = 'failed';
      trace.errorCode = code;
      if (extra.retryable !== undefined) {
        trace.retryable = extra.retryable;
      }
      if (extra.causeCode !== undefined) {
        trace.causeCode = extra.causeCode;
      }
      Object.assign(trace, patch);
      throw new ToolRegistryError(code, message, trace, extra);
    };

    if (!definition) {
      return fail('TOOL_NOT_FOUND', 'Tool is not registered');
    }
    const descriptor = definition.descriptor;

    if (!descriptor.permission.some((role) => context.actor.roles.includes(role))) {
      return fail('TOOL_FORBIDDEN', 'Actor role is not permitted for this tool', {
        causeCode: 'ROLE',
      });
    }
    if (!descriptor.supportedScenarios.includes(context.scenario)) {
      return fail('TOOL_NOT_ALLOWED', 'Tool is not enabled for this scenario', {
        causeCode: 'SCENARIO',
      });
    }
    if (!context.allowedToolNames.includes(descriptor.name)) {
      return fail('TOOL_NOT_ALLOWED', 'Tool is not enabled for this workflow step', {
        causeCode: 'ALLOWLIST',
      });
    }

    const argumentsResult = definition.argumentSchema.safeParse(args);
    if (!argumentsResult.success) {
      return fail('TOOL_INVALID_ARGUMENTS', 'Tool arguments failed schema validation');
    }
    const argumentBytes = serializedBytes(argumentsResult.data);
    if (argumentBytes > descriptor.maxArgumentBytes) {
      return fail(
        'TOOL_ARGUMENTS_TOO_LARGE',
        'Tool arguments exceed their size bound',
        {},
        { argumentBytes },
      );
    }

    const timeoutMs = Math.min(
      descriptor.timeoutMs,
      context.timeoutMsCap ?? descriptor.timeoutMs,
    );
    const callContext: ToolCallContext = {
      ...context,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };

    let output: unknown;
    try {
      output = await definition.execute(argumentsResult.data, callContext);
    } catch (error) {
      if (error instanceof EnterpriseClientError) {
        return fail(
          error.retryable ? 'TOOL_RETRYABLE_FAILURE' : 'TOOL_PERMANENT_FAILURE',
          error.retryable
            ? 'Enterprise dependency failed with a retryable error'
            : 'Enterprise dependency rejected the request',
          {
            retryable: error.retryable,
            causeCode: error.problemCode ?? error.code,
          },
          { argumentBytes },
        );
      }
      if (error instanceof ToolRegistryError) {
        throw error;
      }
      return fail('TOOL_PERMANENT_FAILURE', 'Tool execution failed', {
        retryable: false,
        causeCode: 'HANDLER_ERROR',
      });
    }

    const resultResult = definition.resultSchema.safeParse(output);
    if (!resultResult.success) {
      return fail(
        'TOOL_RESULT_INVALID',
        'Tool result failed schema validation',
        { retryable: false },
        { argumentBytes },
      );
    }
    const resultBytes = serializedBytes(resultResult.data);
    if (resultBytes > descriptor.maxResultBytes) {
      return fail(
        'TOOL_RESULT_TOO_LARGE',
        'Tool result exceeds its size bound',
        { retryable: false },
        { argumentBytes, resultBytes },
      );
    }
    const resultCount = definition.countResults(resultResult.data);
    if (
      !Number.isInteger(resultCount) ||
      resultCount < 0 ||
      resultCount > descriptor.maxResults
    ) {
      return fail(
        'TOOL_RESULT_LIMIT_EXCEEDED',
        'Tool result exceeds its item bound',
        { retryable: false },
        { argumentBytes, resultBytes, resultCount },
      );
    }
    if (
      typeof resultResult.data !== 'object' ||
      resultResult.data === null ||
      !('sandboxId' in resultResult.data) ||
      (resultResult.data as { sandboxId: unknown }).sandboxId !== context.sandboxId
    ) {
      return fail(
        'TOOL_SANDBOX_MISMATCH',
        'Tool result belongs to a different sandbox',
        { retryable: false },
        { argumentBytes, resultBytes, resultCount },
      );
    }

    const successTrace: ToolTrace = {
      ...trace,
      outcome: 'succeeded',
      errorCode: null,
      causeCode: null,
      retryable: null,
      durationMs: Date.now() - startedAt,
      argumentBytes,
      resultBytes,
      resultCount,
    };
    return {
      toolName: descriptor.name,
      output: resultResult.data,
      trace: successTrace,
    };
  }
}

export function createToolRegistry(
  definitions: readonly ToolDefinition[],
): ToolRegistryPort {
  return new ToolRegistry(definitions);
}

import type {
  RegisteredToolDefinition,
  ToolInvocationContext,
  ToolTrace,
} from '@nexus/contracts';

export interface ToolCallContext extends ToolInvocationContext {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionOptions {
  readonly signal?: AbortSignal;
}

export interface ToolExecutionOutcome {
  readonly toolName: string;
  readonly output: unknown;
  readonly trace: ToolTrace;
}

export interface ToolRegistryPort {
  listTools(): RegisteredToolDefinition[];
  executeTool(
    name: string,
    args: unknown,
    context: ToolInvocationContext,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionOutcome>;
}

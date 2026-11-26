import type { Actor, RequestContext, SandboxSummary } from '@nexus/contracts';

export interface SandboxResolver {
  getActiveSandbox(): Promise<SandboxSummary | null>;
}

export class SandboxUnavailableError extends Error {
  constructor(message = 'No active sandbox is available') {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export class SandboxInactiveError extends Error {
  constructor(message = 'The active sandbox is read-only') {
    super(message);
    this.name = 'SandboxInactiveError';
  }
}

export async function requireActiveSandbox(
  resolver: SandboxResolver,
): Promise<SandboxSummary> {
  const sandbox = await resolver.getActiveSandbox();
  if (!sandbox) {
    throw new SandboxUnavailableError();
  }
  return sandbox;
}

export async function requireActiveSandboxForMutation(
  resolver: SandboxResolver,
): Promise<SandboxSummary> {
  const sandbox = await requireActiveSandbox(resolver);
  if (sandbox.status !== 'active') {
    throw new SandboxInactiveError();
  }
  return sandbox;
}

export function requestContext(input: {
  requestId: string;
  correlationId: string;
  sandboxId: string;
  actor: Actor;
}): RequestContext {
  return {
    requestId: input.requestId,
    correlationId: input.correlationId,
    sandboxId: input.sandboxId,
    actor: input.actor,
  };
}

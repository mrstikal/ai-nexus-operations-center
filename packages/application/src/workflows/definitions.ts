import type { RunResumeCause, WaitReason } from '@nexus/contracts';

export type WorkflowStepKind = 'pure' | 'read' | 'external';
export type RedactedValue = string | number | boolean | null;
export type RedactedOutput = Record<string, RedactedValue>;

export type StepExecution =
  | {
      readonly status: 'succeeded';
      readonly output: RedactedOutput;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'waiting';
      readonly wait: WaitReason;
      readonly output?: RedactedOutput;
      readonly evidenceRefs?: readonly string[];
    }
  | {
      readonly status: 'retryable_failure';
      readonly errorClass: string;
      readonly output?: RedactedOutput;
      readonly evidenceRefs?: readonly string[];
    }
  | {
      readonly status: 'permanent_failure';
      readonly errorClass: string;
      readonly output?: RedactedOutput;
      readonly evidenceRefs?: readonly string[];
    };

export interface WorkflowStepContext {
  readonly runId: string;
  readonly sandboxId: string;
  readonly caseId: string;
  readonly stepKey: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly resumeCause: RunResumeCause | null;
  readonly ingress: Record<string, unknown>;
  readonly dependencies: Readonly<Record<string, RedactedOutput>>;
  readonly signal?: AbortSignal;
}

export interface WorkflowStepDefinition {
  readonly key: string;
  readonly kind: WorkflowStepKind;
  readonly dependsOn: readonly string[];
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly execute: (context: WorkflowStepContext) => Promise<StepExecution>;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly version: string;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly activeMsLimit?: number;
  readonly deadlineMs?: number;
  readonly policyRevision?: string;
  readonly modelRevision?: string;
  readonly configRevision?: string;
  readonly promptRevision?: string | null;
}

export interface WorkflowTrigger {
  readonly name: string;
  readonly version: string;
}

export type WorkflowTriggerMap = Readonly<Record<string, WorkflowTrigger>>;

export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowDefinitionError';
  }
}

const STEP_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/;
const OUTPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function assertRedactedOutput(output: RedactedOutput): void {
  const keys = Object.keys(output);
  if (keys.length > 20) {
    throw new WorkflowDefinitionError('Step output has too many fields');
  }
  for (const [key, value] of Object.entries(output)) {
    if (!OUTPUT_KEY_PATTERN.test(key)) {
      throw new WorkflowDefinitionError('Step output field name is invalid');
    }
    if (typeof value === 'string' && value.length > 500) {
      throw new WorkflowDefinitionError('Step output string exceeds its bound');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new WorkflowDefinitionError('Step output number must be finite');
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new WorkflowDefinitionError('Step output value is not a primitive');
    }
  }
}

function validateDefinition(definition: WorkflowDefinition): void {
  if (definition.name.length === 0 || definition.version.length === 0) {
    throw new WorkflowDefinitionError('Workflow definition name and version are required');
  }
  const keys = new Set<string>();
  for (const step of definition.steps) {
    if (!STEP_KEY_PATTERN.test(step.key)) {
      throw new WorkflowDefinitionError(`Invalid step key ${step.key}`);
    }
    if (keys.has(step.key)) {
      throw new WorkflowDefinitionError(`Duplicate step key ${step.key}`);
    }
    keys.add(step.key);
    if (step.kind !== 'pure' && step.kind !== 'read' && step.kind !== 'external') {
      throw new WorkflowDefinitionError(`Invalid step kind for ${step.key}`);
    }
    if (step.maxAttempts !== undefined) {
      if (
        step.kind === 'external'
          ? step.maxAttempts !== 1
          : step.maxAttempts < 1 || step.maxAttempts > 3
      ) {
        throw new WorkflowDefinitionError(
          `Step ${step.key} has an invalid attempt limit`,
        );
      }
    }
  }
  for (const step of definition.steps) {
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency)) {
        throw new WorkflowDefinitionError(
          `Step ${step.key} depends on unknown step ${dependency}`,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(definition.steps.map((step) => [step.key, step]));
  const visit = (key: string): void => {
    if (visited.has(key)) {
      return;
    }
    if (visiting.has(key)) {
      throw new WorkflowDefinitionError('Workflow definition contains a cycle');
    }
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const step of definition.steps) {
    visit(step.key);
  }
}

export class WorkflowDefinitionRegistry {
  readonly #definitions = new Map<string, WorkflowDefinition>();

  constructor(definitions: readonly WorkflowDefinition[]) {
    for (const definition of definitions) {
      validateDefinition(definition);
      const key = `${definition.name}:${definition.version}`;
      if (this.#definitions.has(key)) {
        throw new WorkflowDefinitionError(`Duplicate workflow definition ${key}`);
      }
      this.#definitions.set(key, definition);
    }
  }

  get(name: string, version: string): WorkflowDefinition | null {
    return this.#definitions.get(`${name}:${version}`) ?? null;
  }

  list(): WorkflowDefinition[] {
    return [...this.#definitions.values()];
  }
}

export const TEST_WORKFLOW_NAME = 'test-three-step';
export const TEST_WORKFLOW_VERSION = 'v1';
export const TEST_RETRY_DEFINITION_NAME = 'test-retry';
export const TEST_EXTERNAL_DEFINITION_NAME = 'test-external';
export const TEST_WAIT_DEFINITION_NAME = 'test-wait';

function deterministicDefinition(): WorkflowDefinition {
  return {
    name: TEST_WORKFLOW_NAME,
    version: TEST_WORKFLOW_VERSION,
    activeMsLimit: 300_000,
    deadlineMs: 2 * 60 * 60 * 1000,
    policyRevision: 'test-policy-v1',
    modelRevision: 'none',
    configRevision: 'f11-test-v1',
    promptRevision: null,
    steps: [
      {
        key: 'alpha',
        kind: 'pure',
        dependsOn: [],
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return {
            status: 'succeeded',
            output: { value: 'alpha' },
            evidenceRefs: [],
          };
        },
      },
      {
        key: 'beta',
        kind: 'pure',
        dependsOn: [],
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return {
            status: 'succeeded',
            output: { value: 'beta' },
            evidenceRefs: [],
          };
        },
      },
      {
        key: 'join',
        kind: 'pure',
        dependsOn: ['alpha', 'beta'],
        execute: async (context) => ({
          status: 'succeeded',
          output: {
            joined: `${String(context.dependencies['alpha']?.['value'])}|${String(
              context.dependencies['beta']?.['value'],
            )}`,
          },
          evidenceRefs: [],
        }),
      },
    ],
  };
}

function retryDefinition(): WorkflowDefinition {
  return {
    name: TEST_RETRY_DEFINITION_NAME,
    version: 'v1',
    activeMsLimit: 300_000,
    deadlineMs: 2 * 60 * 60 * 1000,
    policyRevision: 'test-policy-v1',
    modelRevision: 'none',
    configRevision: 'f11-test-v1',
    promptRevision: null,
    steps: [
      {
        key: 'flaky',
        kind: 'pure',
        dependsOn: [],
        maxAttempts: 3,
        execute: async () => ({
          status: 'retryable_failure',
          errorClass: 'TEST_TRANSIENT',
          output: { attempt: 'transient' },
          evidenceRefs: [],
        }),
      },
    ],
  };
}

function externalDefinition(): WorkflowDefinition {
  return {
    name: TEST_EXTERNAL_DEFINITION_NAME,
    version: 'v1',
    activeMsLimit: 300_000,
    deadlineMs: 2 * 60 * 60 * 1000,
    policyRevision: 'test-policy-v1',
    modelRevision: 'none',
    configRevision: 'f11-test-v1',
    promptRevision: null,
    steps: [
      {
        key: 'external',
        kind: 'external',
        dependsOn: [],
        maxAttempts: 1,
        execute: async () => ({
          status: 'retryable_failure',
          errorClass: 'EXTERNAL_TRANSIENT',
          output: { attempt: 'external' },
          evidenceRefs: [],
        }),
      },
    ],
  };
}

function waitDefinition(): WorkflowDefinition {
  return {
    name: TEST_WAIT_DEFINITION_NAME,
    version: 'v1',
    activeMsLimit: 300_000,
    deadlineMs: 2 * 60 * 60 * 1000,
    policyRevision: 'test-policy-v1',
    modelRevision: 'none',
    configRevision: 'f11-test-v1',
    promptRevision: null,
    steps: [
      {
        key: 'wait',
        kind: 'pure',
        dependsOn: [],
        execute: async (context) =>
          context.resumeCause === 'human_input'
            ? {
                status: 'succeeded',
                output: { resumed: true },
                evidenceRefs: [],
              }
            : {
                status: 'waiting',
                wait: { kind: 'human_input', prompt: 'Deterministic test wait' },
                output: { waiting: true },
                evidenceRefs: [],
              },
      },
    ],
  };
}

export function createTestWorkflowDefinitions(): WorkflowDefinition[] {
  return [
    deterministicDefinition(),
    retryDefinition(),
    externalDefinition(),
    waitDefinition(),
  ];
}

export function testDefinitionsEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env['NEXUS_WORKFLOW_TEST_DEFINITION'] === '1';
}

export function createDefaultWorkflowRegistry(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowDefinitionRegistry {
  return new WorkflowDefinitionRegistry(
    testDefinitionsEnabled(env) ? createTestWorkflowDefinitions() : [],
  );
}

export function createDefaultTriggerMap(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowTriggerMap {
  if (!testDefinitionsEnabled(env)) {
    return {};
  }
  return {
    'nexus.case.created.v1': {
      name: TEST_WORKFLOW_NAME,
      version: TEST_WORKFLOW_VERSION,
    },
  };
}

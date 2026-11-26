import { caseStatusForWorkflowStatus } from '../cases/state.js';
import {
  WorkflowDefinitionError,
  assertRedactedOutput,
  type StepExecution,
  type WorkflowDefinition,
  type WorkflowDefinitionRegistry,
  type WorkflowStepDefinition,
  type WorkflowTriggerMap,
} from './definitions.js';
import {
  LeaseLostError,
  type WorkflowJobClaim,
} from './leases.js';
import {
  computeOutputHash,
  computeStepInputHash,
  dependencyHashes,
  dependencyOutputs,
  type CommitStepInput,
  type JobAction,
  type WorkflowFaults,
  type WorkflowJournal,
  type WorkflowRunContext,
} from './journal.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_PARALLEL_STEPS,
  isTerminalWorkflowStatus,
  retryAllowedForKind,
  workflowRetryDelayMs,
  workflowStatusForWait,
} from './transitions.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_POLL_MS = 100;
const SCHEDULE_POLL_MS = 200;

export type WorkflowRunResultStatus =
  | 'idle'
  | 'completed'
  | 'waiting'
  | 'failed'
  | 'retry_scheduled'
  | 'budget_exhausted'
  | 'blocked'
  | 'lease_lost';

export interface WorkflowRunResult {
  readonly status: WorkflowRunResultStatus;
  readonly runId: string | null;
  readonly stepsExecuted: number;
}

export interface WorkflowRunnerOptions {
  readonly journal: WorkflowJournal;
  readonly registry: WorkflowDefinitionRegistry;
  readonly triggerMap: WorkflowTriggerMap;
  readonly ownerId: string;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly maxParallel?: number;
  readonly faults?: WorkflowFaults;
}

interface ExecutedStep {
  readonly step: WorkflowStepDefinition;
  readonly input: CommitStepInput;
}

class StepTimeoutError extends Error {
  constructor() {
    super('Workflow step timed out');
    this.name = 'StepTimeoutError';
  }
}

function dependenciesSucceeded(
  step: WorkflowStepDefinition,
  context: WorkflowRunContext,
): boolean {
  return step.dependsOn.every((dependency) => {
    return context.steps.get(dependency)?.status === 'succeeded';
  });
}

function readySteps(
  definition: WorkflowDefinition,
  context: WorkflowRunContext,
): WorkflowStepDefinition[] {
  return definition.steps.filter((step) => {
    const row = context.steps.get(step.key);
    if (!row) {
      return false;
    }
    if (
      row.status === 'succeeded' ||
      row.status === 'waiting' ||
      row.status === 'cancelled' ||
      row.status === 'permanent_failure'
    ) {
      return false;
    }
    return dependenciesSucceeded(step, context);
  });
}

function succeededInputMismatch(
  definition: WorkflowDefinition,
  context: WorkflowRunContext,
): string | null {
  for (const step of definition.steps) {
    const row = context.steps.get(step.key);
    if (row?.status !== 'succeeded') {
      continue;
    }
    const dependencies = dependencyHashes(definition, step.key, context.steps);
    const expected = computeStepInputHash({
      definitionName: definition.name,
      definitionVersion: definition.version,
      ingressHash: context.run.ingressHash,
      stepKey: step.key,
      dependencies,
    });
    if (row.inputHash !== expected) {
      return step.key;
    }
  }
  return null;
}

function failureInput(
  context: WorkflowRunContext,
  claim: WorkflowJobClaim,
  step: WorkflowStepDefinition,
  inputHash: string,
  attemptNo: number,
  maxAttempts: number,
  dependencies: { readonly key: string; readonly outputHash: string }[],
  errorClass: string,
  startedAt: Date,
  finishedAt: Date,
): CommitStepInput {
  return {
    claim,
    context,
    stepKey: step.key,
    stepKind: step.kind,
    inputHash,
    attemptNo,
    maxAttempts,
    outcomeStatus: retryAllowedForKind(step.kind) && attemptNo < maxAttempts
      ? 'retryable_failure'
      : 'permanent_failure',
    output: null,
    outputHash: null,
    evidenceRefs: [],
    errorClass: retryAllowedForKind(step.kind) && attemptNo < maxAttempts
      ? errorClass
      : step.kind === 'external'
        ? 'EXTERNAL_RETRY_FORBIDDEN'
        : errorClass,
    waitReason: null,
    runStatusAfter:
      retryAllowedForKind(step.kind) && attemptNo < maxAttempts
        ? 'running'
        : 'failed',
    jobAction:
      retryAllowedForKind(step.kind) && attemptNo < maxAttempts ? 'retry' : 'fail',
    retryAt:
      retryAllowedForKind(step.kind) && attemptNo < maxAttempts
        ? new Date(Date.now() + workflowRetryDelayMs(attemptNo))
        : null,
    caseStatusAfter: caseStatusForRun(
      retryAllowedForKind(step.kind) && attemptNo < maxAttempts
        ? 'running'
        : 'failed',
    ) ?? 'investigating',
    dependencyKeys: dependencies.map((dependency) => dependency.key),
    startedAt,
    finishedAt,
    activeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

function normalizeExecution(
  context: WorkflowRunContext,
  claim: WorkflowJobClaim,
  step: WorkflowStepDefinition,
  inputHash: string,
  attemptNo: number,
  maxAttempts: number,
  dependencies: { readonly key: string; readonly outputHash: string }[],
  execution: StepExecution,
  startedAt: Date,
  finishedAt: Date,
): CommitStepInput {
  const activeMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  if (execution.status === 'retryable_failure') {
    return failureInput(
      context,
      claim,
      step,
      inputHash,
      attemptNo,
      maxAttempts,
      dependencies,
      execution.errorClass,
      startedAt,
      finishedAt,
    );
  }
  if (execution.status === 'permanent_failure') {
    return {
      claim,
      context,
      stepKey: step.key,
      stepKind: step.kind,
      inputHash,
      attemptNo,
      maxAttempts,
      outcomeStatus: 'permanent_failure',
      output: execution.output ?? null,
      outputHash:
        execution.output === undefined ? null : computeOutputHash(execution.output),
      evidenceRefs: execution.evidenceRefs ?? [],
      errorClass: execution.errorClass,
      waitReason: null,
      runStatusAfter: 'failed',
      jobAction: 'fail',
      retryAt: null,
      caseStatusAfter: caseStatusForRun('failed') ?? 'escalated',
      dependencyKeys: dependencies.map((dependency) => dependency.key),
      startedAt,
      finishedAt,
      activeMs,
    };
  }
  if (execution.status === 'waiting') {
    return {
      claim,
      context,
      stepKey: step.key,
      stepKind: step.kind,
      inputHash,
      attemptNo,
      maxAttempts,
      outcomeStatus: 'waiting',
      output: execution.output ?? null,
      outputHash:
        execution.output === undefined ? null : computeOutputHash(execution.output),
      evidenceRefs: execution.evidenceRefs ?? [],
      errorClass: null,
      waitReason: execution.wait,
      runStatusAfter: workflowStatusForWait(execution.wait),
      jobAction: 'wait',
      retryAt: null,
      caseStatusAfter: caseStatusForRun(execution.wait.kind === 'approval'
        ? 'waiting_approval'
        : execution.wait.kind === 'dependency'
          ? 'waiting_dependency'
          : 'waiting_input') ?? 'investigating',
      dependencyKeys: dependencies.map((dependency) => dependency.key),
      startedAt,
      finishedAt,
      activeMs,
    };
  }
  return {
    claim,
    context,
    stepKey: step.key,
    stepKind: step.kind,
    inputHash,
    attemptNo,
    maxAttempts,
    outcomeStatus: 'succeeded',
    output: execution.output,
    outputHash: computeOutputHash(execution.output),
    evidenceRefs: execution.evidenceRefs,
    errorClass: null,
    waitReason: null,
    runStatusAfter: 'running',
    jobAction: 'continue',
    retryAt: null,
    caseStatusAfter: caseStatusForRun('running') ?? 'investigating',
    dependencyKeys: dependencies.map((dependency) => dependency.key),
    startedAt,
    finishedAt,
    activeMs,
  };
}

async function executeStep(
  options: WorkflowRunnerOptions,
  definition: WorkflowDefinition,
  context: WorkflowRunContext,
  claim: WorkflowJobClaim,
  step: WorkflowStepDefinition,
): Promise<ExecutedStep> {
  const row = context.steps.get(step.key);
  if (!row) {
    throw new WorkflowDefinitionError(`Missing persisted step ${step.key}`);
  }
  const maxAttempts =
    step.kind === 'external' ? 1 : (step.maxAttempts ?? row.maxAttempts);
  const attemptNo = row.attemptCount + 1;
  const dependencies = dependencyHashes(definition, step.key, context.steps);
  const inputHash = computeStepInputHash({
    definitionName: definition.name,
    definitionVersion: definition.version,
    ingressHash: context.run.ingressHash,
    stepKey: step.key,
    dependencies,
  });
  const startedAt = new Date();

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new StepTimeoutError());
    }, timeoutMs);
  });
  const executionPromise = step
    .execute({
      runId: context.run.id,
      sandboxId: context.run.sandboxId,
      caseId: context.run.caseId,
      stepKey: step.key,
      attempt: attemptNo,
      inputHash,
      resumeCause: context.run.resumeCause,
      ingress: context.run.ingress,
      dependencies: dependencyOutputs(definition, step.key, context.steps),
      signal: controller.signal,
    })
    .catch((error: unknown) => {
      const errorClass =
        error instanceof Error && error.name === 'StepTimeoutError'
          ? 'STEP_TIMEOUT'
          : 'STEP_ERROR';
      return {
        status: 'retryable_failure',
        errorClass,
        evidenceRefs: [],
      } satisfies StepExecution;
    });
  executionPromise.catch(() => undefined);

  let execution: StepExecution;
  try {
    execution = await Promise.race([executionPromise, timeoutPromise]);
  } catch (error) {
    const errorClass =
      error instanceof StepTimeoutError
        ? 'STEP_TIMEOUT'
        : error instanceof Error && error.name === 'StepTimeoutError'
          ? 'STEP_TIMEOUT'
          : 'STEP_ERROR';
    execution = {
      status: 'retryable_failure',
      errorClass,
      evidenceRefs: [],
    };
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
  const finishedAt = new Date();

  if (execution.status === 'succeeded') {
    try {
      assertRedactedOutput(execution.output);
    } catch {
      return {
        step,
        input: {
          ...failureInput(
            context,
            claim,
            step,
            inputHash,
            attemptNo,
            maxAttempts,
            dependencies,
            'INVALID_OUTPUT',
            startedAt,
            finishedAt,
          ),
          outcomeStatus: 'permanent_failure',
          runStatusAfter: 'failed',
          jobAction: 'fail',
        },
      };
    }
  }
  if (
    execution.evidenceRefs !== undefined &&
    execution.evidenceRefs.some((reference) => !UUID_PATTERN.test(reference))
  ) {
    return {
      step,
      input: {
        ...failureInput(
          context,
          claim,
          step,
          inputHash,
          attemptNo,
          maxAttempts,
          dependencies,
          'INVALID_EVIDENCE_REF',
          startedAt,
          finishedAt,
        ),
        outcomeStatus: 'permanent_failure',
        runStatusAfter: 'failed',
        jobAction: 'fail',
      },
    };
  }
  return {
    step,
    input: normalizeExecution(
      context,
      claim,
      step,
      inputHash,
      attemptNo,
      maxAttempts,
      dependencies,
      execution,
      startedAt,
      finishedAt,
    ),
  };
}

function caseStatusForRun(status: string): ReturnType<typeof caseStatusForWorkflowStatus> {
  return caseStatusForWorkflowStatus(status as Parameters<typeof caseStatusForWorkflowStatus>[0]) ?? 'investigating';
}

function resultForRunStatus(status: string): WorkflowRunResultStatus {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'budget_exhausted') {
    return 'budget_exhausted';
  }
  if (
    status === 'waiting_input' ||
    status === 'waiting_approval' ||
    status === 'waiting_dependency'
  ) {
    return 'waiting';
  }
  if (status === 'blocked') {
    return 'blocked';
  }
  return 'failed';
}

function resultForJobAction(jobAction: JobAction): WorkflowRunResultStatus {
  switch (jobAction) {
    case 'continue':
      return 'idle';
    case 'retry':
      return 'retry_scheduled';
    case 'wait':
      return 'waiting';
    case 'fail':
      return 'failed';
  }
}

export class WorkflowRunner {
  readonly #options: Required<
    Pick<WorkflowRunnerOptions, 'leaseMs' | 'heartbeatMs' | 'maxParallel'>
  > &
    WorkflowRunnerOptions;
  #running = false;
  #stopSignal: Promise<void>;
  #stopResolve: (() => void) | null = null;
  #scheduleLoop: Promise<void> | null = null;
  #runLoop: Promise<void> | null = null;

  constructor(options: WorkflowRunnerOptions) {
    this.#options = {
      ...options,
      leaseMs: options.leaseMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? 5_000,
      maxParallel: options.maxParallel ?? MAX_PARALLEL_STEPS,
    };
    this.#stopSignal = new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
    });
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#scheduleLoop = this.#schedule();
    this.#runLoop = this.#execute();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopResolve?.();
    await Promise.allSettled([
      this.#scheduleLoop ?? Promise.resolve(),
      this.#runLoop ?? Promise.resolve(),
    ]);
  }

  async schedulePendingInbox(limit = 10): Promise<number> {
    const outcomes = await this.#options.journal.schedulePendingInbox({
      triggerMap: this.#options.triggerMap,
      registry: this.#options.registry,
      limit,
    });
    return outcomes.length;
  }

  async runOnce(): Promise<WorkflowRunResult> {
    const claim = await this.#options.journal.claimJob(
      this.#options.ownerId,
      this.#options.leaseMs,
    );
    if (!claim) {
      return { status: 'idle', runId: null, stepsExecuted: 0 };
    }
    let heartbeatLost = false;
    const heartbeat = setInterval(() => {
      void this.#options.journal
        .heartbeat(claim, this.#options.leaseMs)
        .then((held) => {
          if (!held) {
            heartbeatLost = true;
          }
        })
        .catch(() => {
          heartbeatLost = true;
        });
    }, this.#options.heartbeatMs);
    heartbeat.unref();
    let stepsExecuted = 0;
    try {
      await this.#options.faults?.at({ point: 'after_claim', claim });
      let context = await this.#options.journal.markRunning(
        claim,
        caseStatusForRun('running') ?? 'investigating',
      );
      const definition = this.#options.registry.get(
        context.run.definitionName,
        context.run.definitionVersion,
      );
      if (!definition) {
        await this.#options.journal.markBlocked(
          claim,
          context,
          'UNKNOWN_DEFINITION',
          caseStatusForRun('blocked') ?? 'investigating',
        );
        return { status: 'blocked', runId: claim.runId, stepsExecuted };
      }
      if (await this.#budgetExhausted(claim, context)) {
        return { status: 'budget_exhausted', runId: claim.runId, stepsExecuted };
      }

      while (true) {
        if (heartbeatLost) {
          throw new LeaseLostError();
        }
        context = await this.#options.journal.loadContext(claim);
        const mismatch = succeededInputMismatch(definition, context);
        if (mismatch !== null) {
          await this.#options.journal.markBlocked(
            claim,
            context,
            `STEP_INPUT_CHANGED:${mismatch}`.slice(0, 100),
            caseStatusForRun('blocked') ?? 'investigating',
          );
          return { status: 'blocked', runId: claim.runId, stepsExecuted };
        }
        const runResult = await this.#finalizeOrContinue(claim, context);
        if (runResult) {
          return { ...runResult, stepsExecuted };
        }
        const ready = readySteps(definition, context).slice(
          0,
          this.#options.maxParallel,
        );
        if (ready.length === 0) {
          const failed = [...context.steps.values()].find(
            (step) => step.status === 'permanent_failure',
          );
          if (failed) {
            await this.#options.journal.completeJob({
              claim,
              runStatus: 'failed',
              jobState: 'failed',
              errorClass: failed.errorClass,
              caseStatusAfter:
                caseStatusForWorkflowStatus('failed') ?? 'escalated',
            });
            return { status: 'failed', runId: claim.runId, stepsExecuted };
          }
          await this.#options.journal.markBlocked(
            claim,
            context,
            'NO_READY_STEP',
            caseStatusForRun('blocked') ?? 'investigating',
          );
          return { status: 'blocked', runId: claim.runId, stepsExecuted };
        }
        if (await this.#budgetExhausted(claim, context)) {
          return { status: 'budget_exhausted', runId: claim.runId, stepsExecuted };
        }

        const executed = await Promise.all(
          ready.map((step) =>
            executeStep(this.#options, definition, context, claim, step),
          ),
        );
        const successes = executed.filter(
          (item) => item.input.outcomeStatus === 'succeeded',
        );
        const failures = executed.filter(
          (item) => item.input.outcomeStatus !== 'succeeded',
        );
        for (const item of successes) {
          await this.#options.faults?.at({
            point: 'before_step_commit',
            claim,
            stepKey: item.step.key,
          });
          const committed = await this.#options.journal.commitStep(item.input);
          stepsExecuted += 1;
          if (committed.runStatus === 'budget_exhausted') {
            return { status: 'budget_exhausted', runId: claim.runId, stepsExecuted };
          }
          if (committed.jobState !== 'leased') {
            return {
              status: committed.runStatus === 'failed' ? 'failed' : 'waiting',
              runId: claim.runId,
              stepsExecuted,
            };
          }
          await this.#options.faults?.at({
            point: 'after_step_commit',
            claim,
            stepKey: item.step.key,
          });
        }
        if (failures.length > 0) {
          const failure = failures[0];
          if (!failure) {
            return { status: 'failed', runId: claim.runId, stepsExecuted };
          }
          await this.#options.faults?.at({
            point: 'before_step_commit',
            claim,
            stepKey: failure.step.key,
          });
          const committed = await this.#options.journal.commitStep(failure.input);
          stepsExecuted += 1;
          await this.#options.faults?.at({
            point: 'after_step_commit',
            claim,
            stepKey: failure.step.key,
          });
          if (committed.runStatus === 'budget_exhausted') {
            return { status: 'budget_exhausted', runId: claim.runId, stepsExecuted };
          }
          if (committed.runStatus === 'failed' || committed.jobState === 'failed') {
            return { status: 'failed', runId: claim.runId, stepsExecuted };
          }
          if (committed.jobState === 'pending') {
            return { status: 'retry_scheduled', runId: claim.runId, stepsExecuted };
          }
          if (committed.jobState === 'succeeded') {
            return { status: 'waiting', runId: claim.runId, stepsExecuted };
          }
          return {
            status: resultForJobAction(failure.input.jobAction),
            runId: claim.runId,
            stepsExecuted,
          };
        }
      }
    } catch (error) {
      if (
        error instanceof LeaseLostError ||
        (error instanceof Error && error.name === 'LeaseLostError')
      ) {
        return { status: 'lease_lost', runId: claim.runId, stepsExecuted };
      }
      if (
        error instanceof Error &&
        error.name === 'WorkflowBudgetExhaustedError'
      ) {
        return { status: 'budget_exhausted', runId: claim.runId, stepsExecuted };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #budgetExhausted(
    claim: WorkflowJobClaim,
    context: WorkflowRunContext,
  ): Promise<boolean> {
    const now = await this.#options.journal.currentTime();
    const deadlineExceeded = now.getTime() >= context.run.deadlineAt.getTime();
    const activeExceeded = context.run.activeMsUsed >= context.run.activeMsLimit;
    if (deadlineExceeded || activeExceeded) {
      await this.#options.journal.markBudgetExhausted(
        claim,
        context,
        deadlineExceeded ? 'DEADLINE_EXCEEDED' : 'ACTIVE_LIMIT_EXCEEDED',
        caseStatusForRun('budget_exhausted') ?? 'escalated',
      );
      return true;
    }
    return false;
  }

  async #finalizeOrContinue(
    claim: WorkflowJobClaim,
    context: WorkflowRunContext,
  ): Promise<Omit<WorkflowRunResult, 'stepsExecuted'> | null> {
    if (
      context.run.status === 'waiting_input' ||
      context.run.status === 'waiting_approval' ||
      context.run.status === 'waiting_dependency'
    ) {
      const completed = await this.#options.journal.completeJob({
        claim,
        runStatus: context.run.status,
        jobState: 'succeeded',
        caseStatusAfter: caseStatusForRun(context.run.status) ?? 'investigating',
      });
      return { status: resultForRunStatus(completed.runStatus), runId: claim.runId };
    }
    if (isTerminalWorkflowStatus(context.run.status)) {
      const completed = await this.#options.journal.completeJob({
        claim,
        runStatus: context.run.status,
        jobState:
          context.run.status === 'completed' ? 'succeeded' : 'failed',
        caseStatusAfter: caseStatusForRun(context.run.status) ?? 'escalated',
      });
      return { status: resultForRunStatus(completed.runStatus), runId: claim.runId };
    }
    if (context.run.status === 'blocked') {
      await this.#options.journal.markBlocked(
        claim,
        context,
        'DEFINITION_BLOCKED',
        caseStatusForRun('blocked') ?? 'investigating',
      );
      return { status: 'blocked', runId: claim.runId };
    }
    if (
      context.run.cancelRequested ||
      context.run.status === 'cancel_requested' ||
      context.run.status === 'cancelled'
    ) {
      const completed = await this.#options.journal.completeJob({
        claim,
        runStatus: 'cancelled',
        jobState: 'cancelled',
        caseStatusAfter: caseStatusForRun('cancelled') ?? 'cancelled',
      });
      return { status: resultForRunStatus(completed.runStatus), runId: claim.runId };
    }
    if (await this.#budgetExhausted(claim, context)) {
      return { status: 'budget_exhausted', runId: claim.runId };
    }
    const allSucceeded = [...context.steps.values()].every(
      (step) => step.status === 'succeeded',
    );
    if (allSucceeded && context.steps.size > 0) {
      const completed = await this.#options.journal.completeJob({
        claim,
        runStatus: 'completed',
        jobState: 'succeeded',
        caseStatusAfter: caseStatusForRun('completed') ?? 'resolved',
      });
      await this.#options.faults?.at({ point: 'after_run_complete', claim });
      return { status: resultForRunStatus(completed.runStatus), runId: claim.runId };
    }
    return null;
  }

  async #schedule(): Promise<void> {
    while (this.#running) {
      try {
        await this.schedulePendingInbox();
      } catch {
        // The next tick retries; scheduler failures are visible in logs later.
      }
      await this.#wait(SCHEDULE_POLL_MS);
    }
  }

  async #execute(): Promise<void> {
    while (this.#running) {
      try {
        const result = await this.runOnce();
        if (result.status === 'idle' || result.status === 'lease_lost') {
          await this.#wait(RUN_POLL_MS);
        }
      } catch {
        await this.#wait(RUN_POLL_MS * 5);
      }
    }
  }

  async #wait(milliseconds: number): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      this.#stopSignal,
    ]);
  }
}

import { describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionError,
  WorkflowDefinitionRegistry,
  assertRedactedOutput,
  createTestWorkflowDefinitions,
} from '@nexus/application/workflows/definitions';
import {
  computeOutputHash,
  computeStepInputHash,
} from '@nexus/application/workflows/journal';
import {
  assertLeaseActive,
  LeaseLostError,
  nextFencingToken,
} from '@nexus/application/workflows/leases';
import {
  maxAttemptsForKind,
  workflowRetryDelayMs,
} from '@nexus/application/workflows/transitions';

describe('F11 workflow definitions and fences', () => {
  it('rejects duplicate, missing and cyclic step dependencies', () => {
    expect(
      () =>
        new WorkflowDefinitionRegistry([
          {
            name: 'bad',
            version: 'v1',
            steps: [
              { key: 'a', kind: 'pure', dependsOn: [], execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
              { key: 'a', kind: 'pure', dependsOn: [], execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
            ],
          },
        ]),
    ).toThrow(WorkflowDefinitionError);
    expect(
      () =>
        new WorkflowDefinitionRegistry([
          {
            name: 'bad',
            version: 'v1',
            steps: [
              { key: 'a', kind: 'pure', dependsOn: ['missing'], execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
            ],
          },
        ]),
    ).toThrow('unknown step');
    expect(
      () =>
        new WorkflowDefinitionRegistry([
          {
            name: 'bad',
            version: 'v1',
            steps: [
              { key: 'a', kind: 'pure', dependsOn: ['b'], execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
              { key: 'b', kind: 'pure', dependsOn: ['a'], execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
            ],
          },
        ]),
    ).toThrow('cycle');
  });

  it('rejects attempt limits above three or above one for external steps', () => {
    expect(
      () =>
        new WorkflowDefinitionRegistry([
          {
            name: 'bad-attempts',
            version: 'v1',
            steps: [
              { key: 'a', kind: 'pure', dependsOn: [], maxAttempts: 4, execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
            ],
          },
        ]),
    ).toThrow('attempt limit');
    expect(
      () =>
        new WorkflowDefinitionRegistry([
          {
            name: 'bad-external',
            version: 'v1',
            steps: [
              { key: 'a', kind: 'external', dependsOn: [], maxAttempts: 2, execute: async () => ({ status: 'succeeded', output: {}, evidenceRefs: [] }) },
            ],
          },
        ]),
    ).toThrow('attempt limit');
  });

  it('keeps the three-step test definition deterministic and bounded', () => {
    const registry = new WorkflowDefinitionRegistry(createTestWorkflowDefinitions());
    const definition = registry.get('test-three-step', 'v1');
    expect(definition).not.toBeNull();
    expect(definition?.steps.map((step) => step.key)).toEqual(['alpha', 'beta', 'join']);
    expect(definition?.steps[2]?.dependsOn).toEqual(['alpha', 'beta']);
    expect(registry.get('test-three-step', 'v9')).toBeNull();
  });

  it('computes a dependency-order-independent input hash', () => {
    const left = computeStepInputHash({
      definitionName: 'test-three-step',
      definitionVersion: 'v1',
      ingressHash: 'a'.repeat(64),
      stepKey: 'join',
      dependencies: [
        { key: 'beta', outputHash: 'b'.repeat(64) },
        { key: 'alpha', outputHash: 'c'.repeat(64) },
      ],
    });
    const right = computeStepInputHash({
      definitionName: 'test-three-step',
      definitionVersion: 'v1',
      ingressHash: 'a'.repeat(64),
      stepKey: 'join',
      dependencies: [
        { key: 'alpha', outputHash: 'c'.repeat(64) },
        { key: 'beta', outputHash: 'b'.repeat(64) },
      ],
    });
    expect(left).toBe(right);
    expect(computeOutputHash({ joined: 'alpha|beta' })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the bounded retry schedule and forbids external retries', () => {
    expect([1, 2, 3, 4].map(workflowRetryDelayMs)).toEqual([1_000, 5_000, 30_000, 30_000]);
    expect(maxAttemptsForKind('pure')).toBe(3);
    expect(maxAttemptsForKind('read')).toBe(3);
    expect(maxAttemptsForKind('external')).toBe(1);
    expect(nextFencingToken(4)).toBe(5);
  });

  it('rejects expired claims and invalid redacted outputs', () => {
    expect(() =>
      assertLeaseActive(
        {
          jobId: 'job',
          sandboxId: 'sandbox',
          runId: 'run',
          leaseOwner: 'owner',
          leaseExpiresAt: new Date(0),
          fencingToken: 1,
          attemptCount: 1,
        },
        new Date(1),
      ),
    ).toThrow(LeaseLostError);
    expect(() =>
      assertRedactedOutput({ nested: { value: 1 } as never }),
    ).toThrow(WorkflowDefinitionError);
    expect(() =>
      assertRedactedOutput({ tooLong: 'x'.repeat(501) }),
    ).toThrow(WorkflowDefinitionError);
    expect(() => assertRedactedOutput({ ok: 'value', count: 1 })).not.toThrow();
  });
});

import type { ActionPlanItem } from '@nexus/contracts';
import {
  computeActionItemHash,
  computePlanHash as domainComputePlanHash,
} from '@nexus/domain/actions/item-hash';

export { computeActionItemHash };

export interface RevisionHashInput {
  readonly items: readonly ActionPlanItem[];
  readonly policyRevision: string;
  readonly policyContentHash: string;
}

export function computePlanHash(input: RevisionHashInput): string {
  return domainComputePlanHash(input);
}

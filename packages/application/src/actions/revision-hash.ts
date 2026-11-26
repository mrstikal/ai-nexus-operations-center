import type { ActionPlanItem } from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';

export const ACTION_REVISION_HASH_VERSION = 1;
export const ACTION_CATALOG_VERSION = 1;

export interface RevisionHashInput {
  readonly items: readonly ActionPlanItem[];
  readonly policyRevision: string;
  readonly policyContentHash: string;
}

function normalizedItem(item: ActionPlanItem): unknown {
  return {
    itemId: item.itemId,
    target: {
      system: item.target.system,
      type: item.target.type,
      id: item.target.id,
      version: item.target.version,
    },
    dependsOnItemIds: [...item.dependsOnItemIds].sort(),
    baseExpectedVersions: [...item.baseExpectedVersions]
      .map((ref) => ({
        system: ref.system,
        type: ref.type,
        id: ref.id,
        version: ref.version,
      }))
      .sort((left, right) => {
        const leftKey = `${left.system}\u0000${left.type}\u0000${left.id}\u0000${left.version}`;
        const rightKey = `${right.system}\u0000${right.type}\u0000${right.id}\u0000${right.version}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    evidenceIds: [...item.evidenceIds].sort(),
    payload: item.payload,
  };
}

export function computeActionItemHash(item: ActionPlanItem): string {
  return canonicalJsonSha256({
    version: ACTION_REVISION_HASH_VERSION,
    catalogVersion: ACTION_CATALOG_VERSION,
    item: normalizedItem(item),
  });
}

export function computePlanHash(input: RevisionHashInput): string {
  return canonicalJsonSha256({
    version: ACTION_REVISION_HASH_VERSION,
    catalogVersion: ACTION_CATALOG_VERSION,
    policy: {
      revision: input.policyRevision,
      contentHash: input.policyContentHash,
    },
    itemHashes: input.items.map(computeActionItemHash).sort(),
  });
}

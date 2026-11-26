import type { ActionPlanItem, EntityRef } from '@nexus/contracts';
import { enterpriseReferencesForPayload } from '@nexus/domain/policies/action-validation';

export interface OpenProposalRevision {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly planHash: string;
  readonly items: readonly ActionPlanItem[];
}

export interface ExpireProposalRevisionInput {
  readonly sandboxId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly entityRef: EntityRef;
  readonly changedFields: readonly string[];
  readonly originatingRevisionId: string | null;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface ProposalInvalidationStore {
  listOpenProposalRevisions(sandboxId: string): Promise<OpenProposalRevision[]>;
  expireProposalRevision(input: ExpireProposalRevisionInput): Promise<boolean>;
}

export interface InvalidateProposalsInput {
  readonly sandboxId: string;
  readonly entityRef: EntityRef;
  readonly changedFields: readonly string[];
  readonly originatingRevisionId: string | null;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface InvalidationResult {
  readonly expiredProposalIds: string[];
}

export async function invalidateAffectedProposals(
  store: ProposalInvalidationStore,
  input: InvalidateProposalsInput,
): Promise<InvalidationResult> {
  const open = await store.listOpenProposalRevisions(input.sandboxId);
  const affected = open.filter((revision) =>
    revisionUsesEntity(revision.items, input.entityRef),
  );
  const expiredProposalIds: string[] = [];
  for (const revision of affected) {
    const expired = await store.expireProposalRevision({
      sandboxId: input.sandboxId,
      proposalId: revision.proposalId,
      revisionId: revision.revisionId,
      entityRef: input.entityRef,
      changedFields: input.changedFields,
      originatingRevisionId: input.originatingRevisionId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    if (expired) {
      expiredProposalIds.push(revision.proposalId);
    }
  }
  return { expiredProposalIds };
}

export function revisionUsesEntity(
  items: readonly ActionPlanItem[],
  entityRef: EntityRef,
): boolean {
  for (const item of items) {
    if (sameRef(item.target, entityRef)) {
      return true;
    }
    if (item.baseExpectedVersions.some((ref) => sameRef(ref, entityRef))) {
      return true;
    }
    if (payloadRefs(item).some((ref) => sameRef(ref, entityRef))) {
      return true;
    }
  }
  return false;
}

function sameRef(left: EntityRef, right: EntityRef): boolean {
  return (
    left.system === right.system &&
    left.type === right.type &&
    left.id === right.id
  );
}

function payloadRefs(item: ActionPlanItem): EntityRef[] {
  if (item.payload.kind === 'case.add_internal_note') {
    return [
      {
        system: 'nexus',
        type: 'case',
        id: item.payload.caseId,
        version: 0,
      },
    ];
  }
  return enterpriseReferencesForPayload(item.payload).map((ref) => ({
    system: 'enterprise',
    type: ref.type,
    id: ref.id,
    version: 0,
  }));
}

import {
  KnowledgeDocumentSchema,
  KnowledgePublicationResponseSchema,
  KnowledgeVersionSchema,
  type KnowledgeDocument,
  type KnowledgeDocumentKind,
  type KnowledgePublicationResponse,
  type KnowledgeVersion,
  type KnowledgeVersionState,
} from '@nexus/contracts';
import type { PolicyBundleSource } from '../actions/policy-source.js';
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
} from './errors.js';

export interface KnowledgeVersionSnapshot {
  readonly id: string;
  readonly versionNo: number;
  readonly state: KnowledgeVersionState;
  readonly contentSha256: string;
  readonly sourcePath: string;
  readonly policyBundleVersion: string | null;
  readonly policyContentHash: string | null;
}

export interface KnowledgeDocumentSnapshot {
  readonly document: KnowledgeDocument;
  readonly kind: KnowledgeDocumentKind;
  readonly versions: readonly KnowledgeVersionSnapshot[];
}

export interface PublishKnowledgeVersionInput {
  readonly sandboxId: string;
  readonly documentId: string;
  readonly versionId: string | null;
  readonly actorId: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface RevokeKnowledgeVersionInput {
  readonly sandboxId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly reason: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface KnowledgePublicationResult {
  readonly document: KnowledgeDocument;
  readonly version: KnowledgeVersion;
  readonly retrievalGeneration: number;
  readonly expiredProposalIds: readonly string[];
  readonly changed: boolean;
}

export type KnowledgePublicationStoreResult =
  | { readonly ok: true; readonly value: KnowledgePublicationResult }
  | {
      readonly ok: false;
      readonly conflict: 'NO_DRAFT' | 'NO_PUBLISHED_VERSION';
    };

export interface KnowledgePublishStore {
  getActiveSandbox(): Promise<string | null>;
  loadDocument(
    sandboxId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentSnapshot | null>;
  publishVersion(
    input: PublishKnowledgeVersionInput,
  ): Promise<KnowledgePublicationStoreResult>;
  revokeVersion(
    input: RevokeKnowledgeVersionInput,
  ): Promise<KnowledgePublicationStoreResult>;
}

function latestVersion(
  versions: readonly KnowledgeVersionSnapshot[],
  state: KnowledgeVersionState,
): KnowledgeVersionSnapshot | null {
  const matching = versions
    .filter((version) => version.state === state)
    .sort((left, right) => right.versionNo - left.versionNo);
  return matching[0] ?? null;
}

function publicationResponse(
  result: KnowledgePublicationResult,
): KnowledgePublicationResponse {
  return KnowledgePublicationResponseSchema.parse({
    document: KnowledgeDocumentSchema.parse(result.document),
    version: KnowledgeVersionSchema.parse(result.version),
    retrievalGeneration: result.retrievalGeneration,
    changed: result.changed,
    expiredProposalIds: [...result.expiredProposalIds],
  });
}

export class KnowledgePublishService {
  constructor(
    private readonly store: KnowledgePublishStore,
    private readonly policySource: PolicyBundleSource,
  ) {}

  async publish(input: {
    readonly sandboxId: string | null;
    readonly documentId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<KnowledgePublicationResponse> {
    const sandboxId = input.sandboxId ?? (await this.store.getActiveSandbox());
    if (sandboxId === null) {
      throw new KnowledgeNotFoundError('No active sandbox exists');
    }
    const snapshot = await this.store.loadDocument(sandboxId, input.documentId);
    if (!snapshot) {
      throw new KnowledgeNotFoundError();
    }
    const draft = latestVersion(snapshot.versions, 'draft');
    if (draft !== null && snapshot.kind === 'policy') {
      const loaded = await this.policySource.load();
      if (
        draft.sourcePath !== loaded.bundle.canonicalText.path ||
        draft.contentSha256 !== loaded.canonicalTextHash ||
        draft.policyBundleVersion !== loaded.bundle.revision ||
        draft.policyContentHash !== loaded.contentHash
      ) {
        throw new KnowledgeConflictError(
          'POLICY_MISMATCH',
          'Knowledge text does not match the canonical policy bundle',
        );
      }
    }
    const result = await this.store.publishVersion({
      sandboxId,
      documentId: input.documentId,
      versionId: draft?.id ?? null,
      actorId: input.actorId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    if (!result.ok) {
      throw new KnowledgeConflictError(
        result.conflict,
        result.conflict === 'NO_DRAFT'
          ? 'No draft knowledge version is available for publication'
          : 'No published knowledge version matches the revocation',
      );
    }
    return publicationResponse(result.value);
  }

  async revoke(input: {
    readonly sandboxId: string | null;
    readonly documentId: string;
    readonly versionId: string | null;
    readonly reason: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<KnowledgePublicationResponse> {
    const sandboxId = input.sandboxId ?? (await this.store.getActiveSandbox());
    if (sandboxId === null) {
      throw new KnowledgeNotFoundError('No active sandbox exists');
    }
    const snapshot = await this.store.loadDocument(sandboxId, input.documentId);
    if (!snapshot) {
      throw new KnowledgeNotFoundError();
    }
    const target =
      input.versionId === null
        ? latestVersion(snapshot.versions, 'published')
        : (snapshot.versions.find(
            (version) =>
              version.id === input.versionId && version.state === 'published',
          ) ?? null);
    if (target === null) {
      throw new KnowledgeConflictError(
        'NO_PUBLISHED_VERSION',
        'No published knowledge version matches the revocation',
      );
    }
    const result = await this.store.revokeVersion({
      sandboxId,
      documentId: input.documentId,
      versionId: target.id,
      reason: input.reason,
      actorId: input.actorId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    if (!result.ok) {
      throw new KnowledgeConflictError(
        result.conflict,
        'No published knowledge version matches the revocation',
      );
    }
    return publicationResponse(result.value);
  }
}

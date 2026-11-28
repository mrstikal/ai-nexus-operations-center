import { randomUUID } from 'node:crypto';
import {
  KnowledgeChunkLocatorSchema,
  KnowledgeSearchResponseSchema,
  type KnowledgeChunk,
  type KnowledgeDocumentKind,
  type KnowledgeSearchResponse,
} from '@nexus/contracts';
import type {
  KnowledgeRetriever,
  KnowledgeSearchOutcome,
  KnowledgeSearchQuery,
} from '../ports/knowledge.js';
import {
  KnowledgeNotFoundError,
  KnowledgeValidationError,
} from './errors.js';

export interface KnowledgeSearchRow {
  readonly id: string;
  readonly documentVersionId: string;
  readonly policyBundleVersion: string | null;
  readonly text: string;
  readonly locator: unknown;
  readonly score: number;
  readonly evidenceId: string;
}

export interface KnowledgeSearchStore {
  getActiveSandbox(): Promise<string | null>;
  searchChunks(input: {
    readonly sandboxId: string;
    readonly query: string;
    readonly limit: number;
    readonly effectiveAt: string;
    readonly policyId?: string;
    readonly kind?: KnowledgeDocumentKind;
  }): Promise<KnowledgeSearchRow[]>;
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 6;
const MAX_QUERY_CODE_POINTS = 500;

function normaliseScore(score: number): number {
  if (!Number.isFinite(score) || score < 0) {
    return 0;
  }
  return Math.round(score * 1_000_000) / 1_000_000;
}

export class LexicalKnowledgeRetriever implements KnowledgeRetriever {
  constructor(private readonly store: KnowledgeSearchStore) {}

  async search(input: KnowledgeSearchQuery): Promise<KnowledgeSearchOutcome> {
    const query = input.query.trim();
    if (query.length === 0) {
      throw new KnowledgeValidationError('Search query must not be empty');
    }
    if ([...query].length > MAX_QUERY_CODE_POINTS) {
      throw new KnowledgeValidationError(
        'Search query exceeds the maximum length',
      );
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new KnowledgeValidationError(
        'Knowledge search limit must be an integer from 1 to 6',
      );
    }
    const effectiveAt = input.effectiveAt ?? new Date().toISOString();
    const rows = await this.store.searchChunks({
      sandboxId: input.sandboxId,
      query,
      limit,
      effectiveAt,
      ...(input.policyId === undefined ? {} : { policyId: input.policyId }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    });
    const chunks: KnowledgeChunk[] = [];
    for (const row of rows) {
      const locator = KnowledgeChunkLocatorSchema.safeParse(row.locator);
      if (!locator.success) {
        continue;
      }
      chunks.push({
        id: row.id,
        documentVersionId: row.documentVersionId,
        policyBundleVersion: row.policyBundleVersion,
        text: row.text,
        locator: locator.data,
        score: normaliseScore(row.score),
        evidenceId: row.evidenceId,
      });
    }
    return {
      mode: 'lexical',
      queryId: randomUUID(),
      chunks,
      noEvidence: chunks.length === 0,
    };
  }
}

export class KnowledgeSearchService {
  constructor(
    private readonly store: Pick<KnowledgeSearchStore, 'getActiveSandbox'>,
    private readonly retriever: KnowledgeRetriever,
  ) {}

  async search(input: {
    readonly query: string;
    readonly limit?: number | undefined;
    readonly policyId?: string | undefined;
    readonly kind?: KnowledgeDocumentKind | undefined;
    readonly effectiveAt?: string | undefined;
  }): Promise<KnowledgeSearchResponse> {
    const sandboxId = await this.store.getActiveSandbox();
    if (sandboxId === null) {
      throw new KnowledgeNotFoundError('No active sandbox exists');
    }
    const outcome = await this.retriever.search({
      sandboxId,
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.policyId === undefined ? {} : { policyId: input.policyId }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.effectiveAt === undefined
        ? {}
        : { effectiveAt: input.effectiveAt }),
    });
    return KnowledgeSearchResponseSchema.parse({
      mode: outcome.mode,
      queryId: outcome.queryId,
      noEvidence: outcome.noEvidence,
      chunks: [...outcome.chunks],
    });
  }
}

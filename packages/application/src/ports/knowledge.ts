import type {
  KnowledgeChunk,
  KnowledgeDocumentKind,
} from '@nexus/contracts';

export interface KnowledgeSearchQuery {
  readonly sandboxId: string;
  readonly query: string;
  readonly limit?: number;
  readonly policyId?: string;
  readonly kind?: KnowledgeDocumentKind;
  readonly effectiveAt?: string;
}

export interface KnowledgeSearchOutcome {
  readonly mode: 'lexical';
  readonly queryId: string;
  readonly chunks: readonly KnowledgeChunk[];
  readonly noEvidence: boolean;
}

/**
 * Stable retrieval port. F18 implements deterministic lexical FTS; F27 adds a
 * hybrid implementation behind the same interface without changing callers.
 */
export interface KnowledgeRetriever {
  search(input: KnowledgeSearchQuery): Promise<KnowledgeSearchOutcome>;
}

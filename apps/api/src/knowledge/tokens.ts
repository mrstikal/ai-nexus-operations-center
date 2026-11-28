import type {
  KnowledgeCatalogService,
  KnowledgeIngestService,
} from '@nexus/application/knowledge/ingest';
import type { KnowledgeSearchService } from '@nexus/application/knowledge/lexical-retriever';
import type { KnowledgePublishService } from '@nexus/application/knowledge/publish';

export const NEXUS_KNOWLEDGE = 'NEXUS_KNOWLEDGE';

export interface KnowledgeApi {
  readonly ingest: KnowledgeIngestService;
  readonly catalog: KnowledgeCatalogService;
  readonly publish: KnowledgePublishService;
  readonly search: KnowledgeSearchService;
}

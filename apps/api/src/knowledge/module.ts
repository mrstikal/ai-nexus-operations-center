import { Module } from '@nestjs/common';
import { createFilePolicySource } from '@nexus/application/actions/policy-source';
import {
  KnowledgeCatalogService,
  KnowledgeIngestService,
} from '@nexus/application/knowledge/ingest';
import { LexicalKnowledgeRetriever, KnowledgeSearchService } from '@nexus/application/knowledge/lexical-retriever';
import { KnowledgePublishService } from '@nexus/application/knowledge/publish';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createKnowledgeStore } from '@nexus/db/repositories/knowledge';
import { AuthModule } from '../auth/module.js';
import { KnowledgeController } from './controller.js';
import { NEXUS_KNOWLEDGE, type KnowledgeApi } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [
    {
      provide: NEXUS_KNOWLEDGE,
      useFactory: (): KnowledgeApi | null => {
        try {
          const store = createKnowledgeStore(
            createNexusDb(createNexusPool()),
          );
          const policySource = createFilePolicySource();
          return {
            ingest: new KnowledgeIngestService(store, policySource),
            catalog: new KnowledgeCatalogService(store),
            publish: new KnowledgePublishService(store, policySource),
            search: new KnowledgeSearchService(
              store,
              new LexicalKnowledgeRetriever(store),
            ),
          };
        } catch {
          return null;
        }
      },
    },
  ],
})
export class KnowledgeModule {}

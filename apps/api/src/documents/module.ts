import { Module } from '@nestjs/common';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createDocumentStore } from '@nexus/db/repositories/documents';
import { createDocumentExtractionStore } from '@nexus/db/repositories/document-extraction';
import { DocumentCorrectionService } from '@nexus/application/documents/correct';
import { AuthModule } from '../auth/module.js';
import {
  DocumentsController,
  createDocumentIntakeService,
} from './controller.js';
import { DocumentCorrectionsController } from './corrections-controller.js';
import { NEXUS_DOCUMENT_CORRECTIONS, NEXUS_DOCUMENTS } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [DocumentsController, DocumentCorrectionsController],
  providers: [
    {
      provide: NEXUS_DOCUMENTS,
      useFactory: () => {
        try {
          return createDocumentIntakeService(
            createDocumentStore(createNexusDb(createNexusPool())),
          );
        } catch {
          return null;
        }
      },
    },
    {
      provide: NEXUS_DOCUMENT_CORRECTIONS,
      useFactory: () => {
        try {
          const db = createNexusDb(createNexusPool());
          return new DocumentCorrectionService(
            createDocumentExtractionStore(db),
          );
        } catch {
          return null;
        }
      },
    },
  ],
})
export class DocumentsModule {}

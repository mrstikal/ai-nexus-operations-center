import { Module } from '@nestjs/common';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { createDocumentStore } from '@nexus/db/repositories/documents';
import { AuthModule } from '../auth/module.js';
import {
  DocumentsController,
  createDocumentIntakeService,
} from './controller.js';
import { NEXUS_DOCUMENTS } from './tokens.js';

@Module({
  imports: [AuthModule],
  controllers: [DocumentsController],
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
  ],
})
export class DocumentsModule {}

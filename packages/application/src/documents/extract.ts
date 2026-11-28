import {
  DocumentExtractionRevisionSchema,
  type DocumentExtractionField,
  type DocumentExtractionRevision,
  type DocumentKind,
  type ModelGateway,
} from '@nexus/contracts';
import {
  DocumentExtractionV1Schema,
  parseAiOutput,
} from '@nexus/contracts/ai-outputs';
import {
  DocumentExtractionGatewayError,
  classificationRequest,
  classifyDocument,
  extractionRequest,
  extractionSourceText,
  type ExtractionPageText,
} from './classify.js';
import { validateExtraction } from './validate-fields.js';

export interface ReadyDocumentForExtraction {
  readonly sandboxId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly caseId: string | null;
  readonly pages: readonly ExtractionPageText[];
}

export interface SaveExtractionInput {
  readonly sandboxId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly caseId: string | null;
  readonly kind: DocumentKind;
  readonly fields: readonly DocumentExtractionField[];
  readonly reviewRequired: boolean;
  readonly reviewReason: string | null;
  readonly authoredById: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface DocumentExtractionStore {
  loadReadyDocument(input: {
    readonly sandboxId: string;
    readonly documentId: string;
  }): Promise<ReadyDocumentForExtraction | null>;
  saveExtraction(input: SaveExtractionInput): Promise<DocumentExtractionRevision>;
}

export class DocumentExtractionNotFoundError extends Error {
  constructor() {
    super('The document is not ready for structured extraction');
    this.name = 'DocumentExtractionNotFoundError';
  }
}

export class DocumentExtractionService {
  constructor(
    private readonly store: DocumentExtractionStore,
    private readonly gateway: ModelGateway,
  ) {}

  async extract(input: {
    readonly sandboxId: string;
    readonly documentId: string;
    readonly budgetAccountId: string;
    readonly workflowRunId: string | null;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<DocumentExtractionRevision> {
    const document = await this.store.loadReadyDocument({
      sandboxId: input.sandboxId,
      documentId: input.documentId,
    });
    if (!document) {
      throw new DocumentExtractionNotFoundError();
    }
    const sourceText = extractionSourceText(document.pages);

    const classification = await classifyDocument(
      this.gateway,
      classificationRequest({
        sourceText,
        budgetAccountId: input.budgetAccountId,
        workflowRunId: input.workflowRunId,
      }),
    );
    const result = await this.gateway.invoke(
      extractionRequest({
        kind: classification.kind,
        sourceText,
        budgetAccountId: input.budgetAccountId,
        workflowRunId: input.workflowRunId,
      }),
    );
    if (!result.ok) {
      throw new DocumentExtractionGatewayError(
        result.code,
        `Document extraction failed: ${result.message}`,
      );
    }
    const output = DocumentExtractionV1Schema.parse(
      parseAiOutput('document.extraction.v1', 'extract', result.output),
    );
    const validated = validateExtraction({
      kind: classification.kind,
      output,
      pages: document.pages,
      documentVersionId: document.documentVersionId,
    });

    return DocumentExtractionRevisionSchema.parse(
      await this.store.saveExtraction({
        sandboxId: document.sandboxId,
        documentId: document.documentId,
        documentVersionId: document.documentVersionId,
        caseId: document.caseId,
        kind: classification.kind,
        fields: validated.fields,
        reviewRequired: validated.reviewRequired,
        reviewReason: validated.reviewReason,
        authoredById: 'workflow:document-extraction',
        requestId: input.requestId,
        correlationId: input.correlationId,
      }),
    );
  }
}

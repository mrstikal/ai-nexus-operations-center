import {
  type DocumentExtractionCorrectionField,
  type DocumentExtractionField,
  type DocumentExtractionRevision,
} from '@nexus/contracts';
import type { ExtractionPageText } from './classify.js';
import {
  DocumentExtractionValidationError,
  determineReview,
  pageTextSlice,
  validateValueFormat,
} from './validate-fields.js';

export interface LatestDocumentExtraction {
  readonly revision: DocumentExtractionRevision;
  readonly pages: readonly ExtractionPageText[];
}

export type SaveCorrectionConflict = 'REVISION_CONFLICT' | 'EXTRACTION_IN_USE';

export type SaveCorrectionResult =
  | { readonly ok: true; readonly revision: DocumentExtractionRevision }
  | { readonly ok: false; readonly conflict: SaveCorrectionConflict };

export interface SaveCorrectionInput {
  readonly sandboxId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly kind: DocumentExtractionRevision['kind'];
  readonly expectedRevisionNumber: number;
  readonly supersedesRevisionId: string;
  readonly fields: readonly DocumentExtractionField[];
  readonly corrections: ReadonlyArray<{
    readonly field: DocumentExtractionCorrectionField['field'];
    readonly priorValue: string | null;
    readonly newValue: string | null;
    readonly reason: string;
  }>;
  readonly reviewRequired: boolean;
  readonly reviewReason: string | null;
  readonly reason: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface DocumentCorrectionStore {
  getActiveSandbox(): Promise<string | null>;
  loadLatestExtraction(input: {
    readonly sandboxId: string;
    readonly documentId: string;
  }): Promise<LatestDocumentExtraction | null>;
  saveCorrection(input: SaveCorrectionInput): Promise<SaveCorrectionResult>;
}

export class DocumentExtractionNotFoundError extends Error {
  constructor() {
    super('No structured extraction exists for this document');
    this.name = 'DocumentExtractionNotFoundError';
  }
}

export class DocumentCorrectionConflictError extends Error {
  constructor(
    readonly code: 'REVISION_CONFLICT' | 'EXTRACTION_IN_USE',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentCorrectionConflictError';
  }
}

export class DocumentCorrectionService {
  constructor(private readonly store: DocumentCorrectionStore) {}

  async correct(input: {
    readonly sandboxId: string | null;
    readonly documentId: string;
    readonly actorId: string;
    readonly expectedRevisionNumber: number;
    readonly reason: string;
    readonly fields: readonly DocumentExtractionCorrectionField[];
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<DocumentExtractionRevision> {
    const sandboxId =
      input.sandboxId ?? (await this.store.getActiveSandbox());
    if (sandboxId === null) {
      throw new DocumentExtractionNotFoundError();
    }
    const latest = await this.store.loadLatestExtraction({
      sandboxId,
      documentId: input.documentId,
    });
    if (!latest) {
      throw new DocumentExtractionNotFoundError();
    }

    const corrections: Array<SaveCorrectionInput['corrections'][number]> = [];
    const byField = new Map(
      latest.revision.fields.map((field) => [field.field, field]),
    );
    for (const correction of input.fields) {
      const prior = byField.get(correction.field);
      if (
        correction.value !== null &&
        !validateValueFormat(correction.field, correction.value)
      ) {
        throw new DocumentExtractionValidationError(
          `Correction for ${correction.field} has an invalid value format`,
        );
      }
      let source = correction.source ?? null;
      if (source !== null) {
        const page = latest.pages.find(
          (candidate) => candidate.page === source?.page,
        );
        if (
          !page ||
          source.start < 0 ||
          source.end > [...page.text].length ||
          source.end <= source.start
        ) {
          throw new DocumentExtractionValidationError(
            `Correction for ${correction.field} has an unsupported source span`,
          );
        }
        if (
          correction.value !== null &&
          !pageTextSlice(page.text, source.start, source.end).includes(
            correction.value,
          )
        ) {
          throw new DocumentExtractionValidationError(
            `Correction for ${correction.field} is not present in its source span`,
          );
        }
        source = { ...source, documentVersionId: latest.revision.documentVersionId };
      }
      byField.set(correction.field, {
        field: correction.field,
        value: correction.value,
        source,
        status: correction.value === null ? 'missing' : 'corrected',
        evidenceId: null,
      });
      corrections.push({
        field: correction.field,
        priorValue: prior?.value ?? null,
        newValue: correction.value,
        reason: correction.reason,
      });
    }

    const fields = [...byField.values()];
    const review = determineReview(latest.revision.kind, fields);
    const result = await this.store.saveCorrection({
      sandboxId,
      documentId: latest.revision.documentId,
      documentVersionId: latest.revision.documentVersionId,
      kind: latest.revision.kind,
      expectedRevisionNumber: input.expectedRevisionNumber,
      supersedesRevisionId: latest.revision.id,
      fields,
      corrections,
      reviewRequired: review.reviewRequired,
      reviewReason: review.reviewReason,
      reason: input.reason,
      actorId: input.actorId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    if (!result.ok) {
      throw new DocumentCorrectionConflictError(
        result.conflict,
        result.conflict === 'REVISION_CONFLICT'
          ? 'Extraction revision changed before the correction'
          : 'An action derived from this extraction is executing or unresolved',
      );
    }
    return result.revision;
  }
}

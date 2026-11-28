import { z } from 'zod';
import {
  EntityIdSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
} from './common.js';
import { FieldSourceSchema } from './evidence.js';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_FILENAME_LENGTH = 200;
export const MAX_EXTRACTED_PAGES = 20;
export const MAX_PAGE_TEXT_CHARS = 200_000;
export const MAX_EMAIL_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BASE64_CHARS =
  Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 16;
export const DOCUMENT_PARSER_VERSION = 'f16-digital-v1';
export const DOCUMENT_TEXT_DENSITY_MIN_CHARS = 40;

export const DOCUMENT_STATUSES = [
  'uploaded',
  'validating',
  'extracting',
  'needs_review',
  'ready',
  'rejected',
  'failed',
] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DOCUMENT_MEDIA_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'message/rfc822',
  'text/plain',
] as const;
export const DocumentMediaTypeSchema = z.enum(DOCUMENT_MEDIA_TYPES);
export type DocumentMediaType = z.infer<typeof DocumentMediaTypeSchema>;

export const DocumentVersionSchema = z
  .object({
    id: EntityIdSchema,
    documentId: EntityIdSchema,
    sandboxId: EntityIdSchema,
    caseId: EntityIdSchema.nullable(),
    blobHash: HashSchema,
    mediaType: DocumentMediaTypeSchema,
    originalFilename: z
      .string()
      .min(1)
      .max(MAX_DOCUMENT_FILENAME_LENGTH),
    sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
    pageCount: z.number().int().positive().max(1000).nullable(),
    sourceEventId: UuidSchema.nullable(),
    status: DocumentStatusSchema,
    parserVersion: z.string().min(1).max(100).nullable(),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentUploadResponseSchema = z
  .object({
    document: DocumentVersionSchema,
    jobId: UuidSchema,
    duplicateOf: UuidSchema.nullable(),
  })
  .strict();
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponseSchema>;

export const DocumentListResponseSchema = z
  .object({
    items: z.array(DocumentVersionSchema).max(100),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentDownloadTicketSchema = z
  .object({
    document: DocumentVersionSchema,
    blobKey: z.string().min(1).max(200),
  })
  .strict();
export type DocumentDownloadTicket = z.infer<typeof DocumentDownloadTicketSchema>;

export const DOCUMENT_EXTRACTION_FORMATS = [
  'digital_pdf',
  'email',
  'text',
  'image',
] as const;
export const DocumentExtractionFormatSchema = z.enum(DOCUMENT_EXTRACTION_FORMATS);
export type DocumentExtractionFormat = z.infer<
  typeof DocumentExtractionFormatSchema
>;

export const DOCUMENT_EXTRACTION_STATUSES = [
  'ready',
  'needs_review',
  'rejected',
] as const;
export const DocumentExtractionStatusSchema = z.enum(
  DOCUMENT_EXTRACTION_STATUSES,
);
export type DocumentExtractionStatus = z.infer<
  typeof DocumentExtractionStatusSchema
>;

export const EXTRACTION_REASON_CODES = [
  'OCR_REQUIRED',
  'ENCRYPTED',
  'MALFORMED',
  'PAGE_LIMIT',
  'PIXEL_LIMIT',
  'TEXT_LIMIT',
  'ATTACHMENT_LIMIT',
  'UNSUPPORTED_ATTACHMENT',
  'NO_TEXT',
  'UNSUPPORTED_MEDIA',
] as const;
export const ExtractionReasonCodeSchema = z.enum(EXTRACTION_REASON_CODES);
export type ExtractionReasonCode = z.infer<typeof ExtractionReasonCodeSchema>;

export const ExtractedPageSchema = z
  .object({
    page: z.number().int().min(1).max(MAX_EXTRACTED_PAGES),
    text: z.string().max(MAX_PAGE_TEXT_CHARS),
    charCount: z.number().int().nonnegative().max(MAX_PAGE_TEXT_CHARS),
  })
  .strict();
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;

export const ExtractedAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(MAX_DOCUMENT_FILENAME_LENGTH),
    mediaType: DocumentMediaTypeSchema,
    sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
    sha256: HashSchema,
    contentBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
  })
  .strict();
export type ExtractedAttachment = z.infer<typeof ExtractedAttachmentSchema>;

export const DocumentExtractionResultSchema = z
  .object({
    jobToken: UuidSchema,
    parserVersion: z.string().min(1).max(100),
    format: DocumentExtractionFormatSchema,
    status: DocumentExtractionStatusSchema,
    reasonCode: ExtractionReasonCodeSchema.nullable(),
    pageCount: z.number().int().min(1).max(MAX_EXTRACTED_PAGES),
    pages: z.array(ExtractedPageSchema).max(MAX_EXTRACTED_PAGES),
    attachments: z.array(ExtractedAttachmentSchema).max(MAX_EMAIL_ATTACHMENTS),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.pages.length !== result.pageCount) {
      context.addIssue({
        code: 'custom',
        message: 'Page count does not match the extracted pages',
        path: ['pages'],
      });
    }
    const pageNumbers = new Set<number>();
    for (const page of result.pages) {
      if (pageNumbers.has(page.page) || page.page > result.pageCount) {
        context.addIssue({
          code: 'custom',
          message: 'Extracted page numbers must be unique and contiguous',
          path: ['pages'],
        });
      }
      pageNumbers.add(page.page);
      if (page.charCount !== [...page.text].length) {
        context.addIssue({
          code: 'custom',
          message: 'Page charCount does not match the stored text',
          path: ['pages'],
        });
      }
    }
    for (let page = 1; page <= result.pageCount; page += 1) {
      if (!pageNumbers.has(page)) {
        context.addIssue({
          code: 'custom',
          message: 'Extracted pages must cover every page number',
          path: ['pages'],
        });
        break;
      }
    }
    if (result.status === 'ready' && result.reasonCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A ready extraction cannot carry a review reason',
        path: ['reasonCode'],
      });
    }
    if (result.status === 'rejected') {
      if (result.reasonCode === null) {
        context.addIssue({
          code: 'custom',
          message: 'A rejected extraction requires a reason',
          path: ['reasonCode'],
        });
      }
      if (result.attachments.length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'A rejected extraction cannot store attachments',
          path: ['attachments'],
        });
      }
    }
  });
export type DocumentExtractionResult = z.infer<
  typeof DocumentExtractionResultSchema
>;

export const EXTRACTOR_JOB_TOKEN_HEADER = 'x-nexus-job-token';
export const EXTRACTOR_MEDIA_TYPE_HEADER = 'x-nexus-media-type';

export const DOCUMENT_KINDS = [
  'supply_exception',
  'invoice',
  'delivery_note',
  'customer_request',
  'knowledge_document',
  'other',
  'unknown',
] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const EXTRACTION_FIELD_NAMES = [
  'supplier_name',
  'customer_name',
  'purchase_order_number',
  'invoice_number',
  'delivery_note_number',
  'sales_order_number',
  'document_date',
  'delivery_date',
  'due_date',
  'currency',
  'net_amount_minor',
  'tax_amount_minor',
  'gross_amount_minor',
  'tax_rate_bps',
  'total_quantity',
  'unit_price_minor',
  'description',
] as const;
export const ExtractionFieldNameSchema = z.enum(EXTRACTION_FIELD_NAMES);
export type ExtractionFieldName = z.infer<typeof ExtractionFieldNameSchema>;

export const ExtractionFieldStatusSchema = z.enum([
  'extracted',
  'corrected',
  'missing',
  'ambiguous',
]);
export type ExtractionFieldStatus = z.infer<
  typeof ExtractionFieldStatusSchema
>;

export const DocumentExtractionFieldSchema = z
  .object({
    field: ExtractionFieldNameSchema,
    value: z.string().min(1).max(5000).nullable(),
    source: FieldSourceSchema.nullable(),
    status: ExtractionFieldStatusSchema,
    alternatives: z.array(z.string().min(1).max(5000)).max(10).optional(),
    evidenceId: UuidSchema.nullable(),
  })
  .strict();
export type DocumentExtractionField = z.infer<
  typeof DocumentExtractionFieldSchema
>;

export const DocumentExtractionRevisionSchema = z
  .object({
    id: UuidSchema,
    documentId: UuidSchema,
    documentVersionId: UuidSchema,
    revisionNumber: z.number().int().positive().max(1_000_000),
    kind: DocumentKindSchema,
    revisionStatus: z.enum(['extracted', 'corrected']),
    authoredByKind: z.enum(['model', 'human']),
    authoredById: z.string().min(1).max(200),
    supersedesRevisionId: UuidSchema.nullable(),
    fields: z.array(DocumentExtractionFieldSchema).min(1).max(50),
    reviewRequired: z.boolean(),
    reviewReason: z.string().min(1).max(100).nullable(),
    requestReason: z.string().min(1).max(1000).nullable(),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();
export type DocumentExtractionRevision = z.infer<
  typeof DocumentExtractionRevisionSchema
>;

export const DocumentExtractionCorrectionFieldSchema = z
  .object({
    field: ExtractionFieldNameSchema,
    value: z.string().min(1).max(5000).nullable(),
    source: FieldSourceSchema.nullable().optional(),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type DocumentExtractionCorrectionField = z.infer<
  typeof DocumentExtractionCorrectionFieldSchema
>;

export const DocumentExtractionCorrectionRequestSchema = z
  .object({
    reason: z.string().min(1).max(1000),
    fields: z.array(DocumentExtractionCorrectionFieldSchema).min(1).max(50),
  })
  .strict()
  .superRefine((request, context) => {
    const seen = new Set<string>();
    for (const field of request.fields) {
      if (seen.has(field.field)) {
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: 'A correction may name each field only once',
        });
      }
      seen.add(field.field);
    }
  });
export type DocumentExtractionCorrectionRequest = z.infer<
  typeof DocumentExtractionCorrectionRequestSchema
>;

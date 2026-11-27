import { z } from 'zod';
import {
  EntityIdSchema,
  HashSchema,
  IsoUtcTimestampSchema,
  UuidSchema,
} from './common.js';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const MAX_DOCUMENT_FILENAME_LENGTH = 200;

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

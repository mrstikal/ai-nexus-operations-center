import {
  type DocumentExtractionField,
  type DocumentExtractionV1,
  type DocumentKind,
  type ExtractionFieldName,
} from '@nexus/contracts';
import type { ExtractionPageText } from './classify.js';

export class DocumentExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExtractionValidationError';
  }
}

export interface ValidatedExtraction {
  readonly fields: DocumentExtractionField[];
  readonly reviewRequired: boolean;
  readonly reviewReason: string | null;
}

const REQUIRED_FIELDS: Record<DocumentKind, readonly ExtractionFieldName[]> = {
  supply_exception: ['supplier_name', 'purchase_order_number'],
  invoice: [
    'supplier_name',
    'invoice_number',
    'currency',
    'net_amount_minor',
    'tax_amount_minor',
    'gross_amount_minor',
  ],
  delivery_note: [
    'supplier_name',
    'delivery_note_number',
    'purchase_order_number',
  ],
  customer_request: ['customer_name'],
  knowledge_document: [],
  other: [],
  unknown: [],
};

const MONEY_FIELDS = new Set<ExtractionFieldName>([
  'net_amount_minor',
  'tax_amount_minor',
  'gross_amount_minor',
  'unit_price_minor',
]);
const DATE_FIELDS = new Set<ExtractionFieldName>([
  'document_date',
  'delivery_date',
  'due_date',
]);
const FINANCIAL_REVIEW_FIELDS = new Set<ExtractionFieldName>([
  ...MONEY_FIELDS,
  ...DATE_FIELDS,
  'currency',
  'tax_rate_bps',
  'total_quantity',
]);

function normalizeSpanText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Page text offsets are Unicode code-point indexes (`char_length` in PostgreSQL
 * and `char_count` on page rows), not UTF-16 code units. Never use String#slice
 * with them on text that may contain non-BMP characters.
 */
export function pageTextSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

export function validateValueFormat(field: ExtractionFieldName, value: string): boolean {
  if (MONEY_FIELDS.has(field)) {
    return /^(0|[1-9]\d{0,12})$/u.test(value);
  }
  if (field === 'tax_rate_bps') {
    return /^(0|[1-9]\d{0,5})$/u.test(value) && Number(value) <= 100_000;
  }
  if (field === 'total_quantity') {
    return (
      /^(0|[1-9]\d{0,6})$/u.test(value) && Number(value) <= 1_000_000
    );
  }
  if (DATE_FIELDS.has(field)) {
    return isValidDate(value);
  }
  if (field === 'currency') {
    return /^[A-Z]{3}$/u.test(value);
  }
  return true;
}

function sourceForField(
  documentVersionId: string,
  source: { page: number; start: number; end: number },
  pages: readonly ExtractionPageText[],
):
  | { documentVersionId: string; page: number; start: number; end: number }
  | null {
  const page = pages.find((candidate) => candidate.page === source.page);
  if (!page || source.start < 0 || source.end > [...page.text].length) {
    return null;
  }
  return {
    documentVersionId,
    page: source.page,
    start: source.start,
    end: source.end,
  };
}

export function validateExtraction(input: {
  readonly kind: DocumentKind;
  readonly output: DocumentExtractionV1;
  readonly pages: readonly ExtractionPageText[];
  readonly documentVersionId: string;
}): ValidatedExtraction {
  if (input.output.kind !== input.kind) {
    throw new DocumentExtractionValidationError(
      'Extraction kind does not match the classified document kind',
    );
  }
  const seen = new Set<string>();
  const fields: DocumentExtractionField[] = [];
  let reason: string | null = null;
  const markReview = (next: string): void => {
    reason ??= next;
  };

  for (const field of input.output.fields) {
    if (seen.has(field.field)) {
      throw new DocumentExtractionValidationError(
        `Extraction repeats field ${field.field}`,
      );
    }
    seen.add(field.field);

    let status = field.status;
    let value = field.value;
    let source =
      field.source === null
        ? null
        : sourceForField(
            input.documentVersionId,
            field.source,
            input.pages,
          );
    let alternatives = field.alternatives;

    if (status !== 'missing') {
      const page = field.source
        ? input.pages.find((candidate) => candidate.page === field.source?.page)
        : undefined;
      if (field.source !== null && source === null) {
        const originalValue = value;
        status = 'ambiguous';
        value = null;
        source = null;
        alternatives =
          originalValue === null
            ? alternatives
            : [...(alternatives ?? []), originalValue];
        markReview('INVALID_SOURCE_SPAN');
      } else if (value !== null && page && field.source !== null) {
        const span = pageTextSlice(
          page.text,
          field.source.start,
          field.source.end,
        );
        const normalizedSpan = normalizeSpanText(span);
        const normalizedValue = normalizeSpanText(value);
        if (
          normalizedSpan !== normalizedValue &&
          !normalizedSpan.includes(normalizedValue)
        ) {
          status = 'ambiguous';
          alternatives = [...(alternatives ?? []), value];
          value = null;
          source = null;
          markReview('INVALID_SOURCE_SPAN');
        }
      }
    }

    if (status === 'ambiguous' && value !== null && source === null) {
      alternatives = [...(alternatives ?? []), value];
      value = null;
    }

    if (status !== 'missing' && value !== null && !validateValueFormat(field.field, value)) {
      status = 'ambiguous';
      alternatives = [...(alternatives ?? []), value];
      value = null;
      source = null;
      markReview('INVALID_FIELD_VALUE');
    }

    if (
      status !== 'missing' &&
      status !== 'ambiguous' &&
      (value === null || source === null)
    ) {
      status = 'ambiguous';
      value = null;
      source = null;
      markReview('INVALID_SOURCE_SPAN');
    }

    fields.push({
      field: field.field,
      value,
      source,
      status,
      ...(alternatives && alternatives.length > 0
        ? { alternatives: alternatives.slice(0, 10) }
        : {}),
      evidenceId: null,
    });
  }

  const review = determineReview(input.kind, fields);

  return {
    fields,
    reviewRequired: reason !== null || review.reviewRequired,
    reviewReason: reason ?? review.reviewReason,
  };
}

export function determineReview(
  kind: DocumentKind,
  fields: readonly Pick<DocumentExtractionField, 'field' | 'value' | 'status'>[],
): { reviewRequired: boolean; reviewReason: string | null } {
  let reason: string | null = null;
  const markReview = (next: string): void => {
    reason ??= next;
  };
  const byField = new Map(fields.map((field) => [field.field, field]));

  for (const required of REQUIRED_FIELDS[kind] ?? []) {
    const field = byField.get(required);
    if (
      !field ||
      field.value === null ||
      field.status === 'missing' ||
      field.status === 'ambiguous'
    ) {
      markReview('REQUIRED_FIELDS_MISSING');
    }
  }

  for (const field of fields) {
    if (
      field.status === 'ambiguous' &&
      FINANCIAL_REVIEW_FIELDS.has(field.field)
    ) {
      markReview('AMBIGUOUS_FINANCIAL_DATA');
    }
  }

  const amount = (name: ExtractionFieldName): bigint | null => {
    const field = byField.get(name);
    return field?.value !== null && field?.value !== undefined
      ? BigInt(field.value)
      : null;
  };
  const net = amount('net_amount_minor');
  const tax = amount('tax_amount_minor');
  const gross = amount('gross_amount_minor');
  if (net !== null && tax !== null && gross !== null && net + tax !== gross) {
    markReview('ARITHMETIC_MISMATCH');
  }

  const documentDate = byField.get('document_date')?.value ?? null;
  if (documentDate !== null) {
    for (const name of ['delivery_date', 'due_date'] as const) {
      const other = byField.get(name)?.value ?? null;
      if (other !== null && other < documentDate) {
        markReview('CONTRADICTORY_DATE');
      }
    }
  }

  return { reviewRequired: reason !== null, reviewReason: reason };
}

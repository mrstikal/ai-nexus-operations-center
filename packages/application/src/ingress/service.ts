import {
  CaseIntakeRequestSchema,
  CaseIntakeResponseSchema,
  IdempotencyKeySchema,
  caseIntakeSourceIdentity,
  normalizeCaseIntakeSource,
  type Actor,
  type CaseIntakeRequest,
  type CaseIntakeResponse,
  type CaseIntakeSource,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import {
  SandboxInactiveError,
  SandboxUnavailableError,
} from '../cases/context.js';

export const CASE_INTAKE_ROUTE = '/api/v1/cases';

export interface IngressStoreInput {
  readonly actor: Actor;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly sourceType: CaseIntakeSource['type'];
  readonly sourceIdentity: string;
  readonly source: CaseIntakeSource;
  readonly title: string;
  readonly summary: string | null;
  readonly requestId: string;
  readonly correlationId: string;
}

export type IngressStoreResult =
  | { readonly status: 'accepted'; readonly response: CaseIntakeResponse }
  | { readonly status: 'duplicate'; readonly response: CaseIntakeResponse }
  | { readonly status: 'conflict' }
  | { readonly status: 'sandbox_inactive' }
  | { readonly status: 'sandbox_unavailable' };

export interface IngressStore {
  ingest(input: IngressStoreInput): Promise<IngressStoreResult>;
  documentExists(documentId: string): Promise<boolean>;
}

export class IngressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngressValidationError';
  }
}

export class IngressIdempotencyMismatchError extends Error {
  constructor(message = 'Idempotency key or source identity was reused with a different body') {
    super(message);
    this.name = 'IngressIdempotencyMismatchError';
  }
}

export class DocumentReferenceNotFoundError extends Error {
  constructor(message = 'Document reference does not exist') {
    super(message);
    this.name = 'DocumentReferenceNotFoundError';
  }
}

export class IngressService {
  constructor(private readonly store: IngressStore) {}

  async intake(input: {
    readonly body: unknown;
    readonly idempotencyKey: string | undefined;
    readonly actor: Actor;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<CaseIntakeResponse> {
    let parsed: CaseIntakeRequest;
    try {
      parsed = CaseIntakeRequestSchema.parse(input.body);
    } catch {
      throw new IngressValidationError('Case intake request is invalid');
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = IdempotencyKeySchema.parse(input.idempotencyKey);
    } catch {
      throw new IngressValidationError('A valid Idempotency-Key header is required');
    }
    if (input.actor.roles.length === 0) {
      throw new IngressValidationError('The intake actor has no accepted role');
    }

    const source = normalizeCaseIntakeSource(parsed.source);
    if (source.type === 'document') {
      const exists = await this.store.documentExists(source.documentId);
      if (!exists) {
        throw new DocumentReferenceNotFoundError();
      }
    }
    const sourceIdentity = caseIntakeSourceIdentity(source);
    const requestHash = canonicalJsonSha256({
      title: parsed.title,
      summary: parsed.summary,
      source,
    });

    const result = await this.store.ingest({
      actor: input.actor,
      route: CASE_INTAKE_ROUTE,
      idempotencyKey,
      requestHash,
      sourceType: source.type,
      sourceIdentity,
      source,
      title: parsed.title,
      summary: parsed.summary,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    switch (result.status) {
      case 'accepted':
        return CaseIntakeResponseSchema.parse(result.response);
      case 'duplicate':
        return CaseIntakeResponseSchema.parse({
          ...result.response,
          deduplicated: true,
        });
      case 'conflict':
        throw new IngressIdempotencyMismatchError();
      case 'sandbox_inactive':
        throw new SandboxInactiveError();
      case 'sandbox_unavailable':
        throw new SandboxUnavailableError();
    }
  }
}

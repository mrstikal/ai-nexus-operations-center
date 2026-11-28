export class KnowledgeNotFoundError extends Error {
  constructor(message = 'Knowledge document not found') {
    super(message);
    this.name = 'KnowledgeNotFoundError';
  }
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeValidationError';
  }
}

export class KnowledgeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeSourceError';
  }
}

export type KnowledgeConflictCode =
  | 'NO_DRAFT'
  | 'NO_PUBLISHED_VERSION'
  | 'POLICY_MISMATCH';

export class KnowledgeConflictError extends Error {
  constructor(
    readonly code: KnowledgeConflictCode,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeConflictError';
  }
}

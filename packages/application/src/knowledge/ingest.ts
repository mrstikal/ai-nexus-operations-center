import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EntityIdSchema,
  IsoUtcTimestampSchema,
  KNOWLEDGE_SOURCE_PATH_PATTERN,
  KnowledgeDocumentSchema,
  KnowledgeIngestResponseSchema,
  KnowledgeListResponseSchema,
  type KnowledgeDocument,
  type KnowledgeDocumentKind,
  type KnowledgeIngestResponse,
  type KnowledgeListResponse,
} from '@nexus/contracts';
import type { PolicyBundleSource } from '../actions/policy-source.js';
import {
  KNOWLEDGE_SOURCE_MAX_BYTES,
  chunkKnowledgeText,
  type KnowledgeChunkDraft,
} from './chunk.js';
import {
  KnowledgeNotFoundError,
  KnowledgeSourceError,
  KnowledgeValidationError,
} from './errors.js';

export interface SaveKnowledgeVersionInput {
  readonly sandboxId: string;
  readonly kind: KnowledgeDocumentKind;
  readonly policyId: string | null;
  readonly sourcePath: string;
  readonly contentSha256: string;
  readonly policyBundleVersion: string | null;
  readonly policyContentHash: string | null;
  readonly effectiveFrom: string;
  readonly charCount: number;
  readonly chunks: readonly KnowledgeChunkDraft[];
  readonly actorId: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface KnowledgeIngestStore {
  getActiveSandbox(): Promise<string | null>;
  saveVersion(
    input: SaveKnowledgeVersionInput,
  ): Promise<{ readonly document: KnowledgeDocument; readonly deduplicated: boolean }>;
}

export interface KnowledgeDocumentCursor {
  readonly createdAt: string;
  readonly documentId: string;
}

export interface KnowledgeCatalogStore {
  getActiveSandbox(): Promise<string | null>;
  listDocuments(input: {
    readonly sandboxId: string;
    readonly limit: number;
    readonly after?: KnowledgeDocumentCursor;
  }): Promise<{ readonly items: KnowledgeDocument[]; readonly hasMore: boolean }>;
}

export interface KnowledgeIngestServiceOptions {
  readonly root?: string;
  readonly maxBytes?: number;
}

function encodeCursor(cursor: KnowledgeDocumentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeKnowledgeCursor(cursor: string): KnowledgeDocumentCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { createdAt?: unknown; documentId?: unknown };
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.documentId !== 'string' ||
      !IsoUtcTimestampSchema.safeParse(parsed.createdAt).success ||
      !EntityIdSchema.safeParse(parsed.documentId).success
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, documentId: parsed.documentId };
  } catch {
    throw new KnowledgeValidationError('Invalid knowledge cursor');
  }
}

function parseLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new KnowledgeValidationError('Limit must be an integer from 1 to 100');
  }
  return value;
}

export class KnowledgeIngestService {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(
    private readonly store: KnowledgeIngestStore,
    private readonly policySource: PolicyBundleSource,
    options: KnowledgeIngestServiceOptions = {},
  ) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.maxBytes = options.maxBytes ?? KNOWLEDGE_SOURCE_MAX_BYTES;
  }

  async ingest(input: {
    readonly sandboxId: string | null;
    readonly kind: KnowledgeDocumentKind;
    readonly policyId: string | null;
    readonly sourcePath: string;
    readonly effectiveFrom: string | null;
    readonly actorId: string;
    readonly requestId: string;
    readonly correlationId: string;
  }): Promise<KnowledgeIngestResponse> {
    if (!KNOWLEDGE_SOURCE_PATH_PATTERN.test(input.sourcePath)) {
      throw new KnowledgeValidationError(
        'Knowledge source must be a registered fixtures/knowledge markdown path',
      );
    }
    if (input.kind === 'policy' && input.policyId === null) {
      throw new KnowledgeValidationError('A policy document requires a policy id');
    }
    if (input.kind === 'informational' && input.policyId !== null) {
      throw new KnowledgeValidationError(
        'An informational document cannot declare an executable policy id',
      );
    }
    const sandboxId = input.sandboxId ?? (await this.store.getActiveSandbox());
    if (sandboxId === null) {
      throw new KnowledgeNotFoundError('No active sandbox exists');
    }

    let policyBundleVersion: string | null = null;
    let policyContentHash: string | null = null;
    if (input.kind === 'policy') {
      const loaded = await this.policySource.load();
      policyBundleVersion = loaded.bundle.revision;
      policyContentHash = loaded.contentHash;
    }

    const bytes = await this.readSource(input.sourcePath);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new KnowledgeSourceError('Knowledge source is not valid UTF-8');
    }
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const chunks = chunkKnowledgeText({ sourcePath: input.sourcePath, text });
    const saved = await this.store.saveVersion({
      sandboxId,
      kind: input.kind,
      policyId: input.policyId,
      sourcePath: input.sourcePath,
      contentSha256,
      policyBundleVersion,
      policyContentHash,
      effectiveFrom: input.effectiveFrom ?? new Date().toISOString(),
      charCount: [...text].length,
      chunks,
      actorId: input.actorId,
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return KnowledgeIngestResponseSchema.parse({
      document: KnowledgeDocumentSchema.parse(saved.document),
      deduplicated: saved.deduplicated,
    });
  }

  private async readSource(sourcePath: string): Promise<Buffer> {
    const knowledgePath = path.resolve(
      this.root,
      'fixtures',
      'knowledge',
    );
    const securityPath = path.resolve(
      this.root,
      'fixtures',
      'security',
      'inject-policy.md',
    );
    const absolute = path.resolve(this.root, sourcePath);
    const allowed = absolute.startsWith(`${knowledgePath}${path.sep}`)
      ? absolute.endsWith('.md')
      : absolute === securityPath;
    if (!allowed) {
      throw new KnowledgeSourceError(
        'Knowledge source escapes the registered fixture directories',
      );
    }
    try {
      const bytes = await readFile(absolute);
      if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) {
        throw new KnowledgeSourceError('Knowledge source size is outside the bound');
      }
      return bytes;
    } catch (error) {
      if (error instanceof KnowledgeSourceError) {
        throw error;
      }
      throw new KnowledgeSourceError('Knowledge source could not be read');
    }
  }
}

export class KnowledgeCatalogService {
  constructor(private readonly store: KnowledgeCatalogStore) {}

  async list(input: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<KnowledgeListResponse> {
    const sandboxId = await this.store.getActiveSandbox();
    if (sandboxId === null) {
      throw new KnowledgeNotFoundError('No active sandbox exists');
    }
    const limit = parseLimit(input.limit);
    const after =
      input.cursor === undefined
        ? undefined
        : decodeKnowledgeCursor(input.cursor);
    const result = await this.store.listDocuments({
      sandboxId,
      limit,
      ...(after === undefined ? {} : { after }),
    });
    const items = result.items.map((item) => KnowledgeDocumentSchema.parse(item));
    const last = items.at(-1);
    return KnowledgeListResponseSchema.parse({
      items,
      nextCursor:
        result.hasMore && last
          ? encodeCursor({
              createdAt: last.createdAt,
              documentId: last.id,
            })
          : null,
    });
  }
}

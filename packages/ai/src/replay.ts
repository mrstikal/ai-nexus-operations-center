import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  GatewayRequestSchema,
  JsonValueSchema,
  MODEL_FAILURE_CODES,
  ModelUsageSchema,
  type GatewayRequest,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import { ReplayManifestError } from './errors.js';

export const ReplayRouteSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
  })
  .strict();

export const ReplaySuccessOutcomeSchema = z
  .object({
    kind: z.literal('success'),
    output: JsonValueSchema,
    recordedUsage: ModelUsageSchema.nullable(),
  })
  .strict();

export const ReplayFailureOutcomeSchema = z
  .object({
    kind: z.literal('failure'),
    code: z.enum(MODEL_FAILURE_CODES),
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

export const ReplayRecordSchema = z
  .object({
    recordId: z.string().min(1).max(100),
    request: GatewayRequestSchema,
    promptVersion: z.string().regex(/^[a-f0-9]{64}$/),
    configRevision: z.string().min(1).max(100),
    schemaVersion: z.number().int().positive(),
    route: ReplayRouteSchema,
    outcome: z.discriminatedUnion('kind', [
      ReplaySuccessOutcomeSchema,
      ReplayFailureOutcomeSchema,
    ]),
  })
  .strict();
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

export const ReplayManifestSchema = z
  .object({
    version: z.literal('replay-v1'),
    records: z.array(ReplayRecordSchema),
    recordFixtures: z.array(z.string().min(1).max(200)).default([]),
    failureFixtures: z.array(z.string().min(1).max(200)),
  })
  .strict();
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

export interface ReplayContext {
  readonly promptVersion: string;
  readonly configRevision: string;
  readonly schemaVersion: number;
  readonly route: { readonly provider: string; readonly model: string };
}

export interface ReplayLookup {
  readonly record: ReplayRecord;
  readonly replayKey: string;
}

export function normalizeReplayText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

/**
 * The replay key covers the normalized semantic source, evidence references,
 * role, output schema identity, prompt/config revisions and chosen route.
 * It never keys on a generic "success" marker, so a changed source cannot
 * reuse an unrelated recorded output.
 */
export function replayKeyFor(
  request: GatewayRequest,
  context: ReplayContext,
): string {
  const projection = {
    role: request.role,
    outputSchemaId: request.outputSchemaId,
    schemaVersion: context.schemaVersion,
    promptVersion: context.promptVersion,
    configRevision: context.configRevision,
    provider: context.route.provider,
    model: context.route.model,
    capabilities: [...request.capabilities].sort(),
    allowedToolNames: [...request.allowedToolNames].sort(),
    maxOutputTokens: request.maxOutputTokens,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((content) =>
        content.kind === 'text'
          ? { kind: 'text' as const, text: normalizeReplayText(content.text) }
          : {
              kind: 'image_ref' as const,
              documentVersionId: content.documentVersionId,
              page: content.page,
            },
      ),
    })),
  };
  return canonicalJsonSha256(projection);
}

export class ReplayAdapter {
  readonly #records = new Map<string, ReplayRecord>();

  constructor(records: readonly ReplayRecord[]) {
    for (const record of records) {
      const key = replayKeyFor(record.request, {
        promptVersion: record.promptVersion,
        configRevision: record.configRevision,
        schemaVersion: record.schemaVersion,
        route: record.route,
      });
      if (this.#records.has(key)) {
        throw new ReplayManifestError(
          `Duplicate replay key ${key} (records ${this.#records.get(key)?.recordId} and ${record.recordId})`,
        );
      }
      this.#records.set(key, record);
    }
  }

  get size(): number {
    return this.#records.size;
  }

  keyFor(request: GatewayRequest, context: ReplayContext): string {
    return replayKeyFor(request, context);
  }

  lookup(request: GatewayRequest, context: ReplayContext): ReplayLookup | null {
    const replayKey = replayKeyFor(request, context);
    const record = this.#records.get(replayKey);
    return record ? { record, replayKey } : null;
  }
}

export interface LoadedReplay {
  readonly manifest: ReplayManifest;
  readonly records: readonly ReplayRecord[];
  readonly adapter: ReplayAdapter;
}

export function loadReplayManifest(manifestPath: string): LoadedReplay {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new ReplayManifestError(
      `Cannot read replay manifest at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = ReplayManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayManifestError(
      `Invalid replay manifest: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const records = [...parsed.data.records];
  const baseDirectory = path.dirname(path.resolve(manifestPath));
  for (const fixture of parsed.data.recordFixtures) {
    let fixtureRaw: unknown;
    const fixturePath = path.resolve(baseDirectory, fixture);
    try {
      fixtureRaw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    } catch (error) {
      throw new ReplayManifestError(
        `Cannot read replay record fixture ${fixturePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const record = ReplayRecordSchema.safeParse(fixtureRaw);
    if (!record.success) {
      throw new ReplayManifestError(
        `Invalid replay record fixture ${fixturePath}: ${record.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    records.push(record.data);
  }
  for (const fixture of parsed.data.failureFixtures) {
    let fixtureRaw: unknown;
    const fixturePath = path.resolve(baseDirectory, fixture);
    try {
      fixtureRaw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    } catch (error) {
      throw new ReplayManifestError(
        `Cannot read replay failure fixture ${fixturePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const record = ReplayRecordSchema.safeParse(fixtureRaw);
    if (!record.success) {
      throw new ReplayManifestError(
        `Invalid replay failure fixture ${fixturePath}: ${record.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    if (record.data.outcome.kind !== 'failure') {
      throw new ReplayManifestError(
        `Replay failure fixture ${fixturePath} must declare a failure outcome`,
      );
    }
    records.push(record.data);
  }
  return { manifest: parsed.data, records, adapter: new ReplayAdapter(records) };
}

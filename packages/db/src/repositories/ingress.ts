import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  CaseDetailSchema,
  CaseIntakeResponseSchema,
  type CaseIntakeResponse,
} from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';
import type {
  IngressStore,
  IngressStoreInput,
  IngressStoreResult,
} from '@nexus/application/ingress/service';
import type { NexusDb } from '../connection.js';
import { activeSandbox, cases, sandboxes } from '../schema/cases.js';
import { eventOutbox, ingressKeys } from '../schema/events.js';
import { appendAuditInTransaction } from './audit.js';
import type { DbTransaction } from './types.js';

async function lock(tx: DbTransaction, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

type SandboxResolution =
  | { readonly id: string }
  | { readonly status: 'sandbox_inactive' | 'sandbox_unavailable' };

async function resolveSandbox(tx: DbTransaction): Promise<SandboxResolution> {
  const rows = await tx
    .select({ id: sandboxes.id, status: sandboxes.status })
    .from(activeSandbox)
    .innerJoin(sandboxes, eq(sandboxes.id, activeSandbox.sandboxId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { status: 'sandbox_unavailable' };
  }
  if (row.status !== 'active') {
    return { status: 'sandbox_inactive' };
  }
  return { id: row.id };
}

function storedResponse(stored: Record<string, unknown>): CaseIntakeResponse {
  return CaseIntakeResponseSchema.parse(stored);
}

export function createIngressStore(db: NexusDb): IngressStore {
  return {
    async documentExists(): Promise<boolean> {
      return false;
    },

    async ingest(input: IngressStoreInput): Promise<IngressStoreResult> {
      return db.transaction(async (tx) => {
        const sandbox = await resolveSandbox(tx);
        if (!('id' in sandbox)) {
          return { status: sandbox.status };
        }
        const sandboxId = sandbox.id;
        await lock(
          tx,
          `${sandboxId}:${input.route}:${input.sourceType}:${input.sourceIdentity}`,
        );
        await lock(
          tx,
          `${sandboxId}:${input.route}:${input.actor.kind}:${input.actor.id}:${input.idempotencyKey}`,
        );

        const existingKeyRows = await tx
          .select()
          .from(ingressKeys)
          .where(
            and(
              eq(ingressKeys.sandboxId, sandboxId),
              eq(ingressKeys.actorKind, input.actor.kind),
              eq(ingressKeys.actorId, input.actor.id),
              eq(ingressKeys.route, input.route),
              eq(ingressKeys.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        const existingKey = existingKeyRows[0];
        if (existingKey) {
          if (existingKey.requestHash !== input.requestHash) {
            return { status: 'conflict' };
          }
          return {
            status: 'duplicate',
            response: storedResponse(existingKey.response),
          };
        }

        const existingSourceRows = await tx
          .select()
          .from(ingressKeys)
          .where(
            and(
              eq(ingressKeys.sandboxId, sandboxId),
              eq(ingressKeys.route, input.route),
              eq(ingressKeys.sourceType, input.sourceType),
              eq(ingressKeys.sourceIdentity, input.sourceIdentity),
            ),
          )
          .limit(1);
        const existingSource = existingSourceRows[0];
        if (existingSource) {
          if (existingSource.requestHash !== input.requestHash) {
            return { status: 'conflict' };
          }
          return {
            status: 'duplicate',
            response: storedResponse(existingSource.response),
          };
        }

        const caseId = randomUUID();
        const eventId = randomUUID();
        const keyId = randomUUID();
        const occurredAt = new Date();
        const caseRows = await tx
          .insert(cases)
          .values({
            id: caseId,
            sandboxId,
            title: input.title,
            summary: input.summary,
            status: 'new',
            version: 1,
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .returning();
        const caseRow = caseRows[0];
        if (!caseRow) {
          throw new Error('Case intake insert returned no row');
        }

        await appendAuditInTransaction(tx, {
          actor: input.actor,
          requestId: input.requestId,
          correlationId: input.correlationId,
          sandboxId,
          runId: null,
          targetType: 'case',
          targetId: caseId,
          targetVersion: '1',
          action: 'case.intake',
          beforeHash: null,
          afterHash: canonicalJsonSha256({ status: 'new', version: 1 }),
          outcome: 'succeeded',
          details: {
            caseId,
            caseStatus: 'new',
            caseVersion: 1,
            sourceKind: input.sourceType,
          },
        });

        await tx.insert(eventOutbox).values({
          id: eventId,
          sandboxId,
          eventType: 'nexus.case.created.v1',
          schemaVersion: 1,
          producer: 'api',
          occurredAt,
          correlationId: input.correlationId,
          causationId: null,
          aggregateType: 'case',
          aggregateId: caseId,
          aggregateVersion: 1,
          payload: { caseId, title: input.title },
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: sql`clock_timestamp()`,
          lastError: null,
          version: 0,
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        });

        const detail = CaseDetailSchema.parse({
          id: caseRow.id,
          sandboxId: caseRow.sandboxId,
          title: caseRow.title,
          summary: caseRow.summary,
          status: caseRow.status,
          version: caseRow.version,
          terminalReason: caseRow.terminalReason,
          createdAt: caseRow.createdAt.toISOString(),
          updatedAt: caseRow.updatedAt.toISOString(),
          entityRefs: [],
        });
        const response = CaseIntakeResponseSchema.parse({
          case: detail,
          eventId,
          eventType: 'nexus.case.created.v1',
          queued: true,
          deduplicated: false,
        });

        await tx.insert(ingressKeys).values({
          id: keyId,
          sandboxId,
          route: input.route,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          sourceType: input.sourceType,
          sourceIdentity: input.sourceIdentity,
          caseId,
          eventId,
          response: response as unknown as Record<string, unknown>,
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        });

        return { status: 'accepted', response };
      });
    },
  };
}

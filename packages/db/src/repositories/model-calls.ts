import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ModelFailureCodeSchema, ModelUsageSchema } from '@nexus/contracts';
import {
  BUDGET_OWNER_KINDS,
  formatUsdMicrousd,
  hardBudgetCeilingMicrousd,
  parseUsdMicrousd,
  type BudgetAccount,
  type BudgetOwnerKind,
  type CreateBudgetAccountInput,
  type MarkUncertainInput,
  type ModelCallLedger,
  type ReserveModelCallInput,
  type ReserveModelCallResult,
  type SettleModelCallInput,
  type FinalizeUncertainInput,
} from '@nexus/ai/budgets';
import { BudgetAdmissionError, ModelCallLedgerError } from '@nexus/ai/errors';
import type { NexusDb } from '../connection.js';
import { budgetAccounts } from '../schema/budget-accounts.js';
import { modelCalls, type ModelCallReservationRow } from '../schema/model-calls.js';
import type { TraceData } from '@nexus/observability/trace';
import { appendTraceEventInTransaction } from './trace.js';
import type { DbTransaction } from './types.js';

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function iso(value: Date): string {
  return value.toISOString();
}

function ownerKind(value: string): BudgetOwnerKind {
  if (!(BUDGET_OWNER_KINDS as readonly string[]).includes(value)) {
    throw new BudgetAdmissionError('PARENT_INVALID', `Unknown budget owner kind ${value}`);
  }
  return value as BudgetOwnerKind;
}

function mapAccount(row: typeof budgetAccounts.$inferSelect): BudgetAccount {
  return {
    id: row.id,
    sandboxId: row.sandboxId,
    ownerKind: ownerKind(row.ownerKind),
    ownerId: row.ownerId,
    parentAccountId: row.parentAccountId,
    capMicrousd: formatUsdMicrousd(row.capMicrousd),
    usedMicrousd: formatUsdMicrousd(row.usedMicrousd),
    reservedMicrousd: formatUsdMicrousd(row.reservedMicrousd),
    state: row.state,
    depth: row.depth,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function parseReservations(value: unknown): ModelCallReservationRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new ModelCallLedgerError('Invalid stored model-call reservations');
  }
  return value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as ModelCallReservationRow).accountId !== 'string' ||
      typeof (entry as ModelCallReservationRow).reservedMicrousd !== 'string'
    ) {
      throw new ModelCallLedgerError('Invalid stored model-call reservation entry');
    }
    return {
      accountId: (entry as ModelCallReservationRow).accountId,
      reservedMicrousd: (entry as ModelCallReservationRow).reservedMicrousd,
    };
  });
}

function validateOwnerId(value: string): void {
  if (
    value.length < 1 ||
    value.length > 128 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new BudgetAdmissionError('PARENT_INVALID', 'Invalid budget owner id');
  }
}

interface ChainRow {
  id: string;
  parent_account_id: string | null;
  distance: number;
  depth: number;
}

async function lockAccountChain(
  tx: DbTransaction,
  sandboxId: string,
  accountId: string,
  maxDepth: number,
): Promise<Array<typeof budgetAccounts.$inferSelect>> {
  const chain = asRows<ChainRow>(
    await tx.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_account_id, 0 AS distance, depth
        FROM nexus.budget_accounts
        WHERE sandbox_id = ${sandboxId} AND id = ${accountId}
        UNION ALL
        SELECT parent.id, parent.parent_account_id, child.distance + 1, parent.depth
        FROM nexus.budget_accounts parent
        JOIN chain child ON parent.id = child.parent_account_id
        WHERE parent.sandbox_id = ${sandboxId}
      )
      SELECT id, parent_account_id, distance, depth
      FROM chain
      ORDER BY depth ASC, id ASC
    `),
  );
  if (chain.length === 0) {
    throw new BudgetAdmissionError('ACCOUNT_NOT_FOUND', 'Budget account does not exist');
  }
  if (chain.length > maxDepth + 1) {
    throw new BudgetAdmissionError(
      'DEPTH_EXCEEDED',
      `Budget account chain exceeds the maximum depth of ${maxDepth}`,
    );
  }
  const locked: Array<typeof budgetAccounts.$inferSelect> = [];
  for (const entry of chain) {
    const rows = await tx
      .select()
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.sandboxId, sandboxId),
          eq(budgetAccounts.id, entry.id),
        ),
      )
      .for('update');
    const row = rows[0];
    if (!row) {
      throw new BudgetAdmissionError('ACCOUNT_NOT_FOUND', 'Budget account does not exist');
    }
    locked.push(row);
  }
  return locked;
}

async function appendModelTrace(
  tx: DbTransaction,
  input: {
    readonly sandboxId: string;
    readonly runId: string | null;
    readonly event: string;
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly data: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await appendTraceEventInTransaction(tx, {
    sandboxId: input.sandboxId,
    runId: input.runId,
    level: input.level,
    event: input.event,
    data: input.data as TraceData,
  });
}

export function createModelCallLedger(db: NexusDb): ModelCallLedger {
  return {
    async createAccount(input: CreateBudgetAccountInput): Promise<BudgetAccount> {
      validateOwnerId(input.ownerId);
      const cap = parseUsdMicrousd(input.capMicrousd);
      const ceiling = parseUsdMicrousd(hardBudgetCeilingMicrousd(input.ownerKind));
      if (cap > ceiling) {
        throw new BudgetAdmissionError(
          'INVALID_AMOUNT',
          `Budget cap exceeds the hard ${input.ownerKind} ceiling`,
        );
      }
      return db.transaction(async (tx) => {
        let depth = 0;
        if (input.parentAccountId) {
          const parentRows = await tx
            .select()
            .from(budgetAccounts)
            .where(
              and(
                eq(budgetAccounts.sandboxId, input.sandboxId),
                eq(budgetAccounts.id, input.parentAccountId),
              ),
            )
            .limit(1);
          const parent = parentRows[0];
          if (!parent) {
            throw new BudgetAdmissionError(
              'PARENT_INVALID',
              'Parent budget account does not exist in this sandbox',
            );
          }
          depth = parent.depth + 1;
          if (depth > input.maxDepth) {
            throw new BudgetAdmissionError(
              'DEPTH_EXCEEDED',
              `Budget account chain exceeds the maximum depth of ${input.maxDepth}`,
            );
          }
        }
        const id = randomUUID();
        const inserted = await tx
          .insert(budgetAccounts)
          .values({
            id,
            sandboxId: input.sandboxId,
            ownerKind: input.ownerKind,
            ownerId: input.ownerId,
            parentAccountId: input.parentAccountId,
            depth,
            capMicrousd: cap,
            usedMicrousd: 0n,
            reservedMicrousd: 0n,
            state: 'active',
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new BudgetAdmissionError('ACCOUNT_NOT_FOUND', 'Budget account insert failed');
        }
        return mapAccount(row);
      });
    },

    async getAccount(id: string): Promise<BudgetAccount | null> {
      const rows = await db
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.id, id))
        .limit(1);
      const row = rows[0];
      return row ? mapAccount(row) : null;
    },

    async reserveCall(input: ReserveModelCallInput): Promise<ReserveModelCallResult> {
      const amount = parseUsdMicrousd(input.reservedMicrousd);
      return db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${input.sandboxId}:${input.gatewayInvocationId}:${input.physicalAttempt}`},
              0
            )
          )
        `);
        const existingRows = await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.sandboxId, input.sandboxId),
              eq(modelCalls.gatewayInvocationId, input.gatewayInvocationId),
              eq(modelCalls.physicalAttempt, input.physicalAttempt),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        if (existing) {
          if (
            existing.budgetAccountId !== input.accountId ||
            existing.requestHash !== input.requestHash
          ) {
            throw new ModelCallLedgerError(
              'Gateway invocation attempt was reused with a different account or request',
            );
          }
          const reservations = parseReservations(existing.reservations);
          return {
            callId: existing.id,
            reservedMicrousd: formatUsdMicrousd(existing.reservedMicrousd),
            accounts: reservations,
            state: existing.state as ReserveModelCallResult['state'],
            reused: true,
          };
        }

        if (input.workflowRunId !== null) {
          const runRows = asRows<{ id: string }>(
            await tx.execute(sql`
              SELECT id
              FROM nexus.workflow_runs
              WHERE sandbox_id = ${input.sandboxId} AND id = ${input.workflowRunId}
            `),
          );
          if (runRows.length !== 1) {
            throw new BudgetAdmissionError(
              'SANDBOX_MISMATCH',
              'Workflow run does not exist in the reservation sandbox',
            );
          }
        }

        const chain = await lockAccountChain(
          tx,
          input.sandboxId,
          input.accountId,
          input.maxDepth,
        );
        if (
          input.workflowRunId !== null &&
          !chain.some(
            (account) =>
              account.ownerKind === 'run' && account.ownerId === input.workflowRunId,
          )
        ) {
          throw new BudgetAdmissionError(
            'PARENT_INVALID',
            "The selected budget account is not the workflow run's account or a descendant of it",
          );
        }
        for (const account of chain) {
          if (account.state !== 'active') {
            throw new BudgetAdmissionError(
              'ACCOUNT_CLOSED',
              `Budget account ${account.ownerKind}:${account.ownerId} is closed`,
            );
          }
          if (account.usedMicrousd + account.reservedMicrousd + amount > account.capMicrousd) {
            throw new BudgetAdmissionError(
              'CAP_EXCEEDED',
              `Reservation would exceed the budget cap for ${account.ownerKind}:${account.ownerId}`,
            );
          }
        }
        const reservations: ModelCallReservationRow[] = [];
        for (const account of chain) {
          const updated = await tx
            .update(budgetAccounts)
            .set({
              reservedMicrousd: sql`${budgetAccounts.reservedMicrousd} + ${amount}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(budgetAccounts.sandboxId, input.sandboxId),
                eq(budgetAccounts.id, account.id),
                eq(budgetAccounts.state, 'active'),
                sql`${budgetAccounts.usedMicrousd} + ${budgetAccounts.reservedMicrousd} + ${amount} <= ${budgetAccounts.capMicrousd}`,
              ),
            )
            .returning({ id: budgetAccounts.id });
          if (updated.length !== 1) {
            throw new BudgetAdmissionError(
              'CAP_EXCEEDED',
              'Reservation lost the budget admission race',
            );
          }
          reservations.push({
            accountId: account.id,
            reservedMicrousd: formatUsdMicrousd(amount),
          });
        }

        const callId = randomUUID();
        const inserted = await tx
          .insert(modelCalls)
          .values({
            id: callId,
            sandboxId: input.sandboxId,
            budgetAccountId: input.accountId,
            gatewayInvocationId: input.gatewayInvocationId,
            physicalAttempt: input.physicalAttempt,
            workflowRunId: input.workflowRunId,
            role: input.role,
            outputSchemaId: input.outputSchemaId,
            schemaVersion: input.schemaVersion,
            promptVersion: input.promptVersion,
            configRevision: input.configRevision,
            provider: input.provider,
            model: input.model,
            mode: input.mode,
            replayKey: input.replayKey,
            requestHash: input.requestHash,
            state: 'reserved',
            reservedMicrousd: amount,
            settledMicrousd: null,
            reservations,
            usage: null,
            failureCode: null,
            diagnostics: [],
            startedAt: sql`clock_timestamp()`,
            settledAt: null,
            createdAt: sql`clock_timestamp()`,
          })
          .returning({ id: modelCalls.id });
        if (inserted.length !== 1) {
          throw new ModelCallLedgerError('Model-call reservation insert failed');
        }
        return {
          callId,
          reservedMicrousd: formatUsdMicrousd(amount),
          accounts: reservations,
          state: 'reserved',
          reused: false,
        };
      });
    },

    async settleCall(input: SettleModelCallInput): Promise<void> {
      const actual = parseUsdMicrousd(input.actualMicrousd);
      const usage = input.usage === null ? null : ModelUsageSchema.parse(input.usage);
      const failureCode =
        input.failureCode === null
          ? null
          : ModelFailureCodeSchema.parse(input.failureCode);
      if (input.diagnostics.length > 20) {
        throw new ModelCallLedgerError('Too many model-call diagnostics');
      }
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.sandboxId, input.sandboxId),
              eq(modelCalls.id, input.callId),
            ),
          )
          .for('update')
          .limit(1);
        const call = rows[0];
        if (!call) {
          throw new ModelCallLedgerError('Model call does not exist');
        }
        if (call.state !== 'reserved') {
          return;
        }
        const reservations = parseReservations(call.reservations);
        for (const reservation of reservations) {
          const reserved = parseUsdMicrousd(reservation.reservedMicrousd);
          const updated = await tx
            .update(budgetAccounts)
            .set({
              reservedMicrousd: sql`GREATEST(${budgetAccounts.reservedMicrousd} - ${reserved}, 0)`,
              usedMicrousd: sql`${budgetAccounts.usedMicrousd} + ${actual}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(budgetAccounts.sandboxId, input.sandboxId),
                eq(budgetAccounts.id, reservation.accountId),
              ),
            )
            .returning({ id: budgetAccounts.id });
          if (updated.length !== 1) {
            throw new ModelCallLedgerError('Budget account is missing during settlement');
          }
        }
        const state = input.outcome === 'succeeded' ? 'settled' : 'failed';
        await tx
          .update(modelCalls)
          .set({
            state,
            settledMicrousd: actual,
            usage,
            failureCode,
            diagnostics: [...input.diagnostics],
            settledAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(modelCalls.sandboxId, input.sandboxId), eq(modelCalls.id, input.callId)),
          );
        await appendModelTrace(tx, {
          sandboxId: input.sandboxId,
          runId: call.workflowRunId,
          event: input.traceEvent,
          level: input.traceLevel,
          data: {
            ...input.traceData,
            durationMs: Math.max(0, Math.floor(input.latencyMs)),
            attempt: call.physicalAttempt,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
          },
        });
      });
    },

    async markUncertain(input: MarkUncertainInput): Promise<void> {
      const failureCode = ModelFailureCodeSchema.parse(input.failureCode);
      if (input.diagnostics.length > 20) {
        throw new ModelCallLedgerError('Too many model-call diagnostics');
      }
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.sandboxId, input.sandboxId),
              eq(modelCalls.id, input.callId),
            ),
          )
          .for('update')
          .limit(1);
        const call = rows[0];
        if (!call) {
          throw new ModelCallLedgerError('Model call does not exist');
        }
        if (call.state !== 'reserved') {
          return;
        }
        await tx
          .update(modelCalls)
          .set({
            state: 'uncertain',
            failureCode,
            diagnostics: [...input.diagnostics],
          })
          .where(
            and(eq(modelCalls.sandboxId, input.sandboxId), eq(modelCalls.id, input.callId)),
          );
        await appendModelTrace(tx, {
          sandboxId: input.sandboxId,
          runId: call.workflowRunId,
          event: input.traceEvent,
          level: input.traceLevel,
          data: { ...input.traceData, attempt: call.physicalAttempt },
        });
      });
    },

    async finalizeUncertain(input: FinalizeUncertainInput): Promise<void> {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.sandboxId, input.sandboxId),
              eq(modelCalls.id, input.callId),
            ),
          )
          .for('update')
          .limit(1);
        const call = rows[0];
        if (!call) {
          throw new ModelCallLedgerError('Model call does not exist');
        }
        if (call.state !== 'uncertain') {
          return;
        }
        const actual = input.actualMicrousd === null
          ? call.reservedMicrousd
          : parseUsdMicrousd(input.actualMicrousd);
        const reservations = parseReservations(call.reservations);
        for (const reservation of reservations) {
          const reserved = parseUsdMicrousd(reservation.reservedMicrousd);
          await tx
            .update(budgetAccounts)
            .set({
              reservedMicrousd: sql`GREATEST(${budgetAccounts.reservedMicrousd} - ${reserved}, 0)`,
              usedMicrousd: sql`${budgetAccounts.usedMicrousd} + ${actual}`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(budgetAccounts.sandboxId, input.sandboxId),
                eq(budgetAccounts.id, reservation.accountId),
              ),
            );
        }
        await tx
          .update(modelCalls)
          .set({
            state: 'settled',
            settledMicrousd: actual,
            settledAt: sql`clock_timestamp()`,
          })
          .where(
            and(eq(modelCalls.sandboxId, input.sandboxId), eq(modelCalls.id, input.callId)),
          );
      });
    },
  };
}

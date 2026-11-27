import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ActionPlanItemSchema, type EnterpriseCommandReceipt } from '@nexus/contracts';
import { advanceBaseVersions, type EntityChange } from '@nexus/domain/actions/bindings';
import { computePlanHash } from '@nexus/domain/actions/item-hash';
import { purchaseOrderCommitmentMinor } from '@nexus/domain/policies/approvals';
import { computeActionItemHash } from '@nexus/domain/actions/item-hash';
import type {
  RecoverableAttempt,
  ReconciliationResult,
  ReconciliationStore,
} from '@nexus/application/actions/reconcile';
import type {
  CancelPlanResult,
  CancelPlanStore,
} from '@nexus/application/actions/cancel-plan';
import type { PartialEffectSummary } from '@nexus/application/actions/partial-effects';
import type { NexusDb } from '../connection.js';
import { actionExecutionAttempts, actionExecutionReceipts, actionExecutionEntityChanges, actionExecutions } from '../schema/executions.js';
import { actionProposals, actionRevisionEvidence, actionRevisions } from '../schema/actions.js';
import { approvalDecisions } from '../schema/approvals.js';
import { actionReanalysisHandoffs } from '../schema/execution-attempts.js';
import { executionAttemptPayloads, executionReconciliations, actionPartialEffects } from '../schema/execution-attempts.js';
import { appendAuditInTransaction } from './audit.js';
import type { DbTransaction } from './types.js';

function asRows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

interface RecoverableRow {
  sandbox_id: string;
  execution_id: string;
  action_revision_id: string;
  item_id: string;
  attempt_count: number;
  attempt_id: string;
  attempt_number: number;
  attempt_state: string;
  command_kind: string;
  receipt_key: string;
  plan_hash: string;
  item_hash: string;
  execute_before: Date | string;
  authorization_valid_until: Date | string;
  policy_revision: string;
  policy_content_hash: string;
  request_payload: Record<string, unknown>;
  base_expected_versions: RecoverableAttempt['baseExpectedVersions'];
  prior_receipt_keys: string[];
}

function mapAttempt(row: RecoverableRow): RecoverableAttempt {
  return {
    sandboxId: row.sandbox_id,
    executionId: row.execution_id,
    actionRevisionId: row.action_revision_id,
    itemId: row.item_id,
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    attemptState: row.attempt_state,
    commandKind: row.command_kind,
    receiptKey: row.receipt_key,
    planHash: row.plan_hash,
    itemHash: row.item_hash,
    executeBefore: new Date(row.execute_before as unknown as string).toISOString(),
    authorizationValidUntil: new Date(
      row.authorization_valid_until as unknown as string,
    ).toISOString(),
    policyRevision: row.policy_revision,
    policyContentHash: row.policy_content_hash,
    payload: row.request_payload,
    baseExpectedVersions: row.base_expected_versions,
    priorReceiptKeys: row.prior_receipt_keys,
  };
}

export function createReconciliationStore(
  db: NexusDb,
): ReconciliationStore & CancelPlanStore {
  return {
    async findRecoverableAttempt() {
      const result = await db.execute(sql`
        SELECT execution.sandbox_id, execution.id AS execution_id,
               execution.action_revision_id, execution.item_id, execution.attempt_count,
               attempt.id AS attempt_id, attempt.attempt_number, attempt.state AS attempt_state,
               payload.command_kind, payload.receipt_key, payload.plan_hash,
               payload.item_hash, payload.execute_before,
               payload.authorization_valid_until, execution.policy_revision,
               execution.policy_content_hash, payload.request_payload,
               payload.base_expected_versions, payload.prior_receipt_keys
        FROM nexus.action_executions AS execution
        JOIN nexus.action_execution_attempts AS attempt
          ON attempt.sandbox_id = execution.sandbox_id
         AND attempt.execution_id = execution.id
         AND attempt.attempt_number = execution.attempt_count
        JOIN nexus.execution_attempt_payloads AS payload
          ON payload.sandbox_id = attempt.sandbox_id
         AND payload.attempt_id = attempt.id
        WHERE execution.state IN ('in_progress', 'unknown')
          AND attempt.state IN ('in_progress', 'unknown', 'retryable_failure')
          AND NOT EXISTS (
            SELECT 1 FROM nexus.execution_reconciliations AS found
            WHERE found.attempt_id = attempt.id AND found.result = 'found'
          )
        ORDER BY execution.updated_at
        LIMIT 1
      `);
      const row = asRows<RecoverableRow>(result)[0];
      return row ? mapAttempt(row) : null;
    },

    async databaseNow() {
      const result = await db.execute(sql`SELECT clock_timestamp() AS now`);
      const now = asRows<{ now: Date | string }>(result)[0]?.now;
      if (!now) {
        throw new Error('Database clock unavailable');
      }
      return new Date(now as unknown as string).toISOString();
    },

    async recordProbe(input: {
      readonly attempt: RecoverableAttempt;
      readonly result: ReconciliationResult;
      readonly dbNow: string;
      readonly detail?: string;
    }) {
      await db.insert(executionReconciliations).values({
        id: randomUUID(),
        sandboxId: input.attempt.sandboxId,
        executionId: input.attempt.executionId,
        attemptId: input.attempt.attemptId,
        result: input.result,
        receiptKey: input.attempt.receiptKey,
        dbNow: new Date(input.dbNow),
        detail: input.detail ?? null,
        observedAt: sql`clock_timestamp()`,
      });
    },

    async recordFoundReceipt(input: {
      readonly attempt: RecoverableAttempt;
      readonly receipt: EnterpriseCommandReceipt;
    }) {
      await db.transaction(async (tx) => {
        const execution = await lockExecution(tx, input.attempt.sandboxId, input.attempt.executionId);
        if (!execution || execution.state === 'succeeded') {
          return;
        }
        await tx
          .update(actionExecutions)
          .set({
            state: 'succeeded',
            receiptKey: input.receipt.idempotencyKey,
            receiptId: input.receipt.id,
            resultEntityType: input.receipt.result.entityType,
            resultEntityId: input.receipt.result.id,
            resultEntityVersion: input.receipt.result.version,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, execution.id));
        await tx
          .update(actionExecutionAttempts)
          .set({
            state: 'succeeded',
            receiptKey: input.receipt.idempotencyKey,
            finishedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutionAttempts.id, input.attempt.attemptId));
        await tx
          .insert(actionExecutionReceipts)
          .values({
            id: input.receipt.id,
            sandboxId: execution.sandboxId,
            executionId: execution.id,
            receiptKey: input.receipt.idempotencyKey,
            commandKind: input.receipt.commandKind,
            actionRevisionId: input.receipt.actionRevisionId,
            itemId: input.receipt.itemId,
            planHash: input.receipt.planHash,
            itemHash: input.receipt.itemHash,
            resultEntityType: input.receipt.result.entityType,
            resultEntityId: input.receipt.result.id,
            resultEntityVersion: input.receipt.result.version,
            receipt: input.receipt as unknown as Record<string, unknown>,
            createdAt: sql`clock_timestamp()`,
          })
          .onConflictDoNothing();
        for (const [ordinal, change] of input.receipt.entityChanges.entries()) {
          await tx
            .insert(actionExecutionEntityChanges)
            .values({
              sandboxId: execution.sandboxId,
              receiptId: input.receipt.id,
              ordinal,
              entityType: change.entityType,
              entityId: change.id,
              beforeVersion: change.beforeVersion,
              afterVersion: change.afterVersion,
            })
            .onConflictDoNothing();
        }
        await recordPartialEffect(tx, execution, 'succeeded', input.receipt.idempotencyKey);
        await tx.insert(executionReconciliations).values({
          id: randomUUID(),
          sandboxId: input.attempt.sandboxId,
          executionId: execution.id,
          attemptId: input.attempt.attemptId,
          result: 'found',
          receiptKey: input.receipt.idempotencyKey,
          dbNow: sql`clock_timestamp()`,
          detail: 'receipt_found_after_uncertainty',
          observedAt: sql`clock_timestamp()`,
        });
        await appendAuditInTransaction(tx, {
          sandboxId: execution.sandboxId,
          requestId: `reconcile-found-${execution.id}`,
          correlationId: `reconcile-${execution.id}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-reconciler', roles: [] },
          runId: null,
          action: 'action.execution_reconciled',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(execution.attemptCount),
          beforeHash: execution.planHash,
          afterHash: execution.planHash,
          outcome: 'succeeded',
          details: {
            caseId: execution.caseId,
            actionRevisionId: execution.actionRevisionId,
            planHash: execution.planHash,
            policyRevision: execution.policyRevision ?? '',
            status: 'succeeded',
            reasonCode: 'receipt_found',
          },
        });
      });
    },

    async recordDeterministicFailure(input: {
      readonly attempt: RecoverableAttempt;
      readonly errorCode: string;
    }) {
      await db.transaction(async (tx) => {
        const execution = await lockExecution(tx, input.attempt.sandboxId, input.attempt.executionId);
        if (!execution || execution.state === 'succeeded') {
          return;
        }
        await tx
          .update(actionExecutions)
          .set({ state: 'permanent_failure', updatedAt: sql`clock_timestamp()` })
          .where(eq(actionExecutions.id, execution.id));
        await tx
          .update(actionExecutionAttempts)
          .set({
            state: 'permanent_failure',
            errorCode: input.errorCode.slice(0, 100),
            finishedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutionAttempts.id, input.attempt.attemptId));
        await appendAuditInTransaction(tx, {
          sandboxId: execution.sandboxId,
          requestId: `reconcile-failed-${execution.id}`,
          correlationId: `reconcile-${execution.id}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-reconciler', roles: [] },
          runId: null,
          action: 'action.execution_failed',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(execution.attemptCount),
          beforeHash: execution.planHash,
          afterHash: execution.planHash,
          outcome: 'failed',
          details: {
            caseId: execution.caseId,
            actionRevisionId: execution.actionRevisionId,
            planHash: execution.planHash,
            policyRevision: execution.policyRevision ?? '',
            status: 'permanent_failure',
            reasonCode: input.errorCode.slice(0, 100),
          },
        });
      });
    },

    async cancelAfterAbsent(input: {
      readonly attempt: RecoverableAttempt;
      readonly reason: string;
    }) {
      await db.transaction(async (tx) => {
        const execution = await lockExecution(tx, input.attempt.sandboxId, input.attempt.executionId);
        if (!execution || execution.state === 'succeeded') {
          return;
        }
        await tx
          .update(actionExecutions)
          .set({
            state: 'cancelled',
            receiptKey: null,
            receiptId: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, execution.id));
        await tx
          .update(actionExecutionAttempts)
          .set({
            state: 'cancelled',
            errorCode: input.reason.slice(0, 100),
            finishedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutionAttempts.id, input.attempt.attemptId));
        await recordPartialEffect(tx, execution, 'cancelled', null, input.reason);
        await appendAuditInTransaction(tx, {
          sandboxId: execution.sandboxId,
          requestId: `reconcile-cancel-${execution.id}`,
          correlationId: `reconcile-${execution.id}`.slice(0, 128),
          actor: { kind: 'service', id: 'action-reconciler', roles: [] },
          runId: null,
          action: 'action.execution_cancelled',
          targetType: 'action_execution',
          targetId: execution.id,
          targetVersion: String(execution.attemptCount),
          beforeHash: execution.planHash,
          afterHash: execution.planHash,
          outcome: 'denied',
          details: {
            caseId: execution.caseId,
            actionRevisionId: execution.actionRevisionId,
            planHash: execution.planHash,
            policyRevision: execution.policyRevision ?? '',
            status: 'cancelled',
            reasonCode: input.reason.slice(0, 100),
          },
        });
      });
    },

    async canReissue(
      attempt: RecoverableAttempt,
      policy: { readonly revision: string; readonly contentHash: string },
    ) {
      const result = await db.execute(sql`
        SELECT 1
        FROM nexus.action_executions AS execution
        JOIN nexus.action_proposals AS proposal
          ON proposal.sandbox_id = execution.sandbox_id AND proposal.id = execution.proposal_id
        JOIN nexus.action_revisions AS revision
          ON revision.sandbox_id = execution.sandbox_id AND revision.id = execution.action_revision_id
        JOIN nexus.cases AS case_row
          ON case_row.sandbox_id = execution.sandbox_id AND case_row.id = execution.case_id
        WHERE execution.id = ${attempt.executionId}
          AND execution.sandbox_id = ${attempt.sandboxId}
          AND execution.state IN ('in_progress', 'unknown')
          AND execution.policy_revision = ${policy.revision}
          AND execution.policy_content_hash = ${policy.contentHash}
          AND EXISTS (
            SELECT 1 FROM nexus.active_sandbox AS active
            WHERE active.sandbox_id = execution.sandbox_id
          )
          AND proposal.current_revision_id = revision.id
          AND proposal.status = 'approved'
          AND revision.state = 'approved'
          AND revision.expires_at > clock_timestamp()
          AND case_row.status NOT IN ('resolved', 'escalated', 'cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM nexus.action_case_cancellations AS cancellation
            WHERE cancellation.sandbox_id = execution.sandbox_id
              AND cancellation.case_id = execution.case_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(revision.required_roles) AS required_role
            WHERE NOT EXISTS (
              SELECT 1 FROM nexus.approval_decisions AS decision
              WHERE decision.sandbox_id = execution.sandbox_id
                AND decision.action_revision_id = revision.id
                AND decision.decision = 'approve'
                AND decision.state = 'active'
                AND decision.role = required_role
                AND EXISTS (
                  SELECT 1 FROM nexus.user_roles AS user_role
                  WHERE user_role.user_id = decision.actor_id::uuid
                    AND user_role.role = decision.role
                )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM nexus.action_revision_evidence AS link
            JOIN nexus.evidence AS evidence
              ON evidence.sandbox_id = link.sandbox_id AND evidence.id = link.evidence_id
            WHERE link.sandbox_id = execution.sandbox_id
              AND link.revision_id = revision.id
              AND evidence.source_status <> 'available'
          )
        LIMIT 1
      `);
      return asRows(result).length > 0;
    },

    async createRetryAttempt(input) {
      return db.transaction(async (tx) => {
        const execution = await lockExecution(tx, input.attempt.sandboxId, input.attempt.executionId);
        if (
          !execution ||
          ['succeeded', 'cancelled'].includes(execution.state) ||
          execution.attemptCount >= 3 ||
          !(await reissueAllowed(tx, execution, input.policy))
        ) {
          return null;
        }
        const attemptNumber = execution.attemptCount + 1;
        const attemptId = randomUUID();
        await tx.insert(actionExecutionAttempts).values({
          id: attemptId,
          sandboxId: input.attempt.sandboxId,
          executionId: execution.id,
          attemptNumber,
          state: 'in_progress',
          requestHash: null,
          executeBefore: new Date(input.executeBefore),
          authorizationValidUntil: new Date(input.authorizationValidUntil),
          errorCode: null,
          receiptKey: null,
          startedAt: sql`clock_timestamp()`,
          finishedAt: null,
          createdAt: sql`clock_timestamp()`,
        });
        await tx.insert(executionAttemptPayloads).values({
          attemptId,
          sandboxId: input.attempt.sandboxId,
          executionId: execution.id,
          requestPayload: input.attempt.payload,
          baseExpectedVersions: [...input.attempt.baseExpectedVersions],
          priorReceiptKeys: [...input.attempt.priorReceiptKeys],
          commandKind: input.attempt.commandKind,
          receiptKey: input.attempt.receiptKey,
          planHash: input.attempt.planHash,
          itemHash: input.attempt.itemHash,
          executeBefore: new Date(input.executeBefore),
          authorizationValidUntil: new Date(input.authorizationValidUntil),
          createdAt: sql`clock_timestamp()`,
        });
        await tx
          .update(actionExecutions)
          .set({
            state: 'in_progress',
            attemptCount: attemptNumber,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionExecutions.id, execution.id));
        return {
          ...input.attempt,
          attemptId,
          attemptNumber,
          attemptState: 'in_progress',
          executeBefore: input.executeBefore,
          authorizationValidUntil: input.authorizationValidUntil,
        };
      });
    },
    async cancelPlan(input: {
      readonly sandboxId: string;
      readonly proposalId: string;
      readonly requestId: string;
      readonly correlationId: string;
    }): Promise<CancelPlanResult> {
      return db.transaction(async (tx) => {
        const proposalRows = await tx
          .select()
          .from(actionProposals)
          .where(
            and(
              eq(actionProposals.sandboxId, input.sandboxId),
              eq(actionProposals.id, input.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const proposal = proposalRows[0];
        if (!proposal || !proposal.currentRevisionId) {
          return { ok: false, code: 'PLAN_NOT_FOUND' };
        }
        if (
          !['draft', 'pending_approval', 'approved'].includes(proposal.status)
        ) {
          return { ok: false, code: 'PLAN_ALREADY_CLOSED' };
        }
        const revisionRows = await tx
          .select()
          .from(actionRevisions)
          .where(
            and(
              eq(actionRevisions.sandboxId, input.sandboxId),
              eq(actionRevisions.id, proposal.currentRevisionId),
            ),
          )
          .for('update')
          .limit(1);
        const revision = revisionRows[0];
        if (!revision) {
          return { ok: false, code: 'PLAN_NOT_FOUND' };
        }
        const executions = await tx
          .select()
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.sandboxId, input.sandboxId),
              eq(actionExecutions.actionRevisionId, revision.id),
            ),
          )
          .for('update');
        if (
          executions.some((execution) =>
            ['in_progress', 'unknown'].includes(execution.state),
          )
        ) {
          return { ok: false, code: 'PLAN_UNRESOLVED' };
        }
        const planItems = ActionPlanItemSchema.array().parse(revision.items);
        const byItemId = new Map(
          executions.map((execution) => [execution.itemId, execution]),
        );
        for (const item of planItems) {
          const execution = byItemId.get(item.itemId);
          if (execution?.state === 'succeeded') {
            continue;
          }
          if (!execution) {
            const itemHash = computeActionItemHash(item);
            await tx.insert(actionExecutions).values({
              id: randomUUID(),
              sandboxId: input.sandboxId,
              caseId: proposal.caseId,
              proposalId: proposal.id,
              actionRevisionId: revision.id,
              itemId: item.itemId,
              commandKind: item.payload.kind,
              executionKey: `${input.sandboxId}:${revision.id}:${item.itemId}:${item.payload.kind}`,
              planHash: revision.planHash,
              itemHash,
              state: 'cancelled',
              authorizationBasis: 'human',
              policyRevision: revision.policyRevision,
              policyContentHash: revision.policyContentHash,
              committedMinor: null,
              receiptKey: null,
              receiptId: null,
              resultEntityType: null,
              resultEntityId: null,
              resultEntityVersion: null,
              attemptCount: 0,
              createdAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            });
            continue;
          }
          if (execution.state !== 'cancelled') {
            await tx
              .update(actionExecutions)
              .set({
                state: 'cancelled',
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(actionExecutions.id, execution.id));
          }
          await recordPartialEffect(tx, execution, 'cancelled', null, 'plan_cancelled');
        }
        await tx
          .update(actionRevisions)
          .set({ state: 'superseded', updatedAt: sql`clock_timestamp()` })
          .where(eq(actionRevisions.id, revision.id));
        await tx
          .update(actionProposals)
          .set({
            status: 'superseded',
            version: sql`${actionProposals.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(actionProposals.id, proposal.id));
        await tx
          .update(approvalDecisions)
          .set({
            state: 'superseded',
            supersededAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(approvalDecisions.sandboxId, input.sandboxId),
              eq(approvalDecisions.actionRevisionId, revision.id),
              eq(approvalDecisions.state, 'active'),
            ),
          );
        const refreshed = await tx
          .select()
          .from(actionExecutions)
          .where(
            and(
              eq(actionExecutions.sandboxId, input.sandboxId),
              eq(actionExecutions.actionRevisionId, revision.id),
            ),
          );
        const summary = buildPartialSummary(refreshed);
        const existingHandoff = await tx
          .select({ id: actionReanalysisHandoffs.id })
          .from(actionReanalysisHandoffs)
          .where(eq(actionReanalysisHandoffs.sourceRevisionId, revision.id))
          .limit(1);
        const handoffId = existingHandoff[0]?.id ?? randomUUID();
        if (existingHandoff[0]) {
          await tx
            .update(actionReanalysisHandoffs)
            .set({
              succeededReceiptKeys: summary.succeededReceiptKeys,
              cancelledItemIds: summary.cancelledItemIds,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(actionReanalysisHandoffs.id, handoffId));
        } else {
          await tx.insert(actionReanalysisHandoffs).values({
            id: handoffId,
            sandboxId: input.sandboxId,
            sourceProposalId: proposal.id,
            sourceRevisionId: revision.id,
            succeededReceiptKeys: summary.succeededReceiptKeys,
            cancelledItemIds: summary.cancelledItemIds,
            state: 'pending',
            createdAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          });
        }
        await createLinkedProposalForHandoff(tx, handoffId);
        await appendAuditInTransaction(tx, {
          sandboxId: input.sandboxId,
          requestId: input.requestId,
          correlationId: input.correlationId,
          actor: { kind: 'service', id: 'action-canceller', roles: [] },
          runId: null,
          action: 'action.plan_cancelled',
          targetType: 'action_proposal',
          targetId: proposal.id,
          targetVersion: String(revision.revisionNumber),
          beforeHash: revision.planHash,
          afterHash: revision.planHash,
          outcome: 'denied',
          details: {
            caseId: proposal.caseId,
            actionRevisionId: revision.id,
            planHash: revision.planHash,
            policyRevision: revision.policyRevision,
            status: 'cancelled',
            reasonCode: 'plan_cancelled',
          },
        });
        return { ok: true, summary, handoffId };
      });
    },
  };
}

export async function createLinkedProposalForHandoff(
  tx: DbTransaction,
  handoffId: string,
): Promise<string | null> {
  const handoffRows = await tx
    .select()
    .from(actionReanalysisHandoffs)
    .where(eq(actionReanalysisHandoffs.id, handoffId))
    .limit(1);
  const handoff = handoffRows[0];
  if (!handoff || handoff.createdProposalId !== null) {
    return handoff?.createdProposalId ?? null;
  }
  const revisionRows = await tx
    .select()
    .from(actionRevisions)
    .where(
      and(
        eq(actionRevisions.sandboxId, handoff.sandboxId),
        eq(actionRevisions.id, handoff.sourceRevisionId),
      ),
    )
    .limit(1);
  const revision = revisionRows[0];
  const proposalRows = await tx
    .select()
    .from(actionProposals)
    .where(
      and(
        eq(actionProposals.sandboxId, handoff.sandboxId),
        eq(actionProposals.id, handoff.sourceProposalId),
      ),
    )
    .limit(1);
  const sourceProposal = proposalRows[0];
  if (!revision || !sourceProposal) {
    return null;
  }
  const executions = await tx
    .select()
    .from(actionExecutions)
    .where(
      and(
        eq(actionExecutions.sandboxId, handoff.sandboxId),
        eq(actionExecutions.actionRevisionId, revision.id),
      ),
    );
  const succeeded = executions.filter(
    (execution) => execution.state === 'succeeded',
  );
  const succeededIds = new Set(succeeded.map((execution) => execution.itemId));
  const resultByItem = new Map(
    succeeded.map((execution) => [execution.itemId, execution]),
  );
  const plans = ActionPlanItemSchema.array().parse(revision.items);
  const unsent = plans.filter((item) => !succeededIds.has(item.itemId));
  await tx
    .update(actionReanalysisHandoffs)
    .set({ state: 'consumed', updatedAt: sql`clock_timestamp()` })
    .where(eq(actionReanalysisHandoffs.id, handoff.id));
  if (unsent.length === 0) {
    return null;
  }
  const changes: EntityChange[] = [];
  const changeRows = await tx
    .select({
      entityType: actionExecutionEntityChanges.entityType,
      entityId: actionExecutionEntityChanges.entityId,
      beforeVersion: actionExecutionEntityChanges.beforeVersion,
      afterVersion: actionExecutionEntityChanges.afterVersion,
    })
    .from(actionExecutionEntityChanges)
    .innerJoin(
      actionExecutionReceipts,
      and(
        eq(actionExecutionReceipts.sandboxId, actionExecutionEntityChanges.sandboxId),
        eq(actionExecutionReceipts.id, actionExecutionEntityChanges.receiptId),
      ),
    )
    .innerJoin(
      actionExecutions,
      and(
        eq(actionExecutions.sandboxId, actionExecutionReceipts.sandboxId),
        eq(actionExecutions.id, actionExecutionReceipts.executionId),
      ),
    )
    .where(
      and(
        eq(actionExecutionEntityChanges.sandboxId, handoff.sandboxId),
        eq(actionExecutions.actionRevisionId, revision.id),
        eq(actionExecutions.state, 'succeeded'),
      ),
    )
    .orderBy(actionExecutionEntityChanges.ordinal);
  for (const row of changeRows) {
    changes.push({
      entityType: row.entityType,
      entityId: row.entityId,
      beforeVersion: row.beforeVersion,
      afterVersion: row.afterVersion,
    });
  }
  const unsentIds = new Set(unsent.map((item) => item.itemId));
  const items = unsent.map((item) => {
    let payload = item.payload;
    if (payload.kind === 'enterprise.send_message') {
      payload = {
        ...payload,
        parts: payload.parts.map((part) => {
          if (part.kind !== 'receipt_fact') {
            return part;
          }
          const source = resultByItem.get(part.binding.fromItemId);
          if (source && !unsentIds.has(part.binding.fromItemId)) {
            return {
              kind: 'text' as const,
              text: `${part.label}: ${source.resultEntityId ?? ''}`,
            };
          }
          return part;
        }),
      };
    }
    return {
      ...item,
      payload,
      dependsOnItemIds: item.dependsOnItemIds.filter((id) => unsentIds.has(id)),
      baseExpectedVersions: advanceBaseVersions(item.baseExpectedVersions, changes),
    };
  });
  ActionPlanItemSchema.array().parse(items);
  const planHash = computePlanHash({
    items,
    policyRevision: revision.policyRevision,
    policyContentHash: revision.policyContentHash,
  });
  const committed = items.reduce(
    (total, item) => total + purchaseOrderCommitmentMinor(item),
    0n,
  );
  const newProposalId = randomUUID();
  const newRevisionId = randomUUID();
  await tx.insert(actionProposals).values({
    id: newProposalId,
    sandboxId: handoff.sandboxId,
    caseId: sourceProposal.caseId,
    currentRevisionId: null,
    status: 'pending_approval',
    hasProcurement: items.some(
      (item) => item.payload.kind === 'enterprise.create_purchase_order',
    ),
    createdByKind: 'service',
    createdById: 'reanalysis-handoff',
    version: 0,
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  });
  await tx.insert(actionRevisions).values({
    id: newRevisionId,
    sandboxId: handoff.sandboxId,
    proposalId: newProposalId,
    revisionNumber: 1,
    state: 'pending_approval',
    planHash,
    items,
    requiredRoles: revision.requiredRoles,
    aggregateImpactMinor: Number(committed),
    isProcurement: items.some(
      (item) => item.payload.kind === 'enterprise.create_purchase_order',
    ),
    policyRevision: revision.policyRevision,
    policyContentHash: revision.policyContentHash,
    rationale: 'Linked reanalysis after partial effects; prior approvals are not carried over.',
    authoredByKind: 'service',
    authoredById: 'reanalysis-handoff',
    authoredByRoles: [],
    expiresAt: sql`clock_timestamp() + interval '24 hours'`,
    createdAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  });
  for (const evidenceId of [
    ...new Set(items.flatMap((item) => item.evidenceIds)),
  ]) {
    await tx.insert(actionRevisionEvidence).values({
      sandboxId: handoff.sandboxId,
      revisionId: newRevisionId,
      evidenceId,
    });
  }
  await tx
    .update(actionProposals)
    .set({
      currentRevisionId: newRevisionId,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(actionProposals.id, newProposalId));
  await tx
    .update(actionReanalysisHandoffs)
    .set({
      createdProposalId: newProposalId,
      state: 'consumed',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(actionReanalysisHandoffs.id, handoff.id));
  return newProposalId;
}

function buildPartialSummary(
  executions: Array<typeof actionExecutions.$inferSelect>,
): PartialEffectSummary {
  return {
    succeededReceiptKeys: [
      ...new Set(
        executions
          .filter(
            (execution) =>
              execution.state === 'succeeded' && execution.receiptKey !== null,
          )
          .map((execution) => execution.receiptKey as string),
      ),
    ].sort(),
    cancelledItemIds: executions
      .filter((execution) => execution.state === 'cancelled')
      .map((execution) => execution.itemId)
      .sort(),
    unknownItemIds: executions
      .filter((execution) => execution.state === 'unknown')
      .map((execution) => execution.itemId)
      .sort(),
    pendingItemIds: executions
      .filter((execution) => execution.state === 'pending')
      .map((execution) => execution.itemId)
      .sort(),
    effects: executions
      .filter((execution) =>
        ['succeeded', 'cancelled', 'unknown'].includes(execution.state),
      )
      .map((execution) => ({
        itemId: execution.itemId,
        kind:
          execution.state === 'succeeded'
            ? ('succeeded' as const)
            : execution.state === 'cancelled'
              ? ('cancelled' as const)
              : ('unknown' as const),
        receiptKey: execution.receiptKey,
        entityType: execution.resultEntityType,
        entityId: execution.resultEntityId,
      })),
  };
}

async function reissueAllowed(
  executor: NexusDb | DbTransaction,
  execution: typeof actionExecutions.$inferSelect,
  policy: { readonly revision: string; readonly contentHash: string },
): Promise<boolean> {
  const result = await executor.execute(sql`
    SELECT 1
    FROM nexus.action_proposals AS proposal
    JOIN nexus.action_revisions AS revision
      ON revision.sandbox_id = proposal.sandbox_id AND revision.id = proposal.current_revision_id
    JOIN nexus.cases AS case_row
      ON case_row.sandbox_id = proposal.sandbox_id AND case_row.id = proposal.case_id
    JOIN nexus.action_executions AS execution
      ON execution.sandbox_id = proposal.sandbox_id AND execution.id = ${execution.id}
    WHERE proposal.sandbox_id = ${execution.sandboxId}
      AND proposal.id = ${execution.proposalId}
      AND proposal.current_revision_id = ${execution.actionRevisionId}
      AND proposal.status = 'approved'
      AND revision.state = 'approved'
      AND revision.id = ${execution.actionRevisionId}
      AND revision.expires_at > clock_timestamp()
      AND revision.policy_revision = ${policy.revision}
      AND revision.policy_content_hash = ${policy.contentHash}
      AND execution.state IN ('in_progress', 'unknown')
      AND case_row.status NOT IN ('resolved', 'escalated', 'cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM nexus.action_case_cancellations AS cancellation
        WHERE cancellation.sandbox_id = execution.sandbox_id
          AND cancellation.case_id = execution.case_id
      )
      AND EXISTS (
        SELECT 1 FROM nexus.active_sandbox AS active
        WHERE active.sandbox_id = proposal.sandbox_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(revision.required_roles) AS required_role
        WHERE NOT EXISTS (
          SELECT 1 FROM nexus.approval_decisions AS decision
          WHERE decision.sandbox_id = proposal.sandbox_id
            AND decision.action_revision_id = revision.id
            AND decision.decision = 'approve'
            AND decision.state = 'active'
            AND decision.role = required_role
            AND EXISTS (
              SELECT 1 FROM nexus.user_roles AS user_role
              WHERE user_role.user_id = decision.actor_id::uuid
                AND user_role.role = decision.role
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM nexus.action_revision_evidence AS link
        JOIN nexus.evidence AS evidence
          ON evidence.sandbox_id = link.sandbox_id AND evidence.id = link.evidence_id
        WHERE link.sandbox_id = proposal.sandbox_id
          AND link.revision_id = revision.id
          AND evidence.source_status <> 'available'
      )
    LIMIT 1
  `);
  return (result.rows?.length ?? 0) > 0;
}

async function lockExecution(
  tx: DbTransaction,
  sandboxId: string,
  executionId: string,
): Promise<typeof actionExecutions.$inferSelect | null> {
  const rows = await tx
    .select()
    .from(actionExecutions)
    .where(
      and(
        eq(actionExecutions.sandboxId, sandboxId),
        eq(actionExecutions.id, executionId),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function recordPartialEffect(
  tx: DbTransaction,
  execution: typeof actionExecutions.$inferSelect,
  kind: 'succeeded' | 'cancelled' | 'unknown',
  receiptKey: string | null,
  detail = '',
): Promise<void> {
  await tx
    .insert(actionPartialEffects)
    .values({
      id: randomUUID(),
      sandboxId: execution.sandboxId,
      executionId: execution.id,
      kind,
      receiptKey,
      itemId: execution.itemId,
      summary:
        kind === 'succeeded'
          ? 'Effect confirmed by simulator receipt.'
          : kind === 'unknown'
            ? 'Effect remains uncertain.'
            : `No effect recorded${detail === '' ? '' : `: ${detail}`}.`,
      createdAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing();
}

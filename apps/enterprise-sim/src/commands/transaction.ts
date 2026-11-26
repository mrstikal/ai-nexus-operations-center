import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  canonicalizeEnterpriseCommandItem,
  EnterpriseCommandReceiptSchema,
  receiptKeyFor,
  sortEnterpriseBaseVersions,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandEntityChange,
  type EnterpriseCommandKind,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
} from '@nexus/contracts';
import { ProblemException } from '../auth.js';

export interface CommandContext {
  readonly client: PoolClient;
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly businessEffectiveAt: Date;
  readonly now: Date;
  readonly kind: EnterpriseCommandKind;
  readonly receiptKey: string;
  readonly request: EnterpriseCommandRequest;
  readonly baseExpectedVersions: EnterpriseBaseExpectedVersion[];
  readonly priorReceiptKeys: string[];
}

export interface CommandOutboxEvent {
  readonly eventType:
    | 'enterprise.inventory.changed.v1'
    | 'enterprise.communication.created.v1';
  readonly aggregateType: 'inventory' | 'communication';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Record<string, unknown>;
}

export interface CommandEffect {
  readonly resultEntityType: 'purchase_order' | 'communication';
  readonly resultEntityId: string;
  readonly resultEntityVersion: number;
  readonly entityChanges: EnterpriseCommandEntityChange[];
  readonly outboxEvents: CommandOutboxEvent[];
}

export interface CommandExecutionInput {
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly kind: EnterpriseCommandKind;
  readonly request: EnterpriseCommandRequest;
}

interface SandboxRow {
  id: string;
  status: string;
  version: number;
  business_effective_at: Date;
}

interface ReceiptRow {
  id: string;
  sandbox_id: string;
  idempotency_key: string;
  command_kind: string;
  action_revision_id: string;
  item_id: string;
  plan_hash: string;
  item_hash: string;
  prior_receipt_keys: string[];
  execute_before: Date;
  authorization_valid_until: Date;
  result_entity_type: string;
  result_entity_id: string;
  result_entity_version: number;
  status: string;
  created_at: Date;
}

interface BaseVersionRow {
  entity_type: string;
  entity_id: string;
  entity_reference: string | null;
  expected_version: number;
}

interface EntityChangeRow {
  entity_type: string;
  entity_id: string;
  before_version: number | null;
  after_version: number;
}

interface ProofRow {
  id: string;
  idempotency_key: string;
  action_revision_id: string;
  plan_hash: string;
}

function validationFailure(message: string, issues?: unknown[]): ProblemException {
  return new ProblemException('VALIDATION_FAILED', message, issues);
}

function iso(value: Date): string {
  return value.toISOString();
}

function itemHash(request: EnterpriseCommandRequest): string {
  return createHash('sha256')
    .update(
      canonicalizeEnterpriseCommandItem({
        payloadTemplate: request.payloadTemplate,
        baseExpectedVersions: request.baseExpectedVersions,
      }),
      'utf8',
    )
    .digest('hex');
}

function normalizeBaseVersions(
  versions: readonly EnterpriseBaseExpectedVersion[],
): EnterpriseBaseExpectedVersion[] {
  const seen = new Set<string>();
  for (const version of versions) {
    const key = `${version.type}:${version.id}`;
    if (seen.has(key)) {
      throw validationFailure('baseExpectedVersions contains a duplicate entity', [
        { path: ['baseExpectedVersions'], message: `Duplicate ${key}` },
      ]);
    }
    seen.add(key);
  }
  return sortEnterpriseBaseVersions(versions);
}

function normalizeProofKeys(
  keys: readonly string[],
  ownKey: string,
): string[] {
  const unique = [...new Set(keys)].sort();
  if (unique.includes(ownKey)) {
    throw validationFailure('priorReceiptKeys must not contain the current receipt key');
  }
  return unique;
}

async function resolveEntityReference(
  client: PoolClient,
  sandboxId: string,
  type: EnterpriseBaseExpectedVersion['type'],
  id: string,
): Promise<{ version: number; reference: string | null } | null> {
  let query: string;
  switch (type) {
    case 'sandbox':
      query = 'SELECT version, name AS reference FROM enterprise.sandboxes WHERE id = $1';
      break;
    case 'supplier':
      query = 'SELECT version, reference FROM enterprise.suppliers WHERE sandbox_id = $1 AND id = $2';
      break;
    case 'product':
      query = 'SELECT version, sku AS reference FROM enterprise.products WHERE sandbox_id = $1 AND id = $2';
      break;
    case 'customer':
      query = 'SELECT version, reference FROM enterprise.customers WHERE sandbox_id = $1 AND id = $2';
      break;
    case 'agreement':
      query = 'SELECT version, reference FROM enterprise.agreements WHERE sandbox_id = $1 AND id = $2';
      break;
    case 'purchase_order':
      query = 'SELECT version, reference FROM enterprise.purchase_orders WHERE sandbox_id = $1 AND id = $2';
      break;
    case 'inventory':
      query = 'SELECT version, NULL::text AS reference FROM enterprise.inventory WHERE sandbox_id = $1 AND product_id = $2';
      break;
  }

  const parameters = type === 'sandbox' ? [id] : [sandboxId, id];
  const result = await client.query<{ version: number; reference: string | null }>(
    query,
    parameters,
  );
  const row = result.rows[0];
  return row ? { version: row.version, reference: row.reference } : null;
}

async function validateBaseVersions(
  client: PoolClient,
  sandboxId: string,
  versions: readonly EnterpriseBaseExpectedVersion[],
): Promise<void> {
  for (const expected of versions) {
    const current = await resolveEntityReference(
      client,
      sandboxId,
      expected.type,
      expected.id,
    );
    if (!current) {
      throw new ProblemException(
        'STALE_STATE',
        `Base entity ${expected.type}:${expected.id} is not present`,
      );
    }
    if (
      current.version !== expected.version ||
      (expected.reference !== null && current.reference !== expected.reference)
    ) {
      throw new ProblemException(
        'STALE_STATE',
        `Base entity ${expected.type}:${expected.id} has changed`,
      );
    }
  }
}

async function validateProofs(
  client: PoolClient,
  sandboxId: string,
  request: EnterpriseCommandRequest,
  actionRevisionId: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    const result = await client.query<ProofRow>(
      `SELECT id, idempotency_key, action_revision_id, plan_hash
       FROM enterprise.command_receipts
       WHERE sandbox_id = $1 AND idempotency_key = $2`,
      [sandboxId, key],
    );
    const proof = result.rows[0];
    if (
      !proof ||
      proof.action_revision_id !== actionRevisionId ||
      proof.plan_hash !== request.planHash
    ) {
      throw new ProblemException(
        'STALE_STATE',
        'priorReceiptKeys must reference committed receipts of this revision and plan',
      );
    }
  }
}

export async function loadReceipt(
  queryable: Pool | PoolClient,
  sandboxId: string,
  id: string,
): Promise<EnterpriseCommandReceipt | null> {
  const receiptResult = await queryable.query<ReceiptRow>(
    `SELECT id, sandbox_id, idempotency_key, command_kind, action_revision_id,
            item_id, plan_hash, item_hash, prior_receipt_keys, execute_before,
            authorization_valid_until, result_entity_type, result_entity_id,
            result_entity_version, status, created_at
     FROM enterprise.command_receipts
     WHERE sandbox_id = $1 AND id = $2`,
    [sandboxId, id],
  );
  const row = receiptResult.rows[0];
  if (!row) {
    return null;
  }

  const baseResult = await queryable.query<BaseVersionRow>(
    `SELECT entity_type, entity_id, entity_reference, expected_version
     FROM enterprise.command_receipt_base_versions
     WHERE sandbox_id = $1 AND receipt_id = $2
     ORDER BY ordinal`,
    [sandboxId, id],
  );
  const changeResult = await queryable.query<EntityChangeRow>(
    `SELECT entity_type, entity_id, before_version, after_version
     FROM enterprise.command_receipt_entity_changes
     WHERE sandbox_id = $1 AND receipt_id = $2
     ORDER BY ordinal`,
    [sandboxId, id],
  );

  return EnterpriseCommandReceiptSchema.parse({
    id: row.id,
    sandboxId: row.sandbox_id,
    idempotencyKey: row.idempotency_key,
    commandKind: row.command_kind,
    actionRevisionId: row.action_revision_id,
    itemId: row.item_id,
    planHash: row.plan_hash,
    itemHash: row.item_hash,
    status: row.status,
    executeBefore: iso(row.execute_before),
    authorizationValidUntil: iso(row.authorization_valid_until),
    baseExpectedVersions: baseResult.rows.map((base) => ({
      system: 'enterprise',
      type: base.entity_type,
      id: base.entity_id,
      reference: base.entity_reference,
      version: base.expected_version,
    })),
    priorReceiptKeys: row.prior_receipt_keys,
    result: {
      entityType: row.result_entity_type,
      id: row.result_entity_id,
      version: row.result_entity_version,
    },
    entityChanges: changeResult.rows.map((change) => ({
      entityType: change.entity_type,
      id: change.entity_id,
      beforeVersion: change.before_version,
      afterVersion: change.after_version,
    })),
    createdAt: iso(row.created_at),
  });
}

export async function loadReceiptByKey(
  queryable: Pool | PoolClient,
  sandboxId: string,
  idempotencyKey: string,
): Promise<EnterpriseCommandReceipt | null> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM enterprise.command_receipts
     WHERE sandbox_id = $1 AND idempotency_key = $2`,
    [sandboxId, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? loadReceipt(queryable, sandboxId, row.id) : null;
}

function receiptMatches(
  row: ReceiptRow,
  request: EnterpriseCommandRequest,
  actionRevisionId: string,
  itemId: string,
): boolean {
  return (
    row.command_kind === request.payloadTemplate.kind &&
    row.action_revision_id === actionRevisionId &&
    row.item_id === itemId &&
    row.plan_hash === request.planHash &&
    row.item_hash === request.itemHash
  );
}

function isPgError(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export async function runCommandTransaction(
  pool: Pool,
  input: CommandExecutionInput,
  handler: (context: CommandContext) => Promise<CommandEffect>,
): Promise<EnterpriseCommandReceipt> {
  const expectedItemHash = itemHash(input.request);
  if (expectedItemHash !== input.request.itemHash) {
    throw validationFailure('itemHash does not match the canonical payload and base versions');
  }

  const receiptId = randomUUID();
  const sandboxId = input.sandboxId.toLowerCase();
  const actionRevisionId = input.request.actionRevisionId.toLowerCase();
  const itemId = input.request.itemId.toLowerCase();
  const receiptKey = receiptKeyFor(
    sandboxId,
    actionRevisionId,
    itemId,
    input.kind,
  );

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL transaction_timeout = '10s'");

    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('enterprise-command:' || $1, 0)
       )`,
      [sandboxId],
    );
    const sandboxResult = await client.query<SandboxRow>(
      `SELECT id, status, version, business_effective_at
       FROM enterprise.sandboxes
       WHERE id = $1`,
      [sandboxId],
    );
    const sandbox = sandboxResult.rows[0];
    if (!sandbox) {
      throw new ProblemException('NOT_FOUND', 'Enterprise sandbox was not found');
    }

    const clockResult = await client.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    );
    const now = clockResult.rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Enterprise command clock is unavailable',
      );
    }

    const existingResult = await client.query<ReceiptRow>(
      `SELECT id, sandbox_id, idempotency_key, command_kind, action_revision_id,
              item_id, plan_hash, item_hash, prior_receipt_keys, execute_before,
              authorization_valid_until, result_entity_type, result_entity_id,
              result_entity_version, status, created_at
       FROM enterprise.command_receipts
       WHERE sandbox_id = $1 AND idempotency_key = $2`,
      [sandboxId, receiptKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (!receiptMatches(existing, input.request, actionRevisionId, itemId)) {
        throw new ProblemException(
          'IDEMPOTENCY_MISMATCH',
          'The idempotency key is already bound to a different business identity',
        );
      }
      const receipt = await loadReceipt(client, sandboxId, existing.id);
      if (!receipt) {
        throw new ProblemException(
          'DEPENDENCY_UNAVAILABLE',
          'Enterprise command receipt is unavailable',
        );
      }
      await client.query('COMMIT');
      committed = true;
      return receipt;
    }

    if (sandbox.status !== 'active') {
      throw new ProblemException('STALE_STATE', 'Enterprise sandbox is retired');
    }

    const planHashes = await client.query<{ plan_hash: string }>(
      `SELECT DISTINCT plan_hash
       FROM enterprise.command_receipts
       WHERE sandbox_id = $1 AND action_revision_id = $2`,
      [sandboxId, actionRevisionId],
    );
    if (planHashes.rows.some((row) => row.plan_hash !== input.request.planHash)) {
      throw new ProblemException(
        'IDEMPOTENCY_MISMATCH',
        'The action revision is already bound to a different planHash',
      );
    }

    const executeBefore = new Date(input.request.executeBefore);
    const authorizationValidUntil = new Date(
      input.request.authorizationValidUntil,
    );
    if (
      !Number.isFinite(executeBefore.getTime()) ||
      !Number.isFinite(authorizationValidUntil.getTime())
    ) {
      throw validationFailure('Command deadlines must be valid timestamps');
    }
    if (executeBefore.getTime() <= now.getTime()) {
      throw new ProblemException('APPROVAL_EXPIRED', 'executeBefore has already expired');
    }
    if (authorizationValidUntil.getTime() <= now.getTime()) {
      throw new ProblemException(
        'APPROVAL_EXPIRED',
        'authorizationValidUntil has already expired',
      );
    }
    if (executeBefore.getTime() > authorizationValidUntil.getTime()) {
      throw validationFailure(
        'executeBefore must not exceed authorizationValidUntil',
      );
    }
    if (executeBefore.getTime() > now.getTime() + 30_000) {
      throw validationFailure('executeBefore exceeds the DB clock by more than 30 seconds');
    }

    const baseExpectedVersions = normalizeBaseVersions(
      input.request.baseExpectedVersions,
    );
    const priorReceiptKeys = normalizeProofKeys(
      input.request.priorReceiptKeys,
      receiptKey,
    );
    await validateBaseVersions(client, sandboxId, baseExpectedVersions);
    await validateProofs(
      client,
      sandboxId,
      input.request,
      actionRevisionId,
      priorReceiptKeys,
    );

    const effect = await handler({
      client,
      sandboxId,
      correlationId: input.correlationId,
      businessEffectiveAt: sandbox.business_effective_at,
      now,
      kind: input.kind,
      receiptKey,
      request: input.request,
      baseExpectedVersions,
      priorReceiptKeys,
    });

    const commitClockResult = await client.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    );
    const commitClock = commitClockResult.rows[0]?.now;
    if (!(commitClock instanceof Date)) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Enterprise command clock is unavailable',
      );
    }
    if (executeBefore.getTime() <= commitClock.getTime()) {
      throw new ProblemException('APPROVAL_EXPIRED', 'executeBefore has already expired');
    }

    const receiptResult = await client.query<{ created_at: Date }>(
      `INSERT INTO enterprise.command_receipts
         (id, sandbox_id, idempotency_key, command_kind, action_revision_id,
          item_id, plan_hash, item_hash, prior_receipt_keys, execute_before,
          authorization_valid_until, result_entity_type, result_entity_id,
          result_entity_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'succeeded')
       RETURNING created_at`,
      [
        receiptId,
        sandboxId,
        receiptKey,
        input.kind,
        actionRevisionId,
        itemId,
        input.request.planHash,
        input.request.itemHash,
        priorReceiptKeys,
        input.request.executeBefore,
        input.request.authorizationValidUntil,
        effect.resultEntityType,
        effect.resultEntityId,
        effect.resultEntityVersion,
      ],
    );
    const createdAt = receiptResult.rows[0]?.created_at;
    if (!(createdAt instanceof Date)) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Enterprise command receipt timestamp is unavailable',
      );
    }

    for (const [ordinal, base] of baseExpectedVersions.entries()) {
      await client.query(
        `INSERT INTO enterprise.command_receipt_base_versions
           (id, sandbox_id, receipt_id, ordinal, entity_type, entity_id,
            entity_reference, expected_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          sandboxId,
          receiptId,
          ordinal,
          base.type,
          base.id,
          base.reference,
          base.version,
        ],
      );
    }

    for (const [ordinal, change] of effect.entityChanges.entries()) {
      await client.query(
        `INSERT INTO enterprise.command_receipt_entity_changes
           (id, sandbox_id, receipt_id, ordinal, entity_type, entity_id,
            before_version, after_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          sandboxId,
          receiptId,
          ordinal,
          change.entityType,
          change.id,
          change.beforeVersion,
          change.afterVersion,
        ],
      );
    }

    for (const event of effect.outboxEvents) {
      const payload = {
        ...event.payload,
        origin: {
          actionRevisionId,
          itemId,
          receiptId,
          receiptKey,
        },
      };
      await client.query(
        `INSERT INTO enterprise.event_outbox
           (id, sandbox_id, event_type, schema_version, correlation_id,
            causation_id, aggregate_type, aggregate_id, aggregate_version, payload,
            status, attempt_count, next_attempt_at, version,
            origin_action_revision_id, origin_item_id, origin_receipt_id,
            origin_receipt_key)
         VALUES ($1, $2, $3, 1, $4, NULL, $5, $6, $7, $8::jsonb,
                 'pending', 0, clock_timestamp(), 0, $9, $10, $11, $12)`,
        [
          randomUUID(),
          sandboxId,
          event.eventType,
          input.correlationId,
          event.aggregateType,
          event.aggregateId,
          event.aggregateVersion,
          JSON.stringify(payload),
          actionRevisionId,
          itemId,
          receiptId,
          receiptKey,
        ],
      );
    }

    const receipt = await loadReceipt(client, sandboxId, receiptId);
    if (!receipt) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Enterprise command receipt is unavailable',
      );
    }

    await client.query('COMMIT');
    committed = true;
    return receipt;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original command failure remains the actionable error.
      }
    }
    if (error instanceof ProblemException) {
      throw error;
    }
    if (isPgError(error)) {
      if (['55P03', '40001', '40P01'].includes(error.code ?? '')) {
        throw new ProblemException(
          'CONFLICT',
          'Enterprise command lock or transaction conflict; retry with the same key',
        );
      }
      if (error.code === '23505') {
        throw new ProblemException(
          'IDEMPOTENCY_MISMATCH',
          'Enterprise command receipt conflicts with an existing receipt',
        );
      }
      if (error.code === '23514' || error.code === '23503') {
        throw new ProblemException(
          'STALE_STATE',
          'Enterprise command violates a current business constraint',
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

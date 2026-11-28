import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client, PoolConfig } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SupplyScenarioFixtureSchema,
  type SupplyCalculationRequest,
  type SupplyRecommendationInput,
} from '@nexus/contracts';
import { calculateSupply } from '@nexus/domain/supply/calculate';
import { buildCalculationEvidence } from '@nexus/application/verification/citations';
import { verifySupplyRecommendation } from '@nexus/application/verification/deterministic';
import { createNexusDb, createNexusPool } from '@nexus/db/connection';
import { applyMigrations, loadMigrations } from '@nexus/db/migrate';
import {
  getEvidenceRow,
  insertEvidenceInTransaction,
} from '@nexus/db/repositories/evidence';

const { Client: PgClient } = pg;
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SANDBOX_ID = '00000000-0000-4000-8000-000000000002';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing ${name}; run this suite through pnpm test:integration F19`);
  }
  return value;
}

function pgConfig(user: string, password: string): PoolConfig {
  return {
    host: requiredEnv('NEXUS_TEST_PG_HOST'),
    port: Number(requiredEnv('NEXUS_TEST_PG_PORT')),
    database: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    user,
    password,
    application_name: 'f19-evidence-test',
    connectionTimeoutMillis: 5000,
  };
}

function loadFixture(name: string) {
  return SupplyScenarioFixtureSchema.parse(
    JSON.parse(
      readFileSync(path.join(root, 'fixtures/scenarios', name), 'utf8'),
    ),
  );
}

let superuser: Client;
let migrator: Client;
let apiPool: ReturnType<typeof createNexusPool>;
let apiDb: ReturnType<typeof createNexusDb>;

async function persistCalculationEvidence(input: {
  sandboxId: string;
  payload: ReturnType<typeof buildCalculationEvidence>;
  kind?: 'calculation' | 'enterprise_snapshot';
  facts?: unknown;
}): Promise<string> {
  const evidenceId = randomUUID();
  const requestId = randomUUID();
  const correlationId = randomUUID();
  await apiDb.transaction((tx) =>
    insertEvidenceInTransaction(tx, {
      evidenceId,
      sandboxId: input.sandboxId,
      caseId: null,
      kind: input.kind ?? 'calculation',
      sourceStatus: 'available',
      sourceRef: null,
      sourceSandboxId: null,
      contentHash: input.payload.contentHash,
      locator: null,
      capturedFacts: (input.facts ?? input.payload.capturedFacts) as never,
      missingReason: null,
      actor: { kind: 'service', id: 'f19-evidence-test', roles: [] },
      requestId,
      correlationId,
      audit: {
        action: 'evidence.created',
        outcome: 'succeeded',
        details: { evidenceId },
      },
    }),
  );
  return evidenceId;
}

function recommendationFor(
  calculation: ReturnType<typeof calculateSupply>,
  evidenceId: string,
): SupplyRecommendationInput {
  const option = calculation.optionSets.at(-1)!.options[0]!;
  return {
    optionIds: [option.optionId],
    claims: [
      {
        claimId: 'commitment',
        kind: 'option_additional_commitment',
        optionId: option.optionId,
        productId: null,
        deadline: null,
        value: option.additionalCommitmentMinor,
        evidenceIds: [evidenceId],
      },
    ],
    evidenceIds: [evidenceId],
  };
}

beforeAll(async () => {
  superuser = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_SUPERUSER_USER'),
      requiredEnv('NEXUS_TEST_SUPERUSER_PASSWORD'),
    ),
  );
  migrator = new PgClient(
    pgConfig(
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_USER'),
      requiredEnv('NEXUS_TEST_NEXUS_MIGRATOR_PASSWORD'),
    ),
  );
  await superuser.connect();
  await migrator.connect();
  await applyMigrations(migrator, {
    schema: 'nexus',
    migrations: loadMigrations(path.join(root, 'packages/db/migrations')),
  });
  await superuser.query(
    `INSERT INTO nexus.sandboxes
       (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, 'F19 sandbox', 'active', '2026-11-02T09:00:00Z', 1,
             clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [SANDBOX_ID],
  );
  await superuser.query(
    `INSERT INTO nexus.sandboxes
       (id, name, status, business_effective_at, version, created_at, updated_at)
     VALUES ($1, 'F19 other sandbox', 'active', '2026-11-02T09:00:00Z', 1,
             clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_SANDBOX_ID],
  );
  await superuser.query(
    `UPDATE nexus.active_sandbox
     SET sandbox_id = $1, updated_at = clock_timestamp()
     WHERE singleton = true`,
    [SANDBOX_ID],
  );
  apiPool = createNexusPool('api', {
    NEXUS_DB_HOST: requiredEnv('NEXUS_TEST_PG_HOST'),
    NEXUS_DB_PORT: requiredEnv('NEXUS_TEST_PG_PORT'),
    NEXUS_DB_NAME: requiredEnv('NEXUS_TEST_PG_DATABASE'),
    NEXUS_API_DB_USER: requiredEnv('NEXUS_TEST_NEXUS_API_USER'),
    NEXUS_API_DB_PASSWORD: requiredEnv('NEXUS_TEST_NEXUS_API_PASSWORD'),
  });
  apiDb = createNexusDb(apiPool);
}, 120_000);

afterAll(async () => {
  await apiPool?.end();
  await migrator?.end();
  await superuser?.end();
});

beforeEach(async () => {
  await superuser.query(
    `TRUNCATE TABLE nexus.audit_events, nexus.evidence CASCADE`,
  );
});

describe('F19 calculation evidence package', () => {
  it('persists exact calculation facts and verifies a supported recommendation', async () => {
    const fixture = loadFixture('a-partial-split.json');
    const calculation = calculateSupply(fixture.request);
    const payload = buildCalculationEvidence(calculation);
    const evidenceId = await persistCalculationEvidence({
      sandboxId: SANDBOX_ID,
      payload,
    });
    const stored = await getEvidenceRow(apiDb, SANDBOX_ID, evidenceId);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('calculation');
    expect(stored!.contentHash).toBe(payload.contentHash);
    expect(stored!.capturedFacts).toMatchObject({
      ruleVersion: 'supply-rules-v1',
      inputHash: calculation.inputHash,
      resultHash: calculation.resultHash,
    });
    const verification = verifySupplyRecommendation({
      recommendation: recommendationFor(calculation, evidenceId),
      calculation,
      evidence: new Map([
        [
          evidenceId,
          {
            id: evidenceId,
            kind: stored!.kind,
            contentHash: stored!.contentHash,
            capturedFacts: stored!.capturedFacts,
          },
        ],
      ]),
    });
    expect(verification).toEqual({ ok: true, findings: [] });
  });

  it('rejects an invented amount even when the citation ID exists', async () => {
    const fixture = loadFixture('a-partial-split.json');
    const calculation = calculateSupply(fixture.request);
    const payload = buildCalculationEvidence(calculation);
    const evidenceId = await persistCalculationEvidence({
      sandboxId: SANDBOX_ID,
      payload,
    });
    const stored = await getEvidenceRow(apiDb, SANDBOX_ID, evidenceId);
    const recommendation = recommendationFor(calculation, evidenceId);
    recommendation.claims[0]!.value = '999999';
    const verification = verifySupplyRecommendation({
      recommendation,
      calculation,
      evidence: new Map([
        [
          evidenceId,
          {
            id: evidenceId,
            kind: stored!.kind,
            contentHash: stored!.contentHash,
            capturedFacts: stored!.capturedFacts,
          },
        ],
      ]),
    });
    expect(verification.ok).toBe(false);
    expect(verification.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CLAIM_VALUE_MISMATCH',
          claimId: 'commitment',
        }),
      ]),
    );
  });

  it('rejects a calculation citation whose evidence kind or snapshot is wrong', async () => {
    const fixture = loadFixture('a-full-procurement-boundary.json');
    const calculation = calculateSupply(fixture.request);
    const payload = buildCalculationEvidence(calculation);
    const wrongKindId = await persistCalculationEvidence({
      sandboxId: SANDBOX_ID,
      payload,
      kind: 'enterprise_snapshot',
    });
    const storedWrong = await getEvidenceRow(apiDb, SANDBOX_ID, wrongKindId);
    const wrongKind = verifySupplyRecommendation({
      recommendation: recommendationFor(calculation, wrongKindId),
      calculation,
      evidence: new Map([
        [
          wrongKindId,
          {
            id: wrongKindId,
            kind: storedWrong!.kind,
            contentHash: storedWrong!.contentHash,
            capturedFacts: storedWrong!.capturedFacts,
          },
        ],
      ]),
    });
    expect(wrongKind.findings.map((finding) => finding.code)).toContain(
      'WRONG_EVIDENCE_KIND',
    );

    const staleRequest: SupplyCalculationRequest = structuredClone(
      fixture.request,
    );
    staleRequest.priorAdditionalCommittedMinor = '99999';
    const staleCalculation = calculateSupply(staleRequest);
    const stale = verifySupplyRecommendation({
      recommendation: recommendationFor(calculation, wrongKindId),
      calculation: staleCalculation,
      evidence: new Map([
        [
          wrongKindId,
          {
            id: wrongKindId,
            kind: 'calculation',
            contentHash: payload.contentHash,
            capturedFacts: payload.capturedFacts,
          },
        ],
      ]),
    });
    expect(stale.findings.map((finding) => finding.code)).toContain(
      'STALE_CALCULATION_EVIDENCE',
    );
  });

  it('scopes calculation evidence to its sandbox and rejects an infeasible option selection', async () => {
    const fixture = loadFixture('a-no-feasible.json');
    const calculation = calculateSupply(fixture.request);
    const payload = buildCalculationEvidence(calculation);
    const evidenceId = await persistCalculationEvidence({
      sandboxId: SANDBOX_ID,
      payload,
    });
    expect(await getEvidenceRow(apiDb, OTHER_SANDBOX_ID, evidenceId)).toBeNull();
    const stored = await getEvidenceRow(apiDb, SANDBOX_ID, evidenceId);
    const verification = verifySupplyRecommendation({
      recommendation: {
        optionIds: ['00000000000000000000'],
        claims: [],
        evidenceIds: [evidenceId],
      },
      calculation,
      evidence: new Map([
        [
          evidenceId,
          {
            id: evidenceId,
            kind: stored!.kind,
            contentHash: stored!.contentHash,
            capturedFacts: stored!.capturedFacts,
          },
        ],
      ]),
    });
    expect(verification.ok).toBe(false);
    expect(verification.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['UNKNOWN_OPTION', 'INFEASIBLE_OPTION_SELECTED']),
    );
  });
});

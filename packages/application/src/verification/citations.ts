import type { EvidenceKind, SupplyCalculationResult } from '@nexus/contracts';
import { canonicalJsonSha256 } from '@nexus/domain/canonical-json';

export interface CitedEvidenceRecord {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly contentHash: string;
  readonly capturedFacts: unknown;
}

export interface CitationFinding {
  readonly code:
    | 'MISSING_CITATION_EVIDENCE'
    | 'WRONG_EVIDENCE_KIND'
    | 'STALE_CALCULATION_EVIDENCE';
  readonly claimId: string | null;
  readonly message: string;
}

export interface CalculationEvidencePayload {
  readonly kind: 'calculation';
  readonly sourceStatus: 'available';
  readonly contentHash: string;
  readonly locator: null;
  readonly capturedFacts: {
    readonly ruleVersion: string;
    readonly inputHash: string;
    readonly resultHash: string;
    readonly result: SupplyCalculationResult;
  };
}

export function buildCalculationEvidence(
  result: SupplyCalculationResult,
): CalculationEvidencePayload {
  const capturedFacts = {
    ruleVersion: result.ruleVersion,
    inputHash: result.inputHash,
    resultHash: result.resultHash,
    result,
  };
  return {
    kind: 'calculation',
    sourceStatus: 'available',
    contentHash: canonicalJsonSha256(capturedFacts),
    locator: null,
    capturedFacts,
  };
}

export function isMatchingCalculationEvidence(
  evidence: CitedEvidenceRecord,
  calculation: SupplyCalculationResult,
): boolean {
  if (evidence.kind !== 'calculation') {
    return false;
  }
  const facts = evidence.capturedFacts;
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    return false;
  }
  const record = facts as { inputHash?: unknown; resultHash?: unknown };
  return (
    record.inputHash === calculation.inputHash &&
    record.resultHash === calculation.resultHash
  );
}

export function validateCitations(input: {
  readonly claims: ReadonlyArray<{
    readonly claimId: string;
    readonly evidenceIds: readonly string[];
  }>;
  readonly evidence: ReadonlyMap<string, CitedEvidenceRecord>;
}): CitationFinding[] {
  const findings: CitationFinding[] = [];
  for (const claim of input.claims) {
    for (const evidenceId of claim.evidenceIds) {
      if (!input.evidence.has(evidenceId)) {
        findings.push({
          code: 'MISSING_CITATION_EVIDENCE',
          claimId: claim.claimId,
          message: `Claim cites evidence ${evidenceId} that does not exist`,
        });
      }
    }
  }
  return findings;
}

export function requireCalculationCitation(input: {
  readonly claimId: string;
  readonly evidenceIds: readonly string[];
  readonly evidence: ReadonlyMap<string, CitedEvidenceRecord>;
  readonly calculation: SupplyCalculationResult;
}): CitationFinding[] {
  const findings: CitationFinding[] = [];
  const cited = input.evidenceIds
    .map((id) => input.evidence.get(id))
    .filter((entry): entry is CitedEvidenceRecord => entry !== undefined);
  if (cited.length !== input.evidenceIds.length) {
    findings.push({
      code: 'MISSING_CITATION_EVIDENCE',
      claimId: input.claimId,
      message: 'A material claim cites evidence that does not exist',
    });
    return findings;
  }
  if (cited.every((entry) => entry.kind !== 'calculation')) {
    findings.push({
      code: 'WRONG_EVIDENCE_KIND',
      claimId: input.claimId,
      message: 'A calculated claim must cite calculation evidence',
    });
    return findings;
  }
  if (
    !cited.some((entry) =>
      isMatchingCalculationEvidence(entry, input.calculation),
    )
  ) {
    findings.push({
      code: 'STALE_CALCULATION_EVIDENCE',
      claimId: input.claimId,
      message:
        'The cited calculation evidence does not match the current input/result hash',
    });
  }
  return findings;
}

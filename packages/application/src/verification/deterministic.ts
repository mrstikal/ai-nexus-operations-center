import {
  SupplyRecommendationInputSchema,
  type SupplyCalculationResult,
  type SupplyProcurementOption,
  type SupplyRecommendationClaim,
  type SupplyRecommendationInput,
} from '@nexus/contracts';
import { financeApprovalRequired } from '@nexus/domain/supply/impact';
import { addMinor, formatMinor, parseMinor } from '@nexus/domain/money';
import {
  requireCalculationCitation,
  validateCitations,
  type CitedEvidenceRecord,
  type CitationFinding,
} from './citations.js';

export interface MaterialVerificationFinding {
  readonly code:
    | 'INVALID_RECOMMENDATION'
    | 'UNKNOWN_OPTION'
    | 'INFEASIBLE_OPTION_SELECTED'
    | 'INCOMPLETE_OPTION_SELECTION'
    | 'MISSING_CLAIM_TARGET'
    | 'UNSUPPORTED_CLAIM_KIND'
    | 'CLAIM_VALUE_MISMATCH'
    | 'UNKNOWN_SHORTAGE'
    | 'MISSING_OPTION_SELECTION';
  readonly claimId: string | null;
  readonly message: string;
}

export interface SupplyVerificationResult {
  readonly ok: boolean;
  readonly findings: Array<MaterialVerificationFinding | CitationFinding>;
}

function allOptions(
  calculation: SupplyCalculationResult,
): SupplyProcurementOption[] {
  return calculation.optionSets.flatMap((set) => set.options);
}

function findOption(
  calculation: SupplyCalculationResult,
  optionId: string,
): SupplyProcurementOption | null {
  return allOptions(calculation).find((option) => option.optionId === optionId) ?? null;
}

function expectedClaimValue(
  calculation: SupplyCalculationResult,
  claim: SupplyRecommendationClaim,
  selectedFinanceRequired: boolean,
): { readonly value: string } | { readonly finding: MaterialVerificationFinding } {
  switch (claim.kind) {
    case 'option_additional_commitment': {
      if (claim.optionId === null) {
        return {
          finding: {
            code: 'MISSING_CLAIM_TARGET',
            claimId: claim.claimId,
            message: 'An option commitment claim requires an optionId',
          },
        };
      }
      const option = findOption(calculation, claim.optionId);
      return option
        ? { value: option.additionalCommitmentMinor }
        : {
            finding: {
              code: 'UNKNOWN_OPTION',
              claimId: claim.claimId,
              message: `Unknown option ${claim.optionId}`,
            },
          };
    }
    case 'option_arrival': {
      if (claim.optionId === null) {
        return {
          finding: {
            code: 'MISSING_CLAIM_TARGET',
            claimId: claim.claimId,
            message: 'An option arrival claim requires an optionId',
          },
        };
      }
      const option = findOption(calculation, claim.optionId);
      return option
        ? { value: option.latestArrivalAt }
        : {
            finding: {
              code: 'UNKNOWN_OPTION',
              claimId: claim.claimId,
              message: `Unknown option ${claim.optionId}`,
            },
          };
    }
    case 'option_rank': {
      if (claim.optionId === null) {
        return {
          finding: {
            code: 'MISSING_CLAIM_TARGET',
            claimId: claim.claimId,
            message: 'An option rank claim requires an optionId',
          },
        };
      }
      const option = findOption(calculation, claim.optionId);
      return option
        ? { value: String(option.rank) }
        : {
            finding: {
              code: 'UNKNOWN_OPTION',
              claimId: claim.claimId,
              message: `Unknown option ${claim.optionId}`,
            },
          };
    }
    case 'shortage_quantity': {
      if (claim.productId === null || claim.deadline === null) {
        return {
          finding: {
            code: 'MISSING_CLAIM_TARGET',
            claimId: claim.claimId,
            message: 'A shortage claim requires a productId and deadline',
          },
        };
      }
      const shortage = calculation.shortages.find(
        (entry) =>
          entry.productId === claim.productId &&
          entry.deadline === claim.deadline,
      );
      return shortage
        ? { value: String(shortage.quantity) }
        : {
            finding: {
              code: 'UNKNOWN_SHORTAGE',
              claimId: claim.claimId,
              message: 'No shortage matches the claim target',
            },
          };
    }
    case 'wait_feasible':
      return { value: String(calculation.waitingOption.feasible) };
    case 'finance_approval_required':
      return { value: String(selectedFinanceRequired) };
    default:
      return {
        finding: {
          code: 'UNSUPPORTED_CLAIM_KIND',
          claimId: claim.claimId,
          message: 'Unsupported claim kind',
        },
      };
  }
}

export function verifySupplyRecommendation(input: {
  readonly recommendation: SupplyRecommendationInput;
  readonly calculation: SupplyCalculationResult;
  readonly evidence: ReadonlyMap<string, CitedEvidenceRecord>;
}): SupplyVerificationResult {
  const parsed = SupplyRecommendationInputSchema.safeParse(input.recommendation);
  if (!parsed.success) {
    return {
      ok: false,
      findings: [
        {
          code: 'INVALID_RECOMMENDATION',
          claimId: null,
          message: 'Recommendation does not match its closed contract',
        },
      ],
    };
  }
  const recommendation = parsed.data;
  const findings: Array<MaterialVerificationFinding | CitationFinding> = [];
  const options = allOptions(input.calculation);
  const optionIds = new Set(options.map((option) => option.optionId));
  for (const optionId of recommendation.optionIds) {
    if (!optionIds.has(optionId)) {
      findings.push({
        code: 'UNKNOWN_OPTION',
        claimId: null,
        message: `Recommendation references unknown option ${optionId}`,
      });
    }
  }
  const selectedById = new Map<string, SupplyProcurementOption>();
  for (const optionId of recommendation.optionIds) {
    const option = findOption(input.calculation, optionId);
    if (option && !selectedById.has(option.optionId)) {
      selectedById.set(option.optionId, option);
    }
  }
  const selected = [...selectedById.values()];
  const selectedCommitment = selected.reduce(
    (total, option) =>
      addMinor(total, parseMinor(option.additionalCommitmentMinor)),
    0n,
  );
  const selectedFinanceRequired =
    selectedCommitment > 0n &&
    financeApprovalRequired({
      priorAdditionalCommittedMinor:
        input.calculation.impact.priorAdditionalCommittedMinor,
      additionalCommitmentMinor: formatMinor(selectedCommitment),
      financeThresholdMinor:
        input.calculation.impact.financeThresholdMinor,
    }).required;
  const completeSet = input.calculation.optionSets.at(-1) ?? null;
  const requiresOption =
    !input.calculation.noProcurementRequired &&
    !input.calculation.waitingOption.feasible &&
    !input.calculation.infeasible;
  if (requiresOption) {
    if (selected.length === 0) {
      findings.push({
        code: 'MISSING_OPTION_SELECTION',
        claimId: null,
        message: 'A procurement option is required and none was selected',
      });
    } else if (
      completeSet === null ||
      !selected.some((option) =>
        completeSet.options.some(
          (candidate) => candidate.optionId === option.optionId,
        ),
      )
    ) {
      findings.push({
        code: 'INCOMPLETE_OPTION_SELECTION',
        claimId: null,
        message:
          'The selected option does not cover the latest affected deadline',
      });
    }
  }
  if (
    input.calculation.infeasible &&
    recommendation.optionIds.length > 0
  ) {
    findings.push({
      code: 'INFEASIBLE_OPTION_SELECTED',
      claimId: null,
      message: 'An infeasible calculation cannot support a selected option',
    });
  }

  findings.push(
    ...validateCitations({
      claims: recommendation.claims,
      evidence: input.evidence,
    }),
  );
  for (const claim of recommendation.claims) {
    findings.push(
      ...requireCalculationCitation({
        claimId: claim.claimId,
        evidenceIds: claim.evidenceIds,
        evidence: input.evidence,
        calculation: input.calculation,
      }),
    );
    const expected = expectedClaimValue(
      input.calculation,
      claim,
      selectedFinanceRequired,
    );
    if ('finding' in expected) {
      findings.push(expected.finding);
      continue;
    }
    if (expected.value !== claim.value) {
      findings.push({
        code: 'CLAIM_VALUE_MISMATCH',
        claimId: claim.claimId,
        message: `Claim value ${claim.value} does not match the calculated ${expected.value}`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

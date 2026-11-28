import {
  RegisteredToolDefinitionSchema,
  SupplyCalculationRequestSchema,
  SupplyCalculationResultSchema,
  type SupplyCalculationRequest,
  type SupplyCalculationResult,
} from '@nexus/contracts';
import { calculateSupply } from '@nexus/domain/supply/calculate';
import type { ToolDefinition } from './registry.js';

const SUPPLY_ALLOWED_FIELDS = [
  'ruleVersion',
  'asOf',
  'inputHash',
  'resultHash',
  'availableForAllocation',
  'coverageByDeadline',
  'allocations',
  'shortages',
  'optionSets',
  'waitingOption',
  'impact',
  'noProcurementRequired',
  'infeasible',
  'missingFields',
];

/**
 * Server-side deterministic calculation tool. Callers pass a snapshot built
 * from authoritative enterprise reads and validated document fields; the tool
 * never reads the model output as fact and never writes business state.
 */
export function createSupplyCalculationToolDefinition(): ToolDefinition {
  const descriptor = RegisteredToolDefinitionSchema.parse({
    name: 'domain.calculate_supply_options',
    schemaVersion: 1,
    permission: [
      'viewer',
      'operator',
      'approver_ops',
      'approver_finance',
      'admin',
    ],
    toolClass: 'compute',
    supportedScenarios: ['A'],
    maxResults: 100,
    timeoutMs: 5_000,
    retryable: false,
    redaction: {
      mode: 'allowlist',
      allowedFields: SUPPLY_ALLOWED_FIELDS,
    },
    budgetWeight: 0,
    argumentSchemaId: 'domain.calculate_supply_options.arguments.v1',
    resultSchemaId: 'domain.calculate_supply_options.result.v1',
    maxArgumentBytes: 65_536,
    maxResultBytes: 4_194_304,
  });
  return {
    descriptor,
    argumentSchema: SupplyCalculationRequestSchema,
    resultSchema: SupplyCalculationResultSchema,
    countResults: (result) =>
      (result as SupplyCalculationResult).optionSets.reduce(
        (total, set) => total + set.options.length,
        0,
      ),
    execute: async (args) => calculateSupply(args as SupplyCalculationRequest),
  };
}

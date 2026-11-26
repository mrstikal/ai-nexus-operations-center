import {
  EnterpriseAffectedOrdersResponseSchema,
  EnterpriseAlternativesResponseSchema,
  EnterpriseInventoryResponseSchema,
  EnterprisePurchaseOrderResponseSchema,
  GetAffectedOrdersArgsSchema,
  GetInventoryArgsSchema,
  GetPurchaseOrderArgsSchema,
  ListAlternativesArgsSchema,
  type EnterpriseAffectedOrdersResponse,
  type EnterpriseAlternativesResponse,
  type EnterpriseInventoryResponse,
  type EnterprisePurchaseOrderResponse,
  type GetAffectedOrdersArgs,
  type GetInventoryArgs,
  type GetPurchaseOrderArgs,
  type ListAlternativesArgs,
  type ToolName,
} from '@nexus/contracts';
import type {
  EnterpriseReadOptions,
  EnterpriseReadPort,
} from '@nexus/application/ports/enterprise';
import type { ToolCallContext } from '@nexus/application/ports/tools';
import { RegisteredToolDefinitionSchema } from '@nexus/contracts';
import type { ToolDefinition } from './registry.js';

const READ_TIMEOUT_MS = 5_000;
const READ_ARGUMENT_BYTES = 4_096;
const READ_RESULT_BYTES = 524_288;
const READ_ALLOWED_FIELDS = [
  'sandboxId',
  'businessEffectiveAt',
  'purchaseOrderId',
  'productIds',
  'horizonDays',
  'deadline',
  'quantities',
];

type SandboxResult = { readonly sandboxId: string };

function defineTool<TArgs, TResult extends SandboxResult>(definition: {
  readonly name: ToolName;
  readonly argumentSchemaId: string;
  readonly resultSchemaId: string;
  readonly supportedScenarios: readonly string[];
  readonly maxResults: number;
  readonly argumentSchema: ToolDefinition['argumentSchema'];
  readonly resultSchema: ToolDefinition['resultSchema'];
  readonly countResults: (result: TResult) => number;
  readonly execute: (args: TArgs, context: ToolCallContext) => Promise<TResult>;
}): ToolDefinition {
  const descriptor = RegisteredToolDefinitionSchema.parse({
    name: definition.name,
    schemaVersion: 1,
    permission: ['viewer', 'operator', 'approver_ops', 'approver_finance', 'admin'],
    toolClass: 'read',
    supportedScenarios: [...definition.supportedScenarios],
    maxResults: definition.maxResults,
    timeoutMs: READ_TIMEOUT_MS,
    retryable: true,
    redaction: {
      mode: 'allowlist',
      allowedFields: READ_ALLOWED_FIELDS,
    },
    budgetWeight: 1,
    argumentSchemaId: definition.argumentSchemaId,
    resultSchemaId: definition.resultSchemaId,
    maxArgumentBytes: READ_ARGUMENT_BYTES,
    maxResultBytes: READ_RESULT_BYTES,
  });
  return {
    descriptor,
    argumentSchema: definition.argumentSchema,
    resultSchema: definition.resultSchema,
    countResults: (result) => definition.countResults(result as TResult),
    execute: (args, context) =>
      definition.execute(args as TArgs, context),
  };
}

function readOptions(context: ToolCallContext): EnterpriseReadOptions {
  return {
    sandboxId: context.sandboxId,
    correlationId: context.correlationId,
    timeoutMs: context.timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

export function createEnterpriseReadToolDefinitions(
  port: EnterpriseReadPort,
): ToolDefinition[] {
  return [
    defineTool<GetPurchaseOrderArgs, EnterprisePurchaseOrderResponse>({
      name: 'enterprise.get_purchase_order',
      argumentSchemaId: 'enterprise.get_purchase_order.arguments.v1',
      resultSchemaId: 'enterprise.get_purchase_order.result.v1',
      supportedScenarios: ['A', 'B'],
      maxResults: 10,
      argumentSchema: GetPurchaseOrderArgsSchema,
      resultSchema: EnterprisePurchaseOrderResponseSchema,
      countResults: (result) => result.purchaseOrders.length,
      execute: (args, context) =>
        port.getPurchaseOrder(args, readOptions(context)),
    }),
    defineTool<GetInventoryArgs, EnterpriseInventoryResponse>({
      name: 'enterprise.get_inventory',
      argumentSchemaId: 'enterprise.get_inventory.arguments.v1',
      resultSchemaId: 'enterprise.get_inventory.result.v1',
      supportedScenarios: ['A'],
      maxResults: 20,
      argumentSchema: GetInventoryArgsSchema,
      resultSchema: EnterpriseInventoryResponseSchema,
      countResults: (result) => result.items.length,
      execute: (args, context) =>
        port.getInventory(args, readOptions(context)),
    }),
    defineTool<GetAffectedOrdersArgs, EnterpriseAffectedOrdersResponse>({
      name: 'enterprise.get_affected_orders',
      argumentSchemaId: 'enterprise.get_affected_orders.arguments.v1',
      resultSchemaId: 'enterprise.get_affected_orders.result.v1',
      supportedScenarios: ['A'],
      maxResults: 100,
      argumentSchema: GetAffectedOrdersArgsSchema,
      resultSchema: EnterpriseAffectedOrdersResponseSchema,
      countResults: (result) => result.orders.length,
      execute: (args, context) =>
        port.getAffectedOrders(args, readOptions(context)),
    }),
    defineTool<ListAlternativesArgs, EnterpriseAlternativesResponse>({
      name: 'enterprise.list_alternatives',
      argumentSchemaId: 'enterprise.list_alternatives.arguments.v1',
      resultSchemaId: 'enterprise.list_alternatives.result.v1',
      supportedScenarios: ['A'],
      maxResults: 20,
      argumentSchema: ListAlternativesArgsSchema,
      resultSchema: EnterpriseAlternativesResponseSchema,
      countResults: (result) => result.products.length,
      execute: (args, context) =>
        port.listAlternatives(args, readOptions(context)),
    }),
  ];
}

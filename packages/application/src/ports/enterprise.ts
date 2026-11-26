import type {
  EnterpriseAffectedOrdersResponse,
  EnterpriseAlternativesResponse,
  EnterpriseCommandReceipt,
  EnterpriseCommandRequest,
  EnterpriseInventoryResponse,
  EnterprisePurchaseOrderResponse,
  GetAffectedOrdersArgs,
  GetInventoryArgs,
  GetPurchaseOrderArgs,
  ListAlternativesArgs,
} from '@nexus/contracts';

export interface EnterpriseReadOptions {
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EnterpriseReadPort {
  getPurchaseOrder(
    input: GetPurchaseOrderArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterprisePurchaseOrderResponse>;
  getInventory(
    input: GetInventoryArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseInventoryResponse>;
  getAffectedOrders(
    input: GetAffectedOrdersArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseAffectedOrdersResponse>;
  listAlternatives(
    input: ListAlternativesArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseAlternativesResponse>;
}

export interface EnterpriseCommandOptions {
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EnterpriseCommandPort {
  executeCommand(
    input: EnterpriseCommandRequest,
    options: EnterpriseCommandOptions,
  ): Promise<EnterpriseCommandReceipt>;
  getCommandReceipt(
    idempotencyKey: string,
    options: EnterpriseCommandOptions,
  ): Promise<EnterpriseCommandReceipt>;
}

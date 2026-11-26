import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EnterpriseAffectedOrdersResponseSchema,
  EnterpriseAlternativesResponseSchema,
  EnterpriseInventoryResponseSchema,
  EnterprisePurchaseOrderResponseSchema,
  receiptKeyFor,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
  type ToolInvocationContext,
  type ToolName,
} from '@nexus/contracts';
import type {
  EnterpriseReadOptions,
  EnterpriseReadPort,
} from '@nexus/application/ports/enterprise';
import {
  EnterpriseCommandHttpClient,
  EnterpriseReadHttpClient,
} from '@nexus/integrations/enterprise/client';
import { EnterpriseClientError } from '@nexus/integrations/enterprise/errors';
import { createEnterpriseReadToolDefinitions } from '@nexus/integrations/tools/enterprise-reads';
import {
  createToolRegistry,
  ToolRegistryError,
  type ToolDefinition,
} from '@nexus/integrations/tools/registry';

const SANDBOX_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SANDBOX_ID = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '20000000-0000-4000-8000-000000000001';
const PRODUCT_ID_2 = '20000000-0000-4000-8000-000000000002';
const SUPPLIER_ID = '10000000-0000-4000-8000-000000000001';
const PURCHASE_ORDER_ID = '50000000-0000-4000-8000-000000000001';
const AGREEMENT_ID = '40000000-0000-4000-8000-000000000001';
const ACTION_REVISION_ID = '70000000-0000-4000-8000-000000000001';
const ITEM_ID = '80000000-0000-4000-8000-000000000001';
const RECEIPT_ID = '90000000-0000-4000-8000-000000000001';
const COMMUNICATION_ID = '90000000-0000-4000-8000-000000000002';
const READ_TOKEN = 'read-token-0123456789abcdef0123456789abcdef';
const COMMAND_TOKEN = 'command-token-0123456789abcdef0123456789ab';
const ISO_FROM = '2026-11-02T09:00:00.000Z';
const ISO_TO = '2026-11-16T09:00:00.000Z';
const ISO_DEADLINE = '2026-11-10T09:00:00.000Z';
const ALL_TOOL_NAMES: ToolName[] = [
  'enterprise.get_purchase_order',
  'enterprise.get_inventory',
  'enterprise.get_affected_orders',
  'enterprise.list_alternatives',
];

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
}

interface FakeServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  readonly storedReceipts: Map<string, EnterpriseCommandReceipt>;
  close(): Promise<void>;
}

function product(id = PRODUCT_ID, sku = 'NS-MON-27-A1') {
  return {
    id,
    sku,
    name: 'Studio Monitor 27',
    category: 'Monitors',
    status: 'active' as const,
    version: 3,
    createdAt: ISO_FROM,
    updatedAt: ISO_FROM,
  };
}

function supplier() {
  return {
    id: SUPPLIER_ID,
    reference: 'SUP-BALTIC',
    name: 'Baltic Displays',
    status: 'active' as const,
    version: 4,
    createdAt: ISO_FROM,
    updatedAt: ISO_FROM,
  };
}

function purchaseOrderResponse(reference: string, sandboxId = SANDBOX_ID) {
  return {
    sandboxId,
    businessEffectiveAt: ISO_FROM,
    purchaseOrders: [
      {
        id: PURCHASE_ORDER_ID,
        reference,
        supplierReference: 'BC-4417',
        status: 'delayed' as const,
        version: 5,
        orderedAt: ISO_FROM,
        expectedAt: ISO_TO,
        sourcePurchaseOrderId: null,
        sourcePurchaseOrderReference: null,
        expediteChargeMinor: '0',
        paymentTerms: 'Net 30',
        deliveryTerms: 'DAP Rotterdam',
        supplier: supplier(),
        lines: [
          {
            id: '51000000-0000-4000-8000-000000000001',
            lineNumber: 1,
            product: product(),
            agreementId: AGREEMENT_ID,
            agreementReference: 'AGR-2026-0002',
            agreementVersion: 7,
            orderedQuantity: 120,
            receivedQuantity: 0,
            unreceivedQuantity: 120,
            unitPriceMinor: '18500',
            currency: 'EUR' as const,
            confirmedArrivalAt: ISO_TO,
            version: 5,
            createdAt: ISO_FROM,
            updatedAt: ISO_FROM,
          },
        ],
        createdAt: ISO_FROM,
        updatedAt: ISO_FROM,
      },
    ],
  };
}

function inventoryResponse(productIds: string[]) {
  return {
    sandboxId: SANDBOX_ID,
    businessEffectiveAt: ISO_FROM,
    items: productIds.map((id, index) => ({
      product: product(id, `NS-MON-${index + 1}`),
      onHandQuantity: 55,
      activeReservations: 40,
      availableForAllocation: 15,
      reservations: [],
      reservationsTruncated: false,
      confirmedInboundQuantity: 0,
      confirmedInbound: [],
      confirmedInboundTruncated: false,
      version: 6,
      createdAt: ISO_FROM,
      updatedAt: ISO_FROM,
    })),
  };
}

function affectedOrdersResponse(productIds: string[]) {
  return {
    sandboxId: SANDBOX_ID,
    businessEffectiveAt: ISO_FROM,
    requestedProductIds: productIds,
    horizon: { from: ISO_FROM, to: ISO_TO, days: 14 },
    orders: [],
    truncated: false,
  };
}

function alternativesResponse(productIds: string[]) {
  return {
    sandboxId: SANDBOX_ID,
    businessEffectiveAt: ISO_FROM,
    deadline: ISO_DEADLINE,
    products: productIds.map((id) => ({
      product: product(id),
      requestedQuantity: 25,
      offers: [],
      offersTruncated: false,
    })),
  };
}

function commandRequest(): EnterpriseCommandRequest {
  return {
    sandboxId: SANDBOX_ID,
    actionRevisionId: ACTION_REVISION_ID,
    itemId: ITEM_ID,
    planHash: 'a'.repeat(64),
    itemHash: 'b'.repeat(64),
    baseExpectedVersions: [],
    payloadTemplate: {
      kind: 'enterprise.send_message',
      recipient: {
        system: 'enterprise',
        type: 'supplier',
        id: SUPPLIER_ID,
        version: 4,
      },
      subject: 'Delivery update',
      parts: [{ kind: 'text', text: 'Please confirm the revised arrival window.' }],
    },
    priorReceiptKeys: [],
    executeBefore: '2026-11-26T12:00:00.000Z',
    authorizationValidUntil: '2026-11-26T12:10:00.000Z',
  };
}

function receiptFor(request: EnterpriseCommandRequest): EnterpriseCommandReceipt {
  return {
    id: RECEIPT_ID,
    sandboxId: request.sandboxId,
    idempotencyKey: receiptKeyFor(
      request.sandboxId,
      request.actionRevisionId,
      request.itemId,
      request.payloadTemplate.kind,
    ),
    commandKind: request.payloadTemplate.kind,
    actionRevisionId: request.actionRevisionId,
    itemId: request.itemId,
    planHash: request.planHash,
    itemHash: request.itemHash,
    status: 'succeeded',
    executeBefore: request.executeBefore,
    authorizationValidUntil: request.authorizationValidUntil,
    baseExpectedVersions: request.baseExpectedVersions,
    priorReceiptKeys: request.priorReceiptKeys,
    result: {
      entityType: 'communication',
      id: COMMUNICATION_ID,
      version: 1,
    },
    entityChanges: [
      {
        entityType: 'communication',
        id: COMMUNICATION_ID,
        beforeVersion: null,
        afterVersion: 1,
      },
    ],
    createdAt: ISO_FROM,
  };
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload, 'utf8')),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function sendChunkedJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const payload = JSON.stringify(body);
  try {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    for (let offset = 0; offset < payload.length; offset += 128) {
      response.write(payload.slice(offset, offset + 128));
    }
    response.end();
  } catch {
    response.destroy();
  }
}

function sendProblem(
  response: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const payload = JSON.stringify({
    code,
    message,
    requestId: 'f09-fake-simulator',
  });
  response.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload, 'utf8')),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function bearer(request: http.IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^Bearer (\S+)$/.exec(value);
  return match?.[1] ?? null;
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  state: {
    requests: RecordedRequest[];
    storedReceipts: Map<string, EnterpriseCommandReceipt>;
  },
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  state.requests.push({
    method: request.method ?? 'GET',
    url: url.pathname + url.search,
    headers: request.headers,
  });

  const isCommandRoute =
    url.pathname.startsWith('/v1/commands/') ||
    url.pathname.startsWith('/v1/command-receipts/');
  const expectedToken = isCommandRoute ? COMMAND_TOKEN : READ_TOKEN;
  if (bearer(request) !== expectedToken) {
    sendProblem(response, 401, 'UNAUTHENTICATED', 'A valid token is required');
    return;
  }
  if (request.headers['x-nexus-sandbox-id'] !== SANDBOX_ID) {
    sendProblem(response, 400, 'VALIDATION_FAILED', 'Invalid sandbox header');
    return;
  }
  if (typeof request.headers['x-correlation-id'] !== 'string') {
    sendProblem(response, 400, 'VALIDATION_FAILED', 'Missing correlation header');
    return;
  }

  if (url.pathname.startsWith('/v1/purchase-orders/')) {
    const identifier = decodeURIComponent(
      url.pathname.slice('/v1/purchase-orders/'.length),
    );
    if (identifier === 'slow') {
      await delay(300);
      sendJson(response, 200, purchaseOrderResponse('PO-2026-1001'));
      return;
    }
    if (identifier === 'malformed') {
      sendJson(response, 200, { sandboxId: SANDBOX_ID });
      return;
    }
    if (identifier === 'wrong-sandbox') {
      sendJson(response, 200, purchaseOrderResponse('PO-2026-1001', OTHER_SANDBOX_ID));
      return;
    }
    if (identifier === 'outage') {
      sendProblem(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Storage unavailable');
      return;
    }
    if (identifier === 'missing') {
      sendProblem(response, 404, 'NOT_FOUND', 'Purchase order was not found');
      return;
    }
    if (identifier === 'conflict') {
      sendProblem(response, 409, 'CONFLICT', 'Exact read is ambiguous');
      return;
    }
    if (identifier === 'unknown-code') {
      sendProblem(response, 400, 'SOMETHING_NEW', 'Unrecognized problem code');
      return;
    }
    if (identifier === 'spoofed-timeout') {
      sendProblem(response, 400, 'TIMEOUT', 'A problem code cannot select retryability');
      return;
    }
    if (identifier === 'oversized') {
      sendJson(response, 200, {
        ...purchaseOrderResponse('PO-2026-1001'),
        padding: 'x'.repeat(4096),
      });
      return;
    }
    if (identifier === 'chunked-oversized') {
      sendChunkedJson(
        response,
        200,
        purchaseOrderResponse('PO-2026-1001'),
      );
      return;
    }
    sendJson(response, 200, purchaseOrderResponse(identifier));
    return;
  }

  if (url.pathname === '/v1/inventory') {
    const productIds = (url.searchParams.get('productIds') ?? '')
      .split(',')
      .filter(Boolean);
    sendJson(response, 200, inventoryResponse(productIds));
    return;
  }

  if (url.pathname === '/v1/affected-orders') {
    const purchaseOrderId = url.searchParams.get('purchaseOrderId');
    const productIds = purchaseOrderId
      ? [PRODUCT_ID]
      : (url.searchParams.get('productIds') ?? '').split(',').filter(Boolean);
    sendJson(response, 200, affectedOrdersResponse(productIds));
    return;
  }

  if (url.pathname === '/v1/alternatives') {
    const productIds = (url.searchParams.get('productIds') ?? '')
      .split(',')
      .filter(Boolean);
    sendJson(response, 200, alternativesResponse(productIds));
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/v1/commands/')) {
    const kind = decodeURIComponent(url.pathname.slice('/v1/commands/'.length));
    const raw = await readBody(request);
    let parsed: EnterpriseCommandRequest;
    try {
      parsed = JSON.parse(raw) as EnterpriseCommandRequest;
    } catch {
      sendProblem(response, 400, 'VALIDATION_FAILED', 'Invalid JSON body');
      return;
    }
    if (parsed.payloadTemplate.kind !== kind) {
      sendProblem(response, 400, 'VALIDATION_FAILED', 'Command kind mismatch');
      return;
    }
    const receipt = receiptFor(parsed);
    state.storedReceipts.set(receipt.idempotencyKey, receipt);
    sendJson(response, 200, receipt);
    return;
  }

  if (url.pathname.startsWith('/v1/command-receipts/')) {
    const key = decodeURIComponent(
      url.pathname.slice('/v1/command-receipts/'.length),
    );
    const receipt = state.storedReceipts.get(key);
    if (!receipt) {
      sendProblem(response, 404, 'NOT_FOUND', 'Receipt was not found');
      return;
    }
    sendJson(response, 200, receipt);
    return;
  }

  sendProblem(response, 404, 'NOT_FOUND', 'Request route was not found');
}

async function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const storedReceipts = new Map<string, EnterpriseCommandReceipt>();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { requests, storedReceipts }).catch(
      () => {
        sendProblem(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Fake server failure');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    storedReceipts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function invocation(
  overrides: Partial<ToolInvocationContext> = {},
): ToolInvocationContext {
  return {
    requestId: 'f09-request',
    correlationId: 'f09-correlation',
    sandboxId: SANDBOX_ID,
    actor: { kind: 'human', id: 'local-operator', roles: ['operator'] },
    scenario: 'A',
    workflowStep: 'supply.investigate',
    allowedToolNames: ALL_TOOL_NAMES,
    ...overrides,
  };
}

async function expectRegistryError(
  promise: Promise<unknown>,
  code: string,
): Promise<ToolRegistryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRegistryError);
    const registryError = error as ToolRegistryError;
    expect(registryError.code).toBe(code);
    return registryError;
  }
  throw new Error(`Expected tool registry error ${code}`);
}

describe('F09 enterprise client and authorized tool registry', () => {
  let fake: FakeServer;
  let registry: ReturnType<typeof createToolRegistry>;
  let readClient: EnterpriseReadHttpClient;

  beforeAll(async () => {
    fake = await startFakeServer();
    readClient = new EnterpriseReadHttpClient({
      baseUrl: fake.baseUrl,
      token: READ_TOKEN,
      timeoutMs: 2_000,
    });
    registry = createToolRegistry(
      createEnterpriseReadToolDefinitions(readClient),
    );
  });

  afterAll(async () => {
    await fake.close();
  });

  it('exposes only the four accepted read tools without credentials', () => {
    const tools = registry.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.toolClass).toBe('read');
      expect(tool.permission).toContain('viewer');
      expect(tool.permission).toContain('operator');
      expect(tool.retryable).toBe(true);
      expect(tool.schemaVersion).toBe(1);
    }
    const metadata = JSON.stringify(tools);
    expect(metadata).not.toContain(READ_TOKEN);
    expect(metadata).not.toContain(COMMAND_TOKEN);
    expect(metadata).not.toContain('enterprise.create_purchase_order');
    expect(metadata).not.toContain('enterprise.send_message');
    expect(JSON.stringify(readClient)).not.toContain(READ_TOKEN);
  });

  it('executes the purchase order read through the typed port', async () => {
    const outcome = await registry.executeTool(
      'enterprise.get_purchase_order',
      { identifier: 'PO-2026-1001' },
      invocation(),
    );
    const output = outcome.output as {
      sandboxId: string;
      purchaseOrders: { reference: string }[];
    };
    expect(output.sandboxId).toBe(SANDBOX_ID);
    expect(output.purchaseOrders[0]?.reference).toBe('PO-2026-1001');
    expect(outcome.trace.outcome).toBe('succeeded');
    expect(outcome.trace.toolName).toBe('enterprise.get_purchase_order');
    expect(outcome.trace.resultCount).toBe(1);
    const traceText = JSON.stringify(outcome.trace);
    expect(traceText).not.toContain(READ_TOKEN);
    expect(traceText).not.toContain(COMMAND_TOKEN);
    expect(traceText).not.toContain('PO-2026-1001');

    const request = [...fake.requests]
      .reverse()
      .find((entry) => entry.url.startsWith('/v1/purchase-orders/'));
    expect(request?.headers.authorization).toBe(`Bearer ${READ_TOKEN}`);
    expect(request?.headers['x-nexus-sandbox-id']).toBe(SANDBOX_ID);
    expect(request?.headers['x-correlation-id']).toBe('f09-correlation');
  });

  it('executes inventory, affected-order and alternative reads with bounded queries', async () => {
    const inventory = (await registry.executeTool(
      'enterprise.get_inventory',
      { productIds: [PRODUCT_ID, PRODUCT_ID_2] },
      invocation(),
    )) as { output: { items: unknown[] } };
    expect(inventory.output.items).toHaveLength(2);

    const affected = (await registry.executeTool(
      'enterprise.get_affected_orders',
      { productIds: [PRODUCT_ID], horizonDays: 14 },
      invocation(),
    )) as { output: { requestedProductIds: string[] } };
    expect(affected.output.requestedProductIds).toEqual([PRODUCT_ID]);

    const alternatives = (await registry.executeTool(
      'enterprise.list_alternatives',
      {
        productIds: [PRODUCT_ID],
        quantities: [25],
        deadline: ISO_DEADLINE,
      },
      invocation(),
    )) as { output: { products: unknown[] } };
    expect(alternatives.output.products).toHaveLength(1);

    const urls = fake.requests.map((entry) => entry.url);
    expect(urls.some((url) => url.includes('productIds='))).toBe(true);
    expect(urls.some((url) => url.includes('quantities=25'))).toBe(true);
    expect(urls.some((url) => url.includes('deadline='))).toBe(true);
  });

  it('rejects an actor without an accepted role before any HTTP call', async () => {
    const before = fake.requests.length;
    const error = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation({
          actor: { kind: 'human', id: 'nobody', roles: [] },
        }),
      ),
      'TOOL_FORBIDDEN',
    );
    expect(error.trace?.errorCode).toBe('TOOL_FORBIDDEN');
    expect(fake.requests.length).toBe(before);
  });

  it('rejects a tool outside the workflow allowlist', async () => {
    const before = fake.requests.length;
    const error = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_inventory',
        { productIds: [PRODUCT_ID] },
        invocation({ allowedToolNames: ['enterprise.get_purchase_order'] }),
      ),
      'TOOL_NOT_ALLOWED',
    );
    expect(error.causeCode).toBe('ALLOWLIST');
    expect(fake.requests.length).toBe(before);
  });

  it('rejects a tool outside the scenario support', async () => {
    const error = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_inventory',
        { productIds: [PRODUCT_ID] },
        invocation({ scenario: 'B' }),
      ),
      'TOOL_NOT_ALLOWED',
    );
    expect(error.causeCode).toBe('SCENARIO');
  });

  it('rejects unknown tool and hidden write tool names', async () => {
    const before = fake.requests.length;
    await expectRegistryError(
      registry.executeTool('enterprise.create_purchase_order', {}, invocation()),
      'TOOL_NOT_FOUND',
    );
    await expectRegistryError(
      registry.executeTool('enterprise.send_message', {}, invocation()),
      'TOOL_NOT_FOUND',
    );
    await expectRegistryError(
      registry.executeTool('enterprise.run_sql', {}, invocation()),
      'TOOL_NOT_FOUND',
    );
    expect(fake.requests.length).toBe(before);
  });

  it('rejects invalid and oversized arguments', async () => {
    await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'x'.repeat(65) },
        invocation(),
      ),
      'TOOL_INVALID_ARGUMENTS',
    );

    const definitions = createEnterpriseReadToolDefinitions(readClient);
    const purchaseOrderDefinition = definitions[0] as ToolDefinition;
    const sizedRegistry = createToolRegistry([
      {
        ...purchaseOrderDefinition,
        descriptor: {
          ...purchaseOrderDefinition.descriptor,
          maxArgumentBytes: 16,
        },
      },
    ]);
    await expectRegistryError(
      sizedRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation(),
      ),
      'TOOL_ARGUMENTS_TOO_LARGE',
    );
  });

  it('rejects results above the size, schema and item bounds', async () => {
    const definitions = createEnterpriseReadToolDefinitions(readClient);
    const purchaseOrderDefinition = definitions[0] as ToolDefinition;

    const sizeRegistry = createToolRegistry([
      {
        ...purchaseOrderDefinition,
        descriptor: {
          ...purchaseOrderDefinition.descriptor,
          maxResultBytes: 64,
        },
      },
    ]);
    await expectRegistryError(
      sizeRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation(),
      ),
      'TOOL_RESULT_TOO_LARGE',
    );

    const countRegistry = createToolRegistry([
      {
        ...purchaseOrderDefinition,
        descriptor: {
          ...purchaseOrderDefinition.descriptor,
          maxResults: 1,
        },
        execute: async () => {
          const response = purchaseOrderResponse('PO-2026-1001');
          return {
            ...response,
            purchaseOrders: [...response.purchaseOrders, ...response.purchaseOrders],
          };
        },
      },
    ]);
    await expectRegistryError(
      countRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation(),
      ),
      'TOOL_RESULT_LIMIT_EXCEEDED',
    );

    const schemaRegistry = createToolRegistry([
      {
        ...purchaseOrderDefinition,
        execute: async () => ({ sandboxId: SANDBOX_ID, purchaseOrders: [] }),
      },
    ]);
    await expectRegistryError(
      schemaRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation(),
      ),
      'TOOL_RESULT_INVALID',
    );
  });

  it('rejects malformed, oversized and cross-sandbox simulator responses', async () => {
    const malformed = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'malformed' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(malformed.causeCode).toBe('MALFORMED_RESPONSE');
    expect(malformed.retryable).toBe(false);

    const oversizedClient = new EnterpriseReadHttpClient({
      baseUrl: fake.baseUrl,
      token: READ_TOKEN,
      maxResponseBytes: 256,
    });
    const oversizedRegistry = createToolRegistry(
      createEnterpriseReadToolDefinitions(oversizedClient),
    );
    const oversized = await expectRegistryError(
      oversizedRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'oversized' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(oversized.causeCode).toBe('RESPONSE_TOO_LARGE');

    const streaming = await expectRegistryError(
      oversizedRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'chunked-oversized' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(streaming.causeCode).toBe('RESPONSE_TOO_LARGE');

    const wrongSandbox = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'wrong-sandbox' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(wrongSandbox.causeCode).toBe('SANDBOX_MISMATCH');

    const fakePort: EnterpriseReadPort = {
      getPurchaseOrder: async () =>
        purchaseOrderResponse('PO-2026-1001', OTHER_SANDBOX_ID),
      getInventory: async () => inventoryResponse([PRODUCT_ID]),
      getAffectedOrders: async () => affectedOrdersResponse([PRODUCT_ID]),
      listAlternatives: async () => alternativesResponse([PRODUCT_ID]),
    };
    const fakePortRegistry = createToolRegistry(
      createEnterpriseReadToolDefinitions(fakePort),
    );
    const registryMismatch = await expectRegistryError(
      fakePortRegistry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'PO-2026-1001' },
        invocation(),
      ),
      'TOOL_SANDBOX_MISMATCH',
    );
    expect(registryMismatch.retryable).toBe(false);
  });

  it('classifies timeout, dependency and permanent failures for retry', async () => {
    const timeout = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'slow' },
        invocation({ timeoutMsCap: 50 }),
      ),
      'TOOL_RETRYABLE_FAILURE',
    );
    expect(timeout.causeCode).toBe('TIMEOUT');
    expect(timeout.retryable).toBe(true);
    expect(timeout.trace?.retryable).toBe(true);

    const outage = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'outage' },
        invocation(),
      ),
      'TOOL_RETRYABLE_FAILURE',
    );
    expect(outage.causeCode).toBe('DEPENDENCY_UNAVAILABLE');
    expect(outage.retryable).toBe(true);

    const missing = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'missing' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(missing.causeCode).toBe('NOT_FOUND');
    expect(missing.retryable).toBe(false);

    const conflict = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'conflict' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(conflict.causeCode).toBe('CONFLICT');
    expect(conflict.retryable).toBe(false);

    const unknownCode = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'unknown-code' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(unknownCode.causeCode).toBe('SOMETHING_NEW');
    expect(unknownCode.retryable).toBe(false);

    const spoofedCode = await expectRegistryError(
      registry.executeTool(
        'enterprise.get_purchase_order',
        { identifier: 'spoofed-timeout' },
        invocation(),
      ),
      'TOOL_PERMANENT_FAILURE',
    );
    expect(spoofedCode.causeCode).toBe('TIMEOUT');
    expect(spoofedCode.retryable).toBe(false);
  });

  it('uses the same definitions with a replaced read adapter', async () => {
    const calls: string[] = [];
    const fakePort: EnterpriseReadPort = {
      getPurchaseOrder: async (
        input: { identifier: string },
        options: EnterpriseReadOptions,
      ) => {
        calls.push(`purchase:${input.identifier}:${options.sandboxId}`);
        return purchaseOrderResponse(`FAKE-${input.identifier}`);
      },
      getInventory: async (input, options) => {
        calls.push(`inventory:${input.productIds.join(',')}:${options.sandboxId}`);
        return inventoryResponse(input.productIds);
      },
      getAffectedOrders: async (input) => {
        calls.push(`affected:${input.horizonDays}`);
        return affectedOrdersResponse([PRODUCT_ID]);
      },
      listAlternatives: async (input) => {
        calls.push(`alternatives:${input.quantities.join(',')}`);
        return alternativesResponse(input.productIds);
      },
    };
    const replacedRegistry = createToolRegistry(
      createEnterpriseReadToolDefinitions(fakePort),
    );
    const outcome = (await replacedRegistry.executeTool(
      'enterprise.get_purchase_order',
      { identifier: 'PO-LOCAL' },
      invocation(),
    )) as { output: { purchaseOrders: { reference: string }[] } };
    expect(outcome.output.purchaseOrders[0]?.reference).toBe('FAKE-PO-LOCAL');
    expect(calls[0]).toBe(`purchase:PO-LOCAL:${SANDBOX_ID}`);
  });

  it('keeps the executor-only command client outside the AI registry', async () => {
    const commandClient = new EnterpriseCommandHttpClient({
      baseUrl: fake.baseUrl,
      token: COMMAND_TOKEN,
    });
    const request = commandRequest();
    const receipt = await commandClient.executeCommand(request, {
      sandboxId: SANDBOX_ID,
      correlationId: 'f09-command',
    });
    expect(receipt.status).toBe('succeeded');
    expect(receipt.sandboxId).toBe(SANDBOX_ID);

    const replay = await commandClient.getCommandReceipt(
      receipt.idempotencyKey,
      { sandboxId: SANDBOX_ID, correlationId: 'f09-command-replay' },
    );
    expect(replay.id).toBe(RECEIPT_ID);

    const commandRequestRecord = [...fake.requests]
      .reverse()
      .find((entry) => entry.url.startsWith('/v1/commands/'));
    expect(commandRequestRecord?.headers.authorization).toBe(
      `Bearer ${COMMAND_TOKEN}`,
    );

    const registeredNames = registry.listTools().map((tool) => tool.name);
    expect(registeredNames).not.toContain('enterprise.create_purchase_order');
    expect(registeredNames).not.toContain('enterprise.send_message');

    const wrongTokenClient = new EnterpriseCommandHttpClient({
      baseUrl: fake.baseUrl,
      token: READ_TOKEN,
    });
    await expect(
      wrongTokenClient.executeCommand(request, {
        sandboxId: SANDBOX_ID,
        correlationId: 'f09-command-wrong-token',
      }),
    ).rejects.toMatchObject({
      name: 'EnterpriseClientError',
      code: 'UNAUTHENTICATED',
      retryable: false,
    });

    const commandPort = createEnterpriseReadToolDefinitions(readClient);
    expect(commandPort).toHaveLength(4);
  });
});

describe('F09 shared enterprise response contracts', () => {
  it('accepts the shared read responses used by the simulator and client', () => {
    expect(
      EnterprisePurchaseOrderResponseSchema.safeParse(
        purchaseOrderResponse('PO-2026-1001'),
      ).success,
    ).toBe(true);
    expect(
      EnterpriseInventoryResponseSchema.safeParse(
        inventoryResponse([PRODUCT_ID]),
      ).success,
    ).toBe(true);
    expect(
      EnterpriseAffectedOrdersResponseSchema.safeParse(
        affectedOrdersResponse([PRODUCT_ID]),
      ).success,
    ).toBe(true);
    expect(
      EnterpriseAlternativesResponseSchema.safeParse(
        alternativesResponse([PRODUCT_ID]),
      ).success,
    ).toBe(true);
  });

  it('rejects unknown fields and oversized lists in read responses', () => {
    const response = purchaseOrderResponse('PO-2026-1001') as Record<string, unknown>;
    expect(
      EnterprisePurchaseOrderResponseSchema.safeParse({
        ...response,
        extra: true,
      }).success,
    ).toBe(false);
    const inventory = inventoryResponse([PRODUCT_ID]) as {
      items: unknown[];
    };
    expect(
      EnterpriseInventoryResponseSchema.safeParse({
        ...inventoryResponse([PRODUCT_ID]),
        items: Array.from({ length: 21 }, () => inventory.items[0]),
      }).success,
    ).toBe(false);
  });
});

describe('F09 client error classification', () => {
  let fake: FakeServer;

  beforeAll(async () => {
    fake = await startFakeServer();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('exposes the typed error code and no credentials in the message', async () => {
    const client = new EnterpriseReadHttpClient({
      baseUrl: fake.baseUrl,
      token: READ_TOKEN,
    });
    try {
      await client.getPurchaseOrder(
        { identifier: 'outage' },
        { sandboxId: SANDBOX_ID, correlationId: 'f09-client' },
      );
      throw new Error('Expected an enterprise client error');
    } catch (error) {
      expect(error).toBeInstanceOf(EnterpriseClientError);
      const clientError = error as EnterpriseClientError;
      expect(clientError.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(clientError.retryable).toBe(true);
      expect(clientError.requestId).toBe('f09-fake-simulator');
      expect(clientError.message).not.toContain(READ_TOKEN);
    }
  });

  it('rejects a credential-bearing base URL before any request', () => {
    expect(
      () =>
        new EnterpriseReadHttpClient({
          baseUrl: 'http://user:secret@127.0.0.1:3002',
          token: READ_TOKEN,
        }),
    ).toThrow('must not contain credentials');
  });
});

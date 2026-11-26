import {
  EnterpriseAffectedOrdersResponseSchema,
  EnterpriseAlternativesResponseSchema,
  EnterpriseCommandReceiptSchema,
  EnterpriseCommandRequestSchema,
  EnterpriseInventoryResponseSchema,
  EnterprisePurchaseOrderResponseSchema,
  EnterpriseReceiptKeySchema,
  ErrorCodeSchema,
  GetAffectedOrdersArgsSchema,
  GetInventoryArgsSchema,
  GetPurchaseOrderArgsSchema,
  ListAlternativesArgsSchema,
  ProblemSchema,
  TOOL_CORRELATION_PATTERN,
  UuidSchema,
  type EnterpriseAffectedOrdersResponse,
  type EnterpriseAlternativesResponse,
  type EnterpriseCommandReceipt,
  type EnterpriseCommandRequest,
  type EnterpriseInventoryResponse,
  type EnterprisePurchaseOrderResponse,
  type GetAffectedOrdersArgs,
  type GetInventoryArgs,
  type GetPurchaseOrderArgs,
  type ListAlternativesArgs,
} from '@nexus/contracts';
import type {
  EnterpriseCommandOptions,
  EnterpriseCommandPort,
  EnterpriseReadOptions,
  EnterpriseReadPort,
} from '@nexus/application/ports/enterprise';
import type { ZodType } from 'zod';
import { EnterpriseClientError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_REQUEST_BYTES = 262_144;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 4_194_304;
const MAX_REQUEST_BYTES = 1_048_576;
const MINIMUM_TOKEN_LENGTH = 32;
const JSON_CONTENT_TYPE = /^(?:application\/json|application\/problem\+json)(?:;\s*[^;]+)*$/i;

interface ClientConfig {
  readonly baseUrl: URL;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRequestBytes: number;
  readonly fetchImpl: typeof fetch;
}

export interface EnterpriseClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  readonly fetch?: typeof fetch;
}

interface RequestInput {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: string;
  readonly body?: unknown;
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function validateBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enterprise simulator base URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Enterprise simulator base URL must use HTTP or HTTPS');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Enterprise simulator base URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Enterprise simulator base URL must not contain query or fragment');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('Enterprise simulator base URL must not contain a path');
  }
  return url;
}

function validateToken(token: string, label: string): string {
  if (typeof token !== 'string' || token.length < MINIMUM_TOKEN_LENGTH) {
    throw new Error(
      `${label} must contain at least ${MINIMUM_TOKEN_LENGTH} characters`,
    );
  }
  return token;
}

function createConfig(options: EnterpriseClientOptions, label: string): ClientConfig {
  return {
    baseUrl: validateBaseUrl(options.baseUrl),
    token: validateToken(options.token, label),
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, 'timeoutMs'),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      64,
      MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    maxRequestBytes: boundedInteger(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      64,
      MAX_REQUEST_BYTES,
      'maxRequestBytes',
    ),
    fetchImpl: options.fetch ?? fetch,
  };
}

function assertRequestContext(sandboxId: string, correlationId: string): void {
  if (!UuidSchema.safeParse(sandboxId).success) {
    throw new EnterpriseClientError(
      'VALIDATION_FAILED',
      'Enterprise request sandbox identifier is invalid',
    );
  }
  if (!TOOL_CORRELATION_PATTERN.test(correlationId)) {
    throw new EnterpriseClientError(
      'VALIDATION_FAILED',
      'Enterprise request correlation identifier is invalid',
    );
  }
}

function parseArguments<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new EnterpriseClientError(
      'VALIDATION_FAILED',
      'Enterprise read arguments are invalid',
    );
  }
  return parsed.data;
}

function requestSignal(
  external: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (external === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([external, timeoutSignal]);
}

function retryAfterHeader(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) {
    return null;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(Math.floor(seconds * 1000), 86_400_000);
}

function decodeBody(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EnterpriseClientError(
      'MALFORMED_RESPONSE',
      'Enterprise simulator returned a non-UTF-8 response',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EnterpriseClientError(
      'MALFORMED_RESPONSE',
      'Enterprise simulator returned invalid JSON',
    );
  }
}

function problemError(
  body: unknown,
  status: number,
  headers: Headers,
): EnterpriseClientError {
  const parsed = ProblemSchema.safeParse(body);
  if (!parsed.success) {
    return new EnterpriseClientError(
      'MALFORMED_RESPONSE',
      'Enterprise simulator returned an invalid problem response',
      { status },
    );
  }
  const parsedCode = ErrorCodeSchema.safeParse(parsed.data.code);
  if (!parsedCode.success) {
    return new EnterpriseClientError(
      'UNKNOWN_PROBLEM_CODE',
      'Enterprise simulator returned an unrecognized problem code',
      {
        status,
        requestId: parsed.data.requestId,
        retryAfterMs: parsed.data.retryAfterMs ?? retryAfterHeader(headers),
        problemCode: parsed.data.code,
      },
    );
  }
  const code = parsedCode.data;
  return new EnterpriseClientError(
    code,
    `Enterprise simulator rejected the request with ${code}`,
    {
      status,
      requestId: parsed.data.requestId,
      retryAfterMs: parsed.data.retryAfterMs ?? retryAfterHeader(headers),
    },
  );
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EnterpriseClientError(
          'RESPONSE_TOO_LARGE',
          'Enterprise simulator response exceeds its size bound',
          { status: response.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const concatenated = Buffer.concat(chunks);
  return new Uint8Array(
    concatenated.buffer,
    concatenated.byteOffset,
    concatenated.byteLength,
  );
}

async function executeRequest(
  config: ClientConfig,
  schema: ZodType,
  input: RequestInput,
): Promise<unknown> {
  assertRequestContext(input.sandboxId, input.correlationId);
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    config.timeoutMs,
    1,
    MAX_TIMEOUT_MS,
    'timeoutMs',
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal(input.signal, timeoutSignal);
  const url = new URL(config.baseUrl.href);
  url.pathname = `/v1/${input.path}`;
  url.search = input.query ?? '';

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${config.token}`,
    'x-nexus-sandbox-id': input.sandboxId,
    'x-correlation-id': input.correlationId,
  };

  let body: string | undefined;
  if (input.method === 'POST') {
    body = JSON.stringify(input.body);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > config.maxRequestBytes) {
      throw new EnterpriseClientError(
        'PAYLOAD_TOO_LARGE',
        'Enterprise command request exceeds its size bound',
      );
    }
    headers['content-type'] = 'application/json';
  }

  const requestInit: RequestInit =
    body === undefined
      ? { method: input.method, headers, redirect: 'error', signal }
      : { method: input.method, headers, body, redirect: 'error', signal };

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await config.fetchImpl(url, requestInit);
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > config.maxResponseBytes
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new EnterpriseClientError(
        'RESPONSE_TOO_LARGE',
        'Enterprise simulator response exceeds its size bound',
        { status: response.status },
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!JSON_CONTENT_TYPE.test(contentType.trim())) {
      await response.body?.cancel().catch(() => undefined);
      throw new EnterpriseClientError(
        'MALFORMED_RESPONSE',
        'Enterprise simulator returned an unsupported content type',
        { status: response.status },
      );
    }
    bytes = await readBoundedBody(response, config.maxResponseBytes);
  } catch (error) {
    if (error instanceof EnterpriseClientError) {
      throw error;
    }
    if (timeoutSignal.aborted) {
      throw new EnterpriseClientError(
        'TIMEOUT',
        'Enterprise simulator request timed out',
        { cause: error },
      );
    }
    if (input.signal?.aborted === true) {
      throw new EnterpriseClientError(
        'ABORTED',
        'Enterprise simulator request was cancelled',
        { cause: error },
      );
    }
    throw new EnterpriseClientError(
      'NETWORK',
      'Enterprise simulator is unreachable',
      { cause: error },
    );
  }

  const bodyValue = decodeBody(bytes);
  if (!response.ok) {
    throw problemError(bodyValue, response.status, response.headers);
  }

  const parsed = schema.safeParse(bodyValue);
  if (!parsed.success) {
    throw new EnterpriseClientError(
      'MALFORMED_RESPONSE',
      'Enterprise simulator response failed schema validation',
      { status: response.status },
    );
  }
  return parsed.data;
}

function checkResponseSandbox(
  body: unknown,
  expectedSandboxId: string,
): void {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('sandboxId' in body) ||
    (body as { sandboxId: unknown }).sandboxId !== expectedSandboxId
  ) {
    throw new EnterpriseClientError(
      'SANDBOX_MISMATCH',
      'Enterprise simulator returned a different sandbox',
    );
  }
}

function queryFor(pairs: readonly (readonly [string, string])[]): string {
  const query = new URLSearchParams();
  for (const [key, value] of pairs) {
    query.set(key, value);
  }
  return query.toString();
}

class EnterpriseHttpClientBase {
  readonly #config: ClientConfig;

  constructor(config: ClientConfig) {
    this.#config = config;
  }

  async read(
    path: string,
    query: string | undefined,
    schema: ZodType,
    options: EnterpriseReadOptions,
  ): Promise<unknown> {
    const body = await executeRequest(this.#config, schema, {
      method: 'GET',
      path,
      ...(query === undefined ? {} : { query }),
      sandboxId: options.sandboxId,
      correlationId: options.correlationId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    checkResponseSandbox(body, options.sandboxId);
    return body;
  }

  async command(
    path: string,
    body: unknown,
    schema: ZodType,
    options: EnterpriseCommandOptions,
  ): Promise<unknown> {
    const output = await executeRequest(this.#config, schema, {
      method: 'POST',
      path,
      body,
      sandboxId: options.sandboxId,
      correlationId: options.correlationId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    checkResponseSandbox(output, options.sandboxId);
    return output;
  }

  async receipt(
    path: string,
    schema: ZodType,
    options: EnterpriseCommandOptions,
  ): Promise<unknown> {
    const output = await executeRequest(this.#config, schema, {
      method: 'GET',
      path,
      sandboxId: options.sandboxId,
      correlationId: options.correlationId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    checkResponseSandbox(output, options.sandboxId);
    return output;
  }
}

export class EnterpriseReadHttpClient
  extends EnterpriseHttpClientBase
  implements EnterpriseReadPort
{
  constructor(options: EnterpriseClientOptions) {
    super(createConfig(options, 'Enterprise read token'));
  }

  async getPurchaseOrder(
    input: GetPurchaseOrderArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterprisePurchaseOrderResponse> {
    const args = parseArguments(GetPurchaseOrderArgsSchema, input);
    return (await this.read(
      `purchase-orders/${encodeURIComponent(args.identifier)}`,
      undefined,
      EnterprisePurchaseOrderResponseSchema,
      options,
    )) as EnterprisePurchaseOrderResponse;
  }

  async getInventory(
    input: GetInventoryArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseInventoryResponse> {
    const args = parseArguments(GetInventoryArgsSchema, input);
    return (await this.read(
      'inventory',
      queryFor([['productIds', args.productIds.join(',')]]),
      EnterpriseInventoryResponseSchema,
      options,
    )) as EnterpriseInventoryResponse;
  }

  async getAffectedOrders(
    input: GetAffectedOrdersArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseAffectedOrdersResponse> {
    const args = parseArguments(GetAffectedOrdersArgsSchema, input);
    const pairs: [string, string][] = [];
    if (args.purchaseOrderId !== undefined) {
      pairs.push(['purchaseOrderId', args.purchaseOrderId]);
    }
    if (args.productIds !== undefined) {
      pairs.push(['productIds', args.productIds.join(',')]);
    }
    pairs.push(['horizonDays', String(args.horizonDays)]);
    return (await this.read(
      'affected-orders',
      queryFor(pairs),
      EnterpriseAffectedOrdersResponseSchema,
      options,
    )) as EnterpriseAffectedOrdersResponse;
  }

  async listAlternatives(
    input: ListAlternativesArgs,
    options: EnterpriseReadOptions,
  ): Promise<EnterpriseAlternativesResponse> {
    const args = parseArguments(ListAlternativesArgsSchema, input);
    return (await this.read(
      'alternatives',
      queryFor([
        ['productIds', args.productIds.join(',')],
        ['quantities', args.quantities.join(',')],
        ['deadline', args.deadline],
      ]),
      EnterpriseAlternativesResponseSchema,
      options,
    )) as EnterpriseAlternativesResponse;
  }
}

export class EnterpriseCommandHttpClient implements EnterpriseCommandPort {
  readonly #client: EnterpriseHttpClientBase;

  constructor(options: EnterpriseClientOptions) {
    this.#client = new EnterpriseHttpClientBase(
      createConfig(options, 'Enterprise command token'),
    );
  }

  async executeCommand(
    input: EnterpriseCommandRequest,
    options: EnterpriseCommandOptions,
  ): Promise<EnterpriseCommandReceipt> {
    const parsed = EnterpriseCommandRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new EnterpriseClientError(
        'VALIDATION_FAILED',
        'Enterprise command request is invalid',
      );
    }
    if (parsed.data.sandboxId !== options.sandboxId) {
      throw new EnterpriseClientError(
        'VALIDATION_FAILED',
        'Enterprise command sandbox does not match the request context',
      );
    }
    return (await this.#client.command(
      `commands/${encodeURIComponent(parsed.data.payloadTemplate.kind)}`,
      parsed.data,
      EnterpriseCommandReceiptSchema,
      options,
    )) as EnterpriseCommandReceipt;
  }

  async getCommandReceipt(
    idempotencyKey: string,
    options: EnterpriseCommandOptions,
  ): Promise<EnterpriseCommandReceipt> {
    const parsed = EnterpriseReceiptKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new EnterpriseClientError(
        'VALIDATION_FAILED',
        'Enterprise receipt key is invalid',
      );
    }
    return (await this.#client.receipt(
      `command-receipts/${encodeURIComponent(parsed.data)}`,
      EnterpriseCommandReceiptSchema,
      options,
    )) as EnterpriseCommandReceipt;
  }
}

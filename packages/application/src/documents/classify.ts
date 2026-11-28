import {
  type DocumentClassificationV1,
  type DocumentKind,
  type GatewayRequest,
  type ModelGateway,
  type ModelMessage,
} from '@nexus/contracts';
import { DocumentClassificationV1Schema, parseAiOutput } from '@nexus/contracts/ai-outputs';

export const MAX_EXTRACTION_INPUT_CHARS = 16_000;

export interface ExtractionPageText {
  readonly page: number;
  readonly text: string;
}

export class DocumentExtractionGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentExtractionGatewayError';
  }
}

export function extractionSourceText(pages: readonly ExtractionPageText[]): string {
  const joined = pages
    .map((page) => `--- page ${page.page} ---\n${page.text}`)
    .join('\n');
  if ([...joined].length > MAX_EXTRACTION_INPUT_CHARS) {
    throw new DocumentExtractionGatewayError(
      'CONTEXT_LENGTH',
      `Document text exceeds the ${MAX_EXTRACTION_INPUT_CHARS} character extraction input bound`,
    );
  }
  return joined;
}

function messagesFor(text: string): ModelMessage[] {
  return [{ role: 'user', content: [{ kind: 'text', text }] }];
}

export function classificationRequest(input: {
  readonly sourceText: string;
  readonly budgetAccountId: string;
  readonly workflowRunId: string | null;
}): GatewayRequest {
  return {
    role: 'classify',
    capabilities: ['structured_json'],
    messages: messagesFor(input.sourceText),
    outputSchemaId: 'document.classification.v1',
    allowedToolNames: [],
    workflowRunId: input.workflowRunId,
    budgetAccountId: input.budgetAccountId,
    maxOutputTokens: 800,
    stream: false,
  };
}

export function extractionRequest(input: {
  readonly kind: DocumentKind;
  readonly sourceText: string;
  readonly budgetAccountId: string;
  readonly workflowRunId: string | null;
}): GatewayRequest {
  return {
    role: 'extract',
    capabilities: ['structured_json'],
    messages: messagesFor(
      `Document kind: ${input.kind}\n${input.sourceText}`,
    ),
    outputSchemaId: 'document.extraction.v1',
    allowedToolNames: [],
    workflowRunId: input.workflowRunId,
    budgetAccountId: input.budgetAccountId,
    maxOutputTokens: 2000,
    stream: false,
  };
}

export async function classifyDocument(
  gateway: ModelGateway,
  request: GatewayRequest,
): Promise<{ kind: DocumentKind; output: DocumentClassificationV1 }> {
  const result = await gateway.invoke(request);
  if (!result.ok) {
    throw new DocumentExtractionGatewayError(
      result.code,
      `Document classification failed: ${result.message}`,
    );
  }
  const output = DocumentClassificationV1Schema.parse(
    parseAiOutput('document.classification.v1', 'classify', result.output),
  );
  return { kind: output.kind, output };
}

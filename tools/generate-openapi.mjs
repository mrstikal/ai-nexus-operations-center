import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

const {
  ActionDraftItemSchema,
  ActionDraftPlanSchema,
  ActionExecutionSchema,
  ActionKindSchema,
  ActionPayloadSchema,
  ActionPlanItemSchema,
  ActionProposalSchema,
  ActionRevisionSchema,
  ActorSchema,
  ApprovalDecisionSchema,
  AuthMeResponseSchema,
  AuthUserSchema,
  CaseDetailSchema,
  CaseListResponseSchema,
  CaseStatusSchema,
  CaseSummarySchema,
  CostSchema,
  CsrfResponseSchema,
  DeferredBindingSchema,
  DocumentStatusSchema,
  DocumentVersionSchema,
  EntityRefSchema,
  ErrorCodeSchema,
  EvidenceKindSchema,
  EvidenceSchema,
  ExtractedFieldSchema,
  FieldSourceSchema,
  GatewayFailureSchema,
  GatewayRequestSchema,
  GatewayResultSchema,
  GatewaySuccessSchema,
  LoginRequestSchema,
  MessagePartSchema,
  ModelCapabilitySchema,
  ModelRoleSchema,
  MoneySchema,
  PostalAddressSchema,
  ProblemSchema,
  RequestContextSchema,
  ReviewerOutputSchema,
  SseEventSchema,
  StructuredClaimSchema,
  ToolDefinitionSchema,
  ToolNameSchema,
  UiDescriptorSchema,
  ValidationIssueSchema,
  WaitReasonSchema,
  WorkflowRunSchema,
  WorkflowStatusSchema,
  WorkflowStepSchema,
} = await import('@nexus/contracts');
const {
  ActionRequestedPayloadSchema,
  BaseEventEnvelopeSchema,
  CaseCompletedPayloadSchema,
  CaseCreatedPayloadSchema,
  CommunicationCreatedPayloadSchema,
  DocumentReadyPayloadSchema,
  EnterpriseChangePayloadSchema,
  KnowledgeChangedPayloadSchema,
  SupplierDelayPayloadSchema,
  WorkflowResumePayloadSchema,
} = await import('@nexus/contracts/events');

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUTPUT_PATH = path.join(ROOT, 'docs/openapi.json');

const COMPONENTS = [
  ['Money', MoneySchema],
  ['Cost', CostSchema],
  ['EntityRef', EntityRefSchema],
  ['Actor', ActorSchema],
  ['RequestContext', RequestContextSchema],
  ['Problem', ProblemSchema],
  ['ErrorCode', ErrorCodeSchema],
  ['ValidationIssue', ValidationIssueSchema],
  ['AuthUser', AuthUserSchema],
  ['AuthMeResponse', AuthMeResponseSchema],
  ['CsrfResponse', CsrfResponseSchema],
  ['LoginRequest', LoginRequestSchema],
  ['CaseStatus', CaseStatusSchema],
  ['CaseSummary', CaseSummarySchema],
  ['CaseDetail', CaseDetailSchema],
  ['CaseListResponse', CaseListResponseSchema],
  ['WorkflowStatus', WorkflowStatusSchema],
  ['WaitReason', WaitReasonSchema],
  ['WorkflowRun', WorkflowRunSchema],
  ['WorkflowStep', WorkflowStepSchema],
  ['DocumentStatus', DocumentStatusSchema],
  ['DocumentVersion', DocumentVersionSchema],
  ['EvidenceKind', EvidenceKindSchema],
  ['FieldSource', FieldSourceSchema],
  ['ExtractedField', ExtractedFieldSchema],
  ['ActionKind', ActionKindSchema],
  ['PostalAddress', PostalAddressSchema],
  ['DeferredBinding', DeferredBindingSchema],
  ['MessagePart', MessagePartSchema],
  ['ActionPayload', ActionPayloadSchema],
  ['ActionDraftItem', ActionDraftItemSchema],
  ['ActionDraftPlan', ActionDraftPlanSchema],
  ['ActionPlanItem', ActionPlanItemSchema],
  ['ActionRevision', ActionRevisionSchema],
  ['ActionProposal', ActionProposalSchema],
  ['ApprovalDecision', ApprovalDecisionSchema],
  ['ActionExecution', ActionExecutionSchema],
  ['ModelRole', ModelRoleSchema],
  ['ModelCapability', ModelCapabilitySchema],
  ['ToolName', ToolNameSchema],
  ['ToolDefinition', ToolDefinitionSchema],
  ['GatewayRequest', GatewayRequestSchema],
  ['GatewayFailure', GatewayFailureSchema],
  ['ReviewerOutput', ReviewerOutputSchema],
  ['UiDescriptor', UiDescriptorSchema],
  ['CaseCreatedPayload', CaseCreatedPayloadSchema],
  ['CaseCompletedPayload', CaseCompletedPayloadSchema],
  ['DocumentReadyPayload', DocumentReadyPayloadSchema],
  ['WorkflowResumePayload', WorkflowResumePayloadSchema],
  ['ActionRequestedPayload', ActionRequestedPayloadSchema],
  ['SupplierDelayPayload', SupplierDelayPayloadSchema],
  ['EnterpriseChangePayload', EnterpriseChangePayloadSchema],
  ['CommunicationCreatedPayload', CommunicationCreatedPayloadSchema],
  ['KnowledgeChangedPayload', KnowledgeChangedPayloadSchema],
];

const RECURSIVE_COMPONENTS = {
  Evidence: EvidenceSchema,
  StructuredClaim: StructuredClaimSchema,
  GatewaySuccess: GatewaySuccessSchema,
  GatewayResult: GatewayResultSchema,
  SseEvent: SseEventSchema,
  EventEnvelope: BaseEventEnvelopeSchema,
};

function rewriteDefs(value, componentName, defNames, prefix) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDefs(item, componentName, defNames, prefix));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
        const original = entry.slice('#/$defs/'.length);
        const normalized = `${componentName}__${original}`;
        if (!defNames.has(normalized)) {
          defNames.add(normalized);
        }
        result[key] = `${prefix}${normalized}`;
        continue;
      }
      result[key] = rewriteDefs(entry, componentName, defNames, prefix);
    }
    return result;
  }
  return value;
}

function addRecursiveComponent(schemas, name, schema) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const defs = jsonSchema.$defs ?? {};
  const defNames = new Set(Object.keys(defs).map((defName) => `${name}__${defName}`));
  const main = { ...jsonSchema };
  delete main.$schema;
  delete main.$defs;
  schemas[name] = rewriteDefs(main, name, defNames, '#/components/schemas/');
  for (const [defName, defSchema] of Object.entries(defs)) {
    const componentName = `${name}__${defName}`;
    schemas[componentName] = rewriteDefs(
      defSchema,
      name,
      defNames,
      '#/components/schemas/',
    );
  }
}

export function generateOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const registered = new Set();
  for (const [name, schema] of COMPONENTS) {
    if (registered.has(name)) {
      throw new Error(`Duplicate OpenAPI component ${name}`);
    }
    registered.add(name);
    if (typeof schema.openapi !== 'function') {
      throw new Error(`Component ${name} is not extended with OpenAPI metadata`);
    }
    registry.register(name, schema);
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'NEXUS API Contracts',
      version: '0.1.0',
      description:
        'F03 contract catalog generated from the shared Zod schemas. No F03 HTTP controller is implemented; ' +
        'these components are declared and frozen for later API route-owning phases.',
    },
    servers: [
      {
        url: '/api/v1',
        description: 'Declared browser API base path; controllers begin in later phases',
      },
    ],
  });

  document.components = document.components ?? {};
  document.components.schemas = document.components.schemas ?? {};
  for (const [name, schema] of Object.entries(RECURSIVE_COMPONENTS)) {
    addRecursiveComponent(document.components.schemas, name, schema);
  }

  document['x-nexus-implementation-status'] = {
    stage: 'F03',
    contracts: 'declared-and-frozen',
    httpControllers: 'not-implemented-in-f03',
    openapiPaths: 'none-declared',
  };

  return document;
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const document = generateOpenApiDocument();
  const text = serialize(document);

  if (check) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error('docs/openapi.json is missing; run pnpm openapi:generate');
      process.exitCode = 1;
      return;
    }
    const current = fs.readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== text) {
      console.error('docs/openapi.json is out of date; run pnpm openapi:generate');
      process.exitCode = 1;
      return;
    }
    console.log('OpenAPI drift check passed.');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, text);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} with ${Object.keys(document.components.schemas).length} components.`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  main();
}

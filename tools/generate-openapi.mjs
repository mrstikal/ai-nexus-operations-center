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
  ActionProposalCreateInputSchema,
  ActionProposalDetailSchema,
  ActionProposalEditInputSchema,
  ActionProposalListResponseSchema,
  ActionProposalSchema,
  ActionRevisionRequestInputSchema,
  ActionRevisionRequestResponseSchema,
  ActionRevisionRequestSchema,
  ActionRevisionSchema,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResultSchema,
  ApprovalPreflightSchema,
  ActorSchema,
  ApprovalDecisionSchema,
  ApprovalQueueItemSchema,
  ApprovalQueueResponseSchema,
  AuthMeResponseSchema,
  AuthUserSchema,
  CaseDetailSchema,
  CaseHistoryResponseSchema,
  CaseIntakeRequestSchema,
  CaseIntakeResponseSchema,
  CaseIntakeSourceSchema,
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
  IdempotencyKeySchema,
  LoginRequestSchema,
  NoActionInputSchema,
  NoActionResponseSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  MessagePartSchema,
  ModelCapabilitySchema,
  ModelRoleSchema,
  MoneySchema,
  PostalAddressSchema,
  PolicyBundleSchema,
  ProblemSchema,
  RunCancelRequestSchema,
  RunControlResponseSchema,
  RunDetailSchema,
  RunEventsPageSchema,
  RunEventSchema,
  RunEventsQuerySchema,
  RunResumeRequestSchema,
  RunStepSummarySchema,
  RequestContextSchema,
  ReviewerOutputSchema,
  RevisionPreconditionSchema,
  SandboxSummarySchema,
  SseEventSchema,
  StructuredClaimSchema,
  ToolDefinitionSchema,
  ToolNameSchema,
  UiDescriptorSchema,
  ValidationIssueSchema,
  UuidSchema,
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
  ['LoginResponse', LoginResponseSchema],
  ['LogoutResponse', LogoutResponseSchema],
  ['CaseStatus', CaseStatusSchema],
  ['CaseSummary', CaseSummarySchema],
  ['CaseDetail', CaseDetailSchema],
  ['CaseListResponse', CaseListResponseSchema],
  ['CaseHistoryResponse', CaseHistoryResponseSchema],
  ['CaseIntakeSource', CaseIntakeSourceSchema],
  ['CaseIntakeRequest', CaseIntakeRequestSchema],
  ['CaseIntakeResponse', CaseIntakeResponseSchema],
  ['IdempotencyKey', IdempotencyKeySchema],
  ['RunResumeRequest', RunResumeRequestSchema],
  ['RunCancelRequest', RunCancelRequestSchema],
  ['RunControlResponse', RunControlResponseSchema],
  ['RunStepSummary', RunStepSummarySchema],
  ['RunDetail', RunDetailSchema],
  ['RunEvent', RunEventSchema],
  ['RunEventsPage', RunEventsPageSchema],
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
  ['ActionProposalCreateInput', ActionProposalCreateInputSchema],
  ['ActionProposalEditInput', ActionProposalEditInputSchema],
  ['ActionProposalDetail', ActionProposalDetailSchema],
  ['ActionProposalListResponse', ActionProposalListResponseSchema],
  ['PolicyBundle', PolicyBundleSchema],
  ['ApprovalDecision', ApprovalDecisionSchema],
  ['ApprovalDecisionRequest', ApprovalDecisionRequestSchema],
  ['ApprovalDecisionResult', ApprovalDecisionResultSchema],
  ['ApprovalQueueItem', ApprovalQueueItemSchema],
  ['ApprovalQueueResponse', ApprovalQueueResponseSchema],
  ['ApprovalPreflight', ApprovalPreflightSchema],
  ['ActionRevisionRequest', ActionRevisionRequestSchema],
  ['ActionRevisionRequestInput', ActionRevisionRequestInputSchema],
  ['ActionRevisionRequestResponse', ActionRevisionRequestResponseSchema],
  ['NoActionInput', NoActionInputSchema],
  ['NoActionResponse', NoActionResponseSchema],
  ['ActionExecution', ActionExecutionSchema],
  ['SandboxSummary', SandboxSummarySchema],
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

function authProblemResponses() {
  return {
    400: { description: 'Invalid request', content: { 'application/problem+json': { schema: ProblemSchema } } },
    401: { description: 'Authentication required', content: { 'application/problem+json': { schema: ProblemSchema } } },
    403: { description: 'Origin, CSRF or role check failed', content: { 'application/problem+json': { schema: ProblemSchema } } },
    429: { description: 'Login rate limit exceeded', content: { 'application/problem+json': { schema: ProblemSchema } } },
    503: { description: 'Identity or admission dependency unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
  };
}

function registerCasePaths(registry) {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/sandbox',
    tags: ['cases'],
    summary: 'Read the server-resolved active sandbox',
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: 'Active sandbox context',
        content: { 'application/json': { schema: SandboxSummarySchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role or scope denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Case storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/cases',
    tags: ['cases'],
    summary: 'List persisted cases in the active sandbox',
    security: [{ sessionCookie: [] }],
    request: {
      query: z.object({
        status: CaseStatusSchema.optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Stable paginated case list',
        content: { 'application/json': { schema: CaseListResponseSchema } },
      },
      400: {
        description: 'Invalid filter or cursor',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Case storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/cases',
    tags: ['cases'],
    summary: 'Accept a case intake event into the durable queue',
    security: [{ sessionCookie: [] }],
    request: {
      headers: z.object({ 'Idempotency-Key': IdempotencyKeySchema }),
      body: {
        required: true,
        content: { 'application/json': { schema: CaseIntakeRequestSchema } },
      },
    },
    responses: {
      202: {
        description: 'Case and case-created event persisted for queued delivery',
        content: { 'application/json': { schema: CaseIntakeResponseSchema } },
      },
      400: {
        description: 'Invalid body, header or actor role',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Operator role, origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Referenced document does not exist',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'Idempotency key or source identity was reused with a different body',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      413: {
        description: 'Intake body exceeds its bound',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      415: {
        description: 'JSON content type is required',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Case intake storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/runs/{runId}',
    tags: ['runs'],
    summary: 'Read a workflow run and its step summary',
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ runId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'Persisted run detail',
        content: { 'application/json': { schema: RunDetailSchema } },
      },
      400: {
        description: 'Invalid run ID',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Run not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'No active sandbox or stale resource scope',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Run read storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/runs/{runId}/events/page',
    tags: ['runs'],
    summary: 'Read a bounded page of persisted run events',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ runId: z.string().uuid() }),
      query: RunEventsQuerySchema,
    },
    responses: {
      200: {
        description: 'Ordered persisted event page',
        content: { 'application/json': { schema: RunEventsPageSchema } },
      },
      400: {
        description: 'Invalid run ID, cursor or limit',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Run not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'No active sandbox or stale resource scope',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Run read storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/runs/{runId}/events',
    tags: ['runs'],
    summary: 'Stream persisted run events with Last-Event-ID replay',
    description:
      'SSE frames use id/event/data with event=step|status|text_delta|final|error. The 15-second heartbeat is a comment and is not stored. Disconnect does not cancel the run.',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ runId: z.string().uuid() }),
      headers: z.object({ 'Last-Event-ID': z.string().optional() }),
      query: RunEventsQuerySchema,
    },
    responses: {
      200: {
        description: 'Server-sent event stream',
        content: { 'text/event-stream': { schema: z.string() } },
      },
      400: {
        description: 'Invalid run ID, cursor or Last-Event-ID',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Run not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'No active sandbox or stale resource scope',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Run read storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/runs/{runId}/resume',
    tags: ['runs'],
    summary: 'Resume a persisted workflow wait with an explicit cause',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ runId: z.string().uuid() }),
      body: {
        required: true,
        content: { 'application/json': { schema: RunResumeRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Run queued from the matching wait',
        content: { 'application/json': { schema: RunControlResponseSchema } },
      },
      400: {
        description: 'Invalid run ID or resume request',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Operator role, origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Run not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'Terminal, illegal, duplicate or unsupported wake',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Run control storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/runs/{runId}/cancel',
    tags: ['runs'],
    summary: 'Cancel a non-terminal workflow run',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ runId: z.string().uuid() }),
      body: {
        required: true,
        content: { 'application/json': { schema: RunCancelRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Run and case cancelled',
        content: { 'application/json': { schema: RunControlResponseSchema } },
      },
      400: {
        description: 'Invalid run ID or cancel cause',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Operator role, origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Run not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'Terminal or duplicate cancellation',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Run control storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/cases/{caseId}',
    tags: ['cases'],
    summary: 'Read a case in the active sandbox',
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ caseId: z.string() }) },
    responses: {
      200: {
        description: 'Case detail',
        content: { 'application/json': { schema: CaseDetailSchema } },
      },
      400: {
        description: 'Malformed identifier',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Case not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/cases/{caseId}/history',
    tags: ['cases'],
    summary: 'Read redacted append-only history for a case',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ caseId: z.string() }),
      query: z.object({
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Paginated redacted history',
        content: { 'application/json': { schema: CaseHistoryResponseSchema } },
      },
      400: {
        description: 'Malformed identifier or cursor',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Case not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/evidence/{evidenceId}',
    tags: ['cases'],
    summary: 'Read immutable evidence in the active sandbox',
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ evidenceId: z.string() }) },
    responses: {
      200: {
        description: 'Evidence snapshot or explicitly missing source',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Evidence' } },
        },
      },
      400: {
        description: 'Malformed identifier',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Evidence not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
}


function registerDecisionPaths(registry) {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/approvals',
    tags: ['approvals'],
    summary: 'List pending revisions the current approver can still decide',
    security: [{ sessionCookie: [] }],
    request: {
      query: z.object({ limit: z.string().optional(), cursor: z.string().optional() }),
    },
    responses: {
      200: {
        description: 'Bounded approval queue with role slot state',
        content: { 'application/json': { schema: ApprovalQueueResponseSchema } },
      },
      400: { description: 'Malformed cursor or limit', content: { 'application/problem+json': { schema: ProblemSchema } } },
      401: { description: 'Session missing or expired', content: { 'application/problem+json': { schema: ProblemSchema } } },
      403: { description: 'No approver role', content: { 'application/problem+json': { schema: ProblemSchema } } },
      503: { description: 'Approval storage unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
    },
  });
  for (const decision of ['approve', 'reject']) {
    registry.registerPath({
      method: 'post',
      path: `/api/v1/proposals/{proposalId}/${decision}`,
      tags: ['approvals'],
      summary: decision === 'approve' ? 'Approve the exact whole-plan revision slot' : 'Reject the exact whole-plan revision',
      security: [{ sessionCookie: [] }],
      request: {
        params: z.object({ proposalId: z.string() }),
        headers: z.object({ 'idempotency-key': UuidSchema }),
        body: { content: { 'application/json': { schema: ApprovalDecisionRequestSchema } } },
      },
      responses: {
        200: {
          description: 'Recorded immutable human decision and current slot state',
          content: { 'application/json': { schema: ApprovalDecisionResultSchema } },
        },
        400: { description: 'Invalid decision request or header', content: { 'application/problem+json': { schema: ProblemSchema } } },
        401: { description: 'Session missing or expired', content: { 'application/problem+json': { schema: ProblemSchema } } },
        403: { description: 'Self-approval or missing eligible role', content: { 'application/problem+json': { schema: ProblemSchema } } },
        404: { description: 'Proposal not found', content: { 'application/problem+json': { schema: ProblemSchema } } },
        409: { description: 'Stale revision, wrong hash, expiry or conflicting decision', content: { 'application/problem+json': { schema: ProblemSchema } } },
        503: { description: 'Approval storage unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
      },
    });
  }
  registry.registerPath({
    method: 'post',
    path: '/api/v1/proposals/{proposalId}/clarification',
    tags: ['approvals'],
    summary: 'Record a clarification request and the exact human-input wait',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ proposalId: z.string() }),
      headers: z.object({ 'idempotency-key': UuidSchema }),
      body: { content: { 'application/json': { schema: ActionRevisionRequestInputSchema } } },
    },
    responses: {
      200: { description: 'Clarification request recorded; revision is unchanged', content: { 'application/json': { schema: ActionRevisionRequestResponseSchema } } },
      400: { description: 'Invalid request or header', content: { 'application/problem+json': { schema: ProblemSchema } } },
      401: { description: 'Session missing or expired', content: { 'application/problem+json': { schema: ProblemSchema } } },
      403: { description: 'Operator role, origin or CSRF check failed', content: { 'application/problem+json': { schema: ProblemSchema } } },
      404: { description: 'Proposal not found', content: { 'application/problem+json': { schema: ProblemSchema } } },
      409: { description: 'Stale revision, wrong hash, expiry or request conflict', content: { 'application/problem+json': { schema: ProblemSchema } } },
      503: { description: 'Proposal control unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/proposals/{proposalId}/reanalyse',
    tags: ['approvals'],
    summary: 'Supersede the unexecuted revision and record a reanalysis wait',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ proposalId: z.string() }),
      headers: z.object({ 'idempotency-key': UuidSchema }),
      body: { content: { 'application/json': { schema: ActionRevisionRequestInputSchema } } },
    },
    responses: {
      200: { description: 'Reanalysis recorded; old revision remains immutable', content: { 'application/json': { schema: ActionRevisionRequestResponseSchema } } },
      400: { description: 'Invalid request or header', content: { 'application/problem+json': { schema: ProblemSchema } } },
      401: { description: 'Session missing or expired', content: { 'application/problem+json': { schema: ProblemSchema } } },
      403: { description: 'Operator role, origin or CSRF check failed', content: { 'application/problem+json': { schema: ProblemSchema } } },
      404: { description: 'Proposal not found', content: { 'application/problem+json': { schema: ProblemSchema } } },
      409: { description: 'Stale revision, wrong hash, expiry or request conflict', content: { 'application/problem+json': { schema: ProblemSchema } } },
      503: { description: 'Proposal control unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/cases/{caseId}/resolve-no-action',
    tags: ['approvals'],
    summary: 'Human-only justified no-action case resolution',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ caseId: z.string() }),
      headers: z.object({ 'idempotency-key': UuidSchema }),
      body: { content: { 'application/json': { schema: NoActionInputSchema } } },
    },
    responses: {
      200: { description: 'Case resolved with recorded human reason', content: { 'application/json': { schema: NoActionResponseSchema } } },
      400: { description: 'Invalid reason or header', content: { 'application/problem+json': { schema: ProblemSchema } } },
      401: { description: 'Session missing or expired', content: { 'application/problem+json': { schema: ProblemSchema } } },
      403: { description: 'Operator role, origin or CSRF check failed', content: { 'application/problem+json': { schema: ProblemSchema } } },
      404: { description: 'Case not found', content: { 'application/problem+json': { schema: ProblemSchema } } },
      409: { description: 'Terminal case or started/unknown/succeeded effect', content: { 'application/problem+json': { schema: ProblemSchema } } },
      503: { description: 'No-action storage unavailable', content: { 'application/problem+json': { schema: ProblemSchema } } },
    },
  });
}

function registerProposalPaths(registry) {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/cases/{caseId}/proposals',
    tags: ['proposals'],
    summary: 'Create a manually submitted action proposal revision for a case',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ caseId: z.string() }),
      headers: z.object({ 'idempotency-key': UuidSchema }),
      body: {
        content: { 'application/json': { schema: ActionProposalCreateInputSchema } },
      },
    },
    responses: {
      201: {
        description: 'Persisted immutable pending revision or idempotent replay',
        content: { 'application/json': { schema: ActionProposalDetailSchema } },
      },
      400: {
        description: 'Invalid proposal draft, header or unsupported action kind',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Operator role, origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Case not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'Idempotency mismatch or an open procurement plan already exists',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Proposal storage or policy bundle unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/cases/{caseId}/proposals',
    tags: ['proposals'],
    summary: 'List current proposal revisions for a case',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ caseId: z.string() }),
      query: z.object({ limit: z.string().optional(), cursor: z.string().optional() }),
    },
    responses: {
      200: {
        description: 'Bounded newest-first proposal details',
        content: { 'application/json': { schema: ActionProposalListResponseSchema } },
      },
      400: {
        description: 'Malformed identifier or limit',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Case not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Proposal storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/proposals/{proposalId}',
    tags: ['proposals'],
    summary: 'Read the current immutable proposal revision',
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ proposalId: z.string() }) },
    responses: {
      200: {
        description: 'Current proposal and revision',
        content: { 'application/json': { schema: ActionProposalDetailSchema } },
      },
      400: {
        description: 'Malformed identifier',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Viewer role denied',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Proposal not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Proposal storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/proposals/{proposalId}',
    tags: ['proposals'],
    summary: 'Supersede the whole pending or approved unexecuted revision',
    security: [{ sessionCookie: [] }],
    request: {
      params: z.object({ proposalId: z.string() }),
      headers: z.object({ 'if-match': RevisionPreconditionSchema }),
      body: {
        content: { 'application/json': { schema: ActionProposalEditInputSchema } },
      },
    },
    responses: {
      200: {
        description: 'New revision with a fully recomputed hash and roles',
        content: { 'application/json': { schema: ActionProposalDetailSchema } },
      },
      400: {
        description: 'Invalid edit or missing If-Match precondition',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Operator role, origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      404: {
        description: 'Proposal not found in the active sandbox',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      409: {
        description: 'Stale revision or open procurement conflict',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Proposal storage or policy bundle unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
}

function registerAuthPaths(registry) {
  registry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'nexus_session',
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/csrf',
    tags: ['auth'],
    summary: 'Obtain a preauth challenge or rotate a session CSRF token',
    request: {
      headers: z.object({
        Origin: z.string().optional(),
        'Sec-Fetch-Site': z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'CSRF token and expiry',
        content: { 'application/json': { schema: CsrfResponseSchema } },
      },
      403: {
        description: 'Session CSRF refresh origin is not allowed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Identity storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['auth'],
    summary: 'Consume a single-use preauth challenge and create an eight-hour session',
    request: {
      headers: z.object({
        Origin: z.string(),
        'X-CSRF-Token': z.string(),
      }),
      body: {
        content: { 'application/json': { schema: LoginRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Authenticated session',
        headers: { 'Set-Cookie': { schema: { type: 'string' } } },
        content: { 'application/json': { schema: LoginResponseSchema } },
      },
      ...authProblemResponses(),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/me',
    tags: ['auth'],
    summary: 'Read the authenticated identity and roles',
    security: [{ sessionCookie: [] }],
    responses: {
      200: {
        description: 'Identity and roles only (no sandbox context)',
        content: { 'application/json': { schema: AuthMeResponseSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Identity storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: ['auth'],
    summary: 'Revoke the current session',
    security: [{ sessionCookie: [] }],
    request: {
      headers: z.object({
        Origin: z.string(),
        'X-CSRF-Token': z.string(),
      }),
    },
    responses: {
      200: {
        description: 'Session revoked',
        headers: { 'Set-Cookie': { schema: { type: 'string' } } },
        content: { 'application/json': { schema: LogoutResponseSchema } },
      },
      401: {
        description: 'Session missing or expired',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      403: {
        description: 'Origin or CSRF check failed',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
      503: {
        description: 'Identity storage unavailable',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  });
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

  registerAuthPaths(registry);
  registerCasePaths(registry);
  registerProposalPaths(registry);
  registerDecisionPaths(registry);
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
    stage: 'F13',
    contracts: 'declared-and-frozen',
    httpControllers: 'auth, case reads, durable case intake, proposal create/edit/read, human decisions/clarification/reanalysis, no-action control, run control and run read/SSE',
    openapiPaths: 'auth, sandbox, case/evidence reads, case intake, proposal create/edit/read, human decision/clarification/reanalysis/no-action control, run control, run detail/event pages and persisted SSE; later controllers are declared in their owner stages',
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

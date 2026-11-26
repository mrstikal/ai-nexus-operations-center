# NEXUS — AI Operations Center

## 1. Assignment

Design a comprehensive, production-inspired implementation plan for an application called **NEXUS — AI Operations Center**.

NEXUS is an enterprise AI application that demonstrates how artificial intelligence can be integrated into real-world business processes, existing enterprise systems, operational decision-making, and human-supervised automation.

The application is intended to become a flagship software engineering portfolio project.

It must demonstrate not only the ability to integrate AI models and APIs, but also the ability to design and implement a reliable, maintainable, secure, observable, and economically viable AI-powered product.

The deliverable of this assignment is a detailed implementation plan, not the application itself.

## 2. Project Objectives

The project must appeal to three different audiences:

### HR and non-technical stakeholders

- Immediately understand the purpose of the application.
- Recognize its potential business value.
- Explore a polished, intuitive, and functional product.
- Understand how AI can reduce repetitive operational work.

### CTOs and technical decision-makers

- Recognize sound architectural decisions.
- Understand how AI is integrated into existing enterprise infrastructure.
- Evaluate security, reliability, scalability, maintainability, and operational costs.
- See how the application handles AI uncertainty and failure.
- Recognize that AI is treated as an engineering component rather than an unrestricted decision-maker.

### Software engineers

- Inspect a well-structured, documented, and tested codebase.
- Understand the separation of responsibilities between application logic and AI components.
- Examine reusable AI infrastructure and integration patterns.
- Reproduce and evaluate the implementation locally.

The project should demonstrate senior-level software engineering and AI application development capabilities.

## 3. Product Concept

NEXUS is an intelligent operations center for a fictional medium-sized commerce and distribution company.

The company operates several interconnected business systems:

- Enterprise Resource Planning (ERP)
- Customer Relationship Management (CRM)
- Warehouse Management System (WMS)
- Supplier management
- Customer support
- Document management
- Internal company policies and procedures

Operational events arrive from various sources, including emails, documents, business system events, and manually submitted requests.

NEXUS processes these events, gathers relevant information, analyzes the situation, identifies potential problems, proposes solutions, and executes authorized actions.

Human operators supervise AI activities and approve sensitive or consequential actions.

The application must be a functional operational platform rather than a chatbot with access to a collection of tools.

## 4. Core Design Principles

### 4.1. AI is a component, not an authority

AI may:

- Classify information.
- Extract data.
- Interpret unstructured content.
- Identify relevant information.
- Generate hypotheses.
- Recommend actions.
- Produce structured execution plans.
- Prepare communications.

Deterministic application components must remain responsible for:

- Authentication and authorization.
- Business rule enforcement.
- Financial calculations.
- Data validation.
- State transitions.
- Transactional operations.
- Approval requirements.
- Action execution.

AI-generated instructions must never bypass these controls.

### 4.2. Evidence-based decisions

Material AI findings and recommendations must be traceable to their supporting evidence.

Evidence may include:

- Source documents.
- Retrieved policy fragments.
- Business records.
- Tool results.
- Historical cases.
- Deterministically calculated values.

The application must distinguish between verified facts, assumptions, AI interpretations, and unresolved uncertainties.

Unsupported conclusions must not be presented as verified facts.

### 4.3. Human supervision

The platform must support different levels of automation:

- Information gathering.
- Recommendations.
- Draft preparation.
- Actions requiring explicit human approval.
- Automatically executable, low-risk actions permitted by predefined policies.

Approval requirements must be enforced by the application, not by the AI model.

### 4.4. Practical technology selection

Every AI technology included in the project must solve an identifiable product or engineering problem.

Do not introduce technologies merely to increase the number of frameworks, protocols, or architectural patterns mentioned in the README.

Where multiple approaches are available, explain the trade-offs and justify the selected approach.

## 5. Business Scenarios

Implement three complete, interconnected business scenarios using shared platform infrastructure.

### Scenario A — Supply Chain Exception Management

A supplier sends an email containing a document announcing a delayed or partially unavailable delivery.

NEXUS should:

1. Ingest the incoming event and attached document.
2. Classify the operational issue.
3. Extract relevant structured information.
4. Identify the corresponding supplier and purchase order.
5. Retrieve inventory information.
6. Identify affected customer orders.
7. Calculate the operational and financial impact.
8. Retrieve relevant company policies.
9. Identify available alternative suppliers or fulfillment options.
10. Compare the available alternatives.
11. Generate an evidence-backed recommendation.
12. Prepare the required business actions and communications.
13. Request human approval where necessary.
14. Execute approved actions.
15. Record the complete operational history.

The scenario must support multiple possible outcomes rather than a single hardcoded resolution.

### Scenario B — Intelligent Document Processing and Reconciliation

The company receives an invoice, delivery note, or another operational document.

NEXUS should:

1. Identify the document type.
2. Extract structured information from digital PDFs, scanned documents, or images.
3. Identify the associated business records.
4. Reconcile the document against purchase orders, deliveries, and existing invoices.
5. Detect missing information, discrepancies, duplicates, and inconsistencies.
6. Retrieve applicable company policies.
7. Distinguish acceptable differences from material discrepancies.
8. Generate a structured reconciliation report.
9. Recommend corrective actions.
10. Prepare supplier communication when appropriate.
11. Route unresolved or sensitive cases for human review.
12. Update the relevant business records after authorization.

Financial calculations, comparisons, and reconciliation rules must be implemented deterministically wherever possible.

The AI layer must not invent missing financial or business data.

### Scenario C — Intelligent Customer Request Resolution

A customer submits a request that requires information from multiple enterprise systems.

Example requests:

- A missing or delayed delivery.
- A damaged product.
- A return or replacement request.
- A billing discrepancy.
- A request to modify an existing order.

NEXUS should:

1. Classify the request and identify the customer.
2. Retrieve relevant order and customer information.
3. Retrieve related previous communications.
4. Investigate relevant operational events.
5. Retrieve applicable policies and contractual conditions.
6. Identify possible resolutions.
7. Evaluate their operational and financial implications.
8. Prepare a personalized customer response.
9. Propose associated business actions.
10. Obtain approval when required.
11. Execute authorized actions.
12. Maintain a complete case history.

The scenario should demonstrate both successful resolution and appropriate escalation when available information is insufficient.

## 6. Shared AI Platform

The three business scenarios must use common, reusable AI infrastructure.

The architecture must avoid implementing three independent AI pipelines that duplicate the same functionality.

### 6.1. Model Gateway and Model Routing

Implement a centralized AI model integration layer.

OpenRouter should be the primary provider wherever technically and economically appropriate.

Specialized external APIs may be used when required capabilities are unavailable through OpenRouter.

The model integration layer should support:

- Configurable model selection.
- Multiple model roles.
- Provider-independent application interfaces.
- Structured outputs.
- Tool calling.
- Multimodal inputs.
- Streaming where appropriate.
- Capability-aware model routing.
- Configurable fallback strategies.
- Timeouts and bounded retries.
- Usage accounting.
- Cost estimation and accounting.
- Per-workflow execution budgets.

Different models should be configurable for tasks such as:

- Classification.
- Structured data extraction.
- Document understanding.
- Embeddings.
- Complex operational analysis.
- Recommendation verification.
- Content generation.

Avoid hardcoding specific commercial model names into business logic.

The implementation plan should define suitable default model configurations while allowing models to be replaced without modifying application code.

### 6.2. Document Intelligence

Implement a reusable document-processing pipeline supporting:

- Digital PDF files.
- Scanned documents.
- Images.
- Plain text.
- Email content and attachments.

The pipeline should include:

- File validation.
- Document classification.
- Text extraction.
- OCR or multimodal processing where appropriate.
- Structured data extraction.
- Schema validation.
- Source references.
- Detection of incomplete or ambiguous information.
- Human correction of extracted data.
- Document versioning and processing status.

Prefer conventional document extraction when it provides sufficient quality. Use multimodal AI where it adds measurable value.

Document processing must treat uploaded content as untrusted data.

### 6.3. Retrieval-Augmented Generation

Implement a knowledge retrieval subsystem for:

- Internal company policies.
- Operational procedures.
- Supplier agreements.
- Product information.
- Customer support guidelines.
- Historical operational cases.

The subsystem should support:

- Document ingestion.
- Chunking and metadata.
- Embeddings.
- Vector search.
- Keyword search.
- Hybrid retrieval.
- Metadata filtering.
- Source attribution.
- Document versioning.
- Retrieval evaluation.

Consider reranking where it provides a demonstrable benefit.

The architecture should distinguish between unstructured knowledge retrieval and authoritative transactional business data.

Do not use vector search as a substitute for relational database queries.

### 6.4. Tool Calling and Enterprise Integration

AI workflows must be able to interact with enterprise systems through clearly defined tools.

Example tools:

- Retrieve purchase order details.
- Retrieve available inventory.
- Retrieve affected customer orders.
- Search alternative suppliers.
- Calculate fulfillment costs.
- Retrieve customer history.
- Create a proposed replacement order.
- Prepare a customer notification.
- Update an operational case.

Tools must have explicit schemas, validation, permission requirements, and well-defined error behavior.

Consider MCP as a standardized integration mechanism between the AI platform and simulated enterprise systems.

Distinguish between:

- Read-only tools.
- Deterministic computational tools.
- Tools that propose actions.
- Tools that perform side effects.

Side-effecting tools must be protected by the application authorization and approval mechanisms.

### 6.5. AI Workflow Orchestration

Design a persistent and observable workflow orchestration layer.

The system must support:

- Multi-step workflows.
- Conditional execution.
- Tool invocation.
- Parallel processing where appropriate.
- Bounded AI reasoning loops.
- Persistent execution state.
- Intermediate results.
- Workflow interruption and resumption.
- Human approval checkpoints.
- Error recovery.
- Workflow cancellation.
- Execution budgets.
- Idempotent processing.

Compare suitable existing orchestration frameworks with a lightweight custom implementation.

Select an approach based on practical project requirements, not framework popularity.

Workflow execution must not depend on the lifetime of a browser session or HTTP request.

### 6.6. Independent Verification

Implement an independent verification mechanism for consequential or uncertain AI-generated recommendations.

Verification should examine:

- Evidence consistency.
- Unsupported claims.
- Missing information.
- Contradictory conclusions.
- Compliance with applicable policies.
- Whether the proposed action addresses the original problem.

Where a proposition can be verified deterministically, use deterministic verification instead of another AI model.

AI reviewers should be used selectively rather than automatically reviewing every AI output.

Verification must have explicit execution limits and must not create uncontrolled recursive agent loops.

The system must support unresolved disagreements and escalation to a human operator.

### 6.7. Operational Memory

Implement persistent operational memory that allows the platform to benefit from previous cases.

The memory subsystem may include:

- Historical case summaries.
- Previously approved resolutions.
- Recurring operational issues.
- Known supplier problems.
- Human feedback.
- Relevant previous decisions.

Memory entries must have identifiable provenance and lifecycle rules.

The system must distinguish historical experience from currently valid business rules.

Previous AI-generated conclusions must not automatically become authoritative knowledge.

Avoid uncontrolled self-modification or automatic modification of company policies.

### 6.8. Conversational Operations Assistant

Provide an integrated conversational assistant that allows operators to explore operational information using natural language.

Example requests:

- Which customer orders are currently affected by supplier delays?
- Why did NEXUS recommend this supplier?
- Show me unresolved invoice discrepancies above €500.
- What evidence supports this recommendation?
- Compare the proposed solution with similar historical cases.
- Prepare a customer notification for this case.

The conversational assistant must use the same tools, knowledge retrieval subsystem, authorization rules, and operational data as the core workflows.

The assistant should not become the primary interface of the entire application.

### 6.9. Dynamic AI-Driven User Interfaces

Evaluate the practical use of AG-UI and A2UI for selected workflows.

Potential use cases include:

- Dynamically generated clarification forms.
- Structured comparison of proposed alternatives.
- Context-specific operational cards.
- Document discrepancy summaries.
- Human approval interfaces.
- Evidence exploration.
- Live workflow progress.

AI-generated UI must use a controlled component catalog.

Arbitrary executable UI code must not be generated or executed by the AI.

Authorization and validation must remain server-side.

Use conventional React components where dynamic UI generation does not provide meaningful value.

### 6.10. Additional AI Capabilities

Evaluate whether any of the following technologies would provide meaningful value:

- Agent-to-Agent communication (A2A).
- Cache-Augmented Generation.
- Semantic caching.
- Advanced model routing.
- Voice interaction.
- Specialized non-LLM models.
- AI-assisted anomaly detection.
- Automated prompt optimization.

Classify each considered technology as:

- Required for the core application.
- Valuable optional enhancement.
- Suitable future extension.
- Not justified for this project.

Do not artificially expand the project scope.

## 7. Simulated Enterprise Environment

The project must be independently runnable without access to real enterprise infrastructure.

Implement a realistic but intentionally limited simulated enterprise environment.

It should contain:

- Customers.
- Products.
- Suppliers.
- Customer orders.
- Purchase orders.
- Inventory records.
- Deliveries.
- Invoices.
- Customer communications.
- Company policies.
- Historical operational cases.

The simulated systems must expose realistic integration interfaces and business constraints.

They should support actual persistent changes, not simply return static mock responses.

For example, an approved replacement order should create a corresponding business record and affect subsequent operations.

Provide a coherent fictional company dataset.

Include sample emails, digital documents, scanned documents, and operational events.

The dataset must include:

- Valid and straightforward cases.
- Ambiguous information.
- Missing information.
- Contradictory information.
- Duplicate documents.
- Incorrect financial values.
- Policy violations.
- Unauthorized action attempts.
- Malicious prompt injection examples.

Do not implement a complete ERP, CRM, or warehouse management product.

Implement only the business functionality required to support convincing operational scenarios.

The architecture should allow simulated integrations to be replaced with real external systems in the future.

## 8. Event-Driven Architecture

NEXUS should support operational events originating from:

- Incoming emails.
- Uploaded documents.
- Supplier notifications.
- Inventory changes.
- Order status changes.
- Customer requests.
- Manually triggered scenarios.

Consider an event-driven architecture using RabbitMQ and Redis where appropriate.

Clearly distinguish their responsibilities.

The system should demonstrate:

- Asynchronous event processing.
- Background workers.
- Durable event delivery.
- Retry policies.
- Dead-letter handling.
- Duplicate event detection.
- Idempotent consumers.
- Correlation identifiers.
- Persistent workflow state.
- Recovery after process interruption.

Avoid claiming exactly-once message delivery where the underlying infrastructure cannot guarantee it.

Instead, design for safe and effectively-once business operations through appropriate idempotency and transactional patterns.

Evaluate the transactional outbox pattern where applicable.

## 9. Human-in-the-Loop and Action Execution

Implement a centralized action proposal and approval subsystem.

Each proposed action should include:

- Action type.
- Target business entity.
- Proposed changes.
- Business justification.
- Supporting evidence.
- Expected consequences.
- Estimated financial impact, where applicable.
- Required permissions.
- Approval status.
- Execution status.

Operators should be able to:

- Approve an action.
- Reject an action.
- Modify a proposal.
- Request clarification.
- Request additional analysis.

Material modifications must trigger revalidation and, where necessary, renewed approval.

Before execution, the application must verify that:

- The action remains authorized.
- The underlying business state is still valid.
- Required approvals are present.
- The approved action payload has not been modified.
- The operation has not already been executed.

The action execution subsystem must maintain a complete audit trail.

The application must prevent AI-generated plans from directly modifying protected business records.

## 10. Security and AI Safety

Security must be considered a first-class architectural concern.

Address:

- Authentication.
- Role-based access control.
- Tool-level authorization.
- Secret management.
- API key protection.
- Sensitive data handling.
- Data redaction.
- Input and output validation.
- File upload security.
- Prompt injection.
- Indirect prompt injection through retrieved content.
- Malicious document content.
- Unauthorized tool execution.
- Data exfiltration through AI tools.
- Excessive agent autonomy.
- Unbounded model consumption.
- Dependency and integration failures.

Treat the following as untrusted inputs:

- Emails.
- Documents.
- Retrieved knowledge.
- External tool responses.
- AI-generated outputs.

Instructions embedded in business documents must never override application policies or system instructions.

The implementation plan must explicitly define trust boundaries and explain how they are enforced.

## 11. Observability and Auditability

Implement observability for both conventional application operations and AI-specific operations.

For each AI workflow execution, capture:

- Workflow identifier.
- Correlation identifier.
- Execution status.
- Workflow steps.
- Selected models and providers.
- Prompt template version.
- Tool calls.
- Retrieved sources.
- Structured model outputs.
- Validation results.
- Verification findings.
- Human decisions.
- Retry attempts.
- Fallback events.
- Token usage.
- Latency.
- Estimated or provider-reported costs.
- Execution errors.

Where exact costs are unavailable, clearly distinguish estimates from confirmed provider-reported values.

Provide a visual execution trace accessible through the application.

The execution trace should explain what the system did, which information it used, and which decisions were made.

Do not depend on access to private model chain-of-thought.

Consider OpenTelemetry and Langfuse or equivalent technologies.

Sensitive information must be redacted from logs and traces according to configurable policies.

## 12. AI Evaluation Framework

The project must include a reproducible AI evaluation framework.

This is a core project requirement, not an optional future enhancement.

Prepare a versioned evaluation dataset with known expected results and clearly defined evaluation criteria.

Evaluate at least:

- Classification accuracy.
- Structured extraction accuracy.
- Retrieval relevance.
- Correct tool selection.
- Tool argument correctness.
- Evidence attribution.
- Unsupported claims.
- Business recommendation quality.
- Policy compliance.
- Appropriate abstention and escalation.
- Prompt injection resistance.
- Unauthorized action prevention.
- Workflow completion.
- Model latency.
- Token consumption.
- Operational costs.

Prefer deterministic evaluation wherever reliable expected outcomes can be defined.

Use independent model-based evaluation only for criteria that cannot reasonably be evaluated deterministically.

The framework must distinguish conventional software test failures from AI quality evaluation failures.

Provide:

- Reproducible evaluation runs.
- Configurable model comparisons.
- Quality thresholds.
- Regression detection.
- Cost and latency reports.
- Machine-readable evaluation results.
- Human-readable evaluation summaries.

Consider an administrative evaluation dashboard that allows technical users to compare AI model configurations.

Evaluation runs must have explicit cost limits.

Automated software tests should not require paid live AI API calls by default.

Provide mocked or recorded model responses for deterministic integration tests and a separate opt-in mode for live AI evaluations.

## 13. Reliability and Failure Handling

The implementation must demonstrate controlled behavior under realistic failure conditions.

Include scenarios covering:

- Invalid structured model output.
- AI provider unavailability.
- Model timeout.
- Rate limiting.
- Workflow budget exhaustion.
- Excessive tool invocation.
- Contradictory AI findings.
- Insufficient evidence.
- Unavailable enterprise systems.
- Duplicate operational events.
- Stale business data.
- Worker interruption.
- Failed action execution.
- Partially completed workflows.

The platform should be able to recover, retry, suspend, or escalate workflows as appropriate.

Failures must be visible and understandable to operators.

The application must not silently fabricate successful outcomes.

Where partial execution is possible, define appropriate compensation or reconciliation mechanisms.

## 14. User Interface

The application must have a professional, contemporary enterprise-style user interface.

Visual quality matters, but the project should prioritize usability and engineering quality over decorative complexity.

### 14.1. Operations Dashboard

Display:

- Active operational cases.
- Cases requiring attention.
- Pending approvals.
- Resolved cases.
- Operational alerts.
- AI processing activity.
- Relevant operational metrics.
- AI-generated operational briefings backed by source data.

### 14.2. Case Management

Each operational case should provide:

- Case overview.
- Current status.
- Original event.
- Related documents.
- Affected business entities.
- AI findings.
- Supporting evidence.
- Proposed resolutions.
- Approval requests.
- Communication drafts.
- Operational history.
- Execution trace.

### 14.3. Approval Center

Provide a centralized interface for reviewing, modifying, approving, and rejecting proposed actions.

Clearly communicate the implications of each action before approval.

### 14.4. Document Center

Provide document upload, inspection, extracted data visualization, manual correction, and processing status.

Where practical, allow operators to inspect the source corresponding to extracted values.

### 14.5. Knowledge Center

Provide interfaces for managing company documents, policies, ingestion status, and knowledge retrieval.

### 14.6. AI Operations and Administration

Provide administrative interfaces for:

- Model configuration.
- Workflow configuration within predefined safe boundaries.
- AI usage.
- Cost monitoring.
- Execution traces.
- Failure inspection.
- Evaluation results.
- Model comparisons.

### 14.7. Demo Scenario Launcher

Provide an easily accessible interface for launching predefined demonstration scenarios.

A reviewer must be able to experience the main capabilities of NEXUS without manually preparing documents or business data.

The launcher should include:

- Scenario descriptions.
- Expected business situations.
- Required AI capabilities.
- Normal and exceptional scenarios.
- Estimated AI processing costs where available.
- A safe mechanism for resetting demo data.

## 15. Preferred Technology Stack

Use the following stack as the starting point for architectural planning.

| Layer | Preferred technology |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Styling | Tailwind CSS |
| Backend | NestJS, TypeScript |
| Relational database | PostgreSQL |
| Vector storage | pgvector |
| Caching and temporary state | Redis |
| Message broker | RabbitMQ |
| AI provider | OpenRouter |
| AI orchestration | To be evaluated |
| Enterprise integration | REST APIs and MCP |
| Dynamic AI interfaces | AG-UI and A2UI, where justified |
| Observability | OpenTelemetry and Langfuse, or justified alternatives |
| Unit and integration testing | Vitest or appropriate alternatives |
| End-to-end testing | Playwright |
| Local infrastructure | Docker Compose |

The proposed stack is not an unconditional requirement.

The planning agent may recommend alternatives when they provide clear architectural, operational, or implementation benefits.

Verify current library versions, protocol specifications, compatibility, maintenance status, and licensing before finalizing the plan.

Prefer a modular monolith for the core application unless service separation provides a clear practical benefit.

Background workers, simulated enterprise integrations, and infrastructure components may run as separate processes or containers where justified.

Avoid unnecessary microservices, Kubernetes, and infrastructure complexity.

## 16. Project Distribution and Local Setup

The project will primarily be distributed as a public GitHub repository.

A technically competent reviewer must be able to install and run the application locally.

Provide:

- Docker Compose configuration.
- Environment variable templates.
- Database migrations.
- Seed data.
- Demo documents.
- Sample operational events.
- Automated initialization.
- Health checks.
- Clear installation instructions.
- Troubleshooting documentation.
- A repeatable demo reset mechanism.

Implement a bring-your-own-key configuration for live AI operations.

API keys must remain server-side and must never appear in client bundles, logs, or repository files.

The application should provide two explicitly distinguished execution modes:

### Demo / Replay Mode

Uses recorded or simulated AI responses to demonstrate application behavior without paid API access.

### Live AI Mode

Uses real AI models and executes actual AI workflows.

Replay mode must be clearly labeled. Simulated AI responses must never be presented as live model results.

Both modes should exercise the same application-level workflow, validation, authorization, and action execution logic wherever practical.

## 17. Portfolio Presentation

The repository and application must be designed for efficient evaluation by potential employers and technical reviewers.

Provide three demonstration paths:

### 60-second overview

A concise explanation of the product, its business value, and its principal capabilities.

### 5-minute product demonstration

A guided walkthrough of a complete operational scenario, from incoming event to authorized resolution.

### Technical deep dive

Detailed documentation and application interfaces explaining:

- Architecture.
- AI integration.
- Workflow orchestration.
- Security boundaries.
- Human supervision.
- Failure handling.
- Observability.
- Evaluation methodology.
- Cost optimization.
- Architectural trade-offs.

The README must explain:

- The business problem.
- The solution.
- Why AI is useful.
- Which operations are AI-driven.
- Which operations are deterministic.
- Architectural decisions.
- How to run the application.
- How to reproduce demonstration scenarios.
- How to execute tests and evaluations.
- Known limitations.
- Potential production extensions.

Include architecture diagrams and Architecture Decision Records for material technical decisions.

Avoid unsupported claims of production readiness, accuracy, scalability, or economic savings.

## 18. Scope Management

The project must be sufficiently comprehensive to demonstrate broad AI engineering capabilities while remaining realistically implementable by a single experienced developer assisted by coding agents.

Organize functionality into three categories:

1. **Core:** Required for a complete and convincing product.
2. **Advanced:** Valuable enhancements implemented after the core platform is stable.
3. **Optional:** Features that may be omitted without compromising the core product.

Prioritize complete vertical business workflows over isolated infrastructure demonstrations.

Do not allow advanced AI functionality to delay the delivery of the first fully functional business scenario.

Avoid building generic enterprise infrastructure beyond what the project can reasonably demonstrate.

Explicitly identify features that should not be implemented.

## 19. Implementation Plan Requirements

Produce a comprehensive implementation plan divided into clearly defined, independently verifiable stages.

The plan will be executed incrementally by coding agents, including relatively inexpensive models with limited reasoning capabilities.

Do not assume that implementation agents can infer missing architectural decisions.

Each implementation stage must include:

- Unique stage identifier.
- Objective.
- Dependencies.
- Preconditions.
- Explicit scope.
- Out-of-scope items.
- Expected files, modules, or components.
- Required interfaces and data contracts.
- Detailed implementation instructions.
- Required tests.
- Acceptance criteria.
- Verification commands.
- Expected deliverables.
- Documentation updates.
- Explicit completion conditions.

Stages should be:

- Reasonably balanced in complexity.
- Small enough for reliable implementation within a single agent session.
- Ordered according to their dependencies.
- Independently reviewable.
- Designed to avoid unnecessary reimplementation.

Where a stage is too complex, divide it into smaller stages.

Every stage should conclude with implementation verification, tests, and a clear stopping point before proceeding to the next stage.

Include dedicated integration and architectural verification checkpoints.

The plan must establish stable architectural contracts before implementing components that depend on them.

Use concrete, unambiguous instructions rather than generic recommendations.

## 20. Recommended Planning Deliverables

The planning output should include the following sections or documents:

1. Product specification.
2. Scope and non-goals.
3. Functional requirements.
4. Non-functional requirements.
5. System architecture.
6. Architecture diagrams.
7. Technology selection and justification.
8. Domain model.
9. Database design.
10. API and integration contracts.
11. Event architecture.
12. Workflow specifications and state machines.
13. AI model integration architecture.
14. Knowledge retrieval architecture.
15. Tool contracts and authorization model.
16. Human approval architecture.
17. Security model and threat analysis.
18. Observability architecture.
19. AI evaluation methodology.
20. Testing strategy.
21. Demo dataset specification.
22. User interface specification.
23. Local deployment architecture.
24. Detailed staged implementation plan.
25. Acceptance criteria for the completed project.
26. Risk assessment and mitigation strategies.
27. Future production extensions.
28. Architecture Decision Records.

The planning agent may organize these deliverables into multiple Markdown files if that improves readability, maintainability, and usability for implementation agents.

## 21. Planning Agent Instructions

Before finalizing the implementation plan:

- Analyze the complete product requirements.
- Identify architectural conflicts, ambiguities, and unnecessary complexity.
- Resolve foreseeable integration problems.
- Validate compatibility between selected technologies.
- Define explicit trust and responsibility boundaries.
- Identify where deterministic logic should replace AI.
- Identify where AI creates genuine product value.
- Evaluate the cost implications of the proposed AI architecture.
- Ensure that all three business scenarios reuse shared infrastructure.
- Verify that the project remains practical for local execution.
- Ensure that the implementation stages are suitable for less capable coding agents.
- Identify requirements that are disproportionately expensive or complex.
- Justify major deviations from the proposed architecture.

Do not blindly implement every technology mentioned in this brief.

Where requirements are ambiguous, make a reasonable, documented architectural decision unless the ambiguity materially changes the product.

Prefer the simplest architecture that satisfies the product requirements without sacrificing reliability, maintainability, or demonstrable engineering value.

## 22. Definition of Project Success

The completed project should demonstrate that its author can:

- Design a practical AI-powered enterprise product.
- Integrate multiple AI capabilities into cohesive business workflows.
- Combine probabilistic AI with deterministic application logic.
- Integrate AI with existing business systems.
- Process structured and unstructured information.
- Implement reliable agentic workflows.
- Enforce security and authorization boundaries.
- Manage AI uncertainty and failure.
- Implement meaningful human supervision.
- Measure and improve AI quality.
- Control AI operational costs.
- Build reusable AI infrastructure.
- Deliver a professional full-stack application.
- Document and justify architectural decisions.

The final product should not resemble a collection of disconnected AI demonstrations.

It should resemble a coherent, production-inspired enterprise application in which artificial intelligence creates measurable and understandable operational value.

**The primary success criterion is that a technical decision-maker reviewing this project can realistically imagine adapting its architecture and implementation patterns to an actual enterprise environment.**
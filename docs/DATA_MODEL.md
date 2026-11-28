# NEXUS Data Model

Status: F05 implements the shared case/evidence foundation; F07 implements the enterprise
supply/sales read model and F08 adds command receipts, simulated communications and the
enterprise outbox. Identity tables are in F04; workflow, action, model, document,
knowledge, memory, assistant and evaluation tables belong to their later owning stages and
are not created here.

## Ownership and migration map

| Module | Tables | Owner |
|---|---|---|
| Identity | `users`, `user_roles`, `sessions`, `preauth_challenges`, readonly `approver_role_view` | F04 |
| Case foundation | `sandboxes`, `active_sandbox`, `cases`, `case_entity_links`, `sequence_counters`, `evidence`, `audit_events`, `trace_events` | F05 |
| Enterprise supply/sales | `sandboxes`, `suppliers`, `products`, `customers`, `agreements`, `purchase_orders`, `purchase_order_lines`, `sales_orders`, `sales_order_lines`, `inventory`, `inventory_reservations` | F07 |
| Enterprise commands | `command_receipts`, `command_receipt_base_versions`, `command_receipt_entity_changes`, `communications`, `communication_parts`, `event_outbox` | F08 |
| Events/workflows/actions/documents/knowledge/etc. | their own migrations | later stages |

Migrations are monotonically numbered SQL files under `packages/db/migrations/` and
`packages/enterprise-db/migrations/`, applied with the checksummed ledger runner. Destructive
changes require an explicit migration plan; ORM push is not used.

## Sandbox model

`nexus.sandboxes` is the synthetic company scenario boundary. `nexus.active_sandbox` is a
singleton pointer to the server-selected active sandbox. The initial migration seeds sandbox
`00000000-0000-4000-8000-000000000001` with business effective time
`2026-11-02T09:00:00Z`; this is the ID later simulator seed uses. The initial sandbox is not
a complete scenario seed.

Every case/evidence/audit/trace row has `sandbox_id`. Cross-business references use
composite `(sandbox_id, id)` foreign keys where both rows are local, or validated external
references. A browser-supplied case/evidence ID is never an authorization decision: the API
resolves the active sandbox server-side and returns 404 for foreign-sandbox resources.

The model supports one company with isolated synthetic sandboxes. It is not a multi-tenant
security claim. Users, sessions, migration state and server configuration are global.
Retired sandboxes are read-only; F56 introduces non-destructive sandbox reset by creating a
new sandbox rather than truncating existing data.

## Cases

`nexus.cases` has `id`, `sandbox_id`, title, nullable summary, status, `version`,
`terminal_reason`, `created_at` and `updated_at`. Status values are the frozen case
vocabulary. The unique `(sandbox_id, id)` key supports composite scoped links.

`nexus.case_entity_links` records typed entity references with their observed version and
uses the composite case FK. No JSON blob substitutes for identifiers or versions.

Case list ordering is `(date_trunc('milliseconds', created_at) DESC, id DESC)` with an
opaque cursor over the same pair; truncation keeps the cursor precision aligned with the
JavaScript Date representation, and `id` breaks same-millisecond ties. New inserts do not
duplicate or shift an existing page. Detail reads always include the
active-sandbox predicate. Mutable updates use the expected version in the SQL predicate; a
zero-row update is a stale-state conflict, not a silent overwrite.

## Evidence

`nexus.evidence` is append-only for its content. It stores kind, source status (`available` or
`missing`), source system/type/ID/version/sandbox, a 64-character content hash, optional locator,
captured facts, nullable missing reason and capture time. A missing source must have a null
source reference and a non-null reason; an available source must have a same-sandbox source
reference and no missing reason. The application validates source provenance and locator
bounds before insert. F17 adds nullable `superseded_at`/`superseded_reason` lifecycle markers;
a human correction may set only those two columns through a column-level UPDATE grant, and the
captured source fields, hash, locator and facts remain unchanged. Runtime roles have no other
update/delete grant.

Evidence can support a case but is immutable. Authoritative facts may expire for execution
while the historical snapshot remains valid for audit. Raw uploads and personal address
content are not written to audit rows.

## Audit and trace

`nexus.audit_events` is append-only security/business history. It stores actor, request and
correlation IDs, optional run ID, action, target identity/version, before/after hashes,
outcome, allowlisted details and a per-sandbox sequence. `nexus.sequence_counters` allocates
audit and trace sequences transactionally; concurrent appends receive unique contiguous
numbers.

`nexus.trace_events` is bounded operational diagnostics: level, event, allowlisted data and
a per-sandbox sequence. Trace is not audit evidence, does not replace the workflow journal
and never carries raw prompts, secrets or personal data. Both runtime roles may read/append
their allowed rows; neither may update or delete existing audit/trace rows. See
[SECURITY.md](SECURITY.md) for the difference and retention boundary.

## Indexes and grants

Migrations `0003_cases_evidence_audit_trace.sql` and
`0004_case_model_conventions.sql` add:
- case sandbox/status/created index for filters; the F05 millisecond-truncated list order
  currently sorts at these volumes;
- evidence sandbox/case/capture index;
- audit sandbox/target/sequence index;
- trace sandbox/run/sequence index;
- unique `(sandbox_id, sequence)` on audit and trace;
- id/created-at/version conventions on sandbox, active-sandbox and case-link rows.

`nexus_api` may read sandboxes/active sandbox, select/insert/update cases, insert case links,
read/insert evidence, read/insert audit/trace and update sequence counters. `nexus_worker`
has the same case/evidence/audit/trace append/read grants for its future work. Neither role
may update/delete evidence content, audit or trace; the only evidence exception is the F17
supersession marker columns. Public access is revoked.

## Enterprise supply, sales and commands (F07-F08)

`enterprise.sandboxes` is the simulator-local sandbox boundary. Its accepted initial row uses
the same sandbox ID and business clock (`2026-11-02T09:00:00Z`) as `nexus.sandboxes`; the
simulator never reads the Nexus schema at runtime. Every other enterprise supply/sales row has
`sandbox_id` plus a composite `(sandbox_id, id)` unique key. References between these rows use
composite FKs, so a supplier, product, customer, order or inventory row cannot cross sandboxes.
There is no cross-schema foreign key to Nexus.

The accepted fixture graph under `fixtures/company/` seeds 6 suppliers, 12 products, 12
customers, 24 agreements, 12 purchase orders, 24 sales orders, 12 inventory rows and 12
reservations. It intentionally mixes lifecycle states (delayed/cancelled/received purchase
orders, discontinued products, inactive customers and delivered/cancelled sales orders) and
contains a duplicate supplier-provided purchase-order reference (`BC-4417`) so callers must
handle exact-match candidates rather than choose one silently. Inventory keeps on-hand and
reservation quantities; confirmed inbound quantities and arrival dates stay on unreceived
purchase-order lines. Agreement rows keep supplier price, capacity, lead time, validity and
row version.

Business facts use typed columns: money is `bigint` minor units in EUR, quantities and versions
are integers, statuses are checked text values, and timestamps are `timestamptz`. Checks bound
money at `1000000000000` minor units, line totals at the same amount (migration
`0003_supply_total_bounds.sql`), quantities at `1000000`, lead time at 365 days and versions at
the integer range. No JSON blob substitutes for identifiers, money, status or row versions.
Nested inventory reservation/inbound reads and supplier offers are bounded to 1000 visible rows
per product; aggregates and truncation flags keep the totals honest.

Migration `0004_commands.sql` adds `purchase_orders.source_purchase_order_id` and
`expedite_charge_minor`, `purchase_order_lines.agreement_id`, the immutable command receipt
tables (`command_receipts`, `command_receipt_base_versions`,
`command_receipt_entity_changes`), simulated communication tables (`communications`,
`communication_parts`) and the origin-tagged `event_outbox`. A receipt key is unique per
sandbox and equals `sandbox_id:action_revision_id:item_id:command_kind`. Receipt base versions
and before/after entity changes are typed rows, not JSON. Outbox rows keep the originating
action revision, item, receipt id and receipt key. F08 writes `pending` rows and emits inventory/
communication events. Migration `0005_outbox_lifecycle.sql` admits the plan's five enterprise
event types and publisher statuses; `0006_outbox_scope.sql` admits
`inventory/communication/purchase_order/supplier/invoice` aggregate types and narrows outbox
`UPDATE` to the publisher columns.

`enterprise_app` has `SELECT` on the F07 read tables and scoped command DML: INSERT/UPDATE on
purchase orders, INSERT on purchase-order lines, UPDATE on inventory versions, and
SELECT/INSERT on receipts, base versions, entity changes, communications, communication parts
and the outbox, including column-scoped outbox status/attempt/next-attempt/version `UPDATE` for
the later publisher. It has no DELETE and no write access to suppliers, products, customers or
agreements. `nexus_api` and `nexus_worker` have no access to the enterprise schema. The
migrations revoke public access. Reads and commands are implemented by the private
`apps/enterprise-sim` service, not by the Nexus API or worker. See
[ENTERPRISE_API.md](ENTERPRISE_API.md) for routes, headers, receipts and retry semantics, and
[ADR 005](adr/005-tools-vs-privileged-commands.md) for the tool-versus-command boundary.

## Durable events (F10)

Migration `packages/db/migrations/0005_events.sql` adds four Nexus tables.

- `event_outbox` stores the transactional Nexus outbox. It has the event ID, sandbox, event
  type from the closed Nexus registry, version `1`, `api`/`worker` producer, occurrence time,
  bounded correlation and optional causation IDs, aggregate type/ID/version, typed JSON payload,
  `pending|publishing|published|failed` status, attempt count, next-attempt time, bounded last
  error and row version. `nexus_api` may insert/select; `nexus_worker` may select and update only
  the publisher columns. A unique identity `(sandbox_id,id)` supports ingress references.
- `event_inbox` stores one accepted envelope per `(consumer_name,event_id)`. The validated
  envelope JSON is retained together with sandbox, event type, producer, correlation/causation,
  occurrence time, `pending|scheduled|processed|dead` dispatch state, attempt count and
  next-attempt time. F10 inserts `pending` rows; F11 schedules and transitions them. Only
  `nexus_worker` can access it.
- `dead_letters` stores a queryable poison record keyed by consumer and SHA-256 of the raw body.
  It keeps bounded broker metadata, body size, the raw-body hash, a closed reason code and a
  redacted detail. It does not store the raw body, so poison that accidentally contains a secret
  is not retained. It does not reference a sandbox because a poison event may carry an unknown
  sandbox.
- `ingress_keys` stores the HTTP intake key and normalized source identity. A key is unique per
  sandbox/actor/route, and a source identity is unique per sandbox/route. The row references the
  created case and outbox event, stores the canonical request hash and the original accepted
  response for idempotent replay. Only `nexus_api` can access it.

The enterprise outbox already exists from F08; F10 adds `last_error` in
`packages/enterprise-db/migrations/0007_outbox_errors.sql` and grants that publisher column in
`packages/enterprise-db/migrations/0008_outbox_error_grant.sql`. Its publisher statuses remain
`pending|publishing|published|failed`, and `enterprise_app` retains column-scoped update access
for the publisher. Neither runtime role can read the other schema.

The F10 tables do not create workflow, approval, proposal, run, document, knowledge or action
tables. The inbox is the durable accepted queue, not a substitute for the F11 workflow job
tables. See [EVENTS.md](EVENTS.md) for topology, delivery, retry and DLQ behavior.

## Workflow journal (F11)

Migration `packages/db/migrations/0006_workflows.sql` adds five Nexus tables.

- `workflow_runs` stores the immutable ingress envelope/hash, definition name/version, trigger
  event/inbox IDs, status, wait reason, effective time, policy/model/config/prompt revisions,
  active-time limit/used, deadline, cancellation flag and row version. A unique
  `(sandbox_id, trigger_event_id)` prevents duplicate runs.
- `workflow_steps` stores one row per definition step: key/kind, status, input/output hash,
  redacted output, evidence refs, attempt count/limit, error class and timing. Input identity is a
  canonical hash of definition, ingress and sorted dependency outputs.
- `workflow_step_attempts` is append-only attempt history with hashes, redacted output, evidence
  refs, error class, revisions, fencing token and timing.
- `workflow_attempt_evidence` is the typed join to an existing evidence row in the same sandbox;
  missing, duplicate or cross-sandbox references are journaled as permanent failures rather than
  copied into the journal.
- `workflow_jobs` is the durable queue with state, owner, database-time lease, monotonic fencing
  token, attempt count and availability. A partial unique index allows at most one active job per
  run.

`nexus_worker` can insert the journal and update only mutable lifecycle columns; ingress,
definition identity and attempts are immutable. `nexus_api` has read access for F11B. The pending
inbox row, run, initial job and pending step rows are created in one transaction. F11 does not add
approval/proposal/action/execution/SSE tables; F11A/B and F12/F13 own those.

## Workflow waits and dependency linkage (F11A)

Migration `packages/db/migrations/0007_workflow_waits.sql` adds `resume_cause`, `cancel_cause` and
`partial_effects` to `workflow_runs`, a unique child identity on runs
`(sandbox_id,case_id,trigger_event_id)`, and the `workflow_dependencies` table.

`workflow_dependencies` stores the parent run/case, root case, child case and exact child trigger
event, the child case version at linkage, a `waiting|resolved|escalated|expired|cancelled` state,
a database-time 48-real-hour expiry and resolution time. Composite sandbox foreign keys bind the parent run,
parent/root/child cases and the child run identity; a partial unique index allows one active
(waiting) dependency per parent run. Maximum depth one is enforced by the application before
insert: the parent case cannot itself be a waiting child, the child case cannot already be a
waiting parent, self-links reject, and a per-sandbox advisory transaction lock serializes
dependency creation.

The worker and API may update only dependency state/resolution time. The API receives column-scoped
control updates for run status/resume/cancel/partial effects, job insert/state and waiting-step
status; it does not receive the worker's broader journal update grants. A terminal case transition
writes the case status/audit and one `nexus.case.completed.v1` outbox row in the same transaction.
The dependency coordinator consumes matching case-completed inbox rows and marks them processed;
it never creates a workflow run from a terminal event.

## F05/F07/F08 boundaries

F07/F08 do not implement the application executor, approvals, automatic outbox publishing,
goods receipts, invoices, returns, customer-address commands, chosen alternatives or financial
effects. F08 messages are simulation records, not email. F05 does not create workflow runs,
proposals, approvals, executions, documents, blobs, knowledge, enterprise tables, model calls
or a public event-driven case POST. The initial sandbox is a foundation seed, not a complete
demo scenario.

## Action proposals and policy bundles (F12)

Migration `packages/db/migrations/0008_actions_policies.sql` adds four Nexus tables.

- `policy_bundles` is keyed by the reviewed policy revision. It stores the strict validated
  bundle JSON, the canonical bundle SHA-256, the canonical text path and SHA-256 and an
  `active|superseded` status. Reusing a revision with different content is rejected in the
  application instead of overwriting the row. The API may insert/select; the worker may select.
- `action_proposals` stores the sandbox and case, the current immutable revision, the
  `draft|pending_approval|approved|rejected|superseded|expired|cancelled` lifecycle status, a
  server-derived procurement flag, the creator and a row version. Composite foreign keys bind
  the sandbox/case and the current revision. A partial unique index permits at most one open
  (`draft`/`pending_approval`) procurement proposal per case. F13 adds a generated identity
  `sequence` used as the exact approval-queue pagination key; the API role receives explicit sequence
  USAGE.
- `action_revisions` stores immutable revision content: revision number, lifecycle state, plan
  hash, bounded item JSON, required role JSON, typed bigint aggregate impact in EUR minor units,
  procurement flag, policy revision/content hash, rationale, author actor fields, expiry and
  timestamps. A unique `(proposal_id,revision_number)` and a composite sandbox foreign key
  preserve identity. Only lifecycle `state`/`updated_at` are mutable for supersede or expiry.
- `action_revision_evidence` is a typed join keyed by `(sandbox_id,revision_id,evidence_id)` with
  scoped foreign keys to the immutable revision and evidence rows. It is not a JSON evidence
  list and cannot cross the sandbox.
- `action_proposal_idempotency` keys creation replay by sandbox, actor, route and
  `Idempotency-Key`, stores the canonical request hash and original response, and references the
  created proposal. A reused key with a different body is a conflict.

The partial procurement index includes `approved` because approval precedes execution. The
policy bundle is reviewed configuration paired with compiled rules; no generic policy
scripting, role grant, threshold widening or future-table prior-execution query is introduced.
The worker consumes enterprise change inbox rows and expires affected open proposals in place.
Approval decisions, role slots, executions, enterprise receipts and enterprise effects remain
absent until F13/F13A. See [ACTIONS.md](ACTIONS.md) for the derivation and hash rules.

## Human decisions and control (F13)

Migration `packages/db/migrations/0009_approvals.sql` adds:

- `approval_decisions`: one immutable human approve/reject row bound to proposal, current action
  revision, plan hash, required role set, selected role, actor with roles at decision time, reason,
  revision expiry and lifecycle `active|superseded`. Partial unique indexes prevent two active
  decisions for one role, one actor filling two approval slots, or two active rejections for one
  revision.
- `action_command_idempotency`: UUID key replay scoped by sandbox, actor and route, with canonical
  request hash, resource identity and original response.
- `action_revision_requests`: clarification/reanalysis rows bound to the exact revision and plan
  hash, with bounded reason, actor and optional human-input wait run. One recorded request of each
  kind can exist per revision.
- `case_resolutions`: human no-action resolution rows with case version, bounded reason, actor and
  time.

The API role alone may insert decisions/requests/resolutions and update decision/request lifecycle
columns; the worker may read decisions/requests/resolutions and may only update decision lifecycle when an
external change invalidates a proposal; it cannot insert human decisions. Editing or expiring a
revision supersedes its active decisions in the same transaction. An edit retargets a matching
approval wait to the new revision; expiry moves it to a recorded human-input wait. Approval
completion resumes the matching waiting workflow run; rejection, clarification and reanalysis move it
to a recorded human-input wait. No-action requires an active run, cancels unstarted plans/active
runs, then resolves through the case reducer only after the execution-state port reports no
started/succeeded/unknown effect. Enterprise execution remains absent until F13A.

## Execution receipts and per-item state (F13A)

Migration `packages/db/migrations/0010_executions.sql` adds:

- `action_executions`: one row per revision item with stable execution key, command kind, plan/item
  hash, `pending|in_progress|succeeded|retryable_failure|unknown|permanent_failure|cancelled` state,
  authorization basis (`human|policy_auto`), policy identity, per-item committed amount, receipt
  identity/result and attempt count. Unique on `(sandbox, revision, item)` and the execution key.
- `action_execution_attempts`: bounded attempt rows with request hash, executeBefore, authorization
  lifetime, state, error code and timestamps.
- `action_execution_receipts`: immutable local receipt copy with typed result, plan/item hash,
  command kind and raw receipt JSON.
- `action_execution_entity_changes`: typed receipt entity changes used only for the proven
  same-revision version-chain advance and own-origin invalidation proof.
- `case_notes`: policy-auto internal notes with policy revision/content hash, unique per revision
  item.

The worker role owns execution/attempt/note writes and current execution state; the API role has
read-only execution/receipt/note access for prior commitments, preflight and no-action checks. No
JSON blob substitutes for the queryable execution state, per-item identity, committed amount,
receipt key, result IDs/versions or entity-change versions. F13B adds recovery/cancellation/partial
effect tables and the absent-final protocol; F13A does not claim exactly-once delivery.

## Recovery, attempt payloads and partial effects (F13B)

Migration `packages/db/migrations/0011_recovery.sql` adds:

- `execution_attempt_payloads`: exact resolved payload, base expected versions, prior receipt keys,
  command kind, stable receipt key and per-attempt deadlines stored before I/O; used to reissue only
  the identical business payload after `absent_final`.
- `execution_reconciliations`: append-only unknown/absent-final/found observations with the shared DB
  clock and receipt key.
- `action_partial_effects`: one typed succeeded/cancelled/unknown record per execution, preserving
  effect identity instead of fictional rollback.
- `action_reanalysis_handoffs`: source proposal/revision, succeeded receipt keys, cancelled item IDs,
  pending/consumed state and an optional linked created proposal. At most one handoff exists per
  source revision; consuming it creates a new proposal from only unsent items with advanced versions
  and no cloned approvals.

The worker owns reconciliation, partial-effect and handoff writes; the API may read them and may
insert the F13 reanalysis handoff in the same transaction as that request. Receipt payloads and
entity changes remain typed/queryable where they drive decisions; the raw simulator receipt is an
audit copy, not the source of truth. F13A execution rows are frozen once any item starts; F13B
reconciles before any reissue or cancellation.

# Action Proposals, Policy Bundles and Revision Hashes (F12)

This document describes the F12 boundary: how the application turns a manually submitted
closed action draft into an immutable, policy-derived action revision. It does not describe
approval decisions (F13), enterprise execution (F13A) or later recovery.

## Authority model

The flow has four separate sources of authority:

1. The reviewed policy bundle remains data. It may tighten a compiled numeric threshold,
   disable the single low-risk automation or narrow the enabled action catalog. It cannot add
   an action handler, add an approval role, widen a hard threshold, lengthen the maximum
   approval lifetime or grant an automatic execution.
2. Compiled domain code owns the finite action catalog, role mapping, hard ceilings, graph
   validation, money calculation and canonical hashing. The only policy bundle accepted today
   is `northstar` revision `northstar-v1`.
3. The server derives item identifiers, dependencies, base expected versions, plan hash,
   aggregate impact and required roles. A draft cannot supply any of these fields.
4. A persisted `pending_approval` revision is a request for a decision, not an authorization
   and not an execution. F13 owns approval decisions; F13A owns execution.

The model or operator may draft only the allowlisted payload and prose fields of an action
draft. The strict Zod schemas reject unknown fields, so a forged status, role, dependency,
hash, expected version or approval flag is a validation error.

## Policy bundle

`config/policies/northstar-v1.json` is validated by `PolicyBundleSchema` in
`packages/contracts/src/policies.ts`. The canonical human-readable policy is
`fixtures/knowledge/northstar-v1.md`; its exact UTF-8 bytes are hashed with SHA-256 and the hash
must match the bundle. The bundle path is checked against the revision.

| Field | Rule |
| --- | --- |
| `schemaVersion` | Literal `1`. |
| `policyId` | Literal `northstar`; no generic policy engine exists. |
| `revision` | `northstar-v<N>`; a changed executable rule needs a new revision. |
| `canonicalText.path` | Must equal `fixtures/knowledge/<revision>.md`. |
| `canonicalText.sha256` | Must equal the file's SHA-256. |
| `supplyApproval.financeThresholdMinor` | Non-negative and at most `50000` (EUR 500.00). Lower values tighten. |
| `approval.ttlHours` | Integer from 1 to 24; 24 is the hard ceiling. |
| `lowRiskAutomation.enabled` | May be false. If true, `actionKinds` must be exactly `case.add_internal_note`. |
| `lowRiskAutomation.actionKinds` | Empty when disabled; otherwise only the internal note. |
| `enabledActionKinds` | Unique subset of the compiled catalog; cannot enable an absent handler. |

The bundle is registered in `nexus.policy_bundles` on first use. The row is keyed by revision
and keeps the canonical bundle hash and canonical text hash. A later file change that reuses
the same revision is a `POLICY_REVISION_CONFLICT` and fails closed. Proposals pin the bundle
revision and bundle content hash.

## Finite action catalog

Only action kinds that have a compiled policy rule are accepted:

| Action kind | Handler | Approval roles | Finance threshold | Automatic |
| --- | --- | --- | --- | --- |
| `case.add_internal_note` | Internal note | none | no | yes, if enabled |
| `enterprise.create_purchase_order` | Purchase order | `approver_ops` | yes | never |
| `enterprise.send_message` | Message | `approver_ops` | no | never |

The other closed `ActionKind` values remain declared contracts for later owning stages. They
have no F12 handler, so F12 rejects them regardless of the declared schema. A future kind
requires an explicit handler, policy rule, tests and an authorizing stage; it does not become
enabled by adding it to the bundle.

No communication, money, inventory or business-status write is automatic. The internal note
is limited to plain text of at most 2,000 characters and cannot send or mutate enterprise
state.

## Revision construction

A manual create request supplies a case ID and a closed `ActionDraftPlan`. The server:

1. Resolves the active sandbox and confirms the case exists and is not terminal.
2. Loads and validates the policy bundle and confirms the registered revision content.
3. Validates every action kind against the compiled catalog and bundle enablement.
4. Assigns stable random UUID item identifiers in one revision.
5. Validates every evidence reference: it must exist in the same sandbox, be available, and
   either have no case or the proposal case. Enterprise items require at least one evidence
   reference; the internal note may have none.
6. Enumerates every enterprise entity referenced by the item target and payload (source purchase
   order, supplier, product, agreement, message recipient, invoice, order or delivery). Every
   referenced entity must have available enterprise evidence that binds its version. The
   server-derived evidence version becomes the expected version; a client-supplied target version
   is accepted only when it equals that evidence version. Missing or conflicting evidence rejects
   the plan. The complete sorted set is `baseExpectedVersions`.
7. Validates the dependency DAG: known dependencies, no self-reference, no cycle, unique
   identifiers, unique dependencies, unique evidence per item and receipt bindings that point
   to a compatible predecessor. F12 public drafts have no dependencies; the graph validator is
   shared with later scenario builders.
8. Computes the whole-plan purchase-order commitment: every line quantity times its unit price
   plus the explicit expedite charge. It rejects negative or zero unit prices and negative
   expedite charges.
9. Derives required roles. Operations is required for every purchase order and message. Finance
   is added when prior successful additional procurement plus the new plan commitment exceeds
   the bundle threshold. Role names are deduplicated and emitted in fixed order.
10. Computes the canonical plan hash and persists the proposal, revision, evidence links and
    audit record in one transaction.

The aggregate impact stored on the revision is the new plan's EUR commitment, not the prior
case total. The finance decision uses prior plus new, but the revision reports exactly the new
consequences. Before F13A there are no action executions, so the prior successful commitment is
provided through a typed port that currently returns zero; no future execution table is
queried.

At most one open unexecuted procurement proposal may exist per case. The partial unique index
covers `draft`, `pending_approval` and `approved` proposals that contain a purchase order, so an
approved but not yet executed plan still blocks a second procurement plan.

## Canonical plan hash

`packages/application/src/actions/revision-hash.ts` defines hash version 1 and catalog version 1.
An item hash covers the item identifier, target, sorted dependencies, sorted base expected
versions, sorted evidence IDs and the canonical payload. The plan hash covers the hash version,
catalog version, policy revision, policy content hash and the sorted hashes of all items.

Array order that carries no semantics (dependencies, base versions, evidence IDs, item order)
is sorted before hashing. Object key order is canonicalized by the F03 canonical JSON helper.
Rationale prose is not approval-critical and is not hashed. The revision number is not part of
the plan hash: two revisions that retain the same items, evidence and policy identity keep the
same plan hash, while any changed item changes the whole-plan hash. F13 binds decisions to the
proposal, revision, plan hash, role slots and expiry.

## Proposal and revision lifecycle

- Creation persists revision number 1 in `pending_approval` and sets the proposal current
  revision.
- A bounded edit supplies every existing item identifier and an `If-Match` positive revision
  precondition. It may not add or remove items or change item identity. The server recomputes
  all consequences and hashes.
- `draft`, `pending_approval` and `approved` revisions are editable while no execution exists.
  A successful edit marks the previous revision `superseded` and inserts a new
  `pending_approval` revision with the next number in one transaction, incrementing the
  proposal version. No decision rows exist in F12; F13 will supersede pending decisions in the
  same transaction. F13A will reject an edit after execution starts.
- Concurrent edits use a proposal row lock. Both may read the same current revision, but only
  one transaction may create the next number; the other receives `STALE_STATE` (409).
- A referenced enterprise entity change expires the whole current revision and proposal. The
  worker consumes `enterprise.*.changed.v1` inbox rows, matches targets, base expected versions
  and payload references, and expires affected `draft`, `pending_approval` and `approved`
  proposals. Unrelated entities remain untouched. F12 records `originatingRevisionId` but
  deliberately does not exempt its own executions because execution does not exist yet; F13A
  adds the proven own-execution exemption.
- Revisions and their evidence links are immutable. Only lifecycle `state`/`updated_at` may
  change for supersede or expiry; proposal `current_revision_id`, `status`, `has_procurement`,
  `version` and `updated_at` may change.

## API

`POST /api/v1/cases/{caseId}/proposals` (operator, CSRF) requires a UUID `Idempotency-Key`
header and accepts `{ plan }` where `plan` is the closed `ActionDraftPlan`. The same key and body
returns the original 201 result; the same key with a different body returns
`IDEMPOTENCY_MISMATCH` (409).

`GET /api/v1/cases/{caseId}/proposals?limit=N&cursor=...` (viewer) lists the bounded
newest-first current proposal revisions for one case. The response carries `nextCursor`; passing
it as `cursor` returns the next page.

`PATCH /api/v1/proposals/{proposalId}` (operator, CSRF) requires an `If-Match` positive integer
revision precondition and accepts `{ rationale, items: [{ itemId, target, evidenceIds, payload }] }`.
Every item ID must already exist in the current revision. It returns the new revision; a missing
precondition is 400 and a stale revision is `STALE_STATE` (409).

`GET /api/v1/proposals/{proposalId}` (viewer) returns the current proposal and revision.

All proposal responses are `ActionProposalDetail`. The revision includes the exact items,
dependencies, base expected versions, evidence identifiers, required roles, aggregate impact,
policy revision and plan hash, plus authored actor, creation time and expiry.

## Persistence and audit

Migration `0008_actions_policies.sql` adds:

- `policy_bundles`: revision, validated bundle JSON, content hash, canonical path/hash, status.
- `action_proposals`: sandbox/case, current revision, lifecycle status, procurement flag,
  creator and row version.
- `action_revisions`: immutable plan hash, items, required roles, monetary aggregate, policy
  identity, rationale, author, expiry and lifecycle state.
- `action_revision_evidence`: typed scoped foreign keys to evidence in the same sandbox.
- `action_proposal_idempotency`: creation key scoped by sandbox, actor and route, with the
  canonical request hash and the original response for replay.

The API can insert proposals/revisions/evidence/idempotency rows and update only lifecycle
columns. The worker
can read proposals and update only expiry/supersede lifecycle columns. Neither role can delete
rows or write enterprise data. Audit actions are `action.proposal_created`,
`action.proposal_revised` and `action.proposal_invalidated`; details are limited to the
allowlisted case, revision, hash, policy, status, entity and reason fields. Case history uses
the `caseId` detail to expose the proposal events without leaking action text or evidence
payloads.

## Explicit non-goals

F12 does not create approval decisions, role slots filled by users, action executions,
enterprise receipts, partial effects, outbox command rows, browser UI or automatic note
execution. It does not implement policy scripting, configurable roles, AI-selected thresholds,
dependencies supplied by a model, or edit-after-execution. Those belong to F13, F13A, F13B and
later workbench stages.

## Human decisions, clarification and no-action (F13)

F13 adds the human decision boundary on top of the immutable proposal revision. The API inserts
decisions; clients never send a decision status, role, hash or authority. A decision request binds
the exact `actionRevisionId` and `planHash`; the server rechecks the current proposal, revision,
whole-plan hash, required role set and database expiry under a proposal/action-revision row lock.

`GET /api/v1/approvals` lists pending revisions where the current approver still holds an unfilled
required role and has not already decided. Eligibility is filtered in SQL rather than after paging,
and the cursor uses the same proposal timestamp ordering as the keyset comparison. `POST /api/v1/proposals/{proposalId}/approve` records one
server-selected role slot; `reject` records a rejection and supersedes the unexecuted plan. The server
chooses the slot from the actor's current database roles. Self-approval by the human author, the same
user filling two slots, an ineligible/revoked role, a wrong hash, a stale revision and an expired
revision are rejected. An approval does not execute anything and does not write enterprise state or
an action command.

Only the complete required role set moves the proposal and revision to `approved`. Completion resumes
any workflow run waiting for that exact proposal/revision with `approval_completed`, resets the
waiting step and enqueues the next job. The public run-resume path revalidates that the exact revision
is still current and approved with a complete active decision set before it queues the run. Partial
approvals remain `pending_approval`. An edit retargets a matching approval wait to the new revision;
expiry/external invalidation moves it to a recorded `human_input` wait, so a superseded approval
cannot be resumed. Decisions are
immutable rows with `active|superseded` lifecycle state; an edit, expiry, clarification, reanalysis
or no-action resolution supersedes them atomically. A rejection or clarification/reanalysis moves a
matching approval wait to a recorded `human_input` wait instead of leaving a resumable approval.

`POST /api/v1/proposals/{proposalId}/clarification` records a bounded question without editing the
revision or its history and invalidates partial approvals. `POST .../reanalyse` records the request,
supersedes the whole unexecuted proposal/revision and invalidates decisions. Both use the existing
`human_input` wait type and the current workflow step; no workflow definition or step history is
rewritten. The `waiting_approval -> waiting_input` transition is limited to this recorded control
action. The request row keeps the exact old revision ID, plan hash, actor, reason and wait run ID.

`POST /api/v1/cases/{caseId}/resolve-no-action` is operator-only, requires a bounded reason and an
`Idempotency-Key`, and requires at least one active workflow run so the terminal transition always
goes through the case reducer and emits `nexus.case.completed.v1`. It locks open
proposals/revisions, then active runs, then the case in the same order as decisions and later
dispatch. It supersedes every unstarted plan, cancels active workflow jobs and resolves the case only
when the execution-state port reports no started/succeeded/unknown effect. A manual case with no run
returns `NO_ACTIVE_RUN` rather than bypassing the reducer.
F13's port is empty because execution does not exist; F13A must bind it to real execution rows. The
reason is stored in `case_resolutions` and audit; the audit/response redact the text from general
logs while preserving a content hash.

All mutation POSTs require the UUID `Idempotency-Key` replay contract. `action_command_idempotency`
is scoped by sandbox, actor and route, stores the canonical request hash and original response, and
returns `IDEMPOTENCY_MISMATCH` for a reused key with a changed body. The API role alone may insert
human decisions and requests. The worker may read them and may only mark decisions superseded during
proposal invalidation; it cannot insert a human decision. Preflight for F13A returns the exact
revision/hash, policy revision/content hash, required/filled/missing roles, expiry and execution
state, with `none` before executions exist. Decision registration also rejects an approval when the
revision's policy identity differs from the current validated bundle (`POLICY_CHANGED`). Preflight
is not an execution grant.

## Sequential executor and per-item receipts (F13A)

F13A adds the deterministic executor after approval. `packages/application/src/actions/executor.ts`
walks the approved plan in topological item order; `action-dag.ts` supplies readiness and prior
receipt keys, and `packages/domain/src/actions/bindings.ts` resolves only registered receipt-created
IDs and advances expected versions only through a continuous chain of this same revision's earlier
committed receipts. The first PO's own source-PO/inventory version changes may advance the second
PO's captured base version; an unrelated change or agreement change still requires a new approval.
Created entity bindings start from the creating receipt's result; money, customer, supplier, address
and arbitrary field bindings are rejected.

Each execution is unique on `(sandbox_id, action_revision_id, item_id)` with the stable key
`sandboxId:actionRevisionId:itemId:commandKind`. Before an enterprise command the executor:
reloads the current policy bundle and revision policy identity; checks active sandbox, proposal and
revision state, whole-plan expiry, complete active decisions and no cancellation; fetches prior
receipts through the simulator receipt port rather than trusting local copies; resolves bindings;
computes the canonical command item hash from the resolved payload and advanced base versions; and
sets `executeBefore <= min(DB clock + 30 seconds, revision/approval expiry)`. The business identity
(plan hash, item hash, revision, item, kind, sandbox) is immutable across transport renewal. A
successful receipt is persisted locally with typed result, entity changes and attempt history before
the next item starts. A failed predecessor stops dependents; F13A records the failure and does not
invent a retry. F13B owns unknown/absent-final recovery, cancellation after effects, partial effects
and reissue.

The worker owns execution writes; the API role has read-only execution access for commitment,
preflight and no-action state. `proposal-events` invalidation ignores an event only when its
`originatingRevisionId` plus receipt key matches a locally persisted succeeded execution and entity
change for the same revision; an external/incomplete origin still expires the plan. The F12 prior
commitment port now sums succeeded execution commitments for the case; the F13 empty execution-state
port is bound to real `action_executions` rows in both API and worker compositions.

The sole automatic branch remains `case.add_internal_note`: when the current policy bundle enables
the internal-note automation, the executor records `authorizationBasis=policy_auto` with the policy
revision/content hash and an audit event, inserts the local case note, and creates no enterprise
command or human decision. Pending enterprise PO/message items never execute without a complete
human approval. Execution does not change proposal semantics: approval is not execution proof, and
proposal status remains separate from item execution state.

### F13A dispatch rechecks and uncertain outcomes

Candidate selection excludes terminal cases and any revision with an in-progress, failed or unknown
execution, so one blocked plan cannot stall later approved plans. Claim re-reads the case status,
the pinned-versus-current policy identity, live approver role rows, evidence availability, expiry,
deadline and an all-pending execution set under the proposal/revision locks. Evidence becoming
unavailable expires the plan and supersedes decisions with an `evidence_unavailable` audit rather
than silently skipping it. TIMEOUT/NETWORK/ABORTED, malformed/oversized/sandbox-mismatched responses,
and a local receipt-persistence failure after a remote success persist `unknown`; no-action and
preflight block it. Cancellation or policy change after the claim but before the remote command is
the documented claim-to-dispatch gap owned by F13B, not a claim that F13A is exactly-once.

## Recovery, partial effects and cancellation (F13B)

F13B reconciles remote uncertainty without repeating or pretending to undo effects. Every command
attempt stores the exact resolved payload, base versions and prior receipt keys in
`execution_attempt_payloads` before I/O. The reconciler queries the simulator receipt by the stable
key before any retry. A found receipt is applied locally even if approval later expired or the plan
was cancelled; the local execution becomes succeeded with its typed receipt/entity changes and a
partial-effect record. Absence is `unknown` until the shared DB clock is past `executeBefore + 10s`;
after that it is `absent_final`.

Only after `absent_final`, with current approval/roles/evidence/versions/sandbox still valid and no
cancellation, may the reconciler create the next command attempt with the same business payload and
receipt key, a newly recorded bounded `executeBefore`, and at most three total attempts. It never
changes payload, versions or plan hash to force a retry. An expired approval, revoked role, changed
evidence, terminal case, attempt limit or missing safe deadline converts the item to cancelled with a
partial-effect record. A 409 requires refreshed evidence/new revision, not a same-key retry.

`CancelPlanService` first drains recoverable attempts. If any item remains in-progress or unknown it
returns `PLAN_UNRESOLVED`; otherwise it marks only unsent items cancelled, preserves succeeded
receipts/amounts, supersedes the plan/decisions and writes an `action_reanalysis_handoffs` row with
the succeeded receipt keys and cancelled item IDs. Reanalysis creates the same handoff and never
clones succeeded executions or approvals. Consuming the handoff creates a linked proposal containing
only unsent items, with base versions advanced by prior receipts, message receipt facts from succeeded
items rendered as text, and no approval rows; a repeat reuses receipts/handoff. The handoff is
idempotent per source revision. No automatic refund/delete/unreserve/rollback is claimed. F13A edit freeze now
rejects any revision containing in-progress, unknown or succeeded execution.

Workflow cancellation first enters `cancel_requested`, marks unsent executions cancelled, and a
worker completion step transitions the run/case to cancelled only after all in-progress/unknown
executions resolve into found/succeeded or cancelled/absent states, recording run partial effects.
The remote authorization interval remains bounded: a command accepted by the simulator after the
executor's last local check cannot be undone by cancellation or later role removal. The simulator
still enforces its own deadline; a found receipt always wins.

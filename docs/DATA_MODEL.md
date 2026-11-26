# NEXUS Data Model

Status: F05 implements the shared case/evidence foundation. Identity tables are in F04;
enterprise, workflow, action, model, document, knowledge, memory, assistant and evaluation
tables belong to their later owning stages and are not created here.

## Ownership and migration map

| Module | Tables | Owner |
|---|---|---|
| Identity | `users`, `user_roles`, `sessions`, `preauth_challenges`, readonly `approver_role_view` | F04 |
| Case foundation | `sandboxes`, `active_sandbox`, `cases`, `case_entity_links`, `sequence_counters`, `evidence`, `audit_events`, `trace_events` | F05 |
| Enterprise supply/sales | suppliers/products/customers/orders/inventory/agreements | F07 |
| Events/workflows/actions/documents/knowledge/etc. | their own migrations | later stages |

Migrations are monotonically numbered SQL files under `packages/db/migrations/`, applied
with the checksummed ledger runner. Destructive changes require an explicit migration plan;
ORM push is not used.

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
Retired sandboxes are read-only; F46 introduces non-destructive sandbox reset by creating a
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

`nexus.evidence` is insert-only. It stores kind, source status (`available` or `missing`),
source system/type/ID/version/sandbox, a 64-character content hash, optional locator,
captured facts, nullable missing reason and capture time. A missing source must have a null
source reference and a non-null reason; an available source must have a same-sandbox source
reference and no missing reason. The application validates source provenance and locator
bounds before insert; runtime roles have no update/delete grant.

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
may update/delete evidence, audit or trace. Public access is revoked.

## F05 boundaries

F05 does not create workflow runs, proposals, approvals, executions, documents, blobs,
knowledge, enterprise tables, model calls or a public event-driven case POST. The initial
sandbox is a foundation seed, not a complete demo scenario.

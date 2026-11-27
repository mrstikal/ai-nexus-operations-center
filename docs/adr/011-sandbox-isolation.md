# Architecture Decision Record 011: Sandbox Isolation

## Status

Accepted as the fixed isolation decision of the implementation plan. F05 implements the
initial active sandbox, scoped case/evidence/audit/trace foundation and server-side read
resolution; non-destructive reset remains F56.

## Context

NEXUS demonstrates one fictional company with multiple synthetic scenarios. Scenarios must
not leak mutable records, evidence, traces or approvals into each other, and a reset must
not truncate audit/approval/spend history while workers or approvals exist. Users and
sessions are global application identity, not tenant records. The browser must not choose
an arbitrary sandbox and use case IDs as authorization.

## Decision

- Represent scenarios as rows in `nexus.sandboxes`; one `active_sandbox` singleton selects
  the current server-side scenario.
- Seed the initial sandbox ID `00000000-0000-4000-8000-000000000001` with business effective
  time `2026-11-02T09:00:00Z`. The initial sandbox is not a complete scenario seed.
- Scope every case/evidence/audit/trace row by `sandbox_id`. Use composite scoped foreign
  keys for local business references and validate external references.
- Resolve the active sandbox on the server for every request. A browser-supplied sandbox or
  case/evidence ID never grants access; foreign-sandbox resources return 404 without content.
- Treat retired sandboxes as read-only. Reset creates a new seed/sandbox generation in F56;
  it does not truncate historical data or use destructive volume cleanup.
- Keep users/sessions/configuration global. Isolation is for synthetic scenarios of one
  company, not a multi-tenant authorization claim.

## Consequences

- Every future business table and query must carry the sandbox scope and preserve composite
  references. Lint/test additions should reject unscoped case/evidence reads.
- Audit and trace remain queryable per sandbox and can survive inactive sandbox read-only
  operation.
- Evidence cannot claim a source from another sandbox; source status must be explicit when
  a source is missing.
- F05 does not implement browser sandbox switching or reset; F06 displays the active context
  and F56 adds admin-confirmed lifecycle.
- Cross-sandbox IDs return 404/403 without revealing whether the record exists.

## Alternatives considered

- Destructive database or volume reset: rejected because it destroys audit/approval/spend
  history and races workers and approvals.
- Client-selected sandbox headers: rejected because a browser-supplied ID is not
  authorization and invites IDOR.
- One global shared mutable scenario: rejected because scenarios must not leak evidence or
  mutable enterprise state into each other.
- Multi-tenant row-level security claim: out of scope; this is one company's synthetic
  sandbox isolation.

## Sources

- [NEXUS implementation plan](../../NEXUS_IMPLEMENTATION_PLAN_final.md) sections 2.3, 3.2, 4.1,
  F05 and F56.
- [Data model](../DATA_MODEL.md), [security guide](../SECURITY.md).

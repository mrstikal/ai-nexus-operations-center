# ADR 010: Shared Live and Replay Gateway Logic

- Status: Accepted (F14)
- Date: 2026-11-27

## Context

The product must demonstrate AI-assisted operations without an API key or network access, while the
same business modules must later run against a live provider with strict budgets and validated
outputs. The plan forbids a separate "demo" reasoning path, hidden replay fallback in live mode, and
generic replay stubs that can return success for the wrong source.

Replay is a test and demonstration mode, not a quality claim. Live provider access is implemented in
F25 and requires explicit budget and privacy preflight. Accounting must survive crashes and must not
be bypassable by two workers.

## Decision

Use one `ModelGateway` contract and one gateway implementation with two interchangeable execution
ports:

- a **replay adapter** that resolves a deterministic key from the normalized semantic request,
  prompt/config/schema identity and selected route, and returns a checked-in validated output or a
  registered failure;
- a **provider port** that F25 implements for OpenRouter. F14 uses a fake provider only for contract
  and accounting tests.

Both paths share:

- role/output-schema validation (Zod) after the provider or fixture returns;
- the prompt content hash and config revision;
- the same attempt, fallback and schema-repair policy, with at most two physical attempts;
- the same hierarchical budget reservation, settlement and uncertain-charge rules;
- the same redacted trace fields and the same typed failure codes.

The gateway never silently changes mode. Live failures return typed failures; they do not fall back
to replay. Replay never reads a key or performs network I/O. A replay miss is a typed failure, not a
synthetic success.

Budget accounts are hierarchical per sandbox. Before provider I/O, the gateway reserves a
conservative bound against the account and every ancestor, locking ancestor-to-leaf in stable order.
The call ledger row and reservation are transactional; provider I/O happens only after the
reservation commits. Settlement replaces reservations with actual or conservatively estimated cost;
timeouts retain the reservation as an uncertain charge. Attempt identities are unique and idempotent.

## Alternatives Considered

- **Separate replay and live business paths.** Rejected: it would allow scenario behavior to drift
  and could hide an unimplemented live capability behind a green replay test.
- **Record/replay at the HTTP client layer.** Rejected: it would replay provider wire payloads and
  bypass output-schema validation, prompt/config identity and budget accounting.
- **Generic success fixtures keyed by role.** Rejected: changed source or evidence would receive an
  unrelated answer.
- **Provider SDK retries.** Rejected: SDK retries multiply spend and cannot share the workflow's
  attempt and dollar caps. The gateway owns the two-attempt bound.
- **Reservations outside the database.** Rejected: a crash or a second worker could bypass the cap.
  Database locking and persisted call rows are required for the tested guarantee.
- **Release reservation on timeout.** Rejected: a timeout does not prove the provider did not bill.
  The conservative uncertain charge is retained.

## Consequences

- F25 can add the live adapter without changing business modules, replay behavior or budget rules.
- Every provider output is schema-validated twice in spirit (provider strictness is not trusted).
- A new source, prompt, schema or route requires a matching replay record; tests fail closed.
- Budget accounts must be created by scenario/document/assistant owners. F14 provides the service
  and hierarchy; F20/F34/F42/F46 own concrete wiring and caps.
- An uncertain reservation blocks further admission until an operator or reconciliation job finalizes
  it; this is intentional spend safety, not a missing retry.
- Replay evidence cannot be reported as live model quality. Live evaluation remains separately
  gated in F54.

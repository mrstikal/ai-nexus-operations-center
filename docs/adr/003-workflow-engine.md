# ADR 003: Custom persisted workflow engine

- Status: accepted for F11 implementation
- Date: 2026-11-26
- Owners: F11 workflow journal, jobs and leases

## Context

The product must survive worker/process death between model, read, proposal and enterprise-action
steps; prevent a stale worker from committing a result; reuse a succeeded pure step by immutable
input; and keep every attempt observable with typed evidence and trace references. The flows are
short, bounded (at most six actions, twelve reads, ten model attempts) and must bind human
approvals, action revisions and command receipts that are outside any generic graph framework.

## Decision

Use an explicit PostgreSQL-backed state machine:

- `workflow_runs` stores the immutable ingress, definition version, revisions, budgets, deadline
  and current state.
- `workflow_jobs` is the durable work queue. Claims use `FOR UPDATE SKIP LOCKED`, a 30-second
  database-time lease, a 5-second heartbeat and a monotonic fencing token. Every commit checks the
  token and unexpired lease.
- `workflow_steps` and immutable `workflow_step_attempts` store input/output hashes, redacted
  output, evidence joins, timing, error class and model/policy/config/prompt revisions.
- Pure/read steps retry `1s`/`5s`/`30s` at most three times; external steps are never generically
  retried. A run deadline/active-time exhaustion becomes `budget_exhausted`.
- RabbitMQ is a wakeup/delivery mechanism only. Pending inbox rows, jobs, leases and attempts are
  database state, so a worker restart does not depend on an open HTTP request, Redis, or a broker
  delivery being held.
- Test definitions are gated by `NEXUS_WORKFLOW_TEST_DEFINITION=1`; no business workflow is
  presented as a product demo.

## Alternatives

### LangGraph JS

LangGraph provides graph orchestration, checkpoints and human-in-the-loop persistence. It still
would not supply this product's human approval/revision binding, canonical action hashes, command
receipts, evidence joins, policy roles or enterprise reconciliation. Adopting it would create a
second checkpoint lifecycle and a second source of run state. The bounded custom state machine is
smaller and keeps the authorization ledger authoritative.

### Temporal

Temporal provides durable workflows, retries, timers and visibility, but requires a server,
operational ownership and deterministic replay constraints. These short bounded flows do not
justify a second durable system. Enterprise effects still need the existing receipt/idempotency
boundary, and approvals still need the product's immutable revision binding. Temporal may be a
future operational choice only if workload and team scale justify it; it is not required here.

### Broker-only jobs

Using RabbitMQ delivery as the job state would lose a claimed job when a worker dies and would make
fencing, attempt history and stale commits dependent on broker semantics. Rejected.

### In-memory runner

Rejected: process death would lose accepted work and make a succeeded pure step ambiguous.

## Consequences

- The database is the execution source of truth; the broker only wakes workers.
- A stale worker cannot commit after lease theft, and a crash window may retry a pure step but
  reuses any committed same-input success.
- Attempt history and trace/evidence references remain queryable without reading model context or
  provider chain-of-thought.
- F11A must add explicit resume causes; F11B must expose bounded run/SSE queries; neither may
  create a parallel state store.
- Operators can inspect pending jobs, expired leases, blocked definitions and failed attempts with
  SQL; no automatic job deletion is provided.

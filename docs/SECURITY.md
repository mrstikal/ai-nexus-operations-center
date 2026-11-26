# NEXUS Security

This document covers the F04 human identity boundary: sessions, CSRF, RBAC and rate
limits. It does not add case, AI, action or external identity-provider behavior. A login
role alone never represents human approval of an action; approval remains a separate
reviewed decision in later phases.

## Authentication endpoints

All routes use the same-origin API prefix `/api/v1`.

| Method and path | Behavior |
|---|---|
| `GET /api/v1/auth/csrf` | With a valid session, rotates and returns a session CSRF token. Without one, creates a five-minute single-use preauth challenge. |
| `POST /api/v1/auth/login` | Consumes a freshly issued preauth challenge, validates Origin and CSRF, applies login rate limits, verifies scrypt credentials, creates an eight-hour session and sets the session cookie. |
| `GET /api/v1/auth/me` | Requires a session. Returns identity and roles only; sandbox context is added by F05. |
| `POST /api/v1/auth/logout` | Requires session, exact Origin and session CSRF. Revokes the session, clears the cookie and invalidates further use of the token. |

Errors use `application/problem+json` with one of the frozen codes from
`docs/CONTRACTS.md`. Login failures are generic; unknown user and wrong password do not
produce distinguishable messages. Passwords, session tokens, CSRF tokens and password
digests are never returned in error bodies or log capture.

## Session and challenge rules

- Session tokens are opaque 256-bit random values. Only their SHA-256 digest is stored.
- Sessions last eight real hours from database `clock_timestamp()`; there is no invisible
  renewal.
- The session cookie is host-only, `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure`
  by default. Local development must explicitly set `NEXUS_COOKIE_SECURE=false`; the
  attribute is never inferred from a client-supplied Host header. No `Domain` is set.
- The preauth challenge is random, stored by digest, expires after five minutes and is
  consumed atomically exactly once by login.
- A session CSRF token is returned through the same-origin JSON response. It is kept in
  browser memory, never in a URL or log, and its digest is bound to the session. GET
  `/auth/csrf` can rotate it after a reload only for a same-origin request or an allowed
  Origin; cross-site metadata is rejected.
- Mutations require the exact allowed Origin, `X-CSRF-Token`, and a healthy Valkey
  admission check. Missing/wrong values fail closed with 403; cache loss fails closed with
  503. CORS is not used as a CSRF defense.
- Password hashing uses Node scrypt with a random 16-byte salt, `N=32768`, `r=8`, `p=1`,
  64-byte key, and a configured 64 MiB memory allowance. Digests are compared in constant
  time. Invalid or out-of-bound hash parameters fail closed.

## Authorization

Roles are read from PostgreSQL on each protected request. Client headers, request bodies
and login roles cannot grant a permission.

| Role | Baseline permissions |
|---|---|
| `viewer` | Read cases/evidence/documents/traces/dashboard |
| `operator` | Viewer reads plus case/document/proposal/clarification/run/assistant/demo launch |
| `approver_ops` | Viewer reads plus operational approval |
| `approver_finance` | Viewer reads plus financial approval |
| `admin` | Viewer reads plus knowledge/config/evaluation/demo management; no implicit approval |

Operator, approver and admin roles also receive viewer read access. Required role slots
for high-cost actions are separate identity checks; the same user cannot fill both slots
when the action policy requires separate people. Admin does not imply `approver_ops` or
`approver_finance`.

Database grants follow the same boundary: `nexus_api` maintains identity/session rows;
`nexus_worker` receives only `SELECT` on the readonly `nexus.approver_role_view`, never
password or session digests. Migration/seed credentials are not runtime API credentials.

## Rate limits and cache outage

Login admission uses Valkey counters keyed by SHA-256 of normalized username and client
IP. The implementation reserves an attempt atomically before password verification: at most
five attempts per username and twenty per IP in a 15-minute window. Exceeding a limit
returns `RATE_LIMITED` with `Retry-After`. A missing, expired or replayed challenge
releases its reservation; a successful login clears the username failure counter but
does not refund the shared IP attempt budget. The IP budget therefore counts all
admitted attempts in the window, including successes; shared egress addresses can
reach it and should use the documented local accounts only in development.

Valkey is admission state, not identity truth. If Valkey is unavailable, login and
CSRF-protected mutations fail closed with `DEPENDENCY_UNAVAILABLE`. An already
authenticated read such as `/auth/me` continues against PostgreSQL. Cache failure cannot
grant a role, create a session or approve an action.

## Local accounts

`pnpm demo:init` applies identity migrations and seeds three local accounts:
`operator`, `ops.approver`, and `finance.admin` from `fixtures/users/roles.json`.
Generated passwords are written to ignored `.env.local` with mode `0600`. When run in an
interactive terminal, the newly generated credentials are printed once; non-interactive
or captured output is redacted from secrets. Never copy these passwords into examples,
evidence, prompts, source or logs. No production password is hardcoded.

For host-run local development, run `pnpm infra:up --dev-ports` so PostgreSQL and
Valkey are reachable on loopback, and ensure `NEXUS_ALLOWED_ORIGINS` contains the exact
web origin. The API development script loads the root `.env` with Nest CLI `--env-file`;
a bare `node dist/main.js` requires the environment to be supplied explicitly. The F04
integration suite uses test-only accounts with disposable test passwords and an isolated
Compose project.

## F04 boundaries

- No external identity provider, MFA, password reset, role administration UI, case/AI/
  action endpoint or sandbox context is implemented.
- The test-only guard routes live in the separate compiled `auth/test-app` entrypoint,
  not the production API.
- `/auth/me` intentionally omits sandbox context; F05 adds the active sandbox.
- Passing F04 tests do not establish approval, execution or AI safety.

## Case reads, audit and trace

F05 adds read-only case, history and evidence APIs under `/api/v1`. The server resolves the
active sandbox; a browser-supplied sandbox is never accepted. Foreign-sandbox case/evidence
IDs return 404 without content. Mutations against a retired sandbox return `STALE_STATE`.
`/api/v1/sandbox` exposes only the server-selected sandbox context. `/auth/me` remains
identity/roles only.

Audit is append-only security/business history. Runtime API and worker roles may select and
insert audit rows, but cannot update or delete them. Audit stores actor/request/correlation
context, target identity/version, before/after hashes, outcome and allowlisted details.
Free-form uploads, personal addresses, secrets and provider content are not audit fields;
the redaction allowlist rejects them before insert. Per-sandbox sequence allocation is
transactional, so concurrent appends receive unique sequence numbers.

Trace is bounded operational diagnostics, not audit evidence. It stores level/event and an
allowlisted primitive payload with a per-sandbox sequence, and is retained under the
diagnostic policy without becoming a workflow journal. Trace must not contain raw prompts,
secrets or personal data. Application roles can append/read trace but cannot alter existing
audit or trace rows. Audit/decision/receipt/spend records are retained longer than traces;
retention jobs arrive in F46A and must never purge approval/audit history silently.

## Enterprise read client and tool registry

F09 connects application reads to the private simulator through a typed port and a strict
client. The read token and the executor-only command token remain separate. Both are
configured only in the adapter constructors, are stored in private fields, never enter
tool metadata, argument/result schemas, traces, prompts, browser code or logs, and are not
serialized with the client.

The HTTP client accepts only an HTTP(S) base URL without credentials, path, query or
fragment. It sets the read token, sandbox and correlation headers itself, rejects
redirects, applies a bounded timeout and enforces a response byte cap while reading the
stream, so an oversized body is cancelled before it is fully accumulated. It requires a
JSON content type, validates the response against the shared untrusted schema and verifies
that the returned sandbox equals the requested sandbox. Timeouts, network failures,
`RATE_LIMITED` and `DEPENDENCY_UNAVAILABLE` are retryable; validation, authentication,
conflict, malformed or oversized responses, sandbox mismatches and unrecognized problem
codes are not. Problem bodies are reduced to a typed code and request ID; server text is
not copied into errors, and an unrecognized code is preserved only as a bounded trace cause
while the error itself remains non-retryable.

The AI registry exposes only read tools. It checks role permission, scenario support and
the workflow-step allowlist before execution, rejects unknown and write-action names, and
after execution re-validates the untrusted result schema, byte and item bounds and sandbox
identity. The trace is a redacted summary; it does not contain argument values, result
payloads, prompts or credentials. Registering a tool that matches a privileged action name
fails registry construction. Later stages may register compute or propose tools only in
their owner stages; no stage may register the command client, a business-write tool or an
arbitrary SQL/HTTP/file tool.

Application code depends only on `EnterpriseReadPort` and the registry port. It must not
import `@nexus/enterprise-db`, call the simulator with ad hoc `fetch`, hold simulator
tokens or derive permissions from tool input. F09 contract tests run a fake HTTP server,
not mocked application repositories, and replace the read adapter with a test port without
changing tool definitions or domain code.

## Durable ingress, outbox and inbox (F10)

The public case intake derives the actor from the authenticated session and the sandbox from
`nexus.active_sandbox`; neither request-body field is trusted. It requires an operator role, a
same-origin CSRF check and a bounded `Idempotency-Key`. The canonical request hash and normalized
source identity are stored in `nexus.ingress_keys`; a reused key or source with a different body
returns `IDEMPOTENCY_MISMATCH`, never a second case or event. A document reference is rejected
until a document store exists. The accepted case, audit event, Nexus outbox event and ingress key
commit in one transaction.

The Nexus and enterprise outbox publishers read only code-owned rows, validate every event
against the closed registry, publish to their own exchange and wait for publisher confirms before
marking delivery. Credentials are read from the environment, never written to outbox payloads,
inbox envelopes, dead letters or logs. A producer cannot substitute an enterprise event in the
Nexus exchange: the publisher checks the event namespace and producer, and the consumer repeats
the check on the received exchange, type prefix and registered producer.

The consumer inserts a pending inbox row before acknowledgement. A handler does no AI, human or
business work while holding a delivery. Duplicate deliveries are acknowledged without a second
inbox row; the unique `(consumer_name,event_id)` is the business duplicate guard. Schema poison,
unknown event names, producer/exchange mismatches, oversized messages and unknown sandboxes are
recorded in `dead_letters` with a redacted reason and moved to the durable DLQ; they are not
retried as business work. Transient broker/database failures remain unacknowledged and retry
with the bounded schedule, so an accepted outbox row is never silently dropped.

`nexus_api` can insert/read its ingress and outbox rows but cannot access the inbox or dead
letters. `nexus_worker` can read the outbox and update only publisher columns, and can read/insert
the inbox and dead letters; it has no access to `ingress_keys` and no outbox update outside the
publisher columns. Neither role can read the other database schema. The local broker uses one identity for setup and runtime; F10
documents this as a production-hardening gap and does not claim per-exchange broker ACLs. See
[EVENTS.md](EVENTS.md) for topology, retry, DLQ and runbook details.

## Workflow journal, jobs and leases (F11)

Workflow execution is claimed only from the database job queue with `FOR UPDATE SKIP LOCKED`.
A claim takes a 30-second database-time lease, a monotonic fencing token and an owner identity.
Every step commit, job completion, block and budget transition rechecks the job, owner, token and
unexpired lease in the same transaction. A stale or stolen worker cannot commit, and a heartbeat
after expiry returns false. Lease validity uses `clock_timestamp()`, not process time.

The worker can insert runs, steps, attempts, evidence joins and jobs, but can update only the
journal's mutable lifecycle columns. Ingress, definition identity and attempt rows are immutable
to it. The API receives read-only run/step/attempt access for F11B; it cannot claim jobs or edit
the journal. Attempt records contain canonical input/output hashes, a bounded redacted output
object, evidence IDs joined to existing evidence rows in the same sandbox and revisions/error
class. Evidence references are checked for UUID syntax, uniqueness, existence and sandbox
ownership; an invalid reference becomes a journaled permanent failure, not a repeated execution.
Attempts do not copy raw documents, prompts, model reasoning or enterprise payloads. Trace records
use the existing allowlist and carry only step/status/attempt/duration/error/evidence-count/retry
fields.

Only pure/read steps use the bounded `1s`/`5s`/`30s` retry policy with at most three attempts;
definitions and the database reject a larger limit. External steps are never generically retried;
a retryable failure is recorded as `EXTERNAL_RETRY_FORBIDDEN`. Deadline or projected active-time
exhaustion moves the run to `budget_exhausted` and fails the job in a committed transaction, so a
deadline that passes during a step cannot roll the transition back. A persisted wait releases the
lease; F11 does not perform AI or human work while holding a delivery.

The deterministic test definitions are registered only when
`NEXUS_WORKFLOW_TEST_DEFINITION=1`. Production starts with an empty registry and trigger map, so a
test workflow cannot appear as a product workflow. Unknown definition versions create a blocked
run without a job; a trigger without a case link marks the inbox row dead. Neither path executes a
step. F11 exposes no run/SSE HTTP route; F11B owns authenticated run queries and bounded SSE.

## Workflow waits, resume and cancellation (F11A)

Resume and cancel routes require a session, same-origin CSRF and the operator role. The server
resolves the active sandbox and never accepts an actor, sandbox, approval, hash or status from the
body. Resume requires the exact typed cause and reference for the recorded wait: human input,
the matching approval proposal/action revision. A dependency wait has no public resume cause; only
a validated child completion can release it. A terminal, duplicate, unrelated or unsupported wake
returns `CONFLICT`; it never releases the wait. Budget
extension is reserved but not enabled in F11A.

Dependency rows are same-sandbox, unique per parent run and child trigger, and limited to depth
one: the parent case cannot itself be a waiting child, the child cannot already be a waiting
parent, self-links reject, and a per-sandbox advisory transaction lock serializes creation. The
child run must exist for the exact case/trigger. The 48-real-hour expiry is checked in database
time in both the event and sweep paths; a late resolved event cannot bypass an expired wait. A case-completed event wakes only when the event sandbox, child case, trigger
generation, current terminal status and terminal version match; stale, wrong-child, wrong-sandbox
and duplicate events are consumed without a wake or second job.

The application case reducer is the only writer of case workflow status; the adapter applies its
target through the domain transition graph. A terminal case transition writes the case status,
audit and one `nexus.case.completed.v1` outbox row in the same transaction. A terminal case cannot
resurrect. Cancellation rejects terminal/duplicate requests, cancels waiting jobs and dependencies,
marks pending/running/waiting steps cancelled, and records a typed partial-effect list. F11A has no
side-effect executor, so the list is empty; the `CancellationReconciler` hook is reserved for F13B
and no fake rollback is reported. The runner also refuses to commit a closed/cancel-requested run.

The API receives only column-scoped control grants for workflow runs/jobs/steps/dependencies plus
read access; it cannot claim jobs or write step inputs/outputs. The worker keeps the broader
journal and dependency updates. Case-completed events are not workflow root triggers and the
transport does not expose a replay or control bypass.

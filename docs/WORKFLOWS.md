# Workflow Journal, Jobs and Leases

Status: F11 implements the durable journal, database job queue, fencing leases, a bounded runner
and a deterministic test definition. F11A adds typed waits, explicit resume/cancel control,
dependency linkage/timeout, the case reducer and the terminal case-completed event. F11B owns run
queries and persisted SSE. F11A does not implement a business AI flow, a proposal or an action
executor. The test workflow is registered only when `NEXUS_WORKFLOW_TEST_DEFINITION=1`; it is not a
product demo.

## Tables

Migration `packages/db/migrations/0006_workflows.sql` adds:

| Table | Purpose |
|---|---|
| `workflow_runs` | Immutable ingress, definition name/version, status, wait reason, policy/model/config/prompt revisions, active-time limit/used, deadline, cancellation flag, row version |
| `workflow_steps` | One row per definition step with status, input/output hash, redacted output, evidence refs, attempt count/limit, error class and timing |
| `workflow_step_attempts` | Immutable attempt history with hashes, redacted output, error class, revisions, lease fencing token and timing |
| `workflow_attempt_evidence` | Join from an attempt to an existing evidence row in the same sandbox |
| `workflow_jobs` | Database work queue with state, owner, lease expiry, monotonic fencing token, attempt count and availability time |

`workflow_runs` has a unique `(sandbox_id, trigger_event_id)` so a duplicate trigger cannot create
a second run. `workflow_jobs` has a partial unique index over `(run_id)` for `pending|leased`, so a
run has at most one active job. `workflow_steps` is unique per `(run_id, step_key)` and attempts
per `(step_id, attempt_no)`.

The worker can insert runs/jobs/steps/attempts and update only the mutable journal columns; it
cannot rewrite ingress, definition identity or attempt rows. The API has read access for F11B.
The inbox row, run, initial job and step rows commit in one transaction.

## Claim, lease and fencing

A job is claimed with `FOR UPDATE SKIP LOCKED` in database time:

1. due `pending` jobs or expired `leased` jobs are candidates;
2. a claim sets `state='leased'`, a 30-second lease expiry, a 5-second heartbeat expectation and
   increments the monotonic `fencing_token`;
3. every step commit, job completion, block or budget transition re-checks the job ID, owner,
   fencing token and unexpired lease in the same transaction;
4. a stale worker cannot commit. The new owner's token is authoritative.

The runner heartbeats while a step executes. A heartbeat after expiry returns false and the worker
stops without committing. A process crash leaves the job leased; it is reclaimed only after lease
expiry. The database clock, not a process clock, decides lease validity.

## Attempts, hashes and reuse

Every committed attempt stores the strict input hash, output hash, redacted output object,
evidence references, error class, definition/policy/model/config/prompt revisions and timing. An
attempt trace carries only allowlisted fields: step key, status, case status, attempt, duration, error
class, evidence count and retry flag. Evidence IDs are joined to existing evidence rows; no raw evidence
or document payload is copied into the journal.

Input identity is the canonical hash of definition name/version, run ingress hash, step key and
the sorted dependency output hashes. A succeeded step is reused only when the recomputed input
hash equals the stored hash. A changed input hash for an already-succeeded step blocks the run with
`STEP_INPUT_CHANGED` instead of silently re-executing. Human edits and downstream invalidation are
F11A.

## Execution and retries

- Independent steps run in parallel, maximum four, then join deterministically by step key and
  sorted dependencies. Consequential actions are never parallel.
- Pure/read steps retry `1s`, `5s`, `30s`, at most three attempts. Definitions reject a larger
  pure/read limit and any external limit above one, and the database enforces the same bounds. A
  repeated `(step,inputHash,error)` cannot loop forever.
- An external step is never generically retried: a retryable failure becomes a permanent
  `EXTERNAL_RETRY_FORBIDDEN` failure. Its specialized reconciliation port belongs to the action
  executor stage.
- A step timeout is a retryable failure for pure/read and a permanent failure for external.
- A run has an active-time limit and a real deadline. An expired deadline or exhausted active time
  moves the run to `budget_exhausted`, fails the job and records a typed trace. The check runs
  before execution, on the projected total before committing a step, and before final completion;
  the transition and trace commit even when the deadline passes during a step.
- A step may return `waiting` with a typed wait reason. F11 persists the step/run wait state,
  releases the lease and stops without doing AI/human work. F11A resumes with an explicit cause.
- An unknown definition version creates a `blocked` run and schedules the inbox row; it creates no
  job. A missing case link marks the inbox row `dead` and records a typed trace.
- A missing definition, dependency deadlock or no-ready-step state blocks the run; a permanent
  step failure fails the run. Succeeded steps remain visible.

## Inbox and job handoff

The scheduler polls `nexus.event_inbox` rows with `dispatch_state='pending'` whose event type has a
registered trigger mapping, using `FOR UPDATE SKIP LOCKED`. It validates the existing envelope,
resolves the definition name/version, and in one transaction:

1. returns the existing run for a duplicate trigger and marks the inbox row scheduled;
2. creates a blocked run for an unknown definition and marks the inbox row scheduled;
3. creates the run, all pending step rows and the initial pending job for a known definition;
4. marks the inbox row scheduled and appends a `workflow.scheduled` trace.

The runner then claims the job independently of the HTTP/SSE lifetime. RabbitMQ is only the wakeup
transport; the database is the execution state.

## Runbook queries

```sql
SELECT status, count(*) FROM nexus.workflow_runs GROUP BY status ORDER BY status;
SELECT step_key, status, attempt_count, error_class
FROM nexus.workflow_steps WHERE run_id = $1 ORDER BY step_key;
SELECT attempt_no, status, error_class, started_at, finished_at
FROM nexus.workflow_step_attempts WHERE run_id = $1 ORDER BY attempt_no;
SELECT state, lease_owner, lease_expires_at, fencing_token, attempt_count, available_at
FROM nexus.workflow_jobs WHERE run_id = $1;
SELECT sequence, event, data FROM nexus.trace_events
WHERE run_id = $1 ORDER BY sequence;
```

A stuck `leased` job after a worker death is expected until lease expiry. A growing `pending` job
set means the workflow loop is not running. A `blocked` run with `UNKNOWN_DEFINITION` needs a
registered version; do not edit the run definition in place. `waiting_*` rows are intentional;
F11A adds the resume/cancel controls. F11 has no automatic job deletion.

## Waits, resume and cancellation (F11A)

A step returns a typed `WaitReason`: `human_input`, `approval` with proposal/action-revision IDs,
`dependency` with child case/trigger IDs, or `budget`. The waiting step and run are persisted, the
lease is released and no AI/human work is held. A resume requires the exact recorded cause:

| Wait | Accepted resume cause |
|---|---|
| `waiting_input` | `human_input` |
| `waiting_approval` | `approval_completed` with the exact proposal/action revision |
| `waiting_dependency` | only a validated child `case.completed` event; no public resume cause |
| `budget_exhausted` | `budget_extension` is reserved but not enabled in F11A |

A terminal, duplicate or unrelated wake returns `CONFLICT`; it never releases the wait. The public
API accepts only `human_input`, `approval_completed` and the reserved `budget_extension` (rejected).
`dependency_retry` is not a public cause: a dependency is released only by the validated child
completion path. Resume transactionally clears the wait, resets the waiting step to pending, sets
`resume_cause`, creates a pending job and applies the case reducer. The handler sees `resumeCause`
in its step context.

Dependency waits insert `workflow_dependencies` with the parent run/case, root case, child case and
exact child trigger event, the child case version at linkage, `expires_at = now + 48 real hours`
and `state='waiting'`. The child run must exist in the same sandbox for that exact case/trigger;
the parent case must not itself be a child, the child must not already be a parent, and a case
cannot wait on itself; dependency creation takes a per-sandbox advisory transaction lock so
concurrent reciprocal links cannot both insert. This enforces maximum depth one. A duplicate
active dependency for a run rejects.

A child `case.completed` event wakes waiting parents only when the event's sandbox, child case and
trigger generation match, the current child case is terminal, its current version equals the
event's terminal version, and the event version is at least the linked version. Expiry is checked
against database time in both the event and sweep paths; an expired dependency escalates even if a
late resolved event arrives. A stale/wrong child, version or sandbox event is marked processed
without a wake. A resolved child transactionally
resolves the dependency, queues the parent and resets its waiting step. A child `escalated` or
`cancelled` event, or the 48-hour dependency expiry, sets the dependency `escalated`/`expired` and
escalates the parent: the run becomes cancelled with `dependency_failure`/`dependency_timeout`, the
case becomes `escalated`, and the terminal event is emitted. Duplicate completion events do not
create a second job.

Cancellation accepts a typed cause (`operator_request`, `dependency_failure`, `dependency_timeout`,
`test`). It rejects terminal and duplicate cancellation, cancels active/waiting jobs and waiting
dependency rows, marks pending/running/waiting steps cancelled, and applies the case reducer to
`cancelled` in one transaction. F11A has no side-effect executor, so the partial-effect list is
empty. The typed `CancellationReconciler` hook is reserved for F13B; it records partial effects;
F11A never fabricates a rollback. The runner also checks `cancel_requested`/closed runs between
steps and refuses to commit a cancelled run.

## Case reducer and terminal event

Only `packages/application/src/cases/state.ts` decides case status. It maps `queued`/`running`/
`waiting_dependency` to `investigating`, human waits to `needs_input`, approval waits to
`needs_approval`, completed to `resolved`, failed/budget exhaustion to `escalated`, and
cancellation to `cancelled`; `blocked` stays `investigating` until a control/case decision. It uses
the domain case transition graph, including a valid intermediate path (for example `new` ->
`investigating` -> `resolved`). A terminal case cannot be resurrected.

A terminal case transition (`resolved`, `escalated`, `cancelled`) appends the case audit and inserts
`nexus.case.completed.v1` in the same transaction. The payload carries the terminal run, trigger
event, case version/status and up to 100 outcome evidence IDs; the envelope carries the correlation.
No event is emitted for a repeated same-status update. The event publisher and inbox are the F10
transport.

## Control routes

`POST /api/v1/runs/:runId/resume` and `POST /api/v1/runs/:runId/cancel` require a session,
same-origin CSRF and the operator role. The server resolves the active sandbox; the body contains
only the typed cause/reference. They return the run/case status, or `CONFLICT` for a terminal,
duplicate, illegal or unsupported wake. The browser never supplies an approval, hash, status or
sandbox identity.

## Test-only definition

`test-three-step-v1` has independent `alpha`/`beta` pure steps and a `join` step depending on both.
`test-retry-v1` fails retryably, `test-external-v1` is external and `test-wait-v1` persists a human
wait. They exist only behind `NEXUS_WORKFLOW_TEST_DEFINITION=1`. The production default registry
and trigger map are empty, so F11 does not pretend a business workflow is available.

## Read API and persisted SSE (F11B)

`GET /api/v1/runs/{runId}` returns the persisted run detail: case/run status, definition identity,
wait reason, budgets/deadline, timestamps and a bounded step summary. It never returns raw ingress,
prompts, model output or enterprise payloads. `GET /api/v1/runs/{runId}/events/page?after=&limit=`
returns an ordered bounded page (maximum 200) with `nextAfter`/`hasMore`.

`GET /api/v1/runs/{runId}/events` is the SSE stream. Each frame is
`id: <trace sequence>`, `event: step|status|text_delta|final|error`, and a validated JSON `data`
built only from allowlisted trace fields. `Last-Event-ID` replays persisted events after that
sequence; reconnect uses the same persisted trace rows, not Redis or an in-memory subscription.
The 15-second heartbeat is an SSE comment and is never stored as audit/trace. A disconnected browser
stops only the subscription; the run and its cancel route remain unchanged.

The stream writes bounded pages and a pending write budget. A write that would exceed the budget
closes the connection; the client reconnects from its last event ID. This prevents unbounded server
buffering for a slow client. The browser must use the explicit POST cancel route; closing SSE never
cancels a run. Source/model data is redacted at persistence and again at the response mapper, so
chain-of-thought, credentials and raw payloads cannot be streamed.

Example page:

```json
{
  "items": [
    {"id": 41, "event": "status", "data": {"status": "running", "caseStatus": null, "waitReason": null, "errorClass": null, "count": null}},
    {"id": 42, "event": "step", "data": {"step": "alpha", "status": "succeeded", "attempt": 1, "durationMs": 3, "errorClass": null, "count": 0}}
  ],
  "nextAfter": 42,
  "hasMore": true
}
```

SSE frame example:

```text
id: 42
event: step
data: {"step":"alpha","status":"succeeded","attempt":1,"durationMs":3,"errorClass":null,"count":0}
```

## Boundaries

F11 does not create approvals, proposals, action executions, model calls, documents, knowledge,
customer child cases or SSE. F11A owns waits/resume/cancellation and the case reducer; F11B owns
query/SSE; F12 owns proposals and policies; F13A/B own execution and recovery. See
[ADR 003](adr/003-workflow-engine.md) for the custom-engine comparison.

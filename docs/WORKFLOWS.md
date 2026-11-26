# Workflow Journal, Jobs and Leases

Status: F11 implements the durable journal, database job queue, fencing leases, a bounded runner
and a deterministic test definition. F11A owns human/dependency waits, resume and cancellation;
F11B owns run queries and persisted SSE. F11 does not implement a business AI flow, a proposal or
an action executor. The test workflow is registered only when
`NEXUS_WORKFLOW_TEST_DEFINITION=1`; it is not a product demo.

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
attempt trace carries only allowlisted fields: step key, status, attempt, duration, error class,
evidence count and retry flag. Evidence IDs are joined to existing evidence rows; no raw evidence
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

## Test-only definition

`test-three-step-v1` has independent `alpha`/`beta` pure steps and a `join` step depending on both.
`test-retry-v1` fails retryably, `test-external-v1` is external and `test-wait-v1` persists a human
wait. They exist only behind `NEXUS_WORKFLOW_TEST_DEFINITION=1`. The production default registry
and trigger map are empty, so F11 does not pretend a business workflow is available.

## Boundaries

F11 does not create approvals, proposals, action executions, model calls, documents, knowledge,
customer child cases or SSE. F11A owns waits/resume/cancellation and the case reducer; F11B owns
query/SSE; F12 owns proposals and policies; F13A/B own execution and recovery. See
[ADR 003](adr/003-workflow-engine.md) for the custom-engine comparison.

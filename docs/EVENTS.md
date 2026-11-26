# Durable Events and Ingress

Status: F10 implements transactional ingress, the Nexus and enterprise outbox publishers, the
consumer inbox and a queryable dead-letter path. It does not implement workflow scheduling,
approval, proposal, action execution or AI work; F11 owns scheduling accepted inbox rows.

The canonical event names, envelope and payloads live in
`packages/contracts/src/events/`. The registry accepts only the declared names and producers and
rejects extra fields. Do not add an ad hoc event name or payload outside that directory.

## Envelope and correlation

The envelope is strict: UUID event ID, closed event type and version `1`, ISO-UTC occurrence time,
UUID sandbox, bounded correlation ID, nullable UUID causation ID, `api`/`worker`/`enterprise-sim`
producer and a registry payload.

Event and causation IDs are UUIDs. The correlation ID is a bounded identifier (maximum 128
characters, `[A-Za-z0-9._:-]`); F10 clarified this because the HTTP and enterprise command paths
already use bounded non-UUID correlation strings. A missing or malformed HTTP correlation header
is replaced server-side with a UUID. A producer must never trust a client-supplied sandbox or
actor.

## Broker topology

The broker is the existing single local RabbitMQ node. F10 declares:

| Object | Kind | Purpose |
|---|---|---|
| `nexus.events` | durable topic exchange | Nexus-produced events |
| `enterprise.events` | durable topic exchange | Enterprise-simulator-produced events |
| `nexus.worker.events` | durable quorum queue, prefetch 8 | One worker ingress queue bound to `#` on both exchanges |
| `nexus.events.dlx` | durable direct exchange | Dead-letter routing |
| `nexus.worker.events.dlq` | durable quorum queue | Poison messages and the queryable DLQ |

Publishers use persistent messages and publisher confirms. The consumer uses manual
acknowledgement and checks the source exchange, event-type prefix and registered producer before
accepting an envelope. A handler only validates and inserts a pending inbox row; it never performs
AI, human or business work while holding a delivery.

Production hardening note: the local scaffold uses one broker identity for topology setup,
publishing and consuming. The application restricts each publisher to its own exchange and
event namespace, but broker-level per-exchange credentials are not configured in F10. A
production deployment must split setup credentials from runtime credentials and grant each
runtime only its own exchange/queue.

## Transactional outbox

Nexus writes `nexus.event_outbox` in the same database transaction as the business change. F10's
public intake inserts the case, append-only audit row, outbox event and ingress key atomically.
Enterprise commands already insert `enterprise.event_outbox` with the receipt and committed
mutation; F10 adds the publisher and its `last_error` column.

Both publishers follow the same lifecycle:

1. Claim due `pending` rows or stale `publishing` rows with `FOR UPDATE SKIP LOCKED`, increment
   the attempt count and row version, and mark `publishing`.
2. Validate the stored event against the registry, publish persistently to the producer's
   exchange with the event ID as message ID, and wait for publisher confirms.
3. Mark `published` only after the confirm. A crash after the confirm but before this update leaves
   `publishing`; a later claim republishes it after the claim timeout. Delivery is at least once.
4. On a transient publish/connection failure, mark `pending` with the bounded retry schedule
   `1s`, `5s`, `30s`, capped at `30s`; the case/outbox row remains visible while the broker is
   unavailable. A permanent schema failure marks `failed`.

The default stale-claim timeout is 30 seconds. Integration tests set
`NEXUS_OUTBOX_CLAIM_TIMEOUT_MS=100` to exercise the crash window. Never set a low timeout in
production without accounting for duplicate publishing; consumers make duplicates safe.

Enterprise communication payloads are normalized from the committed communication row so a
supplier communication emits `supplierId` and a customer communication emits `customerId`, never
both. Enterprise change payloads carry the committed entity type/ID/version, changed fields and
the originating action revision/item/receipt key. The publisher never fabricates approval.

## Case and event intake

`POST /api/v1/cases` is the public event-driven intake. It requires a session, same-origin CSRF
check and the `operator` role. The server derives the actor from the session and the sandbox from
`nexus.active_sandbox`; neither is accepted from the request body. The body declares a title,
summary and one source:

- `text` with a bounded identity;
- `email` with a printable message ID, normalized to lower case;
- `document` with a document UUID. Before F15 no document store exists, so a document reference
  is rejected with `NOT_FOUND`; text and email ID-only events are valid.

`Idempotency-Key` is required. The key is scoped by sandbox, actor kind/ID and route. The
canonical request hash includes the normalized source. Within one transaction and advisory locks:

1. Resolve the active sandbox server-side.
2. Return the stored response when the same key and hash already exist; return `409
   IDEMPOTENCY_MISMATCH` when the same key or source identity has a different hash.
3. Return the original accepted case/event for the same normalized source identity even with a
   new key, so re-ingesting a forwarded email does not create a fresh business input.
4. Otherwise insert the `new` case, its audit event, `nexus.case.created.v1` outbox row and an
   ingress-key row with the accepted response.

The response is `202` with the case detail, event ID, event type, `queued: true` and
`deduplicated`. A duplicate never creates a second case, outbox row, inbox row or job.

## Inbox and dead letters

The consumer validates the envelope and inserts `nexus.event_inbox` with
`dispatch_state='pending'`, unique on `(consumer_name,event_id)`. A duplicate delivery is
acknowledged without a second row. The inbox row is the durable accepted queue: it stores the
validated envelope and a reference to the eventual workflow/action work that F11 will schedule.
No in-memory callback or reference to an uncreated F11 table is used.

Schema poison, unknown event names, wrong producer, wrong source exchange, oversized messages and
unknown sandboxes are not retried as business work:

1. insert a `nexus.dead_letters` row keyed by consumer and raw-body SHA-256, with a redacted
   reason and bounded metadata;
2. negative-acknowledge without requeue so the queue's dead-letter exchange moves the original
   message to `nexus.worker.events.dlq`.

A transient database/consumer failure closes the channel/connection and reconnects after the
retry schedule; the unacknowledged message returns to the queue. The consumer never acknowledges
before the inbox commit and never holds a delivery during AI/human work.

Explicit deviation from plan line 390: infrastructure redeliveries are not hard-capped at three.
A deterministic schema/handler rejection is not retried as business work and goes to the DLQ, but
a broker or database outage is retried with the capped `1s`/`5s`/`30s` schedule. Dead-lettering an
accepted event because the database was briefly unavailable would violate the F10 durability
acceptance and lose work. The delivery attempt count is therefore not persisted in the inbox; the
outbox/publisher attempt count remains persisted and visible.

Replay a dead letter only after correcting the cause and only through a controlled operator
procedure. Re-publish or requeue the original event ID; the inbox uniqueness makes replay
idempotent. Do not edit an inbox row into `pending` by hand without an audited runbook.

## Terminal case event and dependency wake (F11A)

F11A emits `nexus.case.completed.v1` only when the case reducer makes a real transition into a
terminal status (`resolved`, `escalated`, `cancelled`). The case status update, workflow journal
change in the same operation, audit row and outbox insert share one transaction. The payload is the
declared case-completed schema: terminal run ID, trigger event ID, terminal case version/status and
up to 100 outcome evidence IDs. The envelope carries the correlation. A repeated same-status update
emits nothing; a terminal case cannot be resurrected.

The worker's dependency coordinator consumes pending `case.completed` inbox rows. It validates the
event sandbox, child case, trigger generation and terminal version against the current case; only
an exact matching waiting dependency wakes. A resolved child queues the parent; an escalated or
cancelled child, or the 48-real-hour dependency expiry, escalates the parent and cancels its run.
Wrong child/version/sandbox or duplicate events are marked processed without a second job. The
dependency wake, parent job, inbox state and terminal parent event are transactional.

Case-completed events are not workflow root triggers; the workflow scheduler ignores them and the
dependency coordinator marks them processed after handling. Do not map them to a business
definition or create a second run from them.

## Runbook queries

```sql
SELECT status, count(*) FROM nexus.event_outbox GROUP BY status ORDER BY status;
SELECT event_type, count(*) FROM nexus.event_outbox
WHERE status IN ('pending', 'publishing', 'failed') GROUP BY event_type;
SELECT consumer_name, dispatch_state, count(*) FROM nexus.event_inbox
GROUP BY consumer_name, dispatch_state;
SELECT event_id, event_type, reason_code, created_at FROM nexus.dead_letters
ORDER BY created_at DESC LIMIT 50;
SELECT status, attempt_count, last_error, next_attempt_at, created_at
FROM enterprise.event_outbox WHERE status <> 'published' ORDER BY created_at;
```

A growing pending outbox while the broker is down is expected; delivery resumes when the worker
can reach the broker. A growing `failed` set is not expected and needs operator review. A growing
DLQ is a schema/producer incident, not a transient outage.

## Boundaries

F10 does not create workflows, schedules, approvals, proposals, model calls, business execution,
document storage, notifications, or automatic dead-letter replay. It does not expose an admin
replay endpoint. A2 command execution and A3 automatic case creation remain later stages.

# ADR 006: Durable transactional events and at-least-once delivery

- Status: accepted for F10 implementation
- Date: 2026-11-26
- Owners: F10 durable ingress/outbox/inbox

## Context

F07 and F08 created the private enterprise read model, command receipts and an enterprise
outbox, but no publisher, Nexus outbox, consumer inbox or dead-letter path existed. F10 must
deliver accepted cases and enterprise facts without losing them during a broker or process
outage, without duplicate business effects, and without holding a broker delivery open during
AI or human work.

The event envelope and registry were frozen in F03. F08 command correlation IDs are bounded
strings, and the F10 plan specifies a string correlation ID, so the envelope correlation field
was clarified to a bounded identifier. Event and causation IDs remain UUIDs.

## Decision

1. Use the transactional outbox pattern in both databases. A business transaction inserts the
   outbox row before commit. A background publisher claims due rows, publishes with publisher
   confirms, and marks them published after the confirm.
2. Accept at-least-once transport. A crash after confirm leaves the row publishing and it may be
   republished after a stale-claim timeout. Business safety comes from the consumer inbox unique
   `(consumer_name,event_id)` and from later workflow/action idempotency.
3. Use manual acknowledgement and prefetch 8. The consumer's only delivery-time work is envelope
   validation and a pending inbox insert. F11 will schedule durable workflow work from that row.
4. Route permanent validation failures to a durable dead-letter exchange/queue and insert a
   queryable, redacted `dead_letters` record keyed by the raw-body hash. Never retry poison as
   business work.
5. Retry transient publish/consumer infrastructure failures with `1s`, `5s`, `30s` and then a
   capped `30s`; keep the outbox row or unacknowledged message visible. Do not silently drop.
   This deliberately does not hard-cap infrastructure redeliveries at three: deterministic schema
   or handler failures go to the DLQ without business retry, while a broker/database outage must
   not dead-letter accepted work. This is an explicit deviation from plan line 390, documented in
   EVENTS.md and reviewed as a Low finding during F10.
6. Deduplicate HTTP intake by actor/sandbox/route and `Idempotency-Key`, and by normalized source
   identity per sandbox/route, storing the canonical request hash and the original response.
7. Keep the AI tool registry and the privileged command client outside the event transport. F10
   does not add a write tool or expose command execution.
8. Use a single local RabbitMQ user in this scaffold. Application code restricts each publisher
   to its exchange and event namespace and the consumer checks the source exchange/type/producer.
   Production must split setup and runtime credentials and grant per-exchange permissions; that
   remains an explicit hardening item.

## Consequences

- Every accepted case/event is durable before the HTTP 202 or command receipt returns.
- Duplicate delivery is safe but not invisible: inbox rows and metrics show duplicates.
- A broker outage delays delivery without losing the accepted work; the backlog is queryable.
- A schema bug produces a DLQ record and an operator-visible failure, not an infinite retry loop.
- The local broker ACL is weaker than the production target. This is documented rather than
  hidden; F10 acceptance is for local behavior, not production credential separation.
- Transient infrastructure redelivery is unbounded by delivery count but bounded by the capped
  retry delay. This preserves accepted work during an outage and is an explicit plan deviation.
- Later stages add handlers and workflow scheduling by reading pending inbox rows; they must not
  change the transport contract or create a parallel event path.

## Rejected alternatives

- Publish directly from the HTTP request: loses events on crash and couples latency to the broker.
- In-memory retry queue or callback: loses accepted work on restart and violates the plan.
- Auto-ack before inbox commit: can lose an event.
- Infinite retry of schema poison: blocks the queue and hides a producer bug.
- Reusing the F09 read/command tool boundary for event writes: violates the action/approval boundary.

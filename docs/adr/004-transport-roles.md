# Architecture Decision Record 004: Transport Roles and Ephemeral Cache

## Status

Accepted as the fixed transport decision of the implementation plan. F02 implements the
local RabbitMQ and Valkey infrastructure, persistence settings, and health/lifecycle
checks; outbox/inbox code arrives with its owning stages.

## Context

NEXUS needs durable event delivery, a workflow journal that survives process restarts,
and fast ephemeral rate/cache state. Using a cache as an event store or business source
of truth would lose approvals or allow cache failures to grant permissions. The broker
must be durable enough for local persistence tests but is not an HA deployment.

## Decision

- Use RabbitMQ 4.4.1 as the durable broker, pinned by image digest. Use a named volume,
  a stable container hostname, readiness diagnostics, and the `/nexus` vhost. The
  `/nexus` vhost is created by `RABBITMQ_DEFAULT_VHOST`; the definitions file is mounted
  at `/opt/nexus/definitions.json` and applied explicitly by setup after readiness.
- Persist broker state across container restarts. Durable queues and persistent messages
  must survive a broker restart; publisher confirms and consumer acknowledgements are
  required when messaging code is introduced.
- PostgreSQL remains the workflow/execution journal. RabbitMQ is delivery/wakeup, not the
  authoritative workflow state store. Outbox/inbox and dead-letter behavior belong to the
  phases that introduce them.
- Use Valkey 9.2.0 as ephemeral cache/rate-limit state, pinned by image digest, with
  authentication, no AOF, no snapshots, and no-eviction policy. It is never a source of
  business truth.
- Flushing Valkey must not lose PostgreSQL data. Cache loss may make admission fail
  closed in later phases but cannot grant permissions or remove business state.
- Publish no broker/cache host ports by default. Explicit development overrides bind to
  loopback; test projects use random loopback ports and separate labeled resources.
- Keep single-node RabbitMQ and Valkey. Do not claim HA, clustering, or production
  operations.

## Consequences

- F02 tests restart the broker and verify a persistent message, then flush Valkey and
  verify PostgreSQL data remains.
- Migration tooling uses a temporary PostgreSQL-only loopback port and restores the
  default no-host-port project after both schemas are migrated, so `db:migrate` does not
  leave development ports published.
- Later messaging code must use durable queues, persistent messages, confirms, and
  idempotent inbox handling; F02 does not create outbox/inbox tables.
- Operators must not treat a broker restart as delivery success or a cache flush as data
  loss. The database remains authoritative.
- Test runs own a distinct Compose project and remove only its labeled containers and
  volumes. Developer volumes are never part of teardown.
- Broker/cache credentials are generated locally and ignored. They must not appear in
  logs, examples, prompts, or tool arguments.

## Alternatives considered

- Redis as both queue and cache: rejected because it duplicates broker responsibilities
  and makes cache loss a workflow risk.
- Broker as workflow state: rejected because human waits, leases, approvals, and evidence
  need a transactional database journal.
- Persisting Valkey as business storage: rejected because it is intentionally ephemeral
  and cannot provide the required authority or durability.
- Multi-node broker/cache for local F02: rejected as out of scope and not required to
  prove the transport roles.

## Sources

- [NEXUS implementation plan](../../NEXUS_IMPLEMENTATION_PLAN_final.md) sections 2.3, 2.4,
  5, 7.4, F02, and 10.
- [Operations guide](../OPERATIONS.md).

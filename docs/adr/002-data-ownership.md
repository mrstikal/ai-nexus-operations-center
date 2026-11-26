# Architecture Decision Record 002: Data Ownership and Migration Boundaries

## Status

Accepted as the fixed data decision of the implementation plan. F02 implements the
schemas, roles, privilege boundaries, and migration tooling; business tables begin with
their owning stages.

## Context

NEXUS needs durable business state with strong command/idempotency semantics while the
enterprise simulator must remain a separate access boundary. The same local PostgreSQL
instance must share a real database clock for the absent-final protocol, but application
code must not bypass REST by reading the other schema. Runtime credentials must not be
able to create schema objects or assume migration credentials.

## Decision

- Use PostgreSQL 18.7 with a pinned pgvector 0.8.7 extension built from a hash-verified
  source archive into the PostgreSQL image.
- Use Drizzle with node-postgres and reviewed, monotonically numbered SQL migrations.
  Do not use ORM schema push.
- Keep the `nexus` and `enterprise` schemas in one physical database with separate owner
  roles: `nexus_migrator` and `enterprise_migrator`.
- Runtime roles are `nexus_api`, `nexus_worker`, and `enterprise_app`. They receive
  schema usage only; table and sequence grants are added explicitly by the owning module
  migration.
- Revoke `PUBLIC` create/temp privileges and `public` schema creation. No runtime role is
  a member of a migration role. No runtime role can read the other schema.
- Keep migration credentials in local tooling only. Runtime application environments do
  not receive them. Runtime connection variables are role-specific: the API uses
  `NEXUS_API_DB_*`, the worker uses `NEXUS_WORKER_DB_*`, and the simulator uses
  `ENTERPRISE_APP_DB_*`; host/port/name are supplied by the corresponding environment.
- Use a per-schema `schema_migrations` ledger with version, SHA-256 checksum, and
  database-clock application time. Apply each migration and its ledger insert in one
  transaction under an advisory lock. The generic runner is mirrored in both schema
  packages, and the F02 suite enforces byte identity so the copies cannot silently
  diverge.
- F02 migration 0001 creates only `infrastructure_metadata`; business tables and the
  outbox remain for their owning stages.

## Consequences

- Every business module migration must explicitly grant the tables and sequences its
  runtime roles need; broad default privileges are not used.
- Editing an applied migration fails the checksum check. Schema changes require a new
  migration.
- A failed migration stops setup and rolls back its partial effects.
- The same physical instance and clock remain available for future cross-schema
  protocols, but cross-schema SQL access stays denied.
- Local credentials are generated and ignored. Losing `.env` while volumes remain is an
  error, not a reason to rotate roles silently.
- Splitting the schemas into different servers or clocks would require a new architecture
  decision; F02 does not do that.
- F02 does not provide backups, HA, deployment, or business seed data.

## Alternatives considered

- ORM push or framework auto-migrations: rejected because reviewed SQL and explicit
  transaction/ledger behavior are required.
- Separate database servers for nexus and enterprise: rejected because the future
  absent-final protocol depends on the shared real database clock.
- A single runtime superuser or shared migration role: rejected because it would remove
  the least-privilege and cross-schema boundaries.
- Default table grants in every schema: rejected because modules must grant their own
  tables explicitly.

## Sources

- [NEXUS implementation plan](../../NEXUS_IMPLEMENTATION_PLAN_final.md) sections 2.3, 2.4,
  3.2, 7.4, F02, and 10.
- [Operations guide](../OPERATIONS.md).

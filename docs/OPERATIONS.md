# NEXUS Operations Guide

This guide covers the F02 local infrastructure: PostgreSQL with pgvector, RabbitMQ, and
Valkey, plus the schema/role bootstrap and reviewed migration runner. It does not
describe deployment, high availability, or business modules that have not been
implemented.

## Prerequisites

- Docker Engine and Docker Compose with a running daemon. F02 was verified with Engine
  29.9.3 and Compose 5.7.1.
- Node.js 26.13.1 and pnpm 12.23.0 as described in `docs/DEVELOPMENT.md`.
- Loopback development ports `55432`, `55672`, `55673`, and `56379` must be free when
  using `--dev-ports`. `pnpm db:migrate` uses its own temporary random PostgreSQL port.

The default infrastructure publishes no host ports. Only explicit development or test
overrides bind to `127.0.0.1`.

## First start and migration

```bash
pnpm infra:up
pnpm db:migrate
```

`pnpm infra:up` creates an ignored `.env` with random local credentials when it does not
exist, starts the `infra` Compose profile, applies the role/schema bootstrap, imports the
RabbitMQ definitions, and checks service readiness. The definitions file is mounted
read-only at `/opt/nexus/definitions.json` as the explicit import input; it is not
auto-loaded at startup. It does not delete data or volumes.

`pnpm db:migrate` starts the same project with a temporary PostgreSQL-only loopback
port, applies the role/schema bootstrap again, applies every reviewed SQL migration in
order for both schemas, removes the temporary host port by restoring the default
no-port project, and never uses ORM push. If you previously enabled `--dev-ports`, this
restore removes those bindings; rerun `pnpm infra:up --dev-ports` afterward when host-run
applications or tools need them.

`pnpm demo:init` performs the same migration path and restores the default no-port
project. F02 has no seed registrations and no replay assets, so those parts are not run
yet.

To publish explicit development ports for host-run applications or inspection:

```bash
pnpm infra:up --dev-ports
```

## Health checks

```bash
docker compose --project-name nexus --profile infra ps
docker compose --project-name nexus --profile infra exec -T postgres \
  psql -U postgres -d nexus -tAc "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
docker compose --project-name nexus --profile infra exec -T rabbitmq \
  rabbitmq-diagnostics -q check_running
docker compose --project-name nexus --profile infra exec -T valkey \
  sh -c 'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" ping'
```

Expected values are PostgreSQL 18.7, pgvector `0.8.7`, RabbitMQ readiness, and Valkey
`PONG`. `pnpm infra:up` performs equivalent checks and fails with an actionable message
when a service is unhealthy.

## Schemas, roles, and grants

Nexus and enterprise are isolated schemas in the same PostgreSQL instance. Their
migration roles own the schemas; runtime roles receive only schema usage. No role is a
member of another role.

| Role | Schema | Allowed | Not allowed |
|---|---|---|---|
| `nexus_migrator` | `nexus` | Own schema, DDL, migration ledger | Enterprise schema |
| `nexus_api` | `nexus` | Connect, use schema, future explicit table grants | Create tables/schemas, read enterprise, assume migrator |
| `nexus_worker` | `nexus` | Connect, use schema, future explicit table grants | Create tables/schemas, read enterprise, assume migrator |
| `enterprise_migrator` | `enterprise` | Own schema, DDL, migration ledger | Nexus schema |
| `enterprise_app` | `enterprise` | Connect, use schema, future explicit table grants | Create tables/schemas, read nexus, assume migrator |

`PUBLIC` create/temp privileges are revoked. `public` schema creation is revoked.
Migration credentials are used only by migration tooling; they are never placed in
runtime application environment variables. Future module migrations must grant new
tables and sequences explicitly.

## Credentials and environment

`.env` is ignored by Git and generated with mode `0600`. `.env.example` contains only
placeholders and must never receive real values. Credentials are not printed by the
tools; command failures are redacted against the loaded values.

Runtime connection variables are separate from the Compose role-bootstrap passwords:

| Runtime | Host/port/database | User/password |
|---|---|---|
| Nexus API | `NEXUS_DB_HOST`, `NEXUS_DB_PORT`, `NEXUS_DB_NAME` | `NEXUS_API_DB_USER`, `NEXUS_API_DB_PASSWORD` |
| Nexus worker | `NEXUS_DB_HOST`, `NEXUS_DB_PORT`, `NEXUS_DB_NAME` | `NEXUS_WORKER_DB_USER`, `NEXUS_WORKER_DB_PASSWORD` |
| Enterprise simulator | `ENTERPRISE_DB_HOST`, `ENTERPRISE_DB_PORT`, `ENTERPRISE_DB_NAME` | `ENTERPRISE_APP_DB_USER`, `ENTERPRISE_APP_DB_PASSWORD` |

The generated development values point at `127.0.0.1:55432`. Host-run applications need
`pnpm infra:up --dev-ports` before connecting; containerized applications in later phases
will use service hostnames instead. The connection factories start a pool with
`search_path=nexus,pg_catalog` or `search_path=enterprise,pg_catalog` and an explicit
`application_name`.

An existing `.env` from the earlier F02 setup is backfilled with the derived runtime
host/port/name and `*_DB_*` aliases when they are absent; derived passwords are copied
from the existing role-bootstrap passwords without printing values. A `.env` that cannot
be backfilled fails validation with the missing key names.

If infrastructure volumes exist but `.env` is missing, the tool refuses to generate new
passwords because they would not match the existing roles/database. Restore the original
`.env`. Do not delete volumes to work around a credential mismatch unless the data is
expendable and that action is explicitly intended.

## Migration semantics

- Nexus files live in `packages/db/migrations/`; enterprise files live in
  `packages/enterprise-db/migrations/`.
- Filenames are `NNNN_lowercase_name.sql`. A `.sql` file with any other name is rejected
  and stops the run; it is never silently ignored. Versions must be unique and apply in
  numeric order.
- Each schema has a `schema_migrations` ledger containing the version, SHA-256 checksum,
  and database-clock application time.
- A repeated run applies zero migrations. Editing an already applied migration fails the
  checksum check; add a new migration instead.
- Each migration and its ledger insert run in one transaction. A failing migration stops
  the run and rolls back its partial effects; later migrations do not run.
- Migration 0001 creates only infrastructure metadata tables. F02 adds no business
  tables and no application outbox.

## Test resource ownership and cleanup

`pnpm test:integration F02` builds the workspace, starts a separate Compose project named
`nexus-test-f02-<random>`, publishes random loopback ports, applies roles and
definitions, runs the tests, and tears down that project with its own volumes. The runner
verifies the project name and `nexus.owner=test` labels before removal.

The developer project is named `nexus` with volumes `nexus_postgres_data`,
`nexus_rabbitmq_data`, and `nexus_valkey_data`. Test cleanup cannot touch those volumes.
If a test run is interrupted, use the project name printed by the runner in:

```bash
docker compose --project-name <printed-test-project> --profile infra down --volumes
```

Never use `down --volumes` against the `nexus` developer project as routine cleanup.

## Troubleshooting

- **Docker unavailable:** start the daemon and rerun; the tool fails before changing data.
- **Port already in use:** stop the conflicting local service or change the `NEXUS_*_DEV_PORT`
  values in `.env`; the ports are bound to loopback only.
- **Placeholder credentials:** if no `nexus_*` volumes exist, remove the placeholder
  `.env` and rerun `pnpm infra:up`; never copy real secrets into `.env.example`. If
  volumes exist, restore the original `.env` instead of regenerating credentials.
- **Role or schema mismatch:** rerun `pnpm infra:up`; the idempotent bootstrap updates
  role passwords and ownership and asserts pgvector `0.8.7`.
- **Broker or cache data questions:** RabbitMQ messages marked persistent and durable
  queues survive a broker restart; Valkey is ephemeral and a flush must not affect
  PostgreSQL. F02 tests cover both.

## Durable event transport (F10)

F10 starts two background publishers (Nexus outbox in the worker, enterprise outbox in the
private simulator) and one worker consumer. They are optional when their database or broker
environment is absent; the health/API processes still start. When `NEXUS_RABBIT_PASSWORD` (or the
local `RABBITMQ_DEFAULT_PASS` fallback) and the worker database credentials are present, the
worker connects, declares the topology described in [EVENTS.md](EVENTS.md), and consumes
`nexus.worker.events` with prefetch 8.

Operational signals:

- Pending Nexus outbox growth during a broker outage is expected and is not data loss.
- `nexus.event_outbox.status='failed'` or a growing `nexus.dead_letters` needs operator review.
- `nexus.event_inbox.dispatch_state='pending'` is the durable accepted queue; F11 will schedule
  the pending rows. Do not delete them.
- The local broker uses one identity for setup and runtime. Production must separate those
  credentials and grant per-exchange permissions; see the F10 limitation in EVENTS.md and
  ADR 006.

The integration runner owns the isolated test project and tears down RabbitMQ, Valkey and
PostgreSQL after the suite. Do not run `down --volumes` against the developer project.

## F02 boundaries

- No application, API, worker, web, or simulator container is started by `infra:up`; those
  arrive in later phases.
- No business tables, seeds, outbox/inbox, migrations beyond infrastructure metadata, or
  backup automation are provided.
- RabbitMQ is a single local node, not an HA claim. Valkey is not a source of business
  truth. No model, external font, telemetry endpoint, or paid service is contacted.

# NEXUS Development Guide

## Runtime prerequisites

- Node.js 26.13.1, pinned in `.node-version` and `.nvmrc`.
- pnpm 12.23.0, pinned by `packageManager` in `package.json`.

Switch Node with nvm before installing or running any workspace command:

```bash
nvm install 26.13.1
nvm use 26.13.1
```

If pnpm 12.23.0 is not already available, install it globally for the selected Node:

```bash
npm install -g pnpm@12.23.0
```

The repository uses strict engine checks. Commands fail on another Node or pnpm major.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm verify:phase F01
```

`pnpm verify:phase F01` runs formatting, ESLint, dependency boundaries, typecheck,
build, cumulative unit tests, the phase integration suite, the phase E2E suite, and
the registered artifact assertions. It stops at the first failing step and returns
that step's exit code.

The Playwright browser is installed once per machine, not by `pnpm install`:

```bash
pnpm exec playwright install chromium
```

## Individual commands

| Command | Purpose |
|---|---|
| `pnpm lint` | Format check, ESLint, and `tools/check-boundaries.mjs` |
| `pnpm typecheck` | Root tests/tools plus every workspace package |
| `pnpm build` | Compile API and worker with `tsc`; build the Next application |
| `pnpm test:unit` | Vitest unit project |
| `pnpm test:integration F01` | Exact registered integration suites for the selected phase |
| `pnpm test:e2e F01` | Exact registered Playwright suites for the selected phase |
| `pnpm verify:phase F01` | Full phase gate for the selected phase or range |
| `pnpm docs:check` | Local documentation links, required files, plan/manifest order |
| `pnpm licenses:check` | Installed license inventory and direct-dependency notices |
| `pnpm dev` | Foreground API, worker, and web development processes |

Phase selectors accept exact IDs such as `F11A` or manifest-order ranges such as
`F01-F03`. One optional leading `--` is accepted, for example
`pnpm verify:phase -- F01`. Unknown IDs, empty selectors, missing test files, and
unregistered future dependencies fail closed.

`tools/phase-checks.json` is the single ordered phase manifest. Register a real test
path or artifact assertion in the owning phase; an empty selector never passes.

## Local runtime behavior

- The API listens on `127.0.0.1`; F01 uses `PORT=3001` by default and `PORT=0` for
  an ephemeral integration-test port.
- The worker is a Nest application context without an HTTP listener.
- The web application renders the F01 shell on port 3000 in development. The E2E
  runner allocates a free loopback port at startup and passes it to the Playwright
  web server; `NEXUS_E2E_PORT` overrides the allocation for a controlled local run.
  The fixed workspace decision is recorded in [ADR 001](adr/001-workspace.md), and the
  canonical stage contract is [the final implementation plan](../NEXUS_IMPLEMENTATION_PLAN_final.md).
- F01 tests use only loopback connections. Next telemetry is disabled in build,
  development, start, and E2E commands.
- No model, font CDN, telemetry collector, database, broker, or cache connection is
  made in F01.

## Local infrastructure

F02 adds PostgreSQL 18.7 with pgvector 0.8.7, RabbitMQ 4.4.1, and Valkey 9.2.0.
`pnpm infra:up` starts them without host ports; `pnpm infra:up --dev-ports` publishes
explicit loopback development ports; `pnpm db:migrate` applies both reviewed migration
sets through a temporary PostgreSQL-only loopback port and restores the no-port default;
`pnpm demo:init` performs the initial idempotent initialization. See the
[operations guide](OPERATIONS.md) for roles, health checks, credentials, migration
semantics, and test-resource cleanup.

## Commands reserved for later phases

`pnpm demo:reset`, `pnpm eval:offline`, `pnpm retrieval:check`, and `pnpm eval:live` are
registered entry points. Until their owning phase is implemented they exit non-zero with
the owner stage named. In particular, `eval:live` never pretends to succeed and never
starts a paid call.

`pnpm audit --prod` is an explicit advisory-metadata network check for maintenance;
it is not part of the network-isolated replay test path.

## Test layers

- `tests/unit/` contains pure Vitest tests. F01 covers the phase runner, manifest
  selection, failure propagation, and dependency boundary fixtures.
- `tests/integration/` starts isolated Compose resources for infrastructure phases.
  F01 launches the compiled Nest API and worker; F02 verifies the database roles,
  migrations, broker persistence, and cache/database separation. The integration runner
  builds the workspace before starting tests.
- `tests/e2e/` contains Playwright tests against the production-built Next server.
- `tests/fixtures/` contains intentionally invalid boundary and phase manifests used
  to prove that gates fail closed. These fixtures are excluded from lint and typecheck.

Test resources use only ephemeral loopback ports and the process runner's own child
processes. Infrastructure isolation and Compose resources begin in F02.

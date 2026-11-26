# Architecture Decision Record 001: TypeScript Workspace and Verification Harness

## Status

Accepted as the fixed workspace decision of the implementation plan; implemented in F01.

## Context

NEXUS needs one reproducible TypeScript workspace for a Next.js web application, a
NestJS API and worker, and later shared contracts, domain, persistence, AI, integration,
messaging, observability, and UI packages. Server code must run as compiled JavaScript
with explicit Nest dependency injection, not through a test-only TypeScript transform.
Verification must fail closed for unknown phases, empty selections, missing suites, and
dependency-direction violations.

## Decision

- Use a pnpm workspace with exact direct dependency versions and one committed
  `pnpm-lock.yaml`.
- Use Node.js 26.13.1 and pnpm 12.23.0, enforced by `.node-version`, `.nvmrc`,
  `packageManager`, and strict engine checks.
- Use ESM with TypeScript `module` and `moduleResolution` set to `NodeNext` for
  server and shared packages. Server imports use explicit emitted `.js` paths.
- Build API and worker with the TypeScript compiler. Nest dependencies use explicit
  injection tokens and factory providers; the build does not depend on inferred
  decorator metadata.
- Use Next.js App Router for the web application with server assets and a system font
  stack. F01 renders only a minimal shell.
- Use one ordered `tools/phase-checks.json` manifest for stage order, dependencies,
  test paths, and artifact assertions. `tools/run-phase.mjs` implements the documented
  phase/range and failure-propagation contract.
- Use `tools/check-boundaries.mjs` as the dependency-direction gate. The rule set is
  defined in code and exercised by valid and invalid workspace fixtures.
- Use Vitest for unit and integration suites and Playwright for browser E2E suites.
- Allocate a free loopback port for each Playwright E2E run by binding port 0 in the
  wrapper, then pass the assigned port to both the Playwright base URL and the Next
  web-server environment. `NEXUS_E2E_PORT` is an explicit local override.
- Keep build output, test reports, local environment files, and Playwright artifacts
  out of Git.

## Consequences

- Contributors must switch to Node 26.13.1 before install, build, or test; strict
  engine checks intentionally reject the planning-time Node 22 runtime.
- Server integration tests exercise the same compiled JavaScript that the future
  container runtime will launch.
- Adding a phase requires a manifest entry with real checks; selecting an unimplemented
  phase fails instead of passing with zero tests.
- F01 owns the command entry points but not later infrastructure. Commands whose owning
  phase is not implemented fail closed with an explicit owner-stage message.
- Playwright browsers are installed separately from dependency installation and must be
  present before E2E verification.
- Concurrent E2E runs do not share a fixed web-server port; the wrapper allocates a free
  loopback port and the config receives the same value for its base URL and web server.
- OpenAPI generation and drift verification belong to F03; F01 only reserves the
  `docs:check` hook and does not claim generated-contract coverage.

## Alternatives considered

- npm or Yarn workspaces: rejected by the fixed plan decision; pnpm provides the exact
  lockfile and workspace filtering used by the phase commands.
- Running Nest through ts-node, tsx, SWC, or Vitest transforms: rejected because the
  production build and integration evidence must use the TypeScript compiler output.
- A hand-maintained list of phase checks outside the repository: rejected because the
  single manifest must drive selection, dependencies, and artifact assertions.
- Generic glob-based test selection: rejected because `f13*`-style globs would conflate
  F13, F13A, and F13B and could silently select future suites.

## Sources

- [NEXUS implementation plan](../../NEXUS_IMPLEMENTATION_PLAN_final.md) sections 2.2, 2.3, 7.4,
  9.0, F01, and 10. Section 7.4 is the source for isolated test resources and random
  loopback ports.
- The same plan's ADR 001 and verified technology baseline.

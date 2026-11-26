# Third-Party Notices

This file covers the direct third-party dependencies and pinned infrastructure
components of the NEXUS workspace. It does not relicense third-party software. Full
license texts are installed with each package under `node_modules` and must be preserved
in any distribution.

Original project source is licensed under the MIT License in `LICENSE`.

## Runtime dependencies

| Package | Version | License |
|---|---|---|
| `@nestjs/common` | 12.6.2 | MIT |
| `@nestjs/core` | 12.6.2 | MIT |
| `@nestjs/platform-express` | 12.6.2 | MIT |
| `next` | 16.4.6 | MIT |
| `pg` | 8.23.1 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `reflect-metadata` | 0.2.2 | Apache-2.0 |
| `rxjs` | 7.8.2 | Apache-2.0 |
| `zod` | 4.6.7 | MIT |

## Development dependencies

| Package | Version | License |
|---|---|---|
| `@asteasolutions/zod-to-openapi` | 9.1.0 | MIT |
| `@eslint/js` | 10.0.1 | MIT |
| `@nestjs/cli` | 12.0.15 | MIT |
| `@playwright/test` | 1.65.1 | Apache-2.0 |
| `@types/node` | 26.6.11 | MIT |
| `@types/pg` | 8.23.1 | MIT |
| `@types/redis-errors` | 1.2.3 | MIT |
| `@types/react` | 19.3.3 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `amqplib` | 2.4.2 | MIT |
| `eslint` | 10.15.0 | MIT |
| `ioredis` | 6.1.0 | MIT |
| `pg` | 8.23.1 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |
| `typescript-eslint` | 8.74.0 | MIT |
| `vite` | 8.3.8 | MIT |
| `vitest` | 5.1.2 | MIT |

## Transitive dependencies

Transitive package versions are resolved by `pnpm-lock.yaml`. `pnpm licenses:check`
inventories the installed package graph and rejects unknown or unapproved license
expressions. It also parses the direct-dependency rows above and verifies the exact
recorded version and license against the installed direct dependency and the installed
graph.

Notable transitive binary dependencies installed through Next.js image support:

| Package | Version | License |
|---|---|---|
| `@img/sharp-linux-x64` | 0.35.5 | Apache-2.0 |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later |

The libvips shared library and its notices are installed in the package tree. Any
distribution must preserve its license text and the relinking/replacement rights
required by the LGPL. This project does not relicense those binaries.

## Container images

Pinned by tag plus digest in `infra/versions.json`; PostgreSQL and pgvector are built
from pinned sources.

| Component | Version | License | Pin |
|---|---|---|---|
| `postgres:18.7-bookworm` | 18.7 | PostgreSQL | sha256:e742a2668255221388004f3a42b6150a2103f5054ab3a4a93ae9e4f01e551c35 |
| pgvector | 0.8.7 | PostgreSQL | sha256:cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85 |
| `rabbitmq:4.4.1-management` | 4.4.1 | MPL-2.0 | sha256:1c70aa901955dff9c3c86975cf77a9498a6e3448336a2e049dde888b44f9b977 |
| `valkey/valkey:9.2.0` | 9.2.0 | BSD-3-Clause | sha256:1c2b25b09f354c66fe994733acdf12fcfd4bdf6f3bd92b88a93a70378d884056 |

The base distribution also contains operating-system libraries and notices. The full
container and binary inventory, including their distribution obligations, is expanded
by the supply-chain gate in F48B.

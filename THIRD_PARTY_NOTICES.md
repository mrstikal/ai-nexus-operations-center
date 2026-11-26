# Third-Party Notices

This file covers the direct third-party dependencies of the NEXUS workspace in F01.
It does not relicense third-party software. Full license texts are installed with
each package under `node_modules` and must be preserved in any distribution.

Original project source is licensed under the MIT License in `LICENSE`.

## Runtime dependencies

| Package | Version | License |
|---|---|---|
| `@nestjs/common` | 12.6.2 | MIT |
| `@nestjs/core` | 12.6.2 | MIT |
| `@nestjs/platform-express` | 12.6.2 | MIT |
| `next` | 16.4.6 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `reflect-metadata` | 0.2.2 | Apache-2.0 |
| `rxjs` | 7.8.2 | Apache-2.0 |

## Development dependencies

| Package | Version | License |
|---|---|---|
| `@eslint/js` | 10.0.1 | MIT |
| `@nestjs/cli` | 12.0.15 | MIT |
| `@playwright/test` | 1.65.1 | Apache-2.0 |
| `@types/node` | 26.6.11 | MIT |
| `@types/react` | 19.3.3 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `eslint` | 10.15.0 | MIT |
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

No container images are declared in F01. Image notices and digests are added by the
stage that introduces each image.

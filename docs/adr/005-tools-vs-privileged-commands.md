# Architecture Decision Record 005: AI Tools versus Privileged Enterprise Commands

## Status

Accepted as the F08 boundary decision; implemented in F08. Later executor, approval and recovery
stages extend it without widening model access.

## Context

The product needs two different capabilities against the enterprise simulator:

- read and computation tools that an AI workflow can call with bounded arguments and results;
- privileged business commands that change purchase orders, stock aggregates or simulated
  communications only after the application has verified human authority.

Treating both as one tool registry would let a model select prices, suppliers, recipients,
approval state or side effects. Exposing the command route to the browser or Nexus API directly
would bypass the executor's approval, idempotency and recovery checks.

## Decision

- F07 read tools remain bounded, exact and read-only. F09 owns the typed client and registry.
- F08 adds private `POST /v1/commands/:kind` and `GET /v1/command-receipts/:idempotencyKey`
  routes guarded by a separate command token. The read token cannot call them and the command
  token cannot call read routes.
- A command body is the accepted constant-payload transport envelope: opaque sandbox, revision,
  item, plan/item hashes, sorted base versions, payload template, prior receipt keys and bounded
  transport deadlines. The simulator derives the composite receipt key and recalculates the item
  hash; hashes and deadlines are not authorization.
- The simulator re-reads authoritative sandbox, supplier, product, agreement, source-order and
  recipient facts, locks the sandbox command scope and changed rows in a stable order, and writes
  the business mutation, receipt, base versions, before/after entity changes and origin-tagged
  outbox rows in one transaction.
- A same-business receipt returns unchanged even when the transport deadline or proof order is
  renewed. A changed business identity or plan hash is a conflict, never a second effect.
- The command token goes only to the private operator/test caller in F08 and to the application
  executor in F13A. It never enters a model tool schema, browser code, prompt, trace or log.
- There is no generic SQL, URL, filesystem, shell, email-send or raw ERP-write tool. No actual
  email or external procurement occurs in F08.

## Consequences

- F08 can prove transport, receipt and supply-mutation safety without implementing application
  approval or an executor.
- F13A must add preflight, whole-plan approval binding and per-item execution on top of this
  transport; F13B must add uncertain-outcome and partial-effect recovery. A receipt is not an
  approval.
- F09 can build read/compute/propose tools against F07/F08 facts without ever receiving the
  command token.
- Any future command kind requires an explicit contract, authorizing stage and simulator handler;
  it does not become available merely by adding a tool name or a payload schema.

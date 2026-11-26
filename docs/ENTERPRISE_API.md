# NEXUS Enterprise Simulator API (F07-F08)

Status: F07 exposes read-only purchase-order, inventory, affected-order and supplier-alternative
facts. F08 adds the private command transport, purchase-order creation, simulated supplier
messages, command receipts and an origin-tagged enterprise outbox. It does not implement the
application executor, approvals, automatic publishing, goods receipts, invoices, returns,
customer addresses or financial effects; those arrive in later stages.

## Runtime boundary

- Service entry: `apps/enterprise-sim/dist/main.js`.
- The service connects only with `enterprise_app` credentials to the enterprise schema.
- It does not receive Nexus database credentials and never reads the `nexus` schema.
- It is private to the local deployment. There is no public browser route or CORS configuration.
- F07 read routes need only `SELECT`. F08 grants `enterprise_app` scoped INSERT/UPDATE on
  purchase orders, purchase-order lines, inventory versions, communication rows, receipts, entity
  changes and the enterprise outbox. It has no DELETE and no write access to suppliers, products,
  customers or agreements.
- A created purchase order changes confirmed inbound and aggregate row versions, never on-hand
  stock. A message is recorded as simulated; no email or external procurement is sent.
- `nexus_api` and `nexus_worker` cannot read or write any enterprise supply/sales table.

Start it locally after `pnpm build`, `pnpm demo:init` and `pnpm infra:up --dev-ports`
(`demo:init` restores the no-host-port default):

```sh
ENTERPRISE_DB_HOST=127.0.0.1 \
ENTERPRISE_DB_PORT=55432 \
ENTERPRISE_DB_NAME=nexus \
ENTERPRISE_APP_DB_USER=enterprise_app \
ENTERPRISE_APP_DB_PASSWORD=... \
ENTERPRISE_SIM_READ_TOKEN=... \
ENTERPRISE_SIM_COMMAND_TOKEN=... \
PORT=3002 \
pnpm --filter @nexus/enterprise-sim start
```

The process prints `ENTERPRISE_SIM_READY port=<port>` after the database-backed guards are
ready. `ENTERPRISE_SIM_READ_TOKEN` and `ENTERPRISE_SIM_COMMAND_TOKEN` must each contain at least
32 characters and must be different; the service fails closed when either is absent.

## Required request headers

| Header | Required | Meaning |
|---|---|---|
| `Authorization` | yes | `Bearer <ENTERPRISE_SIM_READ_TOKEN>` on read routes; `Bearer <ENTERPRISE_SIM_COMMAND_TOKEN>` on command/receipt routes |
| `X-Nexus-Sandbox-Id` | yes | Exact enterprise sandbox UUID |
| `X-Correlation-Id` | yes | 1-128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$` |

The guards check the expected token in constant time, validate the sandbox UUID and correlation
ID, then load the sandbox business clock. The read token cannot call command routes and the
command token cannot call read routes. A malformed header is `VALIDATION_FAILED` (400), a bad or
missing token is `UNAUTHENTICATED` (401), and an unknown sandbox is `NOT_FOUND` (404). A retired
sandbox remains readable because it is frozen history. A new command mutation rejects a retired
sandbox with `STALE_STATE` (409), while a same-key receipt replay and receipt lookup remain
available so an already committed effect stays reconcilable.

Unmatched routes return `NOT_FOUND` through the same problem format. Successful responses
include:

- `sandboxId`: the exact sandbox UUID;
- `businessEffectiveAt`: the sandbox clock, not the wall clock.

`Cache-Control: no-store` is set on every read route.

## Error format

Errors use the shared problem shape and the `application/problem+json; charset=utf-8` media
type. Every error response also sets `Cache-Control: no-store`:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Invalid request",
  "requestId": "f07-...",
  "issues": [{ "path": ["productIds"], "message": "Expected a UUID" }]
}
```

`requestId` echoes a valid `X-Correlation-Id` or is `unavailable` when the header is missing.
The service maps storage or response-shape failures to `DEPENDENCY_UNAVAILABLE` (503) rather
than returning partial facts.

## Read routes

All product lists are bounded to 20 unique UUIDs. Quantities, horizon and money values are
bounded by the database checks and the request schemas. Query parameters use exact identifiers;
there is no name search or fuzzy matching.

### `GET /v1/purchase-orders/:identifier`

The identifier may be the purchase-order UUID, the exact internal reference, or the exact
supplier-provided reference. The response contains **all exact candidates** in
`purchaseOrders`; the caller must not choose one silently. If no row matches, the route returns
`NOT_FOUND`. If more than ten exact candidates match, it returns `CONFLICT` instead of
truncating.

Each purchase order contains supplier identity/version, status, `version`, ordered/expected
times, payment and delivery terms, and lines. Each line contains product identity/version,
ordered/received/unreceived quantities, unit price, currency, original confirmed arrival time,
line version and timestamps. `expectedAt` and `confirmedArrivalAt` are the original ERP
expectation; a later supplier message is a separate fact source in the workflow.

Example:

```http
GET /v1/purchase-orders/PO-2026-1001
```

```json
{
  "sandboxId": "00000000-0000-4000-8000-000000000001",
  "businessEffectiveAt": "2026-11-02T09:00:00.000Z",
  "purchaseOrders": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "reference": "PO-2026-1001",
      "supplierReference": "BC-4417",
      "status": "delayed",
      "version": 5,
      "orderedAt": "2026-10-20T08:00:00.000Z",
      "expectedAt": "2026-11-06T17:00:00.000Z",
      "paymentTerms": "Net 30",
      "deliveryTerms": "DAP Rotterdam",
      "supplier": { "id": "...", "reference": "SUP-BALTIC", "status": "active", "version": 6 },
      "lines": [
        {
          "lineNumber": 1,
          "product": { "id": "...", "sku": "NS-MON-27-A1", "status": "active" },
          "orderedQuantity": 120,
          "receivedQuantity": 0,
          "unreceivedQuantity": 120,
          "unitPriceMinor": "18500",
          "currency": "EUR",
          "confirmedArrivalAt": "2026-11-06T17:00:00.000Z",
          "version": 5
        }
      ]
    }
  ]
}
```

The accepted seed intentionally gives `PO-2026-1001` and `PO-2026-1012` the same supplier
reference `BC-4417`. Reading `BC-4417` returns two candidates. This exercises exact-match
handling without a fuzzy identity decision.

### `GET /v1/inventory?productIds=<uuid,...>`

Returns one item per requested product, in request order:

- `onHandQuantity`;
- `activeReservations` and `availableForAllocation` (`max(0, onHand - active reservations)`);
- reservation rows with their statuses, quantities and versions;
- confirmed inbound lines: unreceived quantity, original arrival time, purchase-order
  reference/status, line version and updated time;
- `confirmedInboundQuantity` as the total unreceived inbound quantity, independent of the
  visible line count;
- inventory version and timestamps.

Reservation and inbound line lists are bounded to 1000 rows per product. The aggregates cover
all rows, and `reservationsTruncated` / `confirmedInboundTruncated` disclose when only the
first 1000 line details are visible.

`availableForAllocation` never includes inbound stock. Inbound coverage is a separate fact
that the caller compares with a deadline. Only unreceived, non-cancelled lines with an arrival
time after the sandbox clock are included; overdue unreceived lines stay visible on the
purchase-order read instead. A delayed purchase order keeps its original ERP arrival date in
this read and is marked with `purchaseOrderStatus: "delayed"`.

### `GET /v1/affected-orders?purchaseOrderId=<uuid>&horizonDays=<1..365>`

### `GET /v1/affected-orders?productIds=<uuid,...>&horizonDays=<1..365>`

Exactly one of `purchaseOrderId` and `productIds` is required. A purchase-order reference is
resolved through its lines to the exact product IDs. The route returns sales orders with status
`confirmed` or `allocated` whose promised delivery falls from the sandbox business clock through
the inclusive horizon and whose lines reference at least one requested product.

Each order includes customer identity/version, status, version, promised deadline, exposed
order value (sum of line quantity times unit price), contractual penalty daily/cap values (or
null when contract data is missing), and all order lines with product versions. At most 100
orders are returned; `truncated` says whether more matched. Delivered, shipped, cancelled and
out-of-horizon orders are excluded from this exact demand join.

### `GET /v1/alternatives?productIds=<uuid,...>&quantities=<n,...>&deadline=<ISO-8601 Z>`

The product and quantity lists must have the same length and at most 20 unique products.
`deadline` must be an ISO-8601 UTC timestamp at or after the sandbox clock. For each product,
the route returns its requested quantity and every **approved** agreement from an **active**
supplier for an **active** product. Suspended suppliers, pending/expired/revoked agreements and
discontinued products yield no offers.

Each offer keeps agreement ID/reference/version, supplier identity/version, unit price,
currency, capacity, lead time, validity dates, `currentlyValid` (evaluated against the sandbox
clock) and `latestArrivalAt` (sandbox clock plus lead-time days). Capacity may be zero and an
arrival may be after the deadline; the caller ranks feasibility and must reject ineligible
offers explicitly. F07 does not rank, reserve or choose an alternative. A product sees at most
1000 offers; `offersTruncated` discloses the bound.

## Command transport (F08)

### `POST /v1/commands/:kind`

Supported kinds are `enterprise.create_purchase_order` and `enterprise.send_message`. An unknown
kind returns `NOT_FOUND`. The route kind must match `payloadTemplate.kind`; the body sandbox must
match `X-Nexus-Sandbox-Id`.

The JSON body is the accepted constant-payload transport envelope:

```json
{
  "sandboxId": "00000000-0000-4000-8000-000000000001",
  "actionRevisionId": "...",
  "itemId": "...",
  "planHash": "64 lowercase hex characters",
  "itemHash": "64 lowercase hex characters",
  "baseExpectedVersions": [
    {
      "system": "enterprise",
      "type": "agreement",
      "id": "...",
      "reference": "AGR-2026-0002",
      "version": 7
    }
  ],
  "payloadTemplate": { "kind": "enterprise.create_purchase_order", "...": "..." },
  "priorReceiptKeys": [],
  "executeBefore": "<ISO-8601 UTC, at most 30 seconds after the real DB clock>",
  "authorizationValidUntil": "<ISO-8601 UTC, no earlier than executeBefore>"
}
```

The deadline clock is the real PostgreSQL clock. It is deliberately separate from the sandbox
business clock used by planning and fixture dates.

The simulator derives the composite receipt key from
`sandboxId:actionRevisionId:itemId:kind`. It recalculates `itemHash` over the canonical
`payloadTemplate` and sorted `baseExpectedVersions`; a mismatch is `VALIDATION_FAILED`. It accepts
only one `planHash` per action revision, validates any supplied base entity against current
storage, and requires base supplier/source-purchase-order/agreement entries for a purchase order.
Agreement entries must include the exact agreement reference and row version. Inventory base
versions use the product ID as the aggregate ID because the read API exposes inventory by
product.

A new write is rejected with `APPROVAL_EXPIRED` (409) when `executeBefore` or
`authorizationValidUntil` is at or before the database clock. `executeBefore` must not exceed
`authorizationValidUntil` or the database clock by more than 30 seconds (`VALIDATION_FAILED`).
The deadline is rechecked immediately before commit. Hashes and deadlines are transport facts;
they do not replace the command token or prove human approval.

Every supplied `priorReceiptKeys` value must be a committed receipt in the same sandbox, action
revision and plan. Keys are normalized to a sorted unique set. The current key cannot be its own
proof. Proofs are not validated when an existing receipt already matches the business identity.

### Command business effects

`enterprise.create_purchase_order` re-reads the active sandbox, supplier, source purchase order,
products and agreements. It rejects:

- a retired sandbox, inactive supplier/product, unapproved/expired/not-yet-valid agreement,
  non-EUR agreement, missing/negative capacity, or requested quantity over the capacity
  remaining after command-created purchase-order lines (`CONFLICT` or `STALE_STATE`),
- a price that differs from the approved agreement (`CONFLICT`),
- a base agreement/supplier/source-order version or reference that no longer matches
  (`STALE_STATE`),
- an arrival before the sandbox business clock or a line total above the money bound
  (`VALIDATION_FAILED`).

Capacity is consumed only by command-created purchase-order lines. Preexisting F07 seed purchase
orders carry no agreement link and are not subtracted from the approved capacity shown by the
read model.

It inserts one open purchase order linked to the source purchase order and its agreements,
increments the source purchase-order version and each affected inventory row version, and emits
one `enterprise.inventory.changed.v1` outbox row per product. On-hand quantity does not change.
The receipt records before/after versions for the created order, its lines, the source order and
each inventory row.

`enterprise.send_message` validates the exact active enterprise supplier or customer recipient
and its version. It records the subject and typed text/verified-claim parts as a `simulated`
communication. Suspended/inactive recipients return `STALE_STATE`. `receipt_fact` parts and other
deferred receipt bindings are rejected until F13A. It emits one
`enterprise.communication.created.v1` outbox row with entity ID, `version`, `changedFields` and
origin. It does not send email or call a supplier.

The business mutation, receipt, base versions, entity changes and origin-tagged outbox rows
commit in one transaction. A failure rolls all of them back. F08 writes the outbox as `pending`;
the table already accepts the plan's event types and the publisher statuses
`pending/publishing/published/failed`, and `enterprise_app` has column-scoped
`UPDATE (status, attempt_count, next_attempt_at, version, updated_at)` for the later F10
publisher, not a table-wide update. No publisher or external delivery is implemented here.

### `GET /v1/command-receipts/:idempotencyKey`

The key is the composite value printed in `receipt.idempotencyKey`. An existing receipt is
returned unchanged when the command kind, sandbox, action revision, item, plan hash and item
hash match. Renewed `executeBefore`, `authorizationValidUntil` or reordered/changed proof keys do
not alter an existing receipt and cause no new effect. The same key with a changed business
identity returns `IDEMPOTENCY_MISMATCH` (409). A changed plan hash on the same revision also
returns 409. Unknown receipts return `NOT_FOUND`; a malformed key returns `VALIDATION_FAILED`.
Past-success receipts remain readable after their deadline.

Receipt fields are `id`, `sandboxId`, `idempotencyKey`, `commandKind`, `actionRevisionId`,
`itemId`, `planHash`, `itemHash`, `status: "succeeded"`, `executeBefore`,
`authorizationValidUntil`, `baseExpectedVersions`, sorted `priorReceiptKeys`, `result`
(`entityType`, `id`, `version`), `entityChanges`, and `createdAt`. A create result is a purchase
order; a message result is a communication.

The command endpoint is not exposed to AI tools, the browser or the Nexus application. F08
accepts the command token only from the private test/operator caller; the application executor
and its command client belong to F13A. See
[ADR 005](adr/005-tools-vs-privileged-commands.md) for the boundary.

## Seed and fixture ownership

`pnpm demo:init` runs both migration sets, seeds local identity accounts and then calls
`seedEnterpriseSupply` from `@nexus/enterprise-db/seed`. The seed reads the seven JSON files in
`fixtures/company/` and validates counts, references and cross-row consistency before writing.

Baseline counts: 6 suppliers, 12 products, 12 customers, 24 agreements, 12 purchase orders,
24 sales orders, 12 inventory rows and 12 reservations. The seed is deterministic and
idempotent: every write uses a stable UUID with `ON CONFLICT DO NOTHING`, so a repeated run
inserts zero rows. It never truncates or overwrites existing scenario records.

The fixture graph includes:

- partial stock (`P01` has 55 on hand and 40 active reservations, leaving 15 available);
- confirmed inbound before, on and after a 14-day horizon, plus a delayed purchase order;
- both feasible and infeasible supplier offers (early/high price, late, zero capacity);
- a duplicate supplier-provided reference for exact-match ambiguity;
- historical/current lifecycle states across products, customers, purchase orders and sales
  orders.

Read details for tables, keys, checks and grants are in [DATA_MODEL.md](DATA_MODEL.md).

## Verification

```sh
pnpm build
pnpm verify:phase F08
pnpm test:integration F07
pnpm demo:init
```

`pnpm verify:phase F08` runs the F08 integration suite against isolated infrastructure and the
cumulative unit suite. The F08 suite checks token separation, concurrent same-key execution,
changed business/plan/base identity, deadline bounds, same-plan proof sets, wrong price/capacity/
external version, frozen sandbox, rollback, lost-response replay, origin outbox rows, restart
retention and subsequent read state. `pnpm test:integration F07` remains the compatibility check
for the accepted read model.

## Boundaries

F08 provides only the command transport and two command kinds. It does not provide application
approval, the executor, automatic outbox publishing, supplier delay messages, goods receipts,
invoices, returns, customer addresses, chosen alternatives or financial effects. It does not
expose the Nexus API, create workflow runs, write Nexus audit rows or send real email. Later
stages add the executor, approval binding, recovery and cross-store workflow behavior behind
their own contracts.

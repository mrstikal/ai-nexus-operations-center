# NEXUS Enterprise Simulator API (F07)

Status: F07 exposes read-only purchase-order, inventory, affected-order and supplier-alternative
facts from the private enterprise simulator. It does not implement commands, messages,
receipts, invoices, returns or financial effects; those arrive in later stages.

## Runtime boundary

- Service entry: `apps/enterprise-sim/dist/main.js`.
- The service connects only with `enterprise_app` credentials to the enterprise schema.
- It does not receive Nexus database credentials and never reads the `nexus` schema.
- It is private to the local deployment. There is no public browser route or CORS configuration.
- It never mutates business rows. F07 grants `enterprise_app` only `SELECT`.
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
PORT=3002 \
pnpm --filter @nexus/enterprise-sim start
```

The process prints `ENTERPRISE_SIM_READY port=<port>` after the database-backed guard is ready.
`ENTERPRISE_SIM_READ_TOKEN` must contain at least 32 characters; the service fails closed when
it is absent.

## Required request headers

| Header | Required | Meaning |
|---|---|---|
| `Authorization` | yes | `Bearer <ENTERPRISE_SIM_READ_TOKEN>` |
| `X-Nexus-Sandbox-Id` | yes | Exact enterprise sandbox UUID |
| `X-Correlation-Id` | yes | 1-128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$` |

The guard checks the read token in constant time, validates the sandbox UUID and correlation
ID, then loads the sandbox business clock. A malformed header is `VALIDATION_FAILED` (400), a
bad or missing token is `UNAUTHENTICATED` (401), and an unknown sandbox is `NOT_FOUND` (404).
A retired sandbox remains readable because it is frozen history.

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
pnpm verify:phase F07
pnpm demo:init
```

`pnpm verify:phase F07` runs the F07 integration suite against isolated infrastructure and the
cumulative unit suite. The F07 suite checks exact seed counts/links/repeat, ambiguous references,
purchase-order demand joins, on-hand versus inbound coverage, supplier price/capacity/versions,
bad auth/sandbox/schema values, negative/overflow database checks and runtime-role isolation.

## Boundaries

F07 does not provide purchase-order creation or update, supplier messages, goods receipts,
invoices, returns, customer addresses, chosen alternatives or financial effects. It does not
expose the Nexus API, create workflow runs or write audit rows. Later stages add commands and
cross-store workflow behavior behind their own contracts.

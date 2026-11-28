# NEXUS Scenarios

Status: F19 specifies scenario A's deterministic supply formulas, inputs and outputs. The
workflow composition, API and UI remain F20-F24. F31-F44 own B and C.

## Scenario A: supply exception

A supplier notice or document names a delayed purchase order and a revised delivery. The case
must decide whether unreserved stock, other confirmed inbound, an approved alternative purchase
and a customer communication can cover the affected customer deadlines, or whether the case must
escalate. The calculation is deterministic and produces hashed evidence; an AI recommendation is
only an interpretation of that evidence.

### Inputs

`SupplyCalculationRequest` is a bounded snapshot built by trusted workflow code from authoritative
enterprise reads, validated document fields and the reviewed policy bundle:

- `purchaseOrder`: the matched PO with each line's ordered/received/unreceived quantity, unit
  price, currency EUR and confirmed arrival.
- `inventory`: per product, on-hand quantity, active reservations and confirmed inbound lines with
  their purchase order and arrival time. The matched delayed PO's inbound is excluded from
  coverage.
- `demand`: per affected sales order, product, quantity, promised delivery, exposed value,
  contractual daily penalty and cap (nullable), and the authoritative delay tolerance
  (nullable = no delay allowed).
- `offers`: per product, approved supplier agreements with supplier status, agreement status,
  current validity, unit price, capacity, latest arrival and optional explicit expedite charge.
- `supplierNotice`: the extracted revised arrival and quantity; either may be null.
- `asOf`, `policyRevision`, `policyContentHash`, `financeThresholdMinor` and
  `priorAdditionalCommittedMinor`.

### Outputs

`calculateSupply` returns a deterministic `SupplyCalculationResult` with:

- `availableForAllocation = max(0, on_hand - active_reservations)` per product, using on-hand
  only; confirmed inbound never increases it.
- `coverageByDeadline` per product and affected deadline: unreserved stock plus other confirmed
  inbound arriving by that deadline. It is planning coverage, never REST availability.
- `allocations`: stock allocated in (promised delivery, order ID) order; early stock is never
  counted twice. Each allocation records requested, allocated and shortage quantities.
- `shortages`: aggregated per product and affected deadline, with the affected order IDs.
- `optionSets`: one set per deadline with cumulative shortage. Offers are eligible only when the
  supplier is active, the agreement is approved and currently valid, currency is EUR, capacity is
  positive and the latest arrival is not after the deadline. A plan uses one or two suppliers;
  capacity is allocated cheapest-first per product with arrival then agreement ID as tie-breaks.
  Options are ranked by additional commitment, then latest arrival, then supplier ID. The search
  is bounded: at most 20 candidate suppliers are retained (the cheapest supplier per product and
  any supplier able to cover a whole product requirement are always kept before price-ranked
  filling), at most 100 options are retained per deadline, at most 1,000 rejected combinations
  and 1,000 rejected offers are recorded, and an option never exceeds 100 line items. Truncation
  is reported as `SUPPLIER_LIMIT`, `OPTION_LIMIT_REACHED`, `OFFER_LIMIT_REACHED` or
  `ITEM_LIMIT_REACHED`. Candidate retention always keeps the cheapest supplier per product and a
  partner able to cover that product requirement with it, so a feasible two-supplier combination
  is not lost to price truncation. Rejected offers and infeasible supplier combinations carry
  typed reasons. Waiting reasons are capped at 20 entries with a final `REASON_LIMIT_REACHED`
  marker.
- `waitingOption`: feasible only when the revised arrival is present, every short product is
  covered by `revisedProductQuantities` (a single-product notice may use `revisedQuantity`
  instead), and the authoritative contract tolerance allows the arrival for every order that
  actually depends on the delayed purchase order (orders fully covered by stock are not affected).
  With several short products and no per-product quantities the wait is not feasible
  (`MISSING_REVISED_PRODUCT_QUANTITIES`). Otherwise the reasons are listed.
- `impact`: the described option ID, original PO outstanding commitment (comparison only, never
  subtracted), like-for-like unit-price differences, exposed sales value, contractual penalty
  `min(cap, late whole calendar days * daily amount)`, cumulative additional commitment, and the
  strict `>` EUR 500 finance-threshold decision for the canonical complete-plan option. Missing
  penalty terms or a missing planned arrival make the penalty null and list the missing fields
  (up to two entries per demand line, bounded at 200).
- `missingFields`, `noProcurementRequired`, `infeasible`, `inputHash` and `resultHash`.
  `infeasible` is true when any affected deadline has no feasible procurement option, unless the
  wait option is feasible for every short product; both a later deadline with no feasible option
  and an earlier deadline with no feasible option therefore escalate. The best option and impact
  come from the complete latest cumulative-deadline set. A demanded product without an inventory
  row is reported as `inventory.<productId>` with zero coverage instead of failing the
  calculation.

Identical snapshots always produce the same `inputHash` and `resultHash`. The calculation tool
`domain.calculate_supply_options` is a compute tool: it never reads the model as fact and never
writes business state.

### Branches

| Branch | Deterministic outcome |
|---|---|
| Full on-hand coverage | No procurement; impact has zero additional commitment and on-time penalties |
| Partial stock | Shortage after stock and confirmed inbound; a smaller alternative procurement option |
| Alternative purchase | One or two eligible suppliers, ranked by commitment/arrival/supplier ID |
| Wait and notify | Feasible only with a complete revised notice inside the contractual tolerance; penalty stays visible |
| No feasible option | No eligible offer, insufficient capacity or disallowed delay; `infeasible` with reasons, escalation |
| Ambiguous PO / missing fields | `missingFields` names the exact field; no invented value |
| Stale snapshot | A changed input hash invalidates prior calculation evidence and verification |

### Deterministic verification

`packages/application/src/verification/` builds one `calculation` evidence record per result and
verifies a structured recommendation before it can become an executable proposal:

- every material claim cites existing evidence;
- calculated claims cite a `calculation` record whose `inputHash` and `resultHash` match the
  current result, so a stale or unrelated calculation cannot support a new claim;
- the claim value is recomputed exactly from the result (option commitment, arrival, rank, shortage
  quantity, wait feasibility, finance decision); an invented amount is rejected even when its
  citation ID exists;
- a selected option must exist and be feasible; an infeasible calculation cannot select an option
  and must escalate;
- a procurement-required case must select an option unless waiting is feasible, and the selection
  must include an option from the complete latest-deadline set so no affected deadline is left
  unaddressed;
- the finance decision is recomputed from the option commitments the recommendation actually
  selects, not from the canonical best option in the impact record.

Verification is pure and uses no model call. F20 calls it in `supply-v1` before proposing an
action DAG; F28 adds the independent live reviewer on top, never replacing these checks.

### Fixtures

`fixtures/scenarios/a-*.json` each carry the full request and the explicit expected option set and
impact: `a-partial-split`, `a-wait-and-notify`, `a-no-feasible`, `a-full-on-hand`,
`a-full-procurement-boundary`, `a-multi-deadline-infeasible` and `a-multi-product-wait`. Unit and integration tests compute every fixture, assert the exact
hashes are stable, persist calculation evidence in an isolated PostgreSQL sandbox and prove that
invented or stale citations are rejected.

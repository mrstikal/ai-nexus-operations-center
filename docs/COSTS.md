# Costs and Model Accounting

NEXUS accounts for model work in USD micro-units (one USD = 1,000,000 micro-USD). Amounts are stored
as bigint and rendered as non-negative decimal strings on the wire. This document defines the cost
terminology introduced in F14 and used by later AI stages.

## Terminology

| Term | Meaning |
|---|---|
| `actual` | Provider-reported cost for a physical call, or the conservative tariff-derived amount when no reported cost exists. |
| `estimated` | Token-count times configured tariff. Used for pre-call reservations and settlement when the provider reports usage but no cost. |
| `reported` | Provider-supplied cost for the call. Preferred settlement basis. |
| `replay` | Actual cost zero. Recorded token usage is demo metadata only and must not be presented as spend. |
| `reserved` | Conservative upper bound held against every account in the call's hierarchy before I/O. Not yet spend. |
| `used` | Settled actual amounts charged against an account. |
| `uncertain` | A possibly spent reservation retained after a timeout or unaccounted response. It stays reserved until explicitly finalized. |
| `usage_adjustment` | A later conservative correction; it does not rewrite historical audit rows. |

The wire `Cost` object is `{ amountMicrousd, basis: 'estimated' | 'reported' | 'replay' }`.

## Default Envelope

The hard ceilings and the 20% reservation buffer are fixed safety constants in
`packages/ai/src/budgets.ts`; `config/limits.json` supplies only the operational gateway bounds.
A deployed limits revision cannot raise a ceiling or remove the buffer.

| Account owner | Hard ceiling (USD micro-units) | USD |
|---|---:|---:|
| case / run | 200,000 | 0.20 |
| document | 50,000 | 0.05 |
| assistant | 50,000 | 0.05 |
| briefing | 30,000 | 0.03 |
| indexing | 500,000 | 0.50 |
| evaluation | 5,000,000 | 5.00 |

Scenario defaults are A 0.20, B 0.15 and C 0.15 USD per run, enforced by the scenario budget account
parent at its owner stage. Operators may lower a cap; an explicit extension may restore budget only
within the hard ceiling. A child account can never admit a call that would exceed any ancestor cap.

Replay actual spend is always zero. Replay fixtures may record token usage for demonstration, but the
ledger labels it demo metadata and the cost basis is `replay`.

## Admission

- A call requires an existing active budget account. A missing or cross-sandbox account is `BUDGET`.
- The estimate is an input-token upper bound covering the trusted prompt, caller messages and allowed
  tool schemas, plus the effective maximum output tokens at the selected tariff, raised by the fixed
  20% buffer. Unknown pricing, a missing account or a per-call price above the configured cap refuses
  the call instead of making an unsafe budget claim.
- The reservation is atomic across the account and all ancestors. The physical attempt is persisted
  before provider I/O. Two workers cannot both pass the cap check for the same remaining budget.
- Each fallback or repair is a separate physical attempt with its own reservation and counts against
  the same run attempt/dollar caps.

## Settlement

- Success with a provider-reported cost settles at that amount.
- Success with usage but no reported cost settles from input/output tokens and the configured tariff.
- A deterministic provider failure releases the unspent reservation; any provider-reported usage is
  still charged.
- Timeout, disconnect or a provider response with neither usage nor cost leaves the full reservation
  in `uncertain`. It is visible to the operator and blocks further admission until finalized.
- Settlement is idempotent. Repeating it for an already settled call does not charge again.

## Reporting Rules

- Display replay as zero actual cost and label recorded usage as demo metadata.
- Do not present a reservation as spend; show reserved, estimated, reported and uncertain separately.
- Usage totals include retries, fallbacks, repairs, embeddings and judge calls under the same
  hierarchy. Preprocessing performed before case attachment keeps its own documented cap, and totals
  deduplicate ledger call ids rather than silently recharging ownership.
- A provider invoice can differ from a tariff estimate. The ledger enforces conservative admission,
  not an absolute guarantee against provider billing errors.
- Live evaluation or any paid call requires separate explicit authorization and a budget; ordinary
  tests and CI never make one.

## Current F14 Evidence

Replay invocations record a validated output, a zero-cost ledger row and a redacted trace. Budget
admission, concurrent reservation refusal, uncertain retention and finalization are exercised against
the real PostgreSQL schema in `tests/integration/f14-gateway.test.ts`. No paid call was made.

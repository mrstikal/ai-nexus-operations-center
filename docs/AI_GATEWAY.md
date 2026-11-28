# AI Gateway

This document defines the shared model boundary introduced in F14. It applies to every workflow,
document job, assistant run and evaluation that uses an AI role. F14 implements the replay mode,
versioned role configuration, validated outputs and durable budget accounting. The live OpenRouter
adapter and its preflight belong to F25; OCR/vision belongs to F26; embeddings belong to F27.

## Roles and Output Schemas

The gateway accepts the seven closed roles from the shared contracts: `classify`, `extract`,
`vision`, `embed`, `analyse`, `verify`, `write`. Business modules import the `ModelGateway` contract,
never a provider SDK or a model name.

Every invocation names an output schema id registered in `packages/contracts/src/ai-outputs.ts`:

| Schema id | Version | Role | Purpose |
|---|---|---|---|
| `document.classification.v1` | 1 | `classify` | Bounded document kind plus evidence ids |
| `document.extraction.v1` | 1 | `extract` | Source-spanned document fields with nullable values |
| `analysis.recommendation.v1` | 1 | `analyse` | Findings, options, explanation, missing fields |
| `verification.review.v1` | 1 | `verify` | Supported/disputed/insufficient reviewer verdict |

The registry is closed. A request for an unregistered schema, or for a schema owned by another role,
fails with `SCHEMA_INVALID` before any physical call. Owner stages add their own schemas (structured
extraction in F17, supply/reconciliation/customer outputs in F19/F20/F33/F42, assistant replies in
F46). A new output shape requires a new versioned id; an additive change to an approved id would
change its meaning and is not allowed.

Prompts live in `packages/ai/src/prompts/<role>/v1.ts`. The prompt version recorded in a call is the
SHA-256 of its exact instruction text, not a mutable label. Changing prompt text therefore changes
the replay key and the recorded prompt version.

## Modes and Routing

`config/models.default.json` is the checked-in server configuration revision. Each role declares a
provider, model, capabilities, prompt version, maximum output tokens and a token tariff. Validation
happens when the configuration is loaded:

- every role must route a valid prompt version;
- required capabilities must be present (`structured_json` for structured roles, `vision` for
  `vision`, `embedding` for `embed`);
- a configured fallback must be capable of every configured role;
- all tariffs are explicit non-negative USD micro-unit strings.

The configuration is immutable content pinned by runs; changing it requires a new revision. Replay is
the default and only mode available in F14. Live mode requires an injected provider adapter and fails
closed with `UNAVAILABLE` when none is installed. Replay never reads an API key or environment secret
and makes no network request.

### Attempt policy

- At most two physical attempts per invocation, shared by fallback and repair. The counter is never
  reset or multiplied inside a workflow retry.
- A timeout, rate limit or transport unavailability may use the one configured fallback route.
- A model response that fails its Zod output schema may use one schema-repair attempt instead. The
  repair appends a fixed instruction naming the schema. Fallback and repair are never combined in a
  single invocation; the repair remains available when a fallback route is merely configured but not
  used.
- Authorization, moderation, context-length, privacy-policy, budget and deterministic business
  failures do not retry.
- Tool rounds and tool calls are bounded by `RunModelCaps` (two rounds, twelve calls for scenario
  runs; the assistant and other surfaces may lower them). Every fallback or repair consumes the same
  physical-attempt counter. A workflow-bound invocation must receive a shared run counter; omitting
  it fails closed instead of starting a fresh per-call allowance.
- Input is bounded at 16,000 estimated tokens. Output is bounded at 2,000 tokens for ordinary roles
  and 4,000 tokens only for the bounded `analyse` role; a request or route above its role bound is
  refused before reservation and provider I/O. Images use the documented worst-case estimate.
  Exceeding a bound refuses the call rather than truncating required facts.

## Replay Keys

A replay record is a checked-in fixture, not a generic "return success" stub. The key is the SHA-256
of canonical JSON containing:

- role and output schema id plus its version;
- prompt content hash and model-config revision;
- selected route provider and model;
- requested capabilities and allowed tool names (sorted);
- maximum output tokens;
- every message, with text normalized to Unicode NFKC and stable line/space form, and image
  references reduced to document-version id plus page.

The key excludes sandbox, workflow and budget ids so the same semantic request replays across test
runs, but it includes every input that can change the answer. A changed source, evidence reference,
prompt, route or schema therefore cannot reuse an unrelated recording. A miss is a typed
`UNAVAILABLE` failure with `replay_miss`; it is never turned into a fabricated success.

`fixtures/replay/v1/manifest.json` lists success records and references the failure fixtures under
`fixtures/failures/`. Registered failure fixtures cover provider timeout, HTTP 429, provider schema
rejection and budget exhaustion. Recorded token usage is demo metadata; replay actual cost is zero
with basis `replay`.

## Budget Accounts

`nexus.budget_accounts` is a per-sandbox hierarchy:

- owner kinds: `case`, `run`, `document`, `evaluation`, `assistant`, `briefing`, `indexing`;
- each account has an immutable cap and mutable used/reserved micro-USD totals;
- a standalone document or evaluation has its own root cap; document work started by a case is a
  child of that case's run budget;
- maximum hierarchy depth is four accounts (root at depth zero, three child levels), enforced on
  creation and on reservation;
- the unique owner key is `(sandbox_id, owner_kind, owner_id)`;
- a workflow-bound call must select the account owned by that exact workflow run or one of its
  descendants. The ledger locks the chain and rejects an unrelated same-sandbox account before
  reserving, so a standalone document/evaluation allowance cannot bypass the case/run cap.

Hard ceilings and the 20% reservation buffer are code constants, not configuration values. A new
account may lower its cap but cannot exceed the ceiling for its owner kind.

### Reservation and settlement

Before a physical call, the gateway computes a conservative upper bound: an input-token upper bound
covering the trusted prompt, caller messages and every allowed tool schema, plus the effective
maximum output at the selected tariff, raised by the fixed 20% buffer. Unknown tariffs or pricing
that exceeds the per-call price cap refuse the route.

Reservation is transactional:

1. An advisory transaction lock serializes the `(sandbox, invocation, attempt)` identity so a retried
   same attempt cannot reserve twice.
2. The account and every ancestor are locked ancestor-to-leaf in stable `(depth, id)` order.
3. Each account is checked for `active` state and `used + reserved + estimate <= cap`.
4. Each account increments its reserved total and the call row stores the exact per-account
   reservation set.
5. The `nexus.model_calls` row is inserted in state `reserved` before any provider I/O.

Two workers reserving against the same hierarchy therefore serialize and cannot both pass a cap
check. An existing identical attempt returns its recorded reservation/state instead of reserving
again. A workflow retry may pass a stable `invocationId`; reusing it returns the recorded attempt
without repeating provider I/O. An attempt whose identity was already recorded is not silently
retried with a fresh key.

On success, the call settles with the actual reported provider cost, or a labelled token-tariff
estimate when no reported cost exists. On a deterministic provider failure, the unspent reservation is
released and actual cost is zero unless the provider reported usage. On a timeout, disconnect or
unaccounted response, the full reservation remains as an `uncertain` charge; it is never released
automatically and its ledger row retains the failure code and bounded diagnostics. `finalizeUncertain`
conservatively charges the reservation or an explicit actual amount. A provider bill may exceed an
estimate, so the ledger reports conservative enforcement, not an absolute financial guarantee.

`nexus.model_calls` records role, schema version, prompt/config revisions, route, mode, replay key,
request hash, reservation set, usage, failure code, diagnostics and timestamps. The worker database
role owns account creation and every ledger mutation; the API role may read accounts and the ledger
but cannot create an account or change spend totals. No key or raw prompt is stored.

## Trusted Input and Cancellation

Caller messages use only `user`, `assistant` and `tool` roles. Trusted instructions come from the
versioned prompt and are never accepted from a request message, so document or email text cannot be
smuggled into a system slot. `invoke` and `stream` accept an optional `AbortSignal`; admission declines
before reserving when it is already aborted, and a live provider receives the same signal. An abort
after provider I/O remains an accounted or uncertain charge rather than an unrecorded free call.
A caller-supplied retry `invocationId` must be a UUID and is validated before any reservation.

## Tracing

Each settled or failed attempt writes a redacted `trace_events` row in the same transaction:

- `model.call.succeeded` or `model.call.failed`;
- role, output schema, mode, provider/model, cost and cost basis;
- replay key or fixture id, token counts, attempt number and duration.

Trace data uses the allowlist in `@nexus/observability/trace`. Prompt text, source text, secrets and
model reasoning are not recorded.

## Failure Codes

`UNAUTHORIZED`, `MODERATION`, `CONTEXT_LENGTH`, `PRIVACY_POLICY`, `RATE_LIMIT`, `TIMEOUT`,
`UNAVAILABLE`, `SCHEMA_INVALID`, `TOOL_LIMIT`, `BUDGET`, `CANCELLED`, `UNKNOWN`.

`TOOL_LIMIT` is also returned when a shared physical-attempt or tool-round/call cap is exhausted.
Replay misses are `UNAVAILABLE` with the `replay_miss` diagnostic.

## Current Limitations

- F14 has no live HTTP adapter; F25 implements OpenRouter and live preflight. F14 proves the live
  accounting boundary with a fake provider only.
- Only classify, analyse and verify have registered output schemas in F14. Extraction, vision,
  embedding, writing and assistant outputs arrive with their owner stages; until then those requests
  fail closed.
- Replay fixtures prove replay behavior and accounting, not live model quality.
- F14 does not create scenario budget accounts; F20/F23/F34/F46 own the concrete parent/child wiring.
  The ledger and account service are ready for them.
- No exactly-once claim is made for provider billing. The uncertain-reservation path is the
  conservative boundary.

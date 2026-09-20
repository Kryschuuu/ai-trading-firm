# Execution quality — canonical ledger (partial remediation)

This module provides a working **normalized input → PostgreSQL → authenticated
aggregate API** path. It does **not** complete RMA-P4-01: automatic capture from
strategy decisions, broker adapters, asynchronous live reconciliation and the
backtest runner is not wired. No order submission or risk decision is changed.
In particular an order acknowledgement must never be imported as a fill.

## Operations and migration

1. Apply `psql "$DATABASE_URL" -f drizzle/2026-09-20_execution_quality.sql`.
   It creates two new tables, indexes, a foreign key and append-only triggers.
   Reapplying is supported. Schema push alone does not install the triggers.
2. A trusted local operator exports a normalized `Batch` (see `model.ts`) to a
   JSON file and runs `npm run execution:ingest -- normalized-batch.json`.
   The strict field allowlist rejects raw payloads/extra fields. Max file size
   is 1 MiB, at most 1,000 events per batch and 10,000 per intent.
3. Query `GET /api/firm/execution-quality?from=0&to=20000&asOf=20000` using
   existing `firm.read` authorization. All parameters are required epoch-ms.
   API responses are private/no-store. Errors do not return DB/provider text.
4. Inspect `EXECUTION_QUALITY_INGEST` audit events (inserted count or bounded
   failure code, no account/order/instrument IDs). CLI counters are process-local,
   not a persistent Prometheus integration.

Import is explicit, not automatically enabled by deployment. Stop importing to
roll back; deploy the older application while **retaining both audit tables**.
Do not delete evidence. Historical runs are not implicitly backfilled. Existing
Paper/Backtest defaults, authority chains and live gates are unchanged.

## Contract and idempotency

`Batch = { intent: Intent, events: QualityEvent[] }`. The exported TypeScript
interfaces and runtime `parseBatch` validator define all required fields.
`tests/fixtures/executionQuality.ts` contains an executable two-fill example.
Input manifests must be immutable and retained externally; `inputHash` is their
SHA-256 digest, **not** a copy of a model prompt or raw marketdata payload.
Only opaque local account/run `scope` identifiers are allowed operationally;
never use broker account numbers, tokens, email addresses or user names. The
format validator cannot detect a credential disguised as a valid opaque ID.

Intent IDs, decision IDs, client IDs and optional parent IDs are retained.
ACK/fill events bind the broker order ID to the intent. Parent IDs are correlation
references, not currently database-enforced hierarchy edges. Exactly one broker
order is accepted per intent; replacement orders require new intents.

Intent identity and the venue/mode/scope/client-order tuple are unique. Fill
identity additionally enforces venue/mode/scope/order/fill uniqueness across
intents. Same-key, same-content retries insert nothing. Conflicting content
(including timestamps) fails atomically; callers must retry the original event,
not rebuild it with a new `computedAt`. No last-writer-wins behavior. A database
row lock serializes partial fills, and cumulative overfill is rejected. The
ledger does not retry orders and cannot introduce duplicate external orders.

## Time and price semantics

- UTC epoch milliseconds for event, availability and computation times.
  `eventTime <= availableAt <= computedAt`; reports include only events available
  by explicit `asOf`. Intent cohort uses `[from,to)` submit time.
- `elapsedSubmitMs` is an explicitly supplied same-process monotonic duration;
  use null when unavailable. UTC differences never masquerade as monotonic
  latency across restarts. Decision-to-submit monotonic time is not captured.
- Decision/arrival benchmarks must be available at their respective anchor and
  no older than 5 seconds. Stale values must be null with `STALE`, not zero.
  `windowEnd` identifies the completed market observation. A last trade must not
  be relabeled as an arrival **mid** by an importer.
- Interval VWAP is an optional externally calculated, provenance-hashed completed
  interval observation; this module does not build it from trade history.
- Positive `quantity` uses base units; prices and fees use the declared quote
  currency. Fees may be negative for rebates. No currency conversion is implied.
  Unknown fees use null plus reason, not a zero fee estimate.
- Paper/backtest fills must be `modeled`; live/testnet fills must be `observed`.
  Benchmark provenance is independent: paper can use observed market quotes.
- Missing benchmarks return `{ value: null, reason: 'MISSING' }`. Explicit nulls
  retain `MISSING`, `STALE`, `INVALID` or `NOT_AVAILABLE_AS_OF`.

## Formulas and reporting

Let `s = +1` for buy, `-1` for sell, `P = sum(q*f)/sum(q)` and reference `B`:

- price cost bp: `s*(P-B)/B*10000`; quote cost: `s*(P-B)*sum(q)`;
- executed-quantity decision shortfall including fees: decision quote cost +
  sum of quote fees, null if either component is unknown;
- fill ratio: `sum(q)/requestedQuantity`; unfilled opportunity cost is excluded;
- time-to-first/complete uses supplied monotonic durations of the first/last
  chronological fill; complete remains null for a partial order;
- adverse-selection bp per fill at 1s, 5s, 30s:
  `s*(fillPrice-futureMid)/fillPrice*10000` (positive is adverse). Quotes cannot
  postdate the horizon, must have been available by it and be at most 1s old.
  Report per-order quantity-weighted markout and quantity coverage; never
  substitute a later quote. The module does not schedule markout collection.

API groups by venue, mode, strategy, order type **and quote currency**. It
returns count, order coverage, p50/p95 (R7 linear interpolation) and fill-notional
weighted means for arrival/decision/VWAP bp, fill ratio and latencies. Nulls are
excluded, never replaced with zero. Zero-fill orders have zero notional and
therefore no influence on weighted means, but count toward coverage/quantiles.
Per-order fee/shortfall/markout metrics are available from `summarize`; these
are not yet all exposed in the aggregate API. Observed/modeled breakdown per
benchmark is retained in storage but not yet an API grouping dimension.

Reports are bounded to 31 days, 500 intents and 10,000 events in one repeatable
read snapshot. Exceeding a bound returns 422 `REPORT_LIMIT`: narrow the interval;
no truncated population is advertised as a complete aggregate. Queries time out
at 10s. No instrument/order/trade ID is a metrics label.

## Remaining acceptance gaps

Automatic production adapters and backtest parity, monotonic decision timing,
markout/VWAP collection, broker fee reconciliation, complete aggregate metrics,
provenance-quality coverage and adapter restart/retry tests remain open. Thus
this is a partial ledger/API delivery, **not** a production-ready end-to-end
execution-benchmarking claim. RMA-P4-01 stays `PARTIAL`.

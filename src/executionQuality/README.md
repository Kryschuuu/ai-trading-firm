# Execution quality — canonical production ledger

The additive capture path is **decision/intent → existing guarded executor →
immutable intent, ACK and individual fill facts → fixed-horizon observation →
bounded authenticated aggregate API**. It never routes orders or changes their
price, quantity, stop, risk authority or live gate. Capture is explicitly opt-in;
the disabled Paper/Backtest defaults are unchanged.

## Deployment and operations

Apply these **new, additive** migrations in order, before enabling capture:

```sh
psql "$DATABASE_URL" -f drizzle/2026-09-20_execution_quality.sql
psql "$DATABASE_URL" -f drizzle/2026-09-21_execution_quality_capture.sql
psql "$DATABASE_URL" -f drizzle/2026-09-21_execution_quality_quotes.sql
psql "$DATABASE_URL" -f drizzle/2026-09-21_execution_quality_integrity.sql
psql "$DATABASE_URL" -f drizzle/2026-09-21_execution_quality_completion.sql
```

They create the intent/event ledger, durable send claims and receipts, minimal
L1 quote samples and terminal completion markers. All are append-only, including
DB-enforced UPDATE/DELETE/TRUNCATE rejection. Parent references are FK-enforced
on new writes; `NOT VALID` permits reading previously imported orphan references.
Indexes cover time cohorts, scope paging, parent/decision correlation and quote
as-of lookup. Migrations are rerunnable. **Schema push alone does not install
these triggers**. No existing migration or trade table is rewritten.

Set `EXECUTION_QUALITY_ENABLED=true` and a stable, opaque
`EXECUTION_QUALITY_SCOPE=desk-paper-1`. Each broker account/deployment needs a
distinct scope. Never use account numbers, tokens or personal names as scopes.
The flag accepts exactly `true`/`false` (unset means false). Scope is required
for online capture and limited to 64 safe characters. Run a worker for every
active venue/mode using that same scope:

```sh
npm run execution:reconcile -- ALPACA testnet --watch
npm run execution:reconcile -- BITUNIX live --watch
npm run execution:reconcile -- PAPER paper --watch
```

Without `--watch`, the command performs one paginated sweep. Watch uses a minimum
one-second pause between pages, respects existing adapter rate limiting and
never overlaps requests. Each page has at most 100 intents; CLI follows the
returned keyset cursor, restarting safely from the beginning after a crash.
Terminal intents retire only after all existing fills have all three markouts
(or explicit missing observations). UNKNOWN submissions remain reconcilable,
never eligible for a replacement send. Large cohorts or late provider reporting
can reduce one-second markout coverage: the worker reports null, not a later quote.

Monitor `EXECUTION_QUALITY` / `EXECUTION_QUALITY_INGEST` audit events and
`execution_quality_total{result}` in the existing Prometheus exposition. Labels
are code-constant outcomes only, never instrument, strategy, order or fill IDs.
Worker JSON reports scanned/captured/unavailable/failures and paging cursor.
No raw provider response or exception string is included in new audit events.
The operator import remains available for normalized, versioned evidence:
`npm run execution:ingest -- normalized-batch.json` (1 MiB, 1,000 events/batch).

**Rollback:** disable capture, stop quality workers, deploy the old application
and retain these audit tables. No destructive down migration or order replay is
necessary. Existing price decisions, ledger bookings and live gates remain in
place. A DB failure before dispatch prevents submission; a failure after dispatch
must be reconciled, never retried as a new order. Disabling capture is not a way
to resolve an uncertain order: first reconcile it with the venue/client ID.

## Production wiring and retry semantics

- `PaperBroker.submitAtomic`: quality rows and order/position rows commit in the
  same transaction under the existing account lock. The canonical intent ID is
  the actual `order_intents.id`. Engine proposals and MicroExecutor rule/snapshot
  decisions supply stable decision IDs. Retries of a known decision replay the
  existing fill; changed order arguments are rejected. Transaction failure rolls
  back capture and the new in-memory fill. Callers without a decision identity
  remain explicitly unattributed; they must not assume retry dedupe beyond the
  existing position guard.
- PAPER, ALPACA and BITUNIX adapters: capture wraps the **existing** gated
  executor. With capture enabled, adapter callers must supply `orderIntentId`
  or `clientOrderId`. Normalized `executionQuality` decision context is additive.
  A send-once claim is committed before the external call. The stable client key
  reaches the original serializer. A durable minimal receipt repairs a crash
  between result receipt and event append without another send. An uncertain
  claim blocks dispatch until read-only venue recovery supplies evidence.
- Live/testnet: Alpaca account FILL activities and Bitunix execution trades supply
  individual IDs. The worker queries by the original client ID after restart,
  deduplicates fills and compares their quantity to the provider cumulative total.
  Incomplete lists or conflicting facts fail explicitly. Alpaca activity paging
  is bounded to 20 pages of 100; no truncated list is reported as complete.
  If a provider total fee is available, it must match individual quote fees.
  Alpaca FILL activities do not establish quote-currency commissions, so those
  fees stay null. Bitunix missing/invalid fee fields also stay null, never zero.
- Backtest: the existing Paper FillSimulator captures its exact requested/filled
  quantity, input reference, cost, modeled latency and fee. Walk-forward namespaces
  bind dataset/config/version/window/IS-OOS scope. `persistBacktestRun` commits
  these rows **with** its run/trade ledger; its existing idempotency key replays
  the same run. JSON research artifacts carry the evidence too. Historical runs
  are not silently backfilled when enabling the flag later.

Capture covers registered order submissions; it does not fabricate application
intents for unrelated manual broker orders or emergency-close acknowledgements.
A parent ID refers to the canonical quality intent, not an arbitrary client key.
Replacement/child submissions get their own intent and optional parent reference.
The position reconciliation path is not repurposed into execution benchmarking;
`execution:reconcile` is a separate read-only worker and never calls place/cancel/close.

## Contract, units and point-in-time semantics

`Batch = { intent: Intent, events: QualityEvent[] }`; interfaces and strict
runtime allowlists are in `model.ts`. Unknown fields/raw payloads are rejected.
Input hashes identify the immutable effective inputs; operators must retain
source manifests. Intent/fill/benchmark facts themselves are sufficient to
recalculate quality outputs without calling the venue again. No model prompt
or raw provider body is persisted. ID syntax cannot detect a credential disguised
as an opaque identifier: import is trusted operator-only, not a public write API.

- Prices and fees are quote-currency amounts; quantity is base units. Unknown
  currency is `UNKNOWN`, never implicitly USD. Such groups have no mixed-currency
  quote sums or notional-weighted means. Fee rebates are negative costs.
- All UTC times are integer epoch milliseconds. `eventTime <= availableAt <=
  computedAt`. Reports select events by `availableAt <= asOf`; recomputation time
  is not retroactive market knowledge. Missing decision ID/time remains null.
- Submit time is the capture/queue boundary before dispatch (including local
  persistence/guard delay). `elapsedSubmitMs` is a same-process monotonic duration.
  Cross-restart/async venue fill durations remain null; UTC timestamps are still
  retained, never subtracted and presented as a monotonic measurement. ACK time
  means local acknowledgement observation, including recovery observation.
- Decision-to-submit duration is supplied only when the decision clock is from
  the same process. Approved proposals after restart leave it unknown.
- Decision/arrival references must be available at their anchor and at most 5s
  old. Invalid/stale/future input yields null with a reason. Arrival is observed
  L1 mid for Bitunix and Alpaca latestQuote, never a last trade called a mid.
- Paper can have observed quote benchmarks and modeled fills. Backtest benchmarks
  are explicitly modeled around the simulator reference (close/trigger), not
  observed historical order books. Since replay bars are keyed by OPEN time,
  quality evidence anchors to OPEN + timeframe, the completed bar boundary;
  trading-engine decisions and legacy trade timestamps are not changed.
- Interval VWAP is optional normalized external evidence; it is not inferred from
  OHLCV or the order average. Its completed `windowEnd`, availability and input
  hash must be supplied. Absent VWAP remains null/MISSING.
- Markouts use persisted L1 samples at 1s, 5s, 30s. The sample must be known by
  the horizon and at most 1s old. Late jobs cannot substitute present-day quotes.
  No sample → null/MISSING. A benchmark referencing a fill not yet visible as-of
  is excluded until that fill is available.

Identical immutable events collapse. Conflicting same-key facts fail atomically;
no last-writer-wins corrections. Provider retries preserve the first receipt
availability/computation time. Venue/mode/scope/order/fill uniqueness prevents
cross-intent duplicates; intent locks reject concurrent overfill. Each intent
is bounded to 10,000 events.

## Formulas and API

Let `s=+1` for buy, `s=-1` for sell, `P=sum(q*f)/sum(q)` and benchmark `B`:

- Price cost bp: `s*(P-B)/B*10000`; quote cost: `s*(P-B)*sum(q)`.
- Executed-quantity shortfall including fees: decision quote cost + sum of fees;
  bp denominator is executed quantity × decision reference. Unknown fees/reference
  produce null. Unfilled opportunity cost is **not** included.
- Fill ratio: filled/requested quantity; completion latency stays null until full.
  `meanFillLatencyMs` is sum(quantity × monotonic fill delay)/filled quantity,
  null unless every contributing fill has a same-process duration.
- Adverse-selection bp per fill: `s*(fillPrice-futureMid)/fillPrice*10000`;
  positive means the market moved against the acquired position. Per-order
  markouts are quantity weighted and include quantity coverage.

`GET /api/firm/execution-quality?from=...&to=...&asOf=...` requires `firm.read` and
returns private/no-store JSON. All three arguments are UTC epoch-ms; cohort is
`[from,to)` submit time and `asOf >= to`. Groups are venue, mode, strategy, order
type and quote currency. Fields include order/fill count, arrival/decision/limit/
VWAP bp, quote costs, fees, shortfall, fill ratio, decision/ACK/first/complete
latencies, fixed-horizon markouts and observed/modeled/unavailable benchmark counts.
Statistics carry p50/p95 (R7 interpolation), coverage, sample count and
fill-notional-weighted mean. Quote sums are null if incomplete. Missing values
are excluded, never replaced with zero. Zero-fill orders contribute counts and
fill-ratio quantiles, but have zero weight in notional-weighted means.

Bounds: 31 days, 500 intents, 10,000 events, one repeatable-read snapshot, 10s SQL
statement timeout. Exceeding a cap returns 422 `REPORT_LIMIT`; narrow the interval.
Invalid range is 400, store failure 503 (without DB/provider text). No truncated
population is advertised as a complete report.

## Verification

`tests/executionQuality*.test.ts` cover signs, weighting, analytical percentiles,
null/negative paths, observed/modeled parity, pinned deterministic replay golden,
as-of boundaries, actual PostgreSQL migrations/immutability/parent FK, concurrent
claims, receipt-gap recovery, uncertain-submission blocking, atomic PaperBroker
rollback/replay, WalkForward→DB fee roundtrip, read-only Alpaca HTTP activities,
worker horizon sampling/retirement and authenticated bounded API validation.

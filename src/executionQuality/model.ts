/** Canonical execution-quality v1. Prices/fees are quote-currency amounts,
 * quantities base units, UTC times integer epoch milliseconds. Positive costs
 * mean worse execution for BOTH sides. This module never makes trading decisions.
 */
import { createHash } from "node:crypto";
import {
  BROKER_VENUE_IDS,
  EXECUTION_MODES,
  type BrokerVenueId,
  type ExecutionMode,
} from "../contracts/broker";

export type Reason = "MISSING" | "STALE" | "INVALID" | "NOT_AVAILABLE_AS_OF";
export type Quality = "modeled" | "observed";
export interface Intent {
  id: string;
  venue: BrokerVenueId;
  mode: ExecutionMode;
  /** Opaque account/run namespace; never a broker account number or credential. */
  scope: string;
  decisionId: string | null;
  clientOrderId: string;
  parentIntentId: string | null;
  strategy: string;
  instrument: string;
  quoteCurrency: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: number;
  limitPrice: number | null;
  decisionAt: number | null;
  decisionElapsedSubmitMs?: number | null;
  requestHash?: string;
  submitAt: number;
  computedAt: number;
  /** Hash of immutable decision/model/marketdata input manifest. */
  inputHash: string;
}
interface EventBase {
  intentId: string;
  eventTime: number;
  availableAt: number;
  computedAt: number;
}
export interface Ack extends EventBase {
  kind: "ack";
  orderId: string;
  /** Same-process monotonic duration. Never subtract clocks across restarts. */
  elapsedSubmitMs: number | null;
}
export interface Fill extends EventBase {
  kind: "fill";
  orderId: string;
  fillId: string;
  quantity: number;
  price: number;
  feeQuote: number | null;
  feeReason: Reason | null;
  quality: Quality;
  elapsedSubmitMs: number | null;
}
export interface Benchmark extends EventBase {
  kind: "benchmark";
  name:
    | "decision"
    | "arrival"
    | "interval_vwap"
    | "adverse_1000"
    | "adverse_5000"
    | "adverse_30000";
  /** Adverse-selection benchmark references an individual fill. */
  fillId: string | null;
  price: number | null;
  reason: Reason | null;
  quality: Quality;
  source: "quote" | "book" | "trades" | "bar" | "simulation" | "unavailable";
  inputHash: string;
  /** Last completed observation of the benchmark, never an incomplete bar. */
  windowEnd: number;
}
export type QualityEvent = Ack | Fill | Benchmark;
export interface Batch {
  intent: Intent;
  events: QualityEvent[];
}
export class QualityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireValue(ok: boolean, code = "INVALID_INPUT"): asserts ok {
  if (!ok) throw new QualityError(code);
}
function record(v: unknown): asserts v is Record<string, unknown> {
  requireValue(typeof v === "object" && v !== null && !Array.isArray(v));
}
function keys(v: Record<string, unknown>, expected: string) {
  const list = expected.split(" ");
  requireValue(
    Object.keys(v).length === list.length &&
      list.every((k) => Object.hasOwn(v, k)),
    "UNEXPECTED_FIELDS",
  );
}
function id(v: unknown) {
  requireValue(typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(v));
}
function time(v: unknown) {
  requireValue(
    typeof v === "number" &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      v <= 8_640_000_000_000_000,
  );
}
function positive(v: unknown) {
  requireValue(
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e15,
  );
}
function numberOrNull(v: unknown) {
  requireValue(
    v === null ||
      (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e15),
  );
}
function hash(v: unknown) {
  requireValue(typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
}
function nullable(v: unknown, reason: unknown) {
  requireValue(
    v === null
      ? ["MISSING", "STALE", "INVALID", "NOT_AVAILABLE_AS_OF"].includes(
          String(reason),
        )
      : reason === null,
  );
}
/** Strict allowlist: unknown fields (including raw provider payloads) rejected. */
export function parseBatch(raw: unknown): Batch {
  record(raw);
  keys(raw, "intent events");
  record(raw.intent);
  const i = raw.intent;
  const optional = ["decisionElapsedSubmitMs", "requestHash"]
    .filter((k) => Object.hasOwn(i, k))
    .map((k) => ` ${k}`)
    .join("");
  keys(
    i,
    "id venue mode scope decisionId clientOrderId parentIntentId strategy instrument quoteCurrency side orderType quantity limitPrice decisionAt submitAt computedAt inputHash" +
      optional,
  );
  for (const k of [
    "id",
    "scope",
    "clientOrderId",
    "strategy",
    "instrument",
    "quoteCurrency",
  ])
    id(i[k]);
  if (i.decisionId !== null) id(i.decisionId);
  if (Object.hasOwn(i, "requestHash")) hash(i.requestHash);
  if (Object.hasOwn(i, "decisionElapsedSubmitMs")) {
    numberOrNull(i.decisionElapsedSubmitMs);
    requireValue(
      i.decisionElapsedSubmitMs === null ||
        Number(i.decisionElapsedSubmitMs) >= 0,
    );
  }
  if (i.parentIntentId !== null) id(i.parentIntentId);
  requireValue(i.parentIntentId !== i.id);
  requireValue(
    BROKER_VENUE_IDS.includes(i.venue as BrokerVenueId) &&
      EXECUTION_MODES.includes(i.mode as ExecutionMode),
  );
  requireValue(i.side === "buy" || i.side === "sell");
  requireValue(i.orderType === "market" || i.orderType === "limit");
  positive(i.quantity);
  if (i.limitPrice !== null) positive(i.limitPrice);
  requireValue(i.orderType !== "limit" || i.limitPrice !== null);
  if (i.decisionAt !== null) time(i.decisionAt);
  time(i.submitAt);
  time(i.computedAt);
  hash(i.inputHash);
  requireValue(
    (i.decisionAt === null || Number(i.decisionAt) <= Number(i.submitAt)) &&
      Number(i.submitAt) <= Number(i.computedAt),
  );
  requireValue(
    Array.isArray(raw.events) && raw.events.length <= 1000,
    "BATCH_LIMIT",
  );
  for (const e of raw.events) {
    record(e);
    const base = "kind intentId eventTime availableAt computedAt ";
    keys(
      e,
      base +
        (e.kind === "ack"
          ? "orderId elapsedSubmitMs"
          : e.kind === "fill"
            ? "orderId fillId quantity price feeQuote feeReason quality elapsedSubmitMs"
            : "name fillId price reason quality source inputHash windowEnd"),
    );
    requireValue(e.intentId === i.id);
    time(e.eventTime);
    time(e.availableAt);
    time(e.computedAt);
    requireValue(
      Number(e.eventTime) <= Number(e.availableAt) &&
        Number(e.availableAt) <= Number(e.computedAt),
    );
    if (e.kind === "ack" || e.kind === "fill") {
      id(e.orderId);
      numberOrNull(e.elapsedSubmitMs);
      requireValue(
        e.elapsedSubmitMs === null || Number(e.elapsedSubmitMs) >= 0,
      );
      requireValue(Number(e.eventTime) >= Number(i.submitAt));
      if (e.kind === "ack") continue;
      id(e.fillId);
      positive(e.quantity);
      positive(e.price);
      numberOrNull(e.feeQuote);
      nullable(e.feeQuote, e.feeReason);
    } else {
      requireValue(e.kind === "benchmark");
      requireValue(
        [
          "decision",
          "arrival",
          "interval_vwap",
          "adverse_1000",
          "adverse_5000",
          "adverse_30000",
        ].includes(String(e.name)),
      );
      if (e.price !== null) positive(e.price);
      nullable(e.price, e.reason);
      hash(e.inputHash);
      time(e.windowEnd);
      requireValue(e.windowEnd === e.eventTime);
      requireValue(
        [
          "quote",
          "book",
          "trades",
          "bar",
          "simulation",
          "unavailable",
        ].includes(String(e.source)),
      );
      requireValue(e.price === null || e.source !== "unavailable");
      if (String(e.name).startsWith("adverse_")) id(e.fillId);
      else requireValue(e.fillId === null);
      if ((e.name === "decision" || e.name === "arrival") && e.price !== null) {
        requireValue(
          e.name !== "decision" || i.decisionAt !== null,
          "MISSING_DECISION_TIME",
        );
        const anchor = Number(
          e.name === "decision" ? i.decisionAt : i.submitAt,
        );
        requireValue(Number(e.availableAt) <= anchor, "LOOK_AHEAD");
        requireValue(anchor - Number(e.eventTime) <= 5000, "STALE_BENCHMARK");
      }
    }
    requireValue(e.quality === "modeled" || e.quality === "observed");
    if (e.kind === "fill")
      requireValue(
        e.quality ===
          (i.mode === "paper" || i.mode === "backtest"
            ? "modeled"
            : "observed"),
        "MODE_QUALITY_MISMATCH",
      );
  }
  return raw as unknown as Batch;
}
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined && typeof v !== "function")
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function eventKey(e: QualityEvent): string {
  return digest(
    e.kind === "ack"
      ? [e.intentId, "ack"]
      : e.kind === "fill"
        ? [e.intentId, "fill", e.orderId, e.fillId]
        : [e.intentId, "benchmark", e.name, e.fillId],
  );
}
/** Identical retries collapse; conflicting facts are never silently overwritten. */
export function uniqueEvents(events: QualityEvent[]): QualityEvent[] {
  const out = new Map<string, QualityEvent>();
  for (const e of events) {
    const key = eventKey(e),
      previous = out.get(key);
    if (previous && canonical(previous) !== canonical(e))
      throw new QualityError("EVENT_CONFLICT");
    out.set(key, e);
  }
  return [...out.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, e]) => e);
}
export function validateLifecycle(intent: Intent, events: QualityEvent[]) {
  const rows = uniqueEvents(events);
  const fills = rows.filter((e): e is Fill => e.kind === "fill");
  const ack = rows.find((e): e is Ack => e.kind === "ack");
  requireValue(
    fills.reduce((s, f) => s + f.quantity, 0) <=
      intent.quantity + intent.quantity * 1e-10,
    "OVERFILL",
  );
  const orderIds = new Set(
    rows
      .filter((e): e is Fill | Ack => e.kind !== "benchmark")
      .map((e) => e.orderId),
  );
  requireValue(orderIds.size <= 1, "ORDER_MISMATCH");
  if (ack)
    for (const f of fills) {
      // Venue event clocks and local receipt clocks are intentionally not compared.
      if (f.elapsedSubmitMs !== null && ack.elapsedSubmitMs !== null)
        requireValue(
          f.elapsedSubmitMs >= ack.elapsedSubmitMs,
          "MONOTONIC_ORDER",
        );
    }
  for (const b of rows.filter(
    (e): e is Benchmark =>
      e.kind === "benchmark" && e.name.startsWith("adverse_"),
  )) {
    const f = fills.find((f) => f.fillId === b.fillId);
    requireValue(!!f, "UNKNOWN_FILL");
    const horizon = Number(b.name.split("_")[1]);
    // Fixed horizon, at most 1s quote age; later quotes are never substituted.
    if (b.price !== null)
      requireValue(
        b.eventTime <= f.eventTime + horizon &&
          b.eventTime >= f.eventTime + horizon - 1000 &&
          b.availableAt <= f.eventTime + horizon,
        "HORIZON_LOOK_AHEAD",
      );
  }
}
export interface Metric {
  value: number | null;
  reason: Reason | null;
}
const missing = (): Metric => ({ value: null, reason: "MISSING" });
const value = (n: number): Metric => {
  if (!Number.isFinite(n)) throw new QualityError("NUMERIC_OVERFLOW");
  return { value: n, reason: null };
};
/** Executed-quantity shortfall (not opportunity cost on unfilled quantity). */
export function cost(
  side: Intent["side"],
  price: number,
  qty: number,
  benchmark: Pick<Benchmark, "price" | "reason"> | undefined,
): { bps: Metric; quote: Metric } {
  if (!benchmark || benchmark.price === null) {
    const m = benchmark ? { value: null, reason: benchmark.reason } : missing();
    return { bps: m, quote: m };
  }
  const delta = (side === "buy" ? 1 : -1) * (price - benchmark.price);
  return {
    bps: value((delta / benchmark.price) * 10000),
    quote: value(delta * qty),
  };
}
export function summarize(intent: Intent, input: QualityEvent[], asOf: number) {
  const visible = input.filter((e) => e.availableAt <= asOf);
  const visibleFillIds = new Set(
    visible.filter((e): e is Fill => e.kind === "fill").map((e) => e.fillId),
  );
  const events = uniqueEvents(
    visible.filter(
      (e) =>
        e.kind !== "benchmark" ||
        e.fillId === null ||
        visibleFillIds.has(e.fillId),
    ),
  );
  validateLifecycle(intent, events);
  const fills = events
    .filter((e): e is Fill => e.kind === "fill")
    .sort(
      (a, b) => a.eventTime - b.eventTime || compareText(a.fillId, b.fillId),
    );
  const benchmarks = events.filter(
    (e): e is Benchmark => e.kind === "benchmark",
  );
  const qty = fills.reduce((s, f) => s + f.quantity, 0);
  const notional = fills.reduce((s, f) => s + f.quantity * f.price, 0);
  const avgPrice = qty > 0 ? notional / qty : null;
  const bench = (name: Benchmark["name"]) =>
    benchmarks.find((b) => b.name === name);
  const metric = (name: Benchmark["name"]) =>
    avgPrice === null
      ? { bps: missing(), quote: missing() }
      : cost(intent.side, avgPrice, qty, bench(name));
  const ack = events.find((e): e is Ack => e.kind === "ack");
  const fee =
    fills.length && fills.every((f) => f.feeQuote !== null)
      ? value(fills.reduce((s, f) => s + f.feeQuote!, 0))
      : missing();
  const decision = metric("decision");
  const provenance = (name: Benchmark["name"]) => {
    const b = bench(name);
    return b?.price !== null && b?.price !== undefined
      ? b.quality
      : "unavailable";
  };
  const shortfallWithFees =
    decision.quote.value !== null && fee.value !== null
      ? value(decision.quote.value + fee.value)
      : missing();
  const adverse = [1000, 5000, 30000].map((horizon) => {
    let total = 0,
      covered = 0;
    for (const f of fills) {
      const b = benchmarks.find(
        (b) => b.name === `adverse_${horizon}` && b.fillId === f.fillId,
      );
      if (b?.price !== null && b?.price !== undefined) {
        // Positive = price subsequently moves against the filled position.
        total +=
          (((intent.side === "buy" ? 1 : -1) * (f.price - b.price)) / f.price) *
          10000 *
          f.quantity;
        covered += f.quantity;
      }
    }
    return {
      horizonMs: horizon,
      bps: covered ? value(total / covered) : missing(),
      quantityCoverage: qty ? covered / qty : 0,
    };
  });
  const first = fills[0],
    last = fills[fills.length - 1];
  return {
    filledQuantity: qty,
    fillRatio: Math.min(1, qty / intent.quantity),
    avgPrice,
    provenance: {
      decision: provenance("decision"),
      arrival: provenance("arrival"),
      vwap: provenance("interval_vwap"),
    },
    limit:
      avgPrice === null
        ? { bps: missing(), quote: missing() }
        : cost(intent.side, avgPrice, qty, {
            price: intent.limitPrice,
            reason: intent.limitPrice === null ? "MISSING" : null,
          }),
    notional,
    fees: fee,
    decision,
    arrival: metric("arrival"),
    vwap: metric("interval_vwap"),
    shortfallWithFees,
    decisionAt: intent.decisionAt,
    submitAt: intent.submitAt,
    ackAt: ack?.eventTime ?? null,
    decisionToSubmitMs: intent.decisionElapsedSubmitMs ?? null,
    timeToAckMs: ack?.elapsedSubmitMs ?? null,
    timeToFirstMs: first?.elapsedSubmitMs ?? null,
    timeToCompleteMs:
      qty >= intent.quantity * (1 - 1e-10)
        ? (last?.elapsedSubmitMs ?? null)
        : null,
    firstFillAt: first?.eventTime ?? null,
    lastFillAt: last?.eventTime ?? null,
    shortfallWithFeesBps:
      shortfallWithFees.value !== null && bench("decision")?.price && qty
        ? value(
            (shortfallWithFees.value / (qty * bench("decision")!.price!)) *
              10000,
          )
        : missing(),
    adverse,
    fillCount: fills.length,
  };
}
/** Linear interpolation (R7). A single sample has identical p50/p95. */
export function percentile(values: number[], p: number): number | null {
  if (!(p >= 0 && p <= 1) || values.some((v) => !Number.isFinite(v)))
    throw new QualityError("INVALID_PERCENTILE");
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    rank = (sorted.length - 1) * p,
    lo = Math.floor(rank);
  return sorted[lo] + (sorted[Math.ceil(rank)] - sorted[lo]) * (rank - lo);
}
/** Bounded report; quote currencies NEVER combine. Order IDs are not labels. */
export function aggregate(batches: Batch[], asOf: number) {
  if (batches.length > 500) throw new QualityError("REPORT_LIMIT");
  const groups = new Map<
    string,
    {
      dimensions: Pick<
        Intent,
        "venue" | "mode" | "strategy" | "orderType" | "quoteCurrency"
      >;
      rows: ReturnType<typeof summarize>[];
    }
  >();
  for (const b of [...batches].sort((a, b) =>
    compareText(a.intent.id, b.intent.id),
  )) {
    const { venue, mode, strategy, orderType, quoteCurrency } = b.intent;
    const dimensions = { venue, mode, strategy, orderType, quoteCurrency },
      key = canonical(dimensions);
    const group = groups.get(key) ?? { dimensions, rows: [] };
    group.rows.push(summarize(b.intent, b.events, asOf));
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, { dimensions, rows }]) => {
      const statistics = (
        select: (r: (typeof rows)[number]) => number | null,
      ) => {
        const covered = rows.filter((r) => select(r) !== null),
          values = covered.map((r) => select(r)!);
        const weight = covered.reduce((s, r) => s + r.notional, 0);
        return {
          count: values.length,
          coverage: rows.length ? values.length / rows.length : 0,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          notionalWeightedMean:
            weight && dimensions.quoteCurrency !== "UNKNOWN"
              ? covered.reduce((s, r) => s + select(r)! * r.notional, 0) /
                weight
              : null,
        };
      };
      const provenanceCoverage = (name: "arrival" | "decision" | "vwap") => ({
        observed: rows.filter((r) => r.provenance[name] === "observed").length,
        modeled: rows.filter((r) => r.provenance[name] === "modeled").length,
        unavailable: rows.filter((r) => r.provenance[name] === "unavailable")
          .length,
      });
      const sumKnown = (select: (r: (typeof rows)[number]) => number | null) =>
        rows.every((r) => select(r) !== null) &&
        dimensions.quoteCurrency !== "UNKNOWN"
          ? rows.reduce((s, r) => s + select(r)!, 0)
          : null;
      return {
        ...dimensions,
        provenance: {
          arrival: provenanceCoverage("arrival"),
          decision: provenanceCoverage("decision"),
          vwap: provenanceCoverage("vwap"),
        },
        feesQuote: {
          ...statistics((r) => r.fees.value),
          sum: sumKnown((r) => r.fees.value),
        },
        shortfallQuote: {
          ...statistics((r) => r.shortfallWithFees.value),
          sum: sumKnown((r) => r.shortfallWithFees.value),
        },
        shortfallBps: statistics((r) => r.shortfallWithFeesBps.value),
        arrivalQuote: {
          ...statistics((r) => r.arrival.quote.value),
          sum: sumKnown((r) => r.arrival.quote.value),
        },
        decisionQuote: {
          ...statistics((r) => r.decision.quote.value),
          sum: sumKnown((r) => r.decision.quote.value),
        },
        vwapQuote: {
          ...statistics((r) => r.vwap.quote.value),
          sum: sumKnown((r) => r.vwap.quote.value),
        },
        decisionToSubmitMs: statistics((r) => r.decisionToSubmitMs),
        adverse: [0, 1, 2].map((index) => ({
          horizonMs: [1000, 5000, 30000][index],
          ...statistics((r) => r.adverse[index].bps.value),
          quantityCoverage:
            rows.reduce(
              (s, r) =>
                s + r.adverse[index].quantityCoverage * r.filledQuantity,
              0,
            ) / (rows.reduce((s, r) => s + r.filledQuantity, 0) || 1),
        })),
        orderCount: rows.length,
        fillCount: rows.reduce((s, r) => s + r.fillCount, 0),
        limitBps: statistics((r) => r.limit.bps.value),
        arrivalBps: statistics((r) => r.arrival.bps.value),
        decisionBps: statistics((r) => r.decision.bps.value),
        vwapBps: statistics((r) => r.vwap.bps.value),
        fillRatio: statistics((r) => r.fillRatio),
        timeToAckMs: statistics((r) => r.timeToAckMs),
        timeToFirstMs: statistics((r) => r.timeToFirstMs),
        timeToCompleteMs: statistics((r) => r.timeToCompleteMs),
      };
    });
}

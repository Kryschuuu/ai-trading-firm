import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  canonical,
  cost,
  digest,
  parseBatch,
  percentile,
  summarize,
  validateLifecycle,
  type Benchmark,
} from "../src/executionQuality/model";
import { reportRange } from "../src/executionQuality/store";
import { benchmark, fill, fixture, intent } from "./fixtures/executionQuality";

test("buy/sell costs have adverse-positive sign, including price improvement", () => {
  assert.equal(cost("buy", 101, 4, benchmark).bps.value, 100);
  assert.equal(cost("sell", 101, 4, benchmark).bps.value, -100);
  assert.equal(cost("sell", 99, 4, benchmark).quote.value, 4);
  assert.equal(cost("buy", 99, 4, benchmark).quote.value, -4);
});
test("partial fills are quantity weighted, duplicate events do not count twice", () => {
  const b = fixture();
  parseBatch(b);
  const out = summarize(b.intent, [...b.events, fill], 20000);
  assert.equal(out.fillCount, 2);
  assert.equal(out.filledQuantity, 10);
  assert.equal(out.avgPrice, 101.6);
  assert.equal(out.fillRatio, 1);
  assert.ok(Math.abs(out.decision.bps.value! - 160) < 1e-10);
  assert.ok(Math.abs(out.shortfallWithFees.value! - 17) < 1e-10);
  assert.equal(out.fees.value, 1);
  assert.equal(out.timeToAckMs, 100);
  assert.equal(out.timeToFirstMs, 1000);
  assert.equal(out.timeToCompleteMs, 2000);
  const partial = summarize(intent, [fill], 12000);
  assert.equal(partial.fillRatio, 0.4);
  assert.equal(partial.timeToCompleteMs, null);
});
test("absent/stale/VWAP benchmarks and missing fees remain unknown", () => {
  const out = summarize(
    intent,
    [{ ...fill, feeQuote: null, feeReason: "MISSING" }],
    20000,
  );
  assert.deepEqual(out.arrival.bps, { value: null, reason: "MISSING" });
  assert.deepEqual(out.vwap.bps, { value: null, reason: "MISSING" });
  assert.equal(out.fees.value, null);
  assert.equal(out.shortfallWithFees.value, null);
  assert.deepEqual(
    cost("buy", 101, 4, { ...benchmark, price: null, reason: "STALE" }).bps,
    { value: null, reason: "STALE" },
  );
});
test("negative paths: unknown fields, invalid numbers, overfill, conflict, lookahead and stale", () => {
  assert.throws(
    () => parseBatch({ ...fixture(), rawPayload: "secret" }),
    /UNEXPECTED_FIELDS/,
  );
  for (const n of [NaN, Infinity, 0, -1])
    assert.throws(() =>
      parseBatch({ intent: { ...intent, quantity: n }, events: [] }),
    );
  assert.throws(
    () =>
      parseBatch({ intent, events: [{ ...benchmark, availableAt: 10001 }] }),
    /LOOK_AHEAD/,
  );
  assert.throws(
    () =>
      parseBatch({
        intent,
        events: [{ ...benchmark, eventTime: 1, windowEnd: 1, availableAt: 1 }],
      }),
    /STALE_BENCHMARK/,
  );
  assert.throws(
    () => validateLifecycle(intent, [{ ...fill, quantity: 11 }]),
    /OVERFILL/,
  );
  assert.throws(
    () => summarize(intent, [fill, { ...fill, price: 102 }], 20000),
    /EVENT_CONFLICT/,
  );
  assert.throws(
    () =>
      validateLifecycle(intent, [
        fill,
        { ...fill, fillId: "other", orderId: "other" },
      ]),
    /ORDER_MISMATCH/,
  );
  assert.throws(() =>
    parseBatch({
      intent,
      events: [{ ...fill, feeQuote: null, feeReason: null }],
    }),
  );
});
test("backtest/paper modeled fills versus live/testnet observed; no invented provenance", () => {
  for (const mode of ["paper", "backtest"] as const) {
    parseBatch({ intent: { ...intent, mode }, events: [fill] });
    assert.throws(
      () =>
        parseBatch({
          intent: { ...intent, mode },
          events: [{ ...fill, quality: "observed" }],
        }),
      /MODE_QUALITY_MISMATCH/,
    );
  }
  for (const mode of ["live", "testnet"] as const) {
    parseBatch({
      intent: { ...intent, mode },
      events: [{ ...fill, quality: "observed" }],
    });
    assert.throws(
      () => parseBatch({ intent: { ...intent, mode }, events: [fill] }),
      /MODE_QUALITY_MISMATCH/,
    );
  }
});
test("as-of availability excludes later fills, and fixed horizon never looks forward", () => {
  const b = fixture();
  assert.equal(summarize(intent, b.events, 12000).filledQuantity, 4);
  const adverse: Benchmark = {
    ...benchmark,
    name: "adverse_1000",
    fillId: fill.fillId,
    eventTime: 13000,
    windowEnd: 13000,
    availableAt: 13000,
    computedAt: 13000,
    price: 100,
  };
  validateLifecycle(intent, [fill, adverse]);
  const out = summarize(intent, [fill, adverse], 13000);
  assert.ok(Math.abs(out.adverse[0].bps.value! - 10000 / 101) < 1e-10);
  assert.equal(
    summarize(intent, [fill, adverse], 12500).adverse[0].bps.value,
    null,
  );
  assert.throws(
    () => validateLifecycle(intent, [fill, { ...adverse, eventTime: 13001 }]),
    /HORIZON_LOOK_AHEAD/,
  );
});
test("analytical R7 p50/p95, weighted aggregate, coverage and currency isolation", () => {
  assert.equal(percentile([0, 10, 20], 0.5), 10);
  assert.equal(percentile([0, 10, 20], 0.95), 19);
  assert.equal(percentile([], 0.5), null);
  const b = fixture();
  const b2 = fixture();
  b2.intent = { ...b2.intent, id: "intent-2", clientOrderId: "client-2" };
  b2.events = b2.events
    .filter((e) => e.kind !== "benchmark")
    .map((e) => ({ ...e, intentId: "intent-2" }));
  const [out] = aggregate([b, b2], 20000);
  assert.equal(out.arrivalBps.coverage, 0.5);
  assert.equal(out.arrivalBps.count, 1);
  assert.ok(Math.abs(out.arrivalBps.notionalWeightedMean! - 160) < 1e-10);
  b2.intent.quoteCurrency = "EUR";
  assert.equal(aggregate([b, b2], 20000).length, 2);
  assert.throws(() => reportRange(0, 32 * 86400000, 32 * 86400000));
  assert.throws(() => reportRange(0, 100, 99));
});
test("golden execution output and deterministic input order/retry", () => {
  const b = fixture(),
    out = summarize(b.intent, b.events, 20000);
  assert.equal(
    digest(out),
    digest(summarize(b.intent, [...b.events].reverse(), 20000)),
  );
  assert.equal(
    canonical(out),
    canonical(summarize(b.intent, [...b.events, ...b.events], 20000)),
  );
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.deepEqual(
    {
      qty: out.filledQuantity,
      price: out.avgPrice,
      fees: out.fees.value,
      ratio: out.fillRatio,
      ack: out.timeToAckMs,
    },
    { qty: 10, price: 101.6, fees: 1, ratio: 1, ack: 100 },
  );
});

test("two-price analytical aggregate uses notional weights, not order counts", () => {
  const a = { intent, events: [benchmark, fill] };
  const other = { ...intent, id: "intent-2", clientOrderId: "client-2" };
  const b = {
    intent: other,
    events: [
      { ...benchmark, intentId: other.id },
      { ...fill, intentId: other.id, price: 102, quantity: 6 },
    ],
  };
  const [group] = aggregate([a, b], 20000);
  assert.equal(group.decisionBps.p50, 150);
  assert.equal(group.decisionBps.p95, 195);
  assert.ok(
    Math.abs(
      group.decisionBps.notionalWeightedMean! - (100 * 404 + 200 * 612) / 1016,
    ) < 1e-10,
  );
});

test("API authenticates before DB access and rejects unbounded queries", async () => {
  const keys = [
    "FIRM_ADMIN_TOKEN",
    "FIRM_API_TOKEN",
    "FIRM_VIEWER_TOKEN",
    "FIRM_SESSION_SECRET",
    "AUTH_MODE",
  ];
  const saved = keys.map((k) => process.env[k]);
  try {
    keys.forEach((k) => delete process.env[k]);
    process.env.FIRM_API_TOKEN = "execution-quality-test-credential";
    const { GET } = await import("../src/app/api/firm/execution-quality/route");
    const url = "https://trading.example.test/api/firm/execution-quality";
    assert.equal((await GET(new Request(url))).status, 401);
    delete process.env.FIRM_API_TOKEN;
    for (const query of [
      "",
      "?from=0&to=9999999999&asOf=9999999999",
      "?from=0&to=100&asOf=99",
    ]) {
      const res = await GET(new Request(url + query));
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    }
  } finally {
    keys.forEach((k, index) => {
      if (saved[index] === undefined) delete process.env[k];
      else process.env[k] = saved[index];
    });
  }
});

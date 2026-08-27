/**
 * Normalisierung & Anomalie-Erkennung (Task 03).
 * NaN, Sprung > Schwellwert und stale Timestamps werden verworfen (nie gehandelt).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSnapshot, type RawSnapshotInput } from "../src/lib/marketdata/normalization";
import { AnomalousSnapshotError } from "../src/lib/marketdata/types";

const now = 1_750_000_000_000;

function raw(over: Partial<RawSnapshotInput> = {}): RawSnapshotInput {
  return {
    instrumentId: "PAPER:BTC",
    symbol: "BTC",
    base: "BTC",
    quote: "USD",
    bid: 67450,
    ask: 67453,
    last: 67451,
    ts: now,
    source: "binance",
    venue: "BINANCE",
    feed: "binance",
    ...over,
  };
}

const opts = { maxAgeMs: 30_000, maxJumpPct: 50, maxSpread: 0.2, now };

test("Normalisierung: gültiger Snapshot → MarketSnapshot mit Spread", () => {
  const s = normalizeSnapshot(raw(), opts);
  assert.equal(s.instrumentId, "PAPER:BTC");
  assert.ok(s.spread > 0);
  assert.ok(s.ask >= s.bid);
});

test("Normalisierung: NaN/≤0-Preise werden verworfen", () => {
  assert.throws(() => normalizeSnapshot(raw({ bid: NaN }), opts), AnomalousSnapshotError);
  assert.throws(() => normalizeSnapshot(raw({ ask: 0 }), opts), AnomalousSnapshotError);
  assert.throws(() => normalizeSnapshot(raw({ last: Number.NEGATIVE_INFINITY }), opts), AnomalousSnapshotError);
});

test("Normalisierung: ask < bid wird verworfen", () => {
  assert.throws(() => normalizeSnapshot(raw({ bid: 67453, ask: 67450 }), opts), /ask < bid/);
});

test("Normalisierung: zu großer Spread wird verworfen", () => {
  assert.throws(
    () => normalizeSnapshot(raw({ bid: 10, ask: 30 }), opts),
    /Spread .* Limit/
  );
});

test("Normalisierung: staler Timestamp wird verworfen", () => {
  assert.throws(() => normalizeSnapshot(raw({ ts: now - 120_000 }), opts), /stale/);
});

test("Normalisierung: Kurssprung über Schwellwert wird verworfen", () => {
  const prev = normalizeSnapshot(raw(), opts);
  assert.throws(
    () => normalizeSnapshot(raw({ last: prev.last * 2 }), { ...opts, prev }),
    /Kurssprung/
  );
});

test("Normalisierung: Sprung unter Schwellwert wird akzeptiert", () => {
  const prev = normalizeSnapshot(raw(), opts);
  const s = normalizeSnapshot(raw({ last: prev.last * 1.01 }), { ...opts, prev });
  assert.equal(s.last, prev.last * 1.01);
});

test("Normalisierung: maxAgeMs=Infinity deaktiviert Stale-Check (Replay)", () => {
  const s = normalizeSnapshot(raw({ ts: now - 3_600_000 }), { ...opts, maxAgeMs: Infinity });
  assert.equal(s.ts, now - 3_600_000);
});

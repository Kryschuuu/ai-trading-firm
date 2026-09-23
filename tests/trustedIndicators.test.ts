import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import {
  applyTrustedReadings,
  closedCandles,
  loadTrustedIndicators,
  TRUSTED_INDICATOR_VERSION,
} from "../src/cycle/trustedIndicators";

const HOUR = 60 * 60_000;
const ASOF = Date.parse("2026-01-05T00:00:00.000Z");

test("closedCandles verwirft die offene Stunde und kappt auf 120", () => {
  const entries = Array.from({ length: 130 }, (_, i) => ({
    ts: ASOF - (130 - i) * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + i * 0.1,
    volume: 1,
  }));
  entries.push({ ts: ASOF, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  const closed = closedCandles(entries, ASOF);
  assert.equal(closed.length, 120);
  assert.ok(closed.every((candle) => candle.time + HOUR <= ASOF));
});

test("loadTrustedIndicators überschreibt RSI und erfindet bei zu wenig Bars kein 50", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trusted-ind-"));
  try {
    const store = new HistoricalStore(dir);
    const candles = Array.from({ length: 40 }, (_, i) => {
      const close = 100 + i;
      return { time: ASOF - (40 - i) * HOUR, open: close - 1, high: close + 1, low: close - 1, close, volume: 10 };
    });
    store.append(candles, "BITUNIX:BTCUSDT", { venue: "BITUNIX", feed: "test" }, "1h", new Date(ASOF));
    store.append(
      [{ time: ASOF - 2 * HOUR, open: 1, high: 2, low: 1, close: 1, volume: 1 }],
      "SHORT",
      { venue: "PAPER", feed: "test" },
      "1h",
      new Date(ASOF),
    );
    const readings = loadTrustedIndicators(store, ["BITUNIX:BTCUSDT", "SHORT", "MISSING"], ASOF);
    const measured = readings.get("BITUNIX:BTCUSDT");
    assert.ok(measured);
    assert.ok(measured.rsi != null && measured.rsi > 50);
    assert.ok(measured.atr != null && measured.atr > 0);
    assert.equal(readings.get("SHORT")?.rsi, null);
    assert.equal(readings.get("MISSING")?.rsi, null);

    const analyses = [
      { instrumentId: "BITUNIX:BTCUSDT", rsi: 12, atr: 99 },
      { instrumentId: "SHORT", rsi: 50, atr: 1 },
    ];
    applyTrustedReadings(analyses, readings);
    assert.equal(analyses[0].rsi, measured.rsi);
    assert.equal(analyses[0].atr, measured.atr);
    assert.equal("rsi" in analyses[1], false);
    assert.equal("atr" in analyses[1], false);
    assert.equal(TRUSTED_INDICATOR_VERSION, "trusted-indicators@1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

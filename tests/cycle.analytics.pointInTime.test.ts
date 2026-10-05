/** AnalyticsPort alignment and no-lookahead tests for TASK 05. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultAnalyticsPort } from "../src/cycle/ports";
import { HistoricalStore, type SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../src/lib/marketdata/types";

const AS_OF = Date.parse("2026-10-05T12:00:00.000Z");
const HOUR = 3_600_000;

function candles(start: number, closes: readonly number[]): MarketCandle[] {
  return closes.map((close, index) => ({
    time: start + index * HOUR,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 100,
  }));
}

test("DefaultAnalyticsPort richtet Serien aus und ignoriert Kerzen-/Abrufzeiten nach asOf", async () => {
  const previousHistoryDir = process.env.PAPER_HISTORY_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "cycle-analytics-pit-"));
  process.env.PAPER_HISTORY_DIR = dir;
  try {
    const store = new HistoricalStore(dir);
    const t0 = AS_OF - 6 * HOUR;
    const fetchedBeforeAsOf = new Date(AS_OF - HOUR);
    store.append(
      candles(t0, [100, 103, 101, 105, 104, 109, 112, 120]),
      "BITUNIX:BTCUSDT",
      { venue: "BITUNIX", feed: "fixture" },
      "1h" satisfies SupportedTimeframe,
      fetchedBeforeAsOf,
    );
    store.append(
      candles(t0 + HOUR, [50, 49, 52, 51, 55, 60, 65, 70]),
      "BITUNIX:ETHUSDT",
      { venue: "BITUNIX", feed: "fixture" },
      "1h" satisfies SupportedTimeframe,
      fetchedBeforeAsOf,
    );
    // A row describing old market time but learned only after `asOf` must not
    // leak into a historical/replay analysis either.
    store.append(
      [{ time: t0 + 2 * HOUR, open: 999, high: 1_010, low: 990, close: 1_000, volume: 1 }],
      "BITUNIX:BTCUSDT",
      { venue: "BITUNIX", feed: "late-correction" },
      "1h",
      new Date(AS_OF + HOUR),
    );

    const analytics = await new DefaultAnalyticsPort().computeCorrelationAndRisk(
      ["BITUNIX:BTCUSDT", "BITUNIX:ETHUSDT"],
      new Date(AS_OF),
    );
    const btc = analytics.portfolioSeriesBySymbol?.["BITUNIX:BTCUSDT"];
    const eth = analytics.portfolioSeriesBySymbol?.["BITUNIX:ETHUSDT"];
    assert.ok(btc && eth);
    assert.ok(btc.timestamps.every((timestamp) => timestamp <= AS_OF));
    assert.ok(eth.timestamps.every((timestamp) => timestamp <= AS_OF));
    assert.equal(btc.timestamps.at(-1), AS_OF, "post-asOf market bar is excluded");
    assert.notEqual(btc.prices[2], 1_000, "post-asOf correction is excluded by fetchedAt");
    assert.ok(analytics.correlations["BITUNIX:BTCUSDT"]["BITUNIX:ETHUSDT"] !== undefined);
  } finally {
    if (previousHistoryDir === undefined) delete process.env.PAPER_HISTORY_DIR;
    else process.env.PAPER_HISTORY_DIR = previousHistoryDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

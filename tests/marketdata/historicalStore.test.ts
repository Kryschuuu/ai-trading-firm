import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_MAX_BARS_PER_SERIES } from "../../src/lib/marketdata/limits";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import type { SupportedTimeframe } from "../../src/lib/marketdata/timeframes";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "historical-store-retention-"));
}

test("HistoricalStore default retention follows the shared per-series bar limit", () => {
  const dir = temporaryDirectory();
  try {
    const store = new HistoricalStore(dir);
    assert.equal(store.maxBarsPerSeries, DEFAULT_MAX_BARS_PER_SERIES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HistoricalStore compaction retains the newest bars of each series", () => {
  const dir = temporaryDirectory();
  try {
    const store = new HistoricalStore(dir, { maxBarsPerSeries: 2 });
    const timeframe: SupportedTimeframe = "1h";
    const candles = [1, 2, 3].map((time) => ({
      time,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 1,
    }));
    store.append(candles, "BTCUSDT", { venue: "TEST", feed: "fixture" }, timeframe, new Date(0));

    assert.deepEqual(
      store.query({ instrumentId: "BTCUSDT", timeframe }).map(({ ts }) => ts),
      [2, 3],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

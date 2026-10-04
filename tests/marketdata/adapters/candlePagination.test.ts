/** Bounded historical page aggregation independent of any venue HTTP client. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchCandlesBackward, fetchCandlesForward } from "../../../src/marketdata/adapters/candlePagination";
import type { MarketCandle } from "../../../src/marketdata/types";

function candle(time: number): MarketCandle {
  return { time, open: 10, high: 11, low: 9, close: 10.5, volume: 1 };
}

function times(rows: readonly MarketCandle[]): number[] {
  return rows.map((row) => row.time ?? 0);
}

test("backward paging aggregates several bounded pages and applies inclusive range limits", async () => {
  const source = Array.from({ length: 10 }, (_, i) => candle((i + 1) * 1_000));
  const cursors: number[] = [];
  const rows = await fetchCandlesBackward({
    limit: 7,
    pageSize: 3,
    nowMs: 10_000,
    range: { from: 4_000, to: 10_000 },
    fetchPage: async (pageLimit, endTimeMs) => {
      cursors.push(endTimeMs);
      return source.filter((row) => (row.time ?? 0) < endTimeMs).slice(-pageLimit);
    },
  });
  assert.deepEqual(times(rows), [4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000]);
  assert.equal(cursors.length, 3, "7 rows are gathered over pages of 3, 3, and 1");
  assert.ok(cursors[1] < cursors[0] && cursors[2] < cursors[1], "each request moves its end cursor backward");
});

test("backward paging stops on a repeated/ignored page instead of exhausting the request budget", async () => {
  const repeated = [candle(8_000), candle(9_000), candle(10_000)];
  let calls = 0;
  const rows = await fetchCandlesBackward({
    limit: 9,
    pageSize: 3,
    nowMs: 10_000,
    range: { from: 1_000 },
    fetchPage: async () => {
      calls += 1;
      return repeated;
    },
  });
  assert.deepEqual(times(rows), [8_000, 9_000, 10_000]);
  assert.equal(calls, 2, "the second page makes no cursor progress and terminates");
});

test("forward since paging uses venue cursors and returns sorted, unique candles", async () => {
  const source = Array.from({ length: 10 }, (_, i) => candle((i + 1) * 1_000));
  const sinceRequests: number[] = [];
  const rows = await fetchCandlesForward({
    limit: 10,
    pageSize: 3,
    intervalMs: 1_000,
    nowMs: 10_000,
    range: { from: 1_000, to: 10_000 },
    fetchPage: async (sinceSeconds, pageSize) => {
      sinceRequests.push(sinceSeconds);
      const page = source
        .filter((row) => Math.floor((row.time ?? 0) / 1000) >= sinceSeconds)
        .slice(0, pageSize);
      const last = page.at(-1)?.time ?? 0;
      return { candles: page, nextSinceSeconds: Math.floor(last / 1000) + 1 };
    },
  });
  assert.deepEqual(times(rows), source.map((row) => row.time ?? 0));
  assert.deepEqual(sinceRequests, [1, 4, 7, 10]);
});

test("forward paging falls back from a stale Kraken `last` cursor and terminates on no progress", async () => {
  const source = [candle(1_000), candle(2_000), candle(3_000), candle(4_000)];
  let calls = 0;
  const rows = await fetchCandlesForward({
    limit: 4,
    pageSize: 2,
    intervalMs: 1_000,
    nowMs: 4_000,
    range: { from: 1_000, to: 4_000 },
    fetchPage: async (sinceSeconds, pageSize) => {
      calls += 1;
      const page = source.filter((row) => Math.floor((row.time ?? 0) / 1000) >= sinceSeconds).slice(0, pageSize);
      // A Kraken fixture may return a stale `last`; page timestamps remain a safe fallback.
      return { candles: page, nextSinceSeconds: sinceSeconds };
    },
  });
  assert.deepEqual(times(rows), [1_000, 2_000, 3_000, 4_000]);
  assert.equal(calls, 2);
});

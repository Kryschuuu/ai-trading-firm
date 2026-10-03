/**
 * STX-08-04 pre-change golden reference.
 *
 * The hashes in this file are frozen against the original O(n²)
 * `backtestRule()` implementation before it was switched to the indicator
 * cache. Each digest covers the complete backtest result (trades + metrics)
 * and every direct-path snapshot for 3 symbols × 2 timeframes. The fixture
 * rules carry stop, target, and cooldown settings; both exit reasons occur.
 *
 * Do not update a digest to make a failing test pass without explicit review:
 * byte identity is the acceptance criterion for this migration.
 */
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backtestRule,
  buildSnapshotFromCandles,
  type CandleLike,
  type RuleSpec,
} from "../src/lib/ruleEngine";

const TIMEFRAMES = {
  "1h": 3_600_000,
  "1d": 86_400_000,
} as const;

type GoldenAsset = {
  symbol: string;
  startPrice: number;
  trend: number;
  phase: number;
};

const ASSETS: readonly GoldenAsset[] = [
  { symbol: "BTCUSDT", startPrice: 30_000, trend: 0.00035, phase: 0.17 },
  { symbol: "ETHUSDT", startPrice: 2_000, trend: -0.00015, phase: 1.23 },
  { symbol: "SOLUSDT", startPrice: 50, trend: 0.00008, phase: 2.41 },
];

const GOLDEN_SHA256: Record<string, string> = {
  "BTCUSDT/1h": "8c0483b48c686eb1f5a33711442188df1125e8e09b0893d3236cdbfbcd926369",
  "BTCUSDT/1d": "6bb3fc0db208dc38afbf553a88d7f501f08e3dd38c9831e3a017c7734ae5a957",
  "ETHUSDT/1h": "c08ee944ca1ef9308fd921d5da502361c5316dbf65f0380fe61ddb595a8c567b",
  "ETHUSDT/1d": "294259c68b23964d690e519b664e68b0168ffa130bd2b31e5e67eb87678d1250",
  "SOLUSDT/1h": "6fe7a36ca0df49f0d7e99cede75a3b068ac2952f803d0fc0b84fc037627e7bbb",
  "SOLUSDT/1d": "2f5a890da2bdd02925751ef0c1f9adb1825123e165bdcbea495a760ba7c4fae6",
};

function makeCandles(asset: GoldenAsset, stepMs: number): CandleLike[] {
  let price = asset.startPrice;
  return Array.from({ length: 120 }, (_, i) => {
    const change =
      Math.sin(i * 0.41 + asset.phase) * 0.008 +
      Math.cos(i * 0.113 + asset.phase) * 0.004 +
      asset.trend;
    const open = Number(price.toFixed(8));
    const close = Number((price * (1 + change)).toFixed(8));
    const high = Number((Math.max(open, close) * (1.006 + (i % 3) * 0.0004)).toFixed(8));
    const low = Number((Math.min(open, close) * (1 - 0.006 - (i % 4) * 0.0003)).toFixed(8));
    const volume = 1_000 + (i % 13) * 173 + (i % 5) * 13;
    price = close;
    return {
      time: Date.UTC(2026, 0, 1) + i * stepMs,
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

function ruleFor(asset: GoldenAsset, timeframe: keyof typeof TIMEFRAMES): RuleSpec {
  return {
    name: `Golden ${asset.symbol} ${timeframe}`,
    symbol: asset.symbol,
    missionId: null,
    rationale: "STX-08-04 pre-cache golden reference",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: 0 }] },
    action: {
      side: "LONG",
      stopLossPct: 0.8,
      takeProfitRR: 1.25,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
      positionSizeMode: "risk",
    },
    window: {
      timeframe,
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 5,
      cooldownMinutes: 180,
      volumeWindow: 20,
    },
  };
}

test("STX-08-04: pre-cache Golden bleibt über Trades, Kennzahlen und Snapshots byte-identisch", () => {
  const observedReasons = new Set<string>();
  let caseCount = 0;

  for (const asset of ASSETS) {
    for (const timeframe of Object.keys(TIMEFRAMES) as (keyof typeof TIMEFRAMES)[]) {
      const stepMs = TIMEFRAMES[timeframe];
      const candles = makeCandles(asset, stepMs);
      const spec = ruleFor(asset, timeframe);
      const result = backtestRule(spec, candles, { startingEquity: 10_000, warmup: 30 });
      const snapshots = candles.map((_, index) =>
        buildSnapshotFromCandles(spec.symbol, candles.slice(0, index + 1), spec.window.volumeWindow),
      );
      const referenceBytes = JSON.stringify({
        symbol: asset.symbol,
        timeframe,
        result,
        snapshots,
      });
      const digest = createHash("sha256").update(referenceBytes).digest("hex");
      const key = `${asset.symbol}/${timeframe}`;

      assert.ok(result.trades.length > 0, `${key}: fixture must exercise completed trades`);
      assert.equal(spec.action.stopLossPct, 0.8, `${key}: stop-loss setting is part of the fixture`);
      assert.equal(spec.action.takeProfitRR, 1.25, `${key}: target setting is part of the fixture`);
      assert.equal(spec.window.cooldownMinutes, 180, `${key}: cooldown setting is part of the fixture`);
      for (const trade of result.trades) observedReasons.add(trade.reason);
      assert.equal(digest, GOLDEN_SHA256[key], `${key}: pre-cache SHA-256 changed`);
      caseCount += 1;
    }
  }

  assert.equal(caseCount, 6, "3 Symbole × 2 Timeframes sind eingefroren");
  assert.deepEqual([...observedReasons].sort(), ["STOP_LOSS", "TAKE_PROFIT"]);
  assert.deepEqual(Object.keys(GOLDEN_SHA256).sort(), [
    "BTCUSDT/1d",
    "BTCUSDT/1h",
    "ETHUSDT/1d",
    "ETHUSDT/1h",
    "SOLUSDT/1d",
    "SOLUSDT/1h",
  ]);
});

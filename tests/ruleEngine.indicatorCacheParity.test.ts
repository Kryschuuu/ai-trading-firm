/** STX-08-04: exact RuleSnapshot parity between direct and cached paths. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIndicatorCache, snapshotFromCache } from "../src/backtest/indicatorCache";
import {
  backtestRule,
  buildSnapshotFromCandles,
  type CandleLike,
  type RuleSnapshot,
  type RuleSpec,
} from "../src/lib/ruleEngine";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RULE_FIELD_KEYS = Object.keys(RULE_FIELDS) as (keyof typeof RULE_FIELDS)[];

interface FixtureAsset {
  symbol: string;
  startPrice: number;
  trend: number;
  phase: number;
}

const ASSETS: readonly FixtureAsset[] = [
  { symbol: "BTCUSDT", startPrice: 30_000, trend: 0.00035, phase: 0.17 },
  { symbol: "ETHUSDT", startPrice: 2_000, trend: -0.00015, phase: 1.23 },
  { symbol: "SOLUSDT", startPrice: 50, trend: 0.00008, phase: 2.41 },
];

function makeCandles(asset: FixtureAsset, stepMs: number, count = 120): CandleLike[] {
  let price = asset.startPrice;
  return Array.from({ length: count }, (_, i) => {
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
    return { time: Date.UTC(2026, 0, 1) + i * stepMs, open, high, low, close, volume };
  });
}

function assertRuleFieldsEqual(direct: RuleSnapshot, cached: RuleSnapshot, context: string): void {
  for (const field of RULE_FIELD_KEYS) {
    assert.ok(Object.hasOwn(direct, field), `${context}: direct snapshot lacks RULE_FIELDS.${field}`);
    assert.ok(Object.hasOwn(cached, field), `${context}: cached snapshot lacks RULE_FIELDS.${field}`);
    assert.strictEqual(
      cached[field],
      direct[field],
      `${context}: RULE_FIELDS.${field} direct=${String(direct[field])}, cache=${String(cached[field])}`,
    );
  }
}

function flatCandles(count: number, stepMs = HOUR_MS): CandleLike[] {
  return Array.from({ length: count }, (_, i) => ({
    time: Date.UTC(2026, 0, 1) + i * stepMs,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 100,
  }));
}

test("STX-08-04: vollständige RULE_FIELDS-Parität Bar für Bar auf 3 Symbolen × 2 Timeframes", () => {
  let comparedSnapshots = 0;

  for (const asset of ASSETS) {
    for (const [timeframe, stepMs] of [["1h", HOUR_MS], ["1d", DAY_MS]] as const) {
      const candles = makeCandles(asset, stepMs);
      const cache = buildIndicatorCache(candles);
      assert.equal(
        buildSnapshotFromCandles(asset.symbol, candles.slice(0, 24), 20),
        null,
        `${asset.symbol}/${timeframe}: direkter Snapshot fehlt vor 25 Kerzen`,
      );
      assert.equal(
        snapshotFromCache(asset.symbol, candles, cache, 23, 20),
        null,
        `${asset.symbol}/${timeframe}: Cache-Snapshot fehlt vor 25 Kerzen`,
      );

      for (let index = 24; index < candles.length; index++) {
        const direct = buildSnapshotFromCandles(
          asset.symbol,
          candles.slice(0, index + 1),
          20,
          0.0004,
          42_000,
        );
        const cached = snapshotFromCache(asset.symbol, candles, cache, index, 20, 0.0004, 42_000);
        assert.ok(direct && cached, `${asset.symbol}/${timeframe} idx=${index}: Snapshot fehlt`);
        assertRuleFieldsEqual(direct, cached, `${asset.symbol}/${timeframe} idx=${index}`);
        comparedSnapshots += 1;

        if (timeframe === "1d") {
          assert.equal(direct.vwapPct, null, `${asset.symbol}/${timeframe} idx=${index}: <2 UTC-Tagesbars`);
          assert.equal(cached.vwapPct, null, `${asset.symbol}/${timeframe} idx=${index}: Cache-VWAP muss null bleiben`);
        }
      }
    }
  }

  assert.equal(comparedSnapshots, 3 * 2 * (120 - 24));
});

test("STX-08-04: ATR-Nullsemantik auf flachen Kerzen bleibt im Backtest fail-closed", () => {
  const candles = flatCandles(50);
  const cache = buildIndicatorCache(candles);

  for (const index of [24, 30, 49]) {
    const direct = buildSnapshotFromCandles("BTCUSDT", candles.slice(0, index + 1), 20);
    const cached = snapshotFromCache("BTCUSDT", candles, cache, index, 20);
    assert.ok(direct && cached, `idx=${index}: Snapshot fehlt`);
    assertRuleFieldsEqual(direct, cached, `flache Reihe idx=${index}`);
    assert.equal(direct.atrPct, null, `idx=${index}: direkte ATR(0) ist null`);
    assert.equal(cached.atrPct, null, `idx=${index}: Cache darf ATR(0) nicht als Zahl 0 ausgeben`);
    assert.equal(direct.bbZScore, null, `idx=${index}: σ=0 hat keinen Bollinger-Z-Score`);
    assert.equal(direct.bbwPct, 0);
    assert.equal(direct.priceVsUpperBbPct, 0);
    assert.equal(direct.priceVsLowerBbPct, 0);
  }

  const flatRule: RuleSpec = {
    name: "ATR zero must fail closed",
    symbol: "BTCUSDT",
    missionId: null,
    rationale: "Preserve direct-path null semantics",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: { logic: "all", conditions: [{ field: "atrPct", op: "eq", value: 0 }] },
    action: {
      side: "LONG",
      stopLossPct: 5,
      takeProfitRR: 2,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 5,
      cooldownMinutes: 180,
      volumeWindow: 20,
    },
  };
  const result = backtestRule(flatRule, candles, { warmup: 30 });
  assert.equal(result.signals, 0, "ATR=0 darf keinen Entry aus einer Null-ATR-Messung erzeugen");
});

test("STX-08-04: null-Semantik von Bollinger- und Donchian-Feldern bleibt erhalten", () => {
  const start = Date.UTC(2026, 0, 1);
  const candles: CandleLike[] = Array.from({ length: 50 }, (_, index) => {
    const close = index === 49 ? 1 : -100;
    return {
      time: start + index * HOUR_MS,
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 100,
    };
  });
  const cache = buildIndicatorCache(candles);
  const direct = buildSnapshotFromCandles("BTCUSDT", candles, 20);
  const cached = snapshotFromCache("BTCUSDT", candles, cache, candles.length - 1, 20);
  assert.ok(direct && cached);
  assertRuleFieldsEqual(direct, cached, "nicht-positives Bollinger-Mittel / Donchian-Hoch");
  assert.equal(direct.bbwPct, null);
  assert.equal(direct.bbZScore, null);
  assert.equal(direct.priceVsUpperBbPct, null);
  assert.equal(direct.priceVsLowerBbPct, null);
  assert.equal(direct.donchianBreakoutPct, null);

  const normal = makeCandles(ASSETS[0], HOUR_MS);
  const normalCache = buildIndicatorCache(normal);
  const normalDirect = buildSnapshotFromCandles("BTCUSDT", normal, 20)!;
  const normalCached = snapshotFromCache("BTCUSDT", normal, normalCache, normal.length - 1, 20)!;
  assertRuleFieldsEqual(normalDirect, normalCached, "Spread-/Tiefe-Grundfall");
  assert.equal(normalDirect.spreadPct, null);
  assert.equal(normalCached.spreadPct, null);
  assert.equal(normalDirect.bookDepthUsd, null);
  assert.equal(normalCached.bookDepthUsd, null);
});

test("STX-08-04: Spread und Buch-Tiefe übergeben dieselben gültigen Werte und verwerfen ungültige Werte", () => {
  const candles = makeCandles(ASSETS[0], HOUR_MS);
  const cache = buildIndicatorCache(candles);
  const index = candles.length - 1;
  const cases: readonly {
    spread: number | null;
    depth: number | null;
    expectedSpread: number | null;
    expectedDepth: number | null;
  }[] = [
    { spread: 0.0004, depth: 42_000, expectedSpread: 0.04, expectedDepth: 42_000 },
    { spread: null, depth: null, expectedSpread: null, expectedDepth: null },
    { spread: Number.NaN, depth: Number.POSITIVE_INFINITY, expectedSpread: null, expectedDepth: null },
    { spread: -0.0001, depth: 0, expectedSpread: null, expectedDepth: null },
    { spread: Number.POSITIVE_INFINITY, depth: -1, expectedSpread: null, expectedDepth: null },
  ];

  for (const { spread, depth, expectedSpread, expectedDepth } of cases) {
    const direct = buildSnapshotFromCandles("BTCUSDT", candles, 20, spread, depth);
    const cached = snapshotFromCache("BTCUSDT", candles, cache, index, 20, spread, depth);
    assert.ok(direct && cached);
    assertRuleFieldsEqual(direct, cached, `spread=${String(spread)}, depth=${String(depth)}`);
    assert.equal(direct.spreadPct, expectedSpread);
    assert.equal(cached.spreadPct, expectedSpread);
    assert.equal(direct.bookDepthUsd, expectedDepth);
    assert.equal(cached.bookDepthUsd, expectedDepth);
  }
});

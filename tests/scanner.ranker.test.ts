/**
 * Tests des Market Rankers (Task 04): Gewichte, Breakdown-Konsistenz,
 * Determinismus, Regime-Klassifikation und Konfigurationsvalidierung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCANNER_CONFIG,
  ScannerConfigError,
  loadScannerConfig,
  resolveScannerConfig,
  validateScannerConfig,
} from "../src/scanner/config";
import { assertWeightsSumToOne, compareByScore, rankByScore, scoreInstrument } from "../src/scanner/ranker";
import { classifyRegime, describeRegime } from "../src/scanner/regime";
import { FactorCache, dataVersionOf } from "../src/scanner/cache";
import { computeAllFactors } from "../src/scanner/factors";
import { SCORE_COMPONENTS, COMPONENT_FACTOR, type FactorInput } from "../src/scanner/types";
import { AS_OF_MS, candlesFromCloses, growthSeries, healthyCandles, instrument } from "./fixtures/scannerFixtures";

function input(overrides: Partial<FactorInput> = {}): FactorInput {
  return {
    instrument: instrument(),
    candles: healthyCandles(),
    benchmarkCandles: null,
    derivatives: null,
    news: { events24h: 1, events7d: 3, highImpact24h: 0, scheduledEventInHours: null },
    asOf: AS_OF_MS,
    config: DEFAULT_SCANNER_CONFIG,
    ...overrides,
  };
}

// ── Gewichte ─────────────────────────────────────────────────────────────────

test("Gewichte: exakt 25/15/15/10/10/10/5/5/5 und Summe 100 %", () => {
  const w = DEFAULT_SCANNER_CONFIG.weights;
  assert.equal(w.liquidity, 0.25);
  assert.equal(w.volatility, 0.15);
  assert.equal(w.trend, 0.15);
  assert.equal(w.momentum, 0.1);
  assert.equal(w.spread, 0.1);
  assert.equal(w.volume, 0.1);
  assert.equal(w.correlation, 0.05);
  assert.equal(w.news, 0.05);
  assert.equal(w.execution, 0.05);
  assert.equal(SCORE_COMPONENTS.length, 9);
  const sum = SCORE_COMPONENTS.reduce((a, c) => a + w[c], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `Summe muss 1 sein, war ${sum}`);
  assert.equal(assertWeightsSumToOne(w), sum);
});

test("Gewichte: eine Summe ≠ 100 % wird hart abgelehnt", () => {
  assert.throws(
    () => validateScannerConfig({ weights: { ...DEFAULT_SCANNER_CONFIG.weights, liquidity: 0.3 } }),
    ScannerConfigError
  );
  assert.throws(() => assertWeightsSumToOne({ ...DEFAULT_SCANNER_CONFIG.weights, news: 0.5 }), /100 %/);
});

test("Konfiguration: scanner.config.json ist deckungsgleich mit DEFAULT_SCANNER_CONFIG", () => {
  const file = path.join(process.cwd(), "src/scanner/scanner.config.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(parsed, DEFAULT_SCANNER_CONFIG);
  assert.deepEqual(validateScannerConfig(parsed), DEFAULT_SCANNER_CONFIG);
});

test("Konfiguration: Datei-Override via SCANNER_CONFIG_FILE wird geladen und validiert", () => {
  const file = path.join(process.cwd(), "src/scanner/scanner.config.json");
  assert.deepEqual(loadScannerConfig(file), DEFAULT_SCANNER_CONFIG);
  assert.deepEqual(loadScannerConfig(undefined), DEFAULT_SCANNER_CONFIG);
});

test("Konfiguration: unplausible Werte werfen mit sprechender Meldung", () => {
  assert.throws(() => validateScannerConfig({ regime: { low: 1, normal: 0.5, high: 2 } }), /aufsteigend/);
  assert.throws(() => validateScannerConfig({ funnel: { deepMin: 50, deepMax: 40 } }), /deepMin/);
  assert.throws(() => validateScannerConfig({ funnel: { dailyMax: 5000 } }), /monoton/);
  assert.throws(() => validateScannerConfig({ factors: { momentum: { mode: "zufall" } } }), /absolute\|directional/);
  assert.throws(() => validateScannerConfig({ weekly: { rotationMinScore: 90 } }), /rotationMinScore/);
  assert.throws(() => validateScannerConfig("kaputt"), /erwartet Objekt/);
});

test("Konfiguration: unbekannte Schlüssel werden ignoriert (kein Schmuggelpfad)", () => {
  const cfg = validateScannerConfig({ boeserSchalter: true, funnel: { dailyMax: 42 } });
  assert.equal((cfg as unknown as Record<string, unknown>).boeserSchalter, undefined);
  assert.equal(cfg.funnel.dailyMax, 42);
});

// ── OPS-009: abgeleiteter Warmup-Bedarf & Readiness ──────────────────────────

test("Konfiguration: filters.minCandles ist per Default nicht gesetzt (abgeleitet)", () => {
  assert.equal(DEFAULT_SCANNER_CONFIG.filters.minCandles, undefined);
  const cfg = validateScannerConfig({});
  assert.equal(cfg.filters.minCandles, undefined);
});

test("config validation warns when minCandles < requiredWarmupCandles", () => {
  const warnings: string[] = [];
  const cfg = validateScannerConfig({ filters: { minCandles: 30 } }, { onWarn: (m) => warnings.push(m) });
  assert.equal(cfg.filters.minCandles, 30, "der explizite Wert bleibt erhalten");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /minCandles=30/);
  assert.match(warnings[0], /requiredWarmupCandles=61/);
});

test("config validation: strict mode escalates a too-small minCandles to an error", () => {
  assert.throws(
    () => validateScannerConfig({ filters: { minCandles: 10 } }, { strict: true }),
    ScannerConfigError,
  );
});

test("config validation: an explicit minCandles >= required is accepted silently", () => {
  const warnings: string[] = [];
  const cfg = validateScannerConfig({ filters: { minCandles: 200 } }, { onWarn: (m) => warnings.push(m) });
  assert.equal(cfg.filters.minCandles, 200);
  assert.equal(warnings.length, 0);
});

// ── Score & Breakdown ────────────────────────────────────────────────────────

test("Score: Summe der Beiträge entspricht dem Endscore", () => {
  const score = scoreInstrument(input());
  const sum = score.breakdown.reduce((a, e) => a + e.contribution, 0);
  assert.ok(Math.abs(sum - score.score) < 1e-9, `Breakdown ${sum} ≠ Score ${score.score}`);
  assert.equal(score.breakdown.length, 9);
});

test("Score: Breakdown ist vollständig, sortiert und rechnerisch konsistent", () => {
  const score = scoreInstrument(input());
  assert.deepEqual(
    score.breakdown.map((e) => e.component),
    [...SCORE_COMPONENTS]
  );
  for (const entry of score.breakdown) {
    assert.equal(entry.factorId, COMPONENT_FACTOR[entry.component]);
    assert.equal(entry.weight, DEFAULT_SCANNER_CONFIG.weights[entry.component]);
    assert.ok(Math.abs(entry.contribution - entry.weight * entry.normalized * 100) < 1e-9);
    assert.ok(entry.normalized >= 0 && entry.normalized <= 1);
    assert.ok(entry.reason.length > 0);
  }
});

test("Score: liegt immer in [0, 100] — bestes und schlechtestes Instrument", () => {
  const best = scoreInstrument(
    input({
      instrument: instrument({ volume24h: 50_000_000_000, spread: 0.00005, takerFee: 0.0001, makerFee: 0 }),
      candles: healthyCandles(120),
      benchmarkCandles: candlesFromCloses(growthSeries(500, 0.999, 120)),
      news: { events24h: 0, events7d: 0, highImpact24h: 0, scheduledEventInHours: null },
    })
  );
  const worst = scoreInstrument(
    input({
      instrument: instrument({ volume24h: 1, spread: 0.02, takerFee: 0.01, makerFee: 0.01 }),
      candles: [],
      news: { events24h: 20, events7d: 50, highImpact24h: 5, scheduledEventInHours: 1 },
    })
  );
  assert.ok(best.score > worst.score);
  for (const s of [best, worst]) {
    assert.ok(s.score >= 0 && s.score <= 100, `Score außerhalb [0,100]: ${s.score}`);
  }
});

test("Score: zweimal rechnen ⇒ byte-identisches Ergebnis (Determinismus)", () => {
  const first = scoreInstrument(input());
  const second = scoreInstrument(input());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("Score: Gewichtsänderung verschiebt den Score nachvollziehbar", () => {
  const cfg = resolveScannerConfig({
    weights: {
      liquidity: 1,
      volatility: 0,
      trend: 0,
      momentum: 0,
      spread: 0,
      volume: 0,
      correlation: 0,
      news: 0,
      execution: 0,
    },
  });
  const score = scoreInstrument(input({ config: cfg }));
  const liquidity = score.breakdown.find((e) => e.component === "liquidity");
  assert.ok(liquidity);
  assert.equal(score.score, liquidity.contribution);
  assert.equal(score.score, Math.round(liquidity.normalized * 100 * 1e10) / 1e10);
});

test("Ranking: Score absteigend, ID als stabiler Tiebreaker", () => {
  const a = scoreInstrument(input({ instrument: instrument({ symbol: "AAAUSDT" }) }));
  const b = scoreInstrument(input({ instrument: instrument({ symbol: "BBBUSDT" }) }));
  assert.equal(a.score, b.score);
  assert.equal(compareByScore(a, b), -1);
  const ranked = rankByScore([b, a]);
  assert.deepEqual(
    ranked.map((s) => s.instrumentId),
    ["BINANCE:AAAUSDT", "BINANCE:BBBUSDT"]
  );
});

// ── Regime ───────────────────────────────────────────────────────────────────

test("Regime: Klassifikation exakt an den Schwellenwerten (Grenze gehört nach oben)", () => {
  const r = DEFAULT_SCANNER_CONFIG.regime;
  assert.deepEqual([r.low, r.normal, r.high], [0.25, 0.6, 1.2]);
  assert.equal(classifyRegime(0, r), "LOW");
  assert.equal(classifyRegime(0.2499999, r), "LOW");
  assert.equal(classifyRegime(0.25, r), "NORMAL");
  assert.equal(classifyRegime(0.5999999, r), "NORMAL");
  assert.equal(classifyRegime(0.6, r), "HIGH");
  assert.equal(classifyRegime(1.1999999, r), "HIGH");
  assert.equal(classifyRegime(1.2, r), "EXTREME");
  assert.equal(classifyRegime(9, r), "EXTREME");
  assert.equal(classifyRegime(null, r), "NORMAL");
  assert.equal(classifyRegime(Number.NaN, r), "NORMAL");
});

test("Regime: eigene Schwellen wirken sofort", () => {
  const cfg = resolveScannerConfig({ regime: { low: 0.1, normal: 0.2, high: 0.3 } });
  assert.equal(classifyRegime(0.25, cfg.regime), "HIGH");
  assert.match(describeRegime("EXTREME", cfg.regime), /extrem/);
  assert.match(describeRegime("LOW", cfg.regime), /ruhig/);
  assert.match(describeRegime("NORMAL", cfg.regime), /normal/);
  assert.match(describeRegime("HIGH", cfg.regime), /erhöht/);
});

test("Regime: Score-Ergebnis trägt das Regime der realisierten Volatilität", () => {
  const calm = scoreInstrument(input({ candles: candlesFromCloses(growthSeries(100, 1.0002, 60)) }));
  assert.equal(calm.regime, "LOW");
  const wild = scoreInstrument(
    input({ candles: candlesFromCloses(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 140))) })
  );
  assert.equal(wild.regime, "EXTREME");
});

// ── Cache ────────────────────────────────────────────────────────────────────

test("Cache: identische Eingabe trifft, neue Kerze verfehlt", () => {
  const cache = new FactorCache(10);
  const first = input();
  const hitAgain = input();
  cache.getOrCompute(first, computeAllFactors);
  cache.getOrCompute(hitAgain, computeAllFactors);
  assert.equal(cache.statistics.hits, 1);
  assert.equal(cache.statistics.misses, 1);

  const changed = input({ candles: healthyCandles(81) });
  assert.notEqual(dataVersionOf(first), dataVersionOf(changed));
  cache.getOrCompute(changed, computeAllFactors);
  assert.equal(cache.statistics.misses, 2);
});

test("Cache: Treffer liefert exakt dasselbe Ergebnis wie eine Neuberechnung", () => {
  const cache = new FactorCache();
  const one = cache.getOrCompute(input(), computeAllFactors);
  const two = cache.getOrCompute(input(), computeAllFactors);
  assert.equal(JSON.stringify(one), JSON.stringify(computeAllFactors(input())));
  assert.equal(one, two);
});

test("Cache: LRU verdrängt und clear() setzt zurück", () => {
  const cache = new FactorCache(2);
  for (let i = 0; i < 5; i++) {
    cache.getOrCompute(input({ instrument: instrument({ symbol: `SYM${i}USDT` }) }), computeAllFactors);
  }
  assert.equal(cache.size, 2);
  assert.equal(cache.statistics.evictions, 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.statistics.hits, 0);
});

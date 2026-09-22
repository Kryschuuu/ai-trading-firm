/**
 * Unit-Tests der multidimensionalen, point-in-time-sicheren Regime-Erkennung
 * (RMA-P2-01, v1.61.0) — `src/lib/regimeFeatures.ts`,
 * `src/lib/regimeFamilyInputs.ts`, `classifyMarketRegimeMultidim()` in
 * `src/lib/marketRegime.ts`, Gate-Coverage-Schutz, Snapshot-Dimensionen,
 * Artefakt v2 sowie die reinen Evaluationsfunktionen.
 *
 * Abgedeckte Pflicht-Tests des Prompts:
 *   - Feature-Fixtures → erwartete Klasse/Confidence/Treiber
 *   - stale/fehlende Familie senkt Coverage und erhöht das Risiko nicht
 *   - gleiche As-of-Daten ⇒ identischer Snapshot (Determinismus/Golden)
 *   - Hysterese verhindert Ein-Bar-Flapping bei flackernden Familien
 *   - alte OHLCV-only-Konfiguration bleibt reproduzierbar
 *   - Look-ahead: später verfügbare Makro-/Perp-Daten sind unsichtbar
 *   - Negative Paths: invalide, fehlende, stale Inputs
 *
 * Alle Tests deterministisch (feste Serien, injizierte Zeit), ohne Netzwerk,
 * ohne DB (Persistenz-Tests: tests/regimeSnapshot.db.test.ts).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_MARKET_REGIME_CONFIG,
  GATE_FACTOR_BOUNDS,
  MIN_CLASSIFY_CANDLES,
  applyRegimeGate,
  classifyMarketRegime,
  classifyMarketRegimeMultidim,
  collectRegimeHistoryArtifact,
  evaluateInstrumentRegime,
  formatRegimeGateContext,
  loadMarketRegimeConfig,
  refreshInstrumentRegimes,
  resolveRegimeGateForExecution,
  __resetMarketRegimeForTests,
  type MarketRegimeConfig,
  type RegimeCandleLike,
} from "../src/lib/marketRegime";
import {
  REGIME_COVERAGE_DENOMINATOR,
  REGIME_FEATURE_CONTRACT,
  REGIME_FEATURE_VERSION,
  REGIME_MODEL_VERSION,
  assembleRegimeFeatureVector,
  coverageOf,
  evaluateSample,
  type RegimeFamilyInputs,
} from "../src/lib/regimeFeatures";
import {
  loadRegimeFamilyInputs,
  readPerpCacheFile,
  readSpreadCacheFile,
} from "../src/lib/regimeFamilyInputs";
import {
  buildRegimeEvalReport,
  evaluateRegimeOos,
  evaluateRegimeStability,
  type RegimeEvalRow,
} from "../src/lib/regimeEvaluation";
import { regimeSnapshotKey, toRegimeSnapshotRow } from "../src/lib/regimeSnapshotStore";

beforeEach(() => {
  __resetMarketRegimeForTests();
});

// ── Synthetische Serien (deterministisch) ────────────────────────────────────

const T0 = 1_750_000_000_000;
const STEP = 900_000; // 15m

function candlesFromCloses(closes: number[]): RegimeCandleLike[] {
  return closes.map((close, i) => {
    const prev = i === 0 ? close : closes[i - 1];
    return {
      time: T0 + i * STEP,
      open: prev,
      high: Math.max(close, prev) + 0.05,
      low: Math.min(close, prev) - 0.05,
      close,
      volume: 1000 + i,
    };
  });
}

function linear(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function rangeSeries(n = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const amp = i < 60 ? 1.5 : 0.4;
    out.push(100 + amp * Math.sin((i * 2 * Math.PI) / 12));
  }
  return out;
}

function highVolSeries(n = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 80) out.push(100);
    else {
      const base = 100 + (i - 80) * 0.1;
      out.push(base * ((i - 80) % 2 === 1 ? 1.05 : 0.95));
    }
  }
  return out;
}

function crashSeries(n = 100): number[] {
  const flat = Array.from({ length: n - 10 }, () => 100);
  const drop = [92, 88, 85, 83, 82, 81, 80.5, 80, 79.5, 79];
  return [...flat, ...drop];
}

const cfg = (over: Partial<MarketRegimeConfig> = {}): MarketRegimeConfig => ({
  ...DEFAULT_MARKET_REGIME_CONFIG,
  ...over,
  gateFactors: over.gateFactors ?? DEFAULT_MARKET_REGIME_CONFIG.gateFactors,
});

const AS_OF = T0 + 99 * STEP;

/** Frische, vollständige Familien-Inputs relativ zu einem as_of-Zeitpunkt. */
function familiesAt(nowMs: number, over: Partial<NonNullable<RegimeFamilyInputs["perp"]>> = {}): RegimeFamilyInputs {
  return {
    liquidity: { relativeSpread: 0.0001, measuredAtMs: nowMs - 60_000 },
    perp: {
      fundingRate: 0.0001,
      fundingEventTimeMs: nowMs - 60_000,
      openInterestChange24h: 0.02,
      oiEventTimeMs: nowMs - 60_000,
      availableAtMs: nowMs - 30_000,
      ...over,
    },
    macro: { vix: 14, measuredAtMs: nowMs - 60_000 },
  };
}

/** Frische Familien-Inputs zum klassischen AS_OF-Anker. */
function fullFamilies(over: Partial<NonNullable<RegimeFamilyInputs["perp"]>> = {}): RegimeFamilyInputs {
  return familiesAt(AS_OF, over);
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

// ── 1. Feature-Vertrag ───────────────────────────────────────────────────────

test("Feature-Vertrag: feste Familien, Gewichte, Einheiten, Staleness-Budgets", () => {
  const families = REGIME_FEATURE_CONTRACT.map((c) => c.family);
  assert.deepEqual(families, ["price", "volatility", "liquidity", "perp", "macro"]);
  assert.equal(REGIME_COVERAGE_DENOMINATOR, 1);
  const byFamily = Object.fromEntries(REGIME_FEATURE_CONTRACT.map((c) => [c.family, c]));
  assert.equal(byFamily.price.unit, "quote");
  assert.equal(byFamily.volatility.unit, "percentile_0_100");
  assert.equal(byFamily.liquidity.unit, "fraction");
  assert.equal(byFamily.perp.unit, "fraction_per_interval");
  assert.equal(byFamily.macro.optional, true, "Makro ist optional (nie Coverage-pflichtig)");
  assert.equal(byFamily.price.maxStalenessMs, 2 * 60 * 60_000);
  assert.equal(byFamily.liquidity.maxStalenessMs, 6 * 60 * 60_000);
  assert.equal(byFamily.perp.maxStalenessMs, 24 * 60 * 60_000);
  assert.equal(byFamily.macro.maxStalenessMs, 15 * 60_000);
  assert.equal(REGIME_FEATURE_VERSION, "regime-features@1");
  assert.equal(REGIME_MODEL_VERSION, "regime-rules@1");
});

test("assemble: frische Preis-/Vol-Familien OK, fehlende Familien MISSING, Coverage 0.6", () => {
  const vector = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "multidim",
    price: { close: 110.5, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 42, eventTimeMs: AS_OF - STEP },
    families: null,
  });
  const by = Object.fromEntries(vector.families.map((f) => [f.family, f]));
  assert.equal(by.price.status, "OK");
  assert.equal(by.volatility.status, "OK");
  assert.equal(by.liquidity.status, "MISSING");
  assert.equal(by.perp.status, "MISSING");
  assert.equal(by.macro.status, "MISSING");
  assert.equal(vector.coverage, 0.6);
  assert.equal(vector.degraded, true);
  assert.equal(vector.featureVersion, REGIME_FEATURE_VERSION);
  // Value-Formel: 0.3 + 0.3 = 0.6 — kein Family-Wert wird zu 0 substituiert.
  assert.equal(by.liquidity.samples[0].value, null);
  assert.equal(by.liquidity.samples[0].reason, "NO_INPUT");
});

test("assemble: alle Pflichtfamilien OK ⇒ Coverage 1 und nicht degradiert (Makro optional)", () => {
  const vector = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "multidim",
    price: { close: 110, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 50, eventTimeMs: AS_OF - STEP },
    families: fullFamilies(),
  });
  assert.equal(vector.coverage, 1);
  assert.equal(vector.degraded, false);
  // Ohne Makro (optional): Coverage bleibt 1.
  const withoutMacro = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "multidim",
    price: { close: 110, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 50, eventTimeMs: AS_OF - STEP },
    families: { liquidity: fullFamilies().liquidity, perp: fullFamilies().perp },
  });
  assert.equal(withoutMacro.coverage, 1);
  const macro = withoutMacro.families.find((f) => f.family === "macro");
  assert.equal(macro?.status, "MISSING", "fehlendes Makro straft die Coverage nicht");
});

test("assemble: featureMode ohlcv disablet erweiterte Familien (expliziter Degraded Mode)", () => {
  const vector = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "ohlcv",
    price: { close: 110, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 50, eventTimeMs: AS_OF - STEP },
    families: fullFamilies(),
  });
  const liq = vector.families.find((f) => f.family === "liquidity");
  assert.equal(liq?.status, "DISABLED");
  assert.equal(liq?.samples[0].reason, "FAMILY_DISABLED");
  assert.equal(vector.coverage, 0.6, "auch ohlcv-Modus zeigt die volle Vertrags-Coverage");
  assert.equal(vector.degraded, true);
});

// ── 2. Point-in-Time / Negative Paths der Samples ───────────────────────────

test("PIT: availableAt > asOf ⇒ MISSING (AVAILABLE_AT_FUTURE), Wert fließt nie ein", () => {
  const sample = evaluateSample({
    key: "perp.fundingRate",
    family: "perp",
    unit: "fraction_per_interval",
    lookback: "test",
    value: 0.05,
    eventTimeMs: AS_OF - 1000,
    availableAtMs: AS_OF + 60_000, // später bekannt als as_of
    asOfMs: AS_OF,
    maxStalenessMs: 24 * 60 * 60_000,
  });
  assert.equal(sample.status, "MISSING");
  assert.equal(sample.reason, "AVAILABLE_AT_FUTURE");
  assert.equal(sample.value, null, "kein Null-/Ersatzwert — der späte Wert wird verworfen");

  const vector = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "multidim",
    price: { close: 100, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 50, eventTimeMs: AS_OF - STEP },
    families: fullFamilies({ availableAtMs: AS_OF + 1 }),
  });
  const perp = vector.families.find((f) => f.family === "perp");
  assert.equal(perp?.status, "MISSING");
  assert.equal(perp?.reason, "AVAILABLE_AT_FUTURE");
  assert.ok(vector.coverage < 1);
});

test("PIT: eventTime > asOf ⇒ MISSING (EVENT_TIME_FUTURE)", () => {
  const sample = evaluateSample({
    key: "macro.vix",
    family: "macro",
    unit: "index",
    lookback: "test",
    value: 45,
    eventTimeMs: AS_OF + 1,
    availableAtMs: AS_OF, // verfügbar „zur as_of-Zeit“, aber das Ereignis liegt in der Zukunft
    asOfMs: AS_OF,
    maxStalenessMs: 15 * 60_000,
  });
  assert.equal(sample.status, "MISSING");
  assert.equal(sample.reason, "EVENT_TIME_FUTURE");
});

test("Staleness: überschrittenes Budget ⇒ STALE (Wert sichtbar, aber nicht OK)", () => {
  const sample = evaluateSample({
    key: "liquidity.relativeSpread",
    family: "liquidity",
    unit: "fraction",
    lookback: "test",
    value: 0.001,
    eventTimeMs: AS_OF - 7 * 60 * 60_000, // 7 h alt, Budget 6 h
    availableAtMs: AS_OF - 7 * 60 * 60_000,
    asOfMs: AS_OF,
    maxStalenessMs: 6 * 60 * 60_000,
  });
  assert.equal(sample.status, "STALE");
  assert.equal(sample.reason, "STALE");
  assert.equal(sample.ageMs, 7 * 60 * 60_000);
  const vector = assembleRegimeFeatureVector({
    asOfMs: AS_OF,
    mode: "multidim",
    price: { close: 100, eventTimeMs: AS_OF - STEP },
    volatility: { volPercentile: 50, eventTimeMs: AS_OF - STEP },
    families: {
      liquidity: { relativeSpread: 0.001, measuredAtMs: AS_OF - 7 * 60 * 60_000 },
      perp: fullFamilies().perp,
    },
  });
  assert.ok(vector.coverage < 1, "stale Familie senkt die Coverage");
  assert.equal(vector.degraded, true);
});

test("Negative Paths: NaN/Infinity ⇒ INVALID_VALUE, null ⇒ NO_VALUE — nie 0", () => {
  const nan = evaluateSample({
    key: "liquidity.relativeSpread",
    family: "liquidity",
    unit: "fraction",
    lookback: "t",
    value: Number.NaN,
    eventTimeMs: AS_OF,
    availableAtMs: AS_OF,
    asOfMs: AS_OF,
    maxStalenessMs: 1000,
  });
  assert.equal(nan.status, "MISSING");
  assert.equal(nan.reason, "INVALID_VALUE");
  assert.equal(nan.value, null);
  const inf = evaluateSample({
    key: "perp.fundingRate",
    family: "perp",
    unit: "fraction_per_interval",
    lookback: "t",
    value: Number.POSITIVE_INFINITY,
    eventTimeMs: AS_OF,
    availableAtMs: AS_OF,
    asOfMs: AS_OF,
    maxStalenessMs: 1000,
  });
  assert.equal(inf.reason, "INVALID_VALUE");
  const missing = evaluateSample({
    key: "macro.vix",
    family: "macro",
    unit: "index",
    lookback: "t",
    value: null,
    eventTimeMs: null,
    availableAtMs: null,
    asOfMs: AS_OF,
    maxStalenessMs: 1000,
  });
  assert.equal(missing.reason, "NO_INPUT");
  assert.equal(missing.value, null);
});

test("coverageOf: deterministisch und geklemmt [0,1]", () => {
  const vector = assembleRegimeFeatureVector({ asOfMs: AS_OF, mode: "ohlcv" });
  assert.equal(coverageOf(vector.families), vector.coverage);
  assert.ok(vector.coverage >= 0 && vector.coverage <= 1);
  assert.equal(coverageOf([]), 0);
});

// ── 3. OHLCV-Reproduzierbarkeit (Alt-Konfiguration) ─────────────────────────

test("Reproduzierbarkeit: OHLCV-only == classifyMarketRegime über alle Golden-Serien", () => {
  const series: Array<[string, number[]]> = [
    ["trend-up", linear(100, 100, 0.5)],
    ["trend-down", linear(100, 200, -0.4)],
    ["range", rangeSeries()],
    ["high-vol", highVolSeries()],
    ["crash", crashSeries()],
  ];
  for (const [name, closes] of series) {
    const core = classifyMarketRegime(candlesFromCloses(closes), cfg());
    const multi = classifyMarketRegimeMultidim(candlesFromCloses(closes), cfg(), { asOfMs: AS_OF });
    assert.equal(multi.regime, core.regime, `ohne Familien bleibt die Klasse identisch (${name})`);
    assert.equal(multi.rawRegime, core.regime);
    assert.equal(multi.degraded, true);
    assert.equal(multi.coverage, 0.6);
    assert.equal(typeof multi.confidence, "number");
  }
});

test("Reproduzierbarkeit: featureMode ohlcv ignoriert vorhandene Familien-Votes", () => {
  const closes = rangeSeries();
  const candles = candlesFromCloses(closes);
  const core = classifyMarketRegime(candles, cfg());
  const withVotes = classifyMarketRegimeMultidim(candles, cfg({ featureMode: "ohlcv" }), {
    asOfMs: AS_OF,
    families: {
      ...fullFamilies(),
      liquidity: { relativeSpread: 0.02, measuredAtMs: AS_OF - 1000 }, // 2 % Spread
      macro: { vix: 90, measuredAtMs: AS_OF - 1000 },
    },
  });
  assert.equal(core.regime, "RANGE");
  assert.equal(withVotes.regime, "RANGE", "Legacy-Modus: kein Eskalations-Vote");
  assert.equal(withVotes.degraded, true);
});

test("UNKNOWN: zu wenig Kerzen ⇒ UNKNOWN, confidence null, nie still", () => {
  const result = classifyMarketRegimeMultidim(candlesFromCloses(linear(MIN_CLASSIFY_CANDLES - 1, 100, 0.5)), cfg(), {
    asOfMs: AS_OF,
    families: fullFamilies(),
  });
  assert.equal(result.regime, "UNKNOWN");
  assert.equal(result.known, false);
  assert.equal(result.confidence, null);
  assert.equal(result.rawRegime, "UNKNOWN");
  assert.equal(result.topDrivers.length, 0);
});

test("UNKNOWN: leere/kaputte Eingabe ⇒ UNKNOWN ohne Wurf", () => {
  const result = classifyMarketRegimeMultidim([], cfg(), { asOfMs: AS_OF });
  assert.equal(result.regime, "UNKNOWN");
  assert.equal(result.confidence, null);
  assert.equal(result.dataAsOf, null);
});

// ── 4. Multidim-Klassifikation: Confidence, Treiber, Eskalation ─────────────

test("Multidim: Confidence liegt in [0.2, 0.99] und Treiber nennen die Auslöser", () => {
  const trend = classifyMarketRegimeMultidim(candlesFromCloses(linear(100, 100, 0.5)), cfg(), { asOfMs: AS_OF });
  assert.ok(trend.known);
  assert.ok(trend.confidence != null && trend.confidence >= 0.2 && trend.confidence <= 0.99);
  assert.equal(trend.regime, "TREND_UP");
  const keys = trend.topDrivers.map((d) => d.key);
  assert.ok(keys.includes("adx"), "Trend-Treiber nennen ADX");
  assert.ok(keys.includes("slopePctPerCandle"));
  for (const driver of trend.topDrivers) {
    assert.ok(driver.contribution > 0);
    assert.ok(driver.display.length > 0);
  }
  assert.ok(trend.topDrivers.length <= 5, "Treiber sind gebounded (≤5)");
});

test("Multidim: extremer Funding-Vote eskaliert RANGE → HIGH_VOL (nicht CRASH, keine Richtungsdrehung)", () => {
  const candles = candlesFromCloses(rangeSeries());
  const core = classifyMarketRegime(candles, cfg());
  assert.equal(core.regime, "RANGE");
  const result = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: fullFamilies({ fundingRate: 0.01, fundingEventTimeMs: AS_OF - 1000 }), // 1 % ≫ 0.001
  });
  assert.equal(result.rawRegime, "HIGH_VOL", "Eskalation nur zur sicheren Richtung");
  assert.notEqual(result.rawRegime, "CRASH", "CRASH entsteht nie aus erweiterten Familien");
  const driverKeys = result.topDrivers.map((d) => d.key);
  assert.ok(driverKeys.includes("perp.fundingRate"));
  assert.ok(result.reason.includes("Eskalation"));
  assert.ok(result.confidence != null && result.confidence >= 0.2 && result.confidence <= 0.99);
});

test("Multidim: Spread- und Makro-Votes (Liquidity/Makro) eskalieren ebenfalls nur zu HIGH_VOL", () => {
  const candles = candlesFromCloses(rangeSeries());
  const spreadVote = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: { ...fullFamilies(), liquidity: { relativeSpread: 0.02, measuredAtMs: AS_OF - 1000 } },
  });
  assert.equal(spreadVote.rawRegime, "HIGH_VOL");
  assert.ok(spreadVote.topDrivers.some((d) => d.key === "liquidity.relativeSpread"));

  const vixVote = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: { ...fullFamilies(), macro: { vix: 80, measuredAtMs: AS_OF - 1000 } },
  });
  assert.equal(vixVote.rawRegime, "HIGH_VOL");
  assert.ok(vixVote.topDrivers.some((d) => d.key === "macro.vix"));
});

test("Multidim: OI-Einbruch ≤ −30 % ist Perp-Vote; unter der Schwelle nicht", () => {
  const candles = candlesFromCloses(rangeSeries());
  const collapse = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: fullFamilies({ openInterestChange24h: -0.45, fundingRate: 0.0001 }),
  });
  assert.equal(collapse.rawRegime, "HIGH_VOL");
  assert.ok(collapse.topDrivers.some((d) => d.key === "perp.openInterestChange24h"));
  const mild = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: fullFamilies({ openInterestChange24h: -0.05, fundingRate: 0.0001 }),
  });
  assert.equal(mild.rawRegime, "RANGE", "kein Vote unter der dokumentierten Schwelle");
});

test("Multidim: stale/fehlende Familien erzeugen KEINE Eskalation (Coverage sinkt, Klasse Kern)", () => {
  const candles = candlesFromCloses(rangeSeries());
  const result = classifyMarketRegimeMultidim(candles, cfg(), {
    asOfMs: AS_OF,
    families: {
      liquidity: { relativeSpread: 0.05, measuredAtMs: AS_OF - 48 * 60 * 60_000 }, // stale
      // future: weder eventTime noch availableAt ≤ as_of ⇒ verworfen
      perp: {
        fundingRate: 0.02,
        fundingEventTimeMs: AS_OF + 1,
        openInterestChange24h: -0.5,
        oiEventTimeMs: AS_OF + 1,
        availableAtMs: AS_OF + 1,
      },
    },
  });
  assert.equal(result.rawRegime, "RANGE", "stale/future Werte stimmen nicht");
  assert.ok(result.coverage < 1);
  assert.equal(result.degraded, true);
});

test("Determinismus/Golden: identische As-of-Daten ⇒ byte-identischer Snapshot-Hash", () => {
  const candles = candlesFromCloses(rangeSeries());
  const families = fullFamilies({ fundingRate: 0.01 });
  const run = (): string => {
    __resetMarketRegimeForTests();
    const snap = evaluateInstrumentRegime("DET/USD", candles, {
      cfg: cfg(),
      now: AS_OF,
      audit: false,
      families,
    });
    return fnv1a(
      JSON.stringify({
        regime: snap.regime,
        rawRegime: snap.rawRegime,
        confidence: snap.confidence,
        coverage: snap.coverage,
        degraded: snap.degraded,
        featureVersion: snap.featureVersion,
        modelVersion: snap.modelVersion,
        topDrivers: snap.topDrivers,
        families: snap.families.map((f) => ({ family: f.family, status: f.status, reason: f.reason })),
        dataAsOf: snap.dataAsOf,
      })
    );
  };
  const first = run();
  const second = run();
  assert.equal(first, second, "gleicher As-of-Stand ⇒ identischer Snapshot");
});

// ── 5. Hysterese: Rohzustand getrennt, kein Flapping ────────────────────────

test("Hysterese: flackernde Familien erzeugen kein Ein-Bar-Flapping", () => {
  const candles = candlesFromCloses(rangeSeries());
  const withVote = (nowMs: number): RegimeFamilyInputs => familiesAt(nowMs, { fundingRate: 0.02 });
  const withoutVote = (nowMs: number): RegimeFamilyInputs => familiesAt(nowMs, { fundingRate: 0.0001 });

  // 1) Vote an → Eskalation sofort (sichere Richtung).
  const e1 = evaluateInstrumentRegime("FLAP/USD", candles, {
    cfg: cfg(),
    now: AS_OF,
    audit: false,
    families: withVote(AS_OF),
  });
  assert.equal(e1.regime, "HIGH_VOL");
  assert.equal(e1.rawRegime, "HIGH_VOL");

  // 2) Vote aus → Rohklasse RANGE, aber bestätigt bleibt HIGH_VOL (Streak 1).
  const e2 = evaluateInstrumentRegime("FLAP/USD", candles, {
    cfg: cfg(),
    now: AS_OF + STEP,
    audit: false,
    families: withoutVote(AS_OF + STEP),
  });
  assert.equal(e2.rawRegime, "RANGE");
  assert.equal(e2.regime, "HIGH_VOL", "Rohklassifikation ≠ bestätigter Zustand");

  // 3) Vote wieder an → bestätigt unverändert, Pending-Streak zurückgesetzt.
  const e3 = evaluateInstrumentRegime("FLAP/USD", candles, {
    cfg: cfg(),
    now: AS_OF + 2 * STEP,
    audit: false,
    families: withVote(AS_OF + 2 * STEP),
  });
  assert.equal(e3.regime, "HIGH_VOL");
  assert.equal(e3.changeCount, 1, "nur die anfängliche Eskalation war ein Wechsel");

  // 4) Nochmal aus → weiter bestätigt (De-Eskalation braucht 3 in Folge).
  const e4 = evaluateInstrumentRegime("FLAP/USD", candles, {
    cfg: cfg(),
    now: AS_OF + 3 * STEP,
    audit: false,
    families: withoutVote(AS_OF + 3 * STEP),
  });
  assert.equal(e4.regime, "HIGH_VOL");
  assert.equal(e4.changeCount, 1, "Flattern der Familien wechselt den Zustand nicht");
});

test("Hysterese: De-Eskalation nach confirmCandles konsekutiven Roh-RANGE-Bewertungen", () => {
  const candles = candlesFromCloses(rangeSeries());
  const withVote = (nowMs: number): RegimeFamilyInputs => familiesAt(nowMs, { fundingRate: 0.02 });
  const withoutVote = (nowMs: number): RegimeFamilyInputs => familiesAt(nowMs, { fundingRate: 0.0001 });
  evaluateInstrumentRegime("DEESC/USD", candles, {
    cfg: cfg(),
    now: AS_OF,
    audit: false,
    families: withVote(AS_OF),
  });
  evaluateInstrumentRegime("DEESC/USD", candles, {
    cfg: cfg(),
    now: AS_OF + STEP,
    audit: false,
    families: withoutVote(AS_OF + STEP),
  });
  evaluateInstrumentRegime("DEESC/USD", candles, {
    cfg: cfg(),
    now: AS_OF + 2 * STEP,
    audit: false,
    families: withoutVote(AS_OF + 2 * STEP),
  });
  const third = evaluateInstrumentRegime("DEESC/USD", candles, {
    cfg: cfg(),
    now: AS_OF + 3 * STEP,
    audit: false,
    families: withoutVote(AS_OF + 3 * STEP),
  });
  assert.equal(third.regime, "RANGE", "3 konsekutive Bestätigungen de-eskalieren");
  assert.equal(third.changeCount, 2);
});

// ── 6. Gate: Coverage-Schutz (fail-closed, Risiko nie erhöhen) ──────────────

test("Gate: risikoerhöhender Faktor wird bei niedriger Coverage/Degraded geklemmt", () => {
  const boostCfg = cfg({
    gateFactors: {
      ...DEFAULT_MARKET_REGIME_CONFIG.gateFactors,
      TREND_UP: { "mean-reversion": 0.5, trend: 1.5, breakout: 1 },
    },
  });
  // Degraded (ohne Familien): Boost blockiert, Dämpfung bleibt erlaubt.
  const blocked = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "trend",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
    coverage: 0.6,
    degraded: true,
  });
  assert.equal(blocked.factor, 1, "Boost > 1 darf bei Degraded Mode das Risiko nicht erhöhen");
  assert.equal(blocked.boostBlocked, true);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.effectiveWeight, 1);
  assert.match(blocked.reason, /Coverage/);
  assert.match(blocked.reason, /fail-closed/);

  const damped = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "mean-reversion",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
    coverage: 0.6,
    degraded: true,
  });
  assert.equal(damped.factor, 0.5, "Dämpfung ≤ 1 bleibt bei niedriger Coverage zulässig");
  assert.equal(damped.applied, true);
  assert.equal(damped.boostBlocked, false);

  // Volle Coverage, nicht degradiert: Boost wirkt (innerhalb bestehender Bounds).
  const applied = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "trend",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
    coverage: 1,
    degraded: false,
  });
  assert.equal(applied.factor, 1.5);
  assert.ok(applied.factor <= GATE_FACTOR_BOUNDS[1], "weiterhin innerhalb [0, 2]");
  assert.equal(applied.boostBlocked, false);
  assert.equal(applied.applied, true);
});

test("Gate: Coverage unter REGIME_MIN_BOOST_COVERAGE blockiert, darüber nicht", () => {
  const boostCfg = cfg({
    minBoostCoverage: 1,
    gateFactors: {
      ...DEFAULT_MARKET_REGIME_CONFIG.gateFactors,
      TREND_UP: { "mean-reversion": 1, trend: 1.5, breakout: 1 },
    },
  });
  const below = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "trend",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
    coverage: 0.9999,
    degraded: false,
  });
  assert.equal(below.factor, 1);
  assert.equal(below.boostBlocked, true);
  const at = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "trend",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
    coverage: 1,
    degraded: false,
  });
  assert.equal(at.factor, 1.5);
});

test("Gate: Alt-Aufrufe ohne Coverage bleiben byte-kompatibel (Default-Coverage 1)", () => {
  const boostCfg = cfg({
    gateFactors: {
      ...DEFAULT_MARKET_REGIME_CONFIG.gateFactors,
      TREND_UP: { "mean-reversion": 1, trend: 1.5, breakout: 1 },
    },
  });
  const legacy = applyRegimeGate({
    regime: "TREND_UP",
    strategyClass: "trend",
    weight: 1,
    mode: "enforce",
    cfg: boostCfg,
  });
  assert.equal(legacy.factor, 1.5);
  assert.equal(legacy.coverage, 1);
  assert.equal(legacy.degraded, false);
  assert.equal(legacy.boostBlocked, false);
});

test("Gate: resolveRegimeGateForExecution trägt Coverage/Degraded des Snapshots", () => {
  evaluateInstrumentRegime("COV/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: cfg(),
    now: T0,
    audit: false,
  });
  const resolved = resolveRegimeGateForExecution("COV/USD", "mean-reversion", cfg({ gateMode: "enforce" }));
  assert.equal(resolved.coverage, 0.6);
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.factor, 0.5, "Dämpfung wirkt auch degraded");
  const unknown = resolveRegimeGateForExecution("NOPE", "trend", cfg({ gateMode: "enforce" }));
  assert.equal(unknown.coverage, 1, "ohne Snapshot: Default, kein Raten");
  assert.equal(unknown.degraded, false);
});

// ── 7. Snapshot-Integration: Engine-/Refresh-/Prompt-/Artefakt-Dimensionen ──

test("evaluateInstrumentRegime: Snapshot trägt Confidence/Coverage/Versionen/Treiber", () => {
  const snap = evaluateInstrumentRegime("DIM/USD", candlesFromCloses(rangeSeries()), {
    cfg: cfg(),
    now: AS_OF,
    audit: false,
    families: fullFamilies({ fundingRate: 0.02 }),
  });
  assert.equal(snap.rawRegime, "HIGH_VOL");
  assert.equal(snap.regime, "HIGH_VOL");
  assert.ok(snap.confidence != null);
  assert.equal(snap.coverage, 1);
  assert.equal(snap.degraded, false);
  assert.equal(snap.featureVersion, REGIME_FEATURE_VERSION);
  assert.equal(snap.modelVersion, REGIME_MODEL_VERSION);
  assert.equal(snap.mode, "multidim");
  assert.ok(snap.topDrivers.length > 0);
  assert.equal(snap.families.length, 5);
  assert.equal(snap.dataAsOf, new Date(T0 + 99 * STEP).toISOString());
  assert.equal(snap.lastChange?.coverage, 1, "Wechselereignis trägt Coverage-Dimension");
});

test("evaluateInstrumentRegime: ohne Familien ⇒ degraded-Snapshot (Fail-closed Sichtbarkeit)", () => {
  const snap = evaluateInstrumentRegime("DEG/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: cfg(),
    now: T0,
    audit: false,
  });
  assert.equal(snap.degraded, true);
  assert.equal(snap.coverage, 0.6);
  assert.equal(snap.rawRegime, snap.regime, "Rohklasse = Kern ohne Votes");
});

test("refreshInstrumentRegimes: injizierter Loader versorgt Families (Degraded False)", async () => {
  const candles = candlesFromCloses(rangeSeries());
  const snaps = await refreshInstrumentRegimes(["REF/USD"], {
    cfg: cfg(),
    now: AS_OF,
    audit: false,
    force: true,
    fetchCandles: async () => candles,
    loadFamilies: () => fullFamilies({ fundingRate: 0.02 }),
  });
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].coverage, 1);
  assert.equal(snaps[0].degraded, false);
  assert.equal(snaps[0].rawRegime, "HIGH_VOL");

  // Loader-Fehler ⇒ Degraded Mode statt Wurf.
  const failing = await refreshInstrumentRegimes(["REF/USD"], {
    cfg: cfg(),
    now: AS_OF + STEP,
    audit: false,
    force: true,
    fetchCandles: async () => candles,
    loadFamilies: () => {
      throw new Error("loader boom");
    },
  });
  assert.equal(failing[0].degraded, true);
  assert.ok(failing[0].coverage < 1);
});

test("Prompt-Kontext: Confidence/Coverage/Degraded sichtbar, off bleibt leer", () => {
  const snap = evaluateInstrumentRegime("PROMPT/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: cfg(),
    now: T0,
    audit: false,
  });
  const gate = applyRegimeGate({
    regime: snap.regime,
    strategyClass: "mean-reversion",
    weight: 1,
    mode: "monitor",
    cfg: cfg(),
    coverage: snap.coverage,
    degraded: snap.degraded,
  });
  const line = formatRegimeGateContext(snap, "mean-reversion", gate);
  assert.match(line, /Conf 0\./);
  assert.match(line, /Coverage 60 %/);
  assert.match(line, /Degraded \(OHLCV-Fallback\)/);
  assert.match(line, /Rohklasse/);
  const off = applyRegimeGate({ regime: snap.regime, strategyClass: null, weight: 1, mode: "off", cfg: cfg() });
  assert.equal(formatRegimeGateContext(snap, null, off), "", "off → Prompt byte-identisch");
});

test("Artefakt v2: Rohklasse/Confidence/Coverage/Familien im regime-history-Payload", () => {
  // Kerzen reichen bis AS_OF (100 Bars) — Preis-/Vol-Familien sind frisch.
  evaluateInstrumentRegime("ART2/USD", candlesFromCloses(rangeSeries()), {
    cfg: cfg(),
    now: AS_OF,
    audit: false,
    families: fullFamilies(),
  });
  const artifact = collectRegimeHistoryArtifact(cfg());
  assert.ok(artifact);
  assert.equal(artifact.schemaVersion, 2);
  const entry = (artifact.instruments as Array<Record<string, unknown>>)[0];
  assert.equal(entry.coverage, 1);
  assert.equal(entry.degraded, false);
  assert.equal(typeof entry.confidence, "number");
  assert.equal(entry.featureVersion, REGIME_FEATURE_VERSION);
  assert.equal(entry.modelVersion, REGIME_MODEL_VERSION);
  assert.ok(Array.isArray(entry.families));
});

// ── 8. Live-Loader (Datei-Artefakte, nie werfend) ───────────────────────────

test("Loader: Spread-/Perp-Cache und Makro-Zustand → vollständige Families", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regime-family-"));
  try {
    const spreadFile = path.join(dir, "spread-cache.json");
    const perpFile = path.join(dir, "derivatives.json");
    mkdirSync(path.dirname(perpFile), { recursive: true });
    writeFileSync(
      spreadFile,
      JSON.stringify({
        version: 1,
        writtenAt: new Date(AS_OF - 60_000).toISOString(),
        entries: { "PAPER:BTC": { spread: 0.0004, at: new Date(AS_OF - 90_000).toISOString() } },
      })
    );
    writeFileSync(
      perpFile,
      JSON.stringify({
        writtenAt: new Date(AS_OF - 60_000).toISOString(),
        asOf: new Date(AS_OF - 60_000).toISOString(),
        entries: {
          "PAPER:BTC": {
            fundingRate: 0.0002,
            fundingEventTime: new Date(AS_OF - 120_000).toISOString(),
            openInterestChange24h: -0.05,
            availability: "AVAILABLE",
          },
        },
      })
    );
    const inputs = loadRegimeFamilyInputs("BTC", {
      nowMs: AS_OF,
      spreadFile,
      perpFile,
      env: { PERP_DATA_ENABLED: "true" },
      adaptiveState: {
        regime: "NORMAL",
        factor: 1,
        reason: "test",
        at: new Date(AS_OF - 60_000).toISOString(),
        indicators: { VIX: 21.5, ATR: null, BBW: null, RET_STDDEV: null },
      },
    });
    assert.equal(inputs.liquidity?.relativeSpread, 0.0004);
    assert.equal(inputs.perp?.fundingRate, 0.0002);
    assert.equal(inputs.perp?.availableAtMs, AS_OF - 60_000);
    assert.equal(inputs.macro?.vix, 21.5);

    // Kennung auch ohne PAPER-Präfix (Symbolform der Engine).
    const bySymbol = loadRegimeFamilyInputs("BTC", {
      nowMs: AS_OF,
      spreadFile,
      perpFile,
      env: { PERP_DATA_ENABLED: "false" },
      adaptiveState: null,
    });
    assert.equal(bySymbol.liquidity?.relativeSpread, 0.0004);
    assert.equal(bySymbol.perp, undefined, "PERP_DATA_ENABLED=false liefert keinen Perp-Input");
    assert.equal(bySymbol.macro, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Loader: fehlende/kaputte/stale Cache-Dateien ⇒ undefined (nie Wurf, nie erfundene Werte)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "regime-family-bad-"));
  try {
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, "{not-json");
    assert.equal(readSpreadCacheFile(broken), null);
    assert.equal(readPerpCacheFile(broken), null);
    const inputs = loadRegimeFamilyInputs("BTC", {
      nowMs: AS_OF,
      spreadFile: path.join(dir, "missing.json"),
      perpFile: broken,
      env: { PERP_DATA_ENABLED: "true" },
      adaptiveState: null,
    });
    assert.equal(inputs.liquidity, undefined);
    assert.equal(inputs.perp, undefined);
    assert.equal(inputs.macro, undefined);

    // Schreibzeit in der Zukunft (Replay-Missbrauch) ⇒ kein Input.
    const futureCache = path.join(dir, "future.json");
    writeFileSync(
      futureCache,
      JSON.stringify({
        writtenAt: new Date(AS_OF + 60_000).toISOString(),
        entries: { "PAPER:BTC": { spread: 0.001, at: new Date(AS_OF).toISOString() } },
      })
    );
    const futureInputs = loadRegimeFamilyInputs("BTC", { nowMs: AS_OF, spreadFile: futureCache });
    assert.equal(futureInputs.liquidity, undefined, "Cache nach as_of galt noch nicht als bekannt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 9. Konfiguration der neuen Schwellen ────────────────────────────────────

test("Config: neue Flags werden geboundet geklemmt, unbekannter Mode fällt auf multidim", () => {
  const c = loadMarketRegimeConfig({
    REGIME_FEATURE_MODE: "banana",
    REGIME_LIQUIDITY_SPREAD_HIGH_PCT: "999",
    REGIME_PERP_FUNDING_ABS: "abc",
    REGIME_MACRO_VIX_HIGH: "1",
    REGIME_MIN_BOOST_COVERAGE: "2",
  });
  assert.equal(c.featureMode, "multidim", "unbekannter Wert → dokumentierter Default");
  assert.equal(c.liquiditySpreadHighPct, 10, "obere Bound");
  assert.equal(c.perpFundingAbsThreshold, DEFAULT_MARKET_REGIME_CONFIG.perpFundingAbsThreshold);
  assert.equal(c.macroVixHigh, 5, "untere Bound");
  assert.equal(c.minBoostCoverage, 1, "obere Bound");
  const ohlcv = loadMarketRegimeConfig({ REGIME_FEATURE_MODE: "ohlcv" });
  assert.equal(ohlcv.featureMode, "ohlcv");
});

// ── 10. Reine Evaluation (Stabilität/Transitions/Coverage/OOS) ──────────────

function evalRow(over: Partial<RegimeEvalRow> & { symbol: string; asOfMs: number }): RegimeEvalRow {
  return {
    rawRegime: "RANGE",
    confirmedRegime: "RANGE",
    confidence: 0.5,
    coverage: 1,
    degraded: false,
    forwardReturnPct: null,
    ...over,
  };
}

test("Evaluation: Stabilität/Transitions/Coverage deterministisch aus der Historie", () => {
  const rows: RegimeEvalRow[] = [
    evalRow({ symbol: "BTC", asOfMs: 1000, confirmedRegime: "RANGE" }),
    evalRow({ symbol: "BTC", asOfMs: 2000, confirmedRegime: "HIGH_VOL", degraded: true, coverage: 0.6 }),
    evalRow({ symbol: "BTC", asOfMs: 3000, confirmedRegime: "HIGH_VOL" }),
    evalRow({ symbol: "ETH", asOfMs: 1000, confirmedRegime: "UNKNOWN", confidence: null, rawRegime: "UNKNOWN", degraded: true, coverage: 0 }),
    evalRow({ symbol: "ETH", asOfMs: 2500, confirmedRegime: "TREND_UP" }),
  ];
  const report = evaluateRegimeStability(rows);
  assert.equal(report.snapshots, 5);
  assert.equal(report.symbols, 2);
  assert.equal(report.transitions, 2, "BTC RANGE→HIGH_VOL und ETH UNKNOWN→TREND_UP");
  assert.equal(report.transitionsByPair["RANGE→HIGH_VOL"], 1);
  assert.equal(report.transitionsByPair["UNKNOWN→TREND_UP"], 1);
  assert.equal(report.byConfirmed.HIGH_VOL, 2);
  assert.equal(report.coverage.degradedShare, 0.4);
  // Mittelwert: (1 + 0.6 + 1 + 0 + 1) / 5 = 0.72
  assert.equal(report.coverage.mean, 0.72);
  assert.ok(report.flipRate > 0);
  // Determinismus: gleiche Eingabe, andere Reihenfolge ⇒ identischer Report.
  const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]];
  assert.deepEqual(evaluateRegimeStability(shuffled), report);
});

test("Evaluation: OOS schließt Snapshots ohne Horizont aus (null ≠ 0)", () => {
  const rows: RegimeEvalRow[] = [
    evalRow({ symbol: "BTC", asOfMs: 1, confirmedRegime: "RANGE", forwardReturnPct: 2.5 }),
    evalRow({ symbol: "BTC", asOfMs: 2, confirmedRegime: "RANGE", forwardReturnPct: -1 }),
    evalRow({ symbol: "BTC", asOfMs: 3, confirmedRegime: "RANGE", forwardReturnPct: null }),
    evalRow({ symbol: "ETH", asOfMs: 1, confirmedRegime: "HIGH_VOL", forwardReturnPct: -3 }),
  ];
  const oos = evaluateRegimeOos(rows);
  const range = oos.find((o) => o.regime === "RANGE");
  assert.ok(range);
  assert.equal(range.snapshots, 3);
  assert.equal(range.samples, 2, "null-Horizont wird ausgeschlossen");
  assert.equal(range.excluded, 1);
  assert.equal(range.meanForwardReturnPct, 0.75, "(2.5 + −1) / 2");
  assert.equal(range.positiveShare, 0.5);
  const highVol = oos.find((o) => o.regime === "HIGH_VOL");
  assert.equal(highVol?.meanForwardReturnPct, -3);
  // Kein Eintrag ohne Snapshots (geboundedes Vokabular).
  assert.ok(!oos.some((o) => o.regime === "CRASH"));
});

test("Evaluation: Gesamtreport trägt Versionen (kanonischer Snapshot für Backtest/Research)", () => {
  const report = buildRegimeEvalReport([evalRow({ symbol: "BTC", asOfMs: 1, forwardReturnPct: 0.5 })]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.featureVersion, REGIME_FEATURE_VERSION);
  assert.equal(report.modelVersion, REGIME_MODEL_VERSION);
  assert.equal(report.stability.snapshots, 1);
  assert.equal(report.oos.length > 0, true);
});

test("Snapshot-Store (rein): Idempotenz-Key stabil, neue As-of-Zeit ⇒ neuer Key", () => {
  const snap = evaluateInstrumentRegime("KEY/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: cfg(),
    now: T0,
    audit: false,
  });
  const row = toRegimeSnapshotRow(snap, { gateMode: "monitor", featureMode: snap.mode });
  const key1 = regimeSnapshotKey(row);
  const key2 = regimeSnapshotKey({ ...row });
  assert.equal(key1, key2, "gleiche Bewertung ⇒ gleicher Idempotenz-Key");
  assert.match(key1, /^[a-f0-9]{64}$/);
  const later = regimeSnapshotKey({ ...row, asOf: new Date(T0 + STEP).toISOString() });
  assert.notEqual(key1, later, "neues as_of ist eine neue Zeile");
  const otherClass = regimeSnapshotKey({ ...row, confirmedRegime: "HIGH_VOL" });
  assert.notEqual(key1, otherClass);
  assert.equal(row.rawRegime, snap.rawRegime);
  assert.equal(row.confirmedRegime, snap.regime);
  assert.equal(row.coverage, snap.coverage);
});

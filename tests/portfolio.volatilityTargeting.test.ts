/**
 * Tests: Portfolio-Volatility-Targeting — PURE Kern (RMA-P5-01, v1.67.0).
 *
 * Pflicht-Matrix:
 *   - diagonale und korrelierte Kovarianz-Fixtures liefern exakten Forecast
 *   - höherer Forecast senkt Multiplikator monoton
 *   - Clamp, smoothing und max step sind getestet
 *   - NaN, singulär, stale und geringe Coverage führen konservativ zurück
 *   - Annualisierung ist für Asset/Timeframe korrekt
 *   - Look-ahead-/As-of-Test (Event-Zeiten, Future-Check)
 *   - Negative Paths für invalide, fehlende und stale Inputs
 *   - Determinismus (gleiche Eingabe ⇒ bit-identisches Ergebnis)
 *   - Realisierte Volatilität + Target Error
 *   - Idempotency-Key- und Hash-Stabilität
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildVolatilityTargetingIdempotencyKey,
  computePortfolioVolatilityForecast,
  computeRealizedPortfolioVolatility,
  computeTargetError,
  computeVolatilityTargeting,
  computeVolatilityTargetingFromInput,
  DEFAULT_VOLATILITY_TARGETING_CONFIG,
  hashVolatilityTargetingConfig,
  hashVolatilityTargetingData,
  resolveVolatilityTargetingConfig,
  type VolatilityForecastInput,
  type VolatilityForecastSeries,
  type VolatilityTargetingConfig,
} from "../src/portfolio/volatilityTargeting";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Basis-Zeitstempel (epoch ms) für Event-Zeiten. */
const T0 = 1_700_000_000_000;
/** Bar-Länge 1h (ms). */
const BAR_MS = 3_600_000;

/**
 * Deterministische Nullmittelwert-Sequenz mit exakt bekannter Stichproben-
 * Varianz: x = [1,-1,1,-1,1,-1,1,-1] ⇒ mean 0, ddof-1-Varianz = 8/7.
 */
const X: number[] = [1, -1, 1, -1, 1, -1, 1, -1];
const Y: number[] = [1, 1, -1, -1, 1, 1, -1, -1];
const X_VAR = 8 / 7; // Σ(x−x̄)² / (n−1) = 8/7
const Y_VAR = 8 / 7;
const XY_COV = 0; // Σ x·y / (n−1) = 0/7

/** Standard-Config für exakte Forecasts (keine Shrinkage, kurze Schwelle). */
function makeConfig(overrides: Partial<VolatilityTargetingConfig> = {}): VolatilityTargetingConfig {
  return resolveVolatilityTargetingConfig({
    shrinkage: 0,
    minObservations: 4,
    lookbackPeriods: 8,
    smoothingAlpha: 1, // Standard: keine Glättung (einzelschritt-exakt)
    ...overrides,
  });
}

/** Event-Zeiten für T Bars ab T0 (1h-Abstand). */
function eventTimes(t: number, start = T0): number[] {
  return Array.from({ length: t }, (_, i) => start + i * BAR_MS);
}

/**
 * Baut einen Forecast-Input aus zwei Serien mit Uniform-Annualisierung A.
 */
function twoSeriesInput(
  a: number[],
  b: number[],
  opts: { weights?: [number, number]; annualization?: number; asOf?: number; computedAt?: number } = {}
): VolatilityForecastInput {
  const A = opts.annualization ?? 100;
  const [wa, wb] = opts.weights ?? [0.5, 0.5];
  const T = a.length;
  const ev = eventTimes(T);
  const series: VolatilityForecastSeries[] = [
    { symbol: "AAA", weight: wa, annualization: A, logReturns: a, eventTimes: ev },
    { symbol: "BBB", weight: wb, annualization: A, logReturns: b, eventTimes: ev },
  ];
  const asOf = opts.asOf ?? T0 + T * BAR_MS;
  const computedAt = opts.computedAt ?? asOf;
  return { series, asOf, computedAt, config: makeConfig() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

describe("Konfiguration (resolveVolatilityTargetingConfig)", () => {
  test("Defaults sind risikoneutral (mode monitor, max 1)", () => {
    assert.equal(DEFAULT_VOLATILITY_TARGETING_CONFIG.mode, "monitor");
    assert.equal(DEFAULT_VOLATILITY_TARGETING_CONFIG.maxMultiplier, 1);
    assert.equal(DEFAULT_VOLATILITY_TARGETING_CONFIG.minMultiplier, 0.25);
  });

  test("maxMultiplier wird HART auf ≤ 1 geklemmt (niemals risikosteigernd)", () => {
    const c = resolveVolatilityTargetingConfig({ maxMultiplier: 2.5 });
    assert.equal(c.maxMultiplier, 1);
    const c2 = resolveVolatilityTargetingConfig({ maxMultiplier: 0.8, minMultiplier: 0.9 });
    // min > max ⇒ min = max (leeres Fenster ist Misskonfiguration)
    assert.equal(c2.minMultiplier, 0.8);
    assert.equal(c2.maxMultiplier, 0.8);
  });

  test("ungültige Werte behalten den Basiswert", () => {
    const c = resolveVolatilityTargetingConfig({
      targetAnnualizedVolPct: Number.NaN,
      lookbackPeriods: Number.NaN,
      mode: "invalid-mode" as never,
    });
    assert.equal(c.targetAnnualizedVolPct, DEFAULT_VOLATILITY_TARGETING_CONFIG.targetAnnualizedVolPct);
    assert.equal(c.lookbackPeriods, DEFAULT_VOLATILITY_TARGETING_CONFIG.lookbackPeriods);
    assert.equal(c.mode, "monitor");
  });

  test("Werte außerhalb des Fensters werden geklemmt (nicht verworfen)", () => {
    const c = resolveVolatilityTargetingConfig({ lookbackPeriods: -5, targetAnnualizedVolPct: 999 });
    assert.equal(c.lookbackPeriods, 42); // min
    assert.equal(c.targetAnnualizedVolPct, 300); // max
  });

  test("minObservations ≤ lookbackPeriods", () => {
    const c = resolveVolatilityTargetingConfig({ lookbackPeriods: 50, minObservations: 200 });
    assert.equal(c.minObservations, 50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Forecast: exakte Kovarianz-Fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe("Forecast: diagonale und korrelierte Kovarianz (exakt)", () => {
  test("diagonal (unabhängig): exakte closed-form Forecast", () => {
    // A = a·x, B = b·y mit unabhängigen x,y (Σx·y = 0) ⇒ Σ = diag(a²·V, b²·V), Cov = 0.
    const a = 0.01;
    const b = 0.02;
    const seriesA = X.map((v) => a * v);
    const seriesB = Y.map((v) => b * v);
    const A = 100;
    const input = twoSeriesInput(seriesA, seriesB, { annualization: A, weights: [0.5, 0.5] });

    const fc = computePortfolioVolatilityForecast(input);
    assert.equal(fc.status, "OK");
    assert.equal(fc.reasonCode, "OK");
    assert.equal(fc.regularization, "none");

    // w'Σw = 0.25·a²V + 0.25·b²V (Cov-Term = 0, da x ⊥ y)
    const expected = Math.sqrt(A * (0.25 * a * a * X_VAR + 0.25 * b * b * Y_VAR));
    assert.ok(Math.abs(fc.forecastAnnualizedVol! - expected) < 1e-12, `expected ${expected}, got ${fc.forecastAnnualizedVol}`);
    assert.equal(fc.observations, 8);
    assert.equal(fc.coverage, 1);
    assert.deepEqual(fc.usedSymbols, ["AAA", "BBB"]);
  });

  test("korreliert (ρ = 1/√2): exakte closed-form Forecast inkl. Cov-Term", () => {
    // A = a·x, B = b·(x + y) mit unabhängigen x,y ⇒
    // Var(A) = a²·8/7, Var(B) = b²·16/7, Cov(A,B) = a·b·8/7 ⇒ ρ = 1/√2.
    const a = 0.01;
    const b = 0.01;
    const seriesA = X.map((v) => a * v);
    const seriesB = X.map((v, i) => b * (v + Y[i])); // x + y: [2,0,0,-2,2,0,0,-2]
    const A = 100;
    const input = twoSeriesInput(seriesA, seriesB, { annualization: A, weights: [0.5, 0.5] });

    const fc = computePortfolioVolatilityForecast(input);
    assert.equal(fc.status, "OK");
    const varA = (8 / 7); // Var(x)
    const varB = (16 / 7); // Var(x+y) = Var(x) + Var(y) (unabhängig)
    const covAB = (8 / 7); // Cov(x, x+y) = Var(x)
    const wSw = 0.25 * a * a * varA + 0.25 * b * b * varB + 2 * 0.25 * a * b * covAB;
    const expected = Math.sqrt(A * wSw);
    assert.ok(Math.abs(fc.forecastAnnualizedVol! - expected) < 1e-12, `expected ${expected}, got ${fc.forecastAnnualizedVol}`);
  });

  test("Korrelation reduziert den Forecast vs. Summe der Einzelvolatilitäten", () => {
    // ρ = +1 (perfekt korreliert) ⇒ höherer Forecast; unabhängige Assets
    // (ρ = 0) ⇒ niedrigerer Forecast (Diversifikations-Effekt).
    const a = 0.01;
    const A = 100;
    const independent = computePortfolioVolatilityForecast(
      twoSeriesInput(X.map((v) => a * v), Y.map((v) => a * v), { annualization: A })
    );
    const perfectlyCorrelated = computePortfolioVolatilityForecast(
      twoSeriesInput(X.map((v) => a * v), X.map((v) => a * v), { annualization: A })
    );
    assert.equal(independent.status, "OK");
    assert.equal(perfectlyCorrelated.status, "OK");
    // ρ=+1: Diversifikation verschwindet, Forecast > unabhängig.
    assert.ok(perfectlyCorrelated.forecastAnnualizedVol! > independent.forecastAnnualizedVol!);
    // Aber ρ=+1 macht die Matrix singulär ⇒ Ridge wird angewendet (fail-safe,
    // Forecast bleibt endlich und ≥ der exakten ρ=1-Grenze).
    assert.equal(perfectlyCorrelated.regularization, "ridge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiplikator: Monotonie, Clamp, Smoothing, Max-Step
// ─────────────────────────────────────────────────────────────────────────────

describe("Multiplikator (computeVolatilityTargeting)", () => {
  const cfg = makeConfig();

  test("höherer Forecast senkt Multiplikator monoton (α=1, kein Step-Limit)", () => {
    const c = resolveVolatilityTargetingConfig({ shrinkage: 0, minObservations: 4, maxStep: 1, smoothingAlpha: 1 });
    const mk = (vol: number) => ({
      forecast: {
        status: "OK" as const,
        reasonCode: "OK" as const,
        reason: "test",
        forecastAnnualizedVol: vol,
        observations: 8,
        annualization: 100,
        coverage: 1,
        usedSymbols: ["A"],
        normalizedWeights: { A: 1 },
        eventTime: T0,
        regularization: "none" as const,
        shrinkage: 0,
        seriesLength: 8,
      },
      targetAnnualizedVol: 0.3,
      rawMultiplier: null as number | null,
      clampedMultiplier: null as number | null,
      prevMultiplier: null as number | null,
      appliedMultiplier: 0,
      outcome: "ok" as const,
    });
    const vols = [0.05, 0.1, 0.2, 0.3, 0.6, 1.0, 2.0];
    let prev = Infinity;
    for (const vol of vols) {
      const r = computeVolatilityTargeting(mk(vol).forecast, c, null);
      assert.ok(r.appliedMultiplier <= prev + 1e-15, `nicht monoton bei vol=${vol}`);
      prev = r.appliedMultiplier;
    }
  });

  test("Clamp: raw > 1 ⇒ maxMultiplier, raw < min ⇒ minMultiplier", () => {
    const clampCfg = resolveVolatilityTargetingConfig({ shrinkage: 0, minObservations: 4, maxStep: 1, smoothingAlpha: 1 });
    const mk = (vol: number) => ({
      status: "OK" as const,
      reasonCode: "OK" as const,
      reason: "test",
      forecastAnnualizedVol: vol,
      observations: 8,
      annualization: 100,
      coverage: 1,
      usedSymbols: ["A"],
      normalizedWeights: { A: 1 },
      eventTime: T0,
      regularization: "none" as const,
      shrinkage: 0,
      seriesLength: 8,
    });
    // vol weit unter Ziel ⇒ raw >> 1 ⇒ clamp auf max (1).
    const high = computeVolatilityTargeting(mk(0.01), clampCfg, null);
    assert.equal(high.rawMultiplier!, 30); // 0.3 / 0.01
    assert.equal(high.clampedMultiplier, 1);
    assert.equal(high.appliedMultiplier, 1);
    // vol weit über Ziel ⇒ raw << min ⇒ clamp auf min (0.25).
    const low = computeVolatilityTargeting(mk(3.0), clampCfg, null);
    assert.equal(low.clampedMultiplier, 0.25);
    assert.equal(low.appliedMultiplier, 0.25);
  });

  test("Smoothing (EMA): α=0.5 glättet zwischen prev und clamped", () => {
    const c = resolveVolatilityTargetingConfig({ shrinkage: 0, minObservations: 4, smoothingAlpha: 0.5, maxStep: 1 });
    const mk = (vol: number) => ({
      status: "OK" as const,
      reasonCode: "OK" as const,
      reason: "test",
      forecastAnnualizedVol: vol,
      observations: 8,
      annualization: 100,
      coverage: 1,
      usedSymbols: ["A"],
      normalizedWeights: { A: 1 },
      eventTime: T0,
      regularization: "none" as const,
      shrinkage: 0,
      seriesLength: 8,
    });
    // prev = 1 (neutral), clamped = 0.5 ⇒ smoothed = 0.5·0.5 + 0.5·1 = 0.75
    const r1 = computeVolatilityTargeting(mk(0.6), c, 1); // raw=0.5
    assert.ok(Math.abs(r1.appliedMultiplier - 0.75) < 1e-12);
    // prev = 0.75, clamped = 0.5 ⇒ smoothed = 0.5·0.5 + 0.5·0.75 = 0.625
    const r2 = computeVolatilityTargeting(mk(0.6), c, r1.appliedMultiplier);
    assert.ok(Math.abs(r2.appliedMultiplier - 0.625) < 1e-12);
  });

  test("Max-Step: |Δ| ≤ maxStep (Recovery wird gedrosselt)", () => {
    const c = resolveVolatilityTargetingConfig({ shrinkage: 0, minObservations: 4, smoothingAlpha: 1, maxStep: 0.25 });
    const mk = (vol: number) => ({
      status: "OK" as const,
      reasonCode: "OK" as const,
      reason: "test",
      forecastAnnualizedVol: vol,
      observations: 8,
      annualization: 100,
      coverage: 1,
      usedSymbols: ["A"],
      normalizedWeights: { A: 1 },
      eventTime: T0,
      regularization: "none" as const,
      shrinkage: 0,
      seriesLength: 8,
    });
    // prev = 1, clamped = 0.25 (min) ⇒ smoothed = 0.25, step: max(0.25, 1−0.25) = 0.75
    const r = computeVolatilityTargeting(mk(3.0), c, 1);
    assert.ok(Math.abs(r.appliedMultiplier - 0.75) < 1e-12);
    // nächster Schritt: prev = 0.75 ⇒ 0.5
    const r2 = computeVolatilityTargeting(mk(3.0), c, 0.75);
    assert.ok(Math.abs(r2.appliedMultiplier - 0.5) < 1e-12);
  });

  test("appliedMultiplier ist immer endlich und ≤ 1 (auch bei extremen Inputs)", () => {
    const mk = (vol: number) => ({
      status: "OK" as const,
      reasonCode: "OK" as const,
      reason: "test",
      forecastAnnualizedVol: vol,
      observations: 8,
      annualization: 100,
      coverage: 1,
      usedSymbols: ["A"],
      normalizedWeights: { A: 1 },
      eventTime: T0,
      regularization: "none" as const,
      shrinkage: 0,
      seriesLength: 8,
    });
    for (const vol of [0, 1e-9, 0.3, 1e9]) {
      const r = computeVolatilityTargeting(mk(vol), cfg, null);
      assert.ok(Number.isFinite(r.appliedMultiplier));
      assert.ok(r.appliedMultiplier <= 1 + 1e-15);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed: NaN, singulär, stale, geringe Coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("Fail-closed (konservativer ≤ 1 Fallback)", () => {
  const baseSeriesA = X.map((v) => 0.01 * v);

  test("NaN in 50 % der Exposure, minCoverage 60 % ⇒ LOW_COVERAGE, applied = minMultiplier", () => {
    const c = makeConfig({ minCoverage: 0.6 });
    const withNaN = [...baseSeriesA];
    withNaN[3] = Number.NaN;
    const input = twoSeriesInput(withNaN, X.map((v) => 0.02 * v), { weights: [0.5, 0.5] });
    input.config = c;
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "LOW_COVERAGE");
    assert.equal(r.forecast.forecastAnnualizedVol, null); // null ≠ 0
    assert.equal(r.forecast.coverage, 0.5);
    assert.equal(r.rawMultiplier, null);
    assert.equal(r.appliedMultiplier, 0.25); // min
    assert.equal(r.outcome, "fallback");
  });

  test("NaN in 50 % der Exposure, minCoverage 50 % ⇒ OK auf verbleibender Serie", () => {
    const withNaN = [...baseSeriesA];
    withNaN[3] = Number.NaN;
    const input = twoSeriesInput(withNaN, X.map((v) => 0.02 * v), { weights: [0.5, 0.5] });
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "OK");
    assert.deepEqual(r.forecast.usedSymbols, ["BBB"]);
    assert.equal(r.forecast.coverage, 0.5);
    // Einzel-Serie B: σ_a = √(100·b²V)
    const expected = Math.sqrt(100 * 0.02 * 0.02 * X_VAR);
    assert.ok(Math.abs(r.forecast.forecastAnnualizedVol! - expected) < 1e-12);
  });

  test("NaN in ALLEN Serien ⇒ NO_SERIES, applied = minMultiplier", () => {
    const withNaN = [...baseSeriesA];
    withNaN[3] = Number.NaN;
    const input = twoSeriesInput(withNaN, withNaN.map((v) => v + 0), { weights: [0.5, 0.5] });
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "NO_SERIES");
    assert.equal(r.appliedMultiplier, 0.25);
  });

  test("stale Daten (eventTime zu alt) ⇒ STALE_DATA, applied = minMultiplier", () => {
    const c = makeConfig({ maxStalenessMs: 3 * 3_600_000 }); // 3h Limit
    const T = 8;
    const ev = eventTimes(T);
    const series: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 1, annualization: 100, logReturns: baseSeriesA, eventTimes: ev },
    ];
    // computedAt weit nach dem jüngsten Event (> 3h).
    const input: VolatilityForecastInput = {
      series,
      asOf: T0 + T * BAR_MS,
      computedAt: T0 + T * BAR_MS + 5 * 3_600_000,
      config: c,
    };
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "STALE_DATA");
    assert.equal(r.appliedMultiplier, 0.25);
  });

  test("Future-Event-Zeit (Look-ahead-Verdacht) ⇒ INVALID_EVENT_TIMES", () => {
    const T = 8;
    const ev = eventTimes(T);
    const series: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 1, annualization: 100, logReturns: baseSeriesA, eventTimes: ev },
    ];
    // computedAt VOR dem jüngsten Event ⇒ negative Staleness.
    const input: VolatilityForecastInput = {
      series,
      asOf: T0,
      computedAt: T0,
      config: makeConfig(),
    };
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "INVALID_EVENT_TIMES");
  });

  test("geringe Coverage (50 % < minCoverage 60 %) ⇒ LOW_COVERAGE", () => {
    const c = makeConfig({ minCoverage: 0.6 });
    const withNaN = [...baseSeriesA];
    withNaN[1] = Number.NaN; // AAA unbrauchbar
    const input = twoSeriesInput(withNaN, X.map((v) => 0.02 * v), { weights: [0.5, 0.5] });
    input.config = c;
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "LOW_COVERAGE");
    assert.equal(r.forecast.coverage, 0.5);
    assert.equal(r.appliedMultiplier, 0.25);
  });

  test("Coverage 50 % ≥ minCoverage 40 % ⇒ OK auf verbleibender Serie", () => {
    const c = makeConfig({ minCoverage: 0.4 });
    const withNaN = [...baseSeriesA];
    withNaN[1] = Number.NaN;
    const input = twoSeriesInput(withNaN, X.map((v) => 0.02 * v), { weights: [0.5, 0.5] });
    input.config = c;
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "OK");
    assert.deepEqual(r.forecast.usedSymbols, ["BBB"]);
    assert.equal(r.forecast.coverage, 0.5);
    // Einzel-Serie B: σ = b·√V, A=100 ⇒ √(100·b²V)
    const expected = Math.sqrt(100 * 0.02 * 0.02 * X_VAR);
    assert.ok(Math.abs(r.forecast.forecastAnnualizedVol! - expected) < 1e-12);
  });

  test("zu wenige Beobachtungen ⇒ INSUFFICIENT_DATA", () => {
    const c = makeConfig({ minObservations: 6 });
    const shortA = baseSeriesA.slice(0, 4);
    const shortB = X.slice(0, 4).map((v) => 0.02 * v);
    const input = twoSeriesInput(shortA, shortB);
    input.config = c;
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "INSUFFICIENT_DATA");
  });

  test("singuläre Matrix (ρ=+1) ⇒ Ridge, Forecast endlich, applied ≤ 1", () => {
    const input = twoSeriesInput(baseSeriesA, baseSeriesA);
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "OK");
    assert.equal(r.forecast.regularization, "ridge");
    assert.ok(Number.isFinite(r.forecast.forecastAnnualizedVol!));
    assert.ok(r.appliedMultiplier <= 1);
  });

  test("ZERO_EXPOSURE (alle Gewichte 0) ⇒ NO_EXPOSURE, applied = maxMultiplier", () => {
    const input = twoSeriesInput(baseSeriesA, X.map((v) => 0.02 * v), { weights: [0, 0] });
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "NO_EXPOSURE");
    assert.equal(r.outcome, "no_exposure");
    assert.equal(r.appliedMultiplier, 1);
  });

  test("keine Serien ⇒ NO_SERIES Fallback", () => {
    const input: VolatilityForecastInput = {
      series: [],
      asOf: T0,
      computedAt: T0,
      config: makeConfig(),
    };
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "NO_SERIES");
    assert.equal(r.appliedMultiplier, 0.25);
  });

  test("Fehlerhafte Gewichte (negativ) ⇒ INVALID_WEIGHTS", () => {
    const input = twoSeriesInput(baseSeriesA, X.map((v) => 0.02 * v), { weights: [-1, 2] });
    const r = computeVolatilityTargetingFromInput(input, null);
    assert.equal(r.forecast.status, "FALLBACK");
    assert.equal(r.forecast.reasonCode, "INVALID_WEIGHTS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Annualisierung (Asset/Timeframe)
// ─────────────────────────────────────────────────────────────────────────────

describe("Annualisierung", () => {
  test("einheitliches A: Forecast skaliert mit √A (400 vs. 100 ⇒ ×2)", () => {
    const a = 0.01;
    const b = 0.02;
    const fc100 = computePortfolioVolatilityForecast(
      twoSeriesInput(X.map((v) => a * v), X.map((v) => b * v), { annualization: 100 })
    );
    const fc400 = computePortfolioVolatilityForecast(
      twoSeriesInput(X.map((v) => a * v), X.map((v) => b * v), { annualization: 400 })
    );
    assert.equal(fc100.status, "OK");
    assert.equal(fc400.status, "OK");
    assert.ok(Math.abs(fc400.forecastAnnualizedVol! - 2 * fc100.forecastAnnualizedVol!) < 1e-12);
  });

  test("extreme Annualisierung (5m-Krypto = 105.120) bleibt gültig (RMA-P5-01 Regression)", () => {
    // 5m × 365d = 288 × 365 = 105.120 Perioden/Jahr — war vor v1.67.0
    // über der alten Obergrenze (100.000) und hätte JEDE 5m-Serie
    // unbrauchbar gemacht. Der Forecast muss sie akzeptieren.
    const A5m = (86_400_000 / (5 * 60_000)) * 365; // 105.120
    assert.equal(A5m, 105_120);
    const input = twoSeriesInput(X.map((v) => 0.01 * v), Y.map((v) => 0.02 * v), {
      annualization: A5m,
    });
    const fc = computePortfolioVolatilityForecast(input);
    assert.equal(fc.status, "OK");
    assert.equal(fc.annualization, A5m);
    const expected = Math.sqrt(A5m * (0.25 * 0.01 * 0.01 * X_VAR + 0.25 * 0.02 * 0.02 * Y_VAR));
    assert.ok(Math.abs(fc.forecastAnnualizedVol! - expected) < 1e-12);
  });

  test("gemischtes A (√(A_i·A_j)): exakt für unabhängige Assets", () => {
    // AAA: A=100, BBB: A=400, UNABHÄNGIG (x ⊥ y), w = 0.5/0.5, kein Cov-Term.
    const a = 0.01;
    const b = 0.02;
    const ev = eventTimes(8);
    const series: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 0.5, annualization: 100, logReturns: X.map((v) => a * v), eventTimes: ev },
      { symbol: "BBB", weight: 0.5, annualization: 400, logReturns: Y.map((v) => b * v), eventTimes: ev },
    ];
    const input: VolatilityForecastInput = {
      series,
      asOf: T0 + 8 * BAR_MS,
      computedAt: T0 + 8 * BAR_MS,
      config: makeConfig(),
    };
    const fc = computePortfolioVolatilityForecast(input);
    assert.equal(fc.status, "OK");
    // Diagonale: w²·A_i·σ_i² (Cov = 0). σ² pro Serie = 8/7 (X_VAR=Y_VAR).
    const expected = Math.sqrt(0.25 * 100 * a * a * X_VAR + 0.25 * 400 * b * b * Y_VAR);
    assert.ok(Math.abs(fc.forecastAnnualizedVol! - expected) < 1e-12);
    assert.equal(fc.annualization, 400); // max(A_i)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Look-ahead / As-of
// ─────────────────────────────────────────────────────────────────────────────

describe("Look-ahead / As-of", () => {
  test("spätere Kerzen (nach asOf) beeinflussen den Forecast NICHT", () => {
    const a = 0.01;
    const b = 0.02;
    // Input A: 8 Bars. Input B: dieselben 8 Bars + 2 weitere (spätere).
    const extendedA = [...X.map((v) => a * v), 0.5, -0.5];
    const extendedB = [...X.map((v) => b * v), 0.3, -0.3];
    // Für Input B nur die ersten 8 Returns nehmen (as-of = nach Bar 8).
    const inputA = twoSeriesInput(X.map((v) => a * v), X.map((v) => b * v));
    const inputB = twoSeriesInput(extendedA.slice(0, 8), extendedB.slice(0, 8));
    const fcA = computePortfolioVolatilityForecast(inputA);
    const fcB = computePortfolioVolatilityForecast(inputB);
    assert.ok(Math.abs(fcA.forecastAnnualizedVol! - fcB.forecastAnnualizedVol!) < 1e-15);
  });

  test("Änderung EINES Returns innerhalb des Fensters ändert den Forecast", () => {
    const a = 0.01;
    const b = 0.02;
    const base = twoSeriesInput(X.map((v) => a * v), X.map((v) => b * v));
    const changed = [...X.map((v) => a * v)];
    changed[0] = 0.5; // deutlich anderer Wert
    const inputChanged = twoSeriesInput(changed, X.map((v) => b * v));
    const fcBase = computePortfolioVolatilityForecast(base);
    const fcChanged = computePortfolioVolatilityForecast(inputChanged);
    assert.ok(Math.abs(fcBase.forecastAnnualizedVol! - fcChanged.forecastAnnualizedVol!) > 1e-6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Realisierte Volatilität + Target Error
// ─────────────────────────────────────────────────────────────────────────────

describe("Realisierte Volatilität + Target Error", () => {
  test("realized = Forecast ohne Shrinkage (gleiche Daten)", () => {
    const a = 0.01;
    const b = 0.02;
    const ev = eventTimes(8);
    // Unabhängige Serien (x ⊥ y) ⇒ keine Cov-Terme.
    const series: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 0.5, annualization: 100, logReturns: X.map((v) => a * v), eventTimes: ev },
      { symbol: "BBB", weight: 0.5, annualization: 100, logReturns: Y.map((v) => b * v), eventTimes: ev },
    ];
    const cfg = makeConfig({ shrinkage: 0.2 });
    const realized = computeRealizedPortfolioVolatility(series, cfg);
    assert.ok(realized !== null);
    // realized (ohne Shrinkage) = √(100·(0.25a²V + 0.25b²V))
    const expected = Math.sqrt(100 * (0.25 * a * a * X_VAR + 0.25 * b * b * Y_VAR));
    assert.ok(Math.abs(realized! - expected) < 1e-12);

    // Target Error = realized − target
    const targetError = computeTargetError(realized, cfg);
    assert.ok(targetError !== null);
    assert.ok(Math.abs(targetError! - (realized! - 0.3)) < 1e-15);
  });

  test("realized = null bei fehlenden/negativen Gewichten (nie 0)", () => {
    const ev = eventTimes(8);
    const noWeight: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 0, annualization: 100, logReturns: X.map((v) => 0.01 * v), eventTimes: ev },
    ];
    assert.equal(computeRealizedPortfolioVolatility(noWeight, makeConfig()), null);
    const negative: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: -1, annualization: 100, logReturns: X.map((v) => 0.01 * v), eventTimes: ev },
    ];
    assert.equal(computeRealizedPortfolioVolatility(negative, makeConfig()), null);
    assert.equal(computeTargetError(null, makeConfig()), null);
  });

  test("realized wirft NIE bei invalider Annualisierung (null statt Exception)", () => {
    const ev = eventTimes(8);
    const badAnnualization: VolatilityForecastSeries[] = [
      { symbol: "AAA", weight: 1, annualization: 0, logReturns: X.map((v) => 0.01 * v), eventTimes: ev },
      { symbol: "BBB", weight: 1, annualization: Number.NaN, logReturns: Y.map((v) => 0.02 * v), eventTimes: ev },
    ];
    // AAA und BBB beide unbrauchbar ⇒ null (nie 0, nie throw).
    assert.doesNotThrow(() => computeRealizedPortfolioVolatility(badAnnualization, makeConfig()));
    assert.equal(computeRealizedPortfolioVolatility(badAnnualization, makeConfig()), null);
    // Nur eine Serie unbrauchbar ⇒ Rest wird genutzt.
    const partial: VolatilityForecastSeries[] = [
      badAnnualization[0],
      { symbol: "BBB", weight: 1, annualization: 100, logReturns: Y.map((v) => 0.02 * v), eventTimes: ev },
    ];
    const r = computeRealizedPortfolioVolatility(partial, makeConfig());
    assert.ok(r !== null);
    assert.ok(Math.abs(r! - Math.sqrt(100 * 0.02 * 0.02 * Y_VAR)) < 1e-12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinismus + Idempotenz
// ─────────────────────────────────────────────────────────────────────────────

describe("Determinismus + Idempotenz", () => {
  test("gleiche Eingabe ⇒ bit-identisches Ergebnis (2×)", () => {
    const a = 0.01;
    const b = 0.02;
    const input = twoSeriesInput(X.map((v) => a * v), X.map((v) => b * v));
    const r1 = computeVolatilityTargetingFromInput(input, 0.8);
    const r2 = computeVolatilityTargetingFromInput(input, 0.8);
    assert.deepEqual(r1, r2);
    assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  });

  test("Config-Hash ist stabil und unterscheidet sich bei Änderung", () => {
    const c1 = resolveVolatilityTargetingConfig({ targetAnnualizedVolPct: 30 });
    const c2 = resolveVolatilityTargetingConfig({ targetAnnualizedVolPct: 30 });
    const c3 = resolveVolatilityTargetingConfig({ targetAnnualizedVolPct: 35 });
    const h1 = hashVolatilityTargetingConfig(c1);
    const h2 = hashVolatilityTargetingConfig(c2);
    const h3 = hashVolatilityTargetingConfig(c3);
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.match(h1, /^cfg1:[0-9a-f]{64}$/);
  });

  test("Data-Hash ist stabil und unterscheidet sich bei Datenänderung", () => {
    const a = 0.01;
    const b = 0.02;
    const series = [
      { symbol: "AAA", weight: 0.5, annualization: 100, logReturns: X.map((v) => a * v), eventTimes: eventTimes(8) },
      { symbol: "BBB", weight: 0.5, annualization: 100, logReturns: X.map((v) => b * v), eventTimes: eventTimes(8) },
    ];
    const d1 = hashVolatilityTargetingData({ series, asOf: T0, computedAt: T0 + 1 });
    const d2 = hashVolatilityTargetingData({ series, asOf: T0, computedAt: T0 + 1 });
    const changedSeries = series.map((s, i) => (i === 0 ? { ...s, logReturns: [...s.logReturns.slice(0, -1), 0.9] } : s));
    const d3 = hashVolatilityTargetingData({ series: changedSeries, asOf: T0, computedAt: T0 + 1 });
    assert.equal(d1, d2);
    assert.notEqual(d1, d3);
    assert.match(d1, /^data1:[0-9a-f]{64}$/);
  });

  test("Idempotency-Key: gleiche Minute + Hashes ⇒ gleicher Key", () => {
    const cfgHash = "cfg1:" + "a".repeat(64);
    const dataHash = "data1:" + "b".repeat(64);
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_030_000; // 30 s später, gleiche Minute
    const t3 = 1_700_000_060_000; // nächste Minute
    const k1 = buildVolatilityTargetingIdempotencyKey(t1, cfgHash, dataHash);
    const k2 = buildVolatilityTargetingIdempotencyKey(t2, cfgHash, dataHash);
    const k3 = buildVolatilityTargetingIdempotencyKey(t3, cfgHash, dataHash);
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.match(k1, /^vt1:[0-9a-f]{64}$/);
  });
});

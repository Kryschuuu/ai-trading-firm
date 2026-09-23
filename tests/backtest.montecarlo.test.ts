/**
 * Tests: Monte-Carlo-/Trade-Resampling — reine Engine (RMA-P6-02, v1.72.0).
 *
 * Deckung (Definition of Done):
 *   1. Determinismus: gleicher Seed/Config/Input ⇒ byte-stabiles Result;
 *      anderer Seed ändert Pfade, nicht die Metadatensemantik.
 *   2. Analytische Fixtures: konstante Verluste ⇒ Ruin/MaxDD/Losing-Streak/
 *      End-Equity exakt (jeder Pfad identisch); konstante Gewinne ⇒ MaxDD 0.
 *   3. Block-Bootstrap: Blocklänge = n erhält die Original-Sequenz exakt;
 *      Blocklänge 2 auf alternierendem Muster erhält Paarprodukte.
 *   4. Elgibility/Bounds: Mindeststichprobe, Blocklängen, Seed/runs/Ruin/
 *      Equity/Stress-Bounds, unbekannte Methoden/Segmente.
 *   5. Stress: Kostenverschärfung verschlechtert End-Equity/Ruin monoton
 *      (gleicher Seed ⇒ identische Ziehungen).
 *   6. Immutabilität: Eingabe-Trades werden nicht mutiert.
 *   7. Negative Paths: NaN, notional ≤ 0, negative Kosten, seq-Ordnung,
 *      gemischte Symbole, ruinierte Quelle, Spanne 0, No-Op-Stress.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveTradesPerYear,
  MC_ALGORITHM_VERSION,
  MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT,
  MC_MIN_SAMPLE_TRADES,
  MC_MS_PER_YEAR,
  MC_QUANTILE_LEVELS,
  monteCarloIdempotencyKey,
  monteCarloInputHash,
  MonteCarloError,
  nearestRankQuantile,
  resolveMonteCarloConfig,
  runMonteCarloSimulation,
  validateMonteCarloSample,
  type MonteCarloConfig,
  type MonteCarloTradeInput,
} from "../src/backtest/montecarlo";

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FixtureOptions {
  /** Netto-PnL je Trade als Anteil der realisierten Equity DAVOR (exakt). */
  pnlFraction?: (i: number) => number;
  /** Alternative: feste PnL-Beträge (Kontowährung). */
  pnlFixed?: (i: number) => number;
  fees?: (i: number) => number;
  slippage?: (i: number) => number;
  notional?: (i: number) => number;
  symbol?: (i: number) => string;
  initialEquity?: number;
  /** Gesamte Zeitspanne der Ereigniszeiten in ms (Default: 1 Jahr). */
  spanMs?: number;
}

function makeTrades(count: number, opts: FixtureOptions = {}): MonteCarloTradeInput[] {
  const initialEquity = opts.initialEquity ?? 10_000;
  const spanMs = opts.spanMs ?? MC_MS_PER_YEAR;
  const step = spanMs / count;
  let equity = initialEquity;
  const trades: MonteCarloTradeInput[] = [];
  for (let i = 0; i < count; i++) {
    const pnl =
      opts.pnlFixed !== undefined
        ? opts.pnlFixed(i)
        : (opts.pnlFraction?.(i) ?? 0.01) * equity;
    trades.push({
      seq: i + 1,
      symbol: opts.symbol?.(i) ?? "BITUNIX:BTCUSDT",
      strategyId: "RULE-BITUNIX:BTCUSDT",
      entryTs: Math.round(i * step),
      exitTs: Math.round((i + 1) * step),
      pnlNet: pnl,
      fees: opts.fees?.(i) ?? 0,
      slippage: opts.slippage?.(i) ?? 0,
      notional: opts.notional?.(i) ?? 2_000,
    });
    equity += pnl;
  }
  return trades;
}

/** Gemischtes, deterministisches Muster (Gewinne/Verluste/Kosten). */
function mixedTrades(count = 40): MonteCarloTradeInput[] {
  return makeTrades(count, {
    pnlFixed: (i) => [120, -60, 200, -90, 40, -150, 80, 30, -45, 160][i % 10],
    fees: () => 12,
    slippage: () => 6,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof MonteCarloError, `erwartete MonteCarloError, erhielt ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

/** `validateMonteCarloSample` liefert ein Result-Objekt (kein Throw). */
function expectSampleCode(
  trades: MonteCarloTradeInput[],
  code: string
): void {
  const checked = validateMonteCarloSample(trades);
  assert.ok(!checked.ok, `erwartete Abweisung (${code}), erhalten ok`);
  assert.ok(checked.error instanceof MonteCarloError);
  assert.equal(checked.error.code, code);
}

function approx(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: ${actual} weicht von ${expected} um mehr als ${tol} ab`
  );
}

// ── 1) Determinismus ────────────────────────────────────────────────────────

describe("montecarlo: Determinismus & Seed-Semantik", () => {
  it("gleicher Seed/Config/Input erzeugt byte-stabile Summary", () => {
    const trades = mixedTrades();
    const config: MonteCarloConfig = { method: "iid", seed: 42, runs: 200, segment: "ALL" };
    const a = runMonteCarloSimulation({ sourceRunId: "11111111-1111-4111-8111-111111111111", trades, config });
    const b = runMonteCarloSimulation({ sourceRunId: "11111111-1111-4111-8111-111111111111", trades, config: { ...config } });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.match(a.idempotencyKey, /^mcs1:[0-9a-f]{64}$/);
    assert.match(a.inputTradesHash, /^[0-9a-f]{64}$/);
  });

  it("anderer Seed ändert Pfade, nicht Metadaten-Semantik", () => {
    const trades = mixedTrades();
    const base = { method: "moving_block" as const, blockLength: 5, runs: 200, segment: "ALL" as const };
    const a = runMonteCarloSimulation({ sourceRunId: "11111111-1111-4111-8111-111111111111", trades, config: { ...base, seed: 1 } });
    const b = runMonteCarloSimulation({ sourceRunId: "11111111-1111-4111-8111-111111111111", trades, config: { ...base, seed: 2 } });
    assert.notEqual(a.idempotencyKey, b.idempotencyKey, "Seed muss den Key ändern");
    assert.equal(a.summary.stats.sampleTrades, b.summary.stats.sampleTrades);
    assert.equal(a.summary.stats.runs, b.summary.stats.runs);
    assert.equal(a.summary.stats.method, b.summary.stats.method);
    assert.equal(a.summary.stats.blockLength, b.summary.stats.blockLength);
    assert.equal(a.summary.stats.blocksDrawn, b.summary.stats.blocksDrawn, "moving_block: feste Blockanzahl je Pfad");
    assert.deepEqual(a.summary.observed, b.summary.observed, "empirische Beobachtung ist seed-unabhängig");
    assert.deepEqual(a.summary.observedStressed, b.summary.observedStressed);
    assert.notEqual(
      JSON.stringify(a.summary.resampled),
      JSON.stringify(b.summary.resampled),
      "unterschiedliche Seeds müssen unterschiedliche Verteilungen erzeugen"
    );
  });

  it("Quantile sind geordnet: p05 ≤ p50 ≤ p95 (Nearest-Rank)", () => {
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades: mixedTrades(),
      config: { method: "iid", seed: 3, runs: 300, segment: "ALL" },
    });
    for (const m of [
      result.summary.resampled.endEquity,
      result.summary.resampled.maxDrawdownPct,
      result.summary.resampled.sharpeRatio,
      result.summary.resampled.losingStreak,
    ]) {
      assert.ok(m.p05 <= m.p50 && m.p50 <= m.p95, `p05 ≤ p50 ≤ p95 verletzt: ${JSON.stringify(m)}`);
    }
  });

  it("Nearest-Rank-Quantil ist exakt (Typ 1, keine Interpolation)", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(nearestRankQuantile(sorted, 0.05), 1);
    assert.equal(nearestRankQuantile(sorted, 0.5), 5);
    assert.equal(nearestRankQuantile(sorted, 0.95), 10);
    assert.equal(nearestRankQuantile([42], 0.5), 42);
    assert.deepEqual(MC_QUANTILE_LEVELS, [0.05, 0.5, 0.95]);
  });
});

// ── 2) Analytische Fixtures ─────────────────────────────────────────────────

describe("montecarlo: analytische Fixtures", () => {
  it("konstante Verluste (−10 % der Equity): Ruin/MaxDD/Streak/End-Equity exakt", () => {
    const n = 30;
    const trades = makeTrades(n, { pnlFraction: () => -0.1 });
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "iid", seed: 5, runs: 200, segment: "ALL", ruinThresholdPct: 50 },
    });
    // Jeder Pfad ist identisch (alle Trades gleich): Verteilung entartet.
    const r = result.summary.resampled;
    approx(r.endEquity.p05, 10_000 * Math.pow(0.9, n), 0.05, "p05 End-Equity");
    approx(r.endEquity.p50, 10_000 * Math.pow(0.9, n), 0.05, "p50 End-Equity");
    approx(r.endEquity.p95, 10_000 * Math.pow(0.9, n), 0.05, "p95 End-Equity");
    approx(r.maxDrawdownPct.p50, (1 - Math.pow(0.9, n)) * 100, 0.05, "p50 MaxDD");
    assert.equal(r.losingStreak.p05, n);
    assert.equal(r.losingStreak.p95, n);
    assert.equal(r.exceedance.ruinProbability, 1, "0.9^7 ≈ 0.478 < 0.5 ⇒ jeder Pfad ruiniert");
    assert.equal(r.exceedance.endBelowStartProbability, 1);
    assert.equal(r.mcse.ruinProbability, 0, "deterministisches Ereignis ⇒ MCSE 0");
    assert.equal(result.summary.observed.ruined, true);
    assert.equal(result.summary.observed.losingStreak, n);
    // Drawdown-Exceedance: Schwellen geordnet, alle ≤ 95.76 %… aber ≥ 50-Schwelle.
    const dd50 = r.exceedance.maxDrawdownGtePct.find((x) => x.thresholdPct === 50);
    assert.ok(dd50);
    assert.equal(dd50.probability, 1);
    assert.deepEqual(
      r.exceedance.maxDrawdownGtePct.map((x) => x.thresholdPct),
      [...MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT]
    );
  });

  it("konstante Gewinne (+5 %): MaxDD 0, kein Ruin, keine Losing Streak", () => {
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades: makeTrades(30, { pnlFraction: () => 0.05 }),
      config: { method: "iid", seed: 5, runs: 200, segment: "ALL" },
    });
    const r = result.summary.resampled;
    assert.equal(r.maxDrawdownPct.p95, 0);
    assert.equal(r.losingStreak.p95, 0);
    assert.equal(r.exceedance.ruinProbability, 0);
    assert.equal(r.exceedance.endBelowStartProbability, 0);
    approx(r.endEquity.p50, 10_000 * Math.pow(1.05, 30), 0.05, "End-Equity");
    // Sharpe: fast-konstante Renditen ⇒ sehr großes positives Signal (ulps)
    // — Kernel-Konvention bei σ = 0 ist 0; hier ist σ > 0 (FP-Rauschen).
    assert.ok(Number.isFinite(r.sharpeRatio.p50) && r.sharpeRatio.p50 > 0, "durchweg positive Renditen ⇒ Sharpe > 0");
  });

  it("Ruin-Schwelle 100 %: jede Unterbilanz ruiniert (Grenzfall erlaubt)", () => {
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades: mixedTrades(),
      config: { method: "iid", seed: 9, runs: 200, segment: "ALL", ruinThresholdPct: 100 },
    });
    assert.ok(result.summary.resampled.exceedance.ruinProbability > 0, "gemischte Trades müssen zeitweise unter Start fallen");
    assert.ok(result.summary.resampled.exceedance.ruinProbability <= 1);
  });
});

// ── 3) Block-Bootstrap ──────────────────────────────────────────────────────

describe("montecarlo: Block-Bootstrap erhält Blöcke und Grenzen", () => {
  it("moving_block mit Blocklänge = n: jeder Pfad ist die Original-Sequenz", () => {
    const trades = mixedTrades(36);
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "moving_block", blockLength: 36, runs: 150, segment: "ALL", seed: 11 },
    });
    assert.equal(result.summary.stats.blocksDrawn, 150, "ein Block pro Pfad");
    assert.equal(result.summary.resampled.endEquity.p05, result.summary.observed.endEquity);
    assert.equal(result.summary.resampled.endEquity.p95, result.summary.observed.endEquity);
    assert.equal(result.summary.resampled.losingStreak.p50, result.summary.observed.losingStreak);
    assert.equal(
      result.summary.resampled.exceedance.ruinProbability,
      result.summary.observed.ruined ? 1 : 0
    );
  });

  it("moving_block mit Blocklänge 2 auf alternierendem Muster erhält Paarprodukte", () => {
    // +10 % / −10 % im Wechsel: Jeder 2er-Block hat das Produkt 1.1·0.9 = 0.99,
    // egal ob (A,B) oder (B,A) — die End-Equity EVERY path ist 10000·0.99^18.
    const n = 36;
    const trades = makeTrades(n, { pnlFraction: (i) => (i % 2 === 0 ? 0.1 : -0.1) });
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "moving_block", blockLength: 2, runs: 200, segment: "ALL", seed: 13 },
    });
    const expected = 10_000 * Math.pow(0.99, n / 2);
    // Toleranz: 4-Nachkommastellen-Rundung der Summary + FP-Assoziativität.
    const tol = Math.abs(expected) * 1e-9 + 1e-3;
    approx(result.summary.resampled.endEquity.p05, expected, tol, "p05");
    approx(result.summary.resampled.endEquity.p50, expected, tol, "p50");
    approx(result.summary.resampled.endEquity.p95, expected, tol, "p95");
    assert.ok(result.summary.stats.blocksDrawn >= 200 * Math.ceil(n / 2));
  });

  it("stationary_block läuft deterministisch und zieht mindestens einen Block pro Pfad", () => {
    const trades = mixedTrades();
    const a = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "stationary_block", blockLength: 8, runs: 150, segment: "ALL", seed: 21 },
    });
    const b = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "stationary_block", blockLength: 8, runs: 150, segment: "ALL", seed: 21 },
    });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a.summary.stats.blocksDrawn >= 150, "mindestens 1 Block je Pfad");
    assert.ok(a.summary.stats.blocksDrawn <= 150 * 40, "höchstens n Blöcke je Pfad (Blocklänge 1-Semantik)");
  });
});

// ── 4) Eligibility & Bounds ─────────────────────────────────────────────────

describe("montecarlo: Eligibility & Bounds (fail-closed)", () => {
  it("unzureichende Stichprobe wird abgelehnt (29 < 30)", () => {
    expectCode(
      () =>
        runMonteCarloSimulation({
          sourceRunId: "11111111-1111-4111-8111-111111111111",
          trades: mixedTrades(29),
          config: { method: "iid", segment: "ALL" },
        }),
      "mc:insufficient-sample"
    );
    assert.equal(MC_MIN_SAMPLE_TRADES, 30);
  });

  it("ungültige Blocklängen werden abgelehnt", () => {
    const trades = mixedTrades(40);
    expectCode(
      () => runMonteCarloSimulation({ sourceRunId: "x", trades, config: { method: "moving_block", blockLength: 1, segment: "ALL" } }),
      "mc:invalid-config"
    );
    expectCode(
      () => runMonteCarloSimulation({ sourceRunId: "x", trades, config: { method: "stationary_block", blockLength: 41, segment: "ALL" } }),
      "mc:invalid-config"
    );
    expectCode(
      () => runMonteCarloSimulation({ sourceRunId: "x", trades, config: { method: "moving_block", segment: "ALL" } }),
      "mc:invalid-config"
    );
    expectCode(
      () => runMonteCarloSimulation({ sourceRunId: "x", trades, config: { method: "iid", blockLength: 5, segment: "ALL" } }),
      "mc:invalid-config"
    );
  });

  it("Config-Bounds: seed/runs/ruin/equity/stress/method/segment", () => {
    const trades = mixedTrades();
    const base = { method: "iid" as const, segment: "ALL" as const };
    expectCode(() => resolveMonteCarloConfig({ ...base, seed: -1 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, seed: 4_294_967_296 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, seed: 1.5 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, runs: 99 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, runs: 100_001 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, ruinThresholdPct: 0 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, ruinThresholdPct: 100.5 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, initialEquity: 0 }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, initialEquity: -5 }), "mc:invalid-config");
    expectCode(
      () => resolveMonteCarloConfig({ ...base, stress: { feeMultiplier: 0.5, slippageMultiplier: 1 } }),
      "mc:invalid-config"
    );
    expectCode(
      () => resolveMonteCarloConfig({ ...base, stress: { feeMultiplier: 1, slippageMultiplier: 1 } }),
      "mc:invalid-config"
    );
    expectCode(() => resolveMonteCarloConfig({ ...base, method: "magic" as never }), "mc:invalid-config");
    expectCode(() => resolveMonteCarloConfig({ ...base, segment: "EVAL" as never }), "mc:invalid-config");
    // Grenzen sind INKLUSIV: seed 0, seed 2^32−1, runs 100, ruin 100.
    const resolved = resolveMonteCarloConfig({ ...base, seed: 0, runs: 100, ruinThresholdPct: 100 });
    assert.equal(resolved.seed, 0);
    assert.equal(resolved.runs, 100);
    assert.equal(resolved.ruinThresholdPct, 100);
    assert.equal(resolveMonteCarloConfig({ ...base, seed: 4_294_967_295 }).seed, 4_294_967_295);
    assert.equal(resolved.algorithmVersion, MC_ALGORITHM_VERSION);
    assert.equal(resolved.prngAlgorithm, "mulberry32-v1");
  });
});

// ── 5) Kostenstress ─────────────────────────────────────────────────────────

describe("montecarlo: Kostenstress verschlechtert monoton", () => {
  it("höhere Gebühren-Multiplikatoren senken End-Equity und erhöhen Ruin (gleicher Seed)", () => {
    const trades = mixedTrades(40);
    const base = { method: "iid" as const, seed: 7, runs: 300, segment: "ALL" as const, ruinThresholdPct: 70 };
    const baseline = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { ...base },
    });
    const m2 = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { ...base, stress: { feeMultiplier: 2, slippageMultiplier: 1 } },
    });
    const m5 = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { ...base, stress: { feeMultiplier: 5, slippageMultiplier: 1 } },
    });
    // Gleiche Ziehungen (Seed unabhängig vom Stress) ⇒ pointwise monotone Pfade.
    assert.ok(m2.summary.resampled.endEquity.p50 <= baseline.summary.resampled.endEquity.p50, "p50: m2 ≤ baseline");
    assert.ok(m5.summary.resampled.endEquity.p50 <= m2.summary.resampled.endEquity.p50, "p50: m5 ≤ m2");
    assert.ok(m2.summary.resampled.endEquity.p05 <= baseline.summary.resampled.endEquity.p05, "p05: m2 ≤ baseline");
    assert.ok(m5.summary.resampled.endEquity.p05 <= m2.summary.resampled.endEquity.p05, "p05: m5 ≤ m2");
    assert.ok(m2.summary.resampled.exceedance.ruinProbability >= baseline.summary.resampled.exceedance.ruinProbability);
    assert.ok(m5.summary.resampled.exceedance.ruinProbability >= m2.summary.resampled.exceedance.ruinProbability);
    // Szenario-Trennung: observed ist immer die ungestresste Empirie.
    assert.equal(baseline.summary.stats.scenario, "baseline");
    assert.equal(baseline.summary.observedStressed, null);
    assert.equal(m2.summary.stats.scenario, "stress");
    assert.ok(m2.summary.observedStressed !== null);
    assert.deepEqual(baseline.summary.observed, m2.summary.observed, "empirische Beobachtung ist stress-unabhängig");
    assert.ok(m5.summary.observedStressed !== null);
    assert.ok(
      m5.summary.observedStressed.endEquity < m5.summary.observed.endEquity,
      "Stress auf Original-Sequenz muss das Nettoergebnis verschlechtern"
    );
    assert.ok(m5.summary.observedStressed.endEquity <= m2.summary.observedStressed!.endEquity, "monoton auch beobachtet");
    assert.ok(m2.summary.caveats.includes("stress:first-order-cost-only-fixed-sequence-and-exposure"));
  });
});

// ── 6) Immutabilität ────────────────────────────────────────────────────────

describe("montecarlo: Eingabe bleibt unverändert", () => {
  it("Inputtrades werden weder mutiert noch umsortiert", () => {
    const trades = mixedTrades();
    const before = JSON.stringify(trades);
    runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "stationary_block", blockLength: 6, runs: 150, segment: "ALL", seed: 2 },
    });
    assert.equal(JSON.stringify(trades), before);
    assert.deepEqual(
      trades.map((t) => t.seq),
      trades.map((_, i) => i + 1),
      "Reihenfolge unverändert"
    );
  });
});

// ── 7) Negative Paths ───────────────────────────────────────────────────────

describe("montecarlo: negative Paths (invalide, fehlende, stale-artige Inputs)", () => {
  it("NaN/unendliche Zahlen, notional ≤ 0, negative Kosten werden abgelehnt", () => {
    const badPnl = mixedTrades();
    (badPnl[3] as { pnlNet: number }).pnlNet = Number.NaN;
    expectSampleCode(badPnl, "mc:invalid-trades");

    const badNotional = mixedTrades();
    (badNotional[7] as { notional: number }).notional = 0;
    expectSampleCode(badNotional, "mc:invalid-trades");

    const badFees = mixedTrades();
    (badFees[2] as { fees: number }).fees = -1;
    expectSampleCode(badFees, "mc:invalid-trades");

    const badInfinity = mixedTrades();
    (badInfinity[0] as { pnlNet: number }).pnlNet = Number.POSITIVE_INFINITY;
    expectSampleCode(badInfinity, "mc:invalid-trades");
  });

  it("seq muss streng aufsteigend sein", () => {
    const badSeq = mixedTrades();
    (badSeq[5] as { seq: number }).seq = badSeq[4].seq;
    expectSampleCode(badSeq, "mc:invalid-trades");
  });

  it("gemischte Symbole werden abgelehnt (keine Normalisierungsilusion)", () => {
    const mixed = makeTrades(40, { symbol: (i) => (i % 2 === 0 ? "BITUNIX:BTCUSDT" : "BITUNIX:ETHUSDT") });
    expectSampleCode(mixed, "mc:mixed-symbols");
  });

  it("ruinierte Quelle (realisierte Equity ≤ 0) wird abgelehnt", () => {
    const ruined = makeTrades(40, {
      pnlFixed: (i) => (i === 0 ? -10_000 : 10), // erster Trade wischt die Equity
    });
    expectCode(
      () =>
        runMonteCarloSimulation({
          sourceRunId: "11111111-1111-4111-8111-111111111111",
          trades: ruined,
          config: { method: "iid", segment: "ALL" },
        }),
      "mc:source-ruined"
    );
  });

  it("Spanne 0 / nicht ableitbare Jahresnormierung wird abgelehnt (fail-closed)", () => {
    const zeroSpan = makeTrades(40, { spanMs: 0 });
    assert.ok(zeroSpan.every((t) => Number.isFinite(t.entryTs)));
    expectCode(() => deriveTradesPerYear(zeroSpan), "mc:span-not-derivable");
    // Stale-artig degeneriert: alle Zeitstempel identisch.
    const flat = zeroSpan.map((t) => ({ ...t, entryTs: 1000, exitTs: 1000 }));
    expectCode(() => deriveTradesPerYear(flat), "mc:span-not-derivable");
  });

  it("Jahresnormierung: 1 Jahr Spanne ⇒ n Trades/Jahr", () => {
    const n = 40;
    const trades = makeTrades(n, { spanMs: MC_MS_PER_YEAR });
    const tpy = deriveTradesPerYear(trades);
    approx(tpy, n, 0.01, "tradesPerYear");
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades,
      config: { method: "iid", seed: 1, runs: 150, segment: "ALL" },
    });
    approx(result.summary.stats.annualizationTradesPerYear, n, 0.01, "stats.annualizationTradesPerYear");
  });

  it("exitTs vor entryTs wird abgelehnt (Zeitsemantik)", () => {
    const swapped = mixedTrades();
    const t = swapped[4];
    (swapped[4] as { entryTs: number }).entryTs = t.exitTs + 1;
    expectSampleCode(swapped, "mc:invalid-trades");
  });
});

// ── 8) Hashes & Idempotenz-Key ──────────────────────────────────────────────

describe("montecarlo: Hashes & Idempotenz-Key", () => {
  it("Input-Hash ist inhalts-sensitiv und stabil", () => {
    const trades = mixedTrades();
    const h1 = monteCarloInputHash(trades);
    assert.equal(h1, monteCarloInputHash([...trades]));
    const changed = [...trades];
    (changed[9] as { pnlNet: number }).pnlNet += 0.01;
    assert.notEqual(h1, monteCarloInputHash(changed));
  });

  it("Idempotenz-Key trennt Seed, Methode, Segment und Equity-Basis", () => {
    const trades = mixedTrades();
    const key = (over: Partial<MonteCarloConfig>) =>
      monteCarloIdempotencyKey({
        sourceRunId: "22222222-2222-4222-8222-222222222222",
        config: resolveMonteCarloConfig({ method: "iid", segment: "OOS", ...over }),
        inputTradesHash: monteCarloInputHash(trades),
      });
    const base = key({});
    assert.notEqual(base, key({ seed: 99 }));
    assert.notEqual(base, key({ method: "moving_block", blockLength: 4 }));
    assert.notEqual(base, key({ segment: "ALL" }));
    assert.notEqual(base, key({ initialEquity: 20_000 }));
    assert.notEqual(base, key({ stress: { feeMultiplier: 2, slippageMultiplier: 1 } }));
    assert.match(base, /^mcs1:[0-9a-f]{64}$/);
  });
});

// ── 9) Summary-Form (bounded, getrennte Ebenen) ─────────────────────────────

describe("montecarlo: Summary-Form", () => {
  it("trennt Beobachtung, Resampling und Stress; keine Rohpfade", () => {
    const result = runMonteCarloSimulation({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      trades: mixedTrades(),
      config: { method: "iid", seed: 4, runs: 200, segment: "ALL", stress: { feeMultiplier: 3, slippageMultiplier: 1 } },
    });
    const s = result.summary;
    assert.deepEqual(Object.keys(s).sort(), ["caveats", "observed", "observedStressed", "resampled", "stats"]);
    assert.deepEqual(
      Object.keys(s.resampled).sort(),
      ["endEquity", "exceedance", "losingStreak", "maxDrawdownPct", "mcse", "sharpeRatio"]
    );
    assert.equal(s.observedStressed !== null, true, "Stress-Szenario muss den beobachteten Anker enthalten");
    assert.ok(s.stats.runs === 200 && s.stats.sampleTrades === 40 && s.stats.horizonTrades === 40);
    assert.ok(s.caveats.length >= 4 && s.caveats.every((c) => c.length <= 80), "Caveats sind kurz und konstant");
    const serialized = JSON.stringify(s);
    assert.ok(serialized.length < 8_000, "Summary bleibt bounded (< 8 KB)");
    assert.ok(!serialized.includes('"paths"') && !serialized.includes("pathEquity"), "keine Rohpfade in der Summary");
  });
});

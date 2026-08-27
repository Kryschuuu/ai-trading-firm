/**
 * Tests der Risk-Guard-Kette (Task 05).
 *
 * Geprüft wird die **Autorität**: Position Limits → Correlation Limits,
 * strukturierte Gründe, Kappung/Umverteilung, Verwurf bei Unerfüllbarkeit und
 * ein Audit-Eintrag je Entscheidung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyRiskGuard, assertAuthorityChain, capFor, resolveGuardConfig } from "../src/portfolio/riskGuard";
import { optimizePortfolio } from "../src/portfolio/optimize";
import { optimizeWithGuard, assertNoWeightsOnRejection } from "../src/portfolio/pipeline";
import {
  correlationClusters,
  correlationMatrix,
  covarianceAsMatrix,
  covarianceMatrix,
  returnsMatrix,
} from "../src/portfolio/correlation";
import { fromRows } from "../src/portfolio/numeric";
import { createAuditLogger, memoryAuditSink } from "../src/portfolio/audit";
import { PortfolioError } from "../src/portfolio/errors";
import { AUTHORITY_CHAIN, OPTIMIZER_AUTHORITY, type RawOptimizationResult } from "../src/portfolio/types";
import { factorReturns, fixedClock, seriesFrom, symbols, threeHighlyCorrelatedSeries } from "./fixtures/portfolioFixtures";

/** Diagonale Kovarianz ⇒ Min-Variance-Gewichte ∝ 1/σ² (gut vorhersagbar). */
const DIAG5 = fromRows([
  [0.01, 0, 0, 0, 0],
  [0, 0.04, 0, 0, 0],
  [0, 0, 0.09, 0, 0],
  [0, 0, 0, 0.16, 0],
  [0, 0, 0, 0, 0.25],
]);
const NAMES5 = symbols(5);

/** Unkorrelierte Renditen (Korrelationsmatrix ≈ Identität). */
function uncorrelated(n: number, periods = 60, seed = 4711): number[][] {
  const columns: number[][] = [];
  const base = factorReturns(n, periods, seed);
  for (let i = 0; i < n; i++) {
    // Jedes Asset bekommt eine eigene, verschobene Zufallsfolge ⇒ ρ ≈ 0.
    columns.push(factorReturns(1, periods, seed + i * 101)[0].map((v, t) => v + base[i][t] * 0.0001));
  }
  return columns;
}

/** Ungeprüftes Optimizer-Ergebnis aus einer diagonalen Kovarianz. */
function rawMinVariance(): RawOptimizationResult {
  return optimizePortfolio({ symbols: NAMES5, covariance: DIAG5, mode: "min_variance" });
}

/** Identitäts-Korrelation (jedes Asset ein eigener Cluster). */
function identityCorrelation(names: readonly string[]) {
  const n = names.length;
  return {
    method: "pearson" as const,
    symbols: names.slice(),
    matrix: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))),
    observations: 10,
  };
}

test("Konfiguration: Defaults und Validierung", () => {
  const config = resolveGuardConfig();
  assert.equal(config.maxWeightPerInstrument, 0.2);
  assert.equal(config.maxClusterExposure, 0.5);
  assert.equal(config.threshold, 0.8);
  assert.equal(config.minWeight, 0.001);
  assert.equal(config.maxAdjustmentRounds, 50);
  assert.equal(config.allowCashResidual, false);
  assert.equal(capFor("NVDA", config), 0.2);

  const custom = resolveGuardConfig({
    position: { maxWeightPerInstrument: 0.3, perSymbol: { NVDA: 0.05 }, minWeight: 0.01, maxPositions: 7 },
    correlation: { threshold: 0.7, maxClusterExposure: 0.4 },
  });
  assert.equal(custom.maxPositions, 7);
  assert.equal(capFor("NVDA", custom), 0.05);
  assert.equal(capFor("QQQ", custom), 0.3);

  for (const bad of [
    { position: { maxWeightPerInstrument: 1.5 } },
    { position: { maxWeightPerInstrument: 0 } },
    { position: { minWeight: 0.5, maxWeightPerInstrument: 0.2 } },
    { correlation: { threshold: 1.5 } },
    { correlation: { maxClusterExposure: 0 } },
    { correlation: { maxClusterExposure: 1.5 } },
    { maxAdjustmentRounds: 0 },
    { epsilon: -1 },
  ]) {
    assert.throws(
      () => resolveGuardConfig(bad),
      (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_CONFIG",
      JSON.stringify(bad)
    );
  }
});

test("Autoritätskette: Reihenfolge ist erzwungen, Freigabe nur vollständig", () => {
  assertAuthorityChain([...AUTHORITY_CHAIN]);
  assertAuthorityChain(["portfolio-optimizer", "risk-guard", "position-limits"]);
  assert.doesNotThrow(() => assertAuthorityChain(["portfolio-optimizer"]));
  // Freigabe (complete) verlangt alle vier Glieder.
  assert.throws(
    () => assertAuthorityChain(["portfolio-optimizer", "risk-guard", "position-limits"], { complete: true }),
    (e: unknown) => e instanceof PortfolioError && e.field === "chain"
  );
  // Übersprungene Glieder sind unmöglich.
  assert.throws(() => assertAuthorityChain(["risk-guard", "position-limits"]), PortfolioError);
  assert.throws(() => assertAuthorityChain(["portfolio-optimizer", "correlation-limits"]), PortfolioError);
  assert.throws(() => assertAuthorityChain([]), PortfolioError);
  assert.throws(() => assertAuthorityChain([...AUTHORITY_CHAIN, "portfolio-optimizer"]), PortfolioError);
});

test("Nur ein markiertes Optimizer-Ergebnis kommt in die Kette", () => {
  const fake = { authority: "llm-suggestion", symbols: NAMES5, weights: [0.2, 0.2, 0.2, 0.2, 0.2] } as unknown as RawOptimizationResult;
  assert.throws(
    () => applyRiskGuard({ raw: fake, correlation: identityCorrelation(NAMES5) }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  assert.equal(OPTIMIZER_AUTHORITY, "portfolio-optimizer");
});

test("Position Limits: Kappung auf 20 % und vollständige Umverteilung", () => {
  const raw = rawMinVariance();
  // Min-Variance bei Diagonal-Σ ⇒ w ∝ 1/σ² ⇒ w₀ ≈ 68.3 % (weit über dem Limit).
  assert.ok(raw.weights[0] > 0.5, JSON.stringify(raw.weights));
  const result = applyRiskGuard({ raw, correlation: identityCorrelation(NAMES5) });

  assert.equal(result.rejected, false);
  assert.equal(result.adjusted, true);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  for (const w of result.weights) assert.ok(w <= 0.2 + 1e-9, `Gewicht ${w} > 0.2`);
  // Kapazität = 5 × 20 % = 100 % ⇒ alle Assets landen exakt am Limit.
  for (const w of result.weights) assert.ok(Math.abs(w - 0.2) < 1e-9, `Gewicht ${w}`);
  assert.ok(result.reasons.some((r) => r.includes("POSITION_LIMIT_CAPPED")), result.reasons.join(" | "));
  assert.ok(result.decisions.every((d) => d.stage === "position-limits" || d.stage === "correlation-limits"));
  assert.deepEqual(result.chain, [...AUTHORITY_CHAIN]);
  // Der Rohzustand bleibt sichtbar (Transparenz), die Freigabe ist gekappt.
  assert.deepEqual(result.input, raw.weights);
});

test("Position Limits: instrumentspezifische Obergrenze gewinnt", () => {
  const raw = rawMinVariance();
  const result = applyRiskGuard({
    raw,
    correlation: identityCorrelation(NAMES5),
    config: { position: { maxWeightPerInstrument: 0.5, perSymbol: { A0: 0.1 } } },
  });
  assert.equal(result.rejected, false);
  assert.ok(Math.abs(result.weights[0] - 0.1) < 1e-9, `w₀ = ${result.weights[0]}`);
  assert.ok(result.caps.find((c) => c.symbol === "A0")?.cap === 0.1);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Position Limits: maxPositions entfernt die kleinsten Positionen", () => {
  const raw = rawMinVariance();
  const result = applyRiskGuard({
    raw,
    correlation: identityCorrelation(NAMES5),
    config: { position: { maxWeightPerInstrument: 0.5, maxPositions: 3, minWeight: 0 } },
  });
  assert.equal(result.rejected, false);
  const held = result.weights.filter((w) => w > 1e-9);
  assert.equal(held.length, 3, JSON.stringify(result.weights));
  assert.ok(result.reasons.some((r) => r.includes("POSITION_COUNT_EXCEEDED")));
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Position Limits: Splittergewichte unter minWeight werden entfernt", () => {
  const raw = rawMinVariance();
  // A3/A4 haben 4.3 % bzw. 2.7 % — mit minWeight 5 % fallen sie weg.
  const result = applyRiskGuard({
    raw,
    correlation: identityCorrelation(NAMES5),
    config: { position: { maxWeightPerInstrument: 0.5, minWeight: 0.05 } },
  });
  assert.equal(result.weights[3], 0);
  assert.equal(result.weights[4], 0);
  assert.ok(result.reasons.some((r) => r.includes("MIN_WEIGHT_DROPPED")));
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Position Limits: unerfüllbare Limits ⇒ Verwurf mit Grund", () => {
  const raw = rawMinVariance();
  // 5 Assets × 10 % = 50 % < 100 % ⇒ kein zulässiges Portfolio.
  const result = applyRiskGuard({
    raw,
    correlation: identityCorrelation(NAMES5),
    config: { position: { maxWeightPerInstrument: 0.1 } },
  });
  assert.equal(result.rejected, true);
  assert.deepEqual(result.weights, []);
  assert.ok(result.reasons.some((r) => r.includes("POSITION_LIMITS_INFEASIBLE")), result.reasons.join(" | "));
  // Die Kette bricht an der Stelle ab, an der entschieden wurde (Präfix).
  assert.deepEqual(result.chain, ["portfolio-optimizer", "risk-guard", "position-limits"]);
});

test("Correlation Limits: Cluster wird auf das Exposure-Limit skaliert", () => {
  // Drei hochkorrelierte Assets (ein Cluster) + ein unkorreliertes.
  const correlated = threeHighlyCorrelatedSeries(60);
  const extra = seriesFrom(uncorrelated(1, 60, 991), "X");
  const series = [...correlated, ...extra];
  const { symbols: names, columns } = returnsMatrix(series);
  const correlation = correlationMatrix(columns, { symbols: names });
  const clusters = correlationClusters(correlation, 0.8);
  assert.equal(clusters.length, 2, "erwartet einen 3er-Cluster und einen Einzelwert");
  assert.equal(clusters[0].symbols.length, 3);

  // Explizite Ausgangsgewichte: der Cluster hält 75 % ⇒ 25 % müssen umgelagert
  // werden. (Deterministischer Test der Kappung statt Zufallstreffer.)
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const optimized = optimizePortfolio({ symbols: names, covariance: cov, mode: "risk_parity" });
  const raw: RawOptimizationResult = { ...optimized, weights: [0.3, 0.25, 0.2, 0.25] };

  const result = applyRiskGuard({
    raw,
    correlation,
    config: { position: { maxWeightPerInstrument: 1 }, correlation: { maxClusterExposure: 0.5 } },
  });

  assert.equal(result.rejected, false, result.reasons.join(" | "));
  const clusterOf3 = result.clusterExposures.find((c) => c.symbols.length === 3);
  assert.ok(clusterOf3, JSON.stringify(result.clusterExposures));
  assert.ok(clusterOf3.violated, "Ausgangslage muss das Limit verletzen");
  assert.ok(Math.abs(clusterOf3.before - 0.75) < 1e-9, `before = ${clusterOf3.before}`);
  assert.ok(Math.abs(clusterOf3.after - 0.5) < 1e-9, `after = ${clusterOf3.after}`);
  assert.ok(Math.abs(result.weights[3] - 0.5) < 1e-9, `w₃ = ${result.weights[3]}`);
  assert.ok(result.reasons.some((r) => r.includes("CLUSTER_EXPOSURE_CAPPED")), result.reasons.join(" | "));
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.deepEqual(result.chain, [...AUTHORITY_CHAIN]);
});

test("Correlation Limits: unerfüllbar ⇒ Verwurf (fail-closed)", () => {
  // Zwei perfekt korrelierte Assets, Cluster-Limit 50 % ⇒ maximal 50 % investierbar.
  const series = seriesFrom(
    [
      [0.01, -0.02, 0.03, 0.005, -0.01, 0.02],
      [0.011, -0.022, 0.033, 0.0055, -0.011, 0.022],
    ],
    "H"
  );
  const { symbols: names, columns } = returnsMatrix(series);
  const correlation = correlationMatrix(columns, { symbols: names });
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const raw = optimizePortfolio({ symbols: names, covariance: cov, mode: "min_variance" });

  const result = applyRiskGuard({ raw, correlation, config: { position: { maxWeightPerInstrument: 1 } } });
  assert.equal(result.rejected, true);
  assert.deepEqual(result.weights, []);
  assert.ok(result.reasons.some((r) => r.includes("CORRELATION_LIMITS_INFEASIBLE")), result.reasons.join(" | "));
  assert.deepEqual(result.chain, [...AUTHORITY_CHAIN]);
});

test("Correlation Limits: allowCashResidual hält das Portfolio, Rest bleibt Cash", () => {
  const series = seriesFrom(
    [
      [0.01, -0.02, 0.03, 0.005, -0.01, 0.02],
      [0.011, -0.022, 0.033, 0.0055, -0.011, 0.022],
    ],
    "H"
  );
  const { symbols: names, columns } = returnsMatrix(series);
  const correlation = correlationMatrix(columns, { symbols: names });
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const raw = optimizePortfolio({ symbols: names, covariance: cov, mode: "min_variance" });

  const result = applyRiskGuard({
    raw,
    correlation,
    config: { position: { maxWeightPerInstrument: 1 }, allowCashResidual: true },
  });
  assert.equal(result.rejected, false);
  const sum = result.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 0.5) < 1e-9, `Σw = ${sum}`);
  assert.ok(result.reasons.some((r) => r.includes("CASH_RESIDUAL")), result.reasons.join(" | "));
  for (const exposure of result.clusterExposures) {
    assert.ok(exposure.after <= exposure.limit + 1e-9);
  }
});

test("Audit: eine Entscheidung = ein Audit-Ereignis, plus Summary", () => {
  const sink = memoryAuditSink();
  const audit = createAuditLogger({ sink, now: fixedClock(), source: "portfolio:test" });
  const raw = rawMinVariance();
  const result = applyRiskGuard({ raw, correlation: identityCorrelation(NAMES5), audit });

  assert.equal(result.auditEvents.length, result.decisions.length + 1);
  assert.equal(sink.events.length, result.decisions.length + 1);
  const summary = sink.events[sink.events.length - 1];
  assert.equal(summary.event, "RISK_GUARD_SUMMARY");
  assert.equal(summary.code, "RISK_GUARD_ADJUSTED");
  assert.equal(summary.level, "WARN");
  assert.equal(summary.timestamp, "2026-08-27T00:00:00.000Z");
  for (const [i, decision] of result.decisions.entries()) {
    const event = sink.events[i];
    assert.equal(event.event, "RISK_GUARD_DECISION");
    assert.equal(event.code, decision.code);
    assert.equal(event.stage, decision.stage);
    assert.equal(event.action, decision.action);
    assert.equal(event.limit, decision.limit);
    assert.ok(event.reasons.length > 0);
  }
});

test("Audit: Verwurf erzeugt ERROR-Ereignis", () => {
  const sink = memoryAuditSink();
  const audit = createAuditLogger({ sink, now: fixedClock() });
  const result = applyRiskGuard({
    raw: rawMinVariance(),
    correlation: identityCorrelation(NAMES5),
    config: { position: { maxWeightPerInstrument: 0.1 } },
    audit,
  });
  assert.equal(result.rejected, true);
  const summary = sink.events[sink.events.length - 1];
  assert.equal(summary.level, "ERROR");
  assert.equal(summary.code, "RISK_GUARD_REJECTION");
  const reject = sink.events.find((e) => e.code === "POSITION_LIMITS_INFEASIBLE");
  assert.ok(reject && reject.level === "ERROR");
});

test("Audit: unverändertes Portfolio erzeugt nur die Summary (INFO)", () => {
  const sink = memoryAuditSink();
  const audit = createAuditLogger({ sink, now: fixedClock() });
  // Gleichverteilung über 5 Assets liegt innerhalb aller Default-Limits.
  const raw: RawOptimizationResult = {
    authority: OPTIMIZER_AUTHORITY,
    symbols: NAMES5,
    weights: [0.2, 0.2, 0.2, 0.2, 0.2],
    mode: "min_variance",
    diagnostics: {
      mode: "min_variance",
      converged: true,
      iterations: 1,
      objective: 0,
      stationarity: 0,
      variance: 0,
      volatility: 0,
      annualizedVolatility: 0,
      expectedReturn: null,
      sharpe: null,
      riskContributions: [0.2, 0.2, 0.2, 0.2, 0.2],
      regularization: { applied: "none", ridge: 0 },
      polished: null,
      notes: [],
    },
    bounds: { lower: [0, 0, 0, 0, 0], upper: [1, 1, 1, 1, 1] },
  };
  const result = applyRiskGuard({ raw, correlation: identityCorrelation(NAMES5), audit });
  assert.equal(result.rejected, false);
  assert.equal(result.adjusted, false);
  assert.deepEqual(result.weights, raw.weights);
  assert.equal(result.decisions.length, 0);
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].level, "INFO");
  assert.equal(sink.events[0].code, "RISK_GUARD_PASS");
});

test("Guard: Strukturfehler werden abgelehnt (Symbole, Längen, NaN)", () => {
  const raw = rawMinVariance();
  assert.throws(
    () => applyRiskGuard({ raw, correlation: identityCorrelation(["X", "Y"]) }),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(
    () => applyRiskGuard({ raw, correlation: identityCorrelation(["A0", "A1", "A2", "A3", "ZZ"]) }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  const broken: RawOptimizationResult = { ...raw, weights: [NaN, 0.25, 0.25, 0.25, 0.25] };
  assert.throws(
    () => applyRiskGuard({ raw: broken, correlation: identityCorrelation(NAMES5) }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
});

test("Pipeline: optimizeWithGuard liefert Kette, Report und Audit", () => {
  const sink = memoryAuditSink();
  const audit = createAuditLogger({ sink, now: fixedClock() });
  const series = seriesFrom(uncorrelated(6, 80, 1234), "P");
  const result = optimizeWithGuard({ series, mode: "risk_parity" }, { audit });

  assert.deepEqual(result.chain, [...AUTHORITY_CHAIN]);
  assert.equal(result.rejected, false);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(result.guard.input.length, 6);
  assert.ok(result.auditEvents.some((e) => e.event === "PORTFOLIO_OPTIMIZATION"));
  assert.ok(result.auditEvents.some((e) => e.event === "RISK_GUARD_SUMMARY"));
  assert.equal(result.auditEvents.length, sink.events.length);
  assert.equal(result.correlation.symbols.length, 6);
  assert.equal(result.covariance.method, "sample");
  assert.equal(result.metrics, null);
  assertNoWeightsOnRejection(result);
});

test("Pipeline: Kennzahlen optional, EWMA-Kovarianz wählbar", () => {
  const series = seriesFrom(uncorrelated(5, 60, 808), "P");
  const result = optimizeWithGuard({
    series,
    mode: "min_variance",
    withMetrics: true,
    covariance: { method: "ewma", decay: 0.94 },
  });
  assert.equal(result.covariance.method, "ewma");
  assert.equal(result.covariance.decay, 0.94);
  assert.ok(result.metrics && result.metrics.length === 5);
  assert.ok(result.metrics[0].volatility > 0);
});

test("Pipeline: abgelehntes Portfolio führt niemals Gewichte", () => {
  // Drei hochkorrelierte Assets ⇒ ein Cluster, Limit 50 % ⇒ uninvestierbar.
  const series = threeHighlyCorrelatedSeries(60);
  const result = optimizeWithGuard({ series, mode: "risk_parity" });
  assert.equal(result.rejected, true);
  assert.deepEqual(result.weights, []);
  assertNoWeightsOnRejection(result);
  assert.ok(result.reasons.length > 0);
  // Die Rohgewichte des Optimizers bleiben einsehbar (Transparenz).
  assert.equal(result.raw.weights.length, 3);
});

test("Determinismus: gleiche Eingabe ⇒ identischer Guard-Report", () => {
  const series = seriesFrom(uncorrelated(5, 60, 55), "P");
  const a = optimizeWithGuard({ series, mode: "min_variance" });
  const b = optimizeWithGuard({ series, mode: "min_variance" });
  assert.deepEqual(a.weights, b.weights);
  assert.deepEqual(a.reasons, b.reasons);
  assert.deepEqual(a.guard.decisions, b.guard.decisions);
});

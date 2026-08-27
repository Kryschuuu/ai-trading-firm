/**
 * Benchmark des Portfolio-Moduls (Task 05).
 *
 * **Budget:** 500 Assets × 750 Perioden (375.000 Stichproben, genau die
 * Obergrenze `PORTFOLIO_LIMITS.maxCovarianceSamples` = 400.000) müssen in
 * **30 Sekunden** vollständig durch die Autoritätskette laufen. Der Test
 * scheitert bei Überschreitung und protokolliert die gemessenen Zeiten.
 *
 * Referenzmessung (Sandbox, Node 22, 2026-08-27):
 * Kovarianz ≈ 0,2 s · min_variance ≈ 0,7 s · max_sharpe ≈ 0,8 s ·
 * risk_parity ≈ 0,6 s · vollständige Pipeline ≈ 1,4 s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { covarianceAsMatrix, covarianceMatrix, returnsMatrix } from "../src/portfolio/correlation";
import { optimizePortfolio } from "../src/portfolio/optimize";
import { optimizeWithGuard } from "../src/portfolio/pipeline";
import { riskContributions } from "../src/portfolio/optimize";
import { PORTFOLIO_LIMITS } from "../src/portfolio/config";
import { blockReturns, symbols } from "./fixtures/portfolioFixtures";

/** Anzahl Assets im Benchmark. */
export const ASSETS = 500;
/** Perioden je Asset (muss > ASSETS sein, sonst ist die Sample-Kovarianz singulär). */
export const PERIODS = 750;
/** Zeitbudget in Millisekunden für den gesamten Durchlauf. */
export const BUDGET_MS = 30_000;

/**
 * Faktor für Läufe mit Coverage-Instrumentierung.
 *
 * `--experimental-test-coverage` instrumentiert jeden Zweig und macht reine
 * Rechenloops etwa 10× langsamer — gemessen würde dann die Instrumentierung,
 * nicht die Bibliothek. Das Budget wird in diesem Fall entsprechend skaliert
 * (Referenz: 5,8 s ohne, 59 s mit Instrumentierung).
 */
const COVERAGE_FACTOR = process.env.NODE_V8_COVERAGE ? 20 : 1;

/** Wirksames Budget dieses Laufs. */
const effectiveBudgetMs = BUDGET_MS * COVERAGE_FACTOR;

/** Misst eine synchrone Operation in Millisekunden. */
function measure<T>(fn: () => T): { value: T; ms: number } {
  const start = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, ms };
}

test(`Benchmark: ${ASSETS} Assets × ${PERIODS} Perioden bleiben im Budget (${effectiveBudgetMs} ms)`, () => {
  assert.ok(ASSETS * PERIODS <= PORTFOLIO_LIMITS.maxCovarianceSamples, "Benchmark verletzt die eigenen Limits");

  // Block-Faktormodell: 50 Cluster à 10 Assets ⇒ realistische Cluster-Struktur.
  const columns = blockReturns(50, ASSETS / 50, PERIODS, 20260827);
  const names = symbols(ASSETS, "B");
  const timings: Record<string, number> = {};

  const cov = measure(() => covarianceAsMatrix(covarianceMatrix(columns, { symbols: names })));
  timings.covariance = cov.ms;
  assert.equal(cov.value.n, ASSETS);

  const mu = columns.map((c) => c.reduce((a, b) => a + b, 0) / c.length);

  const minVar = measure(() =>
    optimizePortfolio({ symbols: names, covariance: cov.value, mode: "min_variance", expectedReturns: mu })
  );
  timings.min_variance = minVar.ms;
  assert.equal(minVar.value.diagnostics.converged, true, "min_variance konvergierte nicht");
  assert.ok(Math.abs(minVar.value.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);

  const maxSharpe = measure(() =>
    optimizePortfolio({ symbols: names, covariance: cov.value, mode: "max_sharpe", expectedReturns: mu })
  );
  timings.max_sharpe = maxSharpe.ms;
  assert.ok(Math.abs(maxSharpe.value.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);

  const riskParity = measure(() =>
    optimizePortfolio({ symbols: names, covariance: cov.value, mode: "risk_parity" })
  );
  timings.risk_parity = riskParity.ms;
  assert.equal(riskParity.value.diagnostics.converged, true, "risk_parity konvergierte nicht");
  const rc = riskContributions(riskParity.value.weights, cov.value);
  let spread = 0;
  for (const value of rc) spread = Math.max(spread, Math.abs(value - 1 / ASSETS));
  assert.ok(spread < 1e-4, `Risk-Parity-Spread ${spread}`);

  const pipeline = measure(() =>
    optimizeWithGuard({
      series: names.map((symbol, i) => ({ symbol, logReturns: columns[i] })),
      mode: "min_variance",
      guard: { position: { maxWeightPerInstrument: 0.05 }, correlation: { maxClusterExposure: 0.35 } },
    })
  );
  timings.fullPipeline = pipeline.ms;
  assert.deepEqual(pipeline.value.chain, [
    "portfolio-optimizer",
    "risk-guard",
    "position-limits",
    "correlation-limits",
  ]);
  assert.equal(pipeline.value.rejected, false, pipeline.value.reasons.join(" | "));
  assert.equal(pipeline.value.symbols.length, ASSETS);
  assert.ok(Math.abs(pipeline.value.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  for (const weight of pipeline.value.weights) assert.ok(weight <= 0.05 + 1e-9);
  for (const exposure of pipeline.value.guard.clusterExposures) {
    assert.ok(exposure.after <= exposure.limit + 1e-9, `Cluster ${exposure.clusterId}: ${exposure.after}`);
  }

  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  timings.total = total;
  console.log(
    `[portfolio-benchmark] ${ASSETS} Assets × ${PERIODS} Perioden` +
      `${COVERAGE_FACTOR > 1 ? ` (Coverage-Instrumentierung, Faktor ${COVERAGE_FACTOR})` : ""}: ` +
      Object.entries(timings)
        .map(([key, ms]) => `${key} ${ms.toFixed(0)} ms`)
        .join(" · ")
  );
  assert.ok(
    total < effectiveBudgetMs,
    `Budget überschritten: ${total.toFixed(0)} ms > ${effectiveBudgetMs} ms`
  );
});

test("Benchmark: Größenlimit lehnt größere Anfragen ab, statt sie zu rechnen", () => {
  // 501 Assets × 800 Perioden = 400.800 > Limit ⇒ sofortiger Fehler (DoS-Schutz).
  const many = symbols(501, "X").map((symbol, i) => ({
    symbol,
    logReturns: new Array<number>(800).fill(0.001 * ((i % 7) + 1)),
  }));
  assert.throws(
    () => optimizeWithGuard({ series: many, mode: "min_variance" }),
    (e: unknown) => (e as { code?: string }).code === "LIMIT_EXCEEDED"
  );
});

/**
 * Tests des Portfolio-Optimizers (Task 05).
 *
 * Enthalten sind:
 *   - **Golden-Tests** gegen analytische Closed-Form-Lösungen (2 Assets) und
 *     gegen eine unabhängige Newton-Implementierung in Python (Risk Parity),
 *   - **Eigenschaftstests** (Gewichtssumme 1, Bounds, Min-Variance ≤
 *     Gleichverteilung, Max-Sharpe ≥ Gleichverteilung, Risk-Parity-Gleichheit
 *     der Risk Contributions `|RCᵢ − RCⱼ| < 1e-4`),
 *   - **Robustheitstests** (singuläre Matrix, unerfüllbare Bounds,
 *     Nicht-Konvergenz),
 *   - **Determinismus** (zwei Läufe ⇒ bit-identische Gewichte).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { optimizePortfolio, resolveBounds, riskContributions, convergenceWarning } from "../src/portfolio/optimize";
import { covarianceAsMatrix, covarianceMatrix, returnsMatrix } from "../src/portfolio/correlation";
import { fromRows, quadForm, toRows } from "../src/portfolio/numeric";
import { PortfolioError } from "../src/portfolio/errors";
import { factorReturns, fiveWeaklyCorrelatedSeries, seriesFrom, symbols } from "./fixtures/portfolioFixtures";

/** 2-Asset-Kovarianz für die Closed-Form-Goldens. */
const COV2 = fromRows([
  [0.04, 0.012],
  [0.012, 0.09],
]);

/** 3-Asset-Kovarianz für den Risk-Parity-Golden. */
const COV3 = fromRows([
  [0.04, 0.012, 0.004],
  [0.012, 0.09, 0.006],
  [0.004, 0.006, 0.16],
]);

test("Golden (Closed Form): Min-Variance zweier Assets auf 1e-12", () => {
  // Analytisch: w₁ = (σ₂² − σ₁₂)/(σ₁² + σ₂² − 2σ₁₂) = (0.09−0.012)/(0.04+0.09−0.024)
  //            = 0.078/0.106 = 0.7358490566037735
  const result = optimizePortfolio({ symbols: ["A", "B"], covariance: COV2, mode: "min_variance" });
  assert.ok(Math.abs(result.weights[0] - 0.7358490566037735) < 1e-12, `w₀ = ${result.weights[0]}`);
  assert.ok(Math.abs(result.weights[1] - 0.26415094339622647) < 1e-12, `w₁ = ${result.weights[1]}`);
  // Varianz: 0.03260377358490567 (Python) — kleiner als die Gleichverteilung 0.0385.
  assert.ok(Math.abs(result.diagnostics.variance - 0.03260377358490567) < 1e-12);
  assert.ok(result.diagnostics.variance < 0.0385);
  assert.equal(result.diagnostics.converged, true);
  assert.equal(result.diagnostics.polished, true);
  assert.equal(result.authority, "portfolio-optimizer");
});

test("Golden (Closed Form): Max-Sharpe zweier Assets = Tangentialportfolio", () => {
  // Analytisch: w ∝ Σ⁻¹(μ − rf·1), normiert auf Σw = 1
  // Python: [0.9130434782608696, 0.08695652173913045], Sharpe_p = 0.0050460839234958196
  const result = optimizePortfolio({
    symbols: ["A", "B"],
    covariance: COV2,
    mode: "max_sharpe",
    expectedReturns: [0.001, 0.0005],
    riskFreeRate: 0,
  });
  assert.ok(Math.abs(result.weights[0] - 0.9130434782608696) < 1e-6, `w₀ = ${result.weights[0]}`);
  assert.ok(Math.abs(result.weights[1] - 0.08695652173913045) < 1e-6, `w₁ = ${result.weights[1]}`);
  assert.ok(Math.abs((result.diagnostics.sharpe ?? 0) - 0.0050460839234958196) < 1e-9);
  assert.equal(result.diagnostics.converged, true);
});

test("Golden: Risk Parity dreier Assets (unabhängige Newton-Rechnung)", () => {
  // Python (eigene Newton-Implementierung auf F(w) = ½w'Σw − (1/3)Σ ln wᵢ):
  // w = [0.454126039900456, 0.3027506932669707, 0.24312326683257343]
  const result = optimizePortfolio({ symbols: ["A", "B", "C"], covariance: COV3, mode: "risk_parity" });
  const expected = [0.454126039900456, 0.3027506932669707, 0.24312326683257343];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.weights[i] - expected[i]) < 1e-9, `w${i} = ${result.weights[i]} ≠ ${expected[i]}`);
  }
  // RCᵢ = 1/3 für alle i (Python: [0.33333333333333337, …])
  for (const rc of result.diagnostics.riskContributions) {
    assert.ok(Math.abs(rc - 1 / 3) < 1e-9, `RC = ${rc}`);
  }
  assert.equal(result.diagnostics.converged, true);
});

test("Golden: Risk Parity bei Diagonal-Kovarianz ⇒ wᵢ ∝ 1/σᵢ", () => {
  // Σ = diag(σ²) ⇒ RCᵢ = wᵢ²σᵢ² gleich ⇒ wᵢ ∝ 1/σᵢ.
  // σ = (0.2, 0.1, 0.4) ⇒ w = (5, 10, 2.5)/17.5 = (2/7, 4/7, 1/7)
  const cov = fromRows([
    [0.04, 0, 0],
    [0, 0.01, 0],
    [0, 0, 0.16],
  ]);
  const result = optimizePortfolio({ symbols: ["A", "B", "C"], covariance: cov, mode: "risk_parity" });
  const expected = [2 / 7, 4 / 7, 1 / 7];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(result.weights[i] - expected[i]) < 1e-9, `w${i} = ${result.weights[i]} ≠ ${expected[i]}`);
  }
});

test("Eigenschaft: Gewichte summieren zu 1 und halten die Bounds (20 Assets, 3 Modi)", () => {
  const columns = factorReturns(20, 120, 99);
  const names = symbols(20);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const mu = columns.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  for (const mode of ["min_variance", "max_sharpe", "risk_parity"] as const) {
    const result = optimizePortfolio({ symbols: names, covariance: cov, mode, expectedReturns: mu });
    const sum = result.weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${mode}: Σw = ${sum}`);
    for (const w of result.weights) {
      assert.ok(w >= -1e-12, `${mode}: negatives Gewicht ${w}`);
      assert.ok(w <= 1 + 1e-12, `${mode}: Gewicht ${w} > 1`);
    }
    assert.equal(result.weights.length, 20);
    const rcSum = result.diagnostics.riskContributions.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(rcSum - 1) < 1e-9, `${mode}: ΣRC = ${rcSum}`);
  }
});

test("Eigenschaft: Risk Parity ⇒ |RCᵢ − RCⱼ| < 1e-4 für alle i, j (50 Assets)", () => {
  const columns = factorReturns(50, 400, 4242);
  const names = symbols(50);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const result = optimizePortfolio({ symbols: names, covariance: cov, mode: "risk_parity" });
  const rc = riskContributions(result.weights, cov);
  let maxSpread = 0;
  for (let i = 0; i < rc.length; i++) {
    for (let j = i + 1; j < rc.length; j++) {
      maxSpread = Math.max(maxSpread, Math.abs(rc[i] - rc[j]));
    }
  }
  assert.ok(maxSpread < 1e-4, `RC-Spread = ${maxSpread}`);
  assert.equal(result.diagnostics.converged, true);
});

test("Eigenschaft: Min-Variance ≤ Varianz der Gleichverteilung", () => {
  const columns = factorReturns(15, 200, 555);
  const names = symbols(15);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const equal = new Array<number>(15).fill(1 / 15);
  const equalVariance = quadForm(cov, equal);
  const result = optimizePortfolio({ symbols: names, covariance: cov, mode: "min_variance" });
  assert.ok(
    result.diagnostics.variance <= equalVariance + 1e-15,
    `minVar ${result.diagnostics.variance} > equal ${equalVariance}`
  );
  // Streng kleiner, solange die Gleichverteilung nicht selbst optimal ist.
  assert.ok(result.diagnostics.variance < equalVariance);
});

test("Eigenschaft: Max-Sharpe ≥ Sharpe der Gleichverteilung", () => {
  const columns = factorReturns(12, 200, 31337);
  const names = symbols(12);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const mu = columns.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  const equal = new Array<number>(12).fill(1 / 12);
  const equalReturn = mu.reduce((a, b) => a + b, 0) / 12;
  const equalSharpe = equalReturn / Math.sqrt(quadForm(cov, equal));
  const result = optimizePortfolio({ symbols: names, covariance: cov, mode: "max_sharpe", expectedReturns: mu });
  assert.ok(
    (result.diagnostics.sharpe ?? -Infinity) >= equalSharpe - 1e-12,
    `maxSharpe ${result.diagnostics.sharpe} < equal ${equalSharpe}`
  );
});

test("Güte: Max-Sharpe ist mindestens so gut wie die beste Gittersuche", () => {
  // Unabhängige Kontrolle: vollständige Gittersuche auf dem 3-Simplex
  // (Schrittweite 1/100 ⇒ 5.151 zulässige Punkte). Der Optimierer muss jeden
  // dieser Punkte schlagen — sonst ist er nicht (nahe) optimal.
  const cov = fromRows([
    [0.04, 0.012, 0.004],
    [0.012, 0.09, 0.006],
    [0.004, 0.006, 0.16],
  ]);
  const mu = [0.0012, 0.0006, 0.0003];
  let best = -Infinity;
  for (let i = 0; i <= 100; i++) {
    for (let j = 0; j + i <= 100; j++) {
      const w = [i / 100, j / 100, 1 - (i + j) / 100];
      const variance = quadForm(cov, w);
      if (!(variance > 0)) continue;
      const ret = w[0] * mu[0] + w[1] * mu[1] + w[2] * mu[2];
      best = Math.max(best, ret / Math.sqrt(variance));
    }
  }
  const result = optimizePortfolio({ symbols: ["A", "B", "C"], covariance: cov, mode: "max_sharpe", expectedReturns: mu });
  assert.ok(
    (result.diagnostics.sharpe ?? -Infinity) >= best - 1e-9,
    `Solver ${result.diagnostics.sharpe} < Gitter ${best}`
  );
});

test("Bounds: maxWeight wird vom Optimierer eingehalten", () => {
  const columns = factorReturns(8, 150, 77);
  const names = symbols(8);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const result = optimizePortfolio({
    symbols: names,
    covariance: cov,
    mode: "min_variance",
    bounds: { maxWeight: 0.25 },
  });
  for (const w of result.weights) assert.ok(w <= 0.25 + 1e-9, `Gewicht ${w} > 0.25`);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Bounds: Asset-spezifische Untergrenzen werden erzwungen", () => {
  const columns = factorReturns(5, 120, 5);
  const names = symbols(5);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const result = optimizePortfolio({
    symbols: names,
    covariance: cov,
    mode: "min_variance",
    bounds: { lower: [0.1, 0.1, 0.1, 0.1, 0.1], upper: [0.6, 0.6, 0.6, 0.6, 0.6] },
  });
  for (let i = 0; i < 5; i++) {
    assert.ok(result.weights[i] >= 0.1 - 1e-9, `w${i} = ${result.weights[i]} < 0.1`);
    assert.ok(result.weights[i] <= 0.6 + 1e-9);
  }
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Bounds: Long-only=false erlaubt Leerverkäufe (Closed Form −0.125/1.125)", () => {
  // σ₁ = 0.3, σ₂ = 0.2, σ₁₂ = 0.045 (positiv definit: det = 0.001575 > 0).
  // Analytisch: w₁ = (σ₂²−σ₁₂)/(σ₁²+σ₂²−2σ₁₂) = (0.04−0.045)/(0.09+0.04−0.09) = −0.125
  const cov = fromRows([
    [0.09, 0.045],
    [0.045, 0.04],
  ]);
  const result = optimizePortfolio({
    symbols: ["A", "B"],
    covariance: cov,
    mode: "min_variance",
    longOnly: false,
    bounds: { minWeight: -1, maxWeight: 2 },
  });
  assert.ok(Math.abs(result.weights[0] + 0.125) < 1e-12, `w₀ = ${result.weights[0]}`);
  assert.ok(Math.abs(result.weights[1] - 1.125) < 1e-12, `w₁ = ${result.weights[1]}`);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Long-only dagegen klemmt auf die Grenze (0, 1) — dieselbe Kovarianz.
  const longOnly = optimizePortfolio({ symbols: ["A", "B"], covariance: cov, mode: "min_variance" });
  assert.ok(Math.abs(longOnly.weights[0] - 0) < 1e-9, `w₀ = ${longOnly.weights[0]}`);
  assert.ok(Math.abs(longOnly.weights[1] - 1) < 1e-9, `w₁ = ${longOnly.weights[1]}`);
  // Die Long-only-Variante ist deshalb schlechter (höhere Varianz).
  assert.ok(longOnly.diagnostics.variance > result.diagnostics.variance);
});

test("Risk Parity: Gewichtsgrenzen werden erzwungen und als Note gemeldet", () => {
  // Diagonal-Σ ⇒ w ∝ 1/σ = (2/7, 4/7, 1/7); 4/7 ≈ 0.571 > maxWeight 0.4.
  const cov = fromRows([
    [0.04, 0, 0],
    [0, 0.01, 0],
    [0, 0, 0.16],
  ]);
  const result = optimizePortfolio({
    symbols: ["A", "B", "C"],
    covariance: cov,
    mode: "risk_parity",
    bounds: { maxWeight: 0.4 },
  });
  for (const w of result.weights) assert.ok(w <= 0.4 + 1e-9, `Gewicht ${w} > 0.4`);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(
    result.diagnostics.notes.some((n) => n.startsWith("BOUNDS_PROJECTED")),
    JSON.stringify(result.diagnostics.notes)
  );
});

test("Robustheit: singuläre Matrix ⇒ definierter Fehler bzw. konfigurierbare Heilung", () => {
  // [[1, 1], [1, 1]] hat Rang 1 ⇒ Cholesky-Pivot 0.
  const singular = fromRows([
    [1, 1],
    [1, 1],
  ]);
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: singular, mode: "min_variance" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "SINGULAR_MATRIX"
  );
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: singular, mode: "risk_parity" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "SINGULAR_MATRIX"
  );
  // Policy `ridge` ⇒ lösbar, Hinweis in den Notes.
  const ridged = optimizePortfolio({
    symbols: ["A", "B"],
    covariance: singular,
    mode: "min_variance",
    solver: { singularMatrixPolicy: "ridge" },
  });
  assert.equal(ridged.diagnostics.regularization.applied, "ridge");
  assert.ok(ridged.diagnostics.regularization.ridge > 0);
  assert.ok(ridged.diagnostics.notes.includes("COVARIANCE_REGULARIZED:ridge"));
  assert.ok(Math.abs(ridged.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Policy `pseudo-inverse` ⇒ ebenfalls lösbar (Jacobi-Eigenzerlegung).
  const pseudo = optimizePortfolio({
    symbols: ["A", "B"],
    covariance: singular,
    mode: "min_variance",
    solver: { singularMatrixPolicy: "pseudo-inverse" },
  });
  assert.equal(pseudo.diagnostics.regularization.applied, "pseudo-inverse");
  // Rang-defizitäre Praxis-Kovarianz (mehr Assets als Beobachtungen).
  const columns = factorReturns(10, 6, 3);
  const names = symbols(10);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  assert.throws(() => optimizePortfolio({ symbols: names, covariance: cov, mode: "min_variance" }), PortfolioError);
  const healed = optimizePortfolio({
    symbols: names,
    covariance: cov,
    mode: "min_variance",
    solver: { singularMatrixPolicy: "ridge" },
  });
  assert.ok(Math.abs(healed.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("Robustheit: NaN/Infinity in Kovarianz oder μ ⇒ INVALID_INPUT", () => {
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: fromRows([[NaN, 0], [0, 1]]), mode: "min_variance" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  assert.throws(
    () =>
      optimizePortfolio({
        symbols: ["A", "B"],
        covariance: COV2,
        mode: "max_sharpe",
        expectedReturns: [0.001, Infinity],
      }),
    PortfolioError
  );
  assert.throws(
    () => optimizePortfolio({ symbols: ["A"], covariance: COV2, mode: "min_variance" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: COV2, mode: "max_sharpe" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
});

test("Robustheit: unerfüllbare Bounds ⇒ INFEASIBLE_CONSTRAINTS", () => {
  // Σ Untergrenzen = 1.2 > 1.
  assert.throws(
    () =>
      optimizePortfolio({
        symbols: ["A", "B"],
        covariance: COV2,
        mode: "min_variance",
        bounds: { lower: [0.6, 0.6] },
      }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INFEASIBLE_CONSTRAINTS"
  );
  // Σ Obergrenzen = 0.8 < 1.
  assert.throws(
    () =>
      optimizePortfolio({
        symbols: ["A", "B"],
        covariance: COV2,
        mode: "min_variance",
        bounds: { maxWeight: 0.4 },
      }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INFEASIBLE_CONSTRAINTS"
  );
  // Untergrenze > Obergrenze.
  assert.throws(
    () => resolveBounds(2, { lower: [0.5, 0], upper: [0.2, 1] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INFEASIBLE_CONSTRAINTS"
  );
});

test("Konvergenz: Iterationslimit wird klar gemeldet", () => {
  const columns = factorReturns(12, 200, 2024);
  const names = symbols(12);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const result = optimizePortfolio({
    symbols: names,
    covariance: cov,
    mode: "min_variance",
    solver: { maxIterations: 1, tolerance: 1e-15 },
  });
  assert.equal(result.diagnostics.converged, false);
  assert.equal(result.diagnostics.iterations, 1);
  assert.ok(result.diagnostics.notes.some((n) => n.startsWith("NOT_CONVERGED")));
  const warning = convergenceWarning(result);
  assert.ok(warning && warning.startsWith("NOT_CONVERGED"), warning ?? "");
  // Die Gewichte bleiben zulässig — nur die Konvergenz fehlt.
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);

  // Mit ausreichendem Budget konvergiert derselbe Fall.
  const converged = optimizePortfolio({ symbols: names, covariance: cov, mode: "min_variance" });
  assert.equal(converged.diagnostics.converged, true);
  assert.equal(convergenceWarning(converged), null);
});

test("Konvergenz: Toleranz und Iterationslimit werden validiert", () => {
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: COV2, mode: "min_variance", solver: { tolerance: 0 } }),
    PortfolioError
  );
  assert.throws(
    () => optimizePortfolio({ symbols: ["A", "B"], covariance: COV2, mode: "min_variance", solver: { tolerance: 2 } }),
    PortfolioError
  );
  assert.throws(
    () =>
      optimizePortfolio({
        symbols: ["A", "B"],
        covariance: COV2,
        mode: "min_variance",
        solver: { maxIterations: 1.5 },
      }),
    PortfolioError
  );
  assert.throws(
    () =>
      optimizePortfolio({
        symbols: ["A", "B"],
        covariance: COV2,
        mode: "min_variance",
        solver: { rcond: 1 },
      }),
    PortfolioError
  );
});

test("Risk Contributions: Definition wᵢ(Σw)ᵢ / w'Σw, Summe 1", () => {
  const w = [0.5, 0.3, 0.2];
  const cov = COV3;
  const rc = riskContributions(w, cov);
  const sw = [
    cov.data[0] * w[0] + cov.data[1] * w[1] + cov.data[2] * w[2],
    cov.data[3] * w[0] + cov.data[4] * w[1] + cov.data[5] * w[2],
    cov.data[6] * w[0] + cov.data[7] * w[1] + cov.data[8] * w[2],
  ];
  const total = w[0] * sw[0] + w[1] * sw[1] + w[2] * sw[2];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(rc[i] - (w[i] * sw[i]) / total) < 1e-15);
  }
  assert.ok(Math.abs(rc.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  // Nullvarianz ⇒ Gleichanteil (defensiv, dokumentiert).
  assert.deepEqual(riskContributions([0.5, 0.5], fromRows([[0, 0], [0, 0]])), [0.5, 0.5]);
});

test("Determinismus: zwei Läufe liefern bit-identische Gewichte", () => {
  const columns = factorReturns(10, 150, 8);
  const names = symbols(10);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const mu = columns.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  for (const mode of ["min_variance", "max_sharpe", "risk_parity"] as const) {
    const a = optimizePortfolio({ symbols: names, covariance: cov, mode, expectedReturns: mu });
    const b = optimizePortfolio({ symbols: names, covariance: cov, mode, expectedReturns: mu });
    assert.deepEqual(a.weights, b.weights, mode);
    assert.deepEqual(a.diagnostics.riskContributions, b.diagnostics.riskContributions, mode);
    assert.equal(JSON.stringify(a), JSON.stringify(b), mode);
  }
});

test("Praxispfad: Optimizer aus Renditeserien (Pipeline-Vorstufe)", () => {
  const series = fiveWeaklyCorrelatedSeries(80);
  const { symbols: names, columns } = returnsMatrix(series);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols: names }));
  const result = optimizePortfolio({ symbols: names, covariance: cov, mode: "risk_parity" });
  assert.equal(result.symbols.length, 5);
  assert.ok(Math.abs(result.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Annualisierte Volatilität ist konsistent zur Varianz.
  assert.ok(
    Math.abs(result.diagnostics.annualizedVolatility - Math.sqrt(result.diagnostics.variance * 252)) < 1e-9
  );
  assert.ok(Array.isArray(toRows(cov)));
});

test("Ein-Asset-Universum: Gewicht 1 in allen Modi", () => {
  const cov = fromRows([[0.04]]);
  for (const mode of ["min_variance", "max_sharpe", "risk_parity"] as const) {
    const result = optimizePortfolio({ symbols: ["A"], covariance: cov, mode, expectedReturns: [0.001] });
    assert.ok(Math.abs(result.weights[0] - 1) < 1e-12, `${mode}: ${result.weights[0]}`);
  }
});

/**
 * Tests für Korrelation und Kovarianz (Task 05).
 *
 * Golden-Werte (unabhängig in Python nachgerechnet), Matrix-Eigenschaften,
 * EWMA-Verhalten, Cluster-Bildung und Robustheit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annualizeCovariance,
  clusterAnalysis,
  correlationClusters,
  correlationFromCovariance,
  correlationMatrix,
  covarianceAsMatrix,
  covarianceMatrix,
  pearsonCorrelation,
  returnsMatrix,
  spearmanCorrelation,
} from "../src/portfolio/correlation";
import { ranks, toRows } from "../src/portfolio/numeric";
import { PortfolioError } from "../src/portfolio/errors";
import {
  COV_A,
  COV_B,
  PEARSON_X,
  PEARSON_Y,
  TIED_X,
  TIED_Y,
  fiveWeaklyCorrelatedSeries,
  threeHighlyCorrelatedSeries,
} from "./fixtures/portfolioFixtures";

test("Golden: Pearson = 0.9975934858927139", () => {
  // Python: Σ(x−x̄)(y−ȳ)/√(Σ(x−x̄)²·Σ(y−ȳ)²) = 0.9975934858927139
  const r = pearsonCorrelation(PEARSON_X, PEARSON_Y);
  assert.ok(Math.abs(r - 0.9975934858927139) < 1e-15, `r = ${r}`);
  // Perfekte lineare Beziehung ⇒ exakt 1.
  assert.equal(pearsonCorrelation([1, 2, 3], [5, 7, 9]), 1);
  // Perfekte Antikorrelation ⇒ exakt −1.
  assert.equal(pearsonCorrelation([1, 2, 3], [9, 7, 5]), -1);
  // Unkorreliert (kovarianzfrei, aber nicht unabhängig).
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [1, -1, -1, 1]), 0);
  // Dieselbe Paarung mit vertauschtem Vorzeichen ist korreliert: −0.4472135954999579
  assert.ok(Math.abs(pearsonCorrelation([1, 2, 3, 4], [1, -1, 1, -1]) + 0.4472135954999579) < 1e-15);
});

test("Pearson: Nullvarianz ist undefiniert und wird neutral (0)", () => {
  assert.equal(pearsonCorrelation([1, 1, 1], [1, 2, 3]), 0);
  assert.equal(pearsonCorrelation([1, 2, 3], [2, 2, 2]), 0);
});

test("Golden: Ränge mit Gleichstand (Durchschnittsrang)", () => {
  // Python: ranks([1,2,2,4,5]) = [1, 2.5, 2.5, 4, 5]
  assert.deepEqual(ranks(TIED_X), [1, 2.5, 2.5, 4, 5]);
  // Python: ranks([10,20,15,40,50]) = [1, 3, 2, 4, 5]
  assert.deepEqual(ranks(TIED_Y), [1, 3, 2, 4, 5]);
  assert.deepEqual(ranks([5, 5, 5]), [2, 2, 2]);
});

test("Golden: Spearman = 0.9746794344808964 (mit Gleichständen)", () => {
  // Python: Pearson der Ränge = 0.9746794344808964
  const rho = spearmanCorrelation(TIED_X, TIED_Y);
  assert.ok(Math.abs(rho - 0.9746794344808964) < 1e-12, `rho = ${rho}`);
  // Ohne Gleichstände stimmt Spearman mit der Rangordnung überein ⇒ 1.
  assert.equal(spearmanCorrelation(PEARSON_X, PEARSON_Y), 1);
  // Monoton, aber nicht linear: Pearson < 1, Spearman = 1.
  const x = [1, 2, 3, 4, 5];
  const y = x.map((v) => v ** 3);
  assert.equal(spearmanCorrelation(x, y), 1);
  assert.ok(pearsonCorrelation(x, y) < 1);
});

test("Golden: Sample-Kovarianz (ddof = 1)", () => {
  // Python: var(a) = 0.00037, var(b) = 0.00025, cov(a,b) = −7.5e-05,
  //         corr = −0.2465984809580359
  const cov = covarianceMatrix([COV_A, COV_B], { symbols: ["A", "B"] });
  assert.equal(cov.method, "sample");
  assert.equal(cov.denominator, 4);
  assert.ok(Math.abs(cov.rows[0][0] - 0.00037) < 1e-15, `var a = ${cov.rows[0][0]}`);
  assert.ok(Math.abs(cov.rows[1][1] - 0.00025) < 1e-15, `var b = ${cov.rows[1][1]}`);
  assert.ok(Math.abs(cov.rows[0][1] + 7.5e-05) < 1e-15, `cov = ${cov.rows[0][1]}`);
  assert.equal(cov.rows[0][1], cov.rows[1][0]);

  const corr = correlationFromCovariance(covarianceAsMatrix(cov), ["A", "B"]);
  assert.ok(Math.abs(corr.matrix[0][1] + 0.2465984809580359) < 1e-12, `corr = ${corr.matrix[0][1]}`);
});

test("Kovarianz: ddof = 0 skaliert exakt um (n−1)/n", () => {
  const s1 = covarianceMatrix([COV_A, COV_B], { symbols: ["A", "B"], ddof: 1 });
  const s0 = covarianceMatrix([COV_A, COV_B], { symbols: ["A", "B"], ddof: 0 });
  const factor = 4 / 5;
  assert.ok(Math.abs(s0.rows[0][0] - s1.rows[0][0] * factor) < 1e-12);
});

test("Golden: EWMA-Kovarianz (λ = 0.9)", () => {
  // Python (Σ_0 = r_0 r_0ᵀ, Σ_t = λΣ_{t−1} + (1−λ) r_t r_tᵀ):
  // [[0.0001888, 0.0001176], [0.0001176, 0.0003987]]
  const series = [
    [0.01, -0.02, 0.03, 0.005],
    [0.02, 0.01, -0.01, 0.03],
  ];
  const cov = covarianceMatrix(series, { symbols: ["A", "B"], method: "ewma", decay: 0.9 });
  assert.equal(cov.method, "ewma");
  assert.equal(cov.decay, 0.9);
  assert.equal(cov.denominator, 1); // Gewichtssumme ist exakt 1 ⇒ keine Bias-Korrektur
  assert.ok(Math.abs(cov.rows[0][0] - 0.0001888) < 1e-15, `σ_a² = ${cov.rows[0][0]}`);
  assert.ok(Math.abs(cov.rows[0][1] - 0.0001176) < 1e-15, `cov = ${cov.rows[0][1]}`);
  assert.ok(Math.abs(cov.rows[1][1] - 0.0003987) < 1e-15, `σ_b² = ${cov.rows[1][1]}`);
});

test("EWMA: λ → 0 gewichtet nur die letzte Beobachtung", () => {
  const series = [
    [0.01, 0.02],
    [0.03, -0.04],
  ];
  const cov = covarianceMatrix(series, { symbols: ["A", "B"], method: "ewma", decay: 1e-12 });
  assert.ok(Math.abs(cov.rows[0][0] - 0.02 * 0.02) < 1e-12);
  assert.ok(Math.abs(cov.rows[1][1] - 0.04 * 0.04) < 1e-12);
});

test("Korrelationsmatrix: symmetrisch, Diagonale 1, Nullvarianz in `degenerate`", () => {
  const matrix = correlationMatrix(
    [
      [0.01, -0.02, 0.03],
      [0.02, 0.01, -0.01],
      [0, 0, 0],
    ],
    { symbols: ["A", "B", "FLAT"] }
  );
  assert.equal(matrix.matrix.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(matrix.matrix[i][i], 1);
    for (let j = 0; j < 3; j++) {
      assert.equal(matrix.matrix[i][j], matrix.matrix[j][i]);
      assert.ok(Math.abs(matrix.matrix[i][j]) <= 1);
    }
  }
  // FLAT hat keine Varianz ⇒ Korrelation neutral 0, Symbol in `degenerate`.
  assert.equal(matrix.matrix[0][2], 0);
  assert.deepEqual(matrix.degenerate, ["FLAT"]);
});

test("Korrelationsmatrix: Pearson und Spearman unterscheiden sich bei Ausreißern", () => {
  const x = [0.01, -0.01, 0.01, -0.01, 0.5];
  const y = [0.02, -0.02, 0.02, -0.02, -0.4];
  const pearson = correlationMatrix([x, y], { symbols: ["X", "Y"], method: "pearson" });
  const spearman = correlationMatrix([x, y], { symbols: ["X", "Y"], method: "spearman" });
  assert.notEqual(pearson.matrix[0][1], spearman.matrix[0][1]);
  assert.equal(pearson.method, "pearson");
  assert.equal(spearman.method, "spearman");
});

test("Cluster: |ρ| ≥ Schwelle bildet transitiv abgeschlossene Gruppen", () => {
  // A–B und B–C stark, A–C schwach ⇒ Single-Linkage verbindet alle drei.
  const matrix = {
    method: "pearson" as const,
    symbols: ["A", "B", "C", "D"],
    matrix: [
      [1, 0.85, 0.1, 0.0],
      [0.85, 1, 0.9, 0.0],
      [0.1, 0.9, 1, 0.0],
      [0.0, 0.0, 0.0, 1],
    ],
    observations: 10,
  };
  const clusters = correlationClusters(matrix, 0.8);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].symbols, ["A", "B", "C"]);
  assert.deepEqual(clusters[1].symbols, ["D"]);
  assert.equal(clusters[0].id, 0);
  assert.equal(clusters[1].id, 1);
  assert.ok(Math.abs(clusters[0].maxAbsCorrelation - 0.9) < 1e-12);
  // Negative Korrelation zählt über den Betrag.
  const negative = correlationClusters(
    { ...matrix, matrix: [[1, -0.9], [-0.9, 1]], symbols: ["A", "B"] },
    0.8
  );
  assert.equal(negative.length, 1);
});

test("Cluster: Schwelle 1 isoliert jedes Symbol, Schwelle 0 verbindet alle", () => {
  const matrix = correlationMatrix(
    [
      [0.01, -0.02, 0.03],
      [0.02, 0.01, -0.01],
    ],
    { symbols: ["A", "B"] }
  );
  // |ρ(A,B)| ≈ 0.247 ⇒ Schwelle 1 isoliert jedes Symbol, Schwelle 0 verbindet alle.
  assert.equal(correlationClusters(matrix, 1).length, 2);
  assert.equal(correlationClusters(matrix, 0).length, 1);
  assert.throws(() => correlationClusters(matrix, -0.1), PortfolioError);
  assert.throws(() => correlationClusters(matrix, 1.5), PortfolioError);
  assert.throws(() => correlationClusters(matrix, NaN), PortfolioError);
});

test("clusterAnalysis liefert Schwelle, Verfahren und Symbole", () => {
  const matrix = correlationMatrix([COV_A, COV_B], { symbols: ["A", "B"], method: "spearman" });
  const result = clusterAnalysis(matrix, 0.5);
  assert.equal(result.threshold, 0.5);
  assert.equal(result.method, "spearman");
  assert.deepEqual(result.symbols, ["A", "B"]);
  assert.ok(result.clusters.length >= 1);
});

test("returnsMatrix: gleiche Länge Pflicht, doppelte Symbole verboten", () => {
  const ok = returnsMatrix([
    { symbol: "A", logReturns: [0.01, -0.02] },
    { symbol: "B", logReturns: [0.02, 0.01] },
  ]);
  assert.deepEqual(ok.symbols, ["A", "B"]);
  assert.equal(ok.observations, 2);
  assert.throws(
    () =>
      returnsMatrix([
        { symbol: "A", logReturns: [0.01, -0.02] },
        { symbol: "B", logReturns: [0.02] },
      ]),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(
    () =>
      returnsMatrix([
        { symbol: "A", logReturns: [0.01] },
        { symbol: "A", logReturns: [0.02] },
      ]),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_SYMBOL"
  );
  assert.throws(() => returnsMatrix([]), PortfolioError);
});

test("Robustheit: NaN in Kovarianz/Korrelation und Längenfehler", () => {
  assert.throws(
    () => covarianceMatrix([[0.01, NaN], [0.02, 0.01]], { symbols: ["A", "B"] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  assert.throws(
    () => covarianceMatrix([[0.01], [0.02]], { symbols: ["A", "B"] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INSUFFICIENT_DATA"
  );
  assert.throws(
    () => covarianceMatrix([COV_A, [0.01, 0.02]], { symbols: ["A", "B"] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(
    () => covarianceMatrix([COV_A, COV_B], { symbols: ["A", "B"], method: "ewma", decay: 1.5 }),
    PortfolioError
  );
  assert.throws(
    () => correlationMatrix([COV_A, [0.01]], { symbols: ["A", "B"] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(
    () => correlationMatrix([COV_A, COV_B], { symbols: ["A"] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "LENGTH_MISMATCH"
  );
  assert.throws(() => pearsonCorrelation([1], [1]), PortfolioError);
});

test("Größenlimits: Serien × Länge ist hart begrenzt", () => {
  // 1.001 Serien wären über dem Limit — der Fehler kommt vor jeder Rechnung.
  const many = Array.from({ length: 1001 }, (_, i) => new Array<number>(2).fill(0.01 * i));
  assert.throws(
    () => correlationMatrix(many),
    (e: unknown) => e instanceof PortfolioError && e.code === "LIMIT_EXCEEDED"
  );
  const tooLong = [new Array<number>(2001).fill(0.01)];
  assert.throws(
    () => covarianceMatrix(tooLong),
    (e: unknown) => e instanceof PortfolioError && e.code === "LIMIT_EXCEEDED"
  );
});

test("Praxis: hochkorrelierte Serien landen in einem Cluster", () => {
  const series = threeHighlyCorrelatedSeries(40);
  const { symbols, columns } = returnsMatrix(series);
  const matrix = correlationMatrix(columns, { symbols });
  const clusters = correlationClusters(matrix, 0.8);
  assert.equal(clusters.length, 1, JSON.stringify(matrix.matrix));
  assert.equal(clusters[0].symbols.length, 3);
  assert.ok(clusters[0].maxAbsCorrelation > 0.99);
});

test("Praxis: schwach korrelierte Serien bleiben getrennt", () => {
  const series = fiveWeaklyCorrelatedSeries(60);
  const { symbols, columns } = returnsMatrix(series);
  const matrix = correlationMatrix(columns, { symbols });
  const clusters = correlationClusters(matrix, 0.8);
  assert.ok(clusters.length >= 3, `Cluster: ${JSON.stringify(clusters)}`);
});

test("annualizeCovariance skaliert die ganze Matrix", () => {
  const cov = covarianceAsMatrix(covarianceMatrix([COV_A, COV_B], { symbols: ["A", "B"] }));
  const annual = annualizeCovariance(cov, 252);
  const a = toRows(cov);
  const b = toRows(annual);
  assert.ok(Math.abs(b[0][0] - a[0][0] * 252) < 1e-15);
  assert.ok(Math.abs(b[0][1] - a[0][1] * 252) < 1e-15);
});

test("Determinismus: zwei identische Läufe ergeben identische Matrizen", () => {
  const run = () =>
    JSON.stringify(
      correlationMatrix([COV_A, COV_B, COV_A.map((v) => v * 1.3)], { symbols: ["A", "B", "C"] })
    );
  assert.equal(run(), run());
});

test("fünf Assets: Kovarianzmatrix ist positiv definit (Cholesky bricht nicht ab)", () => {
  const series = fiveWeaklyCorrelatedSeries(60);
  const { symbols, columns } = returnsMatrix(series);
  const cov = covarianceAsMatrix(covarianceMatrix(columns, { symbols }));
  assert.equal(cov.n, 5);
  // Diagonale = Varianzen > 0.
  for (let i = 0; i < 5; i++) assert.ok(cov.data[i * 5 + i] > 0);
});

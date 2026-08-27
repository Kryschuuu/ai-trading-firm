/**
 * Unit-Tests der Infrastruktur des Portfolio-Moduls (Task 05):
 * Numerik-Primitives, Fehlerbehandlung, Konfigurationsvalidierung, Audit-Senken
 * und Request-Parser.
 *
 * Die Golden-/Property-/Robustheitstests liegen in den fachlichen Suiten
 * (`portfolio.metrics|correlation|optimizer|riskGuard`); hier werden die
 * Randbedingungen und Fehlerpfade der darunterliegenden Bausteine abgedeckt —
 * inklusive der Garantie, dass **jeder** Fehlerpfad einen stabilen Code liefert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addDiagonal,
  cholesky,
  choleskySolve,
  estimateMaxEigenvalue,
  estimateMinEigenvalue,
  fromRows,
  inverse,
  isSymmetric,
  jacobiEigen,
  matVec,
  maxAbsEntry,
  mean,
  projectOntoBoxSimplex,
  pseudoInverse,
  quadForm,
  ranks,
  regularizeCovariance,
  stdDev,
  submatrix,
  toRows,
  trace,
  variance,
  zerosMatrix,
} from "../src/portfolio/numeric";
import {
  PortfolioError,
  describe,
  portfolioErrorCode,
  publicPortfolioErrorMessage,
  redactPortfolioMessage,
  requireFinite,
  requireFiniteAtLeast,
  requirePositive,
} from "../src/portfolio/errors";
import {
  DEFAULT_ANNUALIZATION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SOLVER_TOLERANCE,
  PORTFOLIO_LIMITS,
  annualizationFor,
  assertWithinLimits,
  closeRoundingGap,
  describeRegime,
  isCorrelationMethod,
  isOptimizationMode,
  isSingularMatrixPolicy,
  resolveSolverOptions,
  roundTo,
  roundVector,
  validateAnnualization,
  validateRegimeThresholds,
} from "../src/portfolio/config";
import {
  EPOCH_TIMESTAMP,
  clampList,
  compositeAuditSink,
  createAuditLogger,
  memoryAuditSink,
  nullAuditSink,
} from "../src/portfolio/audit";
import {
  AUDIT_FILE_RE,
  dbAuditSink,
  fileAuditSink,
  resolveAuditDir,
  serializeAuditEvent,
  writeAuditSnapshot,
} from "../src/portfolio/auditFile";
import {
  clusterAnalysis,
  correlationClusters,
  correlationFromCovariance,
  correlationMatrix,
  covarianceMatrix,
  pearsonCorrelation,
  spearmanCorrelation,
} from "../src/portfolio/correlation";
import {
  assertNoWeightsOnRejection,
  computeAllMetrics,
  computeCorrelation,
  optimizeWithGuard,
  weightsForJson,
} from "../src/portfolio/pipeline";
import {
  asObject,
  errorResponse,
  methodNotAllowed,
  parseCorrelationMethod,
  parseMode,
  parseNumber,
  parseNumberArray,
  parseOptionalNumber,
  parseSeries,
  parseSingularMatrixPolicy,
  parseSymbol,
  parseSymbolMap,
  readJsonBody,
  statusForCode,
} from "../src/app/api/portfolio/parse";
import { blockReturns, symbols } from "./fixtures/portfolioFixtures";

/** Wirft der Aufruf mit dem erwarteten Fehlercode? */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as PortfolioError).code;
  }
  throw new Error("erwarteter Fehler blieb aus");
}

test("Numerik: mean/variance/stdDev und ihre Fehlerpfade", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(variance([1, 2, 3, 4], 1), 5 / 3);
  assert.equal(variance([1, 2, 3, 4], 0), 1.25);
  assert.equal(stdDev([1, 2, 3, 4], 1), Math.sqrt(5 / 3));
  assert.equal(codeOf(() => mean([])), "INSUFFICIENT_DATA");
  assert.equal(codeOf(() => mean([1, NaN])), "INVALID_INPUT");
  assert.equal(codeOf(() => mean([Infinity])), "INVALID_INPUT");
  assert.equal(codeOf(() => variance([1], 1)), "INSUFFICIENT_DATA");
  assert.equal(codeOf(() => variance([1, 2], 2)), "INSUFFICIENT_DATA");
});

test("Numerik: Ränge, Matrizenbau, Konvertierung", () => {
  assert.deepEqual(ranks([10, 30, 20]), [1, 3, 2]);
  assert.deepEqual(ranks([5, 5, 5]), [2, 2, 2]);
  const m = fromRows([
    [4, 1],
    [1, 3],
  ]);
  assert.equal(m.n, 2);
  assert.deepEqual(toRows(m), [
    [4, 1],
    [1, 3],
  ]);
  assert.equal(trace(m), 7);
  assert.equal(maxAbsEntry(m), 4);
  assert.equal(isSymmetric(m), true);
  assert.equal(isSymmetric(fromRows([[4, 1.000000000001], [1, 3]])), true); // Mittelung
  assert.deepEqual(Array.from(matVec(m, [1, 1])), [5, 4]);
  assert.equal(quadForm(m, [1, 0]), 4);
  assert.equal(zerosMatrix(3).data.length, 9);
  assert.deepEqual(toRows(zerosMatrix(2)), [
    [0, 0],
    [0, 0],
  ]);
  assert.deepEqual(toRows(submatrix(m, [1])), [[3]]);
  assert.equal(codeOf(() => fromRows([])), "INVALID_INPUT");
  assert.equal(codeOf(() => fromRows([[1, 2], [3]])), "LENGTH_MISMATCH");
  assert.equal(codeOf(() => fromRows([[1, NaN], [NaN, 1]])), "INVALID_INPUT");
  assert.equal(codeOf(() => matVec(m, [1, 2, 3])), "LENGTH_MISMATCH");
});

test("Numerik: Cholesky, Lösen, Inverse, Eigenwerte, Pseudo-Inverse", () => {
  const m = fromRows([
    [4, 2],
    [2, 3],
  ]);
  const L = cholesky(m);
  assert.ok(Math.abs(L[0] - 2) < 1e-12);
  assert.ok(Math.abs(L[3] - Math.sqrt(2)) < 1e-12);
  const x = choleskySolve(L, 2, [1, 1]);
  assert.ok(Math.abs(x[0] - 0.125) < 1e-12);
  assert.ok(Math.abs(x[1] - 0.25) < 1e-12);
  assert.equal(codeOf(() => choleskySolve(L, 2, [1])), "LENGTH_MISMATCH");
  assert.equal(codeOf(() => cholesky(fromRows([[1, 1], [1, 1]]))), "SINGULAR_MATRIX");
  // Fast-singulär: Pivot unter der relativen Schwelle ist ein Fehler, kein Ergebnis.
  assert.equal(codeOf(() => cholesky(fromRows([[1e-20, 1e-20], [1e-20, 1e-20]]))), "SINGULAR_MATRIX");
  // Dieselbe Matrix mit entspannter Schwelle wird akzeptiert (Schwelle ist konfigurierbar).
  assert.ok(cholesky(fromRows([[1e-20, 0], [0, 1e-20]]), "covariance", { minRelativePivot: 0 }).length === 4);

  const inv = inverse(m);
  assert.ok(Math.abs(inv.data[0] - 0.375) < 1e-12);
  assert.equal(codeOf(() => inverse(fromRows([[1, 1], [1, 1]]))), "SINGULAR_MATRIX");

  const eigen = jacobiEigen(m, { maxSweeps: 100 });
  // λ² − tr(A)·λ + det(A) = λ² − 7λ + 8 = 0 ⇒ λ = (7 ± √17)/2
  assert.equal(eigen.converged, true);
  assert.ok(Math.abs(eigen.values[0] - (7 - Math.sqrt(17)) / 2) < 1e-9);
  assert.ok(Math.abs(eigen.values[1] - (7 + Math.sqrt(17)) / 2) < 1e-9);
  assert.equal(eigen.vectors.n, 2);
  assert.equal(codeOf(() => jacobiEigen(fromRows([[1, 1], [1, 1]]), { maxSweeps: 0, tolerance: 0 })), "NOT_CONVERGED");

  const singular = fromRows([
    [1, 1],
    [1, 1],
  ]);
  const pinv = pseudoInverse(singular);
  assert.equal(pinv.n, 2);
  assert.ok(Math.abs(pinv.data[0] - 0.25) < 1e-9);

  assert.ok(Math.abs(estimateMaxEigenvalue(m) - (7 + Math.sqrt(17)) / 2) < 1e-6);
  assert.ok(Math.abs(estimateMinEigenvalue(m) - (7 - Math.sqrt(17)) / 2) < 1e-6);
  assert.equal(codeOf(() => estimateMinEigenvalue(singular)), "SINGULAR_MATRIX");
});

test("Numerik: Regularisierung meldet, was sie getan hat", () => {
  const ok = fromRows([
    [0.04, 0.012],
    [0.012, 0.09],
  ]);
  const none = regularizeCovariance(ok, "error");
  assert.equal(none.applied, "none");
  assert.equal(none.ridge, 0);

  const singular = fromRows([
    [1, 1],
    [1, 1],
  ]);
  assert.equal(codeOf(() => regularizeCovariance(singular, "error")), "SINGULAR_MATRIX");
  const ridged = regularizeCovariance(singular, "ridge");
  assert.equal(ridged.applied, "ridge");
  assert.ok(ridged.ridge > 0);
  assert.ok(cholesky(ridged.matrix).length === 4);
  const pinv = regularizeCovariance(singular, "pseudo-inverse");
  assert.equal(pinv.applied, "pseudo-inverse");
  assert.equal(pinv.ridge > 0, true);
  assert.ok(cholesky(pinv.matrix).length === 4);
  // Negative Diagonale ist keine Kovarianzmatrix.
  assert.equal(codeOf(() => regularizeCovariance(fromRows([[-1, 0], [0, -1]]), "error")), "NOT_POSITIVE_DEFINITE");
});

test("Numerik: Diagonale ergänzen und Projektion auf Box-Simplex", () => {
  const m = fromRows([
    [1, 0],
    [0, 1],
  ]);
  assert.equal(addDiagonal(m, 0.5).data[0], 1.5);
  assert.equal(addDiagonal(m, 0.5).data[1], 0);

  const p = projectOntoBoxSimplex([0.5, 0.5], [0, 0], [1, 1]);
  assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-12);
  const capped = projectOntoBoxSimplex([0.9, 0.9], [0, 0], [0.4, 0.6]);
  assert.ok(capped[0] <= 0.4 + 1e-12);
  assert.ok(Math.abs(capped[0] + capped[1] - 1) < 1e-12);
  const lowered = projectOntoBoxSimplex([0, 0], [0.3, 0.3], [1, 1], 0.6);
  assert.ok(Math.abs(lowered[0] - 0.3) < 1e-12);
  assert.equal(codeOf(() => projectOntoBoxSimplex([0.5, 0.5], [0], [1, 1])), "LENGTH_MISMATCH");
  assert.equal(codeOf(() => projectOntoBoxSimplex([0.5, 0.5], [0.6, 0.6], [1, 1])), "INFEASIBLE_CONSTRAINTS");
});

test("Fehler: Codes, Redigierung und Pflichtprüfungen", () => {
  const err = new PortfolioError("INVALID_INPUT", "geheim: sk-abc123", { field: "x", details: { a: 1 } });
  assert.equal(err.code, "INVALID_INPUT");
  assert.equal(err.name, "PortfolioError");
  assert.equal(portfolioErrorCode(err), "INVALID_INPUT");
  assert.equal(portfolioErrorCode(new Error("irgendwas")), "INVALID_INPUT");
  assert.equal(publicPortfolioErrorMessage(err), err.message);
  assert.equal(publicPortfolioErrorMessage(new Error("interner Stack")), "interner Stack"); // redigiert, nicht ersetzt
  assert.equal(publicPortfolioErrorMessage("nur ein String"), "nur ein String");
  assert.equal(publicPortfolioErrorMessage(null), "Interner Fehler");
  assert.match(redactPortfolioMessage("postgres://user:pw@host:5432/db"), /\[REDACTED\]/);
  assert.match(redactPortfolioMessage("Bearer abc.def_ghi"), /\[REDACTED\]/);
  assert.match(redactPortfolioMessage("sk-abcdefghijklmnop"), /\[REDACTED\]/);
  assert.match(redactPortfolioMessage("api_key: supergeheim"), /\[REDACTED\]/);
  assert.equal(redactPortfolioMessage("x\n\ny"), "x y"); // Leerraum komprimiert
  assert.equal(redactPortfolioMessage("   "), "Interner Fehler");
  assert.equal(redactPortfolioMessage("x".repeat(500), 100).length, 100);
  assert.equal(describe("abc"), "string");
  assert.equal(describe(NaN), "NaN");
  assert.equal(describe(Infinity), "Infinity");
  assert.equal(describe(-Infinity), "-Infinity");
  assert.equal(describe(2), "2");
  assert.equal(describe(null), "null");
  assert.equal(describe([1, 2, 3]), "Array(3)");
  assert.equal(describe(undefined), "undefined");
  assert.equal(requireFinite(2, "x"), 2);
  assert.equal(codeOf(() => requireFinite("2", "x")), "INVALID_INPUT");
  assert.equal(codeOf(() => requireFinite(NaN, "x")), "INVALID_INPUT");
  assert.equal(requireFiniteAtLeast(5, 1, "x"), 5);
  assert.equal(codeOf(() => requireFiniteAtLeast(0, 1, "x")), "INVALID_INPUT");
  assert.equal(requirePositive(3, "x"), 3);
  assert.equal(codeOf(() => requirePositive(0, "x")), "INVALID_INPUT");
});

test("Konfiguration: Rundung, Gewichtslücke, Annualisierung, Regime", () => {
  assert.equal(roundTo(1.0000000000005, 12), 1.000000000001); // half away from zero
  assert.equal(roundTo(0.1 + 0.2, 12), 0.3);
  assert.equal(roundTo(NaN), 0);
  assert.equal(roundTo(Infinity), 0);
  assert.deepEqual(roundVector([0.1, 0.2]), [0.1, 0.2]);
  assert.deepEqual(roundVector([NaN, 0.5]), [0, 0.5]);

  const w = [0.333333333333, 0.333333333333, 0.333333333334];
  const gap = closeRoundingGap(w);
  assert.equal(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12, true);
  assert.equal(gap >= 0, true);
  // Blockierte Indizes werden übersprungen, wenn der Rest Platz hat.
  const blocked = [0.4, 0.4, 0.1];
  closeRoundingGap(blocked, 1, (i) => i === 2);
  assert.ok(blocked[2] <= 0.1 + 1e-12);

  assert.equal(annualizationFor("crypto"), 365);
  assert.equal(annualizationFor("CRYPTO"), 365);
  assert.equal(annualizationFor("equity"), DEFAULT_ANNUALIZATION.equity);
  assert.equal(annualizationFor(undefined), 252);
  assert.equal(annualizationFor("unbekannt"), 252);
  assert.equal(annualizationFor(null), 252);
  assert.equal(validateAnnualization(365), 365);
  assert.equal(codeOf(() => validateAnnualization(0)), "INVALID_INPUT");
  assert.equal(codeOf(() => validateAnnualization(NaN)), "INVALID_INPUT");

  assert.ok(describeRegime("LOW").includes("ruhig"));
  assert.ok(describeRegime("EXTREME", { low: 0.25, normal: 0.6, high: 1.2 }).includes("extrem"));
  assert.equal(codeOf(() => validateRegimeThresholds({ low: 1, normal: 0.5, high: 1.2 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => validateRegimeThresholds({ low: 0.25, normal: 0.6, high: 0.1 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => validateRegimeThresholds({ low: -1, normal: 0.6, high: 1.2 })), "INVALID_INPUT");
});

test("Konfiguration: Solver-Optionen und Größenlimits", () => {
  const defaults = resolveSolverOptions({});
  assert.equal(defaults.tolerance, DEFAULT_SOLVER_TOLERANCE);
  assert.equal(defaults.maxIterations, DEFAULT_MAX_ITERATIONS);
  assert.equal(codeOf(() => resolveSolverOptions({ tolerance: 0 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => resolveSolverOptions({ tolerance: 2 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => resolveSolverOptions({ maxIterations: 0 })), "INVALID_INPUT");
  assert.equal(codeOf(() => resolveSolverOptions({ maxIterations: 1.5 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => resolveSolverOptions({ maxIterations: 2_000_000 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => resolveSolverOptions({ rcond: 1 })), "INVALID_CONFIG");
  assert.equal(codeOf(() => resolveSolverOptions({ ridgeFactor: -1 })), "INVALID_INPUT");

  assertWithinLimits(10, 100);
  assert.equal(codeOf(() => assertWithinLimits(0, 10)), "INVALID_INPUT");
  assert.equal(codeOf(() => assertWithinLimits(PORTFOLIO_LIMITS.maxSeries + 1, 10)), "LIMIT_EXCEEDED");
  assert.equal(codeOf(() => assertWithinLimits(10, PORTFOLIO_LIMITS.maxSeriesLength + 1)), "LIMIT_EXCEEDED");
  assert.equal(codeOf(() => assertWithinLimits(1000, 500)), "LIMIT_EXCEEDED");
});

test("Konfiguration: Typwächter", () => {
  assert.equal(isCorrelationMethod("spearman"), true);
  assert.equal(isCorrelationMethod("kendall"), false);
  assert.equal(isOptimizationMode("risk_parity"), true);
  assert.equal(isOptimizationMode("max_sharpe "), false);
  assert.equal(isSingularMatrixPolicy("ridge"), true);
  assert.equal(isSingularMatrixPolicy("ignore"), false);
});

test("Audit: Senken, Logger und injizierte Uhr", () => {
  const memory = memoryAuditSink();
  const logger = createAuditLogger({ sink: memory, now: () => new Date("2026-08-27T10:00:00.000Z") });
  const event = logger.log({
    event: "RISK_GUARD_DECISION",
    level: "WARN",
    stage: "position-limits",
    action: "cap",
    code: "POSITION_LIMIT_CAPPED",
    symbols: ["A", "B"],
    weights: [0.2, 0.8],
    before: 0.8,
    after: 0.2,
  });
  assert.equal(event.timestamp, "2026-08-27T10:00:00.000Z");
  assert.equal(event.source, "portfolio");
  assert.equal(event.actor, "system");
  assert.equal(memory.events.length, 1);

  // Ohne Uhr: fester Epoch-Wert statt `new Date()` (Determinismus).
  const timeless = createAuditLogger();
  assert.equal(timeless.build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "pass" }).timestamp, EPOCH_TIMESTAMP);

  assert.deepEqual(clampList([1, 2, 3], 2), [1, 2]);
  assert.equal(clampList(symbols(40, "S")).length, PORTFOLIO_LIMITS.maxSymbolsPerAuditEvent);

  const composite = compositeAuditSink([memory, nullAuditSink()]);
  void composite.write(event);
  assert.equal(memory.events.length, 2);
  assert.equal(nullAuditSink().name, "null");
});

test("Audit: Datei-Senke schreibt NDJSON und validiert den Dateinamen", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portfolio-audit-"));
  try {
    const sink = fileAuditSink({ dir, file: "audit-log.ndjson", truncate: true });
    assert.match(sink.name, /audit-log\.ndjson$/);
    const logger = createAuditLogger({ sink, now: () => new Date("2026-08-27T11:00:00.000Z") });
    logger.log({ event: "PORTFOLIO_OPTIMIZATION", level: "INFO", stage: "portfolio-optimizer", action: "optimize", mode: "min_variance" });
    logger.log({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "summary" });
    const lines = readFileSync(path.join(dir, "audit-log.ndjson"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as { event: string; mode: string; timestamp: string };
    assert.equal(first.event, "PORTFOLIO_OPTIMIZATION");
    assert.equal(first.mode, "min_variance");
    assert.equal(first.timestamp, "2026-08-27T11:00:00.000Z");

    // Anhängen statt Überschreiben.
    fileAuditSink({ dir, file: "audit-log.ndjson" }).write(
      createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "pass" })
    );
    assert.equal(readFileSync(path.join(dir, "audit-log.ndjson"), "utf8").trim().split("\n").length, 3);

    // Serialisierung enthält nur definierte Felder (keine Datenflut, kein undefined).
    const serialized = serializeAuditEvent(
      createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "pass" })
    );
    assert.ok(!serialized.includes("undefined"));
    assert.equal(JSON.parse(serialized).event, "RISK_GUARD_SUMMARY");

    // Snapshot: atomar über tmp + rename, leere Liste ergibt eine leere Datei.
    writeAuditSnapshot(path.join(dir, "snap.ndjson"), [
      createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "pass" }),
    ]);
    assert.equal(readFileSync(path.join(dir, "snap.ndjson"), "utf8").trim().split("\n").length, 1);
    writeAuditSnapshot(path.join(dir, "sub/empty.ndjson"), []);
    assert.equal(readFileSync(path.join(dir, "sub/empty.ndjson"), "utf8"), "");

    assert.equal(resolveAuditDir(dir), dir);
    assert.equal(typeof resolveAuditDir(undefined), "string");
    assert.equal(AUDIT_FILE_RE.test("audit-log.ndjson"), true);
    assert.equal(AUDIT_FILE_RE.test("../escape"), false);
    assert.throws(() => fileAuditSink({ dir, file: "../../etc/passwd" }), /invalid/);

    // Schreibfehler werden nicht verschluckt, sondern gewarnt (sichtbar im Log).
    const blocked = path.join(dir, "blocker");
    writeFileSync(blocked, "keine Verzeichnis", "utf8");
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      fileAuditSink({ dir: blocked }).write(
        createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "summary" })
      );
      // DB-Senke ohne PORTFOLIO_AUDIT_DB=1: no-op; mit Flag: Fehler wird gewarnt,
      // bricht aber nichts ab (Memory-/Datei-Senke bleibt Wahrheit).
      await dbAuditSink().write(
        createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "INFO", stage: "risk-guard", action: "summary" })
      );
      process.env.PORTFOLIO_AUDIT_DB = "1";
      await dbAuditSink().write(
        createAuditLogger().build({ event: "RISK_GUARD_SUMMARY", level: "WARN", stage: "risk-guard", action: "summary" })
      );
      delete process.env.PORTFOLIO_AUDIT_DB;
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(dbAuditSink().name, "db:audit_log");
    assert.ok(warnings.length >= 1, "Schreibfehler müssen gewarnt werden");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Korrelation: Randfälle, Entartung und Cluster-Validierung", () => {
  assert.equal(codeOf(() => pearsonCorrelation([1], [2])), "INSUFFICIENT_DATA");
  assert.equal(codeOf(() => spearmanCorrelation([1, 2], [1])), "INSUFFICIENT_DATA");
  assert.equal(pearsonCorrelation([1, 2, 3], [2, 2, 2]), 0); // Nullvarianz ⇒ neutral

  // Konstante Serie wird als entartet gemeldet, nicht still als 0 durchgereicht.
  const withFlat = correlationMatrix(
    [
      [0.01, -0.02, 0.03],
      [0.5, 0.5, 0.5],
    ],
    { symbols: ["A", "FLAT"] }
  );
  assert.deepEqual(withFlat.degenerate, ["FLAT"]);
  assert.equal(withFlat.matrix[0][1], 0);
  assert.equal(withFlat.matrix[0][0], 1);
  assert.equal(withFlat.observations, 3);
  assert.equal(codeOf(() => correlationMatrix([])), "INVALID_INPUT");
  assert.equal(codeOf(() => correlationMatrix([[1, 2], [1, 2, 3]])), "LENGTH_MISMATCH");
  assert.equal(codeOf(() => correlationMatrix([[1, 2], [3, 4]], { symbols: ["A"] })), "LENGTH_MISMATCH");
  assert.equal(correlationMatrix([[1, 2], [3, 4]]).symbols[0], "asset-0"); // Default-Symbole

  // EWMA: λ muss in (0, 1) liegen.
  const ewma = covarianceMatrix(
    [
      [0.01, 0.02],
      [-0.02, 0.01],
    ],
    { symbols: ["A", "B"], method: "ewma", decay: 0.94 }
  );
  assert.equal(ewma.method, "ewma");
  assert.equal(ewma.decay, 0.94);
  assert.equal(ewma.rows.length, 2);
  assert.equal(
    codeOf(() =>
      covarianceMatrix([[0.01, 0.02], [-0.02, 0.01]], { symbols: ["A", "B"], method: "ewma", decay: 1 })
    ),
    "INVALID_INPUT"
  );
  assert.equal(
    codeOf(() => covarianceMatrix([[0.01, 0.02]], { symbols: ["A"], method: "ewma", decay: Number.NaN })),
    "INVALID_INPUT"
  );
  assert.equal(codeOf(() => covarianceMatrix([[0.01]], { symbols: ["A"] })), "INSUFFICIENT_DATA");

  // Korrelation aus Kovarianz: Nullvarianz ⇒ 0, entartet markiert.
  const fromCov = correlationFromCovariance(
    fromRows([
      [0, 0],
      [0, 0.04],
    ]),
    ["FLAT", "OK"]
  );
  assert.deepEqual(fromCov.degenerate, ["FLAT"]);
  assert.equal(fromCov.matrix[1][1], 1);
  assert.equal(fromCov.matrix[0][1], 0);
  assert.equal(correlationFromCovariance(fromRows([[0.04, 0.02], [0.02, 0.09]])).symbols[0], "asset-0");

  const clusters = correlationClusters(withFlat, 0.5);
  assert.equal(clusters.length, 2);
  assert.equal(codeOf(() => correlationClusters(withFlat, 1.5)), "INVALID_INPUT");
  assert.equal(codeOf(() => correlationClusters(withFlat, -0.1)), "INVALID_INPUT");
  assert.equal(codeOf(() => correlationClusters(withFlat, Number.NaN)), "INVALID_INPUT");
  const analysis = clusterAnalysis(withFlat, 0.5);
  assert.equal(analysis.threshold, 0.5);
  assert.equal(analysis.method, "pearson");
  assert.deepEqual(analysis.symbols, ["A", "FLAT"]);
});

test("Pipeline: Kennzahlen und Korrelation für mehrere Serien", () => {
  const columns = blockReturns(2, 2, 40, 11);
  const series = symbols(4, "U").map((symbol, i) => ({ symbol, logReturns: columns[i] }));
  const { symbols: out, metrics } = computeAllMetrics(series);
  assert.deepEqual(out, ["U0", "U1", "U2", "U3"]);
  assert.equal(metrics.length, 4);
  assert.equal(codeOf(() => computeAllMetrics([])), "INVALID_INPUT");
  assert.equal(codeOf(() => computeAllMetrics([{ symbol: "", logReturns: [0.01, 0.02] }])), "INVALID_SYMBOL");
  assert.equal(
    codeOf(() =>
      computeAllMetrics([
        { symbol: "A", logReturns: [0.01, 0.02] },
        { symbol: "A", logReturns: [0.01, 0.02] },
      ])
    ),
    "INVALID_SYMBOL"
  );

  const withoutClusters = computeCorrelation(series);
  assert.equal(withoutClusters.clusters, null);
  const withClusters = computeCorrelation(series, { method: "spearman", clusterThreshold: 0.5 });
  assert.equal(withClusters.correlation.method, "spearman");
  assert.ok((withClusters.clusters?.clusters.length ?? 0) >= 2);
});

test("Pipeline: Sicherheitsnetz für Gewichte und JSON-Ausgabe", () => {
  const columns = blockReturns(3, 2, 60, 5);
  const ok = optimizeWithGuard({
    series: symbols(6, "W").map((symbol, i) => ({ symbol, logReturns: columns[i] })),
    mode: "min_variance",
  });
  assert.equal(ok.rejected, false);
  assertNoWeightsOnRejection(ok);
  assert.throws(() => assertNoWeightsOnRejection({ ...ok, rejected: true }), PortfolioError);
  assert.throws(() => assertNoWeightsOnRejection({ ...ok, weights: [0.4, 0.4] }), PortfolioError);
  assert.deepEqual(weightsForJson([0.1, NaN]), [0.1, 0]);

  // Ein echter Lauf mit eigenem Audit-Logger: Ereignisse gehen in die Senke.
  const sink = memoryAuditSink();
  const result = optimizeWithGuard(
    {
      series: symbols(6, "V").map((symbol, i) => ({ symbol, logReturns: columns[i] })),
      mode: "min_variance",
    },
    { audit: createAuditLogger({ sink, now: () => new Date("2026-08-27T12:00:00.000Z") }) }
  );
  assert.equal(sink.events.length, result.auditEvents.length);
  assert.ok(sink.events.length >= 2);
  assert.equal(sink.events[0].timestamp, "2026-08-27T12:00:00.000Z");
});

test("Parser: Body, Zahlen, Arrays und Symbol-Map", () => {
  assert.deepEqual(asObject({ a: 1 }), { a: 1 });
  assert.equal(codeOf(() => asObject(null)), "INVALID_INPUT");
  assert.equal(codeOf(() => asObject([1])), "INVALID_INPUT");
  assert.equal(codeOf(() => asObject("x")), "INVALID_INPUT");

  assert.equal(parseNumber(2, "x"), 2);
  assert.equal(codeOf(() => parseNumber(5, "x", { max: 1 })), "INVALID_INPUT");
  assert.equal(codeOf(() => parseNumber(0, "x", { min: 1 })), "INVALID_INPUT");
  assert.equal(codeOf(() => parseNumber(1.5, "x", { integer: true })), "INVALID_INPUT");
  assert.equal(parseOptionalNumber(undefined, "x"), undefined);
  assert.equal(parseOptionalNumber(null, "x"), undefined);
  assert.equal(parseOptionalNumber(1, "x"), 1);

  assert.deepEqual(parseNumberArray([1, 2], "x"), [1, 2]);
  assert.equal(codeOf(() => parseNumberArray("1,2", "x")), "INVALID_INPUT");
  assert.deepEqual(parseNumberArray([], "x"), []); // Leere wird erst fachlich geprüft
  assert.equal(codeOf(() => parseNumberArray([1, "2"], "x")), "INVALID_INPUT");
  assert.equal(
    codeOf(() => parseNumberArray(new Array<number>(PORTFOLIO_LIMITS.maxSeriesLength + 1).fill(1), "x")),
    "LIMIT_EXCEEDED"
  );

  assert.equal(parseCorrelationMethod(undefined), undefined);
  assert.equal(parseCorrelationMethod(null), undefined);
  assert.equal(parseCorrelationMethod("pearson"), "pearson");
  assert.equal(codeOf(() => parseCorrelationMethod("kendall")), "INVALID_INPUT");
  assert.equal(parseMode("risk_parity"), "risk_parity");
  assert.equal(codeOf(() => parseMode("random")), "INVALID_INPUT");
  assert.equal(parseSingularMatrixPolicy(undefined), undefined);
  assert.equal(parseSingularMatrixPolicy("ridge"), "ridge");
  assert.equal(codeOf(() => parseSingularMatrixPolicy("magic")), "INVALID_INPUT");

  assert.equal(parseSymbolMap(undefined, "x"), undefined);
  assert.deepEqual(parseSymbolMap({ nvda: 0.5 }, "x"), { NVDA: 0.5 });
  assert.equal(codeOf(() => parseSymbolMap({ nvda: "viel" }, "x")), "INVALID_INPUT");
  assert.equal(codeOf(() => parseSymbolMap([1], "x")), "INVALID_INPUT");
});

test("Parser: Serien, Kerzen und Request-Body", async () => {
  const parsed = parseSeries([
    { symbol: "nvda", prices: [1, 2, 3], candles: [{ high: 2, low: 1, close: 1.5 }], assetClass: "Equity", riskFreeRate: 0.02 },
  ]);
  assert.equal(parsed[0].symbol, "NVDA");
  assert.equal(parsed[0].assetClass, "equity");
  assert.equal(parsed[0].riskFreeRate, 0.02);
  assert.deepEqual(parsed[0].candles, [{ high: 2, low: 1, close: 1.5 }]);
  assert.equal(codeOf(() => parseSeries([{ symbol: "A", prices: [1, 2], candles: "keine" }])), "INVALID_INPUT");
  assert.equal(codeOf(() => parseSeries([{ symbol: "A", prices: [1, 2], candles: [{ high: 1, low: 1 }] }])), "INVALID_INPUT");
  assert.equal(codeOf(() => parseSeries([{ symbol: "A", prices: [1, 2], assetClass: "x".repeat(33) }])), "INVALID_INPUT");
  assert.equal(codeOf(() => parseSeries([{ symbol: "A", prices: [1, 2], riskFreeRate: 5 }])), "INVALID_INPUT");
  assert.equal(codeOf(() => parseSeries(new Array(1001).fill({ symbol: "A", prices: [1, 2] }))), "LIMIT_EXCEEDED");

  const body = (await readJsonBody(new Request("http://localhost/x", { method: "POST", body: '{"a":1}' }))) as { a: number };
  assert.equal(body.a, 1);
  await assert.rejects(() => readJsonBody(new Request("http://localhost/x", { method: "POST", body: "" })), PortfolioError);
  await assert.rejects(() => readJsonBody(new Request("http://localhost/x", { method: "POST", body: "{kein json" })), PortfolioError);
  await assert.rejects(
    () =>
      readJsonBody(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "content-length": "99999999999" },
          body: "{}",
        })
      ),
    (e: unknown) => (e as PortfolioError).code === "LIMIT_EXCEEDED"
  );

  const notAllowed = methodNotAllowed();
  assert.equal(notAllowed.status, 405);
  assert.equal(notAllowed.headers.get("allow"), "POST");
  const error = errorResponse(new Error("intern"));
  assert.equal(error.status, 500);
  assert.equal(statusForCode("INTERNAL_ERROR"), 500);
});

test("Fehlerformat: Fehlerantwort enthält nie interne Details", async () => {
  const response = errorResponse(new Error("connection string postgres://user:pw@host"));
  assert.equal(response.status, 500);
  const body = (await response.json()) as { ok: boolean; error: string; message: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "INTERNAL_ERROR");
  assert.equal(body.message, "Interner Fehler");
  assert.ok(!body.message.includes("postgres"));
  const domain = errorResponse(new PortfolioError("INVALID_INPUT", "feld fehlt", { field: "series" }));
  assert.equal(domain.status, 400);
  const domainBody = (await domain.json()) as { error: string; message: string; field: string };
  assert.equal(domainBody.error, "INVALID_INPUT");
  assert.equal(domainBody.message, "series: feld fehlt");
  assert.equal(domainBody.field, "series");
  assert.ok(!existsSync(path.join(process.cwd(), "undefined")));
});

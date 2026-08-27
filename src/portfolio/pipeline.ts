/**
 * Orchestrierung der Autoritätskette (Task 05).
 *
 * {@link optimizeWithGuard} ist der **einzige** Weg, aus Renditezeitreihen ein
 * Portfolio zu machen: Optimizer → Risk Guard → Position Limits →
 * Correlation Limits. Der Optimizer wird nie direkt exportiert, wenn es um
 * handelbare Gewichte geht (die API nutzt ausschließlich diese Funktion —
 * erzwungen durch `tests/portfolio.architecture.test.ts`).
 *
 * Rein und deterministisch: Zeitstempel kommen aus dem injizierten Audit-Logger,
 * alle anderen Werte aus den Eingaben.
 */

import { createAuditLogger, type AuditLogger } from "./audit";
import {
  annualizationFor,
  assertWithinLimits,
  roundVector,
  validateAnnualization,
} from "./config";
import { PortfolioError, requireFinite } from "./errors";
import {
  clusterAnalysis,
  correlationMatrix,
  covarianceAsMatrix,
  covarianceMatrix,
  returnsMatrix,
} from "./correlation";
import { computeMetrics, type MetricsOptions } from "./metrics";
import { optimizePortfolio, type OptimizationRequest } from "./optimize";
import { applyRiskGuard } from "./riskGuard";
import { mean } from "./numeric";
import type {
  ClusterResult,
  CorrelationMatrix,
  CovarianceEstimate,
  GuardedPortfolio,
  MetricSet,
  OptimizationMode,
  RiskGuardConfig,
  SeriesInput,
  SolverOptions,
  WeightBounds,
} from "./types";

/** Vollständige Anfrage an die Portfolio-Pipeline. */
export interface PortfolioRequest {
  /** Renditezeitreihen (genau eine Quelle je Serie, gleiche Länge). */
  series: readonly SeriesInput[];
  /** Optimierungs-Modus. */
  mode: OptimizationMode;
  /** Annualisierter risikofreier Zins (Default 0). */
  riskFreeRate?: number;
  /**
   * Erwartete Renditen **pro Periode** je Asset. Ohne Angabe wird der Mittelwert
   * der logarithmischen Renditen verwendet (dokumentierte Annahme).
   */
  expectedReturns?: readonly number[];
  /** Kovarianzschätzung (Default Sample, `ddof = 1`). */
  covariance?: { method?: CovarianceEstimate["method"]; decay?: number; ddof?: number };
  /** Gewichtsschranken des Optimierers. */
  bounds?: WeightBounds;
  /** Long-only (Default true). */
  longOnly?: boolean;
  /** Risk-Guard-Konfiguration. */
  guard?: RiskGuardConfig & { allowCashResidual?: boolean };
  /** Solver-Parameter. */
  solver?: SolverOptions;
  /** Annualisierungsfaktor (überschreibt die Asset-Klasse). */
  annualization?: number;
  /** Korrelationsverfahren für die Cluster-Bildung (Default `pearson`). */
  correlationMethod?: CorrelationMatrix["method"];
  /** Kennzahlen mitsamt der Antwort liefern (Default false). */
  withMetrics?: boolean;
  /** Kennzahl-Optionen. */
  metrics?: MetricsOptions;
}

/** Ergebnis eines vollständigen Laufs (inkl. Guard-Report). */
export interface PortfolioOptimizationResult extends GuardedPortfolio {
  /** Verwendete Korrelationsmatrix. */
  correlation: CorrelationMatrix;
  /** Cluster-Analyse der Risk Guard. */
  clusters: ClusterResult;
  /** Metadaten der Kovarianzschätzung. */
  covariance: { method: CovarianceEstimate["method"]; decay: number | null; observations: number; denominator: number };
  /** Kennzahlen je Serie (nur mit `withMetrics`). */
  metrics: MetricSet[] | null;
  /** Annualisierungsfaktor des Laufs. */
  annualization: number;
}

/** Lauf-Optionen (Audit). */
export interface PortfolioRunOptions {
  /** Audit-Logger (Default: keine Senke, Ereignisse nur im Ergebnis). */
  audit?: AuditLogger;
}

/**
 * Rechnet Kennzahlen für mehrere Serien (API `POST /api/portfolio/metrics`).
 */
export function computeAllMetrics(
  series: readonly SeriesInput[],
  options: MetricsOptions = {}
): { symbols: string[]; metrics: MetricSet[] } {
  if (!Array.isArray(series) || series.length === 0) {
    throw new PortfolioError("INVALID_INPUT", "mindestens eine Serie erforderlich", { field: "series" });
  }
  let maxLength = 0;
  for (const s of series) {
    const length = Math.max(s.prices?.length ?? 0, s.returns?.length ?? 0, s.logReturns?.length ?? 0);
    maxLength = Math.max(maxLength, length);
  }
  assertWithinLimits(series.length, Math.max(2, maxLength));
  const symbols = new Set<string>();
  const metrics = series.map((s) => {
    if (typeof s.symbol !== "string" || !s.symbol) {
      throw new PortfolioError("INVALID_SYMBOL", "symbol fehlt", { field: "symbol" });
    }
    if (symbols.has(s.symbol)) {
      throw new PortfolioError("INVALID_SYMBOL", `Symbol ${s.symbol} doppelt übergeben`, { field: "symbol" });
    }
    symbols.add(s.symbol);
    return computeMetrics(s, options);
  });
  return { symbols: [...symbols], metrics };
}

/**
 * Berechnet die Korrelationsmatrix (und optional die Cluster) mehrerer Serien
 * (API `POST /api/portfolio/correlation`).
 */
export function computeCorrelation(
  series: readonly SeriesInput[],
  options: { method?: CorrelationMatrix["method"]; clusterThreshold?: number } = {}
): { correlation: CorrelationMatrix; clusters: ClusterResult | null } {
  const { symbols, columns } = returnsMatrix(series);
  const correlation = correlationMatrix(columns, { symbols, method: options.method ?? "pearson" });
  const clusters =
    options.clusterThreshold === undefined ? null : clusterAnalysis(correlation, options.clusterThreshold);
  return { correlation, clusters };
}

/**
 * **Autoritätskette:** Portfolio Optimizer → Risk Guard → Position Limits →
 * Correlation Limits → Ergebnis.
 *
 * Jeder Schritt ist Pflicht; das Ergebnis enthält den vollständigen
 * Guard-Report (`{ rejected, adjusted, reasons[] }`), die durchlaufene Kette
 * und alle Audit-Ereignisse. Ein verworfenes Portfolio liefert `weights: []`.
 */
export function optimizeWithGuard(
  request: PortfolioRequest,
  options: PortfolioRunOptions = {}
): PortfolioOptimizationResult {
  if (!request || typeof request !== "object") {
    throw new PortfolioError("INVALID_INPUT", "request fehlt", { field: "request" });
  }
  const audit = options.audit ?? createAuditLogger();
  const { symbols, columns, observations } = returnsMatrix(request.series);
  const n = symbols.length;

  const covarianceEstimate = covarianceMatrix(columns, {
    symbols,
    method: request.covariance?.method ?? "sample",
    decay: request.covariance?.decay,
    ddof: request.covariance?.ddof,
  });
  const covariance = covarianceAsMatrix(covarianceEstimate);

  const annualization = validateAnnualization(
    request.annualization ?? annualizationFor(request.series[0]?.assetClass ?? null)
  );
  const riskFreeRateAnnual = request.riskFreeRate === undefined ? 0 : requireFinite(request.riskFreeRate, "riskFreeRate");
  const riskFreeRatePerPeriod = riskFreeRateAnnual / annualization;

  let expectedReturns: number[] | undefined;
  if (request.expectedReturns) {
    if (request.expectedReturns.length !== n) {
      throw new PortfolioError("LENGTH_MISMATCH", `${request.expectedReturns.length} expectedReturns für ${n} Assets`, {
        field: "expectedReturns",
      });
    }
    expectedReturns = request.expectedReturns.map((v) => requireFinite(v, "expectedReturns"));
  } else if (request.mode === "max_sharpe") {
    expectedReturns = columns.map((column) => mean(column));
  }

  const correlationMethod = request.guard?.correlation?.method ?? request.correlationMethod ?? "pearson";
  const correlation = correlationMatrix(columns, { symbols, method: correlationMethod });
  const threshold = request.guard?.correlation?.threshold ?? undefined;
  const clusters = clusterAnalysis(correlation, threshold);

  const optimizationRequest: OptimizationRequest = {
    symbols,
    covariance,
    expectedReturns,
    riskFreeRate: riskFreeRatePerPeriod,
    mode: request.mode,
    bounds: request.bounds,
    longOnly: request.longOnly,
    solver: request.solver,
    annualization,
  };
  const raw = optimizePortfolio(optimizationRequest);

  const optimizationEvent = audit.log({
    event: "PORTFOLIO_OPTIMIZATION",
    level: raw.diagnostics.converged ? "INFO" : "WARN",
    stage: "portfolio-optimizer",
    action: "optimize",
    code: raw.diagnostics.converged ? "OPTIMIZED" : "NOT_CONVERGED",
    mode: raw.mode,
    symbols,
    weights: raw.weights,
    converged: raw.diagnostics.converged,
    iterations: raw.diagnostics.iterations,
    reasons: raw.diagnostics.converged ? [] : ["Solver erreichte die Toleranz innerhalb des Iterationslimits nicht"],
  });

  const guard = applyRiskGuard({ raw, correlation, config: request.guard, audit });

  const metrics = request.withMetrics
    ? request.series.map((s) =>
        computeMetrics(s, {
          riskFreeRate: riskFreeRateAnnual,
          ...request.metrics,
        })
      )
    : null;

  return {
    chain: guard.chain,
    symbols,
    weights: guard.weights,
    mode: raw.mode,
    rejected: guard.rejected,
    adjusted: guard.adjusted,
    reasons: guard.reasons,
    guard,
    raw,
    diagnostics: raw.diagnostics,
    auditEvents: [optimizationEvent, ...guard.auditEvents],
    correlation,
    clusters,
    covariance: {
      method: covarianceEstimate.method,
      decay: covarianceEstimate.decay,
      observations: covarianceEstimate.observations,
      denominator: covarianceEstimate.denominator,
    },
    metrics,
    annualization,
  };
}

/** Gewichte eines abgelehnten Portfolios sind immer leer (Sicherheitsnetz). */
export function assertNoWeightsOnRejection(result: GuardedPortfolio): void {
  if (result.rejected && result.weights.length !== 0) {
    throw new PortfolioError("RISK_GUARD_REJECTION", "abgelehntes Portfolio darf keine Gewichte führen", {
      field: "weights",
    });
  }
  if (!result.rejected) {
    const sum = result.weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) {
      throw new PortfolioError("NUMERIC_FAILURE", `Gewichtssumme ${sum} ≠ 1`, { field: "weights" });
    }
  }
}

/** Gerundete Gewichtsliste für JSON-Ausgaben. */
export function weightsForJson(weights: readonly number[]): number[] {
  return roundVector(weights);
}

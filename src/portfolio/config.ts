/**
 * Konfiguration und harte Grenzen des Portfolio-Moduls (Task 05).
 *
 * Alle Zahlenwerte, die eine Berechnung beeinflussen, sind hier zentral und
 * **validiert** — es gibt keine versteckten Defaults in den Rechenfunktionen.
 * Größenlimits dienen dem DoS-Schutz der API (Kovarianzschätzung kostet
 * `O(T · n²)`, die Optimierung `O(k · n²)`).
 */

import { PortfolioError, requireFinite, requireFiniteAtLeast, requirePositive } from "./errors";
import type { CorrelationMethod, OptimizationMode, SingularMatrixPolicy, VolatilityRegime } from "./types";

/** Version dieses Konfigurationsstandes (für API-Antworten und Artefakte). */
export const PORTFOLIO_CONFIG_VERSION = 1;

/**
 * Annualisierungsfaktoren je Anlageklasse (Perioden pro Jahr).
 *
 * Krypto handelt 365 Tage, Aktien/ETFs/Indizes an ~252 Börsentagen. Die Werte
 * sind bewusst überschreibbar — der Faktor ist eine **Annahme**, keine Wahrheit.
 */
export const DEFAULT_ANNUALIZATION: Readonly<Record<string, number>> = {
  crypto: 365,
  equity: 252,
  etf: 252,
  index: 252,
  fx: 252,
  commodity: 252,
  other: 252,
};

/** Annualisierungsfaktor für unbekannte Anlageklassen. */
export const DEFAULT_ANNUALIZATION_FALLBACK = 252;

/** Standard-Risikofreier Zins (annualisiert, Dezimalanteil). */
export const DEFAULT_RISK_FREE_RATE = 0;

/** Standard-Periode der Average True Range. */
export const DEFAULT_ATR_PERIOD = 14;

/** Freiheitsgrade der Standardabweichung (1 = Stichproben-σ, 0 = Populations-σ). */
export const DEFAULT_DDOF = 1;

/**
 * Abbruchtoleranz des Solvers.
 *
 * Bewusst **enger** als die geforderte Prüftoleranz 1e-6: Konvergenz wird
 * erklärt, wenn das Stationaritätsmaß (∞-Norm des projizierten Gradienten,
 * relativ skaliert) unter diese Schwelle fällt. So bleiben Golden-Tests auf
 * 1e-6 auch bei schlecht konditionierten Kovarianzmatrizen stabil.
 */
export const DEFAULT_SOLVER_TOLERANCE = 1e-9;

/** Standard-Iterationslimit des Solvers. */
export const DEFAULT_MAX_ITERATIONS = 2000;

/** Relative Ridge-Stärke (Anteil der mittleren Diagonale). */
export const DEFAULT_RIDGE_FACTOR = 1e-10;

/** Rang-Schwelle der Pseudo-Inverse (relativ zum größten Eigenwert). */
export const DEFAULT_RCOND = 1e-12;

/** Standard-Verhalten bei singulärer Kovarianzmatrix: klarer Fehler. */
export const DEFAULT_SINGULAR_MATRIX_POLICY: SingularMatrixPolicy = "error";

/** Standard-Verfahren der Kovarianzschätzung. */
export const DEFAULT_COVARIANCE_METHOD = "sample" as const;

/** RiskMetrics-Standard-Decay für tägliche EWMA-Kovarianz. */
export const DEFAULT_EWMA_DECAY = 0.94;

/** Cluster-Schwelle: `|ρ| ≥ 0.8` gilt als derselbe Risikoblock. */
export const DEFAULT_CLUSTER_THRESHOLD = 0.8;

/** Maximales Exposure je Korrelationscluster (50 % des Portfolios). */
export const DEFAULT_MAX_CLUSTER_EXPOSURE = 0.5;

/** Maximales Gewicht je Instrument (20 %). */
export const DEFAULT_MAX_WEIGHT_PER_INSTRUMENT = 0.2;

/** Gewicht unterhalb dieser Grenze wird verworfen (Rundungs-/Splitterpositionen). */
export const DEFAULT_MIN_WEIGHT = 0.001;

/** Maximale Korrekturrunden der Risk Guard (garantiert Terminierung). */
export const DEFAULT_MAX_ADJUSTMENT_ROUNDS = 50;

/** Numerisches Epsilon der Guard-Prüfungen. */
export const DEFAULT_GUARD_EPSILON = 1e-9;

/**
 * Schwellen des Volatilitäts-Regimes (annualisierte Volatilität).
 * Die Grenze gehört zur **oberen** Klasse (`σ = 0.25` ⇒ `NORMAL`).
 */
export const DEFAULT_REGIME_THRESHOLDS: Readonly<RegimeThresholds> = {
  low: 0.25,
  normal: 0.6,
  high: 1.2,
};

/** Schwellen des Volatilitäts-Regimes. */
export interface RegimeThresholds {
  /** Unterhalb davon: `LOW`. */
  low: number;
  /** Unterhalb davon: `NORMAL` (darüber `HIGH`). */
  normal: number;
  /** Ab dort: `EXTREME`. */
  high: number;
}

/**
 * Harte Größenlimits (DoS-Schutz der API und Schutz vor Rechenzeit-Explosion).
 *
 * `maxCovarianceSamples` begrenzt das Produkt `Anzahl Serien × Länge`, weil die
 * Kovarianzschätzung `O(T · n²)` kostet: 500 Assets × 750 Perioden = 375.000
 * Beiträge ≈ 9,4·10⁷ Matrix-Updates (gemessen ≈ 1 s).
 *
 * **Wichtig für die Praxis:** Die Sample-Kovarianz hat höchstens Rang `T − 1`.
 * Bei `n ≥ T` (mehr Assets als Beobachtungen) ist sie **immer** singulär — dann
 * greift `singularMatrixPolicy` (`ridge` bzw. `pseudo-inverse`) oder es müssen
 * mehr Perioden verwendet werden.
 */
export const PORTFOLIO_LIMITS: Readonly<{
  maxSeries: number;
  maxSeriesLength: number;
  maxCovarianceSamples: number;
  maxBodyBytes: number;
  maxSymbolsPerAuditEvent: number;
}> = {
  /** Maximale Anzahl Zeitreihen/Assets je Request (Default laut Spezifikation). */
  maxSeries: 1000,
  /** Maximale Länge einer einzelnen Zeitreihe. */
  maxSeriesLength: 2000,
  /** Maximales Produkt `Serien × Länge` für Kovarianz/Optimierung. */
  maxCovarianceSamples: 400_000,
  /** Maximale Request-Body-Größe der API. */
  maxBodyBytes: 16 * 1024 * 1024,
  /** Audit-Ereignisse führen höchstens so viele Symbole (keine Datenflut). */
  maxSymbolsPerAuditEvent: 25,
};

/** Anzahl Nachkommastellen der API-/Artefakt-Ausgaben (Byte-Stabilität). */
export const OUTPUT_DECIMALS = 12;

/**
 * Rundet deterministisch auf `decimals` Nachkommastellen (Half-away-from-zero).
 * Nicht-endliche Werte werden zu 0 — damit nie `NaN` in ein JSON gelangt.
 */
export function roundTo(value: number, decimals = OUTPUT_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  const scaled = value * f;
  const r = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return r / f;
}

/**
 * Schließt die Rundungslücke einer Gewichtsmenge.
 *
 * Auf 12 Dezimalen gerundete Gewichte summieren sich nicht exakt zu 1
 * (Rest bis ~5·10⁻¹⁰ bei 1.000 Assets). Das Residuum wird auf die **größte**
 * Komponente gebucht, die nicht gesperrt ist — das ist deterministisch und
 * ändert kein Gewicht sichtbar. Da das Residuum ein Vielfaches von 10⁻¹² ist,
 * bleibt der korrigierte Wert exakt darstellbar.
 *
 * @returns das tatsächlich gebuchte Residuum (0, wenn nichts zu tun war).
 */
export function closeRoundingGap(weights: number[], target = 1, isBlocked?: (index: number) => boolean): number {
  const residual = target - weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(residual) || residual === 0) return 0;
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < weights.length; i++) {
    if (isBlocked?.(i)) continue;
    if (weights[i] > bestValue) {
      bestValue = weights[i];
      best = i;
    }
  }
  if (best < 0) return residual;
  weights[best] = roundTo(weights[best] + residual);
  return residual;
}

/** Rundet jeden Eintrag eines Vektors (für stabile JSON-Ausgaben). */
export function roundVector(values: readonly number[], decimals = OUTPUT_DECIMALS): number[] {
  return values.map((v) => roundTo(v, decimals));
}

/**
 * Liefert den Annualisierungsfaktor einer Anlageklasse.
 *
 * Unbekannte Klassen erhalten {@link DEFAULT_ANNUALIZATION_FALLBACK} — es wird
 * kein Wert erfunden, aber auch keine Berechnung abgebrochen.
 */
export function annualizationFor(assetClass?: string | null): number {
  if (!assetClass) return DEFAULT_ANNUALIZATION_FALLBACK;
  const key = assetClass.trim().toLowerCase();
  const value = DEFAULT_ANNUALIZATION[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ANNUALIZATION_FALLBACK;
}

/** Prüft, ob eine Zahl ein gültiges Korrelationsverfahren ist. */
export function isCorrelationMethod(value: unknown): value is CorrelationMethod {
  return value === "pearson" || value === "spearman";
}

/** Prüft, ob eine Zahl ein gültiger Optimierungs-Modus ist. */
export function isOptimizationMode(value: unknown): value is OptimizationMode {
  return value === "min_variance" || value === "max_sharpe" || value === "risk_parity";
}

/** Prüft eine Policy für singuläre Matrizen. */
export function isSingularMatrixPolicy(value: unknown): value is SingularMatrixPolicy {
  return value === "error" || value === "ridge" || value === "pseudo-inverse";
}

/**
 * Validiert Regime-Schwellen: endliche, positive, streng monoton steigende Werte.
 *
 * @throws PortfolioError `INVALID_CONFIG` bei Verletzung.
 */
export function validateRegimeThresholds(input: RegimeThresholds): RegimeThresholds {
  const low = requirePositive(input.low, "regime.low");
  const normal = requirePositive(input.normal, "regime.normal");
  const high = requirePositive(input.high, "regime.high");
  if (!(low < normal && normal < high)) {
    throw new PortfolioError("INVALID_CONFIG", "erwartet low < normal < high", {
      field: "regime",
      details: { low, normal, high },
    });
  }
  return { low, normal, high };
}

/**
 * Validiert einen Annualisierungsfaktor (≥ 1 Periode pro Jahr, ≤ 100.000).
 *
 * @throws PortfolioError `INVALID_INPUT`.
 */
export function validateAnnualization(value: number): number {
  const v = requireFiniteAtLeast(value, 1, "annualization");
  if (v > 100_000) {
    throw new PortfolioError("INVALID_INPUT", "annualization > 100000 ist unplausibel", {
      field: "annualization",
    });
  }
  return v;
}

/**
 * Validiert eine Solver-Konfiguration und liefert vollständige Werte.
 *
 * @throws PortfolioError `INVALID_CONFIG`.
 */
export function resolveSolverOptions(input: {
  tolerance?: number;
  maxIterations?: number;
  ridgeFactor?: number;
  rcond?: number;
}): { tolerance: number; maxIterations: number; ridgeFactor: number; rcond: number } {
  const tolerance = input.tolerance === undefined ? DEFAULT_SOLVER_TOLERANCE : requireFinite(input.tolerance, "tolerance");
  if (!(tolerance > 0) || tolerance > 1) {
    throw new PortfolioError("INVALID_CONFIG", "tolerance muss in (0, 1] liegen", { field: "tolerance" });
  }
  const maxIterations =
    input.maxIterations === undefined
      ? DEFAULT_MAX_ITERATIONS
      : requireFiniteAtLeast(input.maxIterations, 1, "maxIterations");
  if (!Number.isInteger(maxIterations) || maxIterations > 1_000_000) {
    throw new PortfolioError("INVALID_CONFIG", "maxIterations muss ganzzahlig ≤ 1.000.000 sein", {
      field: "maxIterations",
    });
  }
  const ridgeFactor =
    input.ridgeFactor === undefined ? DEFAULT_RIDGE_FACTOR : requireFiniteAtLeast(input.ridgeFactor, 0, "ridgeFactor");
  const rcond = input.rcond === undefined ? DEFAULT_RCOND : requireFiniteAtLeast(input.rcond, 0, "rcond");
  if (rcond >= 1) {
    throw new PortfolioError("INVALID_CONFIG", "rcond muss < 1 sein", { field: "rcond" });
  }
  return { tolerance, maxIterations, ridgeFactor, rcond };
}

/**
 * Validiert die Größenlimits einer Anfrage (Serien × Länge).
 *
 * @throws PortfolioError `LIMIT_EXCEEDED` — kein stillschweigendes Kürzen,
 * weil gekürzte Reihen andere (falsche) Kennzahlen liefern würden.
 */
export function assertWithinLimits(seriesCount: number, seriesLength: number): void {
  requireFiniteAtLeast(seriesCount, 1, "seriesCount");
  requireFiniteAtLeast(seriesLength, 1, "seriesLength");
  if (seriesCount > PORTFOLIO_LIMITS.maxSeries) {
    throw new PortfolioError("LIMIT_EXCEEDED", `maximal ${PORTFOLIO_LIMITS.maxSeries} Serien je Request`, {
      field: "series",
      details: { seriesCount, max: PORTFOLIO_LIMITS.maxSeries },
    });
  }
  if (seriesLength > PORTFOLIO_LIMITS.maxSeriesLength) {
    throw new PortfolioError("LIMIT_EXCEEDED", `maximal ${PORTFOLIO_LIMITS.maxSeriesLength} Punkte je Serie`, {
      field: "series",
      details: { seriesLength, max: PORTFOLIO_LIMITS.maxSeriesLength },
    });
  }
  if (seriesCount * seriesLength > PORTFOLIO_LIMITS.maxCovarianceSamples) {
    throw new PortfolioError(
      "LIMIT_EXCEEDED",
      `Serien × Länge = ${seriesCount * seriesLength} überschreitet ${PORTFOLIO_LIMITS.maxCovarianceSamples}`,
      { field: "series", details: { samples: seriesCount * seriesLength, max: PORTFOLIO_LIMITS.maxCovarianceSamples } }
    );
  }
}

/** Beschreibt ein Regime menschenlesbar (Doku, API, Begründungen). */
export function describeRegime(regime: VolatilityRegime, thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)} %`;
  switch (regime) {
    case "LOW":
      return `ruhig (< ${pct(thresholds.low)} p. a.)`;
    case "NORMAL":
      return `normal (${pct(thresholds.low)}–${pct(thresholds.normal)} p. a.)`;
    case "HIGH":
      return `erhöht (${pct(thresholds.normal)}–${pct(thresholds.high)} p. a.)`;
    default:
      return `extrem (≥ ${pct(thresholds.high)} p. a.)`;
  }
}

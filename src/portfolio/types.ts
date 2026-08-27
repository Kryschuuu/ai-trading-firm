/**
 * Geteilte Typen des Portfolio-Moduls (Task 05).
 *
 * **Decoupling (Architektur-Regel 1):** Dieses Modul ist eine reine
 * Analyseschicht. Input sind ausschließlich Renditezeitreihen und Parameter —
 * keine Datenbank, keine Broker-Objekte, kein LLM, keine Uhr. Jede Funktion ist
 * deterministisch: gleiche Eingabe ⇒ bit-identische Ausgabe.
 *
 * **Autoritätskette (Architektur-Regel 2):** Die Typen erzwingen die Reihenfolge
 * `Portfolio Optimizer → Risk Guard → Position Limits → Correlation Limits`.
 * Ein Optimizer-Ergebnis trägt die Marke {@link OptimizerAuthority} und kann
 * damit **nur** über die Risk Guard zu einem {@link GuardedPortfolio} werden;
 * die Risk Guard liefert immer `{ rejected, adjusted, reasons[] }` und einen
 * Audit-Trail.
 */

import type { PortfolioAuditEvent } from "./audit";

/** Korrelationsverfahren. */
export type CorrelationMethod = "pearson" | "spearman";

/** Volatilitäts-Regime (Schwellen konfigurierbar, siehe `config.ts`). */
export type VolatilityRegime = "LOW" | "NORMAL" | "HIGH" | "EXTREME";

/** Die drei Optimierungs-Modi. */
export type OptimizationMode = "min_variance" | "max_sharpe" | "risk_parity";

/** Verhalten bei singulärer / nicht positiv definiter Kovarianzmatrix. */
export type SingularMatrixPolicy = "error" | "ridge" | "pseudo-inverse";

/** Schätzverfahren der Kovarianzmatrix. */
export type CovarianceMethod = "sample" | "ewma";

/** Eine OHLC-Teilmenge — ausreichend für die True Range / ATR. */
export interface CandleLike {
  /** Höchster Kurs der Periode (> 0). */
  high: number;
  /** Tiefster Kurs der Periode (> 0). */
  low: number;
  /** Schlusskurs der Periode (> 0). */
  close: number;
}

/**
 * Eingabezeitreihe **eines** Instruments.
 *
 * Genau eine der drei Reihen (`prices`, `returns`, `logReturns`) ist Pflicht;
 * `candles` ist optional und wird ausschließlich für ATR/True Range benutzt.
 */
export interface SeriesInput {
  /** Symbol oder kanonische Instrument-ID (`NVDA`, `BINANCE:BTCUSDT`). */
  symbol: string;
  /** Schlusskurse (> 0) → logarithmische Renditen `ln(p_t / p_{t-1})`. */
  prices?: readonly number[];
  /** Einfache Renditen (`p_t/p_{t-1} − 1`) → `ln(1 + r)`. */
  returns?: readonly number[];
  /** Bereits logarithmische Renditen (werden unverändert validiert). */
  logReturns?: readonly number[];
  /** OHLC-Teilmenge für ATR (optional). */
  candles?: readonly CandleLike[];
  /** Anlageklasse → steuert den Annualisierungsfaktor (Default 252). */
  assetClass?: string;
  /** Jahres-Risikofreier Zins dieser Serie (überschreibt den globalen Wert). */
  riskFreeRate?: number;
}

/** Ergebnis einer Max-Drawdown-Analyse (inkl. Dauer und Tiefpunkt). */
export interface MaxDrawdownResult {
  /** Größter Rückgang vom laufenden Hoch, als positiver Anteil (0.35 = 35 %). */
  value: number;
  /** Index des Hochs, von dem der größte Rückgang ausging. */
  peakIndex: number;
  /** Index des Tiefpunkts dieses Rückgangs. */
  troughIndex: number;
  /** Index, an dem das Hoch wieder erreicht wurde (`null` = nie). */
  recoveryIndex: number | null;
  /** Perioden zwischen Hoch und Tiefpunkt. */
  peakToTroughPeriods: number;
  /**
   * Dauer des Drawdowns in Perioden: Hoch → Erholung, bzw. Hoch → Serienende,
   * wenn sich der Kurs innerhalb des Fensters nicht erholt hat.
   */
  durationPeriods: number;
  /** true, wenn das vorherige Hoch innerhalb der Serie wieder erreicht wurde. */
  recovered: boolean;
}

/** Vollständiger Kennzahlensatz einer Serie. */
export interface MetricSet {
  /** Symbol der Serie. */
  symbol: string;
  /** Anzahl der logarithmischen Renditen, aus denen gerechnet wurde. */
  observations: number;
  /** Verwendeter Annualisierungsfaktor (Perioden pro Jahr). */
  annualization: number;
  /** Mittlerer logarithmischer Renditewert pro Periode. */
  meanLogReturn: number;
  /** Geometrisch annualisierte Rendite `exp(mean·A) − 1`. */
  annualizedReturn: number;
  /** Realisierte Volatilität pro Periode (Standardabweichung der Log-Renditen). */
  volatilityPerPeriod: number;
  /** Annualisierte realisierte Volatilität `σ_p · √A`. */
  volatility: number;
  /** Annualisierte Sharpe Ratio `(E[r] − rf)/σ · √A`. */
  sharpe: number;
  /** Sharpe Ratio pro Periode (nicht annualisiert). */
  sharpePerPeriod: number;
  /** Annualisierte Sortino Ratio (Downside-Deviation statt σ). */
  sortino: number;
  /** Sortino Ratio pro Periode (nicht annualisiert). */
  sortinoPerPeriod: number;
  /** Downside-Deviation pro Periode (Nenner der Sortino Ratio). */
  downsideDeviation: number;
  /** Max Drawdown inkl. Dauer und Tiefpunkt. */
  maxDrawdown: MaxDrawdownResult;
  /** Profit Factor `ΣGewinne / |ΣVerluste|` (`Infinity` ohne Verluste, `null` ohne Bewegung). */
  profitFactor: number | null;
  /** Bruttogewinn `Σ max(r, 0)` — macht `profitFactor = Infinity` eindeutig. */
  grossProfit: number;
  /** Bruttoverlust `|Σ min(r, 0)|` — `0` ⇒ Profit Factor unbeschränkt. */
  grossLoss: number;
  /** Average True Range in Kurseinheiten (`null` ohne Kerzen). */
  atr: number | null;
  /** ATR in Prozent des letzten Schlusskurses (`null` ohne Kerzen). */
  atrPct: number | null;
  /** Verwendete ATR-Periode (`null` ohne Kerzen). */
  atrPeriod: number | null;
  /** Verwendeter annualisierter risikofreier Zins. */
  riskFreeRate: number;
  /** Volatilitäts-Regime auf Basis der annualisierten Volatilität. */
  regime: VolatilityRegime;
}

/** Korrelationsmatrix inkl. Symbolreihenfolge. */
export interface CorrelationMatrix {
  /** Verwendetes Verfahren. */
  method: CorrelationMethod;
  /** Symbole in Zeilen-/Spaltenreihenfolge. */
  symbols: string[];
  /** Symmetrische Matrix (`n × n`), Diagonale = 1. */
  matrix: number[][];
  /** Anzahl der Beobachtungen je Paar. */
  observations: number;
  /**
   * Symbole mit Nullvarianz — ihre Korrelationen sind mathematisch undefiniert
   * und werden als `0` (neutral) geliefert, niemals als `1`.
   */
  degenerate?: string[];
}

/** Ein Korrelationscluster (Single-Linkage über `|ρ| ≥ Schwelle`). */
export interface CorrelationCluster {
  /** Stabile Cluster-Nummer (0-basiert, sortiert nach kleinstem Symbol). */
  id: number;
  /** Mitglieder (aufsteigend sortiert). */
  symbols: string[];
  /** Größter |ρ| innerhalb des Clusters. */
  maxAbsCorrelation: number;
}

/** Ergebnis der Cluster-Bildung. */
export interface ClusterResult {
  /** Cluster-Schwelle `|ρ| ≥ threshold`. */
  threshold: number;
  /** Verfahren der zugrunde liegenden Matrix. */
  method: CorrelationMethod;
  /** Symbole in Matrix-Reihenfolge. */
  symbols: string[];
  /** Cluster, deterministisch sortiert. */
  clusters: CorrelationCluster[];
}

/** Kovarianzmatrix + Metadaten der Schätzung. */
export interface CovarianceEstimate {
  /** Schätzverfahren. */
  method: CovarianceMethod;
  /** Symbole in Zeilen-/Spaltenreihenfolge. */
  symbols: string[];
  /** Symmetrische Kovarianzmatrix (pro Periode). */
  rows: number[][];
  /** Anzahl der Renditevektoren. */
  observations: number;
  /** EWMA-Decay `λ` (null bei `sample`). */
  decay: number | null;
  /** Freiheitsgrade-Korrektur (`n − ddof`) bzw. EWMA-Bias-Korrekturfaktor. */
  denominator: number;
}

/** Marke: dieses Ergebnis stammt aus dem Optimizer und ist **ungeprüft**. */
export const OPTIMIZER_AUTHORITY = "portfolio-optimizer" as const;
/** Typ der Marke (nur intern erzeugbar, siehe `optimize.ts`). */
export type OptimizerAuthority = typeof OPTIMIZER_AUTHORITY;

/** Feste Reihenfolge der Autoritätskette — in Code und Tests erzwungen. */
export const AUTHORITY_CHAIN = [
  "portfolio-optimizer",
  "risk-guard",
  "position-limits",
  "correlation-limits",
] as const;
/** Ein Glied der Autoritätskette. */
export type AuthorityStage = (typeof AUTHORITY_CHAIN)[number];

/** Gewichtsschranken des Optimierers. */
export interface WeightBounds {
  /** Untergrenze je Asset (Default 0 = long-only). */
  minWeight?: number;
  /** Obergrenze je Asset (Default 1). */
  maxWeight?: number;
  /** Explizite Untergrenzen je Asset (überschreibt `minWeight`). */
  lower?: readonly number[];
  /** Explizite Obergrenzen je Asset (überschreibt `maxWeight`). */
  upper?: readonly number[];
}

/** Solver-Parameter (Toleranz, Iterationen, Numerik-Policy). */
export interface SolverOptions {
  /** Abbruchtoleranz (Default `DEFAULT_SOLVER_TOLERANCE` = 1e-9). */
  tolerance?: number;
  /** Iterationslimit (Default `DEFAULT_MAX_ITERATIONS`). */
  maxIterations?: number;
  /** Verhalten bei singulärer Kovarianz (Default `error`). */
  singularMatrixPolicy?: SingularMatrixPolicy;
  /** Ridge-Faktor für die Policy `ridge` (Default 1e-10 relativ zur Spur). */
  ridgeFactor?: number;
  /** `rcond` der Pseudo-Inverse (Default 1e-12). */
  rcond?: number;
}

/** Diagnose eines Optimizer-Laufs (ohne Uhr, ohne I/O ⇒ deterministisch). */
export interface OptimizationDiagnostics {
  /** Modus. */
  mode: OptimizationMode;
  /** true, wenn die Toleranz vor dem Iterationslimit erreicht wurde. */
  converged: boolean;
  /** Verbrauchte Iterationen. */
  iterations: number;
  /** Zielfunktionswert (je Modus dokumentiert). */
  objective: number;
  /** Stationaritätsmaß (∞-Norm des projizierten Gradienten bzw. RC-Spread). */
  stationarity: number;
  /** Portfoliovarianz pro Periode `w'Σw`. */
  variance: number;
  /** Portfoliovolatilität pro Periode `√(w'Σw)`. */
  volatility: number;
  /** Annualisierte Portfoliovolatilität. */
  annualizedVolatility: number;
  /** Erwartete Portfoliorendite pro Periode (null bei `min_variance` ohne μ). */
  expectedReturn: number | null;
  /** Sharpe Ratio des Ergebnisses (null wenn μ fehlt oder σ = 0). */
  sharpe: number | null;
  /** Risk Contributions `wᵢ(Σw)ᵢ / w'Σw` (summieren zu 1). */
  riskContributions: number[];
  /** Regularisierung, die angewendet wurde. */
  regularization: { applied: "none" | "ridge" | "pseudo-inverse"; ridge: number };
  /** War der Active-Set-Polish erfolgreich? (nur `min_variance`) */
  polished: boolean | null;
}

/**
 * **Ungeprüftes** Optimizer-Ergebnis.
 *
 * Die Marke `authority` stellt sicher, dass dieses Objekt nur über
 * `applyRiskGuard()` / `optimizeWithGuard()` zu einem handelbaren Portfolio
 * werden kann — ein Optimizer-Ergebnis gilt in dieser Plattform nie ungeprüft.
 */
export interface RawOptimizationResult {
  /** Feste Marke: Herkunft ist der Optimizer, nicht die Risk Guard. */
  readonly authority: OptimizerAuthority;
  /** Symbole in Gewichtsreihenfolge. */
  readonly symbols: string[];
  /** Rohgewichte (Σ = 1, Bounds eingehalten). */
  readonly weights: number[];
  /** Modus. */
  readonly mode: OptimizationMode;
  /** Solver-Diagnose inkl. Konvergenz. */
  readonly diagnostics: OptimizationDiagnostics;
  /** Wirksam gewesene Bounds (Nachvollziehbarkeit). */
  readonly bounds: { lower: number[]; upper: number[] };
}

/** Positionslimits der Risk Guard. */
export interface PositionLimits {
  /** Maximales Gewicht je Instrument (Default 0.20 = 20 %). */
  maxWeightPerInstrument?: number;
  /** Instrumentenspezifische Obergrenzen (überschreiben den Globalwert). */
  perSymbol?: Record<string, number>;
  /** Maximale Anzahl gleichzeitig gehaltener Instrumente (optional). */
  maxPositions?: number;
  /** Gewicht unterhalb dieser Grenze wird auf 0 gesetzt (Default 0.001). */
  minWeight?: number;
}

/** Korrelationslimits der Risk Guard. */
export interface CorrelationLimits {
  /** Cluster-Schwelle `|ρ| ≥ threshold` (Default 0.8). */
  threshold?: number;
  /** Maximale Summe der Gewichte je Cluster (Default 0.5). */
  maxClusterExposure?: number;
  /** Verfahren der Cluster-Bildung (Default `pearson`). */
  method?: CorrelationMethod;
}

/** Konfiguration der Risk Guard. */
export interface RiskGuardConfig {
  /** Positionslimits. */
  position?: PositionLimits;
  /** Korrelationslimits. */
  correlation?: CorrelationLimits;
  /** Maximale Korrekturrunden (Default 50) — garantiert Terminierung. */
  maxAdjustmentRounds?: number;
  /** Numerisches Epsilon für Verletzungsprüfungen (Default 1e-9). */
  epsilon?: number;
}

/** Eine strukturierte Guard-Entscheidung (Grund + Maßnahme). */
export interface GuardDecision {
  /** Stufe der Autoritätskette, auf der entschieden wurde. */
  stage: AuthorityStage;
  /** Maschinenlesbarer Grund, z. B. `POSITION_LIMIT_CAPPED`. */
  code: string;
  /** Betroffenes Symbol (optional). */
  symbol?: string;
  /** Betroffener Cluster (optional). */
  cluster?: number;
  /** Maßnahme. */
  action: "cap" | "drop" | "redistribute" | "reject" | "scale";
  /** Wirksame Grenze. */
  limit: number;
  /** Wert vor der Maßnahme. */
  before: number;
  /** Wert nach der Maßnahme. */
  after: number;
  /** Menschenlesbare Begründung. */
  message: string;
}

/** Exposure je Korrelationscluster (vor/nach der Guard). */
export interface ClusterExposure {
  /** Cluster-Nummer. */
  clusterId: number;
  /** Mitglieder. */
  symbols: string[];
  /** Exposure vor der Guard. */
  before: number;
  /** Exposure nach der Guard. */
  after: number;
  /** Wirksame Obergrenze. */
  limit: number;
  /** true, wenn die Grenze vor der Guard verletzt war. */
  violated: boolean;
}

/**
 * Ergebnis der Risk-Guard-Kette.
 *
 * `rejected = true` ⇒ es gibt **kein** verwendbares Portfolio (`weights = []`);
 * `adjusted = true` ⇒ das Optimizer-Ergebnis wurde gekappt/umverteilt.
 * Jede Entscheidung steht in `decisions` **und** als Audit-Ereignis in
 * `auditEvents` (eine Entscheidung = ein Audit-Eintrag).
 */
export interface RiskGuardResult {
  /** true, wenn das Ergebnis verworfen wurde (keine Gewichte freigegeben). */
  rejected: boolean;
  /** true, wenn mindestens eine Kappung/Umverteilung stattfand. */
  adjusted: boolean;
  /** Freigegebene Gewichte (`[]` bei `rejected`). */
  weights: number[];
  /** Eingegangene (ungeprüfte) Optimizer-Gewichte. */
  input: number[];
  /** Grundliste — für Menschen und LLM-Interpretation. */
  reasons: string[];
  /** Strukturierte Einzelentscheidungen. */
  decisions: GuardDecision[];
  /** Durchlaufene Stufen der Autoritätskette (in Reihenfolge). */
  chain: AuthorityStage[];
  /** Wirksame Positionslimits je Symbol. */
  caps: { symbol: string; cap: number }[];
  /** Cluster-Exposures vor/nach. */
  clusterExposures: ClusterExposure[];
  /** Audit-Ereignisse (eine Entscheidung = ein Ereignis, plus Summary). */
  auditEvents: PortfolioAuditEvent[];
}

/** Freigegebenes Portfolio — das einzige Ergebnis, das die API ausliefert. */
export interface GuardedPortfolio {
  /** Durchlaufene Autoritätskette (immer die feste Reihenfolge). */
  chain: AuthorityStage[];
  /** Symbole in Gewichtsreihenfolge. */
  symbols: string[];
  /** Freigegebene Gewichte (Σ = 1, alle Limits eingehalten) — `[]` bei Ablehnung. */
  weights: number[];
  /** Optimizer-Modus. */
  mode: OptimizationMode;
  /** true, wenn die Risk Guard verworfen hat. */
  rejected: boolean;
  /** true, wenn gekappt/umverteilt wurde. */
  adjusted: boolean;
  /** Grundliste der Guard. */
  reasons: string[];
  /** Vollständiger Guard-Report. */
  guard: RiskGuardResult;
  /** Ungeprüftes Optimizer-Ergebnis (Transparenz, nie direkt handeln). */
  raw: RawOptimizationResult;
  /** Solver-Diagnose. */
  diagnostics: OptimizationDiagnostics;
  /** Audit-Ereignisse des gesamten Laufs. */
  auditEvents: PortfolioAuditEvent[];
}

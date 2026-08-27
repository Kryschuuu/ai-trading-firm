/**
 * Agenten-Interface (Task 05): fertige Zahlen für das LLM — keine Rechenaufträge.
 *
 * **Warum diese Funktion existiert:** Das LLM darf *interpretieren* („NVDA und
 * QQQ sind hoch korreliert, das Konzentrationrisiko ist hoch"), aber niemals
 * *berechnen*. `getAnalysisContext()` liefert deshalb ausschließlich bereits
 * berechnete, validierte Ergebnisse: Kennzahlen, Korrelationsmatrix, Cluster,
 * Regime und die wirksamen Limits. Gewichte stehen hier **nicht** drin — sie
 * entstehen nur in `optimizeWithGuard()` (Optimizer → Risk Guard → Position
 * Limits → Correlation Limits).
 *
 * Der Kontext enthält ein explizites Regelwerk (`interpretation`), das dem
 * Modell sagt, was es sagen darf und was nicht. Das ist eine Leitplanke, keine
 * Sicherheit: die echte Grenze ist, dass kein LLM-Ergebnis je ungeprüft in eine
 * Order fließt (siehe `docs/PORTFOLIO_ANALYTICS.md`, Abschnitt „Warum das LLM
 * keine Gewichte berechnet").
 */

import {
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_MAX_CLUSTER_EXPOSURE,
  DEFAULT_MAX_WEIGHT_PER_INSTRUMENT,
  PORTFOLIO_CONFIG_VERSION,
  roundVector,
} from "./config";
import { PortfolioError } from "./errors";
import { clusterAnalysis, correlationMatrix, correlationClusters } from "./correlation";
import { computeMetrics, type MetricsOptions } from "./metrics";
import { AUTHORITY_CHAIN, type CorrelationMatrix, type MetricSet } from "./types";

/** Ergebnis von {@link getAnalysisContext}. */
export interface AnalysisContext {
  /** Modul und Konfigurationsversion (Nachvollziehbarkeit). */
  generatedBy: { module: string; configVersion: number };
  /** Symbole in Reihenfolge der Matrizen. */
  symbols: string[];
  /** Anzahl der Beobachtungen je Serie. */
  observations: number;
  /** Kennzahlen je Symbol (Volatilität, Sharpe, Sortino, MaxDD, Profit Factor, ATR, Regime). */
  metrics: MetricSet[];
  /** Pearson-Korrelationsmatrix. */
  correlation: CorrelationMatrix;
  /** Spearman-Korrelationsmatrix (Rangkorrelation). */
  rankCorrelation: CorrelationMatrix;
  /** Korrelationscluster inkl. Schwelle. */
  clusters: { threshold: number; clusters: { id: number; symbols: string[]; maxAbsCorrelation: number }[] };
  /** Wirksam angenommene Limits der Risk Guard (nur Information). */
  limits: {
    maxWeightPerInstrument: number;
    clusterThreshold: number;
    maxClusterExposure: number;
  };
  /** Autoritätskette, die Gewichte erzeugt. */
  authority: {
    chain: readonly string[];
    weightsComputedBy: string;
    riskGuard: string;
    notice: string;
  };
  /** Interpretationsregeln für das LLM (Leitplanke, keine Berechnungsfreigabe). */
  interpretation: {
    llmMay: string[];
    llmMustNot: string[];
  };
}

/** Optionen des Analyse-Kontexts. */
export interface AnalysisContextOptions extends MetricsOptions {
  /** Cluster-Schwelle (Default 0.8). */
  clusterThreshold?: number;
  /** Maximales Gewicht je Instrument (nur zur Information, Default 0.2). */
  maxWeightPerInstrument?: number;
  /** Maximales Cluster-Exposure (nur zur Information, Default 0.5). */
  maxClusterExposure?: number;
}

/**
 * Baut den Analyse-Kontext für die Interpretations-Ebene.
 *
 * @param returns logarithmische Renditen je Symbol (gleiche Länge, ≥ 2 Werte)
 * @param symbols Symbolnamen in derselben Reihenfolge
 * @throws PortfolioError `LENGTH_MISMATCH`, `INVALID_INPUT`, `INSUFFICIENT_DATA`
 */
export function getAnalysisContext(
  returns: readonly (readonly number[])[],
  symbols: readonly string[],
  options: AnalysisContextOptions = {}
): AnalysisContext {
  if (!Array.isArray(returns) || returns.length === 0) {
    throw new PortfolioError("INVALID_INPUT", "mindestens eine Renditeserie erforderlich", { field: "returns" });
  }
  if (!Array.isArray(symbols) || symbols.length !== returns.length) {
    throw new PortfolioError("LENGTH_MISMATCH", `${symbols?.length ?? 0} Symbole für ${returns.length} Serien`, {
      field: "symbols",
    });
  }
  const length = returns[0].length;
  for (let i = 0; i < returns.length; i++) {
    if (returns[i].length !== length) {
      throw new PortfolioError("LENGTH_MISMATCH", `Serie ${symbols[i]} hat ${returns[i].length} Renditen, erwartet ${length}`, {
        field: "returns",
        details: { index: i },
      });
    }
  }
  const threshold = options.clusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const metrics: MetricSet[] = returns.map((series, i) =>
    computeMetrics({ symbol: symbols[i], logReturns: series.slice() }, options)
  );
  const correlation = correlationMatrix(returns, { symbols, method: "pearson" });
  const rankCorrelation = correlationMatrix(returns, { symbols, method: "spearman" });
  const clusters = clusterAnalysis(correlation, threshold);

  return {
    generatedBy: { module: "src/portfolio (task-05)", configVersion: PORTFOLIO_CONFIG_VERSION },
    symbols: symbols.slice(),
    observations: length,
    metrics,
    correlation,
    rankCorrelation,
    clusters: {
      threshold,
      clusters: clusters.clusters.map((c) => ({ id: c.id, symbols: c.symbols, maxAbsCorrelation: c.maxAbsCorrelation })),
    },
    limits: {
      maxWeightPerInstrument: options.maxWeightPerInstrument ?? DEFAULT_MAX_WEIGHT_PER_INSTRUMENT,
      clusterThreshold: threshold,
      maxClusterExposure: options.maxClusterExposure ?? DEFAULT_MAX_CLUSTER_EXPOSURE,
    },
    authority: {
      chain: AUTHORITY_CHAIN,
      weightsComputedBy: "src/portfolio/optimize.ts (min_variance | max_sharpe | risk_parity)",
      riskGuard: "src/portfolio/riskGuard.ts (Position Limits → Correlation Limits)",
      notice:
        "Gewichte werden ausschließlich von der mathematischen Schicht berechnet und von der Risk Guard freigegeben. Dieses Objekt enthält bewusst keine Gewichte.",
    },
    interpretation: {
      llmMay: [
        "Zusammenhänge zwischen den gelieferten Kennzahlen erklären (Volatilität, Korrelation, Drawdown).",
        "Risikokonzentrationen benennen, die aus den Clustern sichtbar werden.",
        "Auf Datenqualität und Grenzen der Historie hinweisen.",
        "Qualitative Einschätzungen formulieren, die keine Zahlen neu erfinden.",
      ],
      llmMustNot: [
        "Portfolio-Gewichte, Positionsgrößen oder Ordergrößen berechnen oder vorschlagen.",
        "Kennzahlen, Korrelationen oder Cluster neu berechnen oder „korrigieren“.",
        "Limits der Risk Guard umgehen, aufweichen oder deren Aufhebung empfehlen.",
        "Renditen oder Kursziele prognostizieren und als Tatsache darstellen.",
      ],
    },
  };
}

/**
 * Kompakte Textzusammenfassung des Analyse-Kontexts (für Prompts/Logs).
 *
 * Enthält ausschließlich bereits berechnete Werte; keine Aufforderung an das
 * Modell, etwas zu rechnen.
 */
export function summarizeAnalysisContext(context: AnalysisContext, maxSymbols = 12): string {
  const lines: string[] = [];
  lines.push(`Analyse-Kontext (${context.symbols.length} Symbole, ${context.observations} Beobachtungen):`);
  for (const m of context.metrics.slice(0, maxSymbols)) {
    lines.push(
      `- ${m.symbol}: Vol ${(m.volatility * 100).toFixed(2)} % p. a. (${m.regime}), Sharpe ${m.sharpe.toFixed(2)}, ` +
        `Sortino ${m.sortino.toFixed(2)}, MaxDD ${(m.maxDrawdown.value * 100).toFixed(2)} % ` +
        `(${m.maxDrawdown.durationPeriods} Perioden), PF ${m.profitFactor === null ? "n/a" : m.profitFactor.toFixed(2)}`
    );
  }
  if (context.metrics.length > maxSymbols) {
    lines.push(`- … ${context.metrics.length - maxSymbols} weitere Symbole`);
  }
  for (const cluster of context.clusters.clusters) {
    if (cluster.symbols.length < 2) continue;
    lines.push(
      `- Cluster ${cluster.id} (|ρ| ≥ ${context.clusters.threshold}): ${cluster.symbols.join(", ")} ` +
        `(max |ρ| ${cluster.maxAbsCorrelation.toFixed(3)})`
    );
  }
  lines.push(
    `Limits: max ${(context.limits.maxWeightPerInstrument * 100).toFixed(0)} % je Instrument, ` +
      `max ${(context.limits.maxClusterExposure * 100).toFixed(0)} % je Cluster.`
  );
  lines.push("Gewichte berechnet ausschließlich die mathematische Schicht inklusive Risk Guard.");
  return lines.join("\n");
}

/** Gerundete Kopie der Korrelationsmatrix (für Prompts/Artefakte). */
export function correlationForPrompt(correlation: CorrelationMatrix): number[][] {
  return correlation.matrix.map((row) => roundVector(row, 4));
}

/** Cluster als Symbol-Listen (für Prompts). */
export function clustersForPrompt(returns: readonly (readonly number[])[], symbols: readonly string[], threshold = DEFAULT_CLUSTER_THRESHOLD): string[][] {
  const correlation = correlationMatrix(returns, { symbols, method: "pearson" });
  return correlationClusters(correlation, threshold).map((c) => c.symbols);
}

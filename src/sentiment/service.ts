/**
 * Service-Schicht für kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05).
 *
 * Koordiniert Deduplikation, Unsicherheitsbewertung, Envelope-Bau, Persistenz
 * und Telemetrie.
 */

import { structuredLog } from "../lib/logger";
import { telemetry } from "../lib/telemetry";
import { deduplicateNewsSources, filterSourcesForEntity } from "./deduplication";
import { buildStructuredSentimentForecast } from "./semantics";
import {
  persistSentimentForecastBatch,
  structuredSentimentPersistenceEnabled,
  type SentimentStoreDeps,
} from "./store";
import {
  SENTIMENT_HORIZONS,
  type SentimentHorizon,
  type SentimentNewsItem,
  type StructuredSentimentForecast,
} from "./types";

export interface AgentSymbolAnalysis {
  instrumentId: string;
  sentiment?: "BULLISH" | "BEARISH" | "NEUTRAL";
  impactScore?: number;
  riskFlags?: string[];
  summary?: string;
  eventType?: string;
  horizon?: string;
  confidence?: number;
}

export interface EvaluateSentimentOptions {
  asOf?: Date;
  horizon?: SentimentHorizon;
  model?: string;
  promptVersion?: number;
  persist?: boolean;
  storeDeps?: SentimentStoreDeps;
}

/**
 * Wertet Sentiment für eine Menge von Entitäten / Symbolen aus.
 *
 * Führt automatische Syndikations-Deduplikation aus, weist Quellen
 * den jeweiligen Entitäten zu und erzeugt für jedes Symbol einen
 * kalibrierbaren Envelope.
 */
export async function evaluateSentimentForEntities(
  symbols: readonly string[],
  newsItems: readonly SentimentNewsItem[],
  agentAnalyses: readonly AgentSymbolAnalysis[] = [],
  options: EvaluateSentimentOptions = {}
): Promise<StructuredSentimentForecast[]> {
  const asOf = options.asOf ?? new Date();
  const horizon = options.horizon ?? "24h";
  const model = options.model ?? "hubble-sentiment";
  const promptVersion = options.promptVersion ?? 1;

  // 1. Alle Roh-Nachrichten deduplizieren und syndizierte Quellen zusammenfassen
  const deduplicatedSources = deduplicateNewsSources(newsItems, {
    asOf,
    targetEntities: symbols,
  });

  // Telemetrie für Deduplikation
  let rawTotal = 0;
  for (const s of deduplicatedSources) {
    rawTotal += s.syndicationCount;
  }
  const duplicatesCount = Math.max(0, rawTotal - deduplicatedSources.length);
  for (let i = 0; i < deduplicatedSources.length; i++) {
    telemetry.sentiment.deduplications.inc({ result: "unique" });
  }
  for (let i = 0; i < duplicatesCount; i++) {
    telemetry.sentiment.deduplications.inc({ result: "syndicated_duplicate" });
  }

  const agentMap = new Map<string, AgentSymbolAnalysis>();
  for (const a of agentAnalyses) {
    if (a.instrumentId) {
      agentMap.set(a.instrumentId.toUpperCase(), a);
    }
  }

  const results: StructuredSentimentForecast[] = [];

  // 2. Für jedes Symbol einen eigenen Envelope berechnen
  for (const sym of symbols) {
    const cleanSym = sym.trim();
    if (!cleanSym) continue;

    // Spezifische Quellen für dieses Symbol filtern
    const symbolSources = filterSourcesForEntity(deduplicatedSources, cleanSym);
    const agentItem = agentMap.get(cleanSym.toUpperCase());

    const direction = agentItem?.sentiment ?? "NEUTRAL";
    const confidence = typeof agentItem?.confidence === "number"
      ? agentItem.confidence
      : typeof agentItem?.impactScore === "number"
        ? Math.abs(agentItem.impactScore - 50) / 50
        : 0;

    const forecast = buildStructuredSentimentForecast({
      entityId: cleanSym,
      symbol: cleanSym.replace(/^(?:BINANCE:|BITUNIX:|PAPER:|ALPACA:)/i, ""),
      sources: symbolSources,
      asOf,
      horizon,
      direction: symbolSources.length > 0 ? (agentItem?.sentiment ?? "NEUTRAL") : undefined,
      confidence,
      impactScore: agentItem?.impactScore ?? 50,
      riskFlags: agentItem?.riskFlags ?? [],
      summary: agentItem?.summary,
      promptVersion,
      model,
    });

    results.push(forecast);

    // Bounded Telemetrie erfassen
    telemetry.sentiment.evaluations.inc({
      status: forecast.status,
      direction: forecast.direction ?? "none",
      horizon: forecast.horizon,
    });
  }

  // 3. Optionale Persistenz in Postgres
  if (options.persist !== false && structuredSentimentPersistenceEnabled()) {
    try {
      await persistSentimentForecastBatch(results, options.storeDeps);
    } catch (e) {
      structuredLog("warn", "sentiment_service_persist_failed", {
        count: results.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

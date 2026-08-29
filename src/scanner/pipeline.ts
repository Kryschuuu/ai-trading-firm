/**
 * Scan-Pipeline (Task 04) — orchestriert Faktoren, Filter, Score und Trichter.
 *
 * ```text
 * Instrumente (Registry)
 *   → Datenanbindung (Kerzen, Benchmark, Derivate, News-Zähler)   [injiziert]
 *   → 14 Faktoren (gecacht)
 *   → Regime + Eignungsfilter
 *   → Market Score + Breakdown
 *   → Trichter (geeignet → interessant → daily → deep)
 * ```
 *
 * Die Pipeline ist **read-only**: sie mutiert weder Registry noch Marktdaten
 * und ruft nichts Externes auf. Jede Zeitabhängigkeit kommt über `asOf` herein.
 */

import type { MarketCandle } from "@/lib/marketdata/types";
import type { MarketInstrument } from "@/universe/types";
import { FactorCache, type CacheStats } from "./cache";
import { loadScannerConfig, type ScannerConfig } from "./config";
import { computeAllFactors } from "./factors";
import { checkEligibility, type FilterRejection } from "./filters";
import { buildFunnel, type FunnelResult } from "./funnel";
import { classifyRegime } from "./regime";
import { rankByScore, scoreFromFactors } from "./ranker";
import type { DerivativeContext, FactorInput, InstrumentScore, NewsRiskContext } from "./types";
import type { ScannerReadiness } from "./readiness";
import { assessDataReadiness, requiredWarmupCandles } from "./warmup";

/** Harte Obergrenze eines Scan-Laufs (Speicher-/DoS-Schutz). */
export const MAX_SCAN_INSTRUMENTS = 250_000;

/**
 * Datenanbindung des Scanners. Alles ist synchron und lokal — der Scanner
 * holt selbst **nichts** aus dem Netz; ein Aufrufer (Job, Test, Benchmark)
 * reicht vorbereitete Serien herein.
 */
export interface ScanDataProvider {
  /** OHLCV-Kerzen des Instruments (aufsteigend nach `time`). */
  candles(instrument: MarketInstrument): readonly MarketCandle[];
  /** Benchmark-Kerzen für die Korrelation (optional). */
  benchmarkCandles?(instrument: MarketInstrument): readonly MarketCandle[] | null;
  /** Funding/Open Interest (optional). */
  derivatives?(instrument: MarketInstrument): DerivativeContext | null;
  /** Deterministische News-Zähler (optional). */
  news?(instrument: MarketInstrument): NewsRiskContext | null;
}

/** Optionen eines Scan-Laufs. */
export interface ScanOptions {
  /** Zu scannende Instrumente. */
  instruments: readonly MarketInstrument[];
  /** Datenanbindung; ohne sie laufen alle Serien-Faktoren auf „unbekannt“. */
  data?: ScanDataProvider;
  /** Auswertungszeitpunkt (injizierte Uhr). */
  asOf: number | Date | string;
  /** Konfiguration; Default: {@link loadScannerConfig}. */
  config?: ScannerConfig;
  /** Faktor-Cache; Default: frischer Cache je Lauf. */
  cache?: FactorCache;
  /**
   * Echte Fetch-/Infrastruktur-Fehler je Instrument-ID (aus MDERR-006). Wenn
   * gesetzt und nicht leer, ist der Readiness-Zustand `ERROR` und betroffene
   * Instrumente werden mit `data-unavailable` (nie `min-candles`) abgelehnt.
   * Rein optional — ohne Angabe wird nur zwischen `READY` und `WARMING`
   * unterschieden.
   */
  dataErrors?: ReadonlyMap<string, string>;
}

/** Kennzahlen eines Laufs (nicht Teil der Artefakte — Laufzeit ist nicht deterministisch). */
export interface ScanStats {
  /** Anzahl gescannter Instrumente. */
  scanned: number;
  /** Anzahl geeigneter Instrumente (nach Filter, vor Kappung). */
  passedFilters: number;
  /** Anzahl abgelehnter Instrumente. */
  rejected: number;
  /** Laufzeit in Millisekunden (nur Logging/Benchmark). */
  durationMs: number;
  /** Cache-Statistik. */
  cache: CacheStats;
}

/** Vollständiges Ergebnis eines Scans. */
export interface ScanResult {
  /** Auswertungszeitpunkt als ISO-8601-UTC. */
  asOf: string;
  /** Auswertungszeitpunkt in Millisekunden. */
  asOfMs: number;
  /** Verwendete Konfiguration (Version erscheint in jedem Artefakt). */
  config: ScannerConfig;
  /** Trichter-Ebenen. */
  funnel: FunnelResult;
  /**
   * Expliziter, deterministischer Readiness-Zustand (OPS-009), berechnet **vor**
   * der Funnel-Auswertung. Trennt Infrastruktur (`WARMING`/`ERROR`) von
   * Fachlogik. Der Funnel bleibt verhaltensgleich; die Readiness ist eine
   * zusätzliche, getrennte Information.
   */
  readiness: ScannerReadiness;
  /** Abgeleiteter Warmup-Bedarf des Faktorsatzes (Quelle der Warmup-Wahrheit). */
  requiredCandles: number;
  /** Alle bewerteten Instrumente, nach Score sortiert. */
  scores: InstrumentScore[];
  /** Index für den Einzelabruf `GET /api/universe/score/{instrumentId}`. */
  byId: Map<string, InstrumentScore>;
  /** Alle Ablehnungen der Eignungsfilter. */
  rejections: FilterRejection[];
  /** Ablehnungen je Regel-ID. */
  rejectionsByRule: Record<string, number>;
  /** Laufzeit-/Cache-Kennzahlen. */
  stats: ScanStats;
}

/** Wandelt die injizierte Uhr in Millisekunden (wirft bei Unsinn). */
export function toEpochMs(asOf: number | Date | string): number {
  const ms = asOf instanceof Date ? asOf.getTime() : typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(ms)) throw new Error("scanUniverse: asOf ist kein gültiger Zeitpunkt");
  return ms;
}

/**
 * Führt einen vollständigen Scan aus.
 *
 * @example
 * ```ts
 * const result = scanUniverse({
 *   instruments: registry.query({ pageSize: 500 }).items,
 *   data: { candles: (i) => store.candlesFor(i.id) },
 *   asOf: "2026-08-27T00:00:00.000Z",
 * });
 * result.funnel.daily.length; // ≤ 100
 * ```
 */
export function scanUniverse(options: ScanOptions): ScanResult {
  const started = performance.now();
  const config = options.config ?? loadScannerConfig();
  const asOfMs = toEpochMs(options.asOf);
  const instruments = options.instruments;
  if (instruments.length > MAX_SCAN_INSTRUMENTS) {
    throw new Error(`scanUniverse: max. ${MAX_SCAN_INSTRUMENTS} Instrumente je Lauf`);
  }
  const cache = options.cache ?? new FactorCache();
  const data = options.data;
  const requiredCandles = requiredWarmupCandles(config);

  const scores: InstrumentScore[] = [];
  const eligibleScores: InstrumentScore[] = [];
  const rejections: FilterRejection[] = [];
  const rejectionsByRule: Record<string, number> = {};
  const byId = new Map<string, InstrumentScore>();
  // Kerzenlänge je Instrument für die Readiness-Bewertung (kein zweiter Fetch).
  const historyByInstrument = new Map<string, readonly MarketCandle[]>();

  for (const instrument of instruments) {
    const candles = data?.candles(instrument) ?? [];
    historyByInstrument.set(instrument.id, candles);
    const input: FactorInput = {
      instrument,
      candles,
      benchmarkCandles: data?.benchmarkCandles?.(instrument) ?? null,
      derivatives: data?.derivatives?.(instrument) ?? null,
      news: data?.news?.(instrument) ?? null,
      asOf: asOfMs,
      config,
    };
    const factors = cache.getOrCompute(input, computeAllFactors);
    const regime = classifyRegime(factors.volatility.raw, config.regime);
    const score = scoreFromFactors(instrument, factors, config, asOfMs);

    scores.push(score);
    byId.set(score.instrumentId, score);

    // MDERR-006: Datenfehler → DATA_UNAVAILABLE (nie min-candles); die
    // Readiness wird unten über `dataErrors` zusätzlich auf ERROR gesetzt.
    const rejection = checkEligibility(
      {
        instrument,
        factors,
        candleCount: candles.length,
        regime,
        dataError: options.dataErrors?.get(instrument.id) ?? undefined,
      },
      config
    );
    if (rejection) {
      rejections.push(rejection);
      rejectionsByRule[rejection.ruleId] = (rejectionsByRule[rejection.ruleId] ?? 0) + 1;
    } else {
      eligibleScores.push(score);
    }
  }

  const funnel = buildFunnel(instruments.length, eligibleScores, config.funnel);

  const readiness = assessDataReadiness({
    instruments,
    historyByInstrument,
    requiredCandles,
    dataErrors: options.dataErrors,
  });

  return {
    asOf: new Date(asOfMs).toISOString(),
    asOfMs,
    config,
    funnel,
    readiness,
    requiredCandles,
    scores: rankByScore(scores),
    byId,
    rejections,
    rejectionsByRule,
    stats: {
      scanned: instruments.length,
      passedFilters: eligibleScores.length,
      rejected: rejections.length,
      durationMs: performance.now() - started,
      cache: cache.statistics,
    },
  };
}

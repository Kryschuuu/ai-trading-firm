/**
 * Contracts des deterministischen Markt-Scanners (Task 04).
 *
 * Der Scanner ist eine **rein deterministische, lesende Analyseschicht**:
 * kein LLM, kein Netzwerk, kein `Math.random`, keine versteckte Uhr.
 * Jede Zeitabhängigkeit kommt über {@link FactorInput.asOf} herein, jede
 * Konfiguration über {@link ScannerConfig}. Gleiche Eingabe ⇒ byte-identische
 * Scores, Rankings und Artefakte.
 *
 * Datenquellen (bereits im Repo vorhanden, siehe RECON in
 * `docs/task-04-IMPLEMENTATION_PLAN.md`):
 *   - {@link MarketInstrument} — Instrument-Registry (Task 01, `src/universe/`)
 *   - {@link MarketCandle} — Market-Data-Layer (Task 03, `src/lib/marketdata/`)
 *
 * @packageDocumentation
 */

import type { MarketCandle } from "@/lib/marketdata/types";
import type { AssetClass, MarketInstrument } from "@/universe/types";
import type { ScannerConfig } from "./config";

/** Stabile ID eines Faktors — erscheint in Breakdown, Cache-Key und Hilfe-JSON. */
export type FactorId =
  | "liquidity"
  | "spread"
  | "atr"
  | "volatility"
  | "momentum"
  | "trend"
  | "volumeRatio"
  | "rsi"
  | "drawdown"
  | "correlation"
  | "news"
  | "funding"
  | "openInterest"
  | "executionCost";

/** Alle Faktor-IDs in kanonischer Reihenfolge (Doku, Tests, Breakdown-Sortierung). */
export const FACTOR_IDS: readonly FactorId[] = [
  "liquidity",
  "spread",
  "atr",
  "volatility",
  "momentum",
  "trend",
  "volumeRatio",
  "rsi",
  "drawdown",
  "correlation",
  "news",
  "funding",
  "openInterest",
  "executionCost",
];

/** Die neun gewichteten Komponenten des Market Scores. */
export type ScoreComponent =
  | "liquidity"
  | "volatility"
  | "trend"
  | "momentum"
  | "spread"
  | "volume"
  | "correlation"
  | "news"
  | "execution";

/** Score-Komponenten in kanonischer Reihenfolge (= Reihenfolge im Breakdown). */
export const SCORE_COMPONENTS: readonly ScoreComponent[] = [
  "liquidity",
  "volatility",
  "trend",
  "momentum",
  "spread",
  "volume",
  "correlation",
  "news",
  "execution",
];

/** Abbildung Score-Komponente → Faktor, der sie speist. */
export const COMPONENT_FACTOR: Readonly<Record<ScoreComponent, FactorId>> = {
  liquidity: "liquidity",
  volatility: "volatility",
  trend: "trend",
  momentum: "momentum",
  spread: "spread",
  volume: "volumeRatio",
  correlation: "correlation",
  news: "news",
  execution: "executionCost",
};

/**
 * Derivate-Kontext eines Instruments (Funding / Open Interest).
 *
 * Wird von der Market-Data-Schicht bzw. dem Discovery-Lauf befüllt; fehlt er,
 * liefern die Faktoren `funding`/`openInterest` ihren dokumentierten
 * Neutralwert statt zu raten.
 */
export interface DerivativeContext {
  /** Funding-Rate je Intervall als Dezimalanteil (0.0001 = 1 bp). */
  fundingRate: number | null;
  /** Länge eines Funding-Intervalls in Stunden (typisch 8). */
  fundingIntervalHours: number | null;
  /** Offenes Interesse in Quote-Währung. */
  openInterest: number | null;
  /** Relative Änderung des offenen Interesses über 24 h (0.1 = +10 %). */
  openInterestChange24h: number | null;
}

/**
 * Deterministischer News-Kontext.
 *
 * **Bewusst keine LLM-Antwort**, sondern strukturierte Zähler eines Feeds
 * (Ereignisanzahl, High-Impact-Flags, geplantes Ereignis). Die inhaltliche
 * (LLM-)Bewertung passiert erst später auf der Top-Shortlist.
 */
export interface NewsRiskContext {
  /** Anzahl Meldungen zum Instrument/Underlying in den letzten 24 h. */
  events24h: number;
  /** Anzahl Meldungen in den letzten 7 Tagen. */
  events7d: number;
  /** Davon als „high impact“ markierte Meldungen (Feed-Kategorie, kein LLM). */
  highImpact24h: number;
  /** Stunden bis zu einem terminierten Ereignis (Earnings, Unlock); `null` = keins. */
  scheduledEventInHours: number | null;
}

/** Vollständige Eingabe für einen Faktor — alles injiziert, nichts implizit. */
export interface FactorInput {
  /** Instrument aus der Registry (Task 01). */
  instrument: MarketInstrument;
  /** OHLCV-Kerzen, aufsteigend nach `time` (Task 03). */
  candles: readonly MarketCandle[];
  /** Kerzen des Korrelations-Benchmarks (gleiches Raster), optional. */
  benchmarkCandles?: readonly MarketCandle[] | null;
  /** Funding / Open Interest, optional. */
  derivatives?: DerivativeContext | null;
  /** Deterministischer News-Kontext, optional. */
  news?: NewsRiskContext | null;
  /** Auswertungszeitpunkt (Unix-Epoch ms) — injizierte Uhr. */
  asOf: number;
  /** Versionierte Scanner-Konfiguration. */
  config: ScannerConfig;
}

/**
 * Ergebnis eines Faktors.
 *
 * `raw` ist der fachliche Rohwert (Einheit siehe Faktor-Katalog),
 * `normalized` ist immer auf `[0, 1]` skaliert und „größer = besser für den
 * Score“. Ist der Faktor nicht berechenbar (`available === false`), steht in
 * `normalized` der dokumentierte Neutralwert des Faktors — nie `NaN`.
 */
export interface FactorValue {
  /** Faktor, der den Wert erzeugt hat. */
  factorId: FactorId;
  /** Rohwert in fachlicher Einheit; `null` = unbekannt. */
  raw: number | null;
  /** Normierter Wert in `[0, 1]`, „größer = besser“. */
  normalized: number;
  /** false, wenn die Datenlage nicht reichte (Neutralwert wurde eingesetzt). */
  available: boolean;
  /** Kurze, deterministische Begründung (Transparenz, keine Secrets). */
  reason: string;
  /** Zusätzliche, deterministische Zwischenwerte für die Nachvollziehbarkeit. */
  detail: Readonly<Record<string, number | string | boolean | null>>;
}

/**
 * Gemeinsames Interface aller Faktor-Module.
 *
 * @example
 * ```ts
 * import { liquidityFactor } from "@/scanner/factors/liquidity";
 * const value = liquidityFactor.compute(input);
 * // value.normalized ∈ [0,1], value.raw = 24h-Volumen in Quote-Währung
 * ```
 */
export interface Factor {
  /** Stabile Faktor-ID. */
  readonly id: FactorId;
  /** Menschenlesbarer Name (Doku/UI). */
  readonly label: string;
  /** Neutralwert, wenn der Faktor nicht berechenbar ist. */
  readonly neutral: number;
  /** Berechnet den Faktor — pure Funktion, keine Seiteneffekte. */
  compute(input: FactorInput): FactorValue;
}

/** Volatilitäts-Regime auf Basis annualisierter realisierter Volatilität. */
export type VolatilityRegime = "LOW" | "NORMAL" | "HIGH" | "EXTREME";

/** Alle Regime-Werte in aufsteigender Intensität. */
export const VOLATILITY_REGIMES: readonly VolatilityRegime[] = ["LOW", "NORMAL", "HIGH", "EXTREME"];

/** Ein Eintrag des Score-Breakdowns: Faktor → Rohwert → normiert → Beitrag. */
export interface ScoreBreakdownEntry {
  /** Score-Komponente (gewichteter Block). */
  component: ScoreComponent;
  /** Faktor, der die Komponente speist. */
  factorId: FactorId;
  /** Rohwert des Faktors (fachliche Einheit). */
  raw: number | null;
  /** Normierter Wert `[0,1]`. */
  normalized: number;
  /** Gewicht der Komponente (Summe aller Gewichte = 1). */
  weight: number;
  /** Beitrag zum Score in Punkten: `weight × normalized × 100`. */
  contribution: number;
  /** War der Faktor berechenbar? */
  available: boolean;
  /** Begründung des Faktors. */
  reason: string;
}

/** Vollständiges Score-Ergebnis eines Instruments. */
export interface InstrumentScore {
  /** Kanonische Instrument-ID (`VENUE:SYMBOL`). */
  instrumentId: string;
  /** Anlageklasse (Diversifikationsregel im Trichter). */
  assetClass: AssetClass;
  /** Market Score in Punkten `[0, 100]` = Summe der Beiträge. */
  score: number;
  /** Volatilitäts-Regime des Instruments. */
  regime: VolatilityRegime;
  /** Beiträge je Score-Komponente in kanonischer Reihenfolge. */
  breakdown: ScoreBreakdownEntry[];
  /** Alle 14 Faktorwerte (auch die nicht gewichteten Diagnose-Faktoren). */
  factors: Readonly<Record<FactorId, FactorValue>>;
  /** Auswertungszeitpunkt als ISO-8601-UTC. */
  asOf: string;
}

/**
 * Eignungsfilter der Trichter-Ebene 2 („geeignet“).
 *
 * Die Regeln laufen in **fester Reihenfolge**; die erste greifende Regel
 * entscheidet und liefert eine stabile Regel-ID plus Begründung. Damit ist
 * jede Ablehnung nachvollziehbar und in Tests festnagelbar.
 *
 * Grundsatz aus Task 01: **`null` heißt „unbekannt“, nicht „gut“.** Unbekanntes
 * Volumen oder unbekannter Spread führen zur Ablehnung, nicht zu einer
 * optimistischen Annahme.
 */

import type { ScannerConfig } from "./config";
import type { FactorId, FactorValue, VolatilityRegime } from "./types";
import type { MarketInstrument } from "@/universe/types";
import { isMarketDataErrorReason } from "@/lib/marketDataErrors";
import { minCandlesRejectionMessage, requiredWarmupCandles } from "./warmup";

/** Stabile IDs aller Filterregeln in Auswertungsreihenfolge. */
export const FILTER_RULE_IDS = [
  "status-active",
  "paper-available",
  "market-type",
  "asset-class",
  "data-unavailable",
  "min-candles",
  "min-volume",
  "max-spread",
  "max-execution-cost",
  "max-drawdown",
  "regime-extreme",
] as const;

/** Typ einer Filterregel-ID. */
export type FilterRuleId = (typeof FILTER_RULE_IDS)[number];

/** Ergebnis einer Ablehnung. */
export interface FilterRejection {
  /** Instrument, das abgelehnt wurde. */
  instrumentId: string;
  /** Greifende Regel. */
  ruleId: FilterRuleId;
  /** Begründung ohne Secrets/Rohdaten. */
  message: string;
  /**
   * `true` ⇒ **Data-Quality-Rejection**: Das Instrument scheitert, weil eine
   * Marktdaten-Metrik nicht geladen wurde (keine Kerzenhistorie, kein Ticker,
   * kein Orderbook-Snapshot) — nicht, weil der Markt fachlich unattraktiv wäre.
   *
   * Betriebsbedeutung: Solche Ablehnungen sind mit einem Warmup-Lauf
   * (`npm run market-sync` → `MarketDataSyncService.syncVenue`) behebbar und
   * dürfen nicht als dauerhaftes „Instrument ungeeignet“ interpretiert werden.
   * `false` ⇒ fachliche Ablehnung (Status, Markttyp, Volumen zu klein,
   * Spread zu breit, Kosten zu hoch, Drawdown, Extrem-Regime).
   */
  dataQuality: boolean;
}

/** Eingabe der Filterprüfung (bereits berechnete Faktoren). */
export interface FilterCandidate {
  /** Instrument aus der Registry. */
  instrument: MarketInstrument;
  /** Faktorwerte des Instruments. */
  factors: Record<FactorId, FactorValue>;
  /** Anzahl vorliegender Kerzen. */
  candleCount: number;
  /** Volatilitäts-Regime. */
  regime: VolatilityRegime;
  /**
   * Echter Fetch-/Infrastruktur-Fehler (MDERR-006), z. B. `RATE_LIMITED`.
   * Wenn gesetzt, greift `data-unavailable` — niemals `min-candles`: ein
   * Abruf-Fehler ist kein „keine Historie vorhanden“.
   */
  dataError?: string;
}

/** Nur die stabile Ursachen-Taxonomie in die Rejection-Message (sonst UNKNOWN). */
function safeReasonLabel(value: string): string {
  return isMarketDataErrorReason(value) ? value : "UNKNOWN";
}

function raw(value: FactorValue): number | null {
  return value.available ? value.raw : null;
}

/**
 * Prüft ein Instrument gegen alle Eignungsregeln.
 *
 * **Warmup-Schwelle (OPS-009):** Der `min-candles`-Schwellwert wird **nicht**
 * hartcodiert, sondern aus dem Faktorsatz abgeleitet
 * (`requiredWarmupCandles(config)`). Ein explizit gesetzter
 * `config.filters.minCandles` hat Vorrang; ohne ihn gilt der abgeleitete
 * Warmup-Bedarf (Default 61). So passieren Instrumente den Filter erst, wenn
 * **alle** Faktoren vollständig (ohne Padding) berechnet werden können. Die
 * Ablehnungs-Message nennt die Herkunft des Schwellwerts (Momentum-Lookback +
 * EMA), damit ein Betreiber Datenverfügbarkeit von Marktqualität unterscheiden
 * kann.
 *
 * **Data-Quality- vs. Fachablehnung (FEHLER-3, Review-Punkt 5):** Fehlt eine
 * Metrik (`candleCount < minCandles`, `volume24h`/`spread` unbekannt), ist das
 * eine **Data-Quality-Rejection** — die Daten wurden nicht geladen, nicht der
 * Markt für unattraktiv befunden. Diese Fälle tragen `dataQuality: true` und
 * eine Meldung, die das explizit sagt („… wurde nicht geladen“), statt eines
 * generischen „Instrument ungeeignet“. Grund: Der Liquiditätsfaktor besitzt
 * einen Kerzen-Fallback (`volume24h ?? letzte Kerze volume × close`), der
 * Spread-Faktor aber **nicht** — ohne Orderbook-Enrichment
 * (`MarketDataSyncService` → `getOrderBook` → `calculateRelativeSpread`)
 * scheitern deshalb selbst kerzengesättigte Instrumente an `max-spread`.
 * Datenfluss: `docs/MARKET_DATA_PIPELINE.md` §2–§3.
 *
 * @param candidate Instrument samt Faktoren, Kerzenzahl und Regime.
 * @param config Vollständige Scanner-Konfiguration (für Filterregeln **und**
 *   den abgeleiteten Warmup-Bedarf).
 * @returns `null`, wenn das Instrument geeignet ist, sonst die Ablehnung.
 */
export function checkEligibility(candidate: FilterCandidate, config: ScannerConfig): FilterRejection | null {
  const { instrument, factors, candleCount, regime, dataError } = candidate;
  const filters = config.filters;
  const reject = (ruleId: FilterRuleId, message: string, dataQuality = false): FilterRejection => ({
    instrumentId: instrument.id,
    ruleId,
    message,
    dataQuality,
  });

  // MDERR-006: Ein echter Abruf-Fehler wird NIE als `min-candles` gemeldet.
  // DATA_UNAVAILABLE ist ein Infrastrukturzustand (Readiness → ERROR) und
  // behebbar — keine Aussage über „0 Kerzen vorhanden“ oder Marktqualität.
  if (dataError) {
    return reject(
      "data-unavailable",
      `DATA_UNAVAILABLE: Marktdaten-Abruf fehlgeschlagen (${safeReasonLabel(dataError)}) — ` +
        `Infrastrukturfehler, KEIN Marktausschluss und KEINE fehlende Historie. Venue/Netz prüfen.`,
      true,
    );
  }

  if (filters.requireStatusActive && instrument.status !== "active") {
    return reject("status-active", `Status ${instrument.status} ist nicht handelbar`);
  }
  if (filters.requirePaperAvailable && !instrument.paperAvailable) {
    return reject("paper-available", "im Paper-Modus nicht handelbar");
  }
  if (!filters.allowedMarketTypes.includes(instrument.marketType)) {
    return reject("market-type", `Markttyp ${instrument.marketType} ist nicht freigegeben`);
  }
  if (!filters.allowedAssetClasses.includes(instrument.assetClass)) {
    return reject("asset-class", `Anlageklasse ${instrument.assetClass} ist nicht freigegeben`);
  }
  // Abgeleiteter Warmup-Bedarf ist die Quelle der Wahrheit; ein explizit
  // gesetzter `minCandles` überschreibt ihn (die Config-Validierung warnt, wenn
  // dieser kleiner als der abgeleitete Bedarf ist).
  const requiredCandles = filters.minCandles ?? requiredWarmupCandles(config);
  if (candleCount < requiredCandles) {
    return reject("min-candles", minCandlesRejectionMessage(candleCount, config), true);
  }

  const volume = raw(factors.liquidity);
  // Data-Quality: weder `volume24h` (Ticker-Enrichment) noch der Kerzen-Fallback
  // (`letzte Kerze volume × close`) lieferte ein Volumen.
  if (volume === null) {
    return reject("min-volume", "24h-Volumen wurde nicht geladen (kein Ticker, keine Kerze)", true);
  }
  if (volume < filters.minVolume24h) {
    return reject("min-volume", `24h-Volumen ${volume.toFixed(0)} < ${filters.minVolume24h}`);
  }

  const spread = raw(factors.spread);
  // Data-Quality: `spread === null` heißt „Orderbook nicht geladen“ und NICHT
  // „Spread = 0“. Der Spread-Faktor hat (anders als `liquidity`) keinen
  // Kerzen-Fallback — ohne `/depth`-Enrichment im Sync scheitert jedes
  // Instrument hier. Kein 0-Mapping, keine optimistische Annahme.
  if (spread === null) {
    return reject("max-spread", "Spread wurde nicht geladen (kein Orderbook-Snapshot) — Warmup nötig", true);
  }
  if (spread > filters.maxSpread) {
    return reject("max-spread", `Spread ${(spread * 10_000).toFixed(2)} bp > ${(filters.maxSpread * 10_000).toFixed(2)} bp`);
  }

  const cost = raw(factors.executionCost);
  // Folgt dem Spread: ohne Spread sind die Roundturn-Kosten nicht bezifferbar.
  if (cost === null) {
    return reject("max-execution-cost", "Handelskosten nicht bezifferbar — Spread wurde nicht geladen", true);
  }
  if (cost > filters.maxExecutionCost) {
    return reject(
      "max-execution-cost",
      `Roundturn-Kosten ${(cost * 10_000).toFixed(2)} bp > ${(filters.maxExecutionCost * 10_000).toFixed(2)} bp`
    );
  }

  const drawdown = raw(factors.drawdown);
  if (drawdown !== null && drawdown > filters.maxDrawdown) {
    return reject("max-drawdown", `Drawdown ${(drawdown * 100).toFixed(1)} % > ${(filters.maxDrawdown * 100).toFixed(1)} %`);
  }

  if (filters.excludeExtremeRegime && regime === "EXTREME") {
    return reject("regime-extreme", "Volatilitäts-Regime EXTREME");
  }

  return null;
}

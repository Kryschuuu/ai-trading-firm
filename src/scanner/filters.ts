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

import type { FilterConfig } from "./config";
import type { FactorId, FactorValue, VolatilityRegime } from "./types";
import type { MarketInstrument } from "@/universe/types";

/** Stabile IDs aller Filterregeln in Auswertungsreihenfolge. */
export const FILTER_RULE_IDS = [
  "status-active",
  "paper-available",
  "market-type",
  "asset-class",
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
}

function raw(value: FactorValue): number | null {
  return value.available ? value.raw : null;
}

/**
 * Prüft ein Instrument gegen alle Eignungsregeln.
 *
 * @returns `null`, wenn das Instrument geeignet ist, sonst die Ablehnung.
 */
export function checkEligibility(candidate: FilterCandidate, config: FilterConfig): FilterRejection | null {
  const { instrument, factors, candleCount, regime } = candidate;
  const reject = (ruleId: FilterRuleId, message: string): FilterRejection => ({
    instrumentId: instrument.id,
    ruleId,
    message,
  });

  if (config.requireStatusActive && instrument.status !== "active") {
    return reject("status-active", `Status ${instrument.status} ist nicht handelbar`);
  }
  if (config.requirePaperAvailable && !instrument.paperAvailable) {
    return reject("paper-available", "im Paper-Modus nicht handelbar");
  }
  if (!config.allowedMarketTypes.includes(instrument.marketType)) {
    return reject("market-type", `Markttyp ${instrument.marketType} ist nicht freigegeben`);
  }
  if (!config.allowedAssetClasses.includes(instrument.assetClass)) {
    return reject("asset-class", `Anlageklasse ${instrument.assetClass} ist nicht freigegeben`);
  }
  if (candleCount < config.minCandles) {
    return reject("min-candles", `zu wenig Historie (${candleCount} < ${config.minCandles} Kerzen)`);
  }

  const volume = raw(factors.liquidity);
  if (volume === null) return reject("min-volume", "24h-Volumen unbekannt");
  if (volume < config.minVolume24h) {
    return reject("min-volume", `24h-Volumen ${volume.toFixed(0)} < ${config.minVolume24h}`);
  }

  const spread = raw(factors.spread);
  if (spread === null) return reject("max-spread", "Spread unbekannt");
  if (spread > config.maxSpread) {
    return reject("max-spread", `Spread ${(spread * 10_000).toFixed(2)} bp > ${(config.maxSpread * 10_000).toFixed(2)} bp`);
  }

  const cost = raw(factors.executionCost);
  if (cost === null) return reject("max-execution-cost", "Handelskosten unbekannt");
  if (cost > config.maxExecutionCost) {
    return reject(
      "max-execution-cost",
      `Roundturn-Kosten ${(cost * 10_000).toFixed(2)} bp > ${(config.maxExecutionCost * 10_000).toFixed(2)} bp`
    );
  }

  const drawdown = raw(factors.drawdown);
  if (drawdown !== null && drawdown > config.maxDrawdown) {
    return reject("max-drawdown", `Drawdown ${(drawdown * 100).toFixed(1)} % > ${(config.maxDrawdown * 100).toFixed(1)} %`);
  }

  if (config.excludeExtremeRegime && regime === "EXTREME") {
    return reject("regime-extreme", "Volatilitäts-Regime EXTREME");
  }

  return null;
}

/**
 * Registry aller Faktor-Module.
 *
 * Ein Faktor = eine Datei = ein Export. Diese Datei ist die einzige Stelle, an
 * der die 14 Faktoren zusammengeführt werden; Ranker, Pipeline, Tests und
 * Dokumentation lesen ausschließlich von hier.
 */
import { FACTOR_IDS, type Factor, type FactorId, type FactorInput, type FactorValue } from "../types";
import { liquidityFactor } from "./liquidity";
import { spreadFactor } from "./spread";
import { atrFactor } from "./atr";
import { volatilityFactor } from "./volatility";
import { momentumFactor } from "./momentum";
import { trendFactor } from "./trend";
import { volumeRatioFactor } from "./volumeRatio";
import { rsiFactor } from "./rsi";
import { drawdownFactor } from "./drawdown";
import { correlationFactor } from "./correlation";
import { newsFactor } from "./news";
import { fundingFactor } from "./funding";
import { openInterestFactor } from "./openInterest";
import { executionCostFactor } from "./executionCost";

export * from "./helpers";
export { liquidityFactor } from "./liquidity";
export { spreadFactor } from "./spread";
export { atrFactor } from "./atr";
export { volatilityFactor } from "./volatility";
export { momentumFactor } from "./momentum";
export { trendFactor } from "./trend";
export { volumeRatioFactor } from "./volumeRatio";
export { rsiFactor, computeRsi } from "./rsi";
export { drawdownFactor } from "./drawdown";
export { correlationFactor, pearson, spearman, ranks, alignByTime } from "./correlation";
export { newsFactor } from "./news";
export { fundingFactor } from "./funding";
export { openInterestFactor } from "./openInterest";
export { executionCostFactor } from "./executionCost";

/** Alle Faktoren, indiziert über ihre ID. */
export const FACTORS: Readonly<Record<FactorId, Factor>> = Object.freeze({
  liquidity: liquidityFactor,
  spread: spreadFactor,
  atr: atrFactor,
  volatility: volatilityFactor,
  momentum: momentumFactor,
  trend: trendFactor,
  volumeRatio: volumeRatioFactor,
  rsi: rsiFactor,
  drawdown: drawdownFactor,
  correlation: correlationFactor,
  news: newsFactor,
  funding: fundingFactor,
  openInterest: openInterestFactor,
  executionCost: executionCostFactor,
});

/** Alle Faktoren in kanonischer Reihenfolge. */
export const FACTOR_LIST: readonly Factor[] = FACTOR_IDS.map((id) => FACTORS[id]);

/**
 * Berechnet alle 14 Faktoren für eine Eingabe.
 * Reihenfolge und Rundung sind fix ⇒ byte-identische Ergebnisse.
 */
export function computeAllFactors(input: FactorInput): Record<FactorId, FactorValue> {
  const out = {} as Record<FactorId, FactorValue>;
  for (const id of FACTOR_IDS) out[id] = FACTORS[id].compute(input);
  return out;
}

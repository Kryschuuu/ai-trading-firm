/**
 * Market Ranker (Task 04) — gewichteter Market Score mit vollständigem
 * Breakdown.
 *
 * ```text
 * score = Σ_Komponenten  gewicht × normierter Faktorwert × 100
 * ```
 *
 * Gewichte (Konfigurationsversion 1, Summe **exakt** 100 %):
 * Liquidity 25 · Volatility 15 · Trend 15 · Momentum 10 · Spread 10 ·
 * Volume 10 · Correlation 5 · News 5 · Execution 5.
 *
 * Der Breakdown enthält je Komponente Rohwert, normierten Wert, Gewicht und
 * Beitrag; die Summe der Beiträge ist per Konstruktion der Score
 * (Test `Breakdown-Summe == Score`).
 */

import type { MarketInstrument } from "@/universe/types";
import { WEIGHT_SUM_TOLERANCE, type ScannerConfig, type ScoreWeights } from "./config";
import { roundTo } from "./math";
import { classifyRegime } from "./regime";
import { computeAllFactors } from "./factors";
import {
  COMPONENT_FACTOR,
  SCORE_COMPONENTS,
  type FactorId,
  type FactorInput,
  type FactorValue,
  type InstrumentScore,
  type ScoreBreakdownEntry,
} from "./types";

/**
 * Prüft, dass die Gewichte exakt 1 (= 100 %) ergeben.
 * @throws {Error} wenn die Summe außerhalb der Toleranz liegt.
 */
export function assertWeightsSumToOne(weights: ScoreWeights): number {
  const sum = SCORE_COMPONENTS.reduce((acc, c) => acc + weights[c], 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(`Score-Gewichte summieren nicht auf 100 % (Summe = ${sum})`);
  }
  return sum;
}

/**
 * Baut Score + Breakdown aus bereits berechneten Faktorwerten.
 * Getrennt von {@link scoreInstrument}, damit der Faktor-Cache greifen kann.
 */
export function scoreFromFactors(
  instrument: MarketInstrument,
  factors: Record<FactorId, FactorValue>,
  config: ScannerConfig,
  asOf: number
): InstrumentScore {
  assertWeightsSumToOne(config.weights);

  const breakdown: ScoreBreakdownEntry[] = [];
  let total = 0;
  for (const component of SCORE_COMPONENTS) {
    const factorId = COMPONENT_FACTOR[component];
    const value = factors[factorId];
    const weight = config.weights[component];
    const contribution = roundTo(weight * value.normalized * 100);
    total += contribution;
    breakdown.push({
      component,
      factorId,
      raw: value.raw,
      normalized: value.normalized,
      weight,
      contribution,
      available: value.available,
      reason: value.reason,
    });
  }

  return {
    instrumentId: instrument.id,
    assetClass: instrument.assetClass,
    score: roundTo(total),
    regime: classifyRegime(factors.volatility.raw, config.regime),
    breakdown,
    factors,
    asOf: new Date(asOf).toISOString(),
  };
}

/** Berechnet alle Faktoren und daraus Score + Breakdown eines Instruments. */
export function scoreInstrument(input: FactorInput): InstrumentScore {
  return scoreFromFactors(input.instrument, computeAllFactors(input), input.config, input.asOf);
}

/**
 * Stabile Rangfolge: Score absteigend, bei Gleichstand `instrumentId`
 * aufsteigend — damit ist das Ranking reproduzierbar, auch wenn zwei
 * Instrumente denselben Score erreichen.
 */
export function compareByScore(a: InstrumentScore, b: InstrumentScore): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
}

/** Sortiert eine Liste nach {@link compareByScore} (Kopie, keine Mutation). */
export function rankByScore(scores: readonly InstrumentScore[]): InstrumentScore[] {
  return [...scores].sort(compareByScore);
}

/**
 * Der Trichter (Task 04).
 *
 * ```text
 * gescannt (alle Instrumente der Registry)
 *   └─ Ebene 2 „geeignet“      Liquidity-/Tradability-/Risk-Filter, max. 2.000
 *       └─ Ebene 3 „interessant“  Market Score ≥ Schwelle,          max.   500
 *           └─ Ebene 4 „Daily Rotation“ Top-N nach Score,           max.   100
 *               └─ Deep-Analyse       Top-N + Diversifikation,      20 – 40
 * ```
 *
 * Alle Größen und Schwellen kommen aus {@link FunnelConfig}; die Reihenfolge
 * ist fix (erst filtern, dann kappen, dann bewerten, dann diversifizieren).
 * Sortierung überall: Score absteigend, `instrumentId` als Tiebreaker.
 */

import type { FunnelConfig } from "./config";
import { rankByScore } from "./ranker";
import type { InstrumentScore } from "./types";

/** Ein Trichter-Ergebnis mit allen Ebenen. */
export interface FunnelResult {
  /** Anzahl gescannter Instrumente. */
  scanned: number;
  /** Ebene 2 — geeignet (gefiltert, gekappt, nach Score sortiert). */
  eligible: InstrumentScore[];
  /** Ebene 3 — interessant (Score-Schwelle). */
  interesting: InstrumentScore[];
  /** Ebene 4 — Daily Rotation. */
  daily: InstrumentScore[];
  /** Deep-Analyse-Kandidaten (diversifiziert). */
  deep: InstrumentScore[];
  /** Wie viele Instrumente rein durch Kappungsgrenzen verloren gingen. */
  droppedByCap: { eligible: number; interesting: number; daily: number };
  /** Wurde die Diversifikationsgrenze gelockert, um `deepMin` zu erreichen? */
  diversificationRelaxed: boolean;
  /** Belegung der Deep-Liste je Anlageklasse. */
  deepPerAssetClass: Record<string, number>;
}

/**
 * Wählt aus einer nach Score sortierten Liste bis zu `limit` Instrumente,
 * höchstens `maxPerClass` je Anlageklasse.
 */
export function selectDiversified(
  ranked: readonly InstrumentScore[],
  limit: number,
  maxPerClass: number
): InstrumentScore[] {
  const counts = new Map<string, number>();
  const picked: InstrumentScore[] = [];
  for (const item of ranked) {
    if (picked.length >= limit) break;
    const used = counts.get(item.assetClass) ?? 0;
    if (used >= maxPerClass) continue;
    counts.set(item.assetClass, used + 1);
    picked.push(item);
  }
  return picked;
}

/**
 * Baut den vollständigen Trichter.
 *
 * Die Deep-Liste erfüllt die Diversifikationsregel „max. `maxPerAssetClass`
 * Instrumente je Anlageklasse“. Reicht das nicht für `deepMin`, wird die
 * Grenze **schrittweise um 1 gelockert** (dokumentiertes Verhalten, im
 * Ergebnis über `diversificationRelaxed` sichtbar) — lieber eine
 * nachvollziehbar gelockerte Regel als eine zu kurze Shortlist.
 */
export function buildFunnel(
  scanned: number,
  eligibleScores: readonly InstrumentScore[],
  config: FunnelConfig
): FunnelResult {
  const ranked = rankByScore(eligibleScores);
  const eligible = ranked.slice(0, config.eligibleMax);

  const aboveThreshold = eligible.filter((s) => s.score >= config.interestingMinScore);
  const interesting = aboveThreshold.slice(0, config.interestingMax);

  const daily = interesting.slice(0, config.dailyMax);

  let maxPerClass = config.maxPerAssetClass;
  let deep = selectDiversified(daily, config.deepMax, maxPerClass);
  let relaxed = false;
  while (deep.length < Math.min(config.deepMin, daily.length) && maxPerClass < daily.length) {
    maxPerClass += 1;
    relaxed = true;
    deep = selectDiversified(daily, config.deepMax, maxPerClass);
  }

  const deepPerAssetClass: Record<string, number> = {};
  for (const item of deep) {
    deepPerAssetClass[item.assetClass] = (deepPerAssetClass[item.assetClass] ?? 0) + 1;
  }

  return {
    scanned,
    eligible,
    interesting,
    daily,
    deep,
    droppedByCap: {
      eligible: Math.max(0, ranked.length - eligible.length),
      interesting: Math.max(0, aboveThreshold.length - interesting.length),
      daily: Math.max(0, interesting.length - daily.length),
    },
    diversificationRelaxed: relaxed,
    deepPerAssetClass,
  };
}

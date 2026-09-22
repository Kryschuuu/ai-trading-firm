/**
 * Cross-Section-Transformation (RMA-P2-04) — pure Funktionen, keine I/O.
 *
 * Der Querschnitt wird IMMER über die **nach Instrument-ID sortierte**
 * Mitglieder-Menge berechnet (kanonische Gleitkomma-Reihenfolge ⇒
 * Permutationsinvarianz der Ergebnisse).
 *
 * ── Formeln (je Horizont h, über die verfügbaren Werte des Universums) ─────
 *   x_i       = gewählter Rohwert (valueMode: `total` | `volAdjusted`)
 *   x̃_i       = winsorized x_i:  clip(x_i, q(winsorLower), q(winsorUpper))
 *                (Quantil „Type 7" über die ID-sorted Menge aller x_j des
 *                 Horizonts — nur über die Werte, die bei j berechenbar sind)
 *   μ_h, σ_h  = Mittelwert / Populations-σ über die x̃_j (ID-sorted)
 *   z_i       = (x̃_i − μ_h) / σ_h        (σ_h < minZStd ⇒ degeneriert)
 *
 *   composite_i = Σ_{h verfügbar} w_h · z_{i,h} / Σ_{h verfügbar} w_h
 *
 * Ein Horizont ist „verfügbar" für Instrument i, wenn `x_i` endlich ist;
 * ein degenerierter Horizont (σ < minZStd) fällt für ALLE Instrumente aus —
 * die Gewichte renormalisieren über die verbliebenen Horizonte.
 *
 *   Rang       = Position in (composite desc, instrumentId asc) — 1 = beste
 *   Perzentil  = (n − rank + 1) / n   (Rang 1 ⇒ 1.0; Anteil des Universums
 *                mit gleichem oder schlechterem Rang)
 *
 * Tie-Break: kanonische Instrument-ID — die Rangfolge ist unabhängig von
 * der Eingabe-Reihenfolge (Testpflichtpunkt).
 */

import type { CrossSectionalConfig, UniverseMember } from "./types";
import { byInstrumentId, isFiniteNumber, quantileSorted, stdDev, mean } from "./math";

/** Ein zu rankendes Mitglied mit berechneten Horizons (vor Querschnitt). */
export interface RankableRow {
  instrumentId: string;
  /** Rohwerte je Horizont-ID; `null` = nicht berechenbar (fail-closed). */
  raw: Readonly<Record<string, number | null>>;
}

/** Ergebnis der Querschnitts-Transformation (ID-sorted). */
export interface CrossSectionResult {
  /** Je Mitglied: winsorisierte Werte + z-Scores (beide `null`-fähig). */
  transformed: Map<string, { winsorized: Record<string, number | null>; z: Record<string, number | null> }>;
  /** Composite je Mitglied (`null` = nicht rankbar). */
  composite: Map<string, number | null>;
  /**
   * Nicht rankbare Mitglieder + Grund (`INSUFFICIENT_HORIZON_COVERAGE` oder
   * `CROSS_SECTION_DEGENERATE`).
   */
  unrankable: Map<string, string>;
}

/**
 * Führt die Querschnitts-Transformation über das Universum aus (Formeln im
 * Modulkopf). Rein und deterministisch — gleiche Mitgliederwerte ⇒
 * byte-identisches Ergebnis.
 */
export function transformCrossSection(
  rows: readonly RankableRow[],
  config: CrossSectionalConfig,
): CrossSectionResult {
  const horizons = config.horizons;
  const sorted = byInstrumentId(rows);
  const transformed = new Map<string, { winsorized: Record<string, number | null>; z: Record<string, number | null> }>();
  const composite = new Map<string, number | null>();
  const unrankable = new Map<string, string>();

  // Explizite NULL-Initialisierung über ALLE Horizonte: ein fehlender Wert
  // ist „nicht berechenbar" (fail-closed) — nie ein fehlender Key, der in
  // Nachschauen als `undefined` durchgehen könnte (`undefined !== null`).
  const nulls = (): Record<string, number | null> =>
    Object.fromEntries(horizons.map((h) => [h.id, null]));
  for (const row of sorted) {
    transformed.set(row.instrumentId, {
      winsorized: { ...nulls() },
      z: { ...nulls() },
    });
  }

  // Degenerierte Horizonte (σ < minZStd über das Universum) vorab bestimmen.
  const horizonValues = new Map<string, { values: number[]; idx: number[] }>();
  for (const h of horizons) {
    const values: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i].raw[h.id];
      if (v !== null && isFiniteNumber(v)) {
        values.push(v);
        idx.push(i);
      }
    }
    horizonValues.set(h.id, { values, idx });
  }

  const activeHorizons: typeof horizons = [];
  for (const h of horizons) {
    const { values } = horizonValues.get(h.id)!;
    if (values.length === 0) continue;
    const sigma = stdDev(values);
    if (sigma !== null && sigma >= config.minZStd) activeHorizons.push(h);
    // σ < minZStd ⇒ degeneriert: Horizon fällt für alle aus (nie 0-Substitution).
  }
  const activeWeightSum = activeHorizons.reduce((acc, h) => acc + h.weight, 0);

  // Je aktivem Horizont: Quantil-Grenzen, Winsorize, z-Scores (ID-sorted).
  const zByHorizon = new Map<string, (number | null)[]>();
  for (const h of activeHorizons) {
    const { values, idx } = horizonValues.get(h.id)!;
    // Quantil-Grenzen über die ID-sorted Werte (idx ist in ID-Reihenfolge).
    const sortedValues = values.slice().sort((a, b) => a - b);
    const lo = quantileSorted(sortedValues, config.winsorLower) as number;
    const hi = quantileSorted(sortedValues, config.winsorUpper) as number;
    const winsorized = values.map((v) => (v < lo ? lo : v > hi ? hi : v));
    const mu = mean(winsorized);
    const sigma = stdDev(winsorized);
    const zValues: (number | null)[] = new Array<number | null>(values.length).fill(null);
    if (mu !== null && sigma !== null && sigma >= config.minZStd) {
      for (let i = 0; i < winsorized.length; i++) zValues[i] = (winsorized[i] - mu) / sigma;
    }
    for (let i = 0; i < idx.length; i++) {
      const t = transformed.get(sorted[idx[i]].instrumentId)!;
      t.winsorized[h.id] = winsorized[i];
      t.z[h.id] = zValues[i];
    }
    zByHorizon.set(h.id, zValues);
  }

  // Composite je Mitglied über die aktiven Horizonte.
  let degenerateUniverse = activeWeightSum <= 0;
  for (const row of sorted) {
    const t = transformed.get(row.instrumentId)!;
    const available = activeHorizons.filter((h) => t.z[h.id] !== null);
    const coverage = horizons.length > 0 ? available.length / horizons.length : 0;
    if (degenerateUniverse) {
      unrankable.set(row.instrumentId, "CROSS_SECTION_DEGENERATE");
      composite.set(row.instrumentId, null);
      continue;
    }
    if (available.length === 0) {
      unrankable.set(row.instrumentId, "INSUFFICIENT_HORIZON_COVERAGE");
      composite.set(row.instrumentId, null);
      continue;
    }
    if (available.length / horizons.length < config.minHorizonCoverage) {
      unrankable.set(row.instrumentId, "INSUFFICIENT_HORIZON_COVERAGE");
      composite.set(row.instrumentId, null);
      continue;
    }
    let acc = 0;
    let wsum = 0;
    for (const h of available) {
      acc += h.weight * (t.z[h.id] as number);
      wsum += h.weight;
    }
    const c = wsum > 0 ? acc / wsum : null;
    composite.set(row.instrumentId, c);
    if (c === null) unrankable.set(row.instrumentId, "CROSS_SECTION_DEGENERATE");
  }

  return { transformed, composite, unrankable };
}

/** Ein geranktes Mitglied (vor Persistenz-Form). */
export interface RankedRow {
  instrumentId: string;
  rank: number;
  percentile: number;
  composite: number;
}

/**
 * Bildet Rang + Perzentil aus den Composites: Sortierung
 * (composite desc, instrumentId asc) — der stabile Tie-Break. `null`-Composites
 * werden ignoriert (die Mitglieder sind bereits als unrankable markiert).
 */
export function assignRanks(composite: ReadonlyMap<string, number | null>): RankedRow[] {
  const ranked = [...composite.entries()]
    .filter(([, c]) => c !== null && isFiniteNumber(c as number))
    .map(([id, c]) => ({ instrumentId: id, composite: c as number }))
    .sort((a, b) => (b.composite - a.composite) || (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
  const n = ranked.length;
  return ranked.map((r, i) => ({
    instrumentId: r.instrumentId,
    rank: i + 1,
    percentile: n > 0 ? (n - (i + 1) + 1) / n : 0,
    composite: r.composite,
  }));
}

/**
 * Wendet die Querschnittsergebnisse auf die Mitglieder an: RANKED-Mitglieder
 * erhalten Rang/Perzentil/Composite, unrankable bleiben EXCLUDED mit Grund.
 * Rückgabe ist ID-sorted (Persistenz-/Artefakt-Form). `winsorized`/`zScores`
 * tragen immer ALLE Config-Horizon-Keys — nicht berechenbar ist explizit
 * `null` (fail-closed, keine implizite 0).
 */
export function applyRanking(
  members: readonly UniverseMember[],
  result: CrossSectionResult,
  horizonIds: readonly string[],
): UniverseMember[] {
  const ranks = assignRanks(result.composite);
  const rankById = new Map(ranks.map((r) => [r.instrumentId, r]));
  const fullNulls = (): Record<string, number | null> =>
    Object.fromEntries(horizonIds.map((id) => [id, null]));
  return byInstrumentId(
    members.map((m) => {
      const r = rankById.get(m.instrumentId);
      const t = result.transformed.get(m.instrumentId) ?? { winsorized: {}, z: {} };
      const winsorized = { ...fullNulls(), ...t.winsorized };
      const z = { ...fullNulls(), ...t.z };
      if (r) {
        return {
          ...m,
          status: "RANKED" as const,
          rank: r.rank,
          percentile: r.percentile,
          composite: r.composite,
          winsorized,
          zScores: z,
          exclusionReason: null,
        };
      }
      const reason = result.unrankable.get(m.instrumentId) ?? "CROSS_SECTION_DEGENERATE";
      return {
        ...m,
        status: "EXCLUDED" as const,
        rank: null,
        percentile: null,
        composite: null,
        winsorized,
        zScores: z,
        exclusionReason: reason as UniverseMember["exclusionReason"],
      };
    }),
  );
}

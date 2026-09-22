/**
 * Universe-Snapshot-Eligibility (RMA-P2-04) — pure Funktion, keine I/O.
 *
 * Die Membership eines Snapshots entsteht hier: aus der Kandidatenpopulation
 * (typischerweise der aktuellen Registry) und den cutoff-sichtbaren Kerzen
 * wird je Instrument EINE der beiden Entscheidungen getroffen:
 *
 *   - `RANKED`-Kandidat: Instrument besteht die Eligibility und geht in die
 *     Querschnitts-Berechnung ein;
 *   - `EXCLUDED` + geschlossener Grund: die Datenlage/Status erlaubt keinen
 *     Rang (fail-closed — das Instrument verschwindet nicht still, es wird
 *     mit Grund im Snapshot ausgewiesen).
 *
 * Die Prüfungsreihenfolge (erster Treffer gewinnt) ist Teil des Verhaltens
 * und im {@link evaluateEligibility} dokumentiert. `UNIVERSE_CAP` wird
 * erst unter den bis dahin verbliebenen Instrumenten angewendet: die
 * `maxUniverseSize` mit dem höchsten `volume24h` (Tie-Break: ID aufsteigend)
 * bleiben im Universum — deterministisch, unabhängig von der
 * Eingabe-Reihenfolge.
 *
 * **Survivorship-Grenze (bewusst sichtbar, nicht „behoben"):** die
 * Membership stammt aus der Registry zum Laufzeitpunkt. Ob ein heute
 * delistetes Instrument am historischen As-of existierte, ist aus den
 * lokalen Daten NICHT rekonstruierbar — das Artefakt trägt daher eine
 * {@link CrossSectionalSnapshot.survivorshipNote} statt der Lücke
 * stillschweigend zu widersprechen.
 */

import type {
  CrossSectionalConfig,
  ExclusionReason,
  MomentumCandle,
} from "./types";
import type { CutoffContext } from "./momentum";
import { pitVisibleCandles } from "./momentum";
import { byInstrumentId, canonicalSort, isFiniteNumber } from "./math";

/** Ein Kandidat der Population (Minimalform — bewusst eng). */
export interface CandidateInstrument {
  id: string;
  status: string;
  assetClass: string;
  volume24h: number | null;
}

/** Entscheidungeiner Eligibility-Prüfung (genau ein Ergebnis je Kandidat). */
export interface EligibilityVerdict {
  instrumentId: string;
  /** `true` = im Universum (geht in die Querschnitts-Berechnung ein). */
  eligible: boolean;
  /** Geschlossener Ausschlussgrund, nur bei `eligible === false`. */
  reason: ExclusionReason | null;
}

/** Ergebnis der Universe-Entscheidung (ID-sorted, deterministisch). */
export interface UniverseSelection {
  /** Alle Kandidaten mit Verdict (ID-sorted). */
  verdicts: EligibilityVerdict[];
  /** ID-Menge der im Universum verbliebenen Instrumente (ID-sorted). */
  memberIds: string[];
  /** Ausschlusszähler je Grund (nur Gründe > 0). */
  exclusionCounts: Record<string, number>;
}

/**
 * Führt die Eligibility-Entscheidung über die gesamte Population aus.
 *
 * Reihenfolge pro Instrument (erster Treffer gewinnt):
 *   1. `INACTIVE`               — `status !== "active"`;
 *   2. `NOT_IN_ASSET_CLASSES`   — Assetgruppen-Filter gesetzt und verletzt;
 *   3. `NO_LIQUIDITY_DATA`      — `volume24h === null` (unbekannt ≠ 0);
 *   4. `BELOW_MIN_VOLUME`       — `volume24h < minVolume24h`;
 *   (daran die `UNIVERSE_CAP`-Kappung über die Verbliebenen: Top-N nach
 *    `volume24h` desc, Tie-Break ID asc);
 *   5. `NO_BARS_AT_CUTOFF`      — keine cutoff-sichtbare Kerze;
 *   6. `STALE_DATA`             — letzte geschlossene Kerze älter als
 *    `maxStaleBars` Perioden vor dem Cutoff;
 *   7. `INSUFFICIENT_HISTORY`   — weniger als `minCandles` geschlossene
 *    Kerzen im Max-Fenster;
 *   8. `INVALID_INPUT`          — die Reihe enthielt unbrauchbare Kerzen
 *    (NaN/≤ 0) — fail-closed statt stiller Reparatur.
 *
 * @param candidates     Kandidatenpopulation (Reihenfolge egal).
 * @param candles        cutoff-sichtbare Kerzen je Kandidat (s. Modulkopf;
 *                       das Modul filtert selbst per {@link pitVisibleCandles}).
 * @param maxWindowMs    Max-Fenster in ms (für Staleness-/Historie-Zählung).
 * @param config         Versionierte Konfiguration.
 */
export function selectUniverse(
  candidates: readonly CandidateInstrument[],
  candles: ReadonlyMap<string, readonly MomentumCandle[]>,
  ctx: CutoffContext,
  maxWindowMs: number,
  config: CrossSectionalConfig,
): UniverseSelection {
  const el = config.eligibility;
  const tfMs = ctx.tfMs;
  const windowFrom = ctx.asOf - maxWindowMs;

  // Phase 1: Einzelprüfungen 1–4 (ohne Kerzen) — deterministisch.
  const phase1 = new Map<string, { instrument: CandidateInstrument; reason: ExclusionReason | null }>();
  for (const c of candidates) {
    let reason: ExclusionReason | null = null;
    if (c.status !== "active") reason = "INACTIVE";
    else if (
      el.assetClasses !== null &&
      !(el.assetClasses as readonly string[]).includes(c.assetClass)
    )
      reason = "NOT_IN_ASSET_CLASSES";
    else if (c.volume24h === null || !isFiniteNumber(c.volume24h)) reason = "NO_LIQUIDITY_DATA";
    else if (c.volume24h < el.minVolume24h) reason = "BELOW_MIN_VOLUME";
    phase1.set(c.id, { instrument: c, reason });
  }

  // Phase 2: UNIVERSE_CAP über die Phase-1-Verbliebenen (Top-N nach
  // volume24h desc, Tie-Break ID asc — unabhängig von Input-Reihenfolge).
  const survivors = canonicalSort(
    [...phase1.values()]
      .filter((e) => e.reason === null)
      .map((e) => e.instrument),
    (c) => c.id,
  );
  const capped = survivors
    .slice()
    .sort(
      (a, b) =>
        (b.volume24h as number) - (a.volume24h as number) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const capSet = new Set(capped.slice(0, el.maxUniverseSize).map((c) => c.id));
  for (const c of survivors) {
    if (!capSet.has(c.id)) phase1.get(c.id)!.reason = "UNIVERSE_CAP";
  }

  // Phase 3: Kerzenprüfungen 5–8 (nur für die noch Verbliebenen).
  for (const entry of phase1.values()) {
    if (entry.reason !== null) continue;
    const id = entry.instrument.id;
    const raw = candles.get(id) ?? [];
    const { visible, invalidAtCutoff } = pitVisibleCandles(raw, ctx);
    // Nur geschlossene Kerzen IM MAX-FENSTER zählen für die Historie:
    const inWindow = visible.filter((c) => c.ts >= windowFrom);
    if (inWindow.length === 0) {
      entry.reason = "NO_BARS_AT_CUTOFF";
      continue;
    }
    const last = inWindow[inWindow.length - 1];
    const lastBarEnd = last.ts + tfMs;
    if (lastBarEnd < ctx.asOf - el.maxStaleBars * tfMs) {
      entry.reason = "STALE_DATA";
      continue;
    }
    if (inWindow.length < el.minCandles) {
      entry.reason = "INSUFFICIENT_HISTORY";
      continue;
    }
    if (invalidAtCutoff > 0) {
      // Die am Cutoff bekannte Reihe enthielt unbrauchbare Kerzen →
      // Datenqualitätsproblem, fail-closed (nie stille Reparatur).
      entry.reason = "INVALID_INPUT";
      continue;
    }
  }

  const verdicts = byInstrumentId(
    [...phase1.values()].map((e) => ({
      instrumentId: e.instrument.id,
      eligible: e.reason === null,
      reason: e.reason,
    })),
  );
  const memberIds = verdicts.filter((v) => v.eligible).map((v) => v.instrumentId);
  const exclusionCounts: Record<string, number> = {};
  for (const v of verdicts) {
    if (v.reason) exclusionCounts[v.reason] = (exclusionCounts[v.reason] ?? 0) + 1;
  }
  return { verdicts, memberIds, exclusionCounts };
}

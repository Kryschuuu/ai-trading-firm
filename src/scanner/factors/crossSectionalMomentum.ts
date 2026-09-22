/**
 * **Faktor `crossSectionalMomentum` — universumsweiter Momentum-Rang
 * (RMA-P2-04, v1.63.0).**
 *
 * Der Faktor liest den **Point-in-Time Cross-Sectional-Snapshot**
 * (`src/crossSectional/`) über den injizierten Kontext
 * {@link FactorInput.crossSectional}:
 *
 * Formel: `normalized = percentile` des Instruments im Querschnitt
 * (Anteil des Universums mit gleichem oder schlechterem Rang ∈ (0,1]),
 * `raw = composite` (gewichtete z-Score-Summe über die versionierten
 * Momentum-Horizonte).
 *
 * Normalisierung: Perzentil ist bereits in `[0,1]` skaliert („größer =
 * stärkeres Universums-Momentum“); `raw` bleibt das Composite in z-Einheiten.
 *
 * **Explizites Unavailable (fail-closed):** ohne injizierten Kontext
 * (kein Snapshot, stale Snapshot, Feature-Flag aus) liefert der Faktor
 * `available: false`, `raw: null` und den dokumentierten Neutralwert 0.5
 * (Median des Querschnitts) — ein fehlender Rang geht **nie** still als
 * 0-Momentum in eine Entscheidung ein.
 *
 * **Kein Doppeltzählen:** der Faktor ist ein **Diagnose-Faktor ohne
 * Score-Gewicht** (wie `atr`/`rsi`/`drawdown`/`funding`/`openInterest`).
 * Die gewichtete Momentum-Komponente des Market Scores nutzt weiterhin den
 * instrument-lokalen Faktor `momentum` — das Cross-Sectional-Ranking
 * verändert den Score nicht (dokumentierte Gewichtsentscheidung: Gewicht 0;
 * eine spätere Gewichtung ist eine bewusste, versionierte Config-Änderung).
 *
 * Datenbedarf: ein persistiertes Cross-Sectional-Artefakt/DB-Snapshot für
 * das Universum (via `npm run research:cross-sectional`); der Scanner
 * selbst führt dafür keine I/O aus (der Service injiziert den Kontext).
 */

import type { Factor, FactorInput, FactorValue } from "../types";
import type { CrossSectionalRankContext } from "@/crossSectional/types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Snapshotlage: 0.5 (Median des Querschnitts, nie 0). */
export const CROSS_SECTIONAL_MOMENTUM_NEUTRAL = 0.5;

/**
 * Der Faktor (Score-Gewicht 0 — Diagnose; die gewichtete Momentum-Komponente
 * bleibt der instrument-lokale Faktor `momentum`, siehe Modul-Kopf).
 */
export const crossSectionalMomentumFactor: Factor = {
  id: "crossSectionalMomentum",
  label: "Cross-Sectional Momentum (Querschnitts-Rang)",
  neutral: CROSS_SECTIONAL_MOMENTUM_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const ctx: CrossSectionalRankContext | null | undefined = input.crossSectional ?? null;
    if (
      !ctx ||
      !Number.isFinite(ctx.percentile) ||
      ctx.percentile <= 0 ||
      ctx.percentile > 1 ||
      !Number.isFinite(ctx.composite) ||
      !Number.isInteger(ctx.rank) ||
      ctx.rank < 1
    ) {
      return unavailable(
        "crossSectionalMomentum",
        CROSS_SECTIONAL_MOMENTUM_NEUTRAL,
        "Cross-Sectional-Snapshot unavailable (kein Snapshot, stale oder Feature-Flag aus) — Rang wird NICHT als 0-Momentum behandelt",
        { source: "cross-sectional" },
      );
    }
    return factorValue("crossSectionalMomentum", {
      raw: ctx.composite,
      normalized: ctx.percentile,
      reason: `Rang ${ctx.rank} (Perzentil ${(ctx.percentile * 100).toFixed(1)} %), Snapshot ${ctx.snapshotId} (asOf ${new Date(ctx.asOf).toISOString()})`,
      detail: {
        rank: ctx.rank,
        percentile: ctx.percentile,
        snapshotId: ctx.snapshotId,
        asOf: new Date(ctx.asOf).toISOString(),
        source: "cross-sectional",
        weight: 0,
      },
    });
  },
};

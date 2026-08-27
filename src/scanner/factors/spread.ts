/**
 * **Faktor `spread` — Geld-Brief-Spanne.**
 *
 * Formel: `raw = spread` (relativer Spread `(ask − bid) / mid` aus der
 * Registry bzw. der Market-Data-Normalisierung, `0.0004` = 4 bp).
 *
 * Normalisierung: invers linear — `bestSpread → 1`, `worstSpread → 0`
 * (enger Spread ist besser).
 *
 * Datenbedarf: `MarketInstrument.spread`. Unbekannt heißt **nicht** „eng“:
 * der Faktor meldet `available: false` mit Neutralwert 0.
 */
import { inverseNorm } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0 — unbekannter Spread wird nicht belohnt. */
export const SPREAD_NEUTRAL = 0;

/** Spread-Faktor (Score-Gewicht 10 %). */
export const spreadFactor: Factor = {
  id: "spread",
  label: "Spread (Geld-Brief-Spanne)",
  neutral: SPREAD_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.spread;
    const spread = input.instrument.spread;
    if (spread === null || !Number.isFinite(spread) || spread < 0) {
      return unavailable("spread", SPREAD_NEUTRAL, "kein Spread bekannt");
    }
    return factorValue("spread", {
      raw: spread,
      normalized: inverseNorm(spread, cfg.bestSpread, cfg.worstSpread),
      reason: `relativer Spread ${(spread * 10_000).toFixed(2)} bp`,
      detail: { bps: spread * 10_000, bestSpread: cfg.bestSpread, worstSpread: cfg.worstSpread },
    });
  },
};

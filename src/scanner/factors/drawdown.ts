/**
 * **Faktor `drawdown` — maximaler Rückgang vom Hoch.**
 *
 * Formel: über die letzten `lookback` Schlusskurse laufendes Maximum `peak_t`,
 * `dd_t = (peak_t − c_t) / peak_t`, `raw = max(dd_t)` (0.25 = −25 %).
 *
 * Normalisierung: invers linear — `0 → 1`, `maxDrawdown (0.5) → 0`.
 *
 * Datenbedarf: ≥ 2 Kerzen.
 *
 * Diagnose-Faktor: kein Score-Gewicht, aber harter Risikofilter im Trichter.
 */
import { closesOf, inverseNorm, tail } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const DRAWDOWN_NEUTRAL = 0;

/** Drawdown-Faktor (Diagnose, kein Score-Gewicht). */
export const drawdownFactor: Factor = {
  id: "drawdown",
  label: "Maximaler Drawdown",
  neutral: DRAWDOWN_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.drawdown;
    const closes = closesOf(input.candles);
    if (!closes) return unavailable("drawdown", DRAWDOWN_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    const window = tail(closes, cfg.lookback);
    if (window.length < 2) {
      return unavailable("drawdown", DRAWDOWN_NEUTRAL, `zu wenig Kurse (${window.length})`);
    }
    let peak = window[0];
    let maxDrawdown = 0;
    let troughIndex = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i] > peak) peak = window[i];
      const dd = peak > 0 ? (peak - window[i]) / peak : 0;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        troughIndex = i;
      }
    }
    return factorValue("drawdown", {
      raw: maxDrawdown,
      normalized: inverseNorm(maxDrawdown, 0, cfg.maxDrawdown),
      reason: `maximaler Drawdown ${(maxDrawdown * 100).toFixed(2)} % über ${window.length} Perioden`,
      detail: { periods: window.length, troughIndex, peak },
    });
  },
};

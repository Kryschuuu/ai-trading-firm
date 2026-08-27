/**
 * **Faktor `trend` — EMA-Struktur.**
 *
 * Formel: `EMA_fast(9)`, `EMA_mid(21)`, `EMA_slow(50)` auf Schlusskursen
 * (`k = 2/(p+1)`, Seed = erster Kurs).
 * `raw = (EMA_fast − EMA_slow) / EMA_slow` (relativer Abstand, signiert).
 *
 * Normalisierung:
 * `strength = min(|raw| / scale, 1)`;
 * `aligned` = EMAs stehen streng monoton (fast > mid > slow **oder**
 * fast < mid < slow);
 * `normalized = aligned ? 0.5 + 0.5 × strength : 0.5 × strength`.
 * Eine saubere, gestaffelte Struktur wird also belohnt, ein
 * Durcheinander-Markt gedeckelt.
 *
 * Datenbedarf: ≥ `slowPeriod` Kerzen.
 */
import { closesOf, clamp01, ema, last } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const TREND_NEUTRAL = 0;

/** Trend-Faktor (Score-Gewicht 15 %). */
export const trendFactor: Factor = {
  id: "trend",
  label: "Trend (EMA-Struktur)",
  neutral: TREND_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.trend;
    const closes = closesOf(input.candles);
    if (!closes) return unavailable("trend", TREND_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    if (closes.length < cfg.slowPeriod) {
      return unavailable("trend", TREND_NEUTRAL, `zu wenig Kurse (${closes.length} < ${cfg.slowPeriod})`);
    }
    const fastSeries = ema(closes, cfg.fastPeriod);
    const midSeries = ema(closes, cfg.midPeriod);
    const slowSeries = ema(closes, cfg.slowPeriod);
    const fast = fastSeries ? last(fastSeries) : null;
    const mid = midSeries ? last(midSeries) : null;
    const slow = slowSeries ? last(slowSeries) : null;
    if (fast === null || mid === null || slow === null || slow <= 0) {
      return unavailable("trend", TREND_NEUTRAL, "EMA nicht berechenbar");
    }
    const raw = (fast - slow) / slow;
    const strength = clamp01(Math.abs(raw) / cfg.scale);
    const alignedUp = fast > mid && mid > slow;
    const alignedDown = fast < mid && mid < slow;
    const aligned = alignedUp || alignedDown;
    const normalized = aligned ? 0.5 + 0.5 * strength : 0.5 * strength;
    return factorValue("trend", {
      raw,
      normalized,
      reason: `EMA-Abstand ${(raw * 100).toFixed(2)} %, Struktur ${aligned ? (alignedUp ? "aufwärts" : "abwärts") : "gemischt"}`,
      detail: { emaFast: fast, emaMid: mid, emaSlow: slow, aligned, strength },
    });
  },
};

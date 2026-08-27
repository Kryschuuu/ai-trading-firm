/**
 * **Faktor `rsi` — Relative Strength Index (Wilder).**
 *
 * Formel: `avgGain`/`avgLoss` als Wilder-RMA der Auf-/Abwärtsbewegungen über
 * `period` (Default 14), `RS = avgGain / avgLoss`, `raw = 100 − 100/(1+RS)`.
 * Ohne einen einzigen Verlust gilt `raw = 100`, bei völlig konstanter Serie
 * `raw = 50` (neutral, konsistent mit `src/lib/indicators.ts`).
 *
 * Normalisierung: **Überhitzungsfilter** —
 * `normalized = 1 − clamp((|RSI − 50| − neutralBand) / (extremeBand − neutralBand), 0, 1)`.
 * RSI zwischen 30 und 70 ⇒ 1; RSI 0 oder 100 ⇒ 0.
 *
 * Datenbedarf: ≥ `period + 1` Kerzen.
 *
 * Diagnose-Faktor: kein eigenes Score-Gewicht, aber Bestandteil von Filtern
 * und Weekly-Begründungen.
 */
import { clamp01, closesOf } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const RSI_NEUTRAL = 0;

/** Berechnet den Wilder-RSI einer Kursreihe (oder `null`). */
export function computeRsi(closes: readonly number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (!Number.isFinite(d)) return null;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (!Number.isFinite(d)) return null;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** RSI-Faktor (Diagnose, kein Score-Gewicht). */
export const rsiFactor: Factor = {
  id: "rsi",
  label: "RSI (Überhitzung)",
  neutral: RSI_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.rsi;
    const closes = closesOf(input.candles);
    if (!closes) return unavailable("rsi", RSI_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    const value = computeRsi(closes, cfg.period);
    if (value === null) {
      return unavailable("rsi", RSI_NEUTRAL, `zu wenig Kurse (${closes.length} < ${cfg.period + 1})`);
    }
    const distance = Math.abs(value - 50);
    const span = cfg.extremeBand - cfg.neutralBand;
    const overheat = span > 0 ? clamp01((distance - cfg.neutralBand) / span) : distance > cfg.neutralBand ? 1 : 0;
    return factorValue("rsi", {
      raw: value,
      normalized: 1 - overheat,
      reason: `RSI ${value.toFixed(1)}`,
      detail: { distanceFromNeutral: distance, period: cfg.period },
    });
  },
};

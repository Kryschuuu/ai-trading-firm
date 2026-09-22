/**
 * Kanonische Features je Timeframe (RMA-P2-03) — rein, deterministisch.
 *
 * Genau drei robuste, normalisierte Merkmale (alle bounded, alle mit
 * dokumentiertem Warmup-Bedarf):
 *
 *   - `trend`      ∈ [-1, 1] — normalisierte EMA-Lücke (Richtung + Staffelung)
 *   - `momentum`   ∈ [-1, 1] — gewichtete Rate-of-Change (Dynamik)
 *   - `volatility` ∈ [0, 1]  — ATR/Close-Anteil (Streckung, dämpft Confidence)
 *
 * Konventionen (identisch zum Scanner, `src/scanner/math.ts`):
 *   - EMA: `k = 2/(p+1)`, Seed = erster Kurs.
 *   - ATR: Wilder-Glättung über True Ranges.
 *   - Ausgabe durch `roundTo` (10 Dezimalen, Half-away-from-zero) — gleiche
 *     Eingabe ⇒ byte-identische Features.
 */

import { clamp01, roundTo } from "@/scanner/math";
import type { ConfluenceFeatureConfig } from "./config";
import type { ConfluenceCandle, TimeframeFeatures } from "./types";

/** Klemmt in [-1, 1]; nicht-endliche Werte werden zu 0 (defensiv). */
function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * Exponentiell geglätteter Durchschnitt (Scanner-Konvention).
 * Liefert `null` bei zu kurzer Reihe oder unbrauchbaren Werten.
 */
export function emaSeries(values: readonly number[], period: number): number[] | null {
  if (!Number.isInteger(period) || period < 1) return null;
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  let prev = values[0];
  if (!Number.isFinite(prev)) return null;
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * ATR nach Wilder über True Ranges, relativ (`atr/close`).
 * Liefert `null` bei zu kurzer Reihe oder unbrauchbaren Werten.
 */
export function atrPct(
  candles: readonly { high: number; low: number; close: number }[],
  period: number,
): number | null {
  if (!Number.isInteger(period) || period < 1) return null;
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const prevClose = candles[i - 1].close;
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(prevClose) ||
      h <= 0 ||
      l <= 0 ||
      prevClose <= 0
    ) {
      return null;
    }
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  // Wilder: Start = Mittel der ersten `period` TRs, dann Rekursion.
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const lastClose = candles[candles.length - 1].close;
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
  const pct = atr / lastClose;
  return Number.isFinite(pct) && pct >= 0 ? pct : null;
}

/**
 * Berechnet die drei kanonischen Features über die (bereits as-of-
 * ausgerichteten, geschlossenen) Kerzen. Reine Funktion.
 *
 * @param closes Schlusskurse, aufsteigend, alle endlich und > 0.
 * @param candles volle Kerzen (für ATR), gleiche Länge/Reihenfolge wie `closes`.
 * @returns Features oder `null`, wenn der Warmup-Bedarf nicht erfüllt ist
 *   oder eine Kennzahl nicht berechenbar ist (Aufrufer meldet `warmup`/
 *   `invalid` — es wird nie geraten).
 */
export function computeTimeframeFeatures(
  closes: readonly number[],
  candles: readonly ConfluenceCandle[],
  cfg: ConfluenceFeatureConfig,
): TimeframeFeatures | null {
  const n = closes.length;
  if (n === 0 || candles.length !== n) return null;
  for (const c of closes) {
    if (!Number.isFinite(c) || c <= 0) return null;
  }

  // Warmup: EMA-slow, längstes Momentum-Fenster (+1 Referenzkerze), ATR (+1).
  const warmup = Math.max(
    cfg.emaSlowPeriod,
    Math.max(...cfg.momentumLookbacks) + 1,
    cfg.atrPeriod + 1,
  );
  if (n < warmup) return null;

  // ── Trend: normalisierte EMA-Lücke ───────────────────────────────────────
  const fast = emaSeries(closes, cfg.emaFastPeriod);
  const slow = emaSeries(closes, cfg.emaSlowPeriod);
  if (!fast || !slow) return null;
  const emaF = fast[fast.length - 1];
  const emaS = slow[slow.length - 1];
  if (!Number.isFinite(emaF) || !Number.isFinite(emaS) || emaS <= 0) return null;
  const trend = clampSigned((emaF - emaS) / emaS / cfg.trendScale);

  // ── Momentum: gewichtete Rate-of-Change ──────────────────────────────────
  const current = closes[n - 1];
  let weighted = 0;
  let weightSum = 0;
  for (let i = 0; i < cfg.momentumLookbacks.length; i++) {
    const lookback = cfg.momentumLookbacks[i];
    const weight = cfg.momentumWeights[i];
    if (n < lookback + 1) continue; // kürzeres Fenster entfällt (sichtbar via barsUsed)
    const past = closes[n - 1 - lookback];
    if (!Number.isFinite(past) || past <= 0) return null;
    weighted += weight * (current / past - 1);
    weightSum += weight;
  }
  if (weightSum <= 0) return null;
  const momentum = clampSigned(weighted / weightSum / cfg.momentumScale);

  // ── Volatilität: ATR/Close ───────────────────────────────────────────────
  const atr = atrPct(candles, cfg.atrPeriod);
  if (atr === null) return null;
  const volatility = clamp01(atr / cfg.volScale);

  return {
    trend: roundTo(trend),
    momentum: roundTo(momentum),
    volatility: roundTo(volatility),
  };
}

/**
 * Richtungskomponente EINES Timeframes aus Trend+Momentum (bounded Mix):
 * `clamp(trendWeight × trend + momentumWeight × momentum, −1, 1)`.
 * Die Volatilität dreht die Richtung nie — sie dämpft nur die Confidence.
 */
export function timeframeDirection(features: TimeframeFeatures, cfg: ConfluenceFeatureConfig): number {
  return roundTo(clampSigned(cfg.trendWeight * features.trend + cfg.momentumWeight * features.momentum));
}

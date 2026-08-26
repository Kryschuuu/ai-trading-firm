/**
 * Technische Indikatoren für die Agenten-Prompts und dynamische Stops.
 * Bewusst klein und deterministisch — keine Bibliothek, kein Ballast.
 */
import type { Candle } from "./marketData";

/** Exponentiell geglätteter Durchschnitt. */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Relative Stärke Index (Wilder). */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) {
    // Reiner Aufwärtslauf ohne einen einzigen Verlust → maximal überkauft;
    // eine völlig bewegungslose Serie ist neutral.
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Bollinger-Band-Breite (Bandwidth) als Anteil des mittleren Kurses:
 * (Oberband − Unterband) / SMA = 2 × mult × σ / SMA.
 *
 * Die Bandbreite misst, wie breit das Preisband ist — ein etablierter
 * "Volatility Squeeze"/-Expansion-Indikator: enge Bänder → niedrige
 * Volatilität, aufgerissene Bänder → hoch. Liefert null, wenn zu wenig
 * Daten oder der Mittelkurs nicht sinnvoll (> 0) ist.
 */
export function bollingerBandWidthPct(
  closes: number[],
  period = 20,
  mult = 2
): number | null {
  if (!Array.isArray(closes) || closes.length < period || period < 2 || mult <= 0) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  if (!Number.isFinite(mean) || mean <= 0) return null;
  // Populations-Standardabweichung (÷ n) — konsistent, deterministisch,
  // und bei Bands um den SMA die übliche Konvention.
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(Math.max(variance, 0));
  const width = (2 * mult * sd) / mean;
  return Number.isFinite(width) && width >= 0 ? width : null;
}

/**
 * Standardabweichung der Perioden-Returns der letzten N Perioden
 * (als Dezimalzahl pro Periode, z. B. 0.01 = 1 % pro Kerze).
 *
 * Direkte Maßzahl der Kursschwingung ohne Glättung — reagiert schneller
 * als ATR, weil jede Periode direkt eingeht. null bei unzureichender
 * Historie oder nicht-sinnvollen Kursen (≤ 0).
 */
export function returnStdDevPct(closes: number[], n = 20): number | null {
  if (!Array.isArray(closes) || closes.length < n + 1 || n < 2) return null;
  const slice = closes.slice(-(n + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) return null;
    returns.push((cur - prev) / prev);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(Math.max(variance, 0));
  return Number.isFinite(sd) ? sd : null;
}

/** Average True Range in Prozent des letzten Kurses. */
export function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const slice = trs.slice(-period);
  const atr = slice.reduce((a, b) => a + b, 0) / slice.length;
  const last = candles[candles.length - 1].close;
  return last > 0 ? atr / last : null;
}

export type MarketSnapshot = {
  symbol: string;
  price: number;
  rsi14: number;
  ema9: number;
  ema21: number;
  trend: "UP" | "DOWN" | "FLAT";
  atrPercent: number | null;
  changePct24h: number | null;
};

/** Kompakter Markt-Snapshot für Prompts und Dashboard. */
export function snapshot(symbol: string, candles: Candle[]): MarketSnapshot | null {
  if (candles.length < 25) return null;
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const price = closes[closes.length - 1];
  const diff = e9[e9.length - 1] - e21[e21.length - 1];
  const relDiff = Math.abs(diff) / price;
  return {
    symbol: symbol.toUpperCase(),
    price,
    rsi14: Number(rsi(closes).toFixed(1)),
    ema9: e9[e9.length - 1],
    ema21: e21[e21.length - 1],
    trend: relDiff < 0.001 ? "FLAT" : diff > 0 ? "UP" : "DOWN",
    atrPercent: atrPct(candles) != null ? Number((atrPct(candles as Candle[])! * 100).toFixed(2)) : null,
    changePct24h:
      candles.length > 1
        ? Number((((price - closes[Math.max(0, closes.length - 97)]) / closes[Math.max(0, closes.length - 97)]) * 100).toFixed(2))
        : null,
  };
}

/** Einzeilige Zusammenfassung für LLM-Prompts. */
export function snapshotLine(s: MarketSnapshot): string {
  const atr = s.atrPercent != null ? `, ATR ${s.atrPercent}%` : "";
  const chg = s.changePct24h != null ? `, 24h ${s.changePct24h > 0 ? "+" : ""}${s.changePct24h}%` : "";
  return `${s.symbol}: ${s.price} | RSI ${s.rsi14} | EMA9 ${s.ema9.toFixed(2)} vs EMA21 ${s.ema21.toFixed(2)} → Trend ${s.trend}${atr}${chg}`;
}

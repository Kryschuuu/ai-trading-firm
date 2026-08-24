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

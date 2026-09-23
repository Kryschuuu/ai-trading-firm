/**
 * Vertrauenswürdige 1h-Indikatoren für den technischen Analysten (VBF-P2-01).
 *
 * RSI, ATR und ADX werden aus geschlossenen Historical-Store-Kerzen gerechnet
 * und nach der LLM-Validierung über die Modellwerte geschrieben. Fehlt die
 * Historie, bleiben die Felder weg — ein Fallback von 50 ist keine Messung.
 */

import { adx, atr, atrPct, macd, rsi } from "@/lib/indicators";
import type { Candle } from "@/lib/marketData";
import type { HistoricalStore } from "@/lib/marketdata/historicalStore";

export const TRUSTED_INDICATOR_VERSION = "trusted-indicators@1";
export const TRUSTED_INDICATOR_TIMEFRAME = "1h" as const;
export const TRUSTED_INDICATOR_BARS = 120;
const HOUR_MS = 60 * 60 * 1000;

export type TrustedReading = {
  instrumentId: string;
  timeframe: typeof TRUSTED_INDICATOR_TIMEFRAME;
  asOfMs: number;
  bars: number;
  /** null = nicht gemessen, nicht „neutral 50“. */
  rsi: number | null;
  /** Absolute ATR in Preiseinheiten. */
  atr: number | null;
  /** ATR in Prozent des letzten Kurses (2.5 = 2,5 %). */
  atrPct: number | null;
  adx: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
};

export type TrustedIndicatorPayload = {
  kind: typeof TRUSTED_INDICATOR_VERSION;
  timeframe: typeof TRUSTED_INDICATOR_TIMEFRAME;
  asOf: string;
  readings: TrustedReading[];
};

function roundOrNull(value: number | null, digits: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}



/** Nur Bars, deren Periode zum as-of bereits geschlossen ist. */
export function closedCandles(
  entries: readonly { ts: number; open: number; high: number; low: number; close: number; volume: number }[],
  asOfMs: number,
): Candle[] {
  return entries
    .filter((entry) => Number.isFinite(entry.ts) && entry.ts + HOUR_MS <= asOfMs)
    .sort((a, b) => a.ts - b.ts)
    .slice(-TRUSTED_INDICATOR_BARS)
    .map((entry) => ({
      time: entry.ts,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
      volume: entry.volume,
    }));
}

export function readingFromCandles(instrumentId: string, candles: readonly Candle[], asOfMs: number): TrustedReading {
  const closes = candles.map((candle) => candle.close);
  // rsi() liefert bei zu wenig Daten still 50. Das darf hier keine Messung werden.
  const rsiValue = closes.length >= 15 ? rsi(closes) : null;
  const macdValue = macd(closes);
  return {
    instrumentId,
    timeframe: TRUSTED_INDICATOR_TIMEFRAME,
    asOfMs,
    bars: candles.length,
    rsi: roundOrNull(rsiValue, 2),
    atr: roundOrNull(atr(candles as Candle[], 14), 6),
    atrPct: roundOrNull(atrPct(candles as Candle[], 14) == null ? null : atrPct(candles as Candle[], 14)! * 100, 4),
    adx: roundOrNull(adx(candles as Candle[], 14), 2),
    macd: roundOrNull(macdValue?.macd ?? null, 6),
    macdSignal: roundOrNull(macdValue?.signal ?? null, 6),
    macdHist: roundOrNull(macdValue?.histogram ?? null, 6),
  };
}

export function loadTrustedIndicators(
  store: HistoricalStore,
  instrumentIds: readonly string[],
  asOfMs: number,
): Map<string, TrustedReading> {
  const ids = [...new Set(instrumentIds.filter((id) => typeof id === "string" && id.length > 0))];
  const map = new Map<string, TrustedReading>();
  if (ids.length === 0 || !Number.isFinite(asOfMs)) return map;
  const wanted = new Set(ids);
  const byId = new Map<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]>();
  for (const entry of store.readAll()) {
    if (entry.timeframe !== TRUSTED_INDICATOR_TIMEFRAME || !wanted.has(entry.instrumentId)) continue;
    const list = byId.get(entry.instrumentId) ?? [];
    list.push(entry);
    byId.set(entry.instrumentId, list);
  }
  for (const id of ids) {
    map.set(id, readingFromCandles(id, closedCandles(byId.get(id) ?? [], asOfMs), asOfMs));
  }
  return map;
}

export function indicatorPayload(readings: ReadonlyMap<string, TrustedReading>, asOfMs: number): TrustedIndicatorPayload {
  return {
    kind: TRUSTED_INDICATOR_VERSION,
    timeframe: TRUSTED_INDICATOR_TIMEFRAME,
    asOf: new Date(asOfMs).toISOString(),
    readings: [...readings.values()],
  };
}

/**
 * Schreibt gemessene RSI/ATR über die LLM-Felder. Ohne Messung werden die
 * Felder gelöscht, auch wenn das Modell eine Zahl geschickt hat.
 */
export function applyTrustedReadings<T extends { instrumentId: string; rsi?: number; atr?: number }>(
  analyses: T[],
  readings: ReadonlyMap<string, TrustedReading>,
): void {
  for (const analysis of analyses) {
    const reading = readings.get(analysis.instrumentId);
    if (!reading || reading.rsi == null) delete analysis.rsi;
    else analysis.rsi = reading.rsi;
    if (!reading || reading.atr == null) delete analysis.atr;
    else analysis.atr = reading.atr;
  }
}

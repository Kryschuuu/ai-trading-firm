/**
 * Indikator-Cache für die Backtest-Engine (Performance-Optimierung, v0.3.0).
 *
 * Problem: `buildSnapshotFromCandles` rechnet pro Bar alle Indikatoren aus
 * der gesamten Historie neu (EMA über alle Closes, ADX über alle Kerzen, …).
 * Bei 17 520 Stundenkerzen (2 Jahre) ist das O(n²) und sprengt den 10-s-Deckel
 * des Performance-Tests (15–20 s auf 2-Core-Hardware).
 *
 * Lösung: Indikatoren einmal pro Symbol in O(n) vorrechnen, danach O(1)-Lookup
 * je Bar. Die Formeln bleiben byte-identisch zu `src/lib/indicators.ts` und
 * `src/lib/ruleEngine.ts`, nur die Ausführung wird von „pro Bar alles“ auf
 * „einmal alles“ umgestellt.
 */

import type { CandleLike } from "../lib/ruleEngine";

export interface IndicatorCache {
  closes: number[];
  ema9: (number | null)[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  rsi14: (number | null)[];
  atr: (number | null)[];
  atrPct: (number | null)[];
  adx14: (number | null)[];
  bbwPct: (number | null)[];
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHist: (number | null)[];
  volume: number[];
  volumeMa20: (number | null)[];
}

function emaArray(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = new Array(values.length);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiArray(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) {
    for (let i = 0; i < values.length; i++) out[i] = 50;
    return out;
  }
  for (let i = 0; i < period; i++) out[i] = 50;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const firstRsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = firstRsi;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    if (avgLoss === 0) {
      out[i] = avgGain === 0 ? 50 : 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function atrArray(candles: CandleLike[], period = 14): { atr: (number | null)[]; tr: number[] } {
  const n = candles.length;
  const tr: number[] = new Array(n).fill(0);
  const atr: (number | null)[] = new Array(n).fill(null);
  if (n < 2) return { atr, tr };
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const curr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    tr[i] = Number.isFinite(curr) && curr >= 0 ? curr : 0;
  }
  if (n >= period + 1) {
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    atr[period] = sum / period;
    for (let i = period + 1; i < n; i++) {
      sum = sum - tr[i - period] + tr[i];
      atr[i] = sum / period;
    }
  }
  return { atr, tr };
}

/**
 * ADX per Bar, exakt wie `adx()` in indicators.ts für den jeweiligen Slice.
 * Original: braucht 2*period+1 Kerzen (29 bei period 14) für ersten Wert,
 * danach Wilder-Glättung. Diese Implementierung liefert für jeden Index den
 * Wert, den `adx(candles.slice(0,idx+1))` liefern würde.
 */
function adxArray(candles: CandleLike[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < 2 * period + 1) return out;

  const trArr: number[] = new Array(n).fill(0);
  const plusArr: number[] = new Array(n).fill(0);
  const minusArr: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusArr[i] = up > down && up > 0 ? up : 0;
    minusArr[i] = down > up && down > 0 ? down : 0;
    trArr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }

  let trS = 0,
    pS = 0,
    mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += trArr[i];
    pS += plusArr[i];
    mS += minusArr[i];
  }

  const dxAt = (): number => {
    if (!Number.isFinite(trS) || trS <= 0) return 0;
    const pdi = (100 * pS) / trS;
    const mdi = (100 * mS) / trS;
    const sum = pdi + mdi;
    return sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  };

  const dxs: number[] = [dxAt()];
  let adxVal: number | null = null;

  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + trArr[i];
    pS = pS - pS / period + plusArr[i];
    mS = mS - mS / period + minusArr[i];
    dxs.push(dxAt());

    if (dxs.length === period) {
      // Durchschnitt der ersten period DXs — noch nicht ausgeben (entspricht len=28, soll null sein)
      let sum = 0;
      for (let j = 0; j < period; j++) sum += dxs[j];
      adxVal = sum / period;
    } else if (dxs.length > period) {
      if (adxVal == null) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += dxs[j];
        adxVal = sum / period;
      }
      adxVal = (adxVal * (period - 1) + dxs[dxs.length - 1]) / period;
      out[i] = adxVal;
    }
  }

  return out;
}

function bbwArray(closes: number[], period = 20, mult = 2): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  for (let i = period - 1; i < n; i++) {
    if (i >= period) {
      sum = sum - closes[i - period] + closes[i];
    }
    const mean = sum / period;
    if (!Number.isFinite(mean) || mean <= 0) {
      out[i] = null;
      continue;
    }
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - mean;
      varSum += diff * diff;
    }
    const variance = varSum / period;
    const sd = Math.sqrt(Math.max(variance, 0));
    const width = (2 * mult * sd) / mean;
    out[i] = Number.isFinite(width) && width >= 0 ? width : null;
  }
  return out;
}

function macdArray(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const n = closes.length;
  const macdOut: (number | null)[] = new Array(n).fill(null);
  const signalOut: (number | null)[] = new Array(n).fill(null);
  const histOut: (number | null)[] = new Array(n).fill(null);

  if (n < slow + signalPeriod) return { macd: macdOut, signal: signalOut, hist: histOut };

  const fastEma = emaArray(closes, fast);
  const slowEma = emaArray(closes, slow);
  const line: number[] = new Array(n);
  for (let i = 0; i < n; i++) line[i] = fastEma[i] - slowEma[i];

  const signalEma = emaArray(line, signalPeriod);

  for (let i = 0; i < n; i++) {
    if (i < slow + signalPeriod - 1) continue;
    const m = line[i];
    const s = signalEma[i];
    if (!Number.isFinite(m) || !Number.isFinite(s)) continue;
    macdOut[i] = m;
    signalOut[i] = s;
    histOut[i] = m - s;
  }

  return { macd: macdOut, signal: signalOut, hist: histOut };
}

export function buildIndicatorCache(candles: CandleLike[]): IndicatorCache {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const ema9 = emaArray(closes, 9);
  const ema21 = emaArray(closes, 21);
  const ema50: number[] = new Array(n);
  if (n > 0) {
    let prev50 = closes[0];
    ema50[0] = prev50;
    for (let i = 1; i < n; i++) {
      if (i < 50) {
        const slice = closes.slice(0, i + 1);
        const p = Math.min(50, slice.length);
        const arr = emaArray(slice, p);
        prev50 = arr[arr.length - 1];
        ema50[i] = prev50;
      } else {
        prev50 = closes[i] * (2 / 51) + prev50 * (1 - 2 / 51);
        ema50[i] = prev50;
      }
    }
  }

  const rsi14 = rsiArray(closes, 14);
  const { atr } = atrArray(candles, 14);
  const atrPct: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    const close = closes[i];
    if (a != null && close > 0) atrPct[i] = a / close;
  }

  const adx14 = adxArray(candles, 14);
  const bbwRaw = bbwArray(closes, 20, 2);
  const { macd, signal, hist } = macdArray(closes, 12, 26, 9);

  const volumeMa20: (number | null)[] = new Array(n).fill(null);
  if (n >= 1) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += volumes[i];
      if (i >= 20) sum -= volumes[i - 20];
      if (i >= 19) volumeMa20[i] = sum / Math.min(20, i + 1);
    }
  }

  return {
    closes,
    ema9: ema9.map((v) => (Number.isFinite(v) ? v : null)),
    ema21: ema21.map((v) => (Number.isFinite(v) ? v : null)),
    ema50: ema50.map((v) => (Number.isFinite(v) ? v : null)),
    rsi14,
    atr,
    atrPct,
    adx14,
    bbwPct: bbwRaw,
    macd,
    macdSignal: signal,
    macdHist: hist,
    volume: volumes,
    volumeMa20,
  };
}

export function snapshotFromCache(
  symbol: string,
  candles: CandleLike[],
  cache: IndicatorCache,
  idx: number,
  volumeWindow = 20,
  spread: number | null = null
): import("../lib/ruleEngine").RuleSnapshot | null {
  if (idx < 24 || idx >= candles.length) return null;
  const price = cache.closes[idx];
  if (!Number.isFinite(price) || price <= 0) return null;

  const e9 = cache.ema9[idx];
  const e21 = cache.ema21[idx];
  const e50 = cache.ema50[idx];
  if (e9 == null || e21 == null || e50 == null) return null;

  const priceVsEma21 = e21 > 0 ? ((price - e21) / e21) * 100 : 0;
  const priceVsEma50 = e50 > 0 ? ((price - e50) / e50) * 100 : 0;

  const volWindow = Math.max(1, Math.min(200, Math.trunc(volumeWindow) || 20));
  const startVol = Math.max(0, idx - volWindow + 1);
  let volSum = 0;
  for (let i = startVol; i <= idx; i++) volSum += candles[i].volume;
  const volCount = idx - startVol + 1;
  const volume = candles[idx].volume;
  const volumeMa = volCount > 0 ? volSum / volCount : 0;

  const trendRel = Math.abs(e9 - e21) / price;
  let trend: "UP" | "DOWN" | "FLAT" = "FLAT";
  if (trendRel >= 0.001) trend = e9 > e21 ? "UP" : "DOWN";

  const baseIdx = Math.max(0, idx - 96);
  const changeBase = cache.closes[baseIdx];
  const changePct24h = changeBase > 0 ? ((price - changeBase) / changeBase) * 100 : null;

  const lastTime = candles[idx].time;
  const anchor = Math.floor(lastTime / 86_400_000) * 86_400_000;
  let pv = 0;
  let vol = 0;
  let samples = 0;
  for (let i = idx; i >= 0; i--) {
    const c = candles[i];
    if (c.time < anchor) break;
    const tp = (c.high + c.low + c.close) / 3;
    const size = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    if (!Number.isFinite(tp) || tp <= 0) continue;
    pv += tp * size;
    vol += size;
    samples += 1;
  }
  let vwapPct: number | null = null;
  if (samples >= 2 && vol > 0 && Number.isFinite(pv)) {
    const vwap = pv / vol;
    if (Number.isFinite(vwap) && vwap > 0) {
      vwapPct = ((price - vwap) / vwap) * 100;
    }
  }

  const atrPctVal = cache.atrPct[idx];
  const adxVal = cache.adx14[idx];
  const bbwVal = cache.bbwPct[idx];
  const macdVal = cache.macd[idx];
  const macdSigVal = cache.macdSignal[idx];
  const macdHistVal = cache.macdHist[idx];

  return {
    symbol: symbol.toUpperCase(),
    ts: candles[idx].time,
    price,
    rsi14: cache.rsi14[idx] != null ? Number((cache.rsi14[idx] as number).toFixed(2)) : 50,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    trend,
    atrPct: atrPctVal != null ? Number((atrPctVal * 100).toFixed(2)) : null,
    adx14: adxVal != null ? Number(adxVal.toFixed(2)) : null,
    bbwPct: bbwVal != null ? Number((bbwVal * 100).toFixed(4)) : null,
    macd: macdVal != null ? Number(macdVal.toFixed(6)) : null,
    macdSignal: macdSigVal != null ? Number(macdSigVal.toFixed(6)) : null,
    macdHist: macdHistVal != null ? Number(macdHistVal.toFixed(6)) : null,
    vwapPct: vwapPct != null ? Number(vwapPct.toFixed(4)) : null,
    spreadPct: spread != null && Number.isFinite(spread) && spread >= 0 ? Number((spread * 100).toFixed(4)) : null,
    volume,
    volumeMa20: volumeMa,
    volumeRatio: volumeMa > 0 ? volume / volumeMa : 0,
    changePct24h: changePct24h != null ? Number(changePct24h.toFixed(2)) : null,
    priceVsEma21Pct: Number(priceVsEma21.toFixed(2)),
    priceVsEma50Pct: Number(priceVsEma50.toFixed(2)),
  };
}

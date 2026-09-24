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
 * MACD auf der rekursiven EMA dieser Datei (Seed = erster Schlusskurs,
 * nicht die Lehrbuch-SMA). Linie = EMA(fast) − EMA(slow), Signal =
 * EMA(signalPeriod) der Linie, Histogramm = Differenz.
 *
 * `null`, wenn die Perioden unsinnig sind oder weniger als
 * `slow + signalPeriod` Schlusskurse vorliegen — vorher wäre die langsame
 * EMA kaum vom Seed weg. Kein stilles 0.
 */
export interface MacdReading {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdReading | null {
  if (
    !Array.isArray(closes) ||
    !Number.isInteger(fast) || fast < 1 ||
    !Number.isInteger(slow) || slow <= fast ||
    !Number.isInteger(signalPeriod) || signalPeriod < 1 ||
    closes.length < slow + signalPeriod
  ) {
    return null;
  }
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = fastEma.map((value, i) => value - slowEma[i]);
  if (line.some((value) => !Number.isFinite(value))) return null;
  const signalEma = ema(line, signalPeriod);
  const macdValue = line[line.length - 1];
  const signalValue = signalEma[signalEma.length - 1];
  if (!Number.isFinite(macdValue) || !Number.isFinite(signalValue)) return null;
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
  };
}

/**
 * Bollinger-Band-Breite (Bandwidth) als Anteil des mittleren Kurses:
 * (Oberband − Unterband) / SMA = 2 × mult × σ / SMA.
 *
 * Das ist ein Bruch (0.05 = 5 %), nicht Prozent. Regel-Snapshots speichern
 * dieselbe Größe als `bbwPct` in Prozent, damit 5 im Regelwerk 5 % bedeutet
 * und nicht mit dem Dashboard-Key `adp.bbwHighPct` (Bruch, Max 0.5) verwechselt wird.
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

/**
 * Tagesanker für den Session-VWAP: Anfang der UTC-Kalendertagesscheibe, in
 * der `timeMs` liegt. Deterministisch und zeitzonenfrei — der Deal ist eine
 * dokumentierte Konvention, nicht die Lokalzeit des Servers. Für
 * Index-/Aktien-Sessions mit anderer Tagesgrenze kann der Aufrufer einen
 * expliziten Anker übergeben.
 */
export function utcDayAnchorMs(timeMs: number): number {
  if (!Number.isFinite(timeMs)) return 0;
  return Math.floor(timeMs / 86_400_000) * 86_400_000;
}

export interface VwapReading {
  /** Volumen-gewichteter Durchschnittskurs der Session. */
  vwap: number;
  /** Kurs der letzten Kerze gegen den VWAP in Prozent (1.5 = 1,5 % darüber). */
  priceVsVwapPct: number;
  /** Kerzen, die in die Rechnung eingegangen sind. */
  samples: number;
  /** Aufsummiertes Volumen der Session (0 ist kein gültiger VWAP → null). */
  totalVolume: number;
  /** Zeitstempel des Session-Ankers (Epoch-ms). */
  anchoredAt: number;
}

/**
 * Session-VWAP (Volume Weighted Average Price) aus Kerzen.
 *
 * Der VWAP ist DER Referenzkurs des Daytradings: über ihm gilt der Markt als
 * von Käufern kontrolliert, unter ihm von Verkäufern; Institutionen
 * messen ihre Fills daran. Er fehlt in dieser Engine komplett — alle
 * vorhandenen Felder vergleichen mit Zeitmittelwerten (EMA), nicht mit dem
 * volumen-gewichteten Tagesdurchschnitt. Deshalb dieses Feld und nicht noch
 * ein Oszillator.
 *
 * Rechnung (Standard, HLC3):
 *   tp_i  = (high + low + close) / 3
 *   vwap  = Σ(tp_i · volume_i) / Σ(volume_i)   über die Session-Kerzen
 *
 * Session = alle Kerzen ab {@link utcDayAnchorMs} des letzten Kerzenstempels,
 * oder ab einem expliziten `anchorMs`. Eine offene Kerze ist ausdrücklich
 * erlaubt (der VWAP lebt vom laufenden Tag); wer nur geschlossene Kerzen
 * will, schneidet sie vor dem Aufruf ab.
 *
 * `null` — nie eine 0 erfinden — bei: < 2 Kerzen, Nicht-Endlichen Werten,
 * oder Gesamtvolumen ≤ 0 (dünke Serien ohne Volumen sind kein VWAP).
 */
export function sessionVwap(
  candles: readonly Candle[],
  anchorMs?: number
): VwapReading | null {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const last = candles[candles.length - 1];
  if (!last || !Number.isFinite(last.time) || !Number.isFinite(last.close) || last.close <= 0) return null;
  const anchor =
    anchorMs !== undefined && Number.isFinite(anchorMs) ? anchorMs : utcDayAnchorMs(last.time);

  let pv = 0;
  let vol = 0;
  let samples = 0;
  for (const candle of candles) {
    if (!Number.isFinite(candle.time) || candle.time < anchor) continue;
    const tp = (candle.high + candle.low + candle.close) / 3;
    const size = Number.isFinite(candle.volume) && candle.volume > 0 ? candle.volume : 0;
    if (!Number.isFinite(tp) || tp <= 0) continue;
    // Kerzen ohne Volumen zählen im Nenner nicht mit; haben WIR gar kein
    // Volumen, gibt es keinen VWAP (Prüfung unten).
    pv += tp * size;
    vol += size;
    samples += 1;
  }
  if (samples < 2 || vol <= 0 || !Number.isFinite(pv)) return null;

  const vwap = pv / vol;
  if (!Number.isFinite(vwap) || vwap <= 0) return null;
  return {
    vwap,
    priceVsVwapPct: ((last.close - vwap) / vwap) * 100,
    samples,
    totalVolume: vol,
    anchoredAt: anchor,
  };
}

/**
 * Average Directional Index (Wilder) — TrendSTÄRKE ohne Richtungsbezug.
 *
 * Deterministische Referenzimplementierung (kein LLM, keine Bibliothek):
 *   1. Je Bar: +DM / −DM (Directional Movement) und TR (True Range).
 *   2. Wilder-Glättung als Summenrekursion: Start = Summe der ersten
 *      `period` Werte, danach S ← S − S/period + Wert.
 *   3. +DI/−DI = 100 · geglättete DM / geglättete TR; DX aus der
 *      Differenz; ADX = Wilder-geglätteter DX (Start = einfacher
 *      Mittelwert der ersten `period` DX-Werte).
 *
 * Liefert null bei unzureichender Historie (< 2·period + 1 Kerzen) oder
 * nicht-sinnvollen Werten. Referenz-/Handrechnungs-Test: tests/indicators.test.ts.
 */
export function adx(candles: Candle[], period = 14): number | null {
  if (!Array.isArray(candles) || period < 1 || candles.length < 2 * period + 1) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  // Wilder-Summenrekursion über die ersten `period` Bars.
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 0; i < period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }

  const dxAt = (): number => {
    if (!Number.isFinite(trS) || trS <= 0) return 0;
    const pdi = (100 * pS) / trS;
    const mdi = (100 * mS) / trS;
    const sum = pdi + mdi;
    return sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  };

  const dxs: number[] = [dxAt()];
  for (let i = period; i < tr.length; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    dxs.push(dxAt());
  }
  if (dxs.length < period) return null;

  let value = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    value = (value * (period - 1) + dxs[i]) / period;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Average True Range in Prozent des letzten Kurses. */
export function atrPct(candles: Candle[], period = 14): number | null {
  const absolute = atr(candles, period);
  if (absolute == null) return null;
  const last = candles[candles.length - 1].close;
  return last > 0 ? absolute / last : null;
}

/**
 * Average True Range in PREISEINHEITEN (einfache Wilder-Näherung: arithmetisches
 * Mittel der letzten `period` True-Range-Werte) — die Größe für das
 * Vol-basierte Position-Sizing (GAP-04, v1.48.0): `stop = entry − k·ATR`.
 *
 * trueRange(i) = max(high−low, |high−prevClose|, |low−prevClose|).
 * Liefert null bei unzureichender Historie (< period+1 Kerzen) oder
 * nicht-sinnvollen (nicht endlichen, ≤ 0) Werten — der Sizing-Pfad wertet
 * das als UNKNOWN (fail-closed), nie als stillen Wert.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (!Array.isArray(candles) || period < 1 || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (!Number.isFinite(tr) || tr < 0) return null;
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const value = slice.reduce((a, b) => a + b, 0) / slice.length;
  return Number.isFinite(value) && value > 0 ? value : null;
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

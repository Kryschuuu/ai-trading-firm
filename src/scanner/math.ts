/**
 * Numerik-Basis des Scanners — klein, pure, deterministisch.
 *
 * Grundregeln (gelten für **alle** Faktoren):
 *   - Eine Serie mit `NaN`, `Infinity` oder Preisen ≤ 0 ist **unbrauchbar**:
 *     die Funktion liefert `null`, der Faktor meldet `available: false`.
 *     Es wird nie interpoliert, geraten oder „repariert“.
 *   - Standardabweichungen sind **Populations**-Standardabweichungen (÷ n) —
 *     eine Konvention, konsistent über alle Faktoren, dokumentiert im
 *     Faktor-Katalog.
 *   - Jede Ausgabe läuft durch {@link roundTo}, damit Gleitkomma-Rauschen die
 *     Byte-Identität von Artefakten nicht bricht.
 */

import type { MarketCandle } from "@/lib/marketdata/types";

/** Anzahl Nachkommastellen, auf die Scanner-Ausgaben gerundet werden. */
export const OUTPUT_DECIMALS = 10;

/** Rundet deterministisch auf `decimals` Nachkommastellen (Half-away-from-zero). */
export function roundTo(value: number, decimals = OUTPUT_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  const scaled = value * f;
  // Math.round rundet -0.5 → -0; explizite Symmetrie ist reproduzierbarer.
  const r = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return r / f;
}

/** Klemmt einen Wert in `[0, 1]`; nicht-endliche Werte werden zu 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Klemmt einen Wert in `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** true, wenn der Wert eine endliche Zahl ist. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Lineare Normierung „größer = besser“: `min → 0`, `max → 1`.
 * Bei `max <= min` wird 0 geliefert (defensiv, keine Division durch 0).
 */
export function linearNorm(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !(max > min)) return 0;
  return clamp01((value - min) / (max - min));
}

/** Lineare Normierung „kleiner = besser“: `min → 1`, `max → 0`. */
export function inverseNorm(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !(max > min)) return 0;
  return clamp01(1 - (value - min) / (max - min));
}

/**
 * Logarithmische Normierung für Größen über mehrere Zehnerpotenzen
 * (Volumen, Open Interest): `min → 0`, `max → 1`, dazwischen `log10`-linear.
 */
export function logNorm(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || !(max > min) || min <= 0) return 0;
  return clamp01((Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)));
}

/**
 * Trapez-Normierung („Sweet Spot“): 0 unterhalb `floor`, linear ansteigend bis
 * `idealLow`, 1 zwischen `idealLow` und `idealHigh`, linear fallend bis
 * `ceiling`, danach 0.
 *
 * Wird für Faktoren genutzt, bei denen sowohl zu wenig als auch zu viel
 * schlecht ist (Volatilität, ATR).
 */
export function bandNorm(
  value: number,
  floor: number,
  idealLow: number,
  idealHigh: number,
  ceiling: number
): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= floor || value >= ceiling) return 0;
  if (value >= idealLow && value <= idealHigh) return 1;
  if (value < idealLow) return clamp01((value - floor) / (idealLow - floor));
  return clamp01((ceiling - value) / (ceiling - idealHigh));
}

/** Arithmetisches Mittel; leere Liste ⇒ `null`. */
export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / values.length;
}

/** Populations-Standardabweichung (÷ n); < 2 Werte ⇒ `null`. */
export function stdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  const variance = acc / values.length;
  return Number.isFinite(variance) ? Math.sqrt(Math.max(variance, 0)) : null;
}

/** Schließkurse einer Kerzenserie; `null`, sobald ein Wert unbrauchbar ist. */
export function closesOf(candles: readonly MarketCandle[]): number[] | null {
  const out: number[] = [];
  for (const c of candles) {
    if (!c || !Number.isFinite(c.close) || c.close <= 0) return null;
    out.push(c.close);
  }
  return out;
}

/**
 * Logarithmische Renditen `ln(c_t / c_{t-1})`.
 * Weniger als zwei Kurse oder ein unbrauchbarer Kurs ⇒ `null`.
 */
export function logReturns(closes: readonly number[]): number[] | null {
  if (closes.length < 2) return null;
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) return null;
    out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Exponentiell geglätteter Durchschnitt, `k = 2/(period+1)`, Seed = erster Wert.
 * Identische Konvention wie `src/lib/indicators.ts` (ein Verfahren im Repo).
 */
export function ema(values: readonly number[], period: number): number[] | null {
  if (!values.length || !(period >= 1)) return null;
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Letzter Wert einer Serie (oder `null` bei leerer Serie). */
export function last<T>(values: readonly T[]): T | null {
  return values.length ? values[values.length - 1] : null;
}

/** Multipliziert eine Perioden-Volatilität auf ein Jahr hoch: `σ × √periodsPerYear`. */
export function annualize(sigmaPerPeriod: number, periodsPerYear: number): number {
  return sigmaPerPeriod * Math.sqrt(periodsPerYear);
}

/** Schneidet die letzten `n` Elemente aus (n ≤ 0 ⇒ leere Liste). */
export function tail<T>(values: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  return values.slice(Math.max(0, values.length - n));
}

/**
 * Wilder-Glättung (RMA) einer Serie: Seed = Mittel der ersten `period` Werte,
 * danach `rma_t = (rma_{t-1} × (period − 1) + x_t) / period`.
 * Gibt den **letzten** geglätteten Wert zurück; `null` bei zu wenig Daten.
 */
export function wilderSmooth(values: readonly number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  let acc = 0;
  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(values[i])) return null;
    acc += values[i];
  }
  let rma = acc / period;
  for (let i = period; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    rma = (rma * (period - 1) + v) / period;
  }
  return Number.isFinite(rma) ? rma : null;
}

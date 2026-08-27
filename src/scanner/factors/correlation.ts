/**
 * **Faktor `correlation` — Gleichlauf mit dem Benchmark.**
 *
 * Formel: Kerzen von Instrument und Benchmark werden über den Zeitstempel
 * geschnitten (nur gemeinsame `time`-Werte), daraus logarithmische Renditen
 * gebildet und die letzten `lookback` Renditen korreliert:
 *
 * * Pearson: `r = Σ(x−x̄)(y−ȳ) / √(Σ(x−x̄)² · Σ(y−ȳ)²)`
 * * Spearman (optional): Pearson auf den **Rängen** (Ties = Durchschnittsrang)
 *
 * `raw = r ∈ [−1, 1]`.
 *
 * Normalisierung: `normalized = 1 − |r|` — belohnt wird
 * **Diversifikationsnutzen**, nicht die Richtung des Gleichlaufs.
 *
 * Datenbedarf: ≥ 3 gemeinsame Kerzen (2 Renditen) mit Benchmark-Serie.
 *
 * Hinweis: Die Korrelationsmathematik liegt bewusst hier lokal. Sobald Task 05
 * (Portfolio Analytics) eine geprüfte Implementierung bereitstellt, wird dieses
 * Modul auf diese Funktion umgestellt (kein zweiter Rechenweg im Repo).
 */
import type { MarketCandle } from "@/lib/marketdata/types";
import { logReturns, tail } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Benchmark: 0.5 — unbekannter Gleichlauf ist weder gut noch schlecht. */
export const CORRELATION_NEUTRAL = 0.5;

/** Pearson-Korrelationskoeffizient zweier gleich langer Serien (`null` bei σ = 0). */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return null;
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  if (!(denom > 0)) return null;
  const r = cov / denom;
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

/** Ränge einer Serie mit Durchschnittsrang bei Gleichstand (1-basiert). */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => (a.v - b.v) || (a.i - b.i));
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k].i] = averageRank;
    i = j + 1;
  }
  return out;
}

/** Spearman-Rangkorrelation (Pearson auf Rängen). */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  return pearson(ranks(x.slice(0, n)), ranks(y.slice(0, n)));
}

/** Schneidet zwei Kerzenserien auf gemeinsame Zeitstempel (aufsteigend). */
export function alignByTime(
  a: readonly MarketCandle[],
  b: readonly MarketCandle[]
): { left: number[]; right: number[] } {
  const rightByTime = new Map<number, number>();
  for (const c of b) {
    if (Number.isFinite(c.time) && Number.isFinite(c.close) && c.close > 0) rightByTime.set(c.time, c.close);
  }
  const left: number[] = [];
  const right: number[] = [];
  for (const c of a) {
    if (!Number.isFinite(c.time) || !Number.isFinite(c.close) || c.close <= 0) continue;
    const match = rightByTime.get(c.time);
    if (match !== undefined) {
      left.push(c.close);
      right.push(match);
    }
  }
  return { left, right };
}

/** Korrelations-Faktor (Score-Gewicht 5 %). */
export const correlationFactor: Factor = {
  id: "correlation",
  label: "Korrelation zum Benchmark",
  neutral: CORRELATION_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.correlation;
    const benchmark = input.benchmarkCandles;
    if (!benchmark || benchmark.length < 3) {
      return unavailable("correlation", CORRELATION_NEUTRAL, "keine Benchmark-Serie", {
        benchmarkInstrumentId: cfg.benchmarkInstrumentId,
      });
    }
    const { left, right } = alignByTime(input.candles, benchmark);
    if (left.length < 3) {
      return unavailable("correlation", CORRELATION_NEUTRAL, `zu wenig gemeinsame Kerzen (${left.length})`, {
        benchmarkInstrumentId: cfg.benchmarkInstrumentId,
      });
    }
    const rl = logReturns(left);
    const rr = logReturns(right);
    if (!rl || !rr) return unavailable("correlation", CORRELATION_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    const x = tail(rl, cfg.lookback);
    const y = tail(rr, cfg.lookback);
    const r = cfg.method === "spearman" ? spearman(x, y) : pearson(x, y);
    if (r === null) {
      return unavailable("correlation", CORRELATION_NEUTRAL, "Korrelation undefiniert (σ = 0)", {
        benchmarkInstrumentId: cfg.benchmarkInstrumentId,
        method: cfg.method,
      });
    }
    return factorValue("correlation", {
      raw: r,
      normalized: 1 - Math.abs(r),
      reason: `${cfg.method === "spearman" ? "Spearman" : "Pearson"} ${r.toFixed(3)} vs. ${cfg.benchmarkInstrumentId}`,
      detail: { method: cfg.method, periods: x.length, benchmarkInstrumentId: cfg.benchmarkInstrumentId },
    });
  },
};

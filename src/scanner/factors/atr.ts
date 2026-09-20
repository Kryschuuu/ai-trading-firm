/**
 * **Faktor `atr` — Average True Range (Stop-Abstände).**
 *
 * Formel: `TR_t = max(high−low, |high−close_{t−1}|, |low−close_{t−1}|)`,
 * `ATR = Wilder-RMA(TR, period)` (Seed = Mittel der ersten `period` TRs),
 * `raw = ATR / letzter Close` (ATR in Prozent des Kurses).
 *
 * Normalisierung: Trapez („Sweet Spot“) — unterhalb `floorPct` bewegt sich der
 * Markt zu wenig für sinnvolle Stops, oberhalb `ceilingPct` müssten Stops
 * unwirtschaftlich weit stehen.
 *
 * Datenbedarf: ≥ `period + 1` Kerzen mit `high/low/close`.
 *
 * Diagnose-Faktor: fließt **nicht** in die neun Score-Komponenten, sondern in
 * Stop-Abstände, Positionsgrößen und die Weekly-Begründungen.
 */
import { bandNorm, wilderSmooth } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const ATR_NEUTRAL = 0;

/**
 * True Ranges einer Kerzenreihe (Wilder-Definition, identisch zum Faktor).
 *
 * `null` bei unbrauchbarer Reihe (nicht-endliche Werte oder `close ≤ 0`) —
 * bewusst kein Teilergebnis: eine Reihe mit einem kaputten Bar ist als Ganzes
 * nicht vertrauenswürdig (fail-closed).
 *
 * Wird seit v1.53.0 auch vom Point-in-Time Feature Store genutzt
 * (`src/features/compute.ts`), damit Faktor und Feature **dieselbe** Formel
 * ausführen und nicht auseinanderdriften (Paritätstest in
 * `tests/featureStore.test.ts`).
 */
export function trueRangesOf(candles: readonly { high: number; low: number; close: number }[]): number[] | null {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    if (
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      !Number.isFinite(prevClose) ||
      c.close <= 0
    ) {
      return null;
    }
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return trs;
}

/**
 * ATR als Anteil des letzten Schlusskurses (`ATR / close`).
 *
 * Einzige Implementierung dieser Kennzahl: Sie wird sowohl vom Faktor `atr`
 * (unten) als auch vom Point-in-Time Feature Store
 * (`scanner.atr@1`, `src/features/compute.ts`) verwendet. Damit ist die
 * Offline/Online-Parität **strukturell** — es gibt keine zweite Formel, die
 * auseinanderdriften könnte. Rückgabe `null`, wenn die Reihe zu kurz, nicht
 * endlich oder nicht berechenbar ist (kein geratener Ersatzwert).
 */
export function computeAtrPct(
  candles: readonly { high: number; low: number; close: number }[],
  period: number
): number | null {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = trueRangesOf(candles);
  if (trs === null) return null;
  const atr = wilderSmooth(trs, period);
  const lastClose = candles[candles.length - 1].close;
  if (atr === null || !Number.isFinite(lastClose) || lastClose <= 0) return null;
  return atr / lastClose;
}

/** ATR-Faktor (Diagnose, kein Score-Gewicht). */
export const atrFactor: Factor = {
  id: "atr",
  label: "ATR (Average True Range)",
  neutral: ATR_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.atr;
    const candles = input.candles;
    if (candles.length < cfg.period + 1) {
      return unavailable("atr", ATR_NEUTRAL, `zu wenig Kerzen (${candles.length} < ${cfg.period + 1})`);
    }
    const trs = trueRangesOf(candles);
    if (trs === null) {
      return unavailable("atr", ATR_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    }
    const atr = wilderSmooth(trs, cfg.period);
    const lastClose = candles[candles.length - 1].close;
    if (atr === null || lastClose <= 0) {
      return unavailable("atr", ATR_NEUTRAL, "ATR nicht berechenbar");
    }
    const atrPct = computeAtrPct(candles, cfg.period);
    if (atrPct === null) {
      // Kann nach den Vorprüfungen oben nicht eintreten; wenn doch, ist die
      // Reihe inkonsistent und es wird kein Wert erfunden.
      return unavailable("atr", ATR_NEUTRAL, "ATR nicht berechenbar");
    }
    return factorValue("atr", {
      raw: atrPct,
      normalized: bandNorm(atrPct, cfg.floorPct, cfg.idealLowPct, cfg.idealHighPct, cfg.ceilingPct),
      reason: `ATR ${(atrPct * 100).toFixed(2)} % des Kurses`,
      detail: { atrAbsolute: atr, lastClose, period: cfg.period },
    });
  },
};

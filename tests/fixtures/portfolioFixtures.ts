/**
 * Fixtures für die Portfolio-Tests (Task 05).
 *
 * Alles deterministisch: Kursreihen sind explizit ausgeschrieben oder werden
 * aus einem **geseedeten** PRNG (`createRng`, Task 03) erzeugt — kein
 * `Math.random`, keine Uhr, kein Netzwerk.
 *
 * Die Referenzwerte in den Golden-Tests wurden unabhängig in Python
 * (ohne Bibliotheken, eigene Implementierung derselben Formeln) nachgerechnet;
 * die Rechnungen sind in den Tests als Kommentar hinterlegt.
 */
import { createRng } from "../../src/lib/marketdata/prng";
import type { CandleLike, SeriesInput } from "../../src/portfolio/types";

/** Zehn Schlusskurse für die Kennzahlen-Goldens (9 logarithmische Renditen). */
export const GOLDEN_PRICES = [100, 102, 101, 105, 103, 110, 108, 112, 115, 113];

/** 16 Kerzen (high/low/close) für die ATR-Goldens. */
export const GOLDEN_CANDLES: CandleLike[] = (() => {
  const closes = [100, 101, 99, 102, 104, 103, 105, 107, 106, 108, 107, 109, 110, 108, 111, 112];
  return closes.map((close) => ({ high: close + 1.5, low: close - 1.5, close }));
})();

/** Bekannte Pearson-/Spearman-Datensätze. */
export const PEARSON_X = [1, 2, 3, 4, 5];
export const PEARSON_Y = [2.1, 3.9, 6.2, 7.8, 10.4];
/** Spearman-Datensatz **mit** Gleichständen (Ränge 2.5 / 2.5). */
export const TIED_X = [1, 2, 2, 4, 5];
export const TIED_Y = [10, 20, 15, 40, 50];

/** Zwei Renditeserien für Kovarianz-Goldens. */
export const COV_A = [0.01, -0.02, 0.03, 0.005, -0.01];
export const COV_B = [0.02, 0.01, -0.01, 0.03, 0.0];

/**
 * Deterministisches Ein-Faktor-Modell:
 * `r_it = β_i · f_t + ε_it` mit `β_i ∈ [0.5, 1.5]`, `f_t ~ U(−1 %, 1 %)`,
 * `ε_it ~ U(−0.5 %, 0.5 %)`. Erzeugt eine positiv definite Kovarianzmatrix.
 */
export function factorReturns(assets: number, periods: number, seed = 20260827): number[][] {
  const rng = createRng(seed);
  const betas = Array.from({ length: assets }, () => 0.5 + rng());
  const factors = Array.from({ length: periods }, () => (rng() - 0.5) * 0.02);
  const columns: number[][] = Array.from({ length: assets }, () => []);
  for (let i = 0; i < assets; i++) {
    for (let t = 0; t < periods; t++) {
      columns[i].push(betas[i] * factors[t] + (rng() - 0.5) * 0.01);
    }
  }
  return columns;
}

/** Deterministische Symbolnamen (`A0 … A{n−1}`). */
export function symbols(n: number, prefix = "A"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** Baut `SeriesInput` aus Log-Renditen. */
export function seriesFrom(columns: readonly (readonly number[])[], prefix = "A"): SeriesInput[] {
  return columns.map((logReturns, i) => ({ symbol: `${prefix}${i}`, logReturns: logReturns.slice() }));
}

/**
 * Fünf schwach korrelierte Serien — das Standard-Universum der Guard-Tests
 * (mit dem Default-Limit von 20 % je Instrument sind fünf Assets nötig, damit
 * die Gewichtssumme 1 erreichbar ist).
 */
export function fiveWeaklyCorrelatedSeries(periods = 40, seed = 7): SeriesInput[] {
  const columns = factorReturns(5, periods, seed);
  return seriesFrom(columns, "W");
}

/**
 * Drei hochkorrelierte Serien (`|ρ| ≈ 1`): `s2 = 1.1·s1`, `s3 = 0.9·s1 + Rauschen`.
 * Dient den Cluster-/Ablehnungstests der Risk Guard.
 */
export function threeHighlyCorrelatedSeries(periods = 40, seed = 11): SeriesInput[] {
  const rng = createRng(seed);
  const base = Array.from({ length: periods }, () => (rng() - 0.5) * 0.02);
  const s1 = base;
  const s2 = base.map((v) => v * 1.1);
  const s3 = base.map((v) => v * 0.9 + (rng() - 0.5) * 0.0005);
  return seriesFrom([s1, s2, s3], "H");
}

/** Feste Uhr für Audit-Zeitstempel (Determinismus in Tests). */
export const FIXED_NOW = "2026-08-27T00:00:00.000Z";
/** Uhr-Funktion mit festem Zeitpunkt. */
export function fixedClock(): () => Date {
  return () => new Date(FIXED_NOW);
}

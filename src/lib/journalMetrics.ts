/**
 * MAE/MFE-Berechnung für das Trade-Journal (GAP-03, v1.43.0, D2).
 *
 * Rein und deterministisch (keine I/O, keine Uhr, kein Zufall): Die Kerzen
 * werden vom Aufrufer geladen (`src/lib/journal.ts` ← Historical Store) und
 * hier nur maskiert, auf Lücken geprüft und ausgewertet.
 *
 * Definition (relativ zum Entry, in PROZENT-DEZIMAL, z. B. −0.03 = −3 %):
 *
 * UNEINHEITLICHES Vorzeichen gibt es bewusst nicht: MAE/MFE sind immer das
 * P&L DES EXCURSIONS-PREISES (relativ zum Entry), identisch definiert für
 * beide Seiten:
 *
 *   LONG:  MAE = min (low  − entry) / entry      (P&L am niedrigsten Kurs; ≤ 0)
 *          MFE = max (high − entry) / entry      (P&L am höchsten Kurs;  ≥ 0)
 *   SHORT (gespiegelt):
 *          MAE = min (entry − high) / entry      (P&L am höchsten Kurs;    ≤ 0 bei Verlust)
 *          MFE = max (entry − low)  / entry      (P&L am niedrigsten Kurs; ≥ 0 bei Gewinn)
 *
 * Zeitmaske: nur Kerzen mit Intervallstart `ts` im Bereich
 * [openedAtMs, closedAtMs] (inklusiv) — Intervalle ≤ Exit-Zeit und
 * ≥ Eröffnungszeit (GAP-03, D2). Kerzen, die vor der Eröffnung begannen,
 * werden bewusst NICHT mitgezogen (konservativ: der Excursion wird eher
 * unter- als überschätzt).
 *
 * Lücken: zwischen zwei aufeinanderfolgenden (nach ts sortierten)
 * maskierten Kerzen darf höchstens ein Intervall (timeframeMs) liegen.
 * Eine größere Lücke heißt, dass Excursions im Dunkeln passiert sein
 * können — die Metriken bleiben null und das Ergebnis trägt das Flag
 * `CANDLE_GAP` (kein Qualitätsbefund-Handling in diesem PR; NICHT schätzen).
 * Keine Kerzen im Fenster → `NO_DATA`, null.
 */

export interface CandleLike {
  /** Unix-Epoch (ms) des Intervallstarts. */
  ts: number;
  high: number;
  low: number;
}

/** Datenqualität des MAE/MFE-Ergebnisses (journal.quality-Spalte). */
export type MetricsQuality = "OK" | "CANDLE_GAP" | "NO_DATA";

export interface MaeMfeResult {
  /** Ungünstigster Excursion in Dezimal (LONG: ≤ 0), null bei NO_DATA/GAP. */
  maePct: number | null;
  /** Günstigster Excursion in Dezimal (LONG: ≥ 0), null bei NO_DATA/GAP. */
  mfePct: number | null;
  quality: MetricsQuality;
  /** Anzahl maskierter, lückenloser Kerzen (Diagnostics). */
  candlesUsed: number;
}

export interface MaeMfeInput {
  candles: readonly CandleLike[];
  side: "LONG" | "SHORT";
  entryPrice: number;
  openedAtMs: number;
  closedAtMs: number;
  timeframeMs: number;
}

/**
 * Berechnet MAE/MFE aus maskierten Kerzen (siehe Modul-TSDoc).
 * Wirft nur bei strukturell ungültiger Eingabe (kein endlicher Entry > 0,
 * kein endliches Fenster) — inhaltlich ungültige Kerzen (NaN/≤0) werden
 * gezählt und übersprungen, nie der Lauf gebrochen.
 */
export function computeMaeMfe(input: MaeMfeInput): MaeMfeResult {
  const { side, entryPrice, openedAtMs, closedAtMs, timeframeMs } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`computeMaeMfe: entryPrice muss endlich und > 0 sein (war ${String(entryPrice)})`);
  }
  if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs) || closedAtMs < openedAtMs) {
    throw new Error(
      `computeMaeMfe: ungültiges Fenster (openedAtMs=${String(openedAtMs)}, closedAtMs=${String(closedAtMs)})`
    );
  }
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) {
    throw new Error(`computeMaeMfe: timeframeMs muss endlich und > 0 sein (war ${String(timeframeMs)})`);
  }

  // 1) Zeitmaske: Intervallstart ∈ [openedAtMs, closedAtMs].
  const masked = (input.candles ?? [])
    .filter((c) => {
      if (!c || typeof c.ts !== "number" || !Number.isFinite(c.ts)) return false;
      if (c.ts < openedAtMs || c.ts > closedAtMs) return false;
      if (!Number.isFinite(c.high) || !Number.isFinite(c.low) || c.high <= 0 || c.low <= 0) return false;
      return true;
    })
    .sort((a, b) => a.ts - b.ts);

  if (masked.length === 0) {
    return { maePct: null, mfePct: null, quality: "NO_DATA", candlesUsed: 0 };
  }

  // 2) Lückenprüfung: aufeinanderfolgende Starts höchstens 1 Intervall apart.
  for (let i = 1; i < masked.length; i++) {
    if (masked[i].ts - masked[i - 1].ts > timeframeMs) {
      return { maePct: null, mfePct: null, quality: "CANDLE_GAP", candlesUsed: masked.length };
    }
  }

  // 3) Excursions (Long: low ungunstig / high günstig; Short gespiegelt).
  let mae: number | null = null;
  let mfe: number | null = null;
  for (const c of masked) {
    const excursionLow = (c.low - entryPrice) / entryPrice; // < 0 ungunstig bei Long
    const excursionHigh = (c.high - entryPrice) / entryPrice; // > 0 günstig bei Long
    if (side === "LONG") {
      if (mae === null || excursionLow < mae) mae = excursionLow;
      if (mfe === null || excursionHigh > mfe) mfe = excursionHigh;
    } else {
      // SHORT: ungunstig = Kurs ÜBER Entry (high), günstig = Kurs UNTER Entry (low).
      // P&L-Vorzeichen wie bei LONG: MAE ≤ 0 (Verlust am höchsten Kurs),
      // MFE ≥ 0 (Gewinn am niedrigsten Kurs).
      const maeCandidate = (entryPrice - c.high) / entryPrice;
      const mfeCandidate = (entryPrice - c.low) / entryPrice;
      if (mae === null || maeCandidate < mae) mae = maeCandidate;
      if (mfe === null || mfeCandidate > mfe) mfe = mfeCandidate;
    }
  }

  return { maePct: mae, mfePct: mfe, quality: "OK", candlesUsed: masked.length };
}

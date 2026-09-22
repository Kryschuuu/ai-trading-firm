/**
 * Point-in-Time-Momentum-Kern (RMA-P2-04) — pure Funktionen, keine I/O.
 *
 * ── Formeln ─────────────────────────────────────────────────────────────────
 * Gegeben eine Serie geschlossener, cutoff-sichtbarer Kerzen
 * `B = [b_0 … b_m]` (aufsteigend nach `ts`, `barEnd_i = ts_i + timeframeMs`)
 * und ein Horizont `(L = lookback, S = skip)`:
 *
 *   endIdx   = m
 *   baseCut  = asOf − (L + S) × timeframeMs
 *   baseIdx  = größtes i mit barEnd_i ≤ baseCut        (sonst nicht berechenbar)
 *   span     = endIdx − baseIdx;  erforderlich: span ≥ L  (Lücken-Guard)
 *
 *   totalReturn     = close[endIdx] / close[baseIdx] − 1
 *   r_j             = ln(close[j] / close[j−1]), j = baseIdx+1 … endIdx
 *   σ_window        = Populations-Standardabweichung der r_j (÷ span)
 *   volAdjusted     = span ≥ minVolReturns ∧ σ_window > minZStd
 *                     ? totalReturn / (σ_window × √span) : null
 *
 * `volAdjusted` ist die Fenster-Rendite in Einheiten ihrer eigenen (nicht
 * annualisierten) Fenstervolatilität — Sharpe-artig und dimensionslos.
 * Eine flache Reihe (σ = 0) liefert `null`, **nicht** 0: ein fehlender
 * Denominator ist ein nicht berechenbarer Wert, kein neutraler Wert.
 *
 * ── Look-ahead-Garantie ─────────────────────────────────────────────────────
 * {@link pitVisibleCandles} ist die einzige Stelle, die eine Kerze für einen
 * Cutoff freigibt: `barEnd ≤ asOf` UND (Policy `ingested`)
 * `fetchedAtMs ≤ asOf`. Alles andere im Modul konsumiert ausschließlich
 * diese Funktion — spätere Daten können einen historischen Snapshot
 * strukturell nicht berühren.
 */

import type {
  AvailabilityPolicy,
  CrossSectionalConfig,
  HorizonReturn,
  MomentumCandle,
} from "./types";
import { isFiniteNumber, roundTo } from "./math";

/** Per-Call-Validierter Cutoff-Kontext (einmal geprüft, oft genutzt). */
export interface CutoffContext {
  asOf: number;
  tfMs: number;
  policy: AvailabilityPolicy;
}

/** Prüft den Cutoff-Kontext (asOf/tfMs positiv und endlich, Politik erlaubt). */
export function assertCutoffContext(ctx: CutoffContext): void {
  if (!isFiniteNumber(ctx.asOf) || ctx.asOf <= 0) {
    throw new Error("assertCutoffContext: asOf muss eine positive endliche Epoch-ms-Zahl sein");
  }
  if (!isFiniteNumber(ctx.tfMs) || ctx.tfMs <= 0) {
    throw new Error("assertCutoffContext: timeframeMs muss eine positive endliche Zahl sein");
  }
}

/**
 * Liefert die Kerzen, die am Cutoff **sichtbar** waren (Look-ahead-Guard):
 *   - Kerze geschlossen: `ts + tfMs ≤ asOf`,
 *   - Politik `ingested`: zusätzlich `fetchedAtMs ≤ asOf`,
 *   - Politik `bar_close`: nur die Schließungsbedingung (Replay-Annahme
 *     eines vollständigen Datensatzes — Forschungsmodus, nicht Default).
 *
 * Ungültige Kerzen (nicht-endliche/preislose/ts-negative Werte) werden
 * **verworfen und gezählt**, nie still „repariert". Entscheidend für die
 * Point-in-Time-Korrektur: gezählt wird nur `invalidAtCutoff` — ungültige
 * Kerzen, die am Cutoff HÄTTEN bekannt sein müssen (geschlossen und bei
 * `ingested` bis `asOf` ingested). Ein später nachlieferter kaputter Backfill
 * (fetchedAt > asOf) verunreinigt einen historischen Snapshot NICHT
 * (er war damals schlicht noch unbekannt). Ergebnis ist ts-aufsteigend
 * sortiert (neue Array-Kopie; die Eingabe wird nicht mutiert).
 */
export function pitVisibleCandles(
  candles: readonly MomentumCandle[],
  ctx: CutoffContext,
): { visible: MomentumCandle[]; invalidAtCutoff: number } {
  assertCutoffContext(ctx);
  const visible: MomentumCandle[] = [];
  let invalidAtCutoff = 0;
  for (const c of candles) {
    const valid =
      c !== null &&
      typeof c === "object" &&
      isFiniteNumber(c.ts) &&
      c.ts > 0 &&
      isFiniteNumber(c.close) &&
      c.close > 0 &&
      isFiniteNumber(c.fetchedAtMs) &&
      c.fetchedAtMs > 0;
    if (!valid) {
      // Ist diese kaputte Kerze am Cutoff „hätte bekannt" sein müssen?
      const ts = c && typeof c === "object" ? (c as { ts?: unknown }).ts : undefined;
      const fetched = c && typeof c === "object" ? (c as { fetchedAtMs?: unknown }).fetchedAtMs : undefined;
      const knownAtCutoff =
        isFiniteNumber(ts) &&
        ts > 0 &&
        (ts as number) + ctx.tfMs <= ctx.asOf &&
        (ctx.policy === "bar_close" || (isFiniteNumber(fetched) && (fetched as number) <= ctx.asOf));
      if (knownAtCutoff) invalidAtCutoff += 1;
      continue;
    }
    if (c.ts + ctx.tfMs > ctx.asOf) continue; // nicht geschlossen am Cutoff
    if (ctx.policy === "ingested" && c.fetchedAtMs > ctx.asOf) continue; // erst später bekannt
    visible.push(c);
  }
  visible.sort((a, b) => a.ts - b.ts || (a.fetchedAtMs < b.fetchedAtMs ? -1 : a.fetchedAtMs > b.fetchedAtMs ? 1 : 0));
  return { visible, invalidAtCutoff };
}

/**
 * Berechnet die Momentum-Rendite EINES Horizonts aus der cutoff-sichtbaren
 * Serie (Formeln im Modulkopf). Liefert `available: false` + Grund, wenn
 * die Datenlage nicht reicht — nie eine `0`-Substitution.
 */
export function horizonReturn(
  visible: readonly MomentumCandle[],
  horizon: { lookback: number; skip: number },
  ctx: CutoffContext,
  minVolReturns: number,
): HorizonReturn {
  const m = visible.length - 1;
  if (m < 1) {
    return { total: null, volAdjusted: null, barsUsed: 0, available: false, reason: "NO_BARS_AT_CUTOFF" };
  }
  const baseCut = ctx.asOf - (horizon.lookback + horizon.skip) * ctx.tfMs;
  // baseIdx: größtes i mit barEnd_i ≤ baseCut (von hinten gesucht — die
  // Serie ist ts-sorted, die Basis liegt immer vor dem Ende).
  let baseIdx = -1;
  for (let i = m; i >= 0; i--) {
    if (visible[i].ts + ctx.tfMs <= baseCut) {
      baseIdx = i;
      break;
    }
  }
  if (baseIdx < 0) {
    return { total: null, volAdjusted: null, barsUsed: 0, available: false, reason: "INSUFFICIENT_HISTORY" };
  }
  const span = m - baseIdx;
  if (span < horizon.lookback) {
    // Lücken-Guard: das Fenster ist kürzer als der nominelle Rückblick —
    // zu viele fehlende Kerzen, die Rendite wäre nicht mit dem Horizont
    // vergleichbar. Fail-closed statt stillen Stretches.
    return { total: null, volAdjusted: null, barsUsed: 0, available: false, reason: "INSUFFICIENT_HISTORY" };
  }
  const cEnd = visible[m].close;
  const cBase = visible[baseIdx].close;
  const total = cEnd / cBase - 1;

  // Fenstervolatilität über die Bar-Log-Renditen im Fenster.
  let volAdjusted: number | null = null;
  if (span >= minVolReturns) {
    const returns: number[] = [];
    for (let j = baseIdx + 1; j <= m; j++) {
      const prev = visible[j - 1].close;
      const cur = visible[j].close;
      if (!(prev > 0) || !(cur > 0)) break; // Doppelguard (Store-Garantie: Preise > 0)
      returns.push(Math.log(cur / prev));
    }
    if (returns.length === span) {
      const meanR = returns.reduce((acc, v) => acc + v, 0) / returns.length;
      let acc = 0;
      for (const r of returns) {
        const d = r - meanR;
        acc += d * d;
      }
      const sigma = Math.sqrt(acc / returns.length);
      if (sigma > 1e-15) {
        volAdjusted = total / (sigma * Math.sqrt(span));
      }
      // sigma ≤ 1e-15 ⇒ flache Reihe ⇒ volAdjusted bleibt null (fail-closed).
    }
  }

  return {
    total: roundTo(total),
    volAdjusted: volAdjusted === null ? null : roundTo(volAdjusted),
    barsUsed: span + 1,
    available: true,
    reason: null,
  };
}

/**
 * Maximales Fenster in ms über alle Horizonte (für Eligibility- und
 * Data-Hash-Berechnung: welche Kerzen zählten „zum Lauf").
 */
export function maxWindowMs(config: Pick<CrossSectionalConfig, "horizons">, tfMs: number): number {
  let max = 0;
  for (const h of config.horizons) max = Math.max(max, (h.lookback + h.skip) * tfMs);
  return max;
}

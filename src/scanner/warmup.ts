/**
 * Deterministischer Warmup-Bedarf und Readiness-Bewertung des Markt-Scanners
 * (OPS-009 / P1).
 *
 * Zwei getrennte Anliegen, eine Quelle der Wahrheit:
 *
 *  1. {@link requiredWarmupCandles} — die **einzige** Herleitung des
 *     Warmup-Bedarfs aus der Faktor-Konfiguration. Kein hartcodierter Wert.
 *  2. {@link assessDataReadiness} — eine **reine** Funktion, die den expliziten
 *     Readiness-Zustand (`READY | WARMING | ERROR`) berechnet.
 *
 * Beide sind ohne I/O, ohne Uhr und ohne Netzwerk — deterministisch und
 * testbar. Sie leben absichtlich vor der Funnel-Auswertung, damit Konsumenten
 * Infrastruktur- von Fachablehnung unterscheiden können.
 */

import type { MarketCandle } from "@/lib/marketdata/types";
import type { MarketInstrument } from "@/universe/types";
import type { ScannerConfig } from "./config";
import type { ReadinessFailure, ReadinessOffender, ScannerReadiness } from "./readiness";

/**
 * Absolute Obergrenze des abgeleiteten Warmup-Bedarfs (Security).
 *
 * `requiredWarmupCandles` fließt in Request-Limits (candleLimit) ein. Eine
 * fehlerhafte Config (z. B. `momentum.lookbacks: [999999]`) darf **kein**
 * Massen-Fetching auslösen. Die Faktor-Validierung begrenzt Lookbacks bereits
 * auf ≤ 5000 je Feld; hier zieht der Scanner zusätzlich eine harte Kappe.
 */
export const MAX_WARMUP_CANDLES = 1000;

/** Anzahl der schlimmsten Offender, die im `WARMING`-Zustand ausgewiesen werden. */
export const MAX_WORST_OFFENDERS = 10;

/**
 * Minimale Anzahl historischer Kerzen, die der konfigurierte Faktorsatz
 * benoetigt, damit ALLE Faktoren vollstaendig (ohne Padding) berechnet werden
 * koennen.
 *
 * Herleitung bei Default-Konfiguration:
 *   trend.slowPeriod        = 50          -> EMA50 braucht 50 Kerzen
 *   momentum.lookbacks      = [5,20,60]   -> 60er-Lookback braucht 61 Kerzen (n+1)
 *   drawdown.lookback       = 60          -> laufendes Maximum ueber 60 Perioden
 *   volatility.lookback + 1 = 30 + 1 = 31 -> Returns benoetigen eine Kerze mehr als Preise
 *   volumeRatio.basePeriods = 20          -> Referenz-Durchschnitt ueber 20 Perioden
 * => Math.max(50, 60, 60, 31, 20) + 1 = 61 bei aktuellen Defaults.
 *
 * Der Wert wird NIE hartcodiert. Wer einen Faktor-Lookback erhoeht, erhoeht
 * damit automatisch den Warmup-Bedarf. Das Ergebnis ist zusaetzlich auf
 * {@link MAX_WARMUP_CANDLES} gedeckelt (Security: kein Massen-Fetching bei
 * fehlerhafter Config).
 *
 * @throws {Error} wenn ein einfliessender Lookback keine positive Ganzzahl ist
 *   (defensive Absicherung; die Config-Validierung faengt das normalerweise ab).
 */
export function requiredWarmupCandles(config: ScannerConfig): number {
  const f = config.factors;
  const requirements = [
    f.trend.slowPeriod,
    ...f.momentum.lookbacks,
    f.drawdown.lookback,
    f.volatility.lookback + 1,
    f.volumeRatio.basePeriods,
  ];
  for (const value of requirements) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `requiredWarmupCandles: Faktor-Lookback muss eine positive Ganzzahl sein (war ${String(value)})`,
      );
    }
  }
  return Math.min(Math.max(...requirements) + 1, MAX_WARMUP_CANDLES);
}

/** Eingabe der Readiness-Bewertung. */
export interface DataReadinessInput {
  /** Zu bewertende Instrumente. */
  instruments: readonly MarketInstrument[];
  /** Geladene Kerzen je Instrument-ID. */
  historyByInstrument: Map<string, readonly MarketCandle[]>;
  /** Warmup-Bedarf (aus {@link requiredWarmupCandles}). */
  requiredCandles: number;
  /** Echte Fetch-/Infrastruktur-Fehler je Instrument-ID (aus MDERR-006). */
  dataErrors?: ReadonlyMap<string, string>;
}

/**
 * Bewertet die Datenlage eines Universums deterministisch.
 *
 * Regeln:
 *  - `dataErrors` nicht leer  -> `ERROR` (Infrastruktur schlaegt Fachlogik).
 *  - sonst: `warmed` = Anzahl Instrumente mit `candles.length >= requiredCandles`.
 *    - `warmed === instruments.length` -> `READY`
 *    - sonst                            -> `WARMING` (+ worstOffenders)
 *  - `worstOffenders` deterministisch sortiert (candles asc, dann instrumentId
 *    asc), auf {@link MAX_WORST_OFFENDERS} begrenzt.
 *
 * Reine Funktion: kein I/O, keine Zeitabhaengigkeit, keine Mutation der
 * Eingaben.
 */
export function assessDataReadiness(input: DataReadinessInput): ScannerReadiness {
  const { instruments, historyByInstrument, requiredCandles, dataErrors } = input;

  if (dataErrors && dataErrors.size > 0) {
    const failures: ReadinessFailure[] = [...dataErrors.entries()]
      .map(([instrumentId, reason]) => ({ instrumentId, reason: sanitizeReason(reason) }))
      .sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
    return {
      status: "ERROR",
      error: `${failures.length} Instrument(e) mit Datenfehler — Marktdaten-Infrastruktur pruefen (kein Marktausschluss).`,
      failures,
    };
  }

  const total = instruments.length;
  let warmed = 0;
  const offenders: ReadinessOffender[] = [];

  for (const instrument of instruments) {
    const candles = historyByInstrument.get(instrument.id)?.length ?? 0;
    if (candles >= requiredCandles) {
      warmed += 1;
    } else {
      offenders.push({ instrumentId: instrument.id, candles });
    }
  }

  const missing = total - warmed;

  if (missing === 0) {
    return { status: "READY", instruments: total, warmed, missing: 0, requiredCandles };
  }

  offenders.sort((a, b) =>
    a.candles !== b.candles
      ? a.candles - b.candles
      : a.instrumentId < b.instrumentId
        ? -1
        : a.instrumentId > b.instrumentId
          ? 1
          : 0,
  );

  return {
    status: "WARMING",
    instruments: total,
    warmed,
    missing,
    requiredCandles,
    worstOffenders: offenders.slice(0, MAX_WORST_OFFENDERS),
  };
}

/**
 * Baut die erklaerende `min-candles`-Rejection-Message. Sie nennt die Herkunft
 * des Schwellwerts (dominanter Momentum-Lookback + EMA) und macht klar, dass es
 * sich um ein Datenverfuegbarkeits-, kein Marktqualitaetsproblem handelt.
 */
export function minCandlesRejectionMessage(candleCount: number, config: ScannerConfig): string {
  const required = requiredWarmupCandles(config);
  const momentumMax = Math.max(...config.factors.momentum.lookbacks);
  return (
    `min-candles: ${candleCount}/${required} Kerzen. Benoetigt werden ${required} Kerzen, weil der ` +
    `konfigurierte Faktorsatz einen Momentum-Lookback von ${momentumMax} Perioden (+1 Referenzkerze) ` +
    `und eine EMA${config.factors.trend.slowPeriod} enthaelt. Dies ist ein Datenverfuegbarkeits-, kein ` +
    `Marktqualitaetsproblem.`
  );
}

/** Entfernt potenziell sensible Pfade/Hostnamen aus einer Fehlerbegruendung. */
function sanitizeReason(reason: string): string {
  const trimmed = String(reason ?? "").slice(0, 200);
  return trimmed
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:\/[\w.-]+){2,}/g, "[path]")
    .trim();
}

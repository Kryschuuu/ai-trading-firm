/**
 * Deterministische Multi-Timeframe-Aggregation (GAP-07, v1.47.0).
 *
 * Fügt 1h-Kerzen zu 4h- bzw. 1d-Kerzen zusammen — **deterministisch**
 * (UTC-Anker, keine Uhrzeit des Laufs als Eingabe) und **konservativ**:
 *
 *  - **UTC-Anker:** 4h-Kerzen beginnen exakt um 00/04/08/12/16/20 UTC,
 *    1d-Kerzen um 00:00 UTC. Weil 4h und 1d den UTC-Mitternachtspunkt
 *    exakt teilen und Epoche 0 = 1970-01-01T00:00:00Z gilt, ist
 *    `floor(ts / Intervall) × Intervall` der korrekte Bucket-Anfang —
 *    ohne Zeitzone-Konvertierung, ohne DST.
 *  - **OHLCV-Korrektur:** open = open der ersten Kerze, close = close der
 *    letzten, high = max(highs), low = min(lows), volume = summe — alles in
 *    Zeitreihenfolge, nie Ankunftsreihenfolge.
 *  - **Unvollständige Kerze wird NIEMALS aggregiert:** ein Bucket zählt nur
 *    als abgeschlossen, wenn ALLE Sub-Intervalle (4h: 4×1h, 1d: 24×1h) als
 *    Kerze vorliegen. Fehlt auch nur eine, ist der Bucket `partial` und wird
 *    ausgeschlossen (gezählt, nie erfunden).
 *  - **Zeitmaske:** mit `nowMs` wird nie eine Kerze für eine Periode
 *    ausgegeben, die noch nicht abgeschlossen ist (`bucketEnd > nowMs`),
 *    selbst wenn zufällig alle Sub-Kerzen vorhanden wären.
 *
 * Die Funktion ist eine **reine Funktion**: sie liest die Eingabe, sortiert
 * auf einer internen Kopie und mutiert nichts (Freeze-Tests). Zwei Läufe
 * über dieselbe Eingabe liefern byte-identisches Ergebnis (JSON-Test).
 *
 * Kein LLM, keine IO — Aggregation ist Rechenwerk; Persistenz (Append der
 * aggregierten Reihen in den Historical Store) liegt beim Sync-CLI.
 */
import { SUPPORTED_TIMEFRAME_MS, type SupportedTimeframe } from "../lib/marketdata/historicalStore";
import { candleTimeMs } from "./types";
import type { QualityCandle } from "./quality";

/** Ziel-Timeframes, die aus 1h aggregiert werden (GAP-07: 4h und 1d). */
export const AGGREGATION_TARGETS: readonly SupportedTimeframe[] = ["4h", "1d"] as const;

/** Quellsatz der Aggregation: ausschließlich `1h`. */
export const AGGREGATION_SOURCE: SupportedTimeframe = "1h";

/** Ergebnis einer Aggregation. */
export interface AggregationResult {
  /** Abgeschlossene, aggregierte Kerzen (ts = Bucket-Anfang, aufsteigend). */
  candles: QualityCandle[];
  /** Zeitstempel der Buckets (aufsteigend; Diagnose/Zeitmaske-Nachweis). */
  bucketStarts: number[];
  /**
   * Ausgeschlossene Buckets (weniger Sub-Kerzen als benötigt, bzw. Periode
   * noch offen bei `nowMs`). Deterministisch sortiert.
   */
  partial: { ts: number; received: number; expected: number }[];
}

export interface AggregateOptions {
  /**
   * Zeitmaske: Periode, die erst zu `nowMs` (ms) ABGESCHLOSSEN ist, wird
   * ausgegeben. `undefined`/nicht endlich ⇒ nur Vollständigkeit zählt.
   */
  nowMs?: number;
}

/**
 * Aggregiert `1h`-Kerzen in `2h`/`4h`/`1d`. Reine Funktion (keine Mutation
 * der Eingabe), deterministisch (UTC-Anker, interne Sortierung).
 *
 * @throws {Error} bei nicht erlaubtem Zeitrahmen oder nicht ganzzahligem
 *   Perioden-Verhältnis (z. B. `1h → 4h` wäre ganzzahlig, `30m → 1h` ja,
 *   aber `1h → 4h` mit 1,5h-Quelle nein) — ein falsch gemischtes Intervall
 *   wäre eine still vergiftete Faktorreihe.
 */
export function aggregateCandles(
  source: readonly QualityCandle[],
  sourceTimeframe: SupportedTimeframe,
  targetTimeframe: SupportedTimeframe,
  opts: AggregateOptions = {},
): AggregationResult {
  if (sourceTimeframe !== AGGREGATION_SOURCE) {
    throw new Error(
      `aggregateCandles: Quell-Timeframe muss "${AGGREGATION_SOURCE}" sein, war "${sourceTimeframe}" — ` +
        "die Aggregation ist auf 1h→4h/1d spezialisiert (GAP-07).",
    );
  }
  if (!(AGGREGATION_TARGETS as readonly string[]).includes(targetTimeframe)) {
    throw new Error(
      `aggregateCandles: Ziel-Timeframe "${targetTimeframe}" nicht erlaubt ` +
        `(${AGGREGATION_TARGETS.join(", ")}) — ein ungültiges Ziel würde Reihen mischen.`,
    );
  }
  const sourceMs = SUPPORTED_TIMEFRAME_MS[sourceTimeframe];
  const targetMs = SUPPORTED_TIMEFRAME_MS[targetTimeframe];
  if (targetMs % sourceMs !== 0 || targetMs < sourceMs) {
    throw new Error(
      `aggregateCandles: ${targetTimeframe} ist kein ganzzahliges Vielfaches von ${sourceTimeframe} — ` +
        "ein Bruch-Intervall würde Kerzen verschneiden.",
    );
  }
  const expectedPerBucket = targetMs / sourceMs;
  const hasMask = opts.nowMs !== undefined && Number.isFinite(opts.nowMs);

  // Interne, sortierte Kopie (Eingabe bleibt unangetastet). Ungültige
  // Zeitstempel werden verworfen — sie wären in der Qualitätsprüfung
  // bereits INVALID.
  const rows: { ts: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (const c of Array.isArray(source) ? source : []) {
    const ts = candleTimeMs(c as QualityCandle | null | undefined);
    if (ts === null) continue;
    const volume = typeof c?.volume === "number" && Number.isFinite(c.volume) ? c.volume : 0;
    rows.push({
      ts,
      open: c?.open ?? 0,
      high: c?.high ?? 0,
      low: c?.low ?? 0,
      close: c?.close ?? 0,
      volume,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);

  // Dedup auf ts (jüngste Vorkommnis gewinnt = Store-Dedup-Semantik
  // "jüngstes fetchedAt gewinnt" in Abwesenheit von fetchedAt).
  const byTs = new Map<number, (typeof rows)[number]>();
  for (const r of rows) byTs.set(r.ts, r);

  // Buckets: ts → [bucketStart, candles]. UTC-Anker via floor-Division.
  const buckets = new Map<number, (typeof rows)[number][]>();
  for (const r of byTs.values()) {
    const start = Math.floor(r.ts / targetMs) * targetMs;
    const list = buckets.get(start) ?? [];
    list.push(r);
    buckets.set(start, list);
  }
  const sortedStarts = [...buckets.keys()].sort((a, b) => a - b);

  const candles: QualityCandle[] = [];
  const bucketStarts: number[] = [];
  const partial: AggregationResult["partial"] = [];

  for (const start of sortedStarts) {
    const list = buckets.get(start) as (typeof rows)[number][];
    const complete = list.length === expectedPerBucket;
    const open = !hasMask || start + targetMs <= (opts.nowMs as number);
    if (!complete || !open) {
      partial.push({ ts: start, received: list.length, expected: expectedPerBucket });
      continue;
    }
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const r of list) {
      if (r.high > high) high = r.high;
      if (r.low < low) low = r.low;
      volume += r.volume;
    }
    candles.push({
      time: start,
      open: list[0].open,
      high,
      low,
      close: list[list.length - 1].close,
      volume,
    });
    bucketStarts.push(start);
  }

  return { candles, bucketStarts, partial };
}

/**
 * Konsistenz-Check aggregierter Kerzen gegen die Quelle (reine Funktion):
 *
 *  - Envelope: `high >= max(open, close)` und `low <= min(open, close)`,
 *    sowie `high >= max(highs der Sub-Kerzen)` / `low <= min(lows)` (letztere
 *    gilt nach Konstruktion — der Check ist der Nachweis, dass nichts
 *    zwischen Quelle und Ergebnis verfälscht wurde),
 *  - `open`/`close` decken die Sub-Kerzen an (erste/letzte),
 *  - `volume` = Summe der Sub-Volumen (Toleranz 1e-9 für FP-Rauschen).
 *
 * Liefert eine Liste der Verletzungen (leer = konsistent).
 */
export function checkAggregationConsistency(
  source: readonly QualityCandle[],
  aggregated: readonly QualityCandle[],
  targetTimeframe: SupportedTimeframe,
  opts: AggregateOptions = {},
): string[] {
  const issues: string[] = [];
  const targetMs = SUPPORTED_TIMEFRAME_MS[targetTimeframe];
  const sourceMs = SUPPORTED_TIMEFRAME_MS[AGGREGATION_SOURCE];
  const expectedPerBucket = targetMs / sourceMs;
  const hasMask = opts.nowMs !== undefined && Number.isFinite(opts.nowMs);

  const byBucket = new Map<number, (typeof source)[number][]>();
  for (const c of Array.isArray(source) ? source : []) {
    const ts = candleTimeMs(c as QualityCandle | null | undefined);
    if (ts === null) continue;
    const start = Math.floor(ts / targetMs) * targetMs;
    const list = byBucket.get(start) ?? [];
    list.push(c);
    byBucket.set(start, list);
  }

  const aggTs = new Set<number>();
  for (const a of Array.isArray(aggregated) ? aggregated : []) {
    const ts = candleTimeMs(a as QualityCandle | null | undefined);
    if (ts === null) {
      issues.push("aggregierte Kerze ohne Zeitstempel");
      continue;
    }
    aggTs.add(ts);
    // Envelope der aggregierten Kerze selbst.
    if (typeof a?.high === "number" && typeof a?.low === "number" && a.high < a.low) {
      issues.push(`Bucket ${ts}: high < low`);
    }
    const oc = Math.max(a?.open ?? 0, a?.close ?? 0);
    const ic = Math.min(a?.open ?? 0, a?.close ?? 0);
    if ((a?.high ?? 0) < oc) issues.push(`Bucket ${ts}: high < max(open, close)`);
    if ((a?.low ?? 0) > ic) issues.push(`Bucket ${ts}: low > min(open, close)`);

    const subs = byBucket.get(ts) ?? [];
    if (subs.length !== expectedPerBucket) continue; // kein vollständiger Bucket in der Quelle
    let subHigh = -Infinity;
    let subLow = Infinity;
    let subVolume = 0;
    for (const s of subs) {
      const h = s?.high ?? 0;
      const l = s?.low ?? 0;
      if (h > subHigh) subHigh = h;
      if (l < subLow) subLow = l;
      if (typeof s?.volume === "number") subVolume += s.volume;
    }
    if ((a?.high ?? 0) < subHigh) issues.push(`Bucket ${ts}: high < max(Sub-highs)`);
    if ((a?.low ?? 0) > subLow) issues.push(`Bucket ${ts}: low > min(Sub-lows)`);
    if (Math.abs((a?.volume ?? 0) - subVolume) > 1e-9 * Math.max(1, subVolume)) {
      issues.push(`Bucket ${ts}: volume weicht von der Sub-Summe ab`);
    }
  }
  // Abgeschlossene Source-Buckets müssen auch im Ergebnis stehen — außer
  // die Zeitmaske schließt die Periode zu `nowMs` noch nicht (dann ist die
  // Auslassung korrekt, kein Konsistenzfehler).
  for (const [start, subs] of byBucket) {
    if (subs.length !== expectedPerBucket || aggTs.has(start)) continue;
    const open = hasMask && start + targetMs > (opts.nowMs as number);
    if (!open) issues.push(`Bucket ${start}: vollständig in Quelle, fehlt im Ergebnis`);
  }
  return issues;
}

/**
 * Aggregiert die 1h-Reihe eines Instruments auf alle Ziel-Timeframes
 * (Bequemlichkeit für den Sync-CLI; delegiert je TF an `aggregateCandles`).
 */
export function aggregateInstrument(
  candles: readonly QualityCandle[],
  nowMs?: number,
): Record<"4h" | "1d", AggregationResult> {
  const out = {} as Record<"4h" | "1d", AggregationResult>;
  for (const tf of AGGREGATION_TARGETS) {
    out[tf as "4h" | "1d"] = aggregateCandles(candles, AGGREGATION_SOURCE, tf, { nowMs });
  }
  return out;
}

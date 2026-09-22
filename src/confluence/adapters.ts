/**
 * Produktionsadapter der Multi-Timeframe-Konfluenz (RMA-P2-03).
 *
 * Alle Adapter füttern dieselbe reine Funktion (`computeConfluence`) — der
 * Backtest-/Live-Paritätstest beweist: gleicher Snapshot ⇒ identischer Output,
 * egal ob die Kerzen aus dem {@link HistoricalStore}, aus `MarketCandle`-Reihen
 * oder aus `getCandles()`-Zeilen stammen.
 *
 * Verantwortlichkeiten der Adapter (keine Formel — nur Anbindung):
 *   - Store EINMAL lesen und nach (Instrument, Timeframe) gruppieren (O(n)
 *     statt einer Datei-Ladung je Query — 40 Kandidaten × 5 TFs).
 *   - Provenienz (`fetchedAt`) als `availableAt` übernehmen (PIT-Guard).
 *   - Telemetrie (`confluence_runs_total`, bounded Labels) + strukturiertes
 *     Audit-Log (`confluence_computed`); Instrument-IDs stehen im LOG, nie im
 *     Metrik-Label (Kardinalitätsregel).
 */

import type {
  HistoricalCandleEntry,
  HistoricalStore,
  SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import { isSupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { MarketCandle as LibMarketCandle } from "@/lib/marketdata/types";
import { structuredLog } from "@/lib/logger";
import { metricLabel, telemetry } from "@/lib/telemetry";
import type { MarketCandle } from "@/marketdata/types";
import { candleTimeMs } from "@/marketdata/types";
import { computeConfluence, formatConfluenceLine } from "./confluence";
import type { ConfluenceConfig } from "./config";
import type {
  ConfluenceCandle,
  ConfluenceInput,
  ConfluenceSeriesInput,
  ConfluenceSource,
  ConfluenceSnapshot,
} from "./types";
import { isConfluenceSource } from "./types";

/** Optionen aller Snapshot-Adapter (Quelle + Protokollzeit). */
export interface ConfluenceAdapterOptions {
  /** Geschlossene Quellen-Kennung (Default `cycle`). */
  source?: ConfluenceSource;
  /** Protokollzeit in Epoch-ms (Default: `asOfMs`, deterministisch). */
  computedAtMs?: number;
  /**
   * Strukturiertes Audit-Log unterdrücken (Tests). Telemetrie läuft weiter —
   * sie ist prozesslokal und stumm.
   */
  quiet?: boolean;
}

function resolveSource(source: ConfluenceSource | undefined): ConfluenceSource {
  return source !== undefined && isConfluenceSource(source) ? source : "cycle";
}

/**
 * Rechnet den Snapshot, zählt die Telemetrie und schreibt das Audit-Event.
 * Einzige Stelle mit Nebenwirkungen — die Formel selbst bleibt rein.
 */
function finalizeSnapshot(
  input: ConfluenceInput,
  config: ConfluenceConfig,
  opts: ConfluenceAdapterOptions,
): ConfluenceSnapshot {
  const source = resolveSource(opts.source);
  const snapshot = computeConfluence(input, config, opts.computedAtMs);
  const result =
    snapshot.status === "OK" ? "ok" : snapshot.status === "DEGRADED" ? "degraded" : "abstain";
  telemetry.confluence.runs.inc({ result, source: metricLabel(source, "cycle") });
  if (!opts.quiet) {
    structuredLog(snapshot.status === "ABSTAIN" ? "warn" : "info", "confluence_computed", {
      instrumentId: snapshot.instrumentId,
      source,
      status: snapshot.status,
      direction: snapshot.direction,
      strength: snapshot.strength,
      bias: snapshot.bias ?? "n/a",
      confidence: snapshot.confidence,
      coverage: snapshot.coverage,
      conflict: snapshot.conflict,
      formulaVersion: snapshot.formulaVersion,
      configVersion: snapshot.configVersion,
      snapshotKey: snapshot.snapshotKey,
      missing: snapshot.missing.length,
    });
  }
  return snapshot;
}

/**
 * Baut die reine Funktions-Eingabe aus generischen Kerzenreihen
 * (Backtest-/Replay-/API-Pfad). Die Reihenfolge der Map-Einträge ist egal.
 */
export function confluenceInputFromCandles(
  instrumentId: string,
  asOfMs: number,
  seriesByTimeframe: ReadonlyMap<string, readonly ConfluenceCandle[]>,
): ConfluenceInput {
  const series: ConfluenceSeriesInput[] = [];
  for (const [timeframe, candles] of seriesByTimeframe) {
    if (!isSupportedTimeframe(timeframe)) continue;
    series.push({ timeframe, candles: Array.isArray(candles) ? [...candles] : [] });
  }
  return { instrumentId, asOfMs, series };
}

/**
 * Konfluenz aus `MarketCandle`-Reihen (Sync-/Backtest-Contract `time|ts`).
 * Optional lässt sich je Kerze eine Verfügbarkeit injizieren (`availableAt`
 * je Index oder konstant) — ohne Angabe gilt jede Kerze als verfügbar.
 */
export function confluenceFromMarketCandles(
  instrumentId: string,
  asOfMs: number,
  seriesByTimeframe: ReadonlyMap<string, readonly MarketCandle[]>,
  config: ConfluenceConfig,
  opts: ConfluenceAdapterOptions = {},
  availableAtMs?: number,
): ConfluenceSnapshot {
  const series: ConfluenceSeriesInput[] = [];
  for (const [timeframe, candles] of seriesByTimeframe) {
    if (!isSupportedTimeframe(timeframe)) continue;
    const out: ConfluenceCandle[] = [];
    for (const c of candles ?? []) {
      const time = candleTimeMs(c);
      if (time === null) continue;
      out.push({
        time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        ...(availableAtMs !== undefined ? { availableAtMs } : {}),
      });
    }
    series.push({ timeframe, candles: out });
  }
  return finalizeSnapshot({ instrumentId, asOfMs, series }, config, opts);
}

/**
 * Konfluenz aus `getCandles()`-Zeilen (`src/lib/marketData.ts`, Analyst-Pfad).
 * Der `Candle`-Contract trägt nur `time` (kein `availableAt`) — Live-Kerzen
 * gelten als verfügbar; die as-of-Ausrichtung schließt die offene Bar aus.
 */
export function confluenceFromLibCandles(
  instrumentId: string,
  asOfMs: number,
  seriesByTimeframe: ReadonlyMap<string, readonly LibMarketCandle[]>,
  config: ConfluenceConfig,
  opts: ConfluenceAdapterOptions = {},
): ConfluenceSnapshot {
  const series: ConfluenceSeriesInput[] = [];
  for (const [timeframe, candles] of seriesByTimeframe) {
    if (!isSupportedTimeframe(timeframe)) continue;
    const out: ConfluenceCandle[] = [];
    for (const c of candles ?? []) {
      if (!c || typeof c !== "object") continue;
      const time = (c as { time?: unknown }).time;
      if (typeof time !== "number" || !Number.isInteger(time) || time <= 0) continue;
      out.push({
        time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
    series.push({ timeframe, candles: out });
  }
  return finalizeSnapshot({ instrumentId, asOfMs, series }, config, opts);
}

/**
 * Konfluenz EINES Instruments aus dem Historical Store (Live-/Cycle-Pfad).
 * Liest die benötigten Reihen über `query` (Pflicht-Timeframe je Reihe).
 */
export function confluenceFromStore(
  store: HistoricalStore,
  instrumentId: string,
  asOfMs: number,
  config: ConfluenceConfig,
  opts: ConfluenceAdapterOptions = {},
): ConfluenceSnapshot {
  const series: ConfluenceSeriesInput[] = [];
  for (const timeframe of config.timeframes) {
    const entries = store.query({ instrumentId, timeframe });
    series.push({ timeframe, candles: entries.map(storeEntryToCandle) });
  }
  return finalizeSnapshot({ instrumentId, asOfMs, series }, config, opts);
}

/**
 * Konfluenz MEHRERER Instrumente aus dem Historical Store (Batch für den
 * technischen Step: 40 Kandidaten × 5 TFs). Der Store wird GENAU EINMAL
 * gelesen und nach (Instrument, Timeframe) gruppiert — eine Datei-Ladung
 * je Query wäre O(n²)-I/O über die wachsende NDJSON-Datei.
 *
 * Unbekannte Instrumente (keine einzige Zeile) erhalten einen ehrlichen
 * `ABSTAIN`-Snapshot (`unavailable` je Timeframe) statt einer Exception —
 * der Step bleibt für die übrigen Kandidaten lauffähig.
 */
export function confluenceBatchFromStore(
  store: HistoricalStore,
  instrumentIds: readonly string[],
  asOfMs: number,
  config: ConfluenceConfig,
  opts: ConfluenceAdapterOptions = {},
): Map<string, ConfluenceSnapshot> {
  const wanted = new Set(instrumentIds);
  const wantedTf = new Set<string>(config.timeframes);
  const grouped = new Map<string, Map<string, ConfluenceCandle[]>>();
  for (const id of wanted) grouped.set(id, new Map());

  for (const entry of store.readAll()) {
    if (!wanted.has(entry.instrumentId)) continue;
    if (!wantedTf.has(entry.timeframe)) continue;
    const perInstrument = grouped.get(entry.instrumentId);
    if (!perInstrument) continue;
    const list = perInstrument.get(entry.timeframe) ?? [];
    list.push(storeEntryToCandle(entry));
    perInstrument.set(entry.timeframe, list);
  }

  const out = new Map<string, ConfluenceSnapshot>();
  for (const id of instrumentIds) {
    const perInstrument = grouped.get(id) ?? new Map();
    const series: ConfluenceSeriesInput[] = [];
    for (const timeframe of config.timeframes) {
      const tf = timeframe as SupportedTimeframe;
      const candles = perInstrument.get(tf);
      // Fehlende Reihen werden NICHT als leere Reihe übergeben, sondern
      // weggelassen — die reine Funktion meldet dann `unavailable`
      // (Sync-Lücke) statt `no-closed-bars` (präziserer Grund).
      if (candles !== undefined) series.push({ timeframe: tf, candles });
    }
    out.set(id, finalizeSnapshot({ instrumentId: id, asOfMs, series }, config, opts));
  }
  return out;
}

/**
 * Store-Eintrag → Eingabekerze. `fetchedAt` wird als `availableAt` übernommen:
 * Eine Kerze, die erst NACH asOf geschrieben wurde (später Backfill), bleibt
 * in der as-of-Sicht unsichtbar — der zentrale Point-in-Time-Guard für
 * Replay/Backtest-Parität. Unparsebares `fetchedAt` ⇒ Kerze gilt als
 * verfügbar (der Store validiert das Feld bereits beim Schreiben/Lesen).
 */
function storeEntryToCandle(entry: HistoricalCandleEntry): ConfluenceCandle {
  const parsed = Date.parse(entry.fetchedAt);
  return {
    time: entry.ts,
    open: entry.open,
    high: entry.high,
    low: entry.low,
    close: entry.close,
    volume: entry.volume,
    ...(Number.isFinite(parsed) ? { availableAtMs: parsed } : {}),
  };
}

export { formatConfluenceLine };

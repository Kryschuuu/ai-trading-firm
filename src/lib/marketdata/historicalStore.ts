/**
 * Historical Store (Task 03) — append-only OHLCV-Speicher.
 *
 * Format: NDJSON (repo-konform wie `data/universe`), eine Kerze pro Zeile,
 * append-only. Jede Zeile trägt eindeutige Provenienz (venue, feed, ts), damit
 * ein Backtest/Replay nachvollziehbar und bit-identisch reproduzierbar ist.
 *
 * Schreibvorgänge nutzen atomares `tmp`+`rename` (keine halben Dateien);
 * Anhängen erfolgt append-only (kein Rewrite).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Ein persistierter OHLCV-Eintrag mit Provenienz. */
export interface HistoricalCandleEntry {
  instrumentId: string;
  venue: string;
  feed: string;
  /** Unix-Epoch (ms) der Kerze. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Provenienz-Timestamp (wann geschrieben, ISO-UTC). */
  fetchedAt: string;
  /**
   * Optionales Intervall (`5m`/`15m`/`30m`/`1h`), gesetzt vom
   * MarketDataSyncService. Altbestand ohne Feld bleibt gültig.
   */
  timeframe?: string;
}

export interface Provenance {
  venue: string;
  feed: string;
}

export interface StoreQuery {
  instrumentId?: string;
  from?: number;
  to?: number;
  limit?: number;
  /** Optional: nur Kerzen dieses Intervalls (Einträge ohne `timeframe` matchen nicht). */
  timeframe?: string;
}

/** Sortiert nach ts aufsteigend (stabil). */
function sortEntries(entries: HistoricalCandleEntry[]): HistoricalCandleEntry[] {
  return [...entries].sort((a, b) => a.ts - b.ts || a.fetchedAt.localeCompare(b.fetchedAt));
}

export class HistoricalStore {
  readonly dir: string;
  readonly filePath: string;

  constructor(dir?: string) {
    this.dir = path.isAbsolute(dir ?? "data/history")
      ? (dir as string)
      : path.join(process.cwd(), dir ?? "data/history");
    this.filePath = path.join(this.dir, "candles.ndjson");
  }

  /**
   * Append-only: hängt Kerzen an (nie bestehende Daten neu schreiben).
   *
   * Abwärtskompatibel: 4. Parameter darf `Date` (bisheriges API) oder
   * Timeframe-String sein. `MarketDataSyncService` ruft
   * `append(candles, id, provenance, timeframe, now)` auf.
   */
  append(
    candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[],
    instrumentId: string,
    provenance: Provenance,
    timeframeOrNow: string | Date = new Date(),
    now?: Date
  ): number {
    if (!candles.length) return 0;
    mkdirSync(this.dir, { recursive: true });
    let timeframe: string | undefined;
    let fetched: Date;
    if (timeframeOrNow instanceof Date) {
      fetched = timeframeOrNow;
    } else {
      timeframe = timeframeOrNow;
      fetched = now instanceof Date ? now : new Date();
    }
    const fetchedAt = fetched.toISOString();
    const lines = candles.map((c) => {
      const entry: HistoricalCandleEntry = {
        instrumentId,
        venue: provenance.venue,
        feed: provenance.feed,
        ts: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        fetchedAt,
      };
      if (timeframe) entry.timeframe = timeframe;
      return JSON.stringify(entry);
    });
    appendFileSync(this.filePath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    return lines.length;
  }

  /** Liest Einträge (append-only ⇒ Sortierung + Filter am Lesen). */
  query(q: StoreQuery = {}): HistoricalCandleEntry[] {
    if (!existsSync(this.filePath)) return [];
    const entries: HistoricalCandleEntry[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      try {
        entries.push(JSON.parse(t) as HistoricalCandleEntry);
      } catch {
        /* beschädigte Zeile überspringen (append-only) */
      }
    }
    let out = entries;
    if (q.instrumentId) out = out.filter((e) => e.instrumentId === q.instrumentId);
    if (q.timeframe) out = out.filter((e) => e.timeframe === q.timeframe);
    if (q.from !== undefined) out = out.filter((e) => e.ts >= (q.from as number));
    if (q.to !== undefined) out = out.filter((e) => e.ts <= (q.to as number));
    out = sortEntries(out);
    if (q.limit !== undefined && q.limit > 0) out = out.slice(0, q.limit);
    return out;
  }

  /** Anzahl der Einträge (für Diagnose/Tests). */
  count(instrumentId?: string): number {
    return this.query(instrumentId ? { instrumentId } : {}).length;
  }
}

/**
 * Schreibt den aktuellen Store-Stand als deterministisches Ergebnisartefakt
 * (Golden-/Replay-Test: gleicher Stand → byte-identische Datei).
 */
export function writeStoreSnapshot(store: HistoricalStore, outPath: string): void {
  const entries = sortEntries(store.query());
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, outPath);
}

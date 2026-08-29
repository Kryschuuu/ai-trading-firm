/**
 * Historical Store — append-only OHLCV-Speicher mit Timeframe-Dimension.
 *
 * Format: NDJSON (repo-konform wie `data/universe`), eine Kerze pro Zeile.
 * Jede Zeile trägt Provenienz (venue, feed, ts, fetchedAt) und — seit
 * Schema-Version **v2** — verpflichtend ein `timeframe`.
 *
 * WARUM `timeframe` Pflicht ist (Teil der logischen Identität einer Kerze):
 * Ohne dieses Feld würden z.B. 5m- und 1h-Bars desselben Instruments zu einer
 * gemeinsamen Faktorreihe verschmelzen und jede EMA-/Momentum-/Volatilitäts-
 * Berechnung unbemerkt verfälschen. Der logische Primärschlüssel ist
 * `instrumentId + timeframe + ts`; bei Kollision gewinnt der Eintrag mit dem
 * jüngsten `fetchedAt` ( deterministische Deduplizierung, siehe
 * {@link HistoricalStore.append}).
 *
 * Schreibvorgänge nutzen atomares `tmp` + `rename` (keine halben Dateien).
 * Der Loader arbeitet strom-/pufferbasiert (feste Chunk-Größe), damit eine
 * große Historie den Prozess nicht OOM-killt; kaputte Zeilen werden gezählt,
 * geloggt und übersprungen (kein Prozessabbruch).
 *
 * Migration von Altbestand (v1, ohne `timeframe`):
 *   npm run history:migrate -- --file=data/history/candles.ndjson \
 *     --assume-timeframe=15m [--dry-run]
 * Siehe `docs/HISTORY.md` und `scripts/migrate-history-timeframe.ts`.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { MarketCandle } from "./types";

/**
 * Alle im System zulässigen Kerzen-Periodizitäten (Allowlist).
 * Wird gegen externe/geparste Werte validiert — freie Strings werden
 * abgewiesen, damit ein Tippfehler (`"1H"` vs. `"1h"`) keine still
 * gemischte Reihe erzeugt.
 */
export const SUPPORTED_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
  "5d",
] as const;

export type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

/**
 * Marker für Zeilen im Legacy-Schema (v1, ohne `timeframe`). Solche Zeilen
 * werden im Runtime-Loader niemals über {@link HistoricalStore.query}
 * ausgeliefert (ein Timeframe-Pflicht-Query kann sie nie matchen) — sie
 * bleiben ausschließlich für `readAll()`/Migration sichtbar.
 */
export const LEGACY_UNKNOWN = "__legacy_unknown__" as const;

/** Aktuelle Schema-Version des Zeilenformats. */
export const HISTORY_SCHEMA_VERSION = 2;

/**
 * Standard-Timeframe für analytische Konsumenten (Scanner, Replay/Backtest,
 * Korrelation/Risk). Trend-/Drawdown-Periode und Lookbacks gehen von einer
 * einheitlichen Periodizität aus — das Mischen von Intervallen würde die
 * Faktorreihe verfälschen.
 */
export const DEFAULT_ANALYSIS_TIMEFRAME: SupportedTimeframe = "1h";

/**
 * Ein persistierter OHLCV-Eintrag mit Provenienz.
 *
 * `timeframe` ist Teil der logischen Identität einer Kerze. Ohne dieses Feld
 * würden z.B. 5m- und 1h-Bars desselben Instruments zu einer gemeinsamen
 * Faktorreihe verschmelzen und jede EMA/Momentum-Berechnung unbemerkt
 * verfälschen.
 */
export interface HistoricalCandleEntry {
  instrumentId: string;
  venue: string;
  feed: string;
  /** Periodizität der Kerze (`"5m"`, `"15m"`, `"1h"`, …). */
  timeframe: SupportedTimeframe;
  /** Unix-Epoch (ms) der Kerze. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Provenienz-Timestamp (wann geschrieben, ISO-UTC). */
  fetchedAt: string;
}

export interface Provenance {
  venue: string;
  feed: string;
}

/**
 * Filter für {@link HistoricalStore.query}. `instrumentId` und `timeframe`
 * sind PFLICHT: ein vergessener Timeframe-Filter würde Kerzen verschiedener
 * Periodizität mischen (der Bug, den diese Schicht behebt).
 */
export interface StoreQuery {
  instrumentId: string;
  timeframe: SupportedTimeframe;
  /** Inklusive: `ts >= from`. */
  from?: number;
  /** Inklusive: `ts <= to`. */
  to?: number;
  /** Liefert die letzten `limit` Bars (ts absteigend selektiert), Ergebnis ts aufsteigend. */
  limit?: number;
}

/** Ergebnis eines Append-Laufs. */
export interface AppendResult {
  /** Neu geschriebene, vorher nicht vorhandene Bars. */
  written: number;
  /** Als Duplikat erkannte (und nicht erneut geschriebene) Bars. */
  deduplicated: number;
  /** Wegen fehlgeschlagener Validierung übersprungene Eingabe-Bars. */
  invalid: number;
}

/** Ergebnis einer Lade-Operation (für Diagnose/Migration). */
export interface LoadStats {
  total: number;
  legacy: number;
  corrupted: number;
  valid: number;
}

/** Fehler bei einem verletzten Store-Kontrakt (z. B. Query ohne Timeframe). */
export class HistoricalStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Prüft einen Wert gegen die Timeframe-Allowlist. */
export function isSupportedTimeframe(value: unknown): value is SupportedTimeframe {
  return typeof value === "string" && (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

/** Logischer Schlüssel einer Kerze. */
function seriesKey(instrumentId: string, timeframe: string): string {
  return `${instrumentId}\u0000${timeframe}`;
}

/**
 * Sortierreihenfolge für Ergebnisse: `ts` aufsteigend, bei Gleichstand
 * `fetchedAt` (stabil, deterministisch).
 */
function sortEntries<T extends { ts: number; fetchedAt: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.ts - b.ts || (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Ergebnis eines Zeilen-Parsing (diskriminierte Union nach `legacy`). */
export type ParsedCandleLine =
  | { legacy: false; entry: HistoricalCandleEntry }
  | { legacy: true; entry: Omit<HistoricalCandleEntry, "timeframe"> & { timeframe: typeof LEGACY_UNKNOWN } };

/**
 * Parst EINE JSON-Zeile feldweise (KEIN Spread des geparsten Objekts —
 * Prototype-Pollution-Schutz: `__proto__`/`constructor` werden gar nicht erst
 * übernommen). Gibt `null` bei unbrauchbaren Zeilen zurück.
 */
export function parseCandleLine(raw: unknown): ParsedCandleLine | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Feldweises Mapping über Object.create(null) (kein Prototyp, kein Spread) —
  // `__proto__`/`constructor`/`prototype` im Rohobjekt werden verworfen und
  // niemals als Eigenschaft übernommen (Prototype-Pollution-Schutz).
  const src = raw as Record<string, unknown>;
  const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);
  const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (DANGEROUS.has(k)) continue;
    o[k] = src[k];
  }

  const instrumentId = o.instrumentId;
  const venue = o.venue;
  const feed = o.feed;
  const ts = o.ts;
  const fetchedAt = o.fetchedAt;
  const open = o.open;
  const high = o.high;
  const low = o.low;
  const close = o.close;
  const volume = o.volume;

  if (!isNonEmptyString(instrumentId) || !isNonEmptyString(venue) || !isNonEmptyString(feed)) return null;
  if (!isNonEmptyString(fetchedAt) || Number.isNaN(Date.parse(fetchedAt))) return null;
  // ts: positive Ganzzahl (Epoch-ms).
  if (!isFiniteNumber(ts) || !Number.isInteger(ts) || ts <= 0) return null;
  // OHLCV: endliche Zahlen; Preise > 0, Volume >= 0.
  if (!isFiniteNumber(open) || open <= 0) return null;
  if (!isFiniteNumber(high) || high <= 0) return null;
  if (!isFiniteNumber(low) || low <= 0) return null;
  if (!isFiniteNumber(close) || close <= 0) return null;
  if (!isFiniteNumber(volume) || volume < 0) return null;

  const base: Omit<HistoricalCandleEntry, "timeframe"> = {
    instrumentId,
    venue,
    feed,
    ts,
    open,
    high,
    low,
    close,
    volume,
    fetchedAt,
  };

  if (isSupportedTimeframe(o.timeframe)) {
    return { entry: { ...base, timeframe: o.timeframe }, legacy: false };
  }
  // Legacy-Zeile (v1 ohne/mit ungültigem timeframe): Marker statt Timeframe.
  return { entry: { ...base, timeframe: LEGACY_UNKNOWN }, legacy: true };
}

/** Bereits gewarnte Dateipfade (Warnung zur Legacy-Migration genau einmal). */
const warnedLegacyFiles = new Set<string>();

export class HistoricalStore {
  readonly dir: string;
  readonly filePath: string;
  /** Maximale Bars je Reihe (instrumentId+timeframe) nach Kompaktierung. */
  readonly maxBarsPerSeries: number;

  constructor(dir?: string, opts: { maxBarsPerSeries?: number } = {}) {
    // Der Pfad wird ausschließlich aus dem konfigurierten `dir` gebildet.
    // instrumentId/timeframe/feed werden NIE in Pfade interpoliert (kein
    // Path-Traversal).
    this.dir = path.isAbsolute(dir ?? "data/history")
      ? (dir as string)
      : path.join(process.cwd(), dir ?? "data/history");
    this.filePath = path.join(this.dir, "candles.ndjson");
    this.maxBarsPerSeries = Math.max(1, Math.floor(opts.maxBarsPerSeries ?? 5000));
  }

  /**
   * Hängt Kerzen an und dedupliziert deterministisch gegen den Bestand.
   *
   * Logischer Schlüssel: `instrumentId + timeframe + ts`. Bei Kollision
   * gewinnt der Eintrag mit dem jüngsten `fetchedAt`; bei Gleichstand der
   * zuletzt gelesene/geschriebene. Die Datei wird je Append atomar
   * umgeschrieben (`tmp`+`rename`), damit Duplikate nicht als Zeilen
   * akkumulieren; wachsende Reihen werden bei Bedarf auf `maxBarsPerSeries`
   * (Default 5000) kompaktiert.
   *
   * `timeframe` ist ein expliziter, Pflicht-Parameter: es gibt KEINE
   * überladene alte Signatur mehr, damit TypeScript jeden Aufrufer zur
   * Migration zwingt (kein optionaler Parameter, der den Mix-Bug still
   * reproduzieren würde).
   *
   * @returns `{ written, deduplicated }` — neu geschriebene bzw. als Duplikat
   *   verworfene Bars.
   */
  append(
    candles: MarketCandle[],
    instrumentId: string,
    provenance: Provenance,
    timeframe: SupportedTimeframe,
    now: Date,
  ): AppendResult {
    if (!Array.isArray(candles) || candles.length === 0) return { written: 0, deduplicated: 0, invalid: 0 };
    if (!isNonEmptyString(instrumentId)) {
      throw new HistoricalStoreError("INVALID_INSTRUMENT", "append: instrumentId muss ein nicht-leerer String sein.");
    }
    if (!isSupportedTimeframe(timeframe)) {
      throw new HistoricalStoreError(
        "INVALID_TIMEFRAME",
        `append: timeframe "${String(timeframe)}" ist nicht in der Allowlist ` +
          `(${SUPPORTED_TIMEFRAMES.join(", ")}). Ein ungültiger Timeframe würde Reihen unbemerkt mischen.`,
      );
    }
    const fetchedAt = now.toISOString();

    // 1. Bestand laden (strom-/pufferbasiert; Legacy bleibt unangetastet).
    const { entries } = this.loadAll();

    // 2. Neue Kerzen validieren + dedup-merge gegen den Bestand.
    let written = 0;
    let deduplicated = 0;
    let invalid = 0;
    for (const c of candles) {
      if (
        !c ||
        !isFiniteNumber(c.time) ||
        !Number.isInteger(c.time) ||
        c.time <= 0 ||
        !isFiniteNumber(c.open) ||
        c.open <= 0 ||
        !isFiniteNumber(c.high) ||
        c.high <= 0 ||
        !isFiniteNumber(c.low) ||
        c.low <= 0 ||
        !isFiniteNumber(c.close) ||
        c.close <= 0 ||
        !isFiniteNumber(c.volume) ||
        c.volume < 0
      ) {
        // Ungültige Eingabe-Strippe: zählen, nicht schreiben (kein Abbruch).
        invalid += 1;
        continue;
      }
      const entry: HistoricalCandleEntry = {
        instrumentId,
        venue: provenance.venue,
        feed: provenance.feed,
        timeframe,
        ts: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        fetchedAt,
      };
      const merged = this.mergeEntry(entries, entry);
      if (merged === "written") written += 1;
      else deduplicated += 1;
    }

    // 3. Kompaktierung je Reihe (älteste Bars außerhalb der Grenze entfernen).
    this.compact(entries);

    // 4. Atomar schreiben (tmp + rename), restriktive Dateirechte (0600).
    this.writeAll(entries);

    return { written, deduplicated, invalid };
  }

  /**
   * Führt eine neue Kerze gegen den geladenen Bestand ein.
   * Schlüssel `instrumentId+timeframe+ts`; jüngstes `fetchedAt` gewinnt,
   * bei Gleichstand der Neue (zuletzt gelesen).
   */
  private mergeEntry(entries: HistoricalCandleEntry[], next: HistoricalCandleEntry): "written" | "duplicate" {
    // Legacy-Einträge nehmen an diesem Schlüssel nicht teil (anderer
    // Timeframe-Marker) — sie bleiben unverändert.
    const key = seriesKey(next.instrumentId, next.timeframe);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.ts !== next.ts) continue;
      if (seriesKey(e.instrumentId, e.timeframe) !== key) continue;
      // Kollision: jüngeres fetchedAt gewinnt; Gleichstand → zuletzt gelesen.
      if (next.fetchedAt >= e.fetchedAt) {
        entries[i] = next;
      }
      return "duplicate";
    }
    entries.push(next);
    return "written";
  }

  /** Kappt je Reihe die ältesten Bars über `maxBarsPerSeries`. */
  private compact(entries: HistoricalCandleEntry[]): void {
    if (this.maxBarsPerSeries === Number.POSITIVE_INFINITY) return;
    const bySeries = new Map<string, HistoricalCandleEntry[]>();
    for (const e of entries) {
      const k = seriesKey(e.instrumentId, e.timeframe);
      const list = bySeries.get(k) ?? [];
      list.push(e);
      bySeries.set(k, list);
    }
    for (const list of bySeries.values()) {
      if (list.length <= this.maxBarsPerSeries) continue;
      list.sort((a, b) => a.ts - b.ts || (a.fetchedAt < b.fetchedAt ? -1 : 1));
      const drop = list.slice(0, list.length - this.maxBarsPerSeries);
      const dropSet = new Set(drop);
      for (const d of dropSet) {
        const idx = entries.indexOf(d);
        if (idx >= 0) entries.splice(idx, 1);
      }
    }
  }

  /**
   * Liefert Kerzen EINES Instruments EINES Timeframes, ts aufsteigend.
   *
   * `timeframe` ist Pflicht (Compile + Runtime-Guard). Ein Timeframe-freier
   * Zugriff würde Kerzen unterschiedlicher Periodizität mischen.
   */
  query(q: StoreQuery): HistoricalCandleEntry[] {
    if (!q || !isNonEmptyString(q.instrumentId)) {
      throw new HistoricalStoreError(
        "QUERY_REQUIRES_INSTRUMENT",
        "query({instrumentId}) ohne instrumentId ist nicht zulässig.",
      );
    }
    if (!isSupportedTimeframe(q.timeframe)) {
      throw new HistoricalStoreError(
        "QUERY_REQUIRES_TIMEFRAME",
        'query({instrumentId}) ohne timeframe ist nicht zulaessig. Ein Timeframe-freier Zugriff ' +
          "wuerde Kerzen unterschiedlicher Periodizitaet mischen. Nutze z.B. " +
          'query({ instrumentId, timeframe: "15m" }).',
      );
    }
    const { entries } = this.loadAll();
    let out = entries.filter((e) => e.instrumentId === q.instrumentId && e.timeframe === q.timeframe);
    if (q.from !== undefined) out = out.filter((e) => e.ts >= (q.from as number));
    if (q.to !== undefined) out = out.filter((e) => e.ts <= (q.to as number));
    out = sortEntries(out);
    if (q.limit !== undefined && q.limit > 0) {
      // Die letzten `limit` Bars (jüngste), wieder ts aufsteigend zurückgeben.
      out = out.slice(-q.limit);
    }
    return out;
  }

  /**
   * Läd ALLE gültigen (v2-)Einträge über alle Timeframes — ausschließlich
   * für Scanner-Provider (Zeitreihen-Auswahl mit Timeframe-Präferenz) und
   * Wartung/Migration. Normale Konsumenten MÜSSEN {@link query} mit
   * Pflicht-Timeframe nutzen. Legacy-Zeilen sind hier nicht enthalten.
   */
  readAll(): HistoricalCandleEntry[] {
    return this.loadAll().entries;
  }

  /** Anzahl Kerzen (Diagnose). Ohne Timeframe nur nach Instrument gefiltert. */
  count(instrumentId?: string, timeframe?: SupportedTimeframe): number {
    const { entries } = this.loadAll();
    return entries.filter(
      (e) =>
        (!instrumentId || e.instrumentId === instrumentId) &&
        (!timeframe || e.timeframe === timeframe),
    ).length;
  }

  /**
   * Streambasiertes Laden der Datei (feste Lese-Chunks, keine ganze Datei im
   * Speicher zur selben Zeit geparst). Kaputte Teilzeilen werden geloggt und
   * übersprungen; Legacy-Zeilen werden gezählt, lösen eine einmalige Warnung
   * aus und werden NICHT als v2-Einträge zurückgegeben.
   */
  loadAll(): { entries: HistoricalCandleEntry[]; stats: LoadStats } {
    const stats: LoadStats = { total: 0, legacy: 0, corrupted: 0, valid: 0 };
    const entries: HistoricalCandleEntry[] = [];
    if (!existsSync(this.filePath)) return { entries, stats };

    const lines = readLinesSync(this.filePath);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      stats.total += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        stats.corrupted += 1;
        console.warn(`[historical-store] kaputte Zeile in ${this.filePath} wird übersprungen: ${t.slice(0, 120)}`);
        continue;
      }
      const result = parseCandleLine(parsed);
      if (!result) {
        stats.corrupted += 1;
        console.warn(`[historical-store] ungültige Zeile in ${this.filePath} wird übersprungen: ${t.slice(0, 120)}`);
        continue;
      }
      if (result.legacy) {
        stats.legacy += 1;
        continue;
      }
      stats.valid += 1;
      entries.push(result.entry);
    }

    if (stats.legacy > 0 && !warnedLegacyFiles.has(this.filePath)) {
      warnedLegacyFiles.add(this.filePath);
      console.warn(
        `[historical-store] ${this.filePath} enthaelt ${stats.legacy.toLocaleString("de-DE")} Zeilen im ` +
          `Legacy-Schema (ohne timeframe). Diese Bars werden ignoriert. Fuehre ` +
          "`npm run history:migrate` aus.",
      );
    }
    return { entries, stats };
  }

  /** Schreibt alle Einträge atomar (tmp + rename), Datei-Modus 0600. */
  private writeAll(entries: HistoricalCandleEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    // JSON.stringify je Zeile (kein String-Concat) -> keine Zeilen-Injection
    // über Feldwerte mit Newlines. Schema-Version v2 je Zeile.
    const body =
      entries
        .map((e) => JSON.stringify({ v: HISTORY_SCHEMA_VERSION, ...e }))
        .join("\n") + (entries.length ? "\n" : "");
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

/**
 * Pufferbasierter Zeilenleser (Streaming-Semantik ohne OOM): liest die Datei
 * in festen Blöcken und gibt Zeilen einzeln weiter. Eine kaputte Teilzeile am
 * Dateiende (fehlendes abschließendes Newline) wird noch ausgeliefert und vom
 * Aufrufer verworfen, falls sie nicht parsebar ist.
 */
function readLinesSync(filePath: string, chunkSize = 1 << 20): string[] {
  const fd = openSync(filePath, "r");
  const lines: string[] = [];
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let carry = "";
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      const chunk = carry + buf.toString("utf8", 0, bytesRead);
      const parts = chunk.split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) lines.push(p);
    }
    if (carry.length > 0) lines.push(carry);
  } finally {
    closeSync(fd);
  }
  return lines;
}

/**
 * Schreibt den aktuellen Store-Stand als deterministisches Ergebnisartefakt
 * (Golden-/Replay-Test: gleicher Stand → byte-identische Datei).
 */
export function writeStoreSnapshot(store: HistoricalStore, outPath: string): void {
  const entries = sortEntries(store.readAll());
  const body =
    entries
      .map((e) => JSON.stringify({ v: HISTORY_SCHEMA_VERSION, ...e }))
      .join("\n") + (entries.length ? "\n" : "");
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, outPath);
}

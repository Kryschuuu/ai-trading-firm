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

/** Ergebnis eines Batch-Appends über mehrere Reihen (eine Datei-Revision). */
export interface AppendSeriesResult extends AppendResult {
  /** Anzahl verarbeiteter Gruppen. */
  groups: number;
  /** Zähler je Gruppe, in Eingabereihenfolge. */
  perGroup: AppendResult[];
}

/**
 * Eine backzufügende Reihe: Kerzen EINES Instruments EINES Timeframes.
 * Mit {@link HistoricalStore.appendSeries} gebündelt, ohne die
 * Pflichtfelder aus `append` zu umgehen.
 */
export interface CandleSeriesGroup {
  candles: readonly MarketCandle[];
  instrumentId: string;
  provenance: Provenance;
  timeframe: SupportedTimeframe;
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
 * Voller Dedup-Schlüssel einer Kerze: `instrumentId + timeframe + ts`.
 * Der Index in {@link HistoricalStore.appendSeries} bildet darauf die
 * logische Identität ab — identisch zur linearen Suche des alten `append`.
 */
function candleKey(entry: { instrumentId: string; timeframe: string; ts: number }): string {
  return `${seriesKey(entry.instrumentId, entry.timeframe)}\u0000${entry.ts}`;
}

/**
 * Validierende Umwandlung einer Adapter-Kerze in einen Store-Eintrag.
 * `null` bei unbrauchbaren Werten (Preis ≤ 0, nicht endlich, Volumen < 0,
 * kein ganzzahliger Zeitstempel) — der Aufrufer zählt sie als `invalid`,
 * ein einzelner Ausschuss bricht niemals den ganzen Lauf ab.
 */
function buildCandleEntry(
  candle: MarketCandle | undefined | null,
  group: CandleSeriesGroup,
  fetchedAt: string,
): HistoricalCandleEntry | null {
  const c = candle as MarketCandle | undefined;
  if (!c) return null;
  if (
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
    return null;
  }
  return {
    instrumentId: group.instrumentId,
    venue: group.provenance.venue,
    feed: group.provenance.feed,
    timeframe: group.timeframe,
    ts: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    fetchedAt,
  };
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
    const batch = this.appendSeries([{ candles, instrumentId, provenance, timeframe }], now);
    return batch.perGroup[0] ?? { written: 0, deduplicated: 0, invalid: 0 };
  }

  /**
   * Batch-Append über mehrere Reihen mit GENAU EINEM Lese-/Schreibzyklus.
   *
   * WARUM es das gibt: `append` lädt, merged und schreibt die Datei komplett.
   * Ein Market-Data-Sync befüllt bis zu 250 Instrumente × 4 Timeframes — ein
   * Append je Gruppe würde die wachsende Datei 1000× atomar umschreiben
   * (O(n²) I/O, im Betrieb Minuten und Gigabytes an Schreibvorgängen). Diese
   * Methode führt alle Gruppen in EINER Revision zusammen.
   *
   * Die Semantik ist bewusst identisch zu {@link append}: Schlüssel
   * `instrumentId + timeframe + ts`, jüngstes `fetchedAt` gewinnt,
   * Kompaktierung auf `maxBarsPerSeries`, atomares `tmp` + `rename`,
   * ungültige Bars werden gezählt statt den Lauf abzubrechen. Deduplizierung
   * läuft über einen Index statt über eine lineare Bestandssuche — bei
   * zehntausenden Zeilen sonst quadratisch.
   *
   * @throws {HistoricalStoreError} bei fehlendem `instrumentId` oder einem
   *   Timeframe außerhalb der Allowlist (Gruppe wird numbered gemeldet).
   */
  appendSeries(groups: readonly CandleSeriesGroup[], now: Date): AppendSeriesResult {
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) {
      return { written: 0, deduplicated: 0, invalid: 0, groups: 0, perGroup: [] };
    }
    for (let i = 0; i < list.length; i++) {
      const group = list[i];
      if (!isNonEmptyString(group.instrumentId)) {
        throw new HistoricalStoreError(
          "INVALID_INSTRUMENT",
          `appendSeries: Gruppe ${i} hat kein nicht-leeres instrumentId.`,
        );
      }
      if (!isSupportedTimeframe(group.timeframe)) {
        throw new HistoricalStoreError(
          "INVALID_TIMEFRAME",
          `appendSeries: Gruppe ${i} timeframe "${String(group.timeframe)}" ist nicht in der Allowlist ` +
            `(${SUPPORTED_TIMEFRAMES.join(", ")}). Ein ungültiger Timeframe würde Reihen unbemerkt mischen.`,
        );
      }
    }

    const fetchedAt = now.toISOString();
    // 1. Bestand EINMAL laden (strombasiert; Legacy bleibt unangetastet).
    const { entries } = this.loadAll();
    // 2. Index über den Bestand: (instrumentId, timeframe, ts) → Position.
    const index = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) index.set(candleKey(entries[i]), i);

    const perGroup: AppendResult[] = [];
    let written = 0;
    let deduplicated = 0;
    let invalid = 0;

    for (const group of list) {
      const stats: AppendResult = { written: 0, deduplicated: 0, invalid: 0 };
      for (const candle of group.candles ?? []) {
        const entry = buildCandleEntry(candle, group, fetchedAt);
        if (!entry) {
          // Ungültige Eingabe-Kerze: zählen, nicht schreiben (kein Abbruch).
          stats.invalid += 1;
          continue;
        }
        const key = candleKey(entry);
        const at = index.get(key);
        if (at === undefined) {
          index.set(key, entries.length);
          entries.push(entry);
          stats.written += 1;
        } else {
          // Kollision: jüngeres fetchedAt gewinnt; Gleichstand → zuletzt gelesen.
          if (entry.fetchedAt >= entries[at].fetchedAt) entries[at] = entry;
          stats.deduplicated += 1;
        }
      }
      perGroup.push(stats);
      written += stats.written;
      deduplicated += stats.deduplicated;
      invalid += stats.invalid;
    }

    // 3. Kompaktierung je Reihe, dann 4. EIN atomarer Schreibvorgang.
    this.compact(entries);
    this.writeAll(entries);

    return { written, deduplicated, invalid, groups: list.length, perGroup };
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
          'query({ instrumentId, timeframe: "15m" }). Siehe docs/MIGRATION_TIMEFRAME_FIELD.md.',
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

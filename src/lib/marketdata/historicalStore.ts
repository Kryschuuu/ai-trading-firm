/**
 * Historical Store — append-only OHLCV-Speicher mit Timeframe-Dimension.
 *
 * Format: NDJSON (repo-konform wie `data/universe`), eine Kerze pro Zeile,
 * Schema-Version **v2** mit verpflichtendem `timeframe` je Zeile.
 *
 * ── Partitioniertes Layout (ASA-09, v0.17.5) ───────────────────────────────
 * Kerzen liegen **pro `(instrumentId, timeframe)`** in eigener Datei unter
 * `<dir>/series/<encodedKey>.ndjson`. Der Dateiname ist eine bijektive,
 * Dateisystem-sichere und Path-Traversal-freie Kodierung der Serie
 * (Percent-Encoding aller unsicheren Zeichen, siehe
 * {@link encodeSeriesComponent}); `instrumentId` wird **nie** roh in einen
 * Pfad interpoliert. Ein `query({ instrumentId, timeframe })` öffnet und
 * parst dadurch **nur noch die eine Partitionsdatei** der angefragten Serie
 * (`O(N_series)` statt `O(N_all)`). Partitionsdateien sind aufsteigend nach
 * `ts` sortiert, sodass Bereichsabfragen (`from`/`to`/`limit`) zeilenweise
 * effizient filtern können.
 *
 * ── Rückwärtskompatibilität ────────────────────────────────────────────────
 * Bestehende Installationen haben eine monolithische `candles.ndjson`. Diese
 * wird beim ersten Lese-/Schreibzugriff **unter Lock** automatisch und
 * verlustfrei migriert: v2-Zeilen wandeln in die Serien-Dateien (Dedup nach
 * `instrumentId + timeframe + ts`), das Original wird byte-exakt nach
 * `candles.ndjson.migrated-<zeitstempel>` umbenannt (Legacy-Zeilen ohne
 * `timeframe` bleiben ausschließlich dort erhalten und können weiterhin mit
 * `npm run history:migrate` nachgerüstet werden). Schlägt die Migration fehl
 * (z. B. read-only eingehängtes Verzeichnis), lesen `query()`/`readAll()` die
 * Legacy-Datei transparent mit — Lesezugriffe bleiben funktionsfähig.
 *
 * ── Streaming & Speicherkonstanz ───────────────────────────────────────────
 * * Lesen: {@link readLinesSync} liest in festen Chunks (Default 1 MiB) und
 *   dekodiert über `StringDecoder("utf8")` — ein Multi-Byte-UTF-8-Zeichen an
 *   einer Chunk-Grenze wird exakt rekonstruiert statt zu `U+FFFD` zu
 *   verfälschen. `chunkSizeBytes` ist für Grenz-Unit-Tests parametrisierbar.
 * * Schreiben: Zeilen werden in 64-KiB-Bündeln direkt über `writeSync(fd, …)`
 *   geschrieben (`fsyncSync` + `renameSync`), kein Gesamtstring mehr — der
 *   Zusatzspeicher bleibt konstant `O(64 KiB)`, unabhängig von der Anzahl der
 *   Kerzen (kein V8-`RangeError: Invalid string length` mehr).
 *
 * ── Cross-Prozess-Sicherheit ───────────────────────────────────────────────
 * Mutierende Operationen (`append`/`appendSeries`/`clear`/Legacy-Migration)
 * halten eine Dateisperre `<dir>/.store.lock` (`openSync(…, "wx")`, Retry mit
 * Backoff, Stale-Lock-Bereinigung nach Halter-PID/Alter). Zwei Store-Instanzen
 * — auch in verschiedenen Prozessen (Web-Server vs. `scripts/sync-*`) —
 * erzeugen dadurch keine Lost Updates mehr. Temp-Dateien tragen einen
 * kollisionsfreien Namen `${target}.tmp-${process.pid}-${randomUUID()}` und
 * werden im Fehlerfall entfernt. Lesezugriffe brauchen keine Sperre: Sie
 * sehen dank `rename` immer eine konsistente Dateiversion.
 *
 * Jede Zeile trägt Provenienz (venue, feed, ts, fetchedAt). Der logische
 * Primärschlüssel ist `instrumentId + timeframe + ts`; bei Kollision gewinnt
 * der Eintrag mit dem jüngsten `fetchedAt` (deterministische Deduplizierung,
 * siehe {@link HistoricalStore.appendSeries}).
 *
 * Migration des Zeilenschemas v1 → v2 (Timeframe-Dimension):
 *   npm run history:migrate -- --file=data/history/candles.ndjson \
 *     --assume-timeframe=15m [--dry-run]
 * Siehe `docs/HISTORY.md` und `scripts/migrate-history-timeframe.ts`.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { resolveRuntimePath } from "../../lib/appPaths";
import type { MarketCandle } from "./types";
import { SUPPORTED_TIMEFRAMES, isSupportedTimeframe, type SupportedTimeframe } from "./timeframes";
import { DEFAULT_MAX_BARS_PER_SERIES } from "./limits";

// Die Timeframe-Allowlist (`SUPPORTED_TIMEFRAMES`), ihre Periodenlängen
// (`SUPPORTED_TIMEFRAME_MS`) und `isSupportedTimeframe` leben seit v0.6.2 in
// `./timeframes` (reine Daten, client-sicher — Regel-Engine, Mikro-Executor und
// Workshop-UI lesen dieselbe Liste). Der Store re-exportiert sie unverändert:
// bestehende Importe aus diesem Modul bleiben gültig.
export {
  SUPPORTED_TIMEFRAMES,
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "./timeframes";

/**
 * Marker für Zeilen im Legacy-Schema (v1, ohne `timeframe`). Solche Zeilen
 * werden im Runtime-Loader niemals über {@link HistoricalStore.query}
 * ausgeliefert (ein Timeframe-Pflicht-Query kann sie nie matchen) — sie
 * bleiben ausschließlich für `readAll()`/Migration sichtbar und nach der
 * Layout-Migration in der `candles.ndjson.migrated-*`-Backup-Datei erhalten.
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

/** Unterverzeichnis der Serien-Partitionen unter `<dir>`. */
export const SERIES_DIR_NAME = "series";

/**
 * Legacy-Gesamtdatei bestehender Installationen. Existiert sie, wird sie beim
 * ersten Zugriff unter Lock in die Serien-Partitionen migriert und danach
 * byte-exakt als `<LEGACY_FILE_NAME><LEGACY_MIGRATED_SUFFIX><Zeitstempel>`
 * umbenannt (verlustfreies Backup inkl. aller Legacy-Zeilen).
 */
export const LEGACY_FILE_NAME = "candles.ndjson";

/** Namenspräfix des Migration-Backups: `candles.ndjson.migrated-<stamp>`. */
export const LEGACY_MIGRATED_SUFFIX = ".migrated-";

/** Standard-Lese-Chunk (1 MiB) für den zeilenweisen Streaming-Loader. */
export const READ_CHUNK_BYTES = 1 << 20;

/** Schreib-Bündelgröße: zusätzlicher String-Speicher bleibt O(64 KiB). */
const WRITE_CHUNK_BYTES = 64 * 1024;

/** Dateisperre gegen Cross-Prozess-Lost-Updates (mutierende Operationen). */
const LOCK_FILE_NAME = ".store.lock";

/** Default-Timeout für das Akquiren der Store-Sperre. */
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/** Eine Sperre gilt nach dieser Haltezeit als verloren (stale) und wird aufgeräumt. */
const LOCK_STALE_MS = 15_000;

/** Retry-Backoff für belegte Sperren. */
const LOCK_RETRY_BASE_MS = 20;
const LOCK_RETRY_MAX_MS = 250;

/** Maximale Byte-Länge eines kodierten Serien-Namensbestandteils (Pfadlänge). */
const MAX_ENCODED_COMPONENT_BYTES = 160;

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

/** Ergebnis eines Batch-Appends über mehrere Reihen (eine Datei-Revision je berührter Serie). */
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

/** Eine im Store-Verzeichnis gefundene Serie (Ergebnis von {@link HistoricalStore.listSeries}). */
export interface SeriesRef {
  instrumentId: string;
  timeframe: SupportedTimeframe;
  /** Absolute Partitionsdatei der Serie. */
  file: string;
}

/** Diagnose-Kennzahlen des Store-Stands ({@link HistoricalStore.stats}). */
export interface StoreStats extends LoadStats {
  /** Anzahl partitionierter Serien `(instrumentId, timeframe)`. */
  series: number;
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

/** Reihenschlüssel `Instrument ⟂ Timeframe` (für Index-/Cache-Maps). */
export function seriesKey(instrumentId: string, timeframe: string): string {
  return `${instrumentId}\u0000${timeframe}`;
}

/** Voller Dedup-Schlüssel einer Kerze: `instrumentId + timeframe + ts`. */
function candleKey(entry: { instrumentId: string; timeframe: string; ts: number }): string {
  return `${seriesKey(entry.instrumentId, entry.timeframe)}\u0000${entry.ts}`;
}

/**
 * Sortierreihenfolge für Einträge: `ts` aufsteigend, bei Gleichstand
 * `fetchedAt` (stabil, deterministisch).
 */
function byTsThenFetchedAt<T extends { ts: number; fetchedAt: string }>(a: T, b: T): number {
  return a.ts - b.ts || (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0);
}

function sortEntries<T extends { ts: number; fetchedAt: string }>(entries: T[]): T[] {
  return [...entries].sort(byTsThenFetchedAt);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ── Serien-Dateinamen: bijektive, traversal-freie Kodierung ─────────────────

/** Zeichen, die in Serien-Dateinamen roh erlaubt sind (Dateisystem-sicher). */
const SERIES_NAME_SAFE = /[A-Za-z0-9._-]/;

/**
 * Kodiert `instrumentId`/`timeframe` als Dateisystem-sicheren, bijektiven
 * Namensbestandteil: alle Zeichen außer `[A-Za-z0-9._-]` werden
 * percent-kodiert (`%XX` je UTF-8-Byte, Großbuchstaben-Hex). `%` selbst wird
 * mitkodiert (`%25`), dadurch ist die Kodierung injektiv und
 * {@link decodeSeriesComponent} rekonstruiert den Originalwert exakt. Das
 * Ergebnis enthält nie `/`, `\` oder NUL — ein Path-Traversal über
 * Instrument-IDs ist ausgeschlossen.
 *
 * @throws {HistoricalStoreError} bei leerem Wert oder wenn das kodierte
 *   Ergebnis die Pfadlängengrenze ({@link MAX_ENCODED_COMPONENT_BYTES})
 *   überschreitet (fail-closed statt stiller Bijektionsbruch).
 */
export function encodeSeriesComponent(raw: string): string {
  if (!isNonEmptyString(raw)) {
    throw new HistoricalStoreError(
      "INVALID_INSTRUMENT",
      "Serien-Schlüssel: leerer Bestandteil ist nicht zulässig.",
    );
  }
  let out = "";
  for (const ch of raw) {
    if (SERIES_NAME_SAFE.test(ch)) {
      out += ch;
      continue;
    }
    const bytes = Buffer.from(ch, "utf8");
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out.length === 0 || Buffer.byteLength(out, "utf8") > MAX_ENCODED_COMPONENT_BYTES) {
    throw new HistoricalStoreError(
      "INSTRUMENT_ID_TOO_LONG",
      `Serien-Schlüssel kodiert zu einem unzulässig langen Dateinamen ` +
        `(> ${MAX_ENCODED_COMPONENT_BYTES} Bytes). Instrument-ID kürzen; ` +
        "der Store weigert sich, die Bijektion über Hash-Kürzung still zu brechen.",
    );
  }
  return out;
}

/**
 * Dekodiert einen via {@link encodeSeriesComponent} kodierten Bestandteil.
 * Gibt `null` bei formal unzulässigen/nicht-kanonischen Namen zurück (z. B.
 * händisch angelegte Dateien) — solche Partitionen werden beim Verzeichnis-
 * Scan übersprungen.
 */
export function decodeSeriesComponent(encoded: string): string | null {
  if (!encoded) return null;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded[i];
    if (c === "%") {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (c.charCodeAt(0) > 0x7f) return null; // roh sind nur ASCII-Zeichen erlaubt
    bytes.push(c.charCodeAt(0));
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  // Bijektions-Guard: Re-Kodierung muss den Namen reproduzieren (wehrt gegen
  // nicht-kanonische Namen wie `%5F%5F` für `__`).
  return encodeSeriesComponent(decoded) === encoded ? decoded : null;
}

/**
 * Partitionsdateiname einer Serie: `<encodedInstrumentId>__<timeframe>.ndjson`.
 * Der Timeframe stammt aus der Allowlist (keine Sonderzeichen); die Trennung
 * erfolgt beim Parsen am **letzten** `__`, sodass auch IDs mit Unterstrichen
 * bijektiv bleiben.
 *
 * @throws {HistoricalStoreError} bei Timeframe außerhalb der Allowlist oder
 *   leerem/unzulässig langem `instrumentId`.
 */
export function seriesFileName(instrumentId: string, timeframe: string): string {
  if (!isSupportedTimeframe(timeframe)) {
    throw new HistoricalStoreError(
      "INVALID_TIMEFRAME",
      `seriesFileName: timeframe "${String(timeframe)}" ist nicht in der Allowlist ` +
        `(${SUPPORTED_TIMEFRAMES.join(", ")}).`,
    );
  }
  return `${encodeSeriesComponent(instrumentId)}__${timeframe}.ndjson`;
}

/**
 * Umkehrung von {@link seriesFileName}: liest `(instrumentId, timeframe)` aus
 * einem Partitionsdateinamen. `null` bei fremden/nicht-kanonischen Dateien
 * (werden nie gelesen, nur übersprungen).
 */
export function parseSeriesFileName(fileName: string): { instrumentId: string; timeframe: SupportedTimeframe } | null {
  if (!fileName.endsWith(".ndjson")) return null;
  const base = fileName.slice(0, -".ndjson".length);
  const sep = base.lastIndexOf("__");
  if (sep <= 0) return null;
  const timeframe = base.slice(sep + 2);
  if (!isSupportedTimeframe(timeframe)) return null;
  const instrumentId = decodeSeriesComponent(base.slice(0, sep));
  if (!isNonEmptyString(instrumentId)) return null;
  return { instrumentId, timeframe };
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

/** Serialisiert einen Eintrag als v2-NDJSON-Zeile (deterministische Feldreihenfolge). */
export function serializeEntryLine(entry: HistoricalCandleEntry): string {
  return JSON.stringify({ v: HISTORY_SCHEMA_VERSION, ...entry });
}

/** Bereits gewarnte Dateipfade (Warnung zur Legacy-Migration genau einmal). */
const warnedLegacyFiles = new Set<string>();

/** Bereits gewarnte Sperren-/Migrations-Konflikte (einmalige Warnung je Verzeichnis). */
const warnedReadFallbacks = new Set<string>();

function warnCorruptedLine(file: string, line: string): void {
  console.warn(`[historical-store] kaputte Zeile in ${file} wird übersprungen: ${line.slice(0, 120)}`);
}

function warnInvalidLine(file: string, line: string): void {
  console.warn(`[historical-store] ungültige Zeile in ${file} wird übersprungen: ${line.slice(0, 120)}`);
}

// ── Streaming-Leser (UTF-8-verlustfrei über beliebige Chunk-Grenzen) ────────

/**
 * Ruft `onLine` für jede Zeile der NDJSON-Datei auf, ohne die Datei als
 * Ganzes im Speicher zu halten. Gelesen wird in festen Blöcken
 * (`chunkSizeBytes`, Default 1 MiB); die Dekodierung läuft über
 * `StringDecoder("utf8")`, sodass Multi-Byte-UTF-8-Sequenzen, die exakt auf
 * einer Chunk-Grenze liegen, verlustfrei rekonstruiert werden (ASA-09: das
 * frühere isolierte `buf.toString("utf8")` je Block erzeugte `U+FFFD`).
 * Eine letzte Zeile ohne abschließendes Newline wird noch ausgeliefert.
 */
function forEachLineSync(
  filePath: string,
  onLine: (line: string) => void,
  chunkSizeBytes: number = READ_CHUNK_BYTES,
): void {
  const chunkSize = Math.max(1, Math.floor(chunkSizeBytes));
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    // StringDecoder puffert unvollständige Multi-Byte-Sequenzen zwischen den
    // Blöcken; decoder.end() spült den Rest am Dateiende.
    const decoder = new StringDecoder("utf8");
    let carry = "";
    for (;;) {
      const bytesRead = readSync(fd, buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      const text = carry + decoder.write(buf.subarray(0, bytesRead));
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    }
    const tail = carry + decoder.end();
    if (tail.length > 0) onLine(tail);
  } finally {
    closeSync(fd);
  }
}

/**
 * Pufferbasierter Zeilenleser (Streaming-Semantik ohne OOM): liest die Datei
 * in festen Blöcken und liefert die Zeilen als Array. `chunkSizeBytes` ist
 * bewusst parametrisierbar, damit Unit-Tests Multi-Byte-UTF-8-Splitting an
 * beliebigen Grenzen (z. B. 16/17-Byte-Puffer) nachweisen können. Für sehr
 * große Dateien {@link forEachLineSync} bevorzugen (kein Zeilen-Array im RAM).
 */
export function readLinesSync(filePath: string, chunkSizeBytes: number = READ_CHUNK_BYTES): string[] {
  const lines: string[] = [];
  forEachLineSync(filePath, (line) => lines.push(line), chunkSizeBytes);
  return lines;
}

// ── Atomares, speicherkonstantes Schreiben ──────────────────────────────────

/**
 * Schreibt `lines` als NDJSON atomar nach `targetPath`:
 *
 * * Zeilen werden in 64-KiB-Bündeln direkt über `writeSync(fd, chunk)`
 *   geschrieben — der zusätzliche String-Speicher bleibt konstant
 *   `O(64 KiB)` unabhängig von der Zeilenzahl (ASA-09: kein
 *   `map(...).join("\n")`-Gesamtstring mehr, kein V8-`RangeError`).
 * * Kollisionsfreier Temp-Name `${targetPath}.tmp-${process.pid}-${randomUUID()}`
 *   (ASA-09: `${...}.tmp-${process.pid}` kollidierte bei verschachtelten
 *   Aufrufen desselben Prozesses). Bei Fehlern wird die Temp-Datei im
 *   `catch` entfernt (`rmSync(…, { force: true })`).
 * * `fsyncSync(fd)` + `renameSync(tmp, target)`: Leser sehen dank `rename`
 *   immer eine vollständige Dateiversion, niemals halbe Dateien.
 */
function writeLinesAtomic(targetPath: string, lines: Iterable<string>, mode: number = 0o600): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      let bundle: string[] = [];
      let bundleBytes = 0;
      const flush = (): void => {
        if (bundle.length === 0) return;
        const chunk = Buffer.from(bundle.join("\n") + "\n", "utf8");
        let offset = 0;
        while (offset < chunk.length) {
          offset += writeSync(fd, chunk, offset, chunk.length - offset);
        }
        bundle = [];
        bundleBytes = 0;
      };
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (bundleBytes > 0 && bundleBytes + lineBytes > WRITE_CHUNK_BYTES) flush();
        bundle.push(line);
        bundleBytes += lineBytes;
      }
      flush();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, targetPath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ── Dateisperre gegen Cross-Prozess-Lost-Updates ────────────────────────────

function lockPathFor(dir: string): string {
  return path.join(dir, LOCK_FILE_NAME);
}

/** Blockierendes Warten (sync-kompatibel) über `Atomics.wait`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/** `true`, wenn ein Prozess mit dieser PID lebt (`kill(pid, 0)`-Probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM heißt: Prozess existiert, gehört aber einem anderen User.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockOwner(lockPath: string): { pid: number; heldAtMs: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; heldAtMs?: unknown };
    if (
      typeof parsed?.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed?.heldAtMs === "number" &&
      Number.isFinite(parsed.heldAtMs)
    ) {
      return { pid: parsed.pid, heldAtMs: parsed.heldAtMs };
    }
  } catch {
    // Kaputte/fremde Lock-Datei: nur über die Altersregel aufräumen.
  }
  return null;
}

/**
 * Eine Sperre ist "stale", wenn ihr Halter nicht mehr lebt oder sie länger
 * als {@link LOCK_STALE_MS} gehalten wird (z. B. nach `kill -9` eines
 * Sync-Prozesses). Stale Sperren werden beim nächsten Versuch entfernt.
 */
function isStaleLock(lockPath: string): boolean {
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    ageMs = Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
  } catch {
    return false; // verschwunden → kein Aufräumen nötig
  }
  const owner = readLockOwner(lockPath);
  if (owner && !isProcessAlive(owner.pid)) return true;
  return ageMs > LOCK_STALE_MS;
}

/**
 * Akquiriert `<dir>/.store.lock` exklusiv (`openSync(…, "wx")`). Belegte
 * Sperren werden mit Backoff erneut versucht; stale Sperren (toter Halter,
 * abgelaufene Haltezeit) werden entfernt und übernommen.
 *
 * @throws {HistoricalStoreError} code `LOCK_TIMEOUT`, wenn die Sperre bis zum
 *   Timeout nicht frei wird.
 */
function acquireStoreLock(dir: string, timeoutMs: number): void {
  mkdirSync(dir, { recursive: true });
  const lockPath = lockPathFor(dir);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let attempt = 0;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        const payload = JSON.stringify({ pid: process.pid, heldAtMs: Date.now() }) + "\n";
        writeSync(fd, Buffer.from(payload, "utf8"));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStaleLock(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new HistoricalStoreError(
          "LOCK_TIMEOUT",
          `HistoricalStore: ${LOCK_FILE_NAME} in ${dir} wurde nicht innerhalb von ` +
            `${Math.max(0, timeoutMs)} ms frei (anderer Sync/Server hält die Sperre). ` +
            "Kein Read-Modify-Write ohne Sperre — bitte später erneut versuchen.",
        );
      }
      attempt += 1;
      sleepSync(Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_BASE_MS * attempt));
    }
  }
}

/**
 * Gibt die Sperre wieder frei — aber nur, wenn sie noch uns gehört. Wurde
 * unsere (stale gewordene) Sperre inzwischen von einem anderen Prozess
 * übernommen, lassen wir deren Datei unangetastet.
 */
function releaseStoreLock(dir: string): void {
  const lockPath = lockPathFor(dir);
  const owner = readLockOwner(lockPath);
  if (owner && owner.pid !== process.pid) return;
  rmSync(lockPath, { force: true });
}

// ── Merging/Kompaktierung ───────────────────────────────────────────────────

/**
 * Kappt die ältesten Bars einer Serie über `maxBarsPerSeries`
 * (`Infinity` deaktiviert die Kompaktierung).
 */
function compactSeries(entries: HistoricalCandleEntry[], maxBarsPerSeries: number): HistoricalCandleEntry[] {
  if (maxBarsPerSeries === Number.POSITIVE_INFINITY || entries.length <= maxBarsPerSeries) return entries;
  return sortEntries(entries).slice(-maxBarsPerSeries);
}

/** Ergebnis eines Legacy-Datei-Scans (für LoadStats-Verrechnung). */
interface LegacyScanStats {
  total: number;
  legacy: number;
  corrupted: number;
  valid: number;
}

export class HistoricalStore {
  readonly dir: string;
  readonly filePath: string;
  /** Verzeichnis der partitionierten Serien: `<dir>/series`. */
  readonly seriesDir: string;
  /** Maximale Bars je Reihe (instrumentId+timeframe) nach Kompaktierung. */
  readonly maxBarsPerSeries: number;
  /** Timeout (ms) für die Store-Dateisperre mutierender Operationen. */
  readonly lockTimeoutMs: number;

  constructor(dir?: string, opts: { maxBarsPerSeries?: number; lockTimeoutMs?: number } = {}) {
    // Der Pfad wird ausschließlich aus dem konfigurierten `dir` gebildet.
    // instrumentId/timeframe/feed werden NIE in Pfade interpoliert (kein
    // Path-Traversal) — Serien liegen unter `<dir>/series/<encodedKey>.ndjson`
    // mit einer bijektiven Percent-Kodierung (siehe seriesFileName).
    this.dir = resolveRuntimePath(dir ?? "data/history");
    this.filePath = path.join(this.dir, "candles.ndjson");
    this.seriesDir = path.join(this.dir, SERIES_DIR_NAME);
    this.maxBarsPerSeries = Math.max(1, Math.floor(opts.maxBarsPerSeries ?? DEFAULT_MAX_BARS_PER_SERIES));
    this.lockTimeoutMs = Math.max(0, Math.floor(opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  }

  /** Partitionsdatei einer Serie (`<dir>/series/<encodedKey>.ndjson`). */
  seriesFilePath(instrumentId: string, timeframe: SupportedTimeframe): string {
    // Der Dateiname wird vollständig aus der kodierten, traversal-freien
    // Kodierung gebildet; das rohe instrumentId fließt nie in den Pfad ein.
    const fileName = seriesFileName(instrumentId, timeframe);
    return path.join(this.seriesDir, fileName);
  }

  /**
   * Hängt Kerzen an und dedupliziert deterministisch gegen den Bestand.
   *
   * Logischer Schlüssel: `instrumentId + timeframe + ts`. Bei Kollision
   * gewinnt der Eintrag mit dem jüngsten `fetchedAt`; bei Gleichstand der
   * zuletzt gelesene/geschriebene. Es wird **nur die Partitionsdatei der
   * betroffenen Serie** neu geschrieben (atomar `tmp`+`rename` unter
   * Dateisperre); wachsende Reihen werden bei Bedarf auf
   * `maxBarsPerSeries` (Default `DEFAULT_MAX_BARS_PER_SERIES`, aktuell
   * 100.000) kompaktiert.
   *
   * `timeframe` ist ein expliziter, Pflicht-Parameter: es gibt KEINE
   * überladene alte Signatur mehr, damit TypeScript jeden Aufrufer zur
   * Migration zwingt (kein optionaler Parameter, der den Mix-Bug still
   * reproduzieren würde).
   *
   * @returns `{ written, deduplicated, invalid }` — neu geschriebene bzw. als
   *   Duplikat verworfene Bars.
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
   * Batch-Append über mehrere Reihen mit EINEM Lese-/Schreibzyklus **je
   * betroffener Serie**.
   *
   * WARUM es das gibt: Ein Market-Data-Sync befüllt bis zu 250 Instrumente ×
   * 4 Timeframes — ein Append je Gruppe würde jede Serie wiederholt atomar
   * umschreiben (O(n²) I/O). Diese Methode bündelt die Eingabe je
   * `(instrumentId, timeframe)` und schreibt jede berührte Partitionsdatei
   * genau einmal — unter einem einzigen Sperrenzyklus, atomares
   * `tmp`+`rename`, gebündelte 64-KiB-Schreibvorgänge. Nur berührte Serien
   * werden gelesen: Der Lauf skaliert mit der Eingabe, nicht mit dem
   * Gesamtbestand (ASA-09).
   *
   * Die Semantik ist bewusst identisch zu {@link append}: Schlüssel
   * `instrumentId + timeframe + ts`, jüngstes `fetchedAt` gewinnt,
   * Kompaktierung auf `maxBarsPerSeries`, ungültige Bars werden gezählt
   * statt den Lauf abzubrechen.
   *
   * @throws {HistoricalStoreError} bei fehlendem `instrumentId`, einem
   *   Timeframe außerhalb der Allowlist (Gruppe wird numbered gemeldet) oder
   *   `LOCK_TIMEOUT`, wenn ein anderer Prozess die Store-Sperre hält.
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
    // Eingabe je Serie bündeln — Gruppenreihenfolge bleibt erhalten; zwei
    // Gruppen derselben Serie im selben Lauf deduplizieren gegeneinander.
    const perGroup: AppendResult[] = list.map(() => ({ written: 0, deduplicated: 0, invalid: 0 }));
    const seriesOrder: Array<{ instrumentId: string; timeframe: SupportedTimeframe }> = [];
    const segmentsBySeries = new Map<string, Array<{ groupIndex: number; entries: HistoricalCandleEntry[] }>>();
    for (let i = 0; i < list.length; i++) {
      const group = list[i];
      const stats = perGroup[i];
      const key = seriesKey(group.instrumentId, group.timeframe);
      let segments = segmentsBySeries.get(key);
      if (!segments) {
        segments = [];
        segmentsBySeries.set(key, segments);
        seriesOrder.push({ instrumentId: group.instrumentId, timeframe: group.timeframe });
      }
      const entries: HistoricalCandleEntry[] = [];
      for (const candle of group.candles ?? []) {
        const entry = buildCandleEntry(candle, group, fetchedAt);
        if (!entry) {
          // Ungültige Eingabe-Kerze: zählen, nicht schreiben (kein Abbruch).
          stats.invalid += 1;
          continue;
        }
        entries.push(entry);
      }
      if (entries.length > 0) segments.push({ groupIndex: i, entries });
    }

    // EIN Sperrenzyklus: Legacy-Migration + Read-Modify-Write aller
    // betroffenen Serien sind gegen parallele Prozesse serialisiert
    // (keine Lost Updates zwischen Web-Server und Sync-CLI).
    this.withStoreLock(() => {
      // Legacy-Datei verlustfrei überführen, bevor Serien gemerged werden.
      this.migrateLegacyIfPresentLocked();

      for (const series of seriesOrder) {
        const target = this.seriesFilePath(series.instrumentId, series.timeframe);
        const existing = readSeriesFileEntries(target);
        // Index über den Bestand der Serie: ts → aktueller Eintrag.
        const byTs = new Map<number, HistoricalCandleEntry>();
        for (const e of existing) byTs.set(e.ts, e);
        let mutated = false;

        for (const segment of segmentsBySeries.get(seriesKey(series.instrumentId, series.timeframe)) ?? []) {
          const stats = perGroup[segment.groupIndex];
          for (const entry of segment.entries) {
            const at = byTs.get(entry.ts);
            if (at === undefined) {
              byTs.set(entry.ts, entry);
              stats.written += 1;
              mutated = true;
            } else {
              // Kollision: jüngeres fetchedAt gewinnt; Gleichstand → zuletzt geschrieben.
              stats.deduplicated += 1;
              if (entry.fetchedAt >= at.fetchedAt) {
                byTs.set(entry.ts, entry);
                mutated = true;
              }
            }
          }
        }

        const merged = sortEntries([...byTs.values()]);
        const compacted = compactSeries(merged, this.maxBarsPerSeries);
        // Schreiben nur bei tatsächlicher Änderung (kein I/O für reine
        // Duplikat-Läufe); Kompaktierung gilt ebenfalls als Änderung.
        if (mutated || compacted.length !== merged.length) {
          writeSeriesFile(target, compacted);
        }
      }
    });

    const written = perGroup.reduce((sum, s) => sum + s.written, 0);
    const deduplicated = perGroup.reduce((sum, s) => sum + s.deduplicated, 0);
    const invalid = perGroup.reduce((sum, s) => sum + s.invalid, 0);
    return { written, deduplicated, invalid, groups: list.length, perGroup };
  }

  /**
   * Führt den Store-Schreibpfad unter der Dateisperre aus. Bei `LOCK_TIMEOUT`
   * wird der Fehler propagiert — niemals ohne Sperre schreiben.
   */
  private withStoreLock<T>(fn: () => T): T {
    acquireStoreLock(this.dir, this.lockTimeoutMs);
    try {
      return fn();
    } finally {
      releaseStoreLock(this.dir);
    }
  }

  /**
   * Liefert Kerzen EINES Instruments EINES Timeframes, ts aufsteigend.
   *
   * `timeframe` ist Pflicht (Compile + Runtime-Guard). Ein Timeframe-freier
   * Zugriff würde Kerzen unterschiedlicher Periodizität mischen.
   *
   * Öffnet und parst **ausschließlich die Partitionsdatei dieser Serie**
   * ( ASA-09: vorher wurde bei jedem Query die gesamte `candles.ndjson` aller
   * Instrumente gelesen und deserialisiert). Existiert eine noch nicht
   * migrierte Legacy-Datei, wird sie vorher unter Lock überführt; schlägt das
   * (z. B. read-only) fehl, wird sie für diesen Aufruf transparent mitgelesen
   * und gefiltert.
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
    this.migrateLegacyForRead();
    const out: HistoricalCandleEntry[] = [];
    const target = this.seriesFilePath(q.instrumentId, q.timeframe);
    const from = q.from;
    const to = q.to;
    const seenTs = new Set<number>();
    if (existsSync(target)) {
      // Effizientes Filtern im Strom: from/to prüfen VOR dem Materialisieren;
      // die Datei ist ts-aufsteigend, limit selektiert nach dem Sortieren.
      forEachLineSync(target, (line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(t);
        } catch {
          warnCorruptedLine(target, t);
          return;
        }
        const result = parseCandleLine(parsed);
        if (!result) {
          warnInvalidLine(target, t);
          return;
        }
        if (result.legacy) return; // Partitionen enthalten keine Legacy-Zeilen
        const e = result.entry;
        seenTs.add(e.ts);
        if (from !== undefined && e.ts < from) return;
        if (to !== undefined && e.ts > to) return;
        out.push(e);
      });
    }
    // Read-only-Fallback: Migration nicht möglich → Legacy-Datei gefiltert
    // mitlesen (Dedup gegen die Partition via seenTs).
    if (existsSync(this.filePath)) {
      this.streamLegacyFiltered(q.instrumentId, q.timeframe, from, to, out, seenTs);
    }
    out.sort(byTsThenFetchedAt);
    if (q.limit !== undefined && q.limit > 0) {
      // Die letzten `limit` Bars (jüngste), wieder ts aufsteigend zurückgeben.
      return out.slice(-q.limit);
    }
    return out;
  }

  /**
   * Fügt passende Zeilen der (noch nicht migrierten) Legacy-Datei hinzu.
   * `seenTs` enthält bereits aus der Partition gelesene `ts`-Werte — im
   * Degenerationsfall "Partition existiert UND Legacy-Datei konnte nicht
   * migriert werden" werden Doppelzählungen so vermieden.
   */
  private streamLegacyFiltered(
    instrumentId: string,
    timeframe: SupportedTimeframe,
    from: number | undefined,
    to: number | undefined,
    out: HistoricalCandleEntry[],
    seenTs?: Set<number>,
  ): void {
    forEachLineSync(this.filePath, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        warnCorruptedLine(this.filePath, t);
        return;
      }
      const result = parseCandleLine(parsed);
      if (!result || result.legacy) return;
      const e = result.entry;
      if (e.instrumentId !== instrumentId || e.timeframe !== timeframe) return;
      if (seenTs?.has(e.ts)) return;
      if (from !== undefined && e.ts < from) return;
      if (to !== undefined && e.ts > to) return;
      seenTs?.add(e.ts);
      out.push(e);
    });
  }

  /**
   * Legacy-Migration für Lesezugriffe: best-effort. Schlägt die Migration
   * fehl (Sperre nicht akquirierbar, read-only), warnen wir einmal und lesen
   * die Legacy-Datei transparent weiter — Lesezugriffe bleiben funktionsfähig.
   *
   * @returns die Scan-Zähler der migrierten Datei (für LoadStats) oder `null`.
   */
  private migrateLegacyForRead(): LegacyScanStats | null {
    if (!existsSync(this.filePath)) return null;
    let scan: LegacyScanStats | null = null;
    try {
      this.withStoreLock(() => {
        if (existsSync(this.filePath)) scan = this.migrateLegacyIfPresentLocked();
      });
    } catch (error) {
      if (!warnedReadFallbacks.has(this.dir)) {
        warnedReadFallbacks.add(this.dir);
        console.warn(
          `[historical-store] Legacy-Migration von ${this.filePath} nicht möglich ` +
            `(${error instanceof Error ? error.message : String(error)}) — es wird transparent ` +
            "aus der Legacy-Datei gelesen.",
        );
      }
    }
    return scan;
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

  /**
   * Streamt alle Serien-Partitionen und aggregiert die Zähler
   * (Diagnose/Migration). Kaputte Zeilen werden gezählt, geloggt und
   * übersprungen; Legacy-Zeilen werden gezählt und nicht als v2-Einträge
   * zurückgegeben.
   */
  loadAll(): { entries: HistoricalCandleEntry[]; stats: LoadStats } {
    // Legacy-Datei ggf. unter Lock migrieren; ihre Scan-Zähler (inkl. Legacy-
    // und Kaputt-Zeilen) gehen in die Gesamtstatistik ein — die gültigen Bars
    // selbst kommen danach aus den frisch geschriebenen Partitionen.
    const migrated = this.migrateLegacyForRead();
    const stats: LoadStats = { total: 0, legacy: 0, corrupted: 0, valid: 0 };
    if (migrated) {
      stats.total += migrated.total;
      stats.legacy += migrated.legacy;
      stats.corrupted += migrated.corrupted;
    }
    const entries: HistoricalCandleEntry[] = [];
    // Dedup-Schlüssel über alle Quellen (verhindert Doppelzählung, falls eine
    // Legacy-Datei nicht migriert werden konnte, ihre v2-Zeilen aber bereits
    // als Partition vorliegen).
    const seen = new Set<string>();
    const ingestLine = (file: string, line: string, skipSeenV2: boolean): void => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      stats.total += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        stats.corrupted += 1;
        warnCorruptedLine(file, t);
        return;
      }
      const result = parseCandleLine(parsed);
      if (!result) {
        stats.corrupted += 1;
        warnInvalidLine(file, t);
        return;
      }
      if (result.legacy) {
        stats.legacy += 1;
        return;
      }
      const dedupKey = candleKey(result.entry);
      if (skipSeenV2 && seen.has(dedupKey)) return;
      seen.add(dedupKey);
      stats.valid += 1;
      entries.push(result.entry);
    };

    if (existsSync(this.seriesDir)) {
      for (const name of readdirSync(this.seriesDir).sort()) {
        if (!name.endsWith(".ndjson")) continue;
        const file = path.join(this.seriesDir, name);
        forEachLineSync(file, (line) => ingestLine(file, line, false));
      }
    }
    // Legacy-Fallback (nach fehlgeschlagener Migration) mitzählen/mitlesen;
    // bereits partitionierte v2-Zeilen werden nicht doppelt geliefert.
    if (existsSync(this.filePath)) {
      forEachLineSync(this.filePath, (line) => ingestLine(this.filePath, line, true));
      this.warnLegacyOnce();
    }
    return { entries, stats };
  }

  /** Einmalige Legacy-Warnung je Datei (gleicher Text wie vor ASA-09). */
  private warnLegacyOnce(): void {
    if (warnedLegacyFiles.has(this.filePath)) return;
    warnedLegacyFiles.add(this.filePath);
    console.warn(
      `[historical-store] ${this.filePath} enthaelt Zeilen im ` +
        `Legacy-Schema (ohne timeframe). Diese Bars werden ignoriert. Fuehre ` +
        "`npm run history:migrate` aus.",
    );
  }

  /**
   * Anzahl Kerzen (Diagnose). Mit `instrumentId` **und** `timeframe` wird nur
   * die eine Partitionsdatei gelesen; sonst laufen alle Serien im Strom mit.
   */
  count(instrumentId?: string, timeframe?: SupportedTimeframe): number {
    if (isNonEmptyString(instrumentId) && isSupportedTimeframe(timeframe)) {
      this.migrateLegacyForRead();
      let n = 0;
      const seenTs = new Set<number>();
      const target = this.seriesFilePath(instrumentId, timeframe);
      if (existsSync(target)) {
        forEachLineSync(target, (line) => {
          const t = line.trim();
          if (!t || t.startsWith("#")) return;
          try {
            const result = parseCandleLine(JSON.parse(t));
            if (result && !result.legacy) {
              seenTs.add(result.entry.ts);
              n += 1;
            }
          } catch {
            // kaputte Zeilen zählen nicht als Bar
          }
        });
      }
      if (existsSync(this.filePath)) {
        const legacy: HistoricalCandleEntry[] = [];
        this.streamLegacyFiltered(instrumentId, timeframe, undefined, undefined, legacy, seenTs);
        n += legacy.length;
      }
      return n;
    }
    const { entries } = this.loadAll();
    return entries.filter(
      (e) =>
        (!instrumentId || e.instrumentId === instrumentId) &&
        (!timeframe || e.timeframe === timeframe),
    ).length;
  }

  /**
   * Listet alle partitionierten Serien `(instrumentId, timeframe)` auf
   * (deterministisch sortiert). Nicht-kanonische Dateien im `series`-Ordner
   * werden stillschweigend übersprungen.
   */
  listSeries(): SeriesRef[] {
    this.migrateLegacyForRead();
    if (!existsSync(this.seriesDir)) return [];
    const out: SeriesRef[] = [];
    for (const name of readdirSync(this.seriesDir).sort()) {
      const parsed = parseSeriesFileName(name);
      if (!parsed) continue;
      out.push({ instrumentId: parsed.instrumentId, timeframe: parsed.timeframe, file: path.join(this.seriesDir, name) });
    }
    return out;
  }

  /**
   * Diagnose-Kennzahlen: Anzahl Serien plus die Loader-Zähler
   * (`total`/`valid`/`legacy`/`corrupted`) über alle Partitionen.
   */
  stats(): StoreStats {
    const series = this.listSeries().length;
    const { stats } = this.loadAll();
    return { series, ...stats };
  }

  /**
   * Entfernt alle Serien-Partitionen, Legacy-Reste und Temp-Dateien des
   * Stores (unter Sperre). Wartungs-API für Tests/Reset — für produktive
   * Daten vorher `data/history` sichern.
   */
  clear(): { removedFiles: number } {
    return this.withStoreLock(() => {
      let removedFiles = 0;
      if (existsSync(this.seriesDir)) {
        for (const name of readdirSync(this.seriesDir)) {
          rmSync(path.join(this.seriesDir, name), { force: true, recursive: true });
          removedFiles += 1;
        }
      }
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          // candles.ndjson + Backups (.migrated-*) + verwaiste .tmp-Reste
          if (name === LEGACY_FILE_NAME || name.startsWith(`${LEGACY_FILE_NAME}.`)) {
            rmSync(path.join(this.dir, name), { force: true, recursive: true });
            removedFiles += 1;
          }
        }
      }
      return { removedFiles };
    });
  }

  /**
   * Migriert eine vorhandene Legacy-`candles.ndjson` verlustfrei in die
   * Serien-Partitionen. MUSS unter der Store-Sperre laufen.
   *
   * Ablauf:
   *  1. Die Datei wird zeilenweise gestreamt; v2-Zeilen werden je Serie
   *     gesammelt, Legacy-/Kaputt-Zeilen gezählt (gleiche Warnungen wie der
   *     frühere Loader).
   *  2. Je Serie: Merge mit der bestehenden Partition (Dedup `ts`, jüngstes
   *     `fetchedAt` gewinnt) und atomares Schreiben.
   *  3. Das Original wird byte-exakt (inkl. aller Legacy-Zeilen) nach
   *     `candles.ndjson.migrated-<stamp>-<uuid>` umbenannt — nichts geht
   *     verloren, `npm run history:migrate` kann die Backup-Datei weiter
   *     verarbeiten.
   *
   * Idempotent gegenüber Abbrüchen: Ein erneuter Lauf dedupliziert
   * deterministisch gegen die bereits geschriebenen Partitionen.
   *
   * @returns die Scan-Zähler der gelesenen Legacy-Datei.
   */
  private migrateLegacyIfPresentLocked(): LegacyScanStats {
    if (!existsSync(this.filePath)) return { total: 0, legacy: 0, corrupted: 0, valid: 0 };
    const groups = new Map<
      string,
      { instrumentId: string; timeframe: SupportedTimeframe; entries: HistoricalCandleEntry[] }
    >();
    const scan: LegacyScanStats = { total: 0, legacy: 0, corrupted: 0, valid: 0 };
    forEachLineSync(this.filePath, (line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      scan.total += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        scan.corrupted += 1;
        warnCorruptedLine(this.filePath, t);
        return;
      }
      const result = parseCandleLine(parsed);
      if (!result) {
        scan.corrupted += 1;
        warnInvalidLine(this.filePath, t);
        return;
      }
      if (result.legacy) {
        scan.legacy += 1;
        return; // bleibt ausschließlich in der Backup-Datei erhalten
      }
      scan.valid += 1;
      const e = result.entry;
      const key = seriesKey(e.instrumentId, e.timeframe);
      const group = groups.get(key) ?? { instrumentId: e.instrumentId, timeframe: e.timeframe, entries: [] };
      group.entries.push(e);
      groups.set(key, group);
    });

    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key);
      if (!group) continue;
      const target = this.seriesFilePath(group.instrumentId, group.timeframe);
      const merged = mergeEntries(readSeriesFileEntries(target), group.entries);
      writeSeriesFile(target, compactSeries(merged, this.maxBarsPerSeries));
    }

    // Verlustfreies Backup: Original byte-exakt umbenennen (kein Umschreiben).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${this.filePath}${LEGACY_MIGRATED_SUFFIX}${stamp}-${randomUUID().slice(0, 8)}`;
    renameSync(this.filePath, backup);

    if (scan.legacy > 0) {
      this.warnLegacyOnce();
      console.warn(
        `[historical-store] ${scan.legacy} Legacy-Zeilen (ohne timeframe) bleiben in ` +
          `${path.basename(backup)} erhalten. Fuehre ` +
          "`npm run history:migrate -- --file=<backup> --assume-timeframe=<tf> --apply` aus.",
      );
    }
    console.warn(
      `[historical-store] ${path.basename(this.filePath)} nach ${this.seriesDir} migriert: ` +
        `${groups.size} Serien, ${scan.valid.toLocaleString("de-DE")} Bars; Backup: ${path.basename(backup)}.`,
    );
    return scan;
  }
}

/**
 * Führt bestehende und neue Einträge einer Serie zusammen. Logischer
 * Schlüssel ist `ts` innerhalb der Serie (`instrumentId + timeframe` steckt
 * in der Partition); bei Kollision gewinnt der Eintrag mit dem jüngsten
 * `fetchedAt`, bei Gleichstand der zuletzt gelesene/geschriebene. Ergebnis
 * ist aufsteigend nach `ts` sortiert.
 */
function mergeEntries(
  existing: HistoricalCandleEntry[],
  incoming: HistoricalCandleEntry[],
): HistoricalCandleEntry[] {
  const byTs = new Map<number, HistoricalCandleEntry>();
  for (const e of existing) byTs.set(e.ts, e);
  for (const e of incoming) {
    const at = byTs.get(e.ts);
    if (at === undefined || e.fetchedAt >= at.fetchedAt) byTs.set(e.ts, e);
  }
  return sortEntries([...byTs.values()]);
}

/**
 * Liest alle gültigen v2-Einträge einer Partitionsdatei (aufsteigend sortiert,
 * wie geschrieben). Kaputte Zeilen werden gewarnt/übersprungen; Legacy-Zeilen
 * (nur bei händisch erweiterten Partitionen möglich) werden ignoriert.
 */
function readSeriesFileEntries(target: string): HistoricalCandleEntry[] {
  if (!existsSync(target)) return [];
  const entries: HistoricalCandleEntry[] = [];
  forEachLineSync(target, (line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      warnCorruptedLine(target, t);
      return;
    }
    const result = parseCandleLine(parsed);
    if (!result || result.legacy) return;
    entries.push(result.entry);
  });
  return entries;
}

/** Schreibt eine Serie ts-aufsteigend als v2-NDJSON atomar (Modus 0600). */
function writeSeriesFile(target: string, entries: HistoricalCandleEntry[]): void {
  // Defensiv erneut sortieren — Partitionen sind vertraglich ts-aufsteigend.
  const sorted = [...entries].sort(byTsThenFetchedAt);
  writeLinesAtomic(target, sorted.map((e) => serializeEntryLine(e)));
}

/**
 * Schreibt den aktuellen Store-Stand als deterministisches Ergebnisartefakt
 * (Golden-/Replay-Test: gleicher Stand → byte-identische Datei). Das Schreiben
 * läuft — wie der Store selbst — gebündelt über 64-KiB-Puffer statt eines
 * Gesamtstrings.
 */
export function writeStoreSnapshot(store: HistoricalStore, outPath: string): void {
  const entries = sortEntries(store.readAll());
  writeLinesAtomic(outPath, entries.map((e) => serializeEntryLine(e)));
}

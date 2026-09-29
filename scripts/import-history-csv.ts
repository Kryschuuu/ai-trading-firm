#!/usr/bin/env node
/**
 * Offline-Import eines Kerzen-CSV in den `HistoricalStore` (STX-00-01, v0.6.0).
 *
 * Zweck: Der Backtest-Benchmark (`scripts/bench-backtest.ts`) MUSS eine echte,
 * aus dem Store gelesene Serie messen — synthetische Bars hätten eine andere
 * Verteilung. Der reguläre Weg in den Store ist `npm run market-sync` (Netz);
 * dieses Skript ist der netzfreie Zweitweg für einen Export, den die Venue
 * oder eine Datenquelle bereits als CSV bereitstellt (z. B. ein
 * Klines-Dump: `unix,date,symbol,open,high,low,close,Volume BTC,…`).
 *
 * Warum kein CSV-Parser-Paket: Das Projekt bleibt dependency-frei (Projekt-
 * Regel „keine neuen Runtime-Dependencies"), und das Eingabeformat ist ein
 * flaches, kommasepariertes Tabellenformat ohne verschachtelte Felder.
 *
 * Verhalten (identisch zur Store-Konvention von `history:migrate`):
 *   - DRY-RUN ist der Default: ohne `--apply` wird nichts geschrieben (Exit 2).
 *   - Geschrieben wird über `HistoricalStore.appendSeries()` — damit gelten
 *     Dedup (`instrumentId+timeframe+ts`), Sortierung, Pfaddir-sichere
 *     Auflösung und der atomare `tmp`+`rename`-Write des Stores.
 *   - Ungültige Zeilen (kein Zeitstempel, Preis ≤ 0, Volumen < 0, zu wenige
 *     Spalten) werden GEZÄHLT und mit Beispielen gemeldet, nie still ersetzt.
 *
 * Aufruf:
 *   npm run history:import-csv -- --file=<pfad.csv> --instrument=BINANCE:BTCUSDT \
 *     [--timeframe=1h] [--dir=data/history] [--max-bars=25000] \
 *     [--from=<ISO|ms>] [--to=<ISO|ms>] [--venue=BINANCE] [--feed=csv-import] \
 *     [--apply]
 *
 * Exit-Codes: 0 importiert (oder Dry-Run ohne verworfene Zeilen … siehe unten),
 * 1 Abbruch (Argumentfehler, unlesbare Datei, keine gültige Zeile),
 * 2 Dry-Run — nichts geschrieben (`--apply` fehlt).
 *
 * Doku: docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md
 */

import { readFileSync, existsSync } from "node:fs";
import {
  HistoricalStore,
  isSupportedTimeframe,
  SUPPORTED_TIMEFRAMES,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../src/lib/marketdata/types";

const HELP = `history:import-csv — Kerzen-CSV offline in den HistoricalStore importieren.

Verwendung:
  npm run history:import-csv -- --file=<pfad.csv> --instrument=<ID> [Optionen]

Pflicht:
  --file=<pfad>        CSV-Datei mit Kopfzeile (Zeit + open/high/low/close/volume).
  --instrument=<ID>    Instrument-ID wie im Store (z. B. BINANCE:BTCUSDT).

Optionen:
  --timeframe=<tf>     Periodizität der Datei. Erlaubt: ${SUPPORTED_TIMEFRAMES.join(", ")}.
                       Default: 1h
  --dir=<pfad>         Store-Verzeichnis. Default: data/history
  --max-bars=<n>       Kompaktierungsgrenze je Reihe (Default 25000). Muss größer
                       als die größte zu messende Kerzenzahl sein, sonst schneidet
                       der Store die ältesten Bars ab (Store-Default: 5000).
  --from=<ISO|ms>      Nur Zeilen ab diesem Zeitpunkt importieren.
  --to=<ISO|ms>        Nur Zeilen bis zu diesem Zeitpunkt importieren.
  --venue=<name>       Provenienz-Venue. Default: Präfix der Instrument-ID.
  --feed=<name>        Provenienz-Feed. Default: csv-import
  --strict             Bei der ersten ungültigen Zeile abbrechen (Exit 1).
  --apply              Schreibt in den Store. OHNE dieses Flag läuft der Dry-Run.
  --help               Diese Hilfe.

Spaltenerkennung (kopfzeilenbasiert, Groß-/Kleinschreibung egal, Leerzeichen und
Sonderzeichen werden ignoriert):
  Zeit     unix, time, timestamp, ts, openTime, date, datetime  (Epoch-s/ms oder ISO)
  Kurse    open, high, low, close
  Volumen  volume, vol, baseVolume — sonst die ERSTE Spalte, die „volume" enthält
           (Basis-Volumen vor Quote-Volumen, z. B. „Volume BTC" vor „Volume USDT")

Exit-Codes: 0 importiert · 1 Abbruch · 2 Dry-Run (nichts geschrieben).`;

/** Normalisierter Spaltenkopf ohne Trenner/Sonderzeichen (boolesch vergleichbar). */
function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface CsvColumns {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TIME_ALIASES = ["unix", "time", "timestamp", "ts", "opentime", "datetime", "date"];
const PRICE_ALIASES: Record<"open" | "high" | "low" | "close", string[]> = {
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c"],
};
const VOLUME_ALIASES = ["volume", "vol", "basevolume", "v"];

/**
 * Bildet die Kopfzeile auf Spaltenindizes ab. `null` = nicht importierbar
 * (dann nennt der Rückgabewert die fehlende Größe, nie nur „Fehler").
 */
export function resolveColumns(header: string[]): { columns: CsvColumns } | { error: string } {
  const normalized = header.map(normalizeHeader);
  const find = (aliases: string[]): number | null => {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return null;
  };

  const time = find(TIME_ALIASES);
  if (time === null) return { error: "keine Zeitspalte gefunden (unix/time/timestamp/date)" };

  const picked: Partial<CsvColumns> = { time };
  for (const key of ["open", "high", "low", "close"] as const) {
    const idx = find(PRICE_ALIASES[key]);
    if (idx === null) return { error: `keine '${key}'-Spalte gefunden` };
    picked[key] = idx;
  }

  let volume = find(VOLUME_ALIASES);
  if (volume === null) volume = normalized.findIndex((h) => h.includes("volume"));
  if (volume < 0) return { error: "keine Volumenspalte gefunden (volume/vol/baseVolume)" };
  picked.volume = volume;

  return { columns: picked as CsvColumns };
}

/**
 * Zeitstempel einer Zeile → Epoch-ms, oder `null` (unbrauchbar).
 * Numerische Werte < 1e11 sind Sekunden (alle Krypto-Venues liefern ms,
 * Sekunden-Werte stammen aus älteren Exporten), sonst ms. Nicht-numerische
 * Werte laufen durch `Date.parse` (ISO-8601).
 */
export function parseCandleTime(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (!Number.isInteger(num)) return null;
    if (num <= 0) return null;
    const ms = num < 1e11 ? num * 1000 : num;
    return Number.isInteger(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Eine CSV-Zeile → validierte Kerze, oder `null` mit Begründung. */
export function parseCandleRow(
  cells: string[],
  columns: CsvColumns,
): { candle: MarketCandle } | { reason: string } {
  const time = parseCandleTime(cells[columns.time]);
  if (time === null) return { reason: "ungültiger Zeitstempel" };

  const nums: Partial<Record<"open" | "high" | "low" | "close" | "volume", number>> = {};
  for (const key of ["open", "high", "low", "close", "volume"] as const) {
    const raw = (cells[columns[key]] ?? "").trim();
    const num = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(num)) return { reason: `ungültiger ${key}-Wert` };
    if (key === "volume" ? num < 0 : num <= 0) return { reason: `${key} außerhalb des Wertebereichs` };
    nums[key] = num;
  }
  if ((nums.high as number) < (nums.low as number)) return { reason: "high < low" };

  return {
    candle: {
      time,
      open: nums.open as number,
      high: nums.high as number,
      low: nums.low as number,
      close: nums.close as number,
      volume: nums.volume as number,
    },
  };
}

export interface ParsedCsv {
  candles: MarketCandle[];
  rows: number;
  rejected: number;
  rejectReasons: string[];
  header: string[];
}

/**
 * Parst den gesamten CSV-Text. Zeilen ohne ausreichende Spaltenzahl und
 * ungültige Werte werden gezählt, nie stillschweigend ersetzt.
 */
export function parseCsv(
  content: string,
  opts: { fromMs?: number; toMs?: number; strict?: boolean } = {},
): ParsedCsv {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("CSV ist leer.");
  const header = lines[0].split(",");
  const resolved = resolveColumns(header);
  if ("error" in resolved) throw new Error(`CSV-Kopfzeile: ${resolved.error}`);
  const { columns } = resolved;

  const candles: MarketCandle[] = [];
  let rejected = 0;
  const rejectReasons: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) {
      rejected += 1;
      if (rejectReasons.length < 3) rejectReasons.push(`Zeile ${i + 1}: zu wenige Spalten`);
      if (opts.strict) break;
      continue;
    }
    const parsed = parseCandleRow(cells, columns);
    if ("reason" in parsed) {
      rejected += 1;
      if (rejectReasons.length < 3) rejectReasons.push(`Zeile ${i + 1}: ${parsed.reason}`);
      if (opts.strict) break;
      continue;
    }
    const ts = parsed.candle.time;
    if (opts.fromMs !== undefined && ts < opts.fromMs) continue;
    if (opts.toMs !== undefined && ts > opts.toMs) continue;
    candles.push(parsed.candle);
  }

  return { candles, rows: lines.length - 1, rejected, rejectReasons, header };
}

/** Epoch-ms aus `--from`/`--to`, identisch zur Semantik von `run-backtest.ts`. */
export function parseTimeArg(raw: string, flag: string): number {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) {
    const ms = Number(t);
    if (Number.isFinite(ms) && ms > 0) return ms;
  } else {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`${flag}="${raw.slice(0, 40)}" ist keine gültige Zeit (ISO-8601 oder Epoch-ms).`);
}

function arg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function fail(message: string): 1 {
  console.error(`[history:import-csv] FEHLER: ${message}`);
  console.error("[history:import-csv] Hilfe: npm run history:import-csv -- --help");
  return 1;
}

/** CLI-Einstieg; gibt den Exit-Code zurück (testbar ohne `process.exit`). */
export function runCli(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const file = arg(argv, "file");
  const instrumentId = arg(argv, "instrument");
  if (!file) return fail("--file=<pfad.csv> fehlt.");
  if (!instrumentId) return fail("--instrument=<ID> (z. B. BINANCE:BTCUSDT) fehlt.");
  if (!existsSync(file)) return fail(`Datei "${file.slice(0, 120)}" existiert nicht.`);

  const timeframeRaw = arg(argv, "timeframe") ?? "1h";
  if (!isSupportedTimeframe(timeframeRaw)) {
    return fail(
      `--timeframe="${timeframeRaw.slice(0, 20)}" ist nicht in der Allowlist (${SUPPORTED_TIMEFRAMES.join(", ")}).`,
    );
  }
  const timeframe: SupportedTimeframe = timeframeRaw;

  const storeDir = arg(argv, "dir") ?? "data/history";
  const maxBarsRaw = Number(arg(argv, "max-bars") ?? "25000");
  if (!Number.isFinite(maxBarsRaw) || maxBarsRaw < 1) return fail("--max-bars muss eine positive Zahl sein.");
  const maxBars = Math.floor(maxBarsRaw);

  let fromMs: number | undefined;
  let toMs: number | undefined;
  try {
    const from = arg(argv, "from");
    const to = arg(argv, "to");
    if (from) fromMs = parseTimeArg(from, "--from");
    if (to) toMs = parseTimeArg(to, "--to");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
    return fail("--from muss vor --to liegen.");
  }

  const apply = argv.includes("--apply");
  const strict = argv.includes("--strict");

  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(readFileSync(file, "utf8"), { fromMs, toMs, strict });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const { candles, rows, rejected } = parsed;
  if (candles.length === 0) {
    return fail(
      `keine importierbare Zeile in "${file.slice(0, 120)}" (${rows} Datenzeilen, ${rejected} verworfen)${fromMs || toMs ? " — prüfe --from/--to" : ""}.`,
    );
  }

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const venue = arg(argv, "venue") ?? (instrumentId.includes(":") ? instrumentId.split(":")[0] : "IMPORT");
  const feed = arg(argv, "feed") ?? "csv-import";
  const first = new Date(sorted[0].time).toISOString();
  const last = new Date(sorted[sorted.length - 1].time).toISOString();

  console.log(
    `[history:import-csv] ${rows} Datenzeilen gelesen, ${candles.length} gültig, ${rejected} verworfen ` +
      `(${first} … ${last}, ${instrumentId} ${timeframe}).`,
  );
  for (const reason of parsed.rejectReasons) console.log(`[history:import-csv]   verworfen → ${reason}`);
  if (rejected > 0) {
    console.log(
      "[history:import-csv] Hinweis: verworfene Zeilen sind Lücken in der Reihe — prüfe sie, bevor du die Serie bewertest.",
    );
  }

  if (!apply) {
    console.log(
      `[history:import-csv] Dry-Run: nichts geschrieben. Ziel wäre ${storeDir} (max ${maxBars} Bars/Reihe). ` +
        "Zum Schreiben --apply anhängen.",
    );
    return 2;
  }

  const store = new HistoricalStore(storeDir, { maxBarsPerSeries: maxBars });
  const result = store.appendSeries(
    [{ instrumentId, timeframe, provenance: { venue, feed }, candles: sorted }],
    new Date(),
  );
  const stored = store.query({ instrumentId, timeframe });
  console.log(
    `[history:import-csv] geschrieben: ${result.written} neu, ${result.deduplicated} dedupliziert, ` +
      `${result.invalid} vom Store verworfen (ungültige Werte).`,
  );
  if (result.invalid > 0) {
    console.log(
      "[history:import-csv] WARNUNG: der Store hat zusätzliche Zeilen abgelehnt (Validierungsregeln des Stores).",
    );
  }
  console.log(
    `[history:import-csv] Reihe ${instrumentId} ${timeframe}: ${stored.length} Kerzen in ${store.filePath}`,
  );
  return 0;
}

// Direktstart (`npm run history:import-csv`), nicht beim Test-Import.
const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("import-history-csv.ts");
if (invokedAsScript) {
  process.exit(runCli());
}

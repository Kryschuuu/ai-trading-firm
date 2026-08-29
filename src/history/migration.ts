/**
 * Historien-Migration v1 → v2 (Timeframe-Dimension).
 *
 * Kernlogik, frei von CLI/Prozess-Code, damit sie aus
 * `scripts/migrate-history-timeframe.ts` UND den Migrationstests
 * (`tests/history/migration.test.ts`) genutzt werden kann.
 *
 * Ablauf:
 *   1. Backup `candles.ndjson.bak-<ISO>` anlegen (Abbruch bei Fehlschlag).
 *   2. Jede Zeile parsen; fehlt `timeframe`, wird `assumeTimeframe` gesetzt
 *      (ohne dieses Flag: Abbruch mit Erklärung — kein Raten).
 *   3. Dedup nach `instrumentId + timeframe + ts` (jüngstes `fetchedAt`
 *      gewinnt; Gleichstand → zuletzt gelesen).
 *   4. Sortierung `instrumentId, timeframe, ts`.
 *   5. Report: gelesen / migriert / dedupliziert / verworfen (mit Gründen).
 *
 * Idempotenz: ein zweiter Lauf ändert nichts (alle Zeilen haben bereits ein
 * gültiges `timeframe`, keine Duplikate mehr).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HISTORY_SCHEMA_VERSION,
  isSupportedTimeframe,
  LEGACY_UNKNOWN,
  parseCandleLine,
  SUPPORTED_TIMEFRAMES,
  type HistoricalCandleEntry,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";

/** Eine verworfene Zeile mit Grund (Reporting). */
export interface RejectedRow {
  line: number;
  reason: string;
  snippet: string;
}

/** Ergebnisbericht einer Migration. */
export interface MigrationReport {
  file: string;
  read: number;
  /** Zeilen, die ein (neues) timeframe-Feld erhielten. */
  migrated: number;
  /** Bereits im v2-Schema (mit gültigem timeframe). */
  alreadyVersioned: number;
  /** Als Duplikat entfernte Zeilen. */
  deduplicated: number;
  /** Unbrauchbare Zeilen (kaputt/unguültig) inkl. Gründen. */
  rejected: RejectedRow[];
  /** Geschriebene Zeilen (nach Migration + Dedup + Sortierung). */
  written: number;
  /** Pfad des angelegten Backups (oder null bei dry-run/keiner Datei). */
  backupPath: string | null;
  dryRun: boolean;
}

export interface MigrateOptions {
  /** Pfad zur NDJSON-Datei. */
  file: string;
  /**
   * Timeframe, der Legacy-Zeilen (ohne `timeframe`) zugewiesen wird.
   * PFLICHT, sobald die Datei Legacy-Zeilen enthält — es wird nie geraten.
   */
  assumeTimeframe?: SupportedTimeframe;
  /** Nur lesen + Report schreiben, Datei/Backup nicht anfassen. */
  dryRun?: boolean;
}

/** Vergleich für die deterministische Ziel-Sortierung. */
function compareEntries(a: HistoricalCandleEntry, b: HistoricalCandleEntry): number {
  if (a.instrumentId !== b.instrumentId) return a.instrumentId < b.instrumentId ? -1 : 1;
  if (a.timeframe !== b.timeframe) return a.timeframe < b.timeframe ? -1 : 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0;
}

/** Serialisert eine Zeile im v2-Format (JSON.stringify, kein String-Concat). */
export function serializeEntry(e: HistoricalCandleEntry): string {
  return JSON.stringify({ v: HISTORY_SCHEMA_VERSION, ...e });
}

/**
 * Migriert eine Historien-Datei. Bei `dryRun` wird nichts geschrieben und
 * kein Backup angelegt. Wirft bei fehlendem `--assume-timeframe` (obwohl
 * Legacy-Zeilen existieren) oder fehlgeschlagenem Backup.
 */
export function migrateHistoryFile(opts: MigrateOptions): MigrationReport {
  const file = path.resolve(opts.file);
  const report: MigrationReport = {
    file,
    read: 0,
    migrated: 0,
    alreadyVersioned: 0,
    deduplicated: 0,
    rejected: [],
    written: 0,
    backupPath: null,
    dryRun: opts.dryRun === true,
  };

  if (!existsSync(file)) {
    // Keine Datei → nichts zu tun (kein Fehler, leerer Report).
    return report;
  }

  if (opts.assumeTimeframe !== undefined && !isSupportedTimeframe(opts.assumeTimeframe)) {
    throw new Error(
      `--assume-timeframe "${String(opts.assumeTimeframe)}" ist ungültig. Erlaubt: ${SUPPORTED_TIMEFRAMES.join(", ")}.`,
    );
  }

  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");

  // Phase 1: parsen + Legacy mit assumeTimeframe belegen.
  const entries: HistoricalCandleEntry[] = [];
  const keyIndex = new Map<string, number>();
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    report.read += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      report.rejected.push({ line: lineNo, reason: "ungültiges JSON", snippet: t.slice(0, 120) });
      continue;
    }

    const result = parseCandleLine(parsed);
    if (!result) {
      report.rejected.push({ line: lineNo, reason: "Pflichtfelder fehlerhaft/fehlend", snippet: t.slice(0, 120) });
      continue;
    }

    let entry: HistoricalCandleEntry;
    if (result.legacy) {
      if (!opts.assumeTimeframe) {
        throw new Error(
          `Die Datei enthält Zeilen im Legacy-Schema (ohne timeframe), aber --assume-timeframe fehlt. ` +
            `Die Migration rät keinen Timeframe (5m vs 1h wäre ununterscheidbar und würde jede Faktorreihe ` +
            `verfälschen). Bitte explizit angeben, z.B.: --assume-timeframe=15m. ` +
            `Erlaubte Werte: ${SUPPORTED_TIMEFRAMES.join(", ")}.`,
        );
      }
      const { timeframe: _ignored, ...rest } = result.entry;
      entry = { ...rest, timeframe: opts.assumeTimeframe };
      report.migrated += 1;
    } else {
      entry = result.entry;
      report.alreadyVersioned += 1;
    }

    // Phase 3: Dedup instrumentId+timeframe+ts, jüngstes fetchedAt gewinnt,
    // Gleichstand → zuletzt gelesen.
    const key = `${entry.instrumentId}\u0000${entry.timeframe}\u0000${entry.ts}`;
    const existingIdx = keyIndex.get(key);
    if (existingIdx === undefined) {
      keyIndex.set(key, entries.length);
      entries.push(entry);
    } else {
      const existing = entries[existingIdx];
      if (entry.fetchedAt >= existing.fetchedAt) {
        entries[existingIdx] = entry;
      }
      report.deduplicated += 1;
    }
  }

  // Phase 4: Sortierung instrumentId, timeframe, ts.
  entries.sort(compareEntries);
  report.written = entries.length;

  // Invariante: kein Bar geht verloren (gelesen = geschrieben + dedupliziert + verworfen).
  const accounted = report.written + report.deduplicated + report.rejected.length;
  if (accounted !== report.read) {
    throw new Error(`Interne Migrations-Invariante verletzt: gelesen ${report.read} ≠ geschrieben ${report.written} + dedupliziert ${report.deduplicated} + verworfen ${report.rejected.length}`);
  }

  if (report.dryRun) {
    return report;
  }

  // Phase 1 (eigentlich zuerst): Backup anlegen, restriktive Rechte (0600).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${file}.bak-${stamp}`;
  try {
    writeFileSync(backupPath, raw, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    throw new Error(
      `Backup konnte nicht geschrieben werden (${backupPath}) — Migration abgebrochen, Original unverändert: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  report.backupPath = backupPath;

  // Phase 5: Zieldatei atomar schreiben (tmp + rename), 0600.
  const body = entries.map(serializeEntry).join("\n") + (entries.length ? "\n" : "");
  const tmp = `${file}.migrate-tmp-${process.pid}`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);

  return report;
}

/** Formatiert einen Migrations-Report als menschenlesbare CLI-Zeilen. */
export function formatMigrationReport(r: MigrationReport): string[] {
  const lines = [
    `[history:migrate] Datei:        ${r.file}`,
    `[history:migrate] gelesen:      ${r.read}`,
    `[history:migrate] migriert:     ${r.migrated} (timeframe zugewiesen)`,
    `[history:migrate] bereits v2:   ${r.alreadyVersioned}`,
    `[history:migrate] dedupliziert: ${r.deduplicated}`,
    `[history:migrate] verworfen:    ${r.rejected.length}`,
    `[history:migrate] geschrieben:  ${r.written}`,
  ];
  if (r.dryRun) lines.push("[history:migrate] DRY-RUN — keine Datei verändert, kein Backup angelegt.");
  else lines.push(`[history:migrate] Backup:       ${r.backupPath ?? "(keines)"}`);
  for (const rej of r.rejected.slice(0, 20)) {
    lines.push(`[history:migrate]   verworfen Zeile ${rej.line}: ${rej.reason} · ${rej.snippet}`);
  }
  if (r.rejected.length > 20) {
    lines.push(`[history:migrate]   … ${r.rejected.length - 20} weitere verworfene Zeilen`);
  }
  return lines;
}

/** Marker wird auch für externe Tests/Checks exportiert. */
export { LEGACY_UNKNOWN };

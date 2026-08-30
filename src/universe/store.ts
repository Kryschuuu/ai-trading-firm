/**
 * Persistenz der Instrument-Registry als **versionierbare NDJSON-Datei**.
 *
 * Warum NDJSON und nicht PostgreSQL?
 *   - Das Universum ist Konfigurationswissen, kein Transaktionszustand: es soll
 *     im Git-Diff sichtbar und reviewbar sein.
 *   - Die Registry muss ohne laufende Datenbank funktionieren (Tests, CI,
 *     Kaltstart, Discovery-Läufe vor dem Schema-Push).
 *   - Zeilenweises Format ⇒ ein Instrument pro Zeile, stabil nach `id` sortiert
 *     ⇒ minimale, lesbare Diffs.
 *
 * Schreibvorgänge sind atomar (`tmp` + `rename`), damit ein Absturz mitten im
 * Schreiben keine halbe Datei hinterlässt.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { validateInstrument } from "./validation";
import { INSTRUMENT_FIELDS, type MarketInstrument } from "./types";

/** Standard-Verzeichnis relativ zum Projektstamm. */
export const DEFAULT_DATA_DIR = "data/universe";
/** Dateiname der Instrumentendatei. */
export const INSTRUMENTS_FILE = "instruments.ndjson";
/** Dateiname des Audit-Logs (Fallback-Senke ohne Datenbank). */
export const AUDIT_FILE = "audit-log.ndjson";

/** Ergebnis eines Ladevorgangs inklusive Diagnose beschädigter Zeilen. */
export interface LoadResult {
  /** Erfolgreich geladene, validierte Instrumente. */
  instruments: MarketInstrument[];
  /** Anzahl übersprungener (kaputter/ungültiger) Zeilen. */
  skipped: number;
  /** true, wenn die Datei existierte. */
  existed: boolean;
}

/** Löst das Datenverzeichnis auf (`UNIVERSE_DATA_DIR` überschreibt den Default). */
export function resolveDataDir(dir?: string): string {
  const raw = dir ?? process.env.UNIVERSE_DATA_DIR ?? DEFAULT_DATA_DIR;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

/** Serialisiert ein Instrument mit stabiler Feldreihenfolge (deterministische Diffs). */
export const PERSISTED_INSTRUMENT_FIELDS: readonly (keyof MarketInstrument)[] = INSTRUMENT_FIELDS.filter(
  (field) => field !== "liveTradable" && field !== "liveAvailable",
);

export function serializeInstrument(instrument: MarketInstrument): string {
  const ordered: Record<string, unknown> = {};
  for (const field of PERSISTED_INSTRUMENT_FIELDS) ordered[field] = instrument[field];
  return JSON.stringify(ordered);
}

/** Dateibasierte NDJSON-Persistenz. */
export class NdjsonStore {
  /** Verzeichnis, in dem Instrumente und Audit-Log liegen. */
  readonly dir: string;
  /** Vollständiger Pfad der Instrumentendatei. */
  readonly instrumentsPath: string;
  /** Vollständiger Pfad des Audit-Logs. */
  readonly auditPath: string;

  constructor(dir?: string) {
    this.dir = resolveDataDir(dir);
    this.instrumentsPath = path.join(this.dir, INSTRUMENTS_FILE);
    this.auditPath = path.join(this.dir, AUDIT_FILE);
  }

  /** Lädt und validiert alle Instrumente. Kaputte Zeilen werden gezählt, nicht geworfen. */
  load(): LoadResult {
    if (!existsSync(this.instrumentsPath)) {
      return { instruments: [], skipped: 0, existed: false };
    }
    const text = readFileSync(this.instrumentsPath, "utf8");
    const instruments: MarketInstrument[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        instruments.push(validateInstrument(JSON.parse(trimmed)));
      } catch {
        skipped += 1;
      }
    }
    return { instruments, skipped, existed: true };
  }

  /** Schreibt alle Instrumente atomar, sortiert nach `id`. */
  save(instruments: MarketInstrument[]): void {
    mkdirSync(this.dir, { recursive: true });
    const sorted = [...instruments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = sorted.map(serializeInstrument).join("\n");
    const tmp = `${this.instrumentsPath}.tmp`;
    writeFileSync(tmp, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, this.instrumentsPath);
  }

  /** Hängt einen Audit-Eintrag an (append-only, eine JSON-Zeile). */
  appendAudit(entry: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /** Liest das Audit-Log (nur Tests/Diagnose; im Betrieb liest das die DB-Senke). */
  readAudit(): unknown[] {
    if (!existsSync(this.auditPath)) return [];
    return readFileSync(this.auditPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
}

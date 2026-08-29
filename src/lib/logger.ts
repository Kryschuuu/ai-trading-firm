/**
 * Strukturierter Logger (JSON-Zeilen) mit Redaktion und Kürzung.
 *
 * Für das Marktdaten-Fehlerpfad (MDERR-006) ist ein **strukturiertes** Log
 * Pflicht: Events wie `market_data_fetch_failed` müssen venue/symbol/timeframe/
 * reason tragen, ohne Credentials, volle URLs oder mehrzeilige Fremdinhalte.
 *
 * Garantien:
 *  - Jedes String-Feld läuft durch `redactSecrets` (src/lib/secrets.ts).
 *  - Maximale Feldlänge 512 Zeichen (Log-Injection-/Flood-Schutz).
 *  - Steuerzeichen/Zeilenumbrüche werden ersetzt — keine mehrzeiligen
 *    Fremdinhalte, kein Terminal-Escape-Injection.
 *  - `cause`-Objekte werden nie ungefiltert geloggt (nur Name/Code via
 *    `MarketDataFetchError.toJSON()`).
 *  - Test-Sink injizierbar (`setStructuredLogSinkForTests`), damit Tests die
 *    Emission ohne Console-Mock prüfen können.
 */
import { redactSecrets } from "./secrets";

export type StructuredLogLevel = "debug" | "info" | "warn" | "error" | "critical";

export type StructuredLogEntry = {
  ts: string;
  level: StructuredLogLevel;
  event: string;
  fields: Record<string, unknown>;
};

export type StructuredLogSink = (entry: StructuredLogEntry) => void;

/** Maximale Länge eines einzelnen Log-Feldes (Security: Log-Flut/Injection). */
export const MAX_LOG_FIELD_LENGTH = 512;

/**
 * Redigiert und kürzt einen Fremdwert für Logs/Fehlermeldungen:
 * Secrets → `[REDACTED]`, Steuerzeichen/Zeilenumbrüche → Leerzeichen,
 * Länge auf `max` Zeichen begrenzt, einzeilig.
 */
export function sanitizeLogField(value: unknown, max = MAX_LOG_FIELD_LENGTH): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : JSON.stringify(value);
  const redacted = redactSecrets(String(raw ?? ""));
  const singleLine = redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function sanitizeField(value: unknown): unknown {
  if (typeof value === "string") return sanitizeLogField(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return value;
  // Objekte/Arrays laufen als JSON durch dieselbe Redaktion/Kürzung.
  return sanitizeLogField(value);
}

function defaultSink(entry: StructuredLogEntry): void {
  const line = JSON.stringify({
    ts: entry.ts,
    level: entry.level,
    event: entry.event,
    ...entry.fields,
  });
  if (entry.level === "error" || entry.level === "critical") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

let sink: StructuredLogSink = defaultSink;

/** Emittiert ein strukturiertes Log-Event (JSON-Zeile, redigiert, gekürzt). */
export function structuredLog(
  level: StructuredLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const cleanFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    cleanFields[key] = sanitizeField(value);
  }
  sink({
    ts: new Date().toISOString(),
    level,
    event,
    fields: cleanFields,
  });
}

/** Nur für Tests: Sink ersetzen (`null` = wieder Console). */
export function setStructuredLogSinkForTests(next: StructuredLogSink | null): void {
  sink = next ?? defaultSink;
}

/**
 * Audit-Senken mit I/O (Task 05) — **einzige** Datei des Moduls mit Dateizugriff.
 *
 * // vgl. task-01/06: Sobald die zentrale `audit_log`-Infrastruktur (Task 01/06)
 * // genutzt werden soll, ist `dbAuditSink()` der Integrationspunkt; die
 * // Datei-Senke folgt bewusst dem Muster aus `src/universe/audit.ts`
 * // (append-only NDJSON, kein Datenbank-Zwang).
 *
 * Die Kernbibliothek (`metrics.ts`, `correlation.ts`, `optimize.ts`,
 * `riskGuard.ts`, `pipeline.ts`, `context.ts`) bleibt damit I/O-frei — geprüft
 * durch `tests/portfolio.architecture.test.ts`.
 *
 * Es werden ausschließlich strukturierte Ereignisse geschrieben (Symbole,
 * Gewichte, Grenzen, Gründe). Niemals Roh-Requests, Header oder Credentials.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { joinRuntimePath, resolveRuntimePath } from "../lib/appPaths";
import { redactPortfolioMessage } from "./errors";
import type { AuditSink, PortfolioAuditEvent } from "./audit";

/** Standardverzeichnis relativ zum Projektstamm. */
export const DEFAULT_AUDIT_DIR = "data/portfolio";
/** Dateiname des Audit-Logs. */
export const AUDIT_FILE = "audit-log.ndjson";
/** Erlaubte Dateinamen (kein Path-Traversal). */
export const AUDIT_FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Stabile Feldreihenfolge der serialisierten Ereignisse (reproduzierbare Diffs). */
const EVENT_FIELDS = [
  "event",
  "level",
  "actor",
  "source",
  "timestamp",
  "stage",
  "action",
  "code",
  "mode",
  "symbols",
  "weights",
  "limit",
  "before",
  "after",
  "converged",
  "iterations",
  "reasons",
] as const;

/**
 * Serialisiert ein Audit-Ereignis mit fester Feldreihenfolge.
 * Nicht-endliche Zahlen werden zu `null` (JSON kennt kein `NaN`/`Infinity`).
 */
export function serializeAuditEvent(event: PortfolioAuditEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const field of EVENT_FIELDS) {
    const value = (event as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    ordered[field] = value;
  }
  return JSON.stringify(ordered, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? null : value
  );
}

/**
 * Löst das Audit-Verzeichnis auf (`PORTFOLIO_AUDIT_DIR` überschreibt den Default).
 *
 * `resolveRuntimePath()` (src/lib/appPaths.ts) behält die bisherige Semantik
 * (relativ ⇒ Projektstamm, absolut ⇒ übernommen) und ergänzt den
 * Path-Traversal-Schutz. Gleichzeitig verschwindet die Turbopack-Warnung
 * „Dynamic filesystem access causes tracing of the whole project".
 */
export function resolveAuditDir(dir?: string): string {
  const raw = dir ?? process.env.PORTFOLIO_AUDIT_DIR ?? DEFAULT_AUDIT_DIR;
  return resolveRuntimePath(raw);
}

/** Optionen der Datei-Senke. */
export interface FileAuditSinkOptions {
  /** Zielverzeichnis (Default `data/portfolio` bzw. `PORTFOLIO_AUDIT_DIR`). */
  dir?: string;
  /** Dateiname (Default `audit-log.ndjson`). */
  file?: string;
  /** true ⇒ Datei bei jedem Schreibvorgang neu anlegen (nur für Tests). */
  truncate?: boolean;
}

/**
 * Append-only NDJSON-Senke.
 *
 * Schreiben ist atomar pro Zeile (`appendFileSync`), das Verzeichnis wird
 * angelegt, die Dateirechte sind 0644. Fehler werden **nicht** verschluckt:
 * Sie landen als Warnung auf der Konsole, weil ein fehlendes Audit-Log
 * sichtbar sein muss.
 */
export function fileAuditSink(options: FileAuditSinkOptions = {}): AuditSink {
  const dir = resolveAuditDir(options.dir);
  const file = options.file ?? AUDIT_FILE;
  if (!AUDIT_FILE_RE.test(file)) {
    throw new Error(`audit file name invalid: ${redactPortfolioMessage(file, 40)}`);
  }
  // Über `joinRuntimePath()`: identisches Ergebnis wie `path.join(dir, file)`,
  // aber die Pfadherkunft endet an der Modulgrenze von `@/lib/appPaths` —
  // sonst meldet Turbopack hier weiterhin Projekt-Tracing.
  const target = joinRuntimePath(dir, file);
  let prepared = false;
  const prepare = () => {
    if (prepared) return;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    if (options.truncate) writeFileSync(target, "", { mode: 0o644 });
    prepared = true;
  };
  return {
    name: `file:${path.relative(process.cwd(), target) || target}`,
    write(event) {
      try {
        prepare();
        appendFileSync(target, `${serializeAuditEvent(event)}\n`, { mode: 0o644 });
      } catch (e) {
        console.warn("[portfolio] Audit-Schreiben fehlgeschlagen:", redactPortfolioMessage(e instanceof Error ? e.message : String(e)));
      }
    },
  };
}

/**
 * Schreibt ein Ereignis synchron in eine konkrete Datei (Test-/Skript-Helfer).
 * Verwendet `tmp` + `rename`, damit keine halbe Datei zurückbleibt.
 */
export function writeAuditSnapshot(targetPath: string, events: readonly PortfolioAuditEvent[]): void {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, events.map(serializeAuditEvent).join("\n") + (events.length ? "\n" : ""), { mode: 0o644 });
  renameSync(tmp, targetPath);
}

/**
 * Optionale Datenbank-Senke (`audit_log`, Event `PORTFOLIO_RISK_GUARD`).
 *
 * // vgl. task-01/06 — Integration in die zentrale Audit-Infrastruktur.
 * Der Import erfolgt dynamisch und nur bei `PORTFOLIO_AUDIT_DB=1`, damit das
 * Portfolio-Modul ohne `DATABASE_URL` importierbar und testbar bleibt.
 * Fehler brechen nichts ab (die Memory-/Datei-Senke bleibt Wahrheit).
 */
export function dbAuditSink(): AuditSink {
  return {
    name: "db:audit_log",
    async write(event) {
      if (process.env.PORTFOLIO_AUDIT_DB !== "1") return;
      try {
        const [{ db }, { auditLog }] = await Promise.all([import("../db"), import("../db/schema")]);
        await db.insert(auditLog).values({
          event: "PORTFOLIO_RISK_GUARD",
          level: event.level === "ERROR" ? "ERROR" : event.level === "WARN" ? "WARN" : "INFO",
          detail: JSON.parse(serializeAuditEvent(event)) as Record<string, unknown>,
        });
      } catch (e) {
        console.warn(
          "[portfolio] Audit-DB-Senke fehlgeschlagen:",
          redactPortfolioMessage(e instanceof Error ? e.message : String(e))
        );
      }
    },
  };
}

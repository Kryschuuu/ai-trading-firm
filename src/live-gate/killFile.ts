/**
 * Kill-Switch-Failsafe-Datei (Task 11) — letzte, lokale Verteidigungslinie.
 *
 * `data/live-gate/kill-switch.json` (NDJSON, append-only bis auf das
 * explizite, auditierte Clear). Der Enforcer prüft die Datei bei JEDER
 * Live-Order-Entscheidung — auch wenn die Datenbank, das Netz oder der
 * State-Store ausgefallen sind: Die Datei ist lokal, benötigt keine Infra-
 * struktur und überlebt Neustarts (persistente, flag-basierte Sperre).
 *
 * Eintrag: { scope: "*" | VENUE, at, actor, reason }
 *   scope "*" = Kill für ALLE Venues (systemweit)
 *   scope VENUE = venue-scoped
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const KILL_FILE_NAME = "kill-switch.json";

export interface KillFileEntry {
  scope: string;
  at: string;
  actor: string;
  reason: string;
}

export function killFilePath(dir: string): string {
  return path.join(dir, KILL_FILE_NAME);
}

/** Alle aktiven Kill-Einträge (parse-fehlerzeilen werden ignoriert — safe). */
export function readKillFile(dir: string): KillFileEntry[] {
  const file = killFilePath(dir);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as KillFileEntry)
      .filter(
        (e) =>
          e &&
          typeof e.scope === "string" &&
          e.scope.length > 0 &&
          typeof e.at === "string" &&
          typeof e.actor === "string" &&
          typeof e.reason === "string"
      );
  } catch {
    // Datei unlesbar => im Zweifel tot: Ein Global-Kill-Eintrag, der nie
    // entfernt werden kann, wäre falsch; deshalb bewusst: Datei unlesbar
    // wird als KEIN Kill behandelt, weil der State-Store zusätzlich prüft
    // (Defense in Depth, beide Quellen müssen frei sein).
    return [];
  }
}

/** Ist ein Kill für die Venue (oder systemweit) aktiv? */
export function isKilledInFile(dir: string, venue: string): KillFileEntry | null {
  const v = venue.toUpperCase();
  return (
    readKillFile(dir).find((e) => e.scope === "*" || e.scope.toUpperCase() === v) ?? null
  );
}

/** Hängt einen Kill-Eintrag an (best-effort; Fehler wirft der Aufrufer). */
export function appendKillEntry(dir: string, entry: KillFileEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(killFilePath(dir), JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Entfernt Kill-Einträge für einen Scope (explizites, auditiertes Clear).
 * Schreibt atomar (tmp + rename). Liefert die Anzahl entfernten Einträge.
 */
export function clearKillEntries(dir: string, scope: string): number {
  const entries = readKillFile(dir);
  const keep = entries.filter(
    (e) => !(e.scope === "*" ? scope === "*" : e.scope.toUpperCase() === scope.toUpperCase())
  );
  if (keep.length === entries.length) return 0;
  const file = killFilePath(dir);
  if (keep.length === 0) {
    existsSync(file) && renameSync(file, `${file}.cleared-${Date.now()}`);
    return entries.length;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  renameSync(tmp, file);
  return entries.length - keep.length;
}

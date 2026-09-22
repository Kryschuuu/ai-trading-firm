/**
 * Prompt-Kanonisierung & Hash (RMA-P3-02, v1.65.0)
 *
 * ── Ziel ─────────────────────────────────────────────────────────────────
 * Jeder Agentenaufruf muss unveränderlich an den Prompt-Kontext gebunden
 * sein (Prompt-Version + Modell + Sampling). Historische Zeilen bleiben
 * unverändert zuordenbar, auch nach späteren Prompt-Änderungen (append-only).
 *
 * ── Kanonisierung ─────────────────────────────────────────────────────────
 * * Zeilenenden werden deterministisch normalisiert (`\r\n` und `\r` → `\n`);
 *   ein Prompt mit Windows-Zeilenenden hasht identisch zu seinem LF-Gegenstück
 *   (Pflicht-Test: stabil trotz normalisierter Zeilenenden).
 * * Außer Zeilenenden wird NICHTS verändert — keine Trimms, keine Leerzeichen-
 *   Faltung: eine inhaltliche Änderung muss den Hash ändern.
 *
 * ── Hash ──────────────────────────────────────────────────────────────────
 * `pp1:<sha256>` über den kanonischen UTF-8-Text (Präfix = Schema-Version
 * der Hashbildung, analog `fc1`/`fd1` der Feature-Store). Der Hash ist
 * stabil über Plattformen und Einfügereihenfolge der Quelle (reine Text-
 * Funktion, keine Objekt-Schlüssel-Sortierung nötig).
 *
 * ── Template-Schema-Version ───────────────────────────────────────────────
 * `prompt-template@1` (konstant, dokumentiert Upgrades des Prompt-Aufbaus;
 * eine Änderung der Prompt-Zusammensetzung erfordert eine neue Version und
 * damit neue Artefakte).
 */

import { createHash } from "node:crypto";

/** Template-Schema-Version der Prompt-Artefakte. */
export const PROMPT_TEMPLATE_SCHEMA_VERSION = "1";

/** Hash-Präfix (Version der Hashbildung). */
export const PROMPT_HASH_PREFIX = "pp1";

/**
 * Kanonisiert einen Prompttext deterministisch (nur Zeilenenden).
 *
 * Beispiele (Pflicht-Tests):
 *   canonicalize("a\\r\\nb") === canonicalize("a\\nb") === "a\\nb"
 *   canonicalize("a\\rb") === "a\\nb"
 *   unterschiedliche Inhalte → anderer kanonischer Text → anderer Hash
 */
export function canonicalizePrompt(prompt: string): string {
  if (typeof prompt !== "string") return "";
  // \r\n zuerst, dann verbliebene \r — Reihenfolge ist wesentlich (sonst bleibt \r).
  return prompt.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * SHA-256 einer UTF-8-Zeichenkette als Hex.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministischer Prompt-Hash `pp1:<sha256>` über den kanonischen Text.
 */
export function promptHash(canonicalText: string): string {
  return `${PROMPT_HASH_PREFIX}:${sha256Hex(canonicalText)}`;
}

/**
 * Kanonisiert und hasht in einem Schritt.
 */
export function canonicalPromptHash(rawPrompt: string): string {
  return promptHash(canonicalizePrompt(rawPrompt));
}

/**
 * Kurzes, bounded Versionslabel für Metriken/Logs (kein Prompt, keine Request-ID).
 * Format: `v<version>#<kurzhash>` (8 Hex-Zeichen, ausreichend zur Unterscheidung).
 */
export function promptVersionLabel(version: number, hash: string): string {
  const short = typeof hash === "string" && hash.includes(":") ? hash.split(":")[1]?.slice(0, 8) ?? "unknown" : "unknown";
  return `v${Math.max(0, Math.trunc(version))}#${short}`;
}

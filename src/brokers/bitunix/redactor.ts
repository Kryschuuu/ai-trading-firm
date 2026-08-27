/**
 * Zentraler Redactor für ALLE Log-/Error-Ausgaben des Bitunix-Adapters.
 *
 * Maskiert Secret-Muster und injizierte Klartext-Secrets (API-Key/Secret,
 * Signatur-Header). Niemals Klartext in Logs, Stacktraces oder Meldungen.
 */
import { redactSecrets } from "../../lib/secrets";

const HEADER_PATTERNS: RegExp[] = [
  /(?:api-key|api[_-]?secret|secret[_-]?key|sign|x-api-key)["']?\s*[:=]\s*["']?[^\s"'&,}]+/gi,
  /(?:BITUNIX_API_KEY|BITUNIX_API_SECRET)\s*=\s*\S+/gi,
];

/** Lange Hex-Tokens (Keys/Signaturen) — nie unmaskiert loggen. */
const HEX_TOKEN = /\b[a-f0-9]{32,}\b/gi;

/**
 * Redigiert `text`. `secrets` sind bekannte Klartext-Werte (Key/Secret),
 * die unabhängig vom Muster ersetzt werden.
 */
export function redactBitunix(text: string, secrets: readonly string[] = []): string {
  if (!text) return text;
  let out = redactSecrets(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  for (const re of HEADER_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  out = out.replace(HEX_TOKEN, "[REDACTED]");
  return out;
}

/** Logger, der jede Ausgabe durch den Redactor schickt. */
export interface BitunixLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Erzeugt einen Logger. `secrets` wird bei jedem Call gelesen, damit
 * nachgeladene Keys ebenfalls maskiert werden.
 */
export function createBitunixLogger(secrets: () => readonly string[] = () => []): BitunixLogger {
  const emit = (fn: (s: string) => void, prefix: string, message: string) => {
    try {
      fn(`${prefix}${redactBitunix(message, secrets())}`);
    } catch {
      fn(`${prefix}[REDACTED]`);
    }
  };
  return {
    info: (m) => emit(console.info, "[bitunix] ", m),
    warn: (m) => emit(console.warn, "[bitunix] ", m),
    error: (m) => emit(console.error, "[bitunix] ", m),
  };
}

/** Redigiert eine Exception-Message (kein Stack mit Secrets). */
export function safeErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unbekannter Fehler";
  const clean = redactBitunix(raw, secrets).replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}…` : clean || "Bitunix-Fehler";
}

/**
 * Zentraler Redactor für ALLE Log-/Error-Ausgaben des Alpaca-Adapters.
 *
 * Maskiert Secret-Muster und injizierte Klartext-Secrets (API-Key/Secret).
 * Niemals Klartext in Logs, Stacktraces oder Meldungen.
 */
import { redactSecrets } from "../../lib/secrets";

const HEADER_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|APCA-API-KEY-ID|APCA-API-SECRET-KEY)["']?\s*[:=]\s*["']?[^\s"'&,}]+/gi,
  /(?:ALPACA_API_KEY|ALPACA_API_SECRET)\s*=\s*\S+/gi,
  // Basic-Auth-Header: Base64-kodiert "key:secret" — nie loggen.
  /(?:Authorization:\s*Basic\s+)[A-Za-z0-9._\-+=/]+/gi,
];

/** Lange Hex/Alphanum-Tokens (Keys/Secrets) — nie unmaskiert loggen. */
const HEX_TOKEN = /\b[a-f0-9]{32,}\b/gi;

/**
 * Redigiert `text`. `secrets` sind bekannte Klartext-Werte (Key/Secret),
 * die unabhängig vom Muster ersetzt werden.
 */
export function redactAlpaca(text: string, secrets: readonly string[] = []): string {
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
export interface AlpacaLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Erzeugt einen Logger. `secrets` wird bei jedem Call gelesen, damit
 * nachgeladene Keys ebenfalls maskiert werden.
 */
export function createAlpacaLogger(secrets: () => readonly string[] = () => []): AlpacaLogger {
  const emit = (fn: (s: string) => void, prefix: string, message: string) => {
    try {
      fn(`${prefix}${redactAlpaca(message, secrets())}`);
    } catch {
      fn(`${prefix}[REDACTED]`);
    }
  };
  return {
    info: (m) => emit(console.info, "[alpaca] ", m),
    warn: (m) => emit(console.warn, "[alpaca] ", m),
    error: (m) => emit(console.error, "[alpaca] ", m),
  };
}

/** Redigiert eine Exception-Message (kein Stack mit Secrets). */
export function safeAlpacaErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unbekannter Fehler";
  const clean = redactAlpaca(raw, secrets).replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}…` : clean || "Alpaca-Fehler";
}

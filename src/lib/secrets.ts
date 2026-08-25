/**
 * Redaktion von Geheimnissen in Logs, Health-Antworten und Fehlermeldungen.
 *
 * Niemals API-Keys, Bearer-Tokens oder Connection-Strings an Clients oder
 * ins Journal durchreichen — auch nicht in „harmlosen“ Error.message-Feldern
 * (pg inkludiert z. B. gelegentlich die Connection-URI).
 */

const PATTERNS: RegExp[] = [
  /postgresql:\/\/\S+/gi,
  /postgres:\/\/\S+/gi,
  /Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /(?:sk-ant-|sk-|AIza)[A-Za-z0-9_\-]{8,}/g,
  /(?:api[_-]?key|x-api-key|x-goog-api-key|x-firm-token)["']?\s*[:=]\s*["']?[^\s"'&]+/gi,
  /[?&]key=[^&\s]+/gi,
];

/** Ersetzt bekannte Geheimnis-Muster durch `[REDACTED]`. Idempotent. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Sichere, gekürzte Fehlermeldung für HTTP-Antworten. */
export function publicErrorMessage(err: unknown, fallback = "Interner Fehler"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  const clean = redactSecrets(raw).replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 240 ? `${clean.slice(0, 237)}…` : clean;
}

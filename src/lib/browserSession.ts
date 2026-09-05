/**
 * Browser-Session-Helfer (W1, v1.36.23).
 *
 * - `sessionCsrf()` liest den nicht-HttpOnly Cookie `firm_csrf` (Double-Submit:
 *   Browser-JS echoet ihn in `x-csrf-token`, der Server vergleicht mit dem
 *   session-gebundenen Wert aus dem HttpOnly `firm_session`-Cookie).
 * - `clearLegacyFirmToken()` entfernt einen alten `firmToken`-Eintrag aus
 *   localStorage (Migration von Installationen vor v1.36.23). Es wird NIE ein
 *   Token geschrieben — nur aufgeräumt.
 *
 * Der HttpOnly Session-Cookie ist fuer JS unsichtbar; der rohe API-Token liegt
 * nach der Umstellung nirgendwo mehr im Browser (kein localStorage).
 */
export const SESSION_CSRF_COOKIE = "firm_csrf";

/** Offen-Betrieb-Konstante (Server-Pendant in src/brokers/control-plane/config.ts). */
export const CSRF_LOCAL_VALUE = "local";

/** Legacy-Schlüssel aus Zeiten vor W1 — wird beim Login/Start entfernt. */
export const LEGACY_TOKEN_KEY = "firmToken";

function readCookie(name: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "";
  for (const part of document.cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

/** CSRF-Wert aus dem Double-Submit-Cookie (leer wenn keine Session). */
export function sessionCsrf(): string {
  return readCookie(SESSION_CSRF_COOKIE);
}

/**
 * Header-Wert fuer mutierende Requests: Session-CSRF, sonst Offen-Konstante —
 * damit funktioniert der lokale Offen-Betrieb ohne Session unveraendert.
 */
export function csrfHeaderValue(): string {
  return sessionCsrf() || CSRF_LOCAL_VALUE;
}

/**
 * Migration: altes `firmToken`-Secret aus localStorage entfernen, wenn es noch
 * aus einer Pre-W1-Installation stammt. Harmlos, wenn kein Eintrag existiert.
 */
export function clearLegacyFirmToken(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    if (localStorage.getItem(LEGACY_TOKEN_KEY)) {
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    // localStorage gesperrt — ignorieren (Themen- und Bootstrap-Code ebenso).
  }
}
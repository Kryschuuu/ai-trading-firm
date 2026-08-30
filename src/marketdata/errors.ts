/**
 * Errors of the market-data sync layer (MDSYNC-001).
 *
 * Messages are leak-free: venue strings are truncated, no URLs, no secrets,
 * no query strings. Every error that can escape the sync must be safe to log
 * verbatim — the CLI prints `error.message` directly.
 */

import { isValidStorageSymbol } from "../symbols/normalize";
import type { SyncFailure } from "./types";

/** Thrown when `syncVenue()` is called for a venue without a registered adapter. */
export class UnsupportedVenueError extends Error {
  readonly code = "UNSUPPORTED_VENUE";
  readonly venue: string;

  constructor(venue: string) {
    const safe = sanitizeVenue(venue);
    super(`Unsupported venue: "${safe}". No MarketDataAdapter is registered.`);
    this.name = "UnsupportedVenueError";
    this.venue = safe;
  }
}

/**
 * Thrown when `candleLimit` is smaller than the derived warmup requirement.
 *
 * WARUM das ein Abbruch und keine Warnung ist: ein zu kleines Limit liefert
 * Kerzen, aber keine vollständigen Faktorreihen. Der Scanner lehnt danach alle
 * Instrumente mit `min-candles` ab — ein Symptom, das exakt aussieht wie „der
 * Markt ist leer“. Der Fehler nennt deshalb die Herleitung und den Behebungs-
 * schritt, statt einen leeren Trichter zu hinterlassen.
 */
export class InsufficientCandleLimitError extends Error {
  readonly code = "CANDLE_LIMIT_TOO_SMALL";
  readonly candleLimit: number;
  readonly required: number;

  constructor(candleLimit: number, required: number, detail?: { momentumLookback?: number }) {
    const momentum = detail?.momentumLookback;
    super(
      `candleLimit=${candleLimit} ist zu klein: der konfigurierte Faktorsatz benötigt mindestens ` +
        `${required} Kerzen (Momentum-Lookback${momentum !== undefined ? ` ${momentum}` : ""}${
          momentum !== undefined ? " + 1" : ""
        }). Der Scanner würde alle Instrumente mit min-candles ablehnen.` +
        ` Behebung: --candle-limit=${required} (oder größer) setzen.`
    );
    this.name = "InsufficientCandleLimitError";
    this.candleLimit = candleLimit;
    this.required = required;
  }
}

/**
 * Thrown at the end of a `continueOnError: false` run that recorded failures.
 *
 * Der Zweck ist der Exit-Code eines Betriebslaufs: „teilweise befüllt“ ist für
 * ein automatisches Scan-Ziel kein Erfolg. Die bereits persistierten Daten
 * bleiben erhalten (Append-only + Dedup), nur der Abbruch wird signalisiert.
 */
export class SyncPartialFailureError extends Error {
  readonly code = "SYNC_PARTIAL_FAILURE";
  readonly venue: string;
  readonly failureCount: number;
  /** Die ersten 10 Fehler (gekürzt, sanitisiert) — für CLI-Ausgaben. */
  readonly failures: SyncFailure[];

  constructor(venue: string, failures: readonly SyncFailure[], maxAttached = 10) {
    const safeVenue = sanitizeVenue(venue);
    super(
      `[market-sync] ${safeVenue}: sync aborted after ${failures.length} failure(s) ` +
        `(continueOnError=false). ` +
        `First: ${failures[0]?.stage ?? "unknown"}${failures[0]?.reason ? `/${failures[0].reason}` : ""}.`
    );
    this.name = "SyncPartialFailureError";
    this.venue = safeVenue;
    this.failureCount = failures.length;
    this.failures = failures.slice(0, maxAttached).map((f) => ({ ...f }));
  }
}

/** Truncate and strip control characters from a venue id used in errors/logs. */
export function sanitizeVenue(venue: unknown): string {
  const raw = typeof venue === "string" ? venue : String(venue ?? "");
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
}

/**
 * Allowlist-Prüfung eines venue-nativen Symbols, bevor es in einen Request
 * oder eine Instrumenten-ID wandert (SSRF-/Path-Injection-Grenze).
 *
 * Erlaubt ist ausschließlich das Registry-Speichermuster (`[A-Z0-9]` plus
 * `/.-=_` in begrenzter Anzahl, max. 32 Zeichen, lineare Regex ⇒ ReDoS-sicher).
 * Alles andere — Query-Separator, `#`, Leerzeichen, Steuerzeichen, Pfadsegmente
 * mit `..`, UTF-8-Müll — wird abgelehnt, bevor eine URL daraus gebaut wird.
 */
export function isSyncableSymbol(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  // `isValidStorageSymbol` verlangt Großbuchstaben; die venue-native
  // Schreibweise ist das bereits (Bitunix z. B. "BTCUSDT"). Kleinschreibung
  // wird vor der Prüfung gehoben, damit ein Adapter nicht an der
  // Groß-/Kleinschreibung scheitert — gesendet wird ausschließlich der
  // geprüfte, gehobene Wert (siehe `normalizeSyncSymbol`).
  return isValidStorageSymbol(raw.trim().toUpperCase());
}

/**
 * Eindeutige Normalisierung dessen, was in einen Venue-Request geht: trimmen +
 * Großbuchstaben. Wird NUR auf symbole angewendet, die {@link isSyncableSymbol}
 * bestanden haben — die Reihenfolge (Prüfen vor Senden) ist der Punkt.
 */
export function normalizeSyncSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return isSyncableSymbol(value) ? value : null;
}

/** Redact URLs and cap length so adapter errors cannot leak credentials. */
export function sanitizeSyncErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/(api[_-]?key|secret|token|sign(ature)?)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 160);
}

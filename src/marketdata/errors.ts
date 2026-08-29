/**
 * Errors of the market-data sync layer.
 *
 * Messages are leak-free: venue strings are truncated, no URLs, no secrets.
 */

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

/** Truncate and strip control characters from a venue id used in errors/logs. */
export function sanitizeVenue(venue: unknown): string {
  const raw = typeof venue === "string" ? venue : String(venue ?? "");
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
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

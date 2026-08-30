/**
 * Fehler- und Warn-Typen der zentralen Symbol-Normalisierung (SYM-007).
 *
 * Drei Strengegrade, bewusst getrennt:
 *  - `SymbolNormalizationError` — die Eingabe ist verworfen (nie raten). Im Abfragepfad liefert
 *    `tryNormalizeVenueSymbol()` einen Grund statt zu werfen; `normalizeVenueSymbol()`
 *    wirft diesen typisierten Fehler.
 *  - `UnknownVenueProfileWarning` — keine Exception, sondern ein strukturiertes
 *    Log-Ereignis im Abfragepfad (unbekannte Venue → striktes Default-Profil, sichtbar gemacht.
 *  - `UnknownVenueProfileError` — die Registrierungs-/Sync-Pfad-Variante: wirft, damit
 *    Discovery/Sync keine Instrumente für falsch geschriebene Venues still
 *    anders behandelt, als der Bediener denkt.
 */

/** Maschinenlesbarer Grund, warum eine Normalisierung fehlschlug. */
export type SymbolRejectReason =
  | "EMPTY_INPUT"
  | "VENUE_INVALID"
  | "VENUE_PREFIX_MISMATCH"
  | "TOO_LONG"
  | "INVALID_CHARACTERS"
  | "MALFORMED_SYMBOL"
  | "REDUNDANT_SEPARATOR"
  | "MALFORMED_FX_SUFFIX"
  | "NON_STRING_INPUT";

/** Rote Linie: jedes abgelehnte Symbol trägt einen dieser Gründe. */
export const SYMBOL_REJECT_REASONS: readonly SymbolRejectReason[] = [
  "EMPTY_INPUT",
  "VENUE_INVALID",
  "VENUE_PREFIX_MISMATCH",
  "TOO_LONG",
  "INVALID_CHARACTERS",
  "MALFORMED_SYMBOL",
  "REDUNDANT_SEPARATOR",
  "MALFORMED_FX_SUFFIX",
  "NON_STRING_INPUT",
];

/**
 * Typisierter Fehler der Normalisierung. Enthält nie die Roheingabe im
 * Klartext — nur gekürzte, redigierte Referenzen (Log-/Injection-Schutz, analog
 * zum Universe-`safeRef`).
 */
export class SymbolNormalizationError extends Error {
  readonly code = "SYMBOL_NORMALIZATION";
  readonly venue: string | null;
  readonly reason: SymbolRejectReason;

  constructor(reason: SymbolRejectReason, message: string, venue: string | null = null) {
    super(message);
    this.name = "SymbolNormalizationError";
    this.reason = reason;
    this.venue = venue;
  }
}

/**
 * Kein Fehler, sondern ein Ereignis: das Abfragepfad-Profil für eine unbekannte Venue ist das STRIKTE
 * Default-Profil, nicht das Venue-Profil — der Aufrufer soll das sehen.
 *
 * Wird ausschließlich in strukturierten Logs/Warnlisten transportiert, niemals
 * in Fehlermeldungen an Außenstehende (kein Venue-Name aus Fremdeingabe darin landet
 * unsaniert — der Konstruktor kürzt auf sichere Zeichen).
 */
export class UnknownVenueProfileWarning {
  readonly venue: string;
  constructor(venue: string) {
    this.venue = venue;
  }
}

/**
 * Wird im Sync-/Registrierungspfad geworfen, wenn eine Venue KEIN
 * Profil besitzt. Der Abfragepfad (Scanner, Rule Engine, MarketData)
 * wirft ihn nie — dort greift das strikte Default-Profil.
 */
export class UnknownVenueProfileError extends Error {
  readonly code = "UNKNOWN_VENUE_PROFILE";
  readonly venue: string;
  constructor(venue: string) {
    super(`Kein Venue-Symbol-Profil für ${venue} registriert — Sync/Registration muss die Venue auflösen, statt zu raten.`);
    this.name = "UnknownVenueProfileError";
    this.venue = venue;
  }
}

/**
 * Venue-Provenienz für Orderbuch-Tiefe: Herkunft + Qualitätsgrenze (v0.4.0, IAD-T-06).
 *
 * Warum das nötig ist: `bookDepthUsd` ist nur dann ein Entscheidungswert, wenn
 * die Venue eine Tiefe liefert, die tief genug gemessen ist und frisch genug.
 * Drei Venue-Familien sind qualitativ verschieden:
 *
 * - `depth`   (Binance/Bitunix/Kraken) — echtes Multi-Level-Orderbuch; die
 *   Tiefensumme ist ein belegbares USD-Notional.
 * - `top`     (Yahoo) — nur Top-of-Book; die „Levels“ tragen keine Lotgröße,
 *   es gibt keine belegbare Tiefe (SPREAD ok, DEPTH nein).
 * - `none`    — kein Orderbuch (z. B. Paper-Preset) ⇒ kein spread, keine Tiefe.
 *
 * Die Grenze wird ausschließlich bei der Erhebung gesetzt (live durch den
 * Micro-Executor/WebSocket, im sync durch `enrichWithOrderBooks`, im Cycle
 * durch `readBookDepth`). Die Regel-Engine selbst bleibt venue-agnostisch und
 * wertet nur `depthUsd` gegen die Bedingung — ist das Buch nicht `VERIFIED`,
 * liest sie `depthUsd` erst gar nicht (fail-closed `null`).
 *
 * Betreiber-Erweiterung: Unbekannte Venues fallen auf `DEFAULT` (`none`)
 * zurück, NIE auf `depth` — eine Plug-and-play-Venue ohne dokumentierte
 * Buchqualität liefert so keine erfundene Tiefe.
 */

/** Erhebungsqualität eines Orderbuchs. */
export type BookDepthQualityKind = "depth" | "top" | "none";

/** Abstrakte Qualitätsstufe: Venue-Bindung und Mindestanforderungen. */
export interface BookDepthQuality {
  /** Venue-Key in Großbuchstaben (bzw. `DEFAULT` als Fallback). */
  venueKey: string;
  /** Erhebungsqualität der Venue-Familie. */
  kind: BookDepthQualityKind;
  /** Mindest-Levels je Seite, die die Erhebung liefern muss. */
  minLevels: number;
  /** Max. Alter des Tiefen-Snapshots (ms); `null` = kein Alterslimit. */
  maxAgeMs: number | null;
}

/**
 * Bestellte Qualitätsstufen. Nur `depth`-Venues können eine `VERIFIED`-Tiefe
 * liefern; `top`/`none` sind per Konstruktion `UNQUALIFIED` (fail-closed).
 *
 * Default-Grenze `DEFAULT_MIN_LEVELS`/`DEFAULT_MAX_AGE_MS`: Der Micro-Executor
 * hält ein Buch aus dem Binance-Depth-Stream nach dem 3. Level typischerweise
 * für Sekunden gültig. Die Grenzen sind bewusst konservativ — eine antike
 * Tiefe ist schlimmer als gar keine.
 */
export const BOOK_DEPTH_MIN_LEVELS_PER_QUOTE = 3;
export const BOOK_DEPTH_MAX_AGE_MS_DEFAULT = 5_000;

export const BOOK_DEPTH_QUALITIES: readonly BookDepthQuality[] = [
  { venueKey: "BINANCE", kind: "depth", minLevels: BOOK_DEPTH_MIN_LEVELS_PER_QUOTE, maxAgeMs: BOOK_DEPTH_MAX_AGE_MS_DEFAULT },
  { venueKey: "BITUNIX", kind: "depth", minLevels: BOOK_DEPTH_MIN_LEVELS_PER_QUOTE, maxAgeMs: BOOK_DEPTH_MAX_AGE_MS_DEFAULT },
  { venueKey: "KRAKEN", kind: "depth", minLevels: BOOK_DEPTH_MIN_LEVELS_PER_QUOTE, maxAgeMs: BOOK_DEPTH_MAX_AGE_MS_DEFAULT },
  { venueKey: "YAHOO", kind: "top", minLevels: 0, maxAgeMs: null },
  { venueKey: "DEFAULT", kind: "none", minLevels: 0, maxAgeMs: null },
] as const;

/** Fallback-Stufe (letzter Eintrag, `DEFAULT`/`none`). */
export const BOOK_DEPTH_QUALITY_DEFAULT: BookDepthQuality =
  BOOK_DEPTH_QUALITIES[BOOK_DEPTH_QUALITIES.length - 1];

/** Obergrenze für eine Herkunfts-ID (Venue-Key; Betreiber-Sonderfälle). */
const MAX_VENUE_LENGTH = 32;

/** Grenzen einer konkreten Tiefen-Erhebung (Messung, nicht Venue-Konfiguration). */
export interface BookDepthLimits {
  /** Anzahl gemessener Buch-Levels je Seite (0 = keine Tiefe erhoben). */
  levels: number;
  /** Alter des Tiefen-Snapshots in ms; `null` = Alter unbekannt. */
  maxAgeMs: number | null;
}

/** Beurteilung einer Erhebung gegen die Venue-Grenze. */
export type BookDepthVerdict = "VERIFIED" | "UNQUALIFIED";

/**
 * Löst die Qualitätsstufe einer Venue auf. Unbekannte oder unbrauchbare
 * Herkünfte fallen auf `DEFAULT` (`none`) — nie auf `depth`.
 */
export function findBookDepthQuality(venueRaw?: unknown): BookDepthQuality {
  const venue = typeof venueRaw === "string" ? venueRaw.trim().toUpperCase() : "";
  if (venue.length === 0 || venue.length > MAX_VENUE_LENGTH) return BOOK_DEPTH_QUALITY_DEFAULT;
  for (const quality of BOOK_DEPTH_QUALITIES) {
    if (quality.venueKey === venue) return quality;
  }
  return BOOK_DEPTH_QUALITY_DEFAULT;
}

/**
 * Entscheidet, ob eine konkrete Tiefen-Erhebung die Venue-Grenze erfüllt.
 * `null` (keine Erhebung) ist `UNQUALIFIED`, nie „leer“ — die Regel-Engine
 * sieht dann `depthUsd = null` und die Bedingung blockiert (fail-closed).
 */
export function bookDepthVerdict(
  venueRaw: unknown,
  depth: BookDepthLimits | null | undefined,
): BookDepthVerdict {
  if (!depth) return "UNQUALIFIED";
  const quality = findBookDepthQuality(venueRaw);
  if (quality.kind !== "depth") return "UNQUALIFIED";
  if (depth.levels < quality.minLevels) return "UNQUALIFIED";
  if (quality.maxAgeMs != null && depth.maxAgeMs != null && depth.maxAgeMs > quality.maxAgeMs) {
    return "UNQUALIFIED";
  }
  return "VERIFIED";
}

/** Kann diese Venue überhaupt belastbare Tiefe liefern? (Capability-Abfrage.) */
export function depthUsableForVenue(venueRaw?: unknown): boolean {
  return findBookDepthQuality(venueRaw).kind === "depth";
}

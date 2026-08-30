/**
 * Zentrale, venue-aware Symbol-Normalisierung (SYM-007, P1).
 *
 * **Single Source of Truth** für Symbol-Semantik. Sie ersetzt die vier
 * historisch auseinandergelaufenen Regex-Muster (Universe, MarketData,
 * RuleEngine, Bitunix-Broker) — deren Tabelle und Nebeneinander steht in
 * `docs/SYMBOLS.md`.
 *
 * Vertrag (Ticket §2):
 *
 * ```ts
 * const c = normalizeVenueSymbol("KRAKEN", "xbt-usd");
 * // { venue: "KRAKEN", canonical: "BTC/USD", venueNative: "XBTUSD",
 * //   instrumentId: "KRAKEN:BTC/USD", assetClass: "CRYPTO" }
 * ```
 *
 * Kanonisierungsregeln (verbindlich, dokumentiert in docs/SYMBOLS.md):
 *   1. Unicode-Normalisierung **NFKC**, Entfernung von Zero-Width-Zeichen
 *      (U+200B–U+200D, U+FEFF), Trimmen, Uppercase.
 *   2. Akzeptierte Eingabeformate: `BTCUSDT`, `BTC/USD`, `BTC-USD`, `BTC_USD`,
 *      `EUR.USD`, `EURUSD=X` sowie mit Venue-Präfix (`KRAKEN:BTC/USD` — der
 *      Präfix muss zum Venue-Argument passen, sonst wird abgelehnt).
 *   3. Kanonisches Format je Anlageklasse: Krypto-/FX-Paare mit `/`,
 *      Einzelwerte (Aktien/ETF) ohne Trenner (Klassensuffix `BRK.B` bleibt).
 *   4. `instrumentId` ist immer `${VENUE}:${canonical}`.
 *
 * Rote Linie: **Nichts wird geraten.** Mehrdeutige oder kaputte Eingaben
 * werden mit maschinenlesbarem Grund abgelehnt (`tryNormalizeVenueSymbol`)
 * bzw. als typisierter `SymbolNormalizationError` geworfen
 * (`normalizeVenueSymbol`) — niemals „repariert“.
 *
 * **Rule-Engine-Sicherheitsgrenzen bleiben unangetastet** (§3.3): dieses Modul
 * ändert weder Seite (`RULE_ALLOWED_SIDE = "LONG"`) noch Operatoren — es liefert
 * ausschließlich die kanonische Symbolform.
 */

import { structuredLog } from "../lib/logger";
import {
  SymbolNormalizationError,
  UnknownVenueProfileError,
  UnknownVenueProfileWarning,
  type SymbolRejectReason,
} from "./errors";
import {
  CRYPTO_BASES,
  FIAT_CODES,
  KNOWN_ETFS,
  MAX_VENUE_LENGTH,
  VENUE_RE,
  getVenueProfile,
  hasDisallowedInputChar,
  parseCanonicalSymbol,
  parseVenueSymbol,
  renderCanonicalParsed,
  resolveVenueProfile,
  type ParsedSymbol,
  type SymbolAssetClass,
  type VenueSymbolProfile,
} from "./venueProfiles";

/** Kanonisiertes Venue-Symbol (Ticket-Contract). */
export type CanonicalSymbol = {
  /** Venue-Kürzel, uppercase (`KRAKEN`). */
  venue: string;
  /** Kanonische Darstellung, Paare mit `/` (`BTC/USD`). */
  canonical: string;
  /** Was die Venue-API erwartet (`XBTUSD`, `BTCUSDT`, `EUR.USD`). */
  venueNative: string;
  /** `${venue}:${canonical}` — Registrierungs-/History-Referenz. */
  instrumentId: string;
  assetClass: SymbolAssetClass;
};

/** Optionen der Normalisierung. */
export interface NormalizeOptions {
  /**
   * Venue-Profil-Politik:
   *  - `warn` (Default, Abfragepfad): unbekannte Venue → striktes
   *    Default-Profil + `UnknownVenueProfileWarning` (kein Wurf).
   *  - `strict` (Sync-/Registrierungspfad): unbekannte Venue →
   *    `UnknownVenueProfileError` wird geworfen bzw. als Grund geliefert.
   */
  profilePolicy?: "warn" | "strict";
}

/**
 * Warn-Senke: beobachtbar machen, dass ein Default-Profil statt eines
 * Venue-Profils genutzt wurde. Default: strukturiertes Log-Event
 * (`unknown_venue_symbol_profile`). Tests injizieren eine eigene Senke über
 * {@link setUnknownVenueWarningSinkForTests}.
 */
type UnknownVenueWarningSink = (warning: UnknownVenueProfileWarning) => void;

let warningSink: UnknownVenueWarningSink | null = null;

function emitUnknownVenueWarning(venue: string): void {
  const warning = new UnknownVenueProfileWarning(venue);
  if (warningSink) {
    warningSink(warning);
    return;
  }
  structuredLog("warn", "unknown_venue_symbol_profile", {
    venue: warning.venue,
    fallback: "DEFAULT_PROFILE",
  });
}

/** Nur für Tests: Warn-Senke ersetzen (`null` = zurück aufs strukturierte Log). */
export function setUnknownVenueWarningSinkForTests(sink: UnknownVenueWarningSink | null): void {
  warningSink = sink;
}

/**
 * Zero-Width- und BOM-Zeichen (U+200B–U+200D, U+FEFF), die vor jeder Bewertung
 * entfernt werden — sie sind unsichtbar und würden sonst zwei byte-verschiedene
 * „gleiche“ Symbole erzeugen.
 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * Unicode-Bereinigung (Pflicht-Regel §3.2): NFKC → Zero-Width raus → trim →
 * uppercase. Keine Reparatur von Trennern/Sonderzeichen — die bleiben dem
 * Parser/den Zeichensätzen überlassen.
 */
export function cleanRawSymbol(raw: string): string {
  return raw.normalize("NFKC").replace(ZERO_WIDTH_RE, "").trim().toUpperCase();
}

/** Zerlegt `VENUE:SYMBOL`-Eingaben; `null`, wenn kein Präfix vorhanden. */
function splitVenuePrefix(s: string): { venue: string; symbol: string } | null {
  const idx = s.indexOf(":");
  if (idx < 0) return null;
  return { venue: s.slice(0, idx), symbol: s.slice(idx + 1) };
}

type InternalFailure = { ok: false; reason: SymbolRejectReason; message: string };
type InternalSuccess = { ok: true; value: CanonicalSymbol };

function fail(reason: SymbolRejectReason, message: string): InternalFailure {
  return { ok: false, reason, message };
}

/** Klassifiziert ein geparstes Symbol (Heuristik, dokumentiert — rät nie laut). */
function inferAssetClass(profile: VenueSymbolProfile, parsed: ParsedSymbol): SymbolAssetClass {
  if (parsed.kind === "pair") {
    if (parsed.fxSuffix) return "FX";
    if (FIAT_CODES.has(parsed.base) && FIAT_CODES.has(parsed.quote)) return "FX";
    if (/^(USDT|USDC|TUSD|FDUSD|BUSD|BTC|ETH)$/.test(parsed.quote)) return "CRYPTO";
    if (CRYPTO_BASES.has(parsed.base)) return "CRYPTO";
    if (!FIAT_CODES.has(parsed.base) && parsed.quote === "USD") return "CRYPTO";
    return "UNKNOWN";
  }
  if (parsed.fxSuffix) return "FX";
  if (parsed.classCode !== null) return "EQUITY";
  if (CRYPTO_BASES.has(parsed.ticker)) return "CRYPTO";
  if (KNOWN_ETFS.has(parsed.ticker)) return "ETF";
  return profile.singleTickerAssetClass;
}

/**
 * Kern-Normalisierung — rein und ohne Seiteneffekte. Formatfehler werden als
 * {@link InternalFailure} geliefert; einzige Ausnahme: `profilePolicy:
 * "strict"` wirft bei unbekannter Venue einen `UnknownVenueProfileError`
 * (gewollter Abbruch des Sync-Pfads, siehe Ticket §3.1).
 */
function normalizeInternal(
  venueRaw: string,
  rawSymbolRaw: string,
  opts: NormalizeOptions
): InternalSuccess | InternalFailure {
  if (typeof venueRaw !== "string" || typeof rawSymbolRaw !== "string") {
    return fail("NON_STRING_INPUT", "venue und rawSymbol müssen Strings sein");
  }

  const venue = venueRaw.normalize("NFKC").trim().toUpperCase();
  if (!venue || venue.length > MAX_VENUE_LENGTH || !VENUE_RE.test(venue)) {
    return fail("VENUE_INVALID", `Venue ungültig (${safeSlice(venueRaw)})`);
  }
  const resolved = resolveVenueProfile(venue);
  if (!resolved) return fail("VENUE_INVALID", `Venue ungültig (${safeSlice(venueRaw)})`);
  if (resolved.usedDefaultProfile && opts.profilePolicy === "strict") {
    throw new UnknownVenueProfileError(venue);
  }

  // 1) Unicode-Bereinigung (NFKC, Zero-Width, Trim, Uppercase).
  let s = cleanRawSymbol(rawSymbolRaw);
  if (s.length === 0) return fail("EMPTY_INPUT", "Symbol ist leer");

  // 2) Optionaler Venue-Präfix: muss zum Argument passen (kein Raten).
  const prefixed = splitVenuePrefix(s);
  if (prefixed) {
    if (prefixed.symbol.includes(":")) {
      return fail("INVALID_CHARACTERS", `Mehr als ein Doppelpunkt (${safeSlice(rawSymbolRaw)})`);
    }
    if (prefixed.venue !== venue) {
      return fail(
        "VENUE_PREFIX_MISMATCH",
        `Präfix ${prefixed.venue} passt nicht zur Venue ${venue} (${safeSlice(rawSymbolRaw)})`
      );
    }
    s = prefixed.symbol;
    if (s.length === 0) return fail("EMPTY_INPUT", "Symbolteil nach dem Venue-Präfix ist leer");
  }

  const { profile } = resolved;

  // 3) Längen- und Zeichensatz-Limits (lineare, ReDoS-sichere Klassen).
  if (s.length > profile.maxLength) {
    return fail("TOO_LONG", `Symbol länger als ${profile.maxLength} Zeichen (${safeSlice(rawSymbolRaw)})`);
  }
  if (s.length < profile.minLength) {
    return fail("MALFORMED_SYMBOL", `Symbol kürzer als ${profile.minLength} Zeichen (${safeSlice(rawSymbolRaw)})`);
  }
  if (hasDisallowedInputChar(s)) {
    return fail("INVALID_CHARACTERS", `Symbol enthält verbotene Zeichen (${safeSlice(rawSymbolRaw)})`);
  }

  // 4) Paar-Parsing (kein Raten; mehrdeutig → Grund).
  const parsed = parseVenueSymbol(profile, s);
  if (!parsed.ok) {
    return fail(parsed.reason, `Symbol nicht verarbeitbar (${parsed.reason}; ${safeSlice(rawSymbolRaw)})`);
  }

  // 5) Kanonische/native Form aus dem Venue-Profil.
  const canonical = profile.toCanonical(s);
  // Defensive Tiefenprüfung: das kanonische Ergebnis muss selbst wieder
  // parsebar sein (Kanon-Parser) und byte-stabil bleiben (Profilinvariante).
  const canonicalReparsed = parseCanonicalSymbol(canonical);
  if (!canonicalReparsed.ok || renderCanonicalParsed(canonicalReparsed.parsed) !== canonical) {
    return fail(
      "MALFORMED_SYMBOL",
      `Kanonisierung instabil (${safeSlice(rawSymbolRaw)} → ${safeSlice(canonical)})`
    );
  }
  const venueNative = profile.toVenueNative(canonical);

  return {
    ok: true,
    value: {
      venue,
      canonical,
      venueNative,
      instrumentId: `${venue}:${canonical}`,
      assetClass: inferAssetClass(profile, canonicalReparsed.parsed),
    },
  };
}

/** Gekürzte, ASCII-sichere Referenz für Fehlermeldungen (nie Rohdaten-Dumps). */
function safeSlice(value: unknown, max = 40): string {
  const raw = typeof value === "string" ? value : String(value);
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return clean || "<leer>";
}

/**
 * Wirf-freie Normalisierung (Abfragepfad: Scanner, RuleEngine, MarketData).
 * Bei unbekannter Venue: striktes Default-Profil + `UnknownVenueProfileWarning`
 * im strukturierten Log — niemals ein Wurf.
 */
export function tryNormalizeVenueSymbol(
  venue: string,
  rawSymbol: string,
  opts: NormalizeOptions = {}
): { ok: true; value: CanonicalSymbol } | { ok: false; reason: string } {
  let result: InternalSuccess | InternalFailure;
  try {
    result = normalizeInternal(venue, rawSymbol, opts);
  } catch (err) {
    if (err instanceof UnknownVenueProfileError) {
      return { ok: false, reason: `Unbekannte Venue: ${venue.trim().toUpperCase()}` };
    }
    throw err;
  }
  if (!result.ok) return { ok: false, reason: result.message };

  const resolved = resolveVenueProfile(venue.trim().toUpperCase());
  if (resolved?.usedDefaultProfile) {
    emitUnknownVenueWarning(resolved.venue);
  }
  return { ok: true, value: result.value };
}

/**
 * Werfende Normalisierung. Wirft {@link SymbolNormalizationError} bei
 * Formatfehlern und {@link UnknownVenueProfileError}, wenn
 * `profilePolicy: "strict"` gesetzt ist und die Venue kein Profil besitzt
 * (vorgesehen für Sync-/Registrierungspfade).
 */
export function normalizeVenueSymbol(
  venue: string,
  rawSymbol: string,
  opts: NormalizeOptions = {}
): CanonicalSymbol {
  const resolved = resolveVenueProfile(venue.trim().toUpperCase());
  const result = normalizeInternal(venue, rawSymbol, opts);
  if (!result.ok) {
    throw new SymbolNormalizationError(result.reason, result.message, resolved?.venue ?? null);
  }
  if (resolved?.usedDefaultProfile) {
    emitUnknownVenueWarning(resolved.venue);
  }
  return result.value;
}

/**
 * Prüft eine Instrument-ID der Form `VENUE:SYMBOL` — der Symbolteil muss sich
 * für die genannte Venue kanonisieren lassen (kanonische ODER native Schreibweise).
 * Wirft nie (Abfragepfad).
 */
export function isValidInstrumentId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const idx = id.indexOf(":");
  if (idx <= 0) return false;
  const venue = id.slice(0, idx);
  const symbol = id.slice(idx + 1);
  if (symbol.includes(":")) return false;
  return tryNormalizeVenueSymbol(venue, symbol, {}).ok;
}

/**
 * Zeichensatz-Prüfung eines Symbols im venue-nativen „Lagerformat“
 * (Registry-Speicher). Die Registry speichert bewusst die venue-typische
 * Schreibweise (`IBKR:EUR.USD`, `BINANCE:BTCUSDT`) — deshalb bleibt hier das
 * bisherige, etwas liberalere Speichermuster bestehen, jetzt als lineare
 * Klasse an EINER zentralen Stelle.
 *
 * Deckungsgleich mit dem früheren `universe/validation.ts`-Muster.
 */
export const STORAGE_SYMBOL_RE = /^[A-Z0-9]{1,20}(?:[/.\-_=][A-Z0-9]{1,10}){0,2}$/;

/** Maximale Länge eines Symbols im Registry-Speicher (legacy-kompatibel: 32). */
export const STORAGE_MAX_SYMBOL_LENGTH = 32;

/** true, wenn der Wert ein speicherbares venue-natives Symbol ist (wirft nie). */
export function isValidStorageSymbol(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length <= STORAGE_MAX_SYMBOL_LENGTH &&
    STORAGE_SYMBOL_RE.test(raw)
  );
}

/** true, wenn die Venue ein eigenes Profil besitzt (kein Default-Fallback). */
export function hasVenueProfile(venue: string): boolean {
  return getVenueProfile(venue) !== null;
}

/**
 * Prüft ein venue-natives Order-Symbol für Broker-Adapter (z. B. die
 * Bitunix-Order-Serialisierung): Es muss sich für DIE Venue fehlerfrei
 * kanonisieren lassen und das Ergebnis muss byte-identisch mit der Eingabe
 * sein (keine Reparatur kurz vor der Order).
 */
export function isValidVenueNativeSymbol(venue: string, rawSymbol: unknown): rawSymbol is string {
  if (typeof rawSymbol !== "string") return false;
  const res = tryNormalizeVenueSymbol(venue, rawSymbol, {});
  if (!res.ok) return false;
  // Strikte Identity-Regel für den Order-Pfad: Order-Symbole kommen intern
  // aus der Registry/den Contracts und müssen bereits in der erwarteten
  // venue-nativen Form vorliegen — der Adapter repariert nicht, er lehnt ab.
  return rawSymbol === res.value.venueNative;
}

export type { SymbolAssetClass } from "./venueProfiles";

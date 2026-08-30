/**
 * Eingabevalidierung der Instrument-Registry.
 *
 * Grundsatz: **Nichts wird geraten.** Jede Eingabe (Datei, HTTP-Query, späterer
 * Broker-Discovery-Adapter) durchläuft dieselben Muster- und Größenlimits.
 * Ungültige Sätze werden mit Code + Begründung abgelehnt, nie repariert.
 */

import { capabilityMatrix } from "../capabilities/matrix";
import { resolveInstrumentCapabilities } from "../capabilities/resolveCapabilities";
import {
  STORAGE_MAX_SYMBOL_LENGTH,
  STORAGE_SYMBOL_RE,
  isValidStorageSymbol,
} from "../symbols/normalize";
import { MAX_VENUE_LENGTH, VENUE_RE } from "../symbols/venueProfiles";
import {
  ASSET_CLASSES,
  INSTRUMENT_STATUSES,
  MARKET_TYPES,
  type AssetClass,
  type InstrumentStatus,
  type MarketInstrument,
  type MarketType,
} from "./types";

/** Maximale Länge eines Venue-Namens. */
export { MAX_VENUE_LENGTH };
/** Maximale Länge eines venue-nativen Symbols. */
export const MAX_SYMBOL_LENGTH = STORAGE_MAX_SYMBOL_LENGTH;
/** Maximale Länge einer Instrument-ID (`VENUE:SYMBOL`). */
export const MAX_ID_LENGTH = MAX_VENUE_LENGTH + 1 + MAX_SYMBOL_LENGTH;
/** Harte Obergrenze für Batch-Upserts (DoS-Schutz). */
export const MAX_BATCH_SIZE = 5000;
/** Harte Obergrenze für die Seitengröße einer Query. */
export const MAX_PAGE_SIZE = 500;
/** Standard-Seitengröße, wenn der Aufrufer nichts angibt. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Erlaubtes Venue-Format: 2–16 Großbuchstaben/Ziffern/Unterstrich, Start
 * alphabetisch. Seit SYM-007 re-exportiert aus der zentralen Symbol-SSoT
 * (`src/symbols/venueProfiles.ts`) — ein Muster, eine Stelle.
 */
export { VENUE_RE };

/**
 * Erlaubtes Symbolformat im Registry-Speicher: Großbuchstaben/Ziffern,
 * optional bis zu zwei Segmente getrennt durch `/ . - _ =` (deckt `BTC/USD`,
 * `EUR.USD`, `BTC-PERP`, `EURUSD=X`, `BRK.B` ab). Keine Leer-/Sonderzeichen,
 * damit nichts in URLs, Dateinamen oder Queries eskalieren kann.
 *
 * Seit SYM-007 Alias auf `STORAGE_SYMBOL_RE` aus `src/symbols/normalize.ts`.
 * Die Registry speichert bewusst venue-NATIVE Schreibweisen (z. B.
 * `IBKR:EUR.USD`); die kanonische Form (`IBKR:EUR/USD`) liefert die
 * zentrale Normalisierung (`tryNormalizeVenueSymbol`). Beide erfüllen dieses
 * Speichermuster.
 */
export const SYMBOL_RE = STORAGE_SYMBOL_RE;

/** Erlaubtes Format für Asset-/Quote-Ticker. */
export const TICKER_RE = /^[A-Z0-9]{1,12}$/;

/** Fehler der Registry-Validierung — enthält nie Secrets oder Rohdaten-Dumps. */
export class UniverseValidationError extends Error {
  /** Maschinenlesbarer Code für den API-Fehler-Contract. */
  readonly code = "VALIDATION_ERROR";
  /** Betroffenes Feld. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "UniverseValidationError";
    this.field = field;
  }
}

/** Kürzt beliebige Fremdeingaben für Fehlermeldungen/Logs auf 40 Zeichen. */
export function safeRef(value: unknown, max = 40): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const clean = String(raw).replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return clean || "<leer>";
}

/** Prüft ein Venue-Kürzel gegen `VENUE_RE` (nach Trim/Uppercase). */
export function isValidVenue(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= MAX_VENUE_LENGTH && VENUE_RE.test(raw);
}

/** Prüft ein venue-natives Symbol gegen `SYMBOL_RE` (= zentrales Speichermuster, SYM-007). */
export function isValidSymbol(raw: unknown): raw is string {
  return isValidStorageSymbol(raw);
}

/** Prüft eine Instrument-ID auf Format `VENUE:SYMBOL`. */
export function isValidInstrumentId(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > MAX_ID_LENGTH) return false;
  const idx = raw.indexOf(":");
  if (idx < 0) return false;
  return isValidVenue(raw.slice(0, idx)) && isValidSymbol(raw.slice(idx + 1));
}

/** Zerlegt eine ID in Venue und Symbol; `null`, wenn das Format nicht stimmt. */
export function splitInstrumentId(raw: unknown): { venue: string; symbol: string } | null {
  if (!isValidInstrumentId(raw)) return null;
  const idx = raw.indexOf(":");
  return { venue: raw.slice(0, idx), symbol: raw.slice(idx + 1) };
}

/** Prüft, ob ein Wert ein gültiger ISO-8601-Zeitstempel ist. */
export function isIsoTimestamp(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 32) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) === raw.slice(0, 19);
}

function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new UniverseValidationError(field, `erwartet eines von ${allowed.join(" | ")}`);
  }
  return value as T;
}

function requirePositiveNumber(field: string, value: unknown, max = 1e12): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new UniverseValidationError(field, `erwartet endliche Zahl > 0 und ≤ ${max}`);
  }
  return n;
}

function requireFee(field: string, value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  // Gebühren sind Dezimalanteile. Rabatte (negative Maker-Fees) sind real,
  // aber jenseits von ±10 % ist die Quelle mit Sicherheit kaputt.
  if (!Number.isFinite(n) || n < -0.1 || n > 0.1) {
    throw new UniverseValidationError(field, "erwartet Dezimalanteil zwischen -0.1 und 0.1");
  }
  return n;
}

function requireBoolean(field: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new UniverseValidationError(field, "erwartet boolean");
  }
  return value;
}

function optionalMetric(field: string, value: unknown, max = 1e15): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new UniverseValidationError(field, `erwartet null oder Zahl zwischen 0 und ${max}`);
  }
  return n;
}

/**
 * Validiert ein vollständiges Instrument (nach der Normalisierung) und liefert
 * eine defensive Kopie mit exakt den Contract-Feldern — Fremdfelder werden
 * verworfen, damit nichts Unkontrolliertes in die Persistenz gelangt.
 *
 * @throws {UniverseValidationError} beim ersten verletzten Feld.
 */
export function validateInstrument(raw: unknown): MarketInstrument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UniverseValidationError("instrument", "erwartet Objekt");
  }
  const o = raw as Record<string, unknown>;

  if (!isValidVenue(o.venue)) {
    throw new UniverseValidationError("venue", `ungültig (${safeRef(o.venue)})`);
  }
  if (!isValidSymbol(o.symbol)) {
    throw new UniverseValidationError("symbol", `ungültig (${safeRef(o.symbol)})`);
  }
  const venue = o.venue as string;
  const symbol = o.symbol as string;
  const id = `${venue}:${symbol}`;
  if (typeof o.id === "string" && o.id !== id) {
    throw new UniverseValidationError("id", `muss "${id}" sein (VENUE:SYMBOL)`);
  }

  const base = o.base === null || o.base === undefined ? null : String(o.base);
  if (base !== null && !TICKER_RE.test(base)) {
    throw new UniverseValidationError("base", `ungültig (${safeRef(o.base)})`);
  }
  const quote = typeof o.quote === "string" ? o.quote : "";
  if (!TICKER_RE.test(quote)) {
    throw new UniverseValidationError("quote", `ungültig (${safeRef(o.quote)})`);
  }

  const lastSeen = o.lastSeen;
  if (!isIsoTimestamp(lastSeen)) {
    throw new UniverseValidationError("lastSeen", "erwartet ISO-8601-Zeitstempel (UTC)");
  }

  const projectedCapabilities = resolveInstrumentCapabilities(venue, capabilityMatrix);

  return {
    id,
    venue,
    symbol,
    base,
    quote,
    assetClass: requireEnum<AssetClass>("assetClass", o.assetClass, ASSET_CLASSES),
    marketType: requireEnum<MarketType>("marketType", o.marketType, MARKET_TYPES),
    status: requireEnum<InstrumentStatus>("status", o.status, INSTRUMENT_STATUSES),
    minQuantity: requirePositiveNumber("minQuantity", o.minQuantity),
    priceStep: requirePositiveNumber("priceStep", o.priceStep),
    quantityStep: requirePositiveNumber("quantityStep", o.quantityStep),
    makerFee: requireFee("makerFee", o.makerFee),
    takerFee: requireFee("takerFee", o.takerFee),
    leverageAvailable: requireBoolean("leverageAvailable", o.leverageAvailable),
    shortAvailable: requireBoolean("shortAvailable", o.shortAvailable),
    paperAvailable: requireBoolean("paperAvailable", o.paperAvailable),
    liveTradable: projectedCapabilities.liveTradable,
    liveAvailable: projectedCapabilities.liveAvailable,
    volume24h: optionalMetric("volume24h", o.volume24h),
    spread: optionalMetric("spread", o.spread, 1),
    volatility: optionalMetric("volatility", o.volatility, 100),
    lastSeen: new Date(lastSeen as string).toISOString(),
  };
}

/** Klemmt eine Seitengröße auf `1..MAX_PAGE_SIZE`. */
export function clampPageSize(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_SIZE);
}

/** Klemmt eine 1-basierte Seitennummer auf `>= 1`. */
export function clampPage(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(Math.trunc(n), 1);
}

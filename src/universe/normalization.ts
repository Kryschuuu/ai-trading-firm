/**
 * Normalisierungs-Policy: venue-natives Symbol → kanonisches Instrument.
 *
 * Deterministisch und offline. Die Regeln sind bewusst klein und explizit —
 * lieber eine Eingabe ablehnen, als sie falsch zu raten.
 *
 * | Venue    | Beispiel-Eingabe | kanonische ID          | base/quote |
 * | -------- | ---------------- | ---------------------- | ---------- |
 * | BINANCE  | `btcusdt`        | `BINANCE:BTCUSDT`      | BTC/USDT   |
 * | KRAKEN   | `btc/usd`        | `KRAKEN:BTC/USD`       | BTC/USD    |
 * | BITUNIX  | `BTCUSDT` (perp) | `BITUNIX:BTCUSDT`      | BTC/USDT   |
 * | DYDX     | `BTC-USD`        | `DYDX:BTC-USD`         | BTC/USD    |
 * | ALPACA   | `spy`            | `ALPACA:SPY`           | null/USD   |
 * | (FX)     | `EURUSD=X`       | `<VENUE>:EURUSD=X`     | EUR/USD    |
 */

import { capabilityMatrix } from "../capabilities/matrix";
import { resolveInstrumentCapabilities } from "../capabilities/resolveCapabilities";
import {
  MAX_SYMBOL_LENGTH,
  MAX_VENUE_LENGTH,
  UniverseValidationError,
  isValidSymbol,
  isValidVenue,
  safeRef,
  validateInstrument,
} from "./validation";
import type {
  Asset,
  AssetClass,
  Instrument,
  InstrumentInput,
  MarketInstrument,
  MarketType,
  Underlying,
} from "./types";

/**
 * Bekannte Quote-Währungen, absteigend nach Länge geprüft, damit `USDT` vor
 * `USD` greift. Nur diese Suffixe werden aus konkatenierten Symbolen gelöst.
 */
export const KNOWN_QUOTES = [
  "USDT",
  "USDC",
  "TUSD",
  "FDUSD",
  "BUSD",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "BTC",
  "ETH",
] as const;

/** Trennzeichen, die Venues zwischen Basis und Quote verwenden. */
const PAIR_SEPARATORS = ["/", "-", "_", "."];

/** Suffix von Yahoo-FX-Symbolen (`EURUSD=X`). */
const FX_SUFFIX = "=X";

/** Fiat-Codes für die Erkennung von FX-Paaren. */
const FIAT = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "SEK", "NOK"]);

/** Normalisiert einen Venue-Namen (Trim + Uppercase) und validiert das Format. */
export function normalizeVenue(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!isValidVenue(v)) {
    throw new UniverseValidationError("venue", `ungültig (${safeRef(raw)}, max. ${MAX_VENUE_LENGTH} Zeichen)`);
  }
  return v;
}

/**
 * Normalisiert ein venue-natives Symbol: Trim, Uppercase, Entfernen von
 * Leerzeichen. Die venue-typische Schreibweise (Slash bei Kraken, keine
 * Trenner bei Binance) bleibt bewusst erhalten — sie ist Teil der Identität.
 */
export function normalizeSymbol(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, "") : "";
  if (!isValidSymbol(s)) {
    throw new UniverseValidationError("symbol", `ungültig (${safeRef(raw)}, max. ${MAX_SYMBOL_LENGTH} Zeichen)`);
  }
  return s;
}

/** Baut die kanonische ID `VENUE:SYMBOL`. */
export function toInstrumentId(venue: string, symbol: string): string {
  return `${normalizeVenue(venue)}:${normalizeSymbol(symbol)}`;
}

/**
 * Zerlegt ein Symbol in Basis und Quote.
 *
 * Reihenfolge: FX-Suffix (`EURUSD=X`) → expliziter Trenner (`BTC/USD`) →
 * bekanntes Quote-Suffix (`BTCUSDT`) → kein Paar (Aktie/ETF).
 */
export function parseBaseQuote(symbol: string): { base: string | null; quote: string | null } {
  const s = symbol.toUpperCase();

  if (s.endsWith(FX_SUFFIX)) {
    const core = s.slice(0, -FX_SUFFIX.length);
    if (core.length === 6) return { base: core.slice(0, 3), quote: core.slice(3) };
    return { base: null, quote: null };
  }

  for (const sep of PAIR_SEPARATORS) {
    const idx = s.indexOf(sep);
    if (idx > 0 && idx < s.length - 1) {
      const base = s.slice(0, idx);
      const quote = s.slice(idx + 1);
      // `BRK.B` ist kein Paar: eine einzelne Klassenkennung ist keine Quote.
      if (quote.length < 2) return { base: null, quote: null };
      if (quote === "PERP" || quote === "SWAP") return { base, quote: "USD" };
      return { base, quote };
    }
  }

  for (const q of KNOWN_QUOTES) {
    if (s.length > q.length + 1 && s.endsWith(q)) {
      return { base: s.slice(0, -q.length), quote: q };
    }
  }

  return { base: null, quote: null };
}

/** Leitet den Markttyp aus Venue und Symbol ab, wenn er nicht angegeben ist. */
export function inferMarketType(venue: string, symbol: string): MarketType {
  if (venue === "DYDX" || venue === "BITUNIX") return "perpetual";
  if (/-(PERP|SWAP)$/.test(symbol)) return "perpetual";
  return "spot";
}

/** Leitet die Anlageklasse aus Symbol/Quote ab, wenn sie nicht angegeben ist. */
export function inferAssetClass(symbol: string, base: string | null, quote: string | null): AssetClass {
  if (symbol.endsWith(FX_SUFFIX)) return "fx";
  if (base && quote && FIAT.has(base) && FIAT.has(quote)) return "fx";
  if (quote && /^(USDT|USDC|TUSD|FDUSD|BUSD|BTC|ETH)$/.test(quote)) return "crypto";
  if (base && quote === "USD" && !FIAT.has(base)) return "crypto";
  return "equity";
}

/**
 * Vervollständigt eine Teileingabe zu einem validen `MarketInstrument`.
 *
 * Nicht angegebene Handelsbedingungen erhalten konservative Defaults
 * (keine Hebel, kein Short, Paper an, Live aus), Metriken starten auf `null`.
 * `lastSeen` wird auf `now` gesetzt, wenn nichts geliefert wird.
 */
export function normalizeInstrument(input: InstrumentInput, now: Date = new Date()): MarketInstrument {
  const venue = normalizeVenue(input.venue);
  const symbol = normalizeSymbol(input.symbol);
  const parsed = parseBaseQuote(symbol);

  const base = input.base !== undefined ? (input.base === null ? null : String(input.base).trim().toUpperCase()) : parsed.base;
  const quote = (input.quote !== undefined ? String(input.quote) : parsed.quote ?? "USD").trim().toUpperCase();

  const candidate = {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base,
    quote,
    assetClass: input.assetClass ?? inferAssetClass(symbol, base, quote),
    marketType: input.marketType ?? inferMarketType(venue, symbol),
    status: input.status ?? "active",
    minQuantity: input.minQuantity ?? 1e-8,
    priceStep: input.priceStep ?? 0.01,
    quantityStep: input.quantityStep ?? 1e-8,
    makerFee: input.makerFee ?? 0,
    takerFee: input.takerFee ?? 0,
    leverageAvailable: input.leverageAvailable ?? false,
    shortAvailable: input.shortAvailable ?? false,
    paperAvailable: input.paperAvailable ?? true,
    ...resolveInstrumentCapabilities(venue, capabilityMatrix),
    volume24h: input.volume24h ?? null,
    spread: input.spread ?? null,
    volatility: input.volatility ?? null,
    lastSeen: input.lastSeen ?? now.toISOString(),
  };

  return validateInstrument(candidate);
}

/**
 * Kanonische Asset-ID eines Instruments: bei Paaren die Basis, sonst das
 * Symbol ohne venue-spezifische Suffixe.
 */
export function assetIdOf(instrument: MarketInstrument): string {
  if (instrument.base) return instrument.base;
  const s = instrument.symbol;
  if (s.endsWith(FX_SUFFIX)) return s.slice(0, -FX_SUFFIX.length);
  return s;
}

/** Liefert das venue-unabhängige Asset eines Instruments. */
export function assetOf(instrument: MarketInstrument): Asset {
  const id = assetIdOf(instrument);
  return { id, symbol: id, assetClass: instrument.assetClass };
}

/**
 * Liefert das ökonomische Underlying. Für Spot-, Perp- und Future-Instrumente
 * desselben Basiswerts ist die ID identisch — genau das macht die
 * Dreifach-Existenz von BTC sichtbar.
 */
export function underlyingOf(instrument: MarketInstrument): Underlying {
  const assetId = assetIdOf(instrument);
  return { id: assetId, assetId, assetClass: instrument.assetClass };
}

/** Reichert ein Instrument um `assetId`/`underlyingId` an (nicht persistiert). */
export function withRelations(instrument: MarketInstrument): Instrument {
  return { ...instrument, assetId: assetIdOf(instrument), underlyingId: underlyingOf(instrument).id };
}

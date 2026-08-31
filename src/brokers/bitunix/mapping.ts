/**
 * Mapping trading_pairs-JSON → MarketInstrument (Task 07).
 *
 * Unbekannte Felder werden ignoriert. Fehlende optionale Zahlen werden
 * konservativ defaultet (Fees: dokumentierte VIP0-Defaults, weil die
 * API sie nicht liefert — MarketInstrument erlaubt kein null für Fees).
 *
 * marketType ist immer `perpetual` (Bitunix-Futures-API).
 */
import type { MarketInstrument } from "../../universe/types";
import { applyAvailabilityProjection } from "../../universe/capabilityProjection";
import { isValidVenueNativeSymbol } from "../../symbols/normalize";
import { BITUNIX_DEFAULT_MAKER_FEE, BITUNIX_DEFAULT_TAKER_FEE } from "./config";
import type { BitunixTradingPair } from "./types";

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function stepFromPrecision(precision: unknown, fallback: number): number {
  const p = asNumber(precision, NaN);
  if (!Number.isFinite(p) || p < 0 || p > 12) return fallback;
  return Math.pow(10, -Math.trunc(p));
}

function mapStatus(raw: unknown): MarketInstrument["status"] {
  const s = typeof raw === "string" ? raw.toUpperCase() : "";
  if (s === "OPEN") return "active";
  if (s === "CANCEL_ONLY" || s === "STOP") return "halted";
  return "preview";
}

/**
 * Eine Trading-Pair-Zeile auf den Universe-Contract abbilden.
 * Liefert `null`, wenn symbol/base/quote nicht verwertbar sind.
 */
export function mapTradingPair(
  raw: BitunixTradingPair | Record<string, unknown>,
  now: Date = new Date()
): MarketInstrument | null {
  if (!raw || typeof raw !== "object") return null;
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  // Zentrale Symbol-SSoT (SYM-007): venue-native Byte-Identität für BITUNIX
  // (2–20 Zeichen, A–Z0–9) — ersetzt das frühere lokale Inline-Regex.
  if (!symbol || !isValidVenueNativeSymbol("BITUNIX", symbol)) return null;

  const base =
    typeof raw.base === "string" && raw.base.trim()
      ? raw.base.trim().toUpperCase()
      : inferBase(symbol);
  const quote =
    typeof raw.quote === "string" && raw.quote.trim()
      ? raw.quote.trim().toUpperCase()
      : inferQuote(symbol);
  if (!base || !quote) return null;

  const minQuantity = Math.max(asNumber(raw.minTradeVolume, 1e-8), 1e-8);
  const quantityStep = stepFromPrecision(raw.basePrecision, 1e-8);
  const priceStep = stepFromPrecision(raw.quotePrecision, 0.01);
  const maxLeverage = asNumber(raw.maxLeverage, 1);

  return {
    id: `BITUNIX:${symbol}`,
    venue: "BITUNIX",
    symbol,
    base,
    quote,
    assetClass: "crypto",
    marketType: "perpetual",
    status: mapStatus(raw.symbolStatus),
    minQuantity,
    priceStep,
    quantityStep,
    makerFee: BITUNIX_DEFAULT_MAKER_FEE,
    takerFee: BITUNIX_DEFAULT_TAKER_FEE,
    leverageAvailable: maxLeverage > 1,
    shortAvailable: true,
    paperAvailable: true,
    // liveTradable: fachliche Freigabe (Bitunix-Perpetuals sind für Live vorgesehen).
    // liveAvailable kommt ausschließlich aus projectInstrumentAvailability()
    // (Adapter + Capability + Feature-Flag + Live-Gate) — Gate geschlossen ⇒ false.
    liveTradable: true,
    liveAvailable: applyAvailabilityProjection({
      venue: "BITUNIX",
      symbol,
      liveTradable: true,
      paperAvailable: true,
    }).liveAvailable,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
}

const QUOTES = ["USDT", "USDC", "USD", "BTC", "ETH"] as const;

/**
 * Quote-Suffix eines konkatenierten Symbols ableiten („BTCUSDT“ → „USDT“).
 *
 * Exportiert für den Marketdata-Wrapper (`src/marketdata/adapters/bitunix.ts`),
 * der dieselbe Fallback-Logik nutzt, wenn `trading_pairs` base/quote nicht
 * liefert — eine zweite, abweichende Inferenz wäre eine zweite Wahrheit.
 */
export function inferQuote(symbol: string): string | null {
  for (const q of QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) return q;
  }
  return null;
}

/**
 * Base-Suffix eines konkatenierten Symbols ableiten („BTCUSDT“ → „BTC“).
 * Exportiert aus demselben Grund wie {@link inferQuote}.
 */
export function inferBase(symbol: string): string | null {
  const q = inferQuote(symbol);
  if (!q) return null;
  return symbol.slice(0, -q.length) || null;
}

/** Batch-Mapping; kaputte Zeilen werden übersprungen. */
export function mapTradingPairs(
  rows: unknown,
  now: Date = new Date()
): MarketInstrument[] {
  if (!Array.isArray(rows)) return [];
  const out: MarketInstrument[] = [];
  for (const row of rows) {
    const mapped = mapTradingPair(row as BitunixTradingPair, now);
    if (mapped) out.push(mapped);
  }
  return out;
}

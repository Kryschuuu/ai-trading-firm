/**
 * Migration der alten `DEFAULT_WATCHLIST` (9 Symbole) in das Instrument-Universum.
 *
 * Abbildungsregeln:
 *   - Krypto (BTC, ETH, SOL) → BINANCE-Spot (`…USDT`) **und** KRAKEN-Spot (`…/USD`)
 *   - Aktien/ETF (SPY, QQQ, NVDA, AAPL, MSFT) → ALPACA **und** IBKR
 *   - EURUSD=X → FX-Instrument bei IBKR (`EUR.USD`)
 *   - zusätzlich pro Watchlist-Symbol ein `PAPER:*`-Instrument, damit der
 *     bestehende Paper-Broker-Pfad unverändert weiterläuft (kein Breaking Change).
 *
 * Handelsbedingungen sind konservative, dokumentierte Startwerte — sie stammen
 * aus öffentlichen Gebühren-/Tick-Tabellen der Venues und werden von späteren
 * Discovery-Tasks überschrieben. Metriken starten bewusst auf `null`:
 * die Registry erfindet keine Marktdaten.
 */

import type { InstrumentInput } from "./types";
import { UI_WATCHLIST_PREFERENCE } from "./watchlist";

/**
 * Fester Zeitstempel des Seeds. Deterministisch, damit die committete
 * NDJSON-Datei bei wiederholtem Seed-Lauf byte-identisch bleibt.
 */
export const SEED_TIMESTAMP = "2026-08-27T00:00:00.000Z";

/** Die 9 Symbole der historischen `DEFAULT_WATCHLIST` (Migrationsquelle). */
export const LEGACY_WATCHLIST: readonly string[] = [
  "BTC",
  "ETH",
  "SOL",
  "SPY",
  "QQQ",
  "NVDA",
  "AAPL",
  "MSFT",
  "EURUSD=X",
];

const CRYPTO = [
  { asset: "BTC", binance: "BTCUSDT", kraken: "BTC/USD", minQty: 0.00001, priceStep: 0.01, qtyStep: 0.00001 },
  { asset: "ETH", binance: "ETHUSDT", kraken: "ETH/USD", minQty: 0.0001, priceStep: 0.01, qtyStep: 0.0001 },
  { asset: "SOL", binance: "SOLUSDT", kraken: "SOL/USD", minQty: 0.01, priceStep: 0.001, qtyStep: 0.01 },
] as const;

const EQUITIES = [
  { symbol: "SPY", assetClass: "etf" as const },
  { symbol: "QQQ", assetClass: "etf" as const },
  { symbol: "NVDA", assetClass: "equity" as const },
  { symbol: "AAPL", assetClass: "equity" as const },
  { symbol: "MSFT", assetClass: "equity" as const },
];

function paperInstrument(symbol: string, assetClass: InstrumentInput["assetClass"], base: string | null, quote: string): InstrumentInput {
  return {
    venue: "PAPER",
    symbol,
    base,
    quote,
    assetClass,
    marketType: "spot",
    status: "active",
    minQuantity: 0.0001,
    priceStep: 0.01,
    quantityStep: 0.0001,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable: false,
    shortAvailable: false,
    paperAvailable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: SEED_TIMESTAMP,
  };
}

/**
 * Erzeugt die deterministische Seed-Liste (26 Instrumente):
 * 9 PAPER + 6 Krypto (BINANCE/KRAKEN) + 10 Aktien/ETF (ALPACA/IBKR) + 1 FX (IBKR).
 */
export function buildSeedInstruments(): InstrumentInput[] {
  const out: InstrumentInput[] = [];

  // 1) PAPER-Spiegel der Watchlist — hält den bestehenden Broker-Pfad grün.
  for (const entry of UI_WATCHLIST_PREFERENCE) {
    const s = entry.displaySymbol;
    if (s === "EURUSD=X") out.push(paperInstrument(s, "fx", "EUR", "USD"));
    else if (["BTC", "ETH", "SOL"].includes(s)) out.push(paperInstrument(s, "crypto", s, "USD"));
    else out.push(paperInstrument(s, ["SPY", "QQQ"].includes(s) ? "etf" : "equity", null, "USD"));
  }

  // 2) Krypto an den echten Spot-Venues.
  for (const c of CRYPTO) {
    out.push({
      venue: "BINANCE",
      symbol: c.binance,
      base: c.asset,
      quote: "USDT",
      assetClass: "crypto",
      marketType: "spot",
      status: "active",
      minQuantity: c.minQty,
      priceStep: c.priceStep,
      quantityStep: c.qtyStep,
      makerFee: 0.001,
      takerFee: 0.001,
      leverageAvailable: false,
      shortAvailable: false,
      paperAvailable: true,
      liveAvailable: true,
      volume24h: null,
      spread: null,
      volatility: null,
      lastSeen: SEED_TIMESTAMP,
    });
    out.push({
      venue: "KRAKEN",
      symbol: c.kraken,
      base: c.asset,
      quote: "USD",
      assetClass: "crypto",
      marketType: "spot",
      status: "active",
      minQuantity: c.minQty,
      priceStep: c.priceStep,
      quantityStep: c.qtyStep,
      makerFee: 0.0016,
      takerFee: 0.0026,
      leverageAvailable: false,
      shortAvailable: false,
      paperAvailable: true,
      liveAvailable: true,
      volume24h: null,
      spread: null,
      volatility: null,
      lastSeen: SEED_TIMESTAMP,
    });
  }

  // 3) Aktien/ETF an den Broker-Venues.
  for (const e of EQUITIES) {
    for (const venue of ["ALPACA", "IBKR"] as const) {
      out.push({
        venue,
        symbol: e.symbol,
        base: null,
        quote: "USD",
        assetClass: e.assetClass,
        marketType: "spot",
        status: "active",
        minQuantity: venue === "ALPACA" ? 0.001 : 1,
        priceStep: 0.01,
        quantityStep: venue === "ALPACA" ? 0.001 : 1,
        makerFee: 0,
        takerFee: venue === "ALPACA" ? 0 : 0.0005,
        leverageAvailable: false,
        shortAvailable: true,
        paperAvailable: true,
        liveAvailable: true,
        volume24h: null,
        spread: null,
        volatility: null,
        lastSeen: SEED_TIMESTAMP,
      });
    }
  }

  // 4) FX-Instrument für EURUSD=X.
  out.push({
    venue: "IBKR",
    symbol: "EUR.USD",
    base: "EUR",
    quote: "USD",
    assetClass: "fx",
    marketType: "spot",
    status: "active",
    minQuantity: 1000,
    priceStep: 0.00005,
    quantityStep: 1,
    makerFee: 0,
    takerFee: 0.00002,
    leverageAvailable: true,
    shortAvailable: true,
    paperAvailable: true,
    liveAvailable: true,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: SEED_TIMESTAMP,
  });

  return out;
}

/** Die Seed-Liste als Konstante (deterministisch, keine Seiteneffekte). */
export const SEED_INSTRUMENTS: readonly InstrumentInput[] = buildSeedInstruments();

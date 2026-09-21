/**
 * PAPER-Spiegel: ein Adapter, zwei Beine (Binance-Spot für Krypto, Yahoo für
 * den Rest).
 *
 * Der Paper-Betrieb handelt das kuratierte Universum (`./seeded.ts`: Preset ∪
 * Seed, 155 Zeilen), hat aber keine eigene Marktdaten-Quelle. Der Spiegel
 * routet deshalb je Symbol auf die Sync-Quelle des Originals:
 *   - `crypto` (reine Base-Ticker: `BTC`, `ETH`, …) ⇒ Binance-Spot
 *     (`BTC` → `BTCUSDT`; Quote `USDT ≈ USD`, dokumentierte 1:1-Annahme).
 *   - sonst (Aktien/ETF, FX, Rohstoffe, Indizes) ⇒ Yahoo (Abbildung aus
 *     `./yahoo.ts`, inkl. `EURUSD=X` direkt).
 *
 * Umsetzung: Der Spiegel hält je einen INTERNEN Binance-/Yahoo-Adapter und
 * delegiert (keine duplizierten Mapper, keine zweite HTTP-Schicht). Die
 * Antworten werden auf PAPER-Symbole zurückbeschriftet (`source`:
 * `paper:binance`/`paper:yahoo` — Herkunft bleibt lesbar). Unbekannte
 * Symbole ⇒ `INVALID_SYMBOL` (isoliert, kein Raten).
 */

import type { InstrumentInput } from "../../universe/types";
import { normalizeSyncSymbol } from "../errors";
import type { MarketDataAdapter } from "../sync";
import type { SupportedTimeframe } from "../../lib/marketdata/historicalStore";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../types";
import { BinanceSyncClient, createBinanceMarketDataAdapter } from "./binance";
import { taggedSyncError } from "./http";
import { seededToMarketInstrument } from "./seeded";
import { createYahooMarketDataAdapter, YahooSyncClient } from "./yahoo";

/** Venue-Key, unter dem der Spiegel registriert wird (`registerAdapters.ts`). */
export const PAPER_MARKET_DATA_VENUE = "PAPER" as const;

/** Dependencies des Spiegels (Clients + kuratiertes Universum, injizierbar). */
export interface PaperMarketAdapterDeps {
  /** Binance-Sync-Client (Krypto-Bein). Teilt sich den Binance-Bucket. */
  binance: BinanceSyncClient;
  /** Yahoo-Sync-Client (Aktien/FX/Rohstoff/Index-Bein). Teilt den Yahoo-Bucket. */
  yahoo: YahooSyncClient;
  /**
   * Kuratiertes PAPER-Universum (`seededInstrumentsForVenue("PAPER")`) —
   * zugleich Routing-Tabelle (Asset-Klasse ⇒ Bein).
   */
  instruments: readonly InstrumentInput[];
  /** Injizierbare Uhr (Determinismus in Tests; Default: Realzeit). */
  now?: () => Date;
}

type PaperRoute =
  | { leg: "binance"; binanceSymbol: string }
  | { leg: "yahoo" };

/** PAPER-Symbol → Binance-Symbol (`BTC` → `BTCUSDT`; `…USDT` bleibt as-is). */
export function paperToBinanceSymbol(paperSymbol: string, base: string | null | undefined): string {
  const candidate = (base ?? paperSymbol).toUpperCase();
  return candidate.endsWith("USDT") ? candidate : `${candidate}USDT`;
}

/** Erzeugt den spiegelnden `MarketDataAdapter`. */
export function createPaperMarketDataAdapter(deps: PaperMarketAdapterDeps): MarketDataAdapter {
  const now = deps.now ?? (() => new Date());

  // Routing-Tabelle (Bauzeit): Asset-Klasse ⇒ Bein. `crypto` läuft über
  // Binance, alles andere über Yahoo (dessen Adapter selbst über Abbildung
  // vs. INVALID_SYMBOL entscheidet).
  const routeBySymbol = new Map<string, PaperRoute>();
  const yahooLegInputs: InstrumentInput[] = [];
  for (const input of deps.instruments) {
    const symbol = input.symbol.toUpperCase();
    if (routeBySymbol.has(symbol)) continue;
    if (input.assetClass === "crypto") {
      routeBySymbol.set(symbol, {
        leg: "binance",
        binanceSymbol: paperToBinanceSymbol(symbol, input.base),
      });
    } else {
      routeBySymbol.set(symbol, { leg: "yahoo" });
      yahooLegInputs.push(input);
    }
  }

  const yahooLeg = createYahooMarketDataAdapter({
    venue: PAPER_MARKET_DATA_VENUE,
    client: deps.yahoo,
    instruments: yahooLegInputs,
    now,
  });
  const binanceLeg = createBinanceMarketDataAdapter({ client: deps.binance, now });
  // Beide Beine implementieren den Bulk (Interface: optional) — ohne ihn
  // wäre der Spiegel N+1; lieber laut scheitern als still langsam sein.
  const binanceBulk = binanceLeg.getTickers;
  const yahooBulk = yahooLeg.getTickers;
  if (!binanceBulk || !yahooBulk) {
    throw new Error("PAPER: interne Bein-Adapter ohne Bulk-Ticker (Invariantenbruch).");
  }

  const resolveRoute = (storage: string): PaperRoute => {
    const upper = storage.toUpperCase();
    const route = routeBySymbol.get(upper);
    if (!route) {
      throw taggedSyncError(
        "INVALID_SYMBOL",
        `PAPER: ${upper} gehört nicht zum kuratierten Sync-Universum (Preset ∪ Seed).`,
      );
    }
    return route;
  };

  return {
    venue: PAPER_MARKET_DATA_VENUE,

    async discoverInstruments(): Promise<MarketInstrument[]> {
      const at = now();
      const out: MarketInstrument[] = [];
      const seen = new Set<string>();
      for (const input of deps.instruments) {
        const symbol = normalizeSyncSymbol(input.symbol);
        if (!symbol) continue;
        const instrument = seededToMarketInstrument(
          { ...input, venue: PAPER_MARKET_DATA_VENUE, symbol },
          at,
        );
        if (seen.has(instrument.id)) continue;
        seen.add(instrument.id);
        out.push(instrument);
      }
      return out;
    },

    async getTicker(symbol: string): Promise<MarketTicker> {
      const upper = symbol.toUpperCase();
      const route = resolveRoute(upper);
      if (route.leg === "yahoo") {
        const ticker = await yahooLeg.getTicker(upper);
        return { ...ticker, symbol: upper, source: "paper:yahoo" };
      }
      const ticker = await binanceLeg.getTicker(route.binanceSymbol);
      return { ...ticker, symbol: upper, source: "paper:binance" };
    },

    /**
     * Bulk über beide Beine (je ein Bulk-Call pro Bein, nicht N+1).
     * Ergebnis in Eingangsreihenfolge (deterministisch).
     */
    async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
      const wanted = symbols ? symbols.map((s) => s.toUpperCase()) : [...routeBySymbol.keys()];
      const binanceWanted: string[] = [];
      const storageByBinance = new Map<string, string>();
      const yahooWanted: string[] = [];
      for (const storage of wanted) {
        const route = routeBySymbol.get(storage);
        if (!route) continue;
        if (route.leg === "binance") {
          if (!storageByBinance.has(route.binanceSymbol)) {
            storageByBinance.set(route.binanceSymbol, storage);
            binanceWanted.push(route.binanceSymbol);
          }
        } else {
          yahooWanted.push(storage);
        }
      }
      const byStorage = new Map<string, MarketTicker>();
      if (binanceWanted.length > 0) {
        const rows = await binanceBulk(binanceWanted);
        for (const row of rows) {
          const storage = storageByBinance.get(row.symbol);
          if (!storage) continue;
          byStorage.set(storage, { ...row, symbol: storage, source: "paper:binance" });
        }
      }
      if (yahooWanted.length > 0) {
        const rows = await yahooBulk(yahooWanted);
        for (const row of rows) {
          byStorage.set(row.symbol, { ...row, source: "paper:yahoo" });
        }
      }
      const out: MarketTicker[] = [];
      for (const storage of wanted) {
        const row = byStorage.get(storage);
        if (row) out.push(row);
      }
      return out;
    },

    async getOrderBook(symbol: string): Promise<MarketOrderBook> {
      const upper = symbol.toUpperCase();
      const route = resolveRoute(upper);
      if (route.leg === "yahoo") {
        const book = await yahooLeg.getOrderBook(upper);
        return { ...book, symbol: upper };
      }
      const book = await binanceLeg.getOrderBook(route.binanceSymbol);
      return { ...book, symbol: upper };
    },

    async getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]> {
      const upper = symbol.toUpperCase();
      const route = resolveRoute(upper);
      if (route.leg === "yahoo") {
        return yahooLeg.getCandles(upper, timeframe, limit);
      }
      return binanceLeg.getCandles(route.binanceSymbol, timeframe, limit);
    },
  };
}

/**
 * Bitunix-Wrapper: Broker-PublicClient → `MarketDataAdapter` (P0-Verdrahtung).
 *
 * DOMÄNENTRENNUNG: Diese Datei ist die einzige Kopplung zwischen der
 * Marketdata-Domäne (`src/marketdata`) und der Bitunix-Broker-Domäne
 * (`src/brokers/bitunix`) — und sie zeigt in genau EINE Richtung:
 *
 *   src/marketdata/adapters/bitunix.ts  ──importiert──▶  BitunixPublicClient
 *
 * `src/brokers/**` importiert NICHTS aus `src/marketdata` (keine Rückwärts-
 * abhängigkeit; der `BitunixBrokerAdapter` implementiert das Interface nicht
 * mehr selbst). Damit bleibt die Broker-Domäne frei von Sync-Orchestrierung
 * und die Marketdata-Domäne kann den Sync-Contract evolve, ohne den Broker
 * anzufassen.
 *
 * SICHERHEIT: Der Wrapper hält ausschließlich den credential-freien
 * `BitunixPublicClient` (trading_pairs / tickers / depth / kline). Ein
 * `BitunixPrivateClient` wird im Market-Data-Pfad NIEMALS konstruiert —
 * nicht hier und nicht in `registerAdapters.ts` (statisch erzwungen in
 * `test/marketdata/security.test.ts`).
 */

import { SUPPORTED_TIMEFRAMES, type SupportedTimeframe } from "../../lib/marketdata/historicalStore";
import { inferBase, inferQuote } from "../../brokers/bitunix/mapping";
import { mapTicker, type BitunixPublicClient } from "../../brokers/bitunix/publicClient";
import {
  BITUNIX_DEFAULT_MAKER_FEE,
  BITUNIX_DEFAULT_TAKER_FEE,
} from "../../brokers/bitunix/config";
import type { BitunixDepthRaw, BitunixTradingPair } from "../../brokers/bitunix/types";
import { normalizeVenueSymbol, type CanonicalSymbol } from "../../symbols/normalize";
import { UnsupportedTimeframeError } from "../errors";
import type { MarketDataAdapter } from "../sync";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketOrderBookLevel, MarketTicker } from "../types";
import type { InstrumentStatus } from "../../universe/types";

/** Venue-Key, unter dem der Wrapper registriert wird (`registerAdapters.ts`). */
export const BITUNIX_MARKET_DATA_VENUE = "BITUNIX" as const;

/**
 * Vollständiges, explizites Timeframe-Mapping `SupportedTimeframe → Bitunix-Interval`.
 *
 * Bitunix-Kline-Intervalle (offizielle Futures-Doku): 1m, 5m, 15m, 30m, 1h,
 * 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M. Die Store-Allowlist
 * (`SUPPORTED_TIMEFRAMES`) ist ein Superset davon — **`3m` und `5d` hat
 * Bitunix nicht**. Diese Lücken sind als `null` EINGETRAGEN (nicht
 * weggelassen): die Map ist damit exhaustiv über jeden `SupportedTimeframe`,
 * und {@link toBitunixInterval} wirft für `null`-Einträge ebenso
 * `UnsupportedTimeframeError` wie für Werte außerhalb der Allowlist. Kein
 * stiller Ersatz durch einen Nachbar-Timeframe — der würde Reihen
 * verschiedener Periodizität mischen.
 */
export const BITUNIX_TIMEFRAME_MAP: Readonly<Record<SupportedTimeframe, string | null>> = {
  "1m": "1m",
  "3m": null, // Bitunix bietet kein 3m-Intervall (dokumentierte Lücke).
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "1d": "1d",
  "5d": null, // Bitunix bietet kein 5d-Intervall (dokumentierte Lücke; 1w ≠ 5d).
};

/** Von Bitunix nachweislich bediente Kline-Intervalle (abgeleitet aus der Map). */
export const BITUNIX_SUPPORTED_INTERVALS: readonly string[] = Object.values(BITUNIX_TIMEFRAME_MAP).filter(
  (v): v is string => v !== null
);

/**
 * Liefert das Bitunix-Interval für einen Store-Timeframe.
 *
 * @throws {UnsupportedTimeframeError} wenn der Timeframe außerhalb der
 *   Store-Allowlist liegt ODER Bitunix dafür kein Intervall dokumentiert
 *   (`null` in {@link BITUNIX_TIMEFRAME_MAP}).
 */
export function toBitunixInterval(timeframe: string): string {
  const mapped = (BITUNIX_TIMEFRAME_MAP as Record<string, string | null>)[timeframe];
  if (mapped === undefined || mapped === null) {
    throw new UnsupportedTimeframeError(timeframe, BITUNIX_MARKET_DATA_VENUE);
  }
  return mapped;
}

/** Dependencies des Wrappers (alles injizierbar → deterministische Tests). */
export interface BitunixMarketAdapterDeps {
  /** Credential-freier Public-Client. NIEMALS ein PrivateClient. */
  publicClient: BitunixPublicClient;
  /**
   * Symbol-SSoT aus SYM-007 — bildet jede Instrument-ID
   * (`instrumentId = BITUNIX:<canonical>`). Injizierbar, damit Tests die
   * Normalisierung per Spy verifizieren können.
   */
  symbolNormalizer: typeof normalizeVenueSymbol;
  /** Injizierbare Uhr (Determinismus in Tests; Default: Realzeit). */
  now?: () => Date;
}

/**
 * DTO→Domain-Mapping EINER `trading_pairs`-Zeile (dokumentierte Regeln):
 *
 * | DTO-Feld | Domain-Feld (`MarketInstrument`) | Nullable-Semantik |
 * | --- | --- | --- |
 * | `symbol` | `symbol` (via `venueNative`), `id` = `VENUE:venueNative` (venue-native Speicherform, docs/SYMBOLS.md §4) | Pflicht; nicht normalisierbar ⇒ Zeile verworfen (kein Instrument bildbar) |
 * | `base` | `base` | fehlend ⇒ Inferenz aus Symbol-Suffix (`inferBase`), scheitert das ⇒ Zeile verworfen |
 * | `quote` | `quote` | fehlend ⇒ Inferenz aus Symbol-Suffix (`inferQuote`), sonst verworfen |
 * | `minTradeVolume` | `minQuantity` | String/Number; ungültig/fehlend ⇒ Default `1e-8` (venuessicherstes Minimum) |
 * | `basePrecision` | `quantityStep = 10^-p` | p außerhalb 0..12 ⇒ Default `1e-8` |
 * | `quotePrecision` | `priceStep = 10^-p` | p außerhalb 0..12 ⇒ Default `0.01` |
 * | `maxLeverage` | `leverageAvailable = maxLeverage > 1` | ungültig/fehlend ⇒ `1` ⇒ `false` |
 * | `symbolStatus` + `isApiSupported` | `status` | siehe {@link mapInstrumentStatus} — nicht handelbare Symbole werden mit `halted`/`delisted` ÜBERNOMMEN, nicht verworfen |
 * | — (nicht in der API) | `makerFee`/`takerFee` | dokumentierte VIP0-Defaults `0.0002`/`0.0006` (`trading_pairs` liefert keine Fees; der Registry-Contract erlaubt kein null) |
 *
 * `volume24h`/`spread`/`volatility` bleiben `null` — sie stammen aus dem
 * Ticker-/Depth-Enrichment des `MarketDataSyncService`, nicht aus Discovery.
 */
export function mapTradingPairToInstrument(
  raw: BitunixTradingPair,
  deps: Pick<BitunixMarketAdapterDeps, "symbolNormalizer">,
  now: Date = new Date()
): MarketInstrument | null {
  if (!raw || typeof raw !== "object") return null;
  const rawSymbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  if (!rawSymbol) return null;

  // Instrument-ID IMMER über die zentrale Symbol-SSoT (SYM-007) — nie selbst
  // konkatenieren. Wichtig ist die richtige Projektion: Registry und
  // HistoricalStore keyen nach der **venue-nativen Speicherform**
  // (`BITUNIX:BTCUSDT`, docs/SYMBOLS.md §4 „Speicherform vs. Kanon“), nicht
  // nach der kanonischen Anfrageform (`canonical.instrumentId` wäre
  // „BITUNIX:BTC/USDT“ und würde Duplikate erzeugen). Eine Zeile, deren
  // Symbol sich nicht normalisieren lässt, kann keinen Registry-Schlüssel
  // bilden und wird verworfen (der Sync-Service zählt solche Zeilen als
  // unusable, sie verschwinden nicht still).
  let canonical: CanonicalSymbol;
  try {
    canonical = deps.symbolNormalizer(BITUNIX_MARKET_DATA_VENUE, rawSymbol, { profilePolicy: "strict" });
  } catch {
    return null;
  }
  const symbol = canonical.venueNative;
  const instrumentId = `${canonical.venue}:${canonical.venueNative}`;

  const base =
    typeof raw.base === "string" && raw.base.trim() ? raw.base.trim().toUpperCase() : inferBase(symbol);
  const quote =
    typeof raw.quote === "string" && raw.quote.trim() ? raw.quote.trim().toUpperCase() : inferQuote(symbol);
  if (!base || !quote) return null;

  const maxLeverage = asNumber(raw.maxLeverage, 1);

  return {
    id: instrumentId,
    venue: BITUNIX_MARKET_DATA_VENUE,
    symbol,
    base,
    quote,
    assetClass: "crypto",
    marketType: "perpetual",
    status: mapInstrumentStatus(raw),
    minQuantity: Math.max(asNumber(raw.minTradeVolume, 1e-8), 1e-8),
    priceStep: stepFromPrecision(raw.quotePrecision, 0.01),
    quantityStep: stepFromPrecision(raw.basePrecision, 1e-8),
    makerFee: BITUNIX_DEFAULT_MAKER_FEE,
    takerFee: BITUNIX_DEFAULT_TAKER_FEE,
    leverageAvailable: maxLeverage > 1,
    shortAvailable: true,
    paperAvailable: true,
    // liveAvailable kommt ausschließlich aus der Projektion (Capability +
    // Feature-Flag + Live-Gate) — Discovery behauptet hier nichts.
    liveTradable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
}

/**
 * `symbolStatus`/`isApiSupported` → Registry-Status (offizielle Doku:
 * „OPEN: trade normal · CANCEL_ONLY: cancel only · STOP: can't open/close
 * position“; `isApiSupported`: „true/false — API Trading Enabled/Disabled“).
 *
 * | Eingabe | Status | Begründung |
 * | --- | --- | --- |
 * | `OPEN` + `isApiSupported !== false` | `active` | normal handelbar |
 * | `OPEN` + `isApiSupported === false` | `halted` | API-Handel aus — Instrument existiert, ist für diesen Pfad aber nicht handelbar. WIRD ÜBERNOMMEN, nicht verworfen. |
 * | `CANCEL_ONLY` \| `STOP` | `halted` | Venue-seitig nicht (voll) handelbar — sichtbar flaggen |
 * | `DELISTED`/`DEL` (defensiv, von der Venue heute nicht dokumentiert) | `delisted` | falls Bitunix den Status je einführt, landet er fachlich korrekt |
 * | unbekannt/fehlend | `preview` | konservativ: Handelbarkeit nicht bestätigt (kein Raten, kein Verwerfen) |
 */
export function mapInstrumentStatus(raw: BitunixTradingPair): InstrumentStatus {
  const status = typeof raw.symbolStatus === "string" ? raw.symbolStatus.trim().toUpperCase() : "";
  if (status === "OPEN") {
    return raw.isApiSupported === false ? "halted" : "active";
  }
  if (status === "CANCEL_ONLY" || status === "STOP") return "halted";
  if (status === "DELISTED" || status === "DEL") return "delisted";
  return "preview";
}

/** Depth-DTO → Orderbook-Levels (String/Number-Paare → endliche Zahlen).
 *
 * P1-Enrichment (Security & Data-Quality):
 *   - Arrays gekappt auf depthLimit (Default 5) — Schutz gegen Payload-Bombing.
 *   - Numerische Felder per Number.isFinite() geprüft, NaN/Infinity → verworfen.
 *   - Nur positive Preise und nicht-negative Mengen übernommen.
 *   - Spread wird aus bestBid/bestAsk berechnet (Ticker liefert keinen Spread).
 *   - Plausibilität: spread > 50% → null (defektes/leeres Buch).
 */
function mapDepthLevels(
  rows: BitunixDepthRaw["bids"] | BitunixDepthRaw["asks"],
  depthLimit = 5
): MarketOrderBookLevel[] {
  if (!Array.isArray(rows)) return [];
  const capped = rows.slice(0, Math.min(depthLimit, 50));
  const out: MarketOrderBookLevel[] = [];
  for (const row of capped) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]);
    const qty = Number(row[1]);
    if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty >= 0) {
      out.push({ price, qty });
    }
  }
  return out;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function stepFromPrecision(precision: unknown, fallback: number): number {
  const p = asNumber(precision, Number.NaN);
  if (!Number.isFinite(p) || p < 0 || p > 12) return fallback;
  return Math.pow(10, -Math.trunc(p));
}

/**
 * Baut den Bitunix-`MarketDataAdapter` um den credential-freien Public-Client.
 *
 * Der Wrapper führt KEIN Registry-Upsert aus — das macht der
 * `MarketDataSyncService` als Stage „upsert“ EINMAL je Instrument mit den
 * angereicherten Feldern (Ticker/Orderbook). Discovery bleibt dadurch
 * seiteneffektfrei (reine Abbildung DTO → Domain).
 */
export function createBitunixMarketDataAdapter(deps: BitunixMarketAdapterDeps): MarketDataAdapter {
  const now = deps.now ?? (() => new Date());
  const client = deps.publicClient;

  return {
    venue: BITUNIX_MARKET_DATA_VENUE,

    async discoverInstruments(): Promise<MarketInstrument[]> {
      // 1 × trading_pairs — RAW-Zeilen holen, Mapping liegt in dieser Domäne.
      const rows = await client.fetchTradingPairsRaw();
      if (!Array.isArray(rows)) return [];
      const out: MarketInstrument[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const instrument = mapTradingPairToInstrument(row, deps, now());
        if (!instrument || seen.has(instrument.id)) continue; // kaputte/duplizierte Zeile
        seen.add(instrument.id);
        out.push(instrument);
      }
      return out;
    },

    async getTicker(symbol: string): Promise<MarketTicker> {
      return client.fetchTicker(symbol.toUpperCase());
    },

    /**
     * 1 × tickers (Bulk) — ein Request für ALLE Symbole (kein N+1).
     *
     * P1: volume24h ist explizit Quote-Volumen (ticker.quoteVol) in Quote-Währung
     * (z. B. USDT). Verwechslung mit Base-Volumen verfälscht min-volume-Filter
     * um Größenordnungen. Dokumentiert im Registry-Typ als JSDoc.
     * Unbekannte Werte bleiben null (Data-Quality), nicht 0.
     */
    async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
      const query = symbols?.map((s) => s.trim().toUpperCase()).filter(Boolean);
      const rows = await client.fetchTickers(query);
      return rows.map(mapTicker);
    },

    async getOrderBook(symbol: string): Promise<MarketOrderBook> {
      // P1-Enrichment: Spread kommt NICHT aus Ticker, sondern aus Orderbook-Top-Level.
      // limit=5 reicht für bestBid/bestAsk; depth ist der einzige Endpunkt ohne
      // Bulk-Variante und wird N-mal pro Lauf gefragt (teuerster Teil des Syncs).
      // Security: Symbol-Allowlist vor URL, Arrays gekappt, numerische Felder geprüft.
      const raw = await client.fetchDepth(symbol.toUpperCase(), 5);
      return {
        symbol: symbol.toUpperCase(),
        bids: mapDepthLevels(raw.bids, 5),
        asks: mapDepthLevels(raw.asks, 5),
        ts: Date.now(),
      };
    },

    async getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]> {
      const interval = toBitunixInterval(timeframe);
      // Die Venue liefert maximal 200 Bars je kline-Call (Doku); der Client
      // klemmt das Limit entsprechend. Ein höheres candleLimit würde ein
      // Paging (mehrere Calls je Reihe) erfordern — bewusst out of scope
      // dieses Wrappers, dokumentiert in docs/MARKET_DATA_PIPELINE.md §10.
      return client.fetchKlines(symbol.toUpperCase(), interval, limit);
    },
  };
}

/** Compile-Time-Beweis, dass die Map wirklich JEDES Store-Timeframe abdeckt. */
const _EXHAUSTIVE_TIMEFRAME_CHECK: Record<SupportedTimeframe, string | null> = BITUNIX_TIMEFRAME_MAP;
void _EXHAUSTIVE_TIMEFRAME_CHECK;
void SUPPORTED_TIMEFRAMES;

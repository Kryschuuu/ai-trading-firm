/**
 * Seed-beschränkte Discovery für Venues ohne Symbol-Listing (ALPACA, IBKR via
 * Yahoo; PAPER als Spiegel).
 *
 * Yahoo Finance kennt keinen „alle Symbole“-Endpunkt — die ehrliche Quelle
 * des Sync-Universums ist deshalb das kuratierte, versionierte Universum des
 * Repos: `PRESET_INSTRUMENTS` (354, `src/universe/presets.ts`) vereinigt mit
 * `SEED_INSTRUMENTS` (26, `src/universe/seed.ts`), je Venue gefiltert und pro
 * Symbol dedupliziert (Preset gewinnt — die Mengen sind wertegleich, wo sie
 * sich überlappen: `BINANCE:BTCUSDT` & Co.).
 *
 * Warum die Vereinigung nötig ist: Die Presets decken weder die Seed-ETFs
 * (`SPY`, `QQQ`) noch das Seed-FX-Paar (`IBKR:EUR.USD`) ab. Discovery aus den
 * Presets allein ließe Seed-Zeilen ohne Kerzen zurück — verwaiste Registry-
 * Einträge, der Scanner bliebe `NO` (Runbook: „verwaiste Instrumente“ in
 * `docs/MARKET_DATA_PIPELINE.md`).
 *
 * Mengen je Venue (Preset ∪ Seed, Stand der Vertrags-Konstanten):
 *   ALPACA: 50 Aktien + SPY/QQQ                                  =  52
 *   IBKR:   50 Aktien + 50 Indizes + 22 Rohstoffe + SPY/QQQ/EUR.USD = 125
 *   PAPER:  152 Spiegel + SPY/QQQ/EURUSD=X                        = 155
 * BINANCE/KRAKEN entdecken live (`exchangeInfo`/`AssetPairs`) und nutzen
 * diese Datei nicht — ihre Seed-Symbole (`BTCUSDT`, `BTC/USD`) sind im
 * Live-Katalog enthalten und mergen per Upsert auf dieselbe ID.
 */

import { PRESET_INSTRUMENTS } from "../../universe/presets";
import { SEED_INSTRUMENTS } from "../../universe/seed";
import type { InstrumentInput } from "../../universe/types";
import type { MarketInstrument } from "../types";

/**
 * Kuratiertes Sync-Universum einer Venue: Preset-Scheibe ∪ Seed-Scheibe,
 * dedupliziert je Symbol (erster Treffer gewinnt = Preset).
 */
export function seededInstrumentsForVenue(venue: string): InstrumentInput[] {
  const key = venue.toUpperCase();
  const out: InstrumentInput[] = [];
  const seen = new Set<string>();
  for (const input of [...PRESET_INSTRUMENTS, ...SEED_INSTRUMENTS]) {
    if (input.venue !== key) continue;
    if (seen.has(input.symbol)) continue;
    seen.add(input.symbol);
    out.push(input);
  }
  return out;
}

/**
 * `InstrumentInput` → Discovery-`MarketInstrument`.
 *
 * Pflichtfelder mit dokumentierten Fallbacks (Presets/Seeds setzen alles —
 * die Fallbacks greifen nur für handgebaute Schnitte in Tests):
 * `status` = `active`, Mengen-/Preis-Ticks = venue-sichere Minima,
 * Gebühren = 0, `liveAvailable` = false (Laufzeitprojektion — Discovery
 * erfindet keine Live-Verfügbarkeit, analog zum Bitunix-Wrapper).
 * `volume24h`/`spread`/`volatility` bleiben `null` (Enrichment-Sache).
 */
export function seededToMarketInstrument(input: InstrumentInput, now: Date): MarketInstrument {
  const venue = input.venue;
  const symbol = input.symbol;
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base: input.base ?? null,
    quote: input.quote ?? "USD",
    assetClass: input.assetClass ?? "crypto",
    marketType: input.marketType ?? "spot",
    status: input.status ?? "active",
    minQuantity: input.minQuantity ?? 0.0001,
    priceStep: input.priceStep ?? 0.01,
    quantityStep: input.quantityStep ?? 0.0001,
    makerFee: input.makerFee ?? 0,
    takerFee: input.takerFee ?? 0,
    leverageAvailable: input.leverageAvailable ?? false,
    shortAvailable: input.shortAvailable ?? false,
    paperAvailable: input.paperAvailable ?? true,
    liveTradable: input.liveTradable ?? false,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
}

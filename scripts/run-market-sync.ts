/**
 * Venue market-data warmup (Discovery → Enrichment → Candle-Backfill).
 *
 *   npm run market-sync                     # BITUNIX, public REST only
 *   npm run market-sync -- --venue=BITUNIX
 *
 * Runs **before** the deterministic scanner. Die `AdapterRegistry`
 * (`src/marketdata/adapterRegistry.ts`) ist die EINZIGE Stelle, die
 * konkrete MarketDataAdapter-Implementierungen instanziiert — hier der
 * `BitunixBrokerAdapter` im Modus "paper" **ohne** PrivateClient/Credentials.
 * Der Sync-Pfad berührt nie die Private-API. Logs aggregated counters only —
 * no symbols, no secrets.
 *
 * See docs/MARKET_DATA_PIPELINE.md.
 */
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { getRegistry } from "../src/universe";
import { MarketDataSyncService, formatSyncLog } from "../src/marketdata";
import { createAdapterRegistry } from "../src/marketdata/adapterRegistry";

const args = process.argv.slice(2);
const venueArg = args.find((a) => a.startsWith("--venue="))?.slice("--venue=".length);
const venue = (venueArg || "BITUNIX").trim().toUpperCase();

async function main(): Promise<void> {
  const registry = getRegistry();
  const history = new HistoricalStore();

  // Einzige Instanzierungsstelle: AdapterRegistry (public-only, paper-Modus).
  // Der Token-Bucket (8 req/s) sitzt am Public-Client des Adapters — ein
  // zweiter Limiter auf Orchestrier-Ebene würde Tokens doppelt verrechnen.
  const adapters = createAdapterRegistry({ registry });

  const sync = new MarketDataSyncService(registry, history, adapters.entries);

  const result = await sync.syncVenue(venue);
  for (const line of formatSyncLog(result)) console.log(line);
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[market-sync] failed: ${msg.slice(0, 160)}`);
  process.exit(1);
});

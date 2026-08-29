/**
 * Venue market-data warmup (Discovery → Enrichment → Candle-Backfill).
 *
 *   npm run market-sync                     # BITUNIX, public REST only
 *   npm run market-sync -- --venue=BITUNIX
 *
 * Runs **before** the deterministic scanner. Never touches PrivateClient
 * or API keys. Logs aggregated counters only — no symbols, no secrets.
 *
 * See docs/MARKET_DATA_PIPELINE.md.
 */
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { getRegistry } from "../src/universe";
import {
  MarketDataSyncService,
  createBitunixMarketDataAdapter,
  formatSyncLog,
} from "../src/marketdata";
import { TokenBucket } from "../src/brokers/bitunix/http";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";

const args = process.argv.slice(2);
const venueArg = args.find((a) => a.startsWith("--venue="))?.slice("--venue=".length);
const venue = (venueArg || "BITUNIX").trim().toUpperCase();

async function main(): Promise<void> {
  const registry = getRegistry();
  const history = new HistoricalStore();
  const adapters = new Map<string, ReturnType<typeof createBitunixMarketDataAdapter>>();

  // Token-Bucket is attached to BitunixHttp (8 req/s). A second limiter on
  // the orchestrator would double-charge tokens; HTTP is the choke point.
  if (venue === "BITUNIX") {
    const cfg = loadBitunixConfig();
    const bucket = new TokenBucket(cfg.publicRatePerSec, cfg.publicRatePerSec);
    adapters.set("BITUNIX", createBitunixMarketDataAdapter({ config: cfg, bucket }));
  }

  const sync = new MarketDataSyncService(registry, history, adapters);

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

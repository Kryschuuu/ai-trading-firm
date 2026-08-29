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
 * MDERR-006: Fehler werden NICHT mehr nur gezählt, sondern zusätzlich als
 * persistentes Datenfehler-Manifest (`data/market-data-errors.json`)
 * geschrieben — der Scanner/Operations-Center liest es und meldet
 * `DATA_UNAVAILABLE` / Readiness ERROR statt `min-candles`.
 *
 * See docs/MARKET_DATA_PIPELINE.md.
 */
import { clearMarketDataErrors, saveMarketDataErrors } from "../src/marketdata/dataErrors";
import { structuredLog } from "../src/lib/logger";
import { runMarketSync } from "./lib/market-sync";

const args = process.argv.slice(2);
const venueArg = args.find((a) => a.startsWith("--venue="))?.slice("--venue=".length);
const venue = (venueArg || "BITUNIX").trim().toUpperCase();

async function main(): Promise<void> {
  const result = await runMarketSync(venue);

  const errorCount = result.errors.length;
  if (errorCount > 0) {
    // Persistiertes Manifest: Ursachen je Instrument → Scanner-Readiness ERROR.
    saveMarketDataErrors(result.errors);
    const byStage: Record<string, number> = {};
    for (const e of result.errors) byStage[e.stage] = (byStage[e.stage] ?? 0) + 1;
    structuredLog("error", "market_sync_fetch_failures", {
      venue: result.venue,
      count: errorCount,
      byStage,
    });
    console.error(`[market-sync] ${errorCount} Marktdaten-Fehler — Manifest geschrieben (data/market-data-errors.json)`);
    process.exitCode = 1;
  } else {
    clearMarketDataErrors();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[market-sync] failed: ${msg.slice(0, 160)}`);
  process.exit(1);
});

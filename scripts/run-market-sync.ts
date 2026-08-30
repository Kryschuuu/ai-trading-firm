/**
 * Venue market-data warmup (Discovery → Enrichment → Candle-Backfill).
 *
 *   npm run market-sync                     # BITUNIX, public REST only
 *   npm run market-sync -- --venue=BITUNIX --timeframes=5m,15m
 *
 * Kompatibilitäts-Einstiegspunkt: derselbe Runner wie `npm run market:sync`
 * (`scripts/market-sync.ts`), inklusive Manifest-Schreibens (MDERR-006) und
 * Exit-Code-Semantik. `market:sync` ist der empfohlene Name, `market-sync`
 * bleibt bestehen, weil Runbooks und `docs/MIGRATION_TIMEFRAME_FIELD.md`
 * darauf verweisen.
 *
 * Der Sync-Pfad berührt nie die Private-API: ausschließlich Public-Endpunkte
 * (trading_pairs / tickers / depth / kline), Modus „paper“, ohne Credentials.
 * Logs: aggregated counters only — no symbols, no secrets.
 *
 * See docs/MARKET_DATA_PIPELINE.md.
 */
import { main } from "./market-sync";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[market-sync] failed: ${msg.slice(0, 160)}`);
    process.exit(1);
  });

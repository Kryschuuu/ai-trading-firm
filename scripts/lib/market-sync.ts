/**
 * Gemeinsamer Market-Data-Sync-Aufruf für CLI (run-market-sync, run-scan).
 *
 * Einzige Instanzierungsstelle der Adapter ist die `AdapterRegistry`
 * (public-only, paper-Modus, ohne Credentials). Fehler werden im
 * `SyncResult.errors` gesammelt und vom Aufrufer ins Datenfehler-Manifest
 * persistiert (`src/marketdata/dataErrors.ts`).
 */
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { getRegistry } from "../../src/universe";
import {
  MarketDataSyncService,
  formatSyncLog,
  type SyncResult,
} from "../../src/marketdata";
import { createAdapterRegistry } from "../../src/marketdata/adapterRegistry";

/** Führt Discovery → Enrichment → Candle-Backfill für eine Venue aus. */
export async function runMarketSync(venue: string): Promise<SyncResult> {
  const registry = getRegistry();
  const history = new HistoricalStore();
  const adapters = createAdapterRegistry({ registry });
  const sync = new MarketDataSyncService(registry, history, adapters.entries);
  const result = await sync.syncVenue(venue);
  for (const line of formatSyncLog(result)) console.log(line);
  return result;
}

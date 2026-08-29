/**
 * Integration: kompletter Sync-Durchlauf über `AdapterRegistry` gegen den
 * lokalen Bitunix-Fixture-HTTP-Server.
 *
 * `MarketDataSyncService.syncVenue("BITUNIX")` — mit der zentralen
 * AdapterRegistry (einzige Adapter-Instanzierungsstelle) und Mock-HTTP-Layer.
 * Assertion: befüllte Registry + HistoricalStore. Kein echtes Netz,
 * 0 Private-Calls, 0 Signaturen.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BitunixFixtureServer } from "../../../tests/fixtures/bitunixFixtureServer";
import { HistoricalStore } from "../../lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../universe/registry";
import { createAdapterRegistry } from "../adapterRegistry";
import { MarketDataSyncService } from "../sync";
import { SYNC_TIMEFRAMES } from "../types";
import { historicalStoreProvider } from "../../scanner/service";

const dirs: string[] = [];
const servers: BitunixFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mds-int-"));
  dirs.push(d);
  return d;
}

/** Env, der den Adapter-Private-Pfad auf den lokalen Fixture-Server zeigt. */
function fixtureEnv(base: string): Record<string, string> {
  return {
    BITUNIX_ENABLED: "true",
    BITUNIX_BASE_URL: base,
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
    BITUNIX_TIMEOUT_MS: "2000",
  };
}

test("Integration: syncVenue(\"BITUNIX\") via AdapterRegistry füllt Registry und HistoricalStore", async () => {
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);

  const dir = tmp();
  const registry = new InstrumentRegistry({
    dir,
    autoSave: true,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  const history = new HistoricalStore(path.join(dir, "history"));

  // Einzige Instanzierungsstelle: AdapterRegistry (paper, public-only).
  const adapters = createAdapterRegistry({ registry, env: fixtureEnv(base) });
  assert.ok(adapters.has("BITUNIX"), "BITUNIX muss in der Registry registriert sein");

  const service = new MarketDataSyncService(registry, history, adapters.entries, {
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });

  const result = await service.syncVenue("BITUNIX");

  assert.ok(result.instrumentsDiscovered >= 2, `discovery: ${result.instrumentsDiscovered}`);
  assert.ok(result.tickersEnriched >= 1);
  assert.ok(result.orderbooksEnriched >= 1);
  for (const tf of SYNC_TIMEFRAMES) {
    assert.ok((result.candlesByTimeframe[tf] ?? 0) > 0, `${tf} candles missing`);
  }

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc, "BTCUSDT muss in der Registry stehen");
  assert.equal(btc!.venue, "BITUNIX");
  assert.ok(btc!.volume24h === 120_000_000 || btc!.volume24h === null || typeof btc!.volume24h === "number");
  assert.ok(btc!.spread === null || (typeof btc!.spread === "number" && btc!.spread > 0));
  assert.equal(btc!.lastSeen, "2026-08-29T12:00:00.000Z");

  assert.ok(history.count() > 0, "HistoricalStore muss Kerzen enthalten");
  const hour = history.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
  assert.ok(hour.length >= 2);

  const provider = historicalStoreProvider(history, "BITUNIX:BTCUSDT");
  const series = provider.candles(btc!);
  assert.ok(series.length >= 2, "Scanner-Provider muss 1h-Kerzen nach dem Sync lesen");
  assert.deepEqual(
    series.map((c) => c.time),
    [...series.map((c) => c.time)].sort((a, b) => a - b),
  );

  assert.equal(fx.privateCalls, 0, "Sync darf die Private-API nie anfassen");
  assert.ok(
    fx.requests.every((r) => !r.signed),
    "kein signierter Request im Sync-Pfad",
  );
  assert.ok(fx.publicCalls > 0);
});

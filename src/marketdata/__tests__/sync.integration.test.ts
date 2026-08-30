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
import { BITUNIX_PATHS } from "../../brokers/bitunix/config";
import { HistoricalStore } from "../../lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../universe/registry";
import { createAdapterRegistry } from "../adapterRegistry";
import { syncErrorsToDataErrors } from "../dataErrors";
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
  assert.equal(btc!.lastSeen, "2026-08-29T12:00:00.000Z");

  // FEHLER-3: Nach dem Sync muss mindestens ein Instrument BEIDE dynamischen
  // Metriken tragen — 24h-Volumen (Ticker) UND Orderbook-Spread (`/depth`).
  // `spread !== null` ist hier die eigentliche Funnel-Garantie: ohne sie
  // scheitert jedes Instrument an der `max-spread`-Regel.
  const enriched = registry.query().items.filter((i) => (i.volume24h ?? 0) > 0 && i.spread !== null);
  assert.ok(enriched.length >= 1, "mind. ein Instrument mit volume24h > 0 UND spread !== null erwartet");
  assert.ok((btc!.volume24h ?? 0) > 0, `volume24h erwartet > 0, war ${btc!.volume24h}`);
  assert.equal(btc!.volume24h, 120_000_000, "volume24h stammt aus ticker.quoteVol des Fixtures");
  assert.ok(btc!.spread !== null, "spread muss aus dem /depth-Snapshot berechnet sein");
  // Fixture-Book 64999/65001 → (65001 − 64999) / 65000
  assert.ok(Math.abs(btc!.spread! - 2 / 65_000) < 1e-12, `unerwarteter Spread ${btc!.spread}`);

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
  // Security Audit: Public-Endpoints (Discovery/Ticker/Depth/Kline) brauchen
  // keine Credentials — es darf kein Auth-Header mitgesendet werden.
  assert.ok(
    fx.requests.every((r) => r.credentialHeaders.length === 0),
    `Public-Calls senden Credentials: ${JSON.stringify(
      fx.requests.filter((r) => r.credentialHeaders.length > 0).map((r) => [r.path, r.credentialHeaders]),
    )}`,
  );
  const depthCalls = fx.requests.filter((r) => r.path === BITUNIX_PATHS.depth);
  assert.ok(
    depthCalls.length >= result.instrumentsDiscovered,
    `1 depth-Call je Instrument erwartet, war ${depthCalls.length}`,
  );
  assert.ok(fx.publicCalls > 0);
});

test("Integration: 429 im Mock-HTTP-Kline-Pfad → SyncResult.errors, Rest-Sync läuft weiter", async () => {
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  // Nur der Kline-Endpunkt wird rate-limited — Discovery/Ticker/Depth bleiben
  // erreichbar, damit der übrige Sync beobachtbar weiterläuft.
  fx.klineStatus = 429;

  const dir = tmp();
  const registry = new InstrumentRegistry({
    dir,
    autoSave: true,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  const history = new HistoricalStore(path.join(dir, "history"));
  const adapters = createAdapterRegistry({ registry, env: fixtureEnv(base) });
  const service = new MarketDataSyncService(registry, history, adapters.entries, {
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });

  const result = await service.syncVenue("BITUNIX");

  // FEHLER-1: Ein einzelner API-Fehler isoliert pro Instrument/Timeframe in
  // SyncResult.errors — kein globaler Abbruch.
  assert.ok(result.errors.length > 0, "429 muss als Sync-Fehler sichtbar sein");
  assert.ok(
    result.errors.some((e) => e.stage === "candles" && e.reason === "RATE_LIMITED" && e.httpStatus === 429),
    `erwartet einen klassifizierten Candle-429-Fehler: ${JSON.stringify(result.errors.slice(0, 2))}`,
  );
  const dataErrors = syncErrorsToDataErrors(result.errors);
  assert.equal(dataErrors.get("BITUNIX:BTCUSDT"), "RATE_LIMITED");
  assert.equal(dataErrors.get("BITUNIX:ETHUSDT"), "RATE_LIMITED");

  // Restlicher Sync bleibt vollständig: Enrichment + Registry laufen weiter.
  assert.ok(result.tickersEnriched >= 1);
  assert.ok(result.orderbooksEnriched >= 1);
  assert.ok(registry.get("BITUNIX:BTCUSDT"), "BTCUSDT bleibt in der Registry");
  assert.ok(registry.get("BITUNIX:ETHUSDT"), "ETHUSDT bleibt in der Registry");
  for (const tf of SYNC_TIMEFRAMES) {
    assert.equal(result.candlesByTimeframe[tf], 0, `${tf} darf bei 429 nicht als Erfolg gezählt werden`);
  }
  assert.ok(
    fx.requests.some((r) => r.path === BITUNIX_PATHS.kline),
    "Kline-Pfad wurde aufgerufen",
  );
  assert.equal(fx.privateCalls, 0);
});

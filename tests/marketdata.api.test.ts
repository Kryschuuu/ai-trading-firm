/**
 * API-Tests (Task 03) — `GET /api/marketdata/snapshot` + `/status`.
 * Read-only, gegen lokalen Fixture-Server (kein echtes Netz).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarketDataManager } from "../src/lib/marketdata/manager";
import { setProductionMarketDataManagerForTests } from "../src/lib/marketdata/production";
import { GET as snapshotGET } from "../src/app/api/marketdata/snapshot/route";
import { GET as statusGET } from "../src/app/api/marketdata/status/route";
import { clearFailoverAuditForTests } from "../src/lib/marketdata/failover";
import { MarketFixtureServer } from "./fixtures/marketFixtureServer";
import { testConfig, tempStore } from "./fixtures/marketdataTestUtil";

let server: MarketFixtureServer;
let baseUrl: string;

beforeEach(async () => {
  clearFailoverAuditForTests();
  server = new MarketFixtureServer();
  baseUrl = await server.start();
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const manager = new MarketDataManager({
    config: testConfig(baseUrl, baseUrl),
    store: tempStore(),
  });
  setProductionMarketDataManagerForTests(manager);
});

afterEach(async () => {
  await server.stop();
});

test("GET /api/marketdata/snapshot liefert normalisierten Snapshot (Modus B)", async () => {
  const res = await snapshotGET(new Request(`${baseUrl}/api/marketdata/snapshot?instrument=BTC`));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    snapshot: { last: number; bid: number; ask: number; source: string; spread: number };
    paperMode: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.snapshot.last, 67451);
  assert.equal(body.snapshot.bid, 67450);
  assert.equal(body.snapshot.ask, 67453);
  assert.equal(body.snapshot.source, "binance");
  assert.equal(body.paperMode, "broker-market-data");
});

test("GET /api/marketdata/snapshot: fehlender Parameter → 400", async () => {
  const res = await snapshotGET(new Request(`${baseUrl}/api/marketdata/snapshot`));
  assert.equal(res.status, 400);
});

test("GET /api/marketdata/snapshot: unbekanntes Instrument → 400", async () => {
  const res = await snapshotGET(new Request(`${baseUrl}/api/marketdata/snapshot?instrument=NOSUCH123`));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "UNKNOWN_INSTRUMENT");
});

test("GET /api/marketdata/status liefert Quelle, Cache-TTL, paperMode", async () => {
  const res = await statusGET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    status: { paperMode: string; activeSource: string; cacheTtlMs: number; staticFallbackEnabled: boolean };
  };
  assert.equal(body.ok, true);
  assert.equal(body.status.paperMode, "broker-market-data");
  assert.equal(body.status.staticFallbackEnabled, false);
  assert.ok(body.status.cacheTtlMs > 0);
});

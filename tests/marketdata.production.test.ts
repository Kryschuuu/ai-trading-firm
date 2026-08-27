/**
 * Produktions-Verdrahtung (Task 03) — wirePaperExecution + getProductionMarketDataManager.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarketDataManager } from "../src/lib/marketdata/manager";
import {
  getProductionMarketDataManager,
  setProductionMarketDataManagerForTests,
  wirePaperExecution,
  createPaperExecution,
} from "../src/lib/marketdata/production";
import { PaperBroker } from "../src/lib/broker";
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
});
afterEach(async () => { await server.stop(); });

test("getProductionMarketDataManager liefert Manager im Default-Modus (Modus B)", () => {
  const m = getProductionMarketDataManager();
  assert.ok(m instanceof MarketDataManager);
  assert.equal(m.config.paperMode, "broker-market-data");
});

test("wirePaperExecution injiziert den Ausführungs-Adapter (idempotent)", () => {
  const manager = new MarketDataManager({ config: testConfig(baseUrl, baseUrl), store: tempStore() });
  setProductionMarketDataManagerForTests(manager);
  const broker = new PaperBroker(10000);
  wirePaperExecution(broker);
  assert.equal(broker.hasExecution(), true);
  wirePaperExecution(broker); // zweiter Aufruf ändert nichts
  assert.equal(broker.hasExecution(), true);
});

test("createPaperExecution: NO_QUOTE ohne Cache, Fill nach getSnapshot", async () => {
  const manager = new MarketDataManager({ config: testConfig(baseUrl, baseUrl), store: tempStore() });
  const exec = createPaperExecution(manager);

  // ohne Cache → kein Quote
  assert.equal(exec.quoteProvider("BTC"), null);

  await manager.getSnapshot("BTC");
  const q = exec.quoteProvider("BTC");
  assert.ok(q && q.bid > 0 && q.ask > 0);
});

/**
 * Integrationstests (Task 03) — Modus B gegen lokalen Fixture-Server.
 * Echter Kursfluss über Feeds, kein echtes Netz. Failover-Kette + Audit,
 * Stale-Kurs-Verwerfen.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarketDataManager } from "../src/lib/marketdata/manager";
import { clearFailoverAuditForTests, readFailoverAudit } from "../src/lib/marketdata/failover";
import { MarketFixtureServer } from "./fixtures/marketFixtureServer";
import { testConfig, tempStore, FixtureBrokerAdapter } from "./fixtures/marketdataTestUtil";

let server: MarketFixtureServer;
let baseUrl: string;

beforeEach(async () => {
  clearFailoverAuditForTests();
  server = new MarketFixtureServer();
  baseUrl = await server.start();
});

afterEach(async () => {
  await server.stop();
});

test("Modus B: echte Kurse fließen vom Fixture-Feed (kein Netz)", async () => {
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore() });

  const snap = await manager.getSnapshot("PAPER:BTC");
  assert.equal(snap.source, "binance");
  assert.equal(snap.venue, "BINANCE");
  assert.equal(snap.last, 67451);
  assert.equal(snap.bid, 67450);
  assert.equal(snap.ask, 67453);
  assert.ok(snap.spread > 0);
  assert.equal(manager.store.count("PAPER:BTC"), 1, "Snapshot wird append-only gespeichert");
});

test("Modus B: Broker-Feed ist primäre Quelle, wenn er liefert", async () => {
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const broker = new FixtureBrokerAdapter({ BTC: 70000 });
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore(), brokerAdapter: broker });

  const snap = await manager.getSnapshot("BTC");
  assert.equal(snap.source, "broker");
  assert.equal(snap.venue, "PAPER");
  assert.equal(snap.last, 70000);
  assert.equal(manager.status().activeSource, "broker:PAPER");
});

test("Failover: Broker-Feed-Ausfall → unabhängiger Feed + Audit-Eintrag", async () => {
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const broker = new FixtureBrokerAdapter({ BTC: 70000 });
  broker.state = "fail";
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore(), brokerAdapter: broker });

  const snap = await manager.getSnapshot("BTC");
  assert.equal(snap.source, "binance", "Failover auf Binance");
  assert.equal(snap.last, 67451);

  const audit = readFailoverAudit(10);
  assert.ok(audit.some((e) => e.fromFeed === "broker:PAPER" && e.toFeed === "binance"), "Audit-Eintrag FEED_FAILOVER");
});

test("Stale-Kurs wird verworfen und Failover ausgelöst", async () => {
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const broker = new FixtureBrokerAdapter({ BTC: 70000 });
  broker.state = "stale"; // liefert einen veralteten ts
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore(), brokerAdapter: broker });

  const snap = await manager.getSnapshot("BTC");
  assert.equal(snap.source, "binance", "staler Broker-Kurs verworfen → Binance");
  const audit = readFailoverAudit(10);
  assert.ok(audit.some((e) => e.reason.startsWith("anomaly:")), "Anomalie (stale) auditiert");
});

test("Synthetic NUR explizit: ohne Flag verweigert (kein stiller Fallback)", async () => {
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
  const broker = new FixtureBrokerAdapter({ BTC: 70000 });
  broker.state = "fail";
  server.setFail("/api/v3/", true); // auch unabhängiger Feed weg
  const config = testConfig(baseUrl, baseUrl, { allowSyntheticFallback: false });
  const manager = new MarketDataManager({ config, store: tempStore(), brokerAdapter: broker });

  await assert.rejects(
    () => manager.getSnapshot("BTC"),
    /keine Feed|FETCH|HTTP 503/
  );
  // Es darf NICHT still auf Synthetic gewechselt werden.
});

test("Synthetic mit Flag: expliziter Offline-Fallback funktioniert", async () => {
  server.setFail("/api/v3/", true);
  const broker = new FixtureBrokerAdapter({ BTC: 70000 });
  broker.state = "fail";
  const config = testConfig(baseUrl, baseUrl, { allowSyntheticFallback: true, seed: 7 });
  const manager = new MarketDataManager({ config, store: tempStore(), brokerAdapter: broker });

  const snap = await manager.getSnapshot("BTC");
  assert.equal(snap.source, "synthetic");
  assert.ok(snap.last > 0);
});

test("Modus A (synthetic): deterministischer Kursfluss", async () => {
  const config = testConfig(baseUrl, baseUrl, { paperMode: "synthetic", seed: 99, staleAfterMs: 0 });
  const manager = new MarketDataManager({ config, store: tempStore() });

  const s1 = await manager.getSnapshot("PAPER:BTC");
  const s2 = await manager.getSnapshot("PAPER:BTC");
  assert.equal(s1.source, "synthetic");
  assert.ok(s1.last > 0);
  assert.notEqual(s1.last, s2.last, "Random-Walk schreitet voran");
});

/**
 * Broker-Integration (Task 03) — Modus B über den PaperBroker.
 * Echte Kurse (Fixture) fließen durch den deterministischen Fill-Simulator
 * in das Paperbuch (Gebühren, Spread, Slippage).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarketDataManager } from "../src/lib/marketdata/manager";
import { createPaperExecution } from "../src/lib/marketdata/production";
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

afterEach(async () => {
  await server.stop();
});

test("Modus B: Broker-Fill nutzt echten Kurs + Gebühren aus Registry", async () => {
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore() });
  await manager.getSnapshot("BTC"); // Cache warmlaufen lassen (echter Kurs)

  const exec = createPaperExecution(manager);
  const broker = new PaperBroker(10000, exec);

  const fill = broker.submit({
    symbol: "BTC",
    side: "LONG",
    qty: 0.02,
    riskNotional: 1349,
    stopLoss: 60000,
    takeProfit: 75000,
  });

  assert.equal(fill.status, "FILLED");
  assert.ok(fill.fillPrice > 67450, "Fill am Ask (+Slippage), nicht darunter");
  assert.ok((fill.fees ?? 0) > 0, "Gebühren abgezogen");
  assert.equal(broker.openPositions, 1);
  const pos = broker.getPosition("BTC");
  assert.equal(pos?.qty, 0.02);
});

test("Modus B: fehlender Kurs → NO_QUOTE (kein statisches Buch)", () => {
  // Cache ist leer und kein Feed erreichbar (Binance-Fixture hat kein Preis
  // für ein unbekanntes Symbol) → Order wird abgelehnt, nicht geraten.
  const config = testConfig(baseUrl, baseUrl);
  const manager = new MarketDataManager({ config, store: tempStore() });
  const exec = createPaperExecution(manager);
  const broker = new PaperBroker(10000, exec);

  const fill = broker.submit({
    symbol: "BTC",
    side: "LONG",
    qty: 0.02,
    riskNotional: 1349,
    stopLoss: 60000,
    takeProfit: 75000,
  });
  assert.equal(fill.status, "REJECTED");
  assert.match(fill.reason ?? "", /NO_QUOTE/);
});

test("Modus B: Partial Fill erscheint im Paperbuch (gefüllte Menge < gewünschte)", async () => {
  const config = testConfig(baseUrl, baseUrl, {
    seed: 5,
    staleAfterMs: 1,
  });
  const manager = new MarketDataManager({ config, store: tempStore() });
  await manager.getSnapshot("BTC");

  const exec = createPaperExecution(manager);
  const broker = new PaperBroker(10000, exec);

  // Partial Fills explizit aktivieren
  manager.config.simulator.partialFillEnabled = true;
  manager.config.simulator.partialFillMaxFraction = 0.5;

  const fill = broker.submit({
    symbol: "BTC",
    side: "LONG",
    qty: 0.02,
    riskNotional: 1349,
    stopLoss: 60000,
    takeProfit: 75000,
  });
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.partial, true, "Partial Fill markiert");
  assert.ok(fill.qty < 0.02, "nur ein Teil der Menge gefüllt");
});

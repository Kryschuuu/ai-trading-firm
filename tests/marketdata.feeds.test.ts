/**
 * Feed-Tests (Task 03) — Yahoo, Broker, Synthetic, Binance direkt.
 * Gegen lokalen Fixture-Server (kein echtes Netz).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MarketInstrument } from "../src/universe/types";
import { YahooFeed } from "../src/lib/marketdata/feeds/yahoo";
import { BrokerFeed } from "../src/lib/marketdata/feeds/brokerFeed";
import { SyntheticFeed } from "../src/lib/marketdata/feeds/synthetic";
import { BinanceFeed } from "../src/lib/marketdata/feeds/binance";
import { FeedNotSupportedError } from "../src/lib/marketdata/types";
import { MarketFixtureServer } from "./fixtures/marketFixtureServer";
import { FixtureBrokerAdapter } from "./fixtures/marketdataTestUtil";

let server: MarketFixtureServer;
let baseUrl: string;

const spy: MarketInstrument = {
  id: "PAPER:SPY", venue: "PAPER", symbol: "SPY", base: null, quote: "USD",
  assetClass: "etf", marketType: "spot", status: "active", minQuantity: 0.001,
  priceStep: 0.01, quantityStep: 0.001, makerFee: 0, takerFee: 0,
  leverageAvailable: false, shortAvailable: true, paperAvailable: true, liveTradable: false, liveAvailable: false,
  volume24h: null, spread: null, volatility: null, lastSeen: "2026-08-27T00:00:00.000Z",
};

const btc: MarketInstrument = {
  id: "PAPER:BTC", venue: "PAPER", symbol: "BTC", base: "BTC", quote: "USD",
  assetClass: "crypto", marketType: "spot", status: "active", minQuantity: 0.00001,
  priceStep: 0.01, quantityStep: 0.00001, makerFee: 0.0004, takerFee: 0.001,
  leverageAvailable: false, shortAvailable: false, paperAvailable: true, liveTradable: false, liveAvailable: false,
  volume24h: 2_000_000_000, spread: 0.0004, volatility: null, lastSeen: "2026-08-27T00:00:00.000Z",
};

beforeEach(async () => {
  server = new MarketFixtureServer();
  baseUrl = await server.start();
  server.setPrice("SPY", { bid: 510, ask: 510.2, last: 510.1, volume24h: 100_000_000 });
  server.setPrice("BTCUSDT", { bid: 67450, ask: 67453, last: 67451, volume24h: 1_000_000_000 });
});
afterEach(async () => { await server.stop(); });

test("YahooFeed: getTicker liefert Snapshot (etf), getCandles liefert Kerzen", async () => {
  const yahoo = new YahooFeed({ baseUrl, allowedHosts: ["127.0.0.1"] });
  const snap = await yahoo.getTicker(spy);
  assert.equal(snap.source, "yahoo");
  assert.equal(snap.symbol, "SPY");
  assert.equal(snap.last, 510.1);
  assert.ok(snap.ask > snap.bid);
  const candles = await yahoo.getCandles(spy, "1d", 10);
  assert.ok(Array.isArray(candles));
  assert.equal(candles.length, 1);
});

test("YahooFeed: bedient keine Krypto → FeedNotSupportedError", async () => {
  const yahoo = new YahooFeed({ baseUrl, allowedHosts: ["127.0.0.1"] });
  await assert.rejects(() => yahoo.getTicker(btc), FeedNotSupportedError);
});

test("BinanceFeed: getTicker + getCandles gegen Fixture", async () => {
  const binance = new BinanceFeed({ baseUrl, allowedHosts: ["127.0.0.1"] });
  const snap = await binance.getTicker(btc);
  assert.equal(snap.source, "binance");
  assert.equal(snap.symbol, "BTCUSDT");
  assert.equal(snap.bid, 67450);
  const candles = await binance.getCandles(btc, "1m", 5);
  assert.equal(candles.length, 1);
});

test("BinanceFeed: kein Krypto → FeedNotSupportedError", async () => {
  const binance = new BinanceFeed({ baseUrl, allowedHosts: ["127.0.0.1"] });
  await assert.rejects(() => binance.getTicker(spy), FeedNotSupportedError);
});

test("BrokerFeed: getCandles ohne Adapter-Capability → FeedNotSupportedError", async () => {
  // FixtureBrokerAdapter hat marketData, aber kein getCandles.
  const broker = new BrokerFeed(new FixtureBrokerAdapter({ SPY: 510 }));
  await assert.rejects(() => broker.getCandles(spy, "1d", 10), FeedNotSupportedError);
});

test("BrokerFeed: Adapter ohne marketData-Capability → getTicker FeedNotSupportedError", async () => {
  const noData = new FixtureBrokerAdapter({ SPY: 510 });
  noData.capabilities.marketData = false;
  const broker = new BrokerFeed(noData);
  await assert.rejects(() => broker.getTicker(spy), FeedNotSupportedError);
});

test("SyntheticFeed: gleiche Seed → identische Kursfolge", async () => {
  const a = new SyntheticFeed({ seed: 1, basePrice: 100 });
  const b = new SyntheticFeed({ seed: 1, basePrice: 100 });
  for (let i = 0; i < 5; i++) {
    const sa = a.snapshot(btc);
    const sb = b.snapshot(btc);
    assert.equal(sa.last, sb.last);
    assert.equal(sa.bid, sb.bid);
  }
});

test("SyntheticFeed: deterministischer Basis-Preis ohne Angabe", () => {
  const a = new SyntheticFeed({ seed: 3 });
  const b = new SyntheticFeed({ seed: 3 });
  const sa = a.snapshot(btc);
  const sb = b.snapshot(btc);
  assert.equal(sa.last, sb.last);
});

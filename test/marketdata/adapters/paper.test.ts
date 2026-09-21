/**
 * PAPER-Spiegel — Tests (Routing + Delegation + Funnel).
 *
 * Coverage: Krypto ⇒ Binance-Bein (USDT-Suffix, Rückbeschriftung, `source`),
 * Rest ⇒ Yahoo-Bein, Bulk über beide Beine in Eingangsreihenfolge, Discovery
 * aus dem kuratierten Schnitt, unbekannte Symbole ⇒ INVALID_SYMBOL ohne
 * Request, keine Credentials.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { SyncVenuesFixtureServer } from "../../../tests/fixtures/syncVenuesFixtureServer";
import { classifyMarketDataError } from "../../../src/lib/marketDataErrors";
import { BinanceSyncClient } from "../../../src/marketdata/adapters/binance";
import { SyncHttpClient } from "../../../src/marketdata/adapters/http";
import {
  PAPER_MARKET_DATA_VENUE,
  createPaperMarketDataAdapter,
  paperToBinanceSymbol,
} from "../../../src/marketdata/adapters/paper";
import { YahooSyncClient } from "../../../src/marketdata/adapters/yahoo";
import type { InstrumentInput } from "../../../src/universe/types";
import type { MarketDataAdapter } from "../../../src/marketdata/sync";

const servers: SyncVenuesFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

function inputs(): InstrumentInput[] {
  return [
    { venue: "PAPER", symbol: "BTC", base: "BTC", quote: "USD", assetClass: "crypto" },
    { venue: "PAPER", symbol: "AAPL", base: null, quote: "USD", assetClass: "equity" },
    { venue: "PAPER", symbol: "EURUSD=X", base: "EUR", quote: "USD", assetClass: "fx" },
  ];
}

async function harness() {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const adapter = createPaperMarketDataAdapter({
    binance: new BinanceSyncClient(new SyncHttpClient({ baseUrl: base })),
    yahoo: new YahooSyncClient(new SyncHttpClient({ baseUrl: base })),
    instruments: inputs(),
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return { fx, adapter };
}


/** Bulk-Zugriff mit hartem Setup-Fehler statt `possibly undefined`. */
function bulkOf(adapter: MarketDataAdapter): NonNullable<MarketDataAdapter["getTickers"]> {
  assert.ok(adapter.getTickers, "Adapter ohne Bulk (Test-Setup)");
  return adapter.getTickers;
}

test("paperToBinanceSymbol: Base + USDT (idempotent)", () => {
  assert.equal(paperToBinanceSymbol("BTC", "BTC"), "BTCUSDT");
  assert.equal(paperToBinanceSymbol("BTC", null), "BTCUSDT");
  assert.equal(paperToBinanceSymbol("BTCUSDT", "BTCUSDT"), "BTCUSDT");
  assert.equal(PAPER_MARKET_DATA_VENUE, "PAPER");
});

test("Funnel: Discovery (PAPER-IDs) + Bein-Routing", async () => {
  const { fx, adapter } = await harness();

  const instruments = await adapter.discoverInstruments();
  assert.deepEqual(
    instruments.map((i) => i.id).sort(),
    ["PAPER:AAPL", "PAPER:BTC", "PAPER:EURUSD=X"],
  );
  assert.ok(instruments.every((i) => i.venue === "PAPER"));

  // Krypto-Bein: Binance-Request mit USDT-Suffix, Antwort als PAPER:BTC.
  const btc = await adapter.getTicker("BTC");
  assert.equal(btc.symbol, "BTC");
  assert.equal(btc.source, "paper:binance");
  assert.ok((btc.quoteVol ?? 0) > 0);
  const depthReq = fx.requests.find((r) => r.path === "/api/v3/ticker/24hr");
  assert.equal(depthReq!.query.symbol, "BTCUSDT");

  // Yahoo-Bein: AAPL direkt, EURUSD=X as-is.
  const aapl = await adapter.getTicker("AAPL");
  assert.equal(aapl.symbol, "AAPL");
  assert.equal(aapl.source, "paper:yahoo");
  const fxTicker = await adapter.getTicker("EURUSD=X");
  assert.equal(fxTicker.symbol, "EURUSD=X");

  // Orderbook je Bein (BTC ⇒ Binance-Depth, AAPL ⇒ Quote-Cache).
  const btcBook = await adapter.getOrderBook("BTC");
  assert.equal(btcBook.symbol, "BTC");
  assert.ok(btcBook.bids.length > 0 && btcBook.asks.length > 0);
  const aaplBook = await adapter.getOrderBook("AAPL");
  assert.ok(aaplBook.bids.length === 1 && aaplBook.asks.length === 1);

  // Kerzen je Bein.
  assert.equal((await adapter.getCandles("BTC", "1h", 61)).length, 61);
  assert.equal((await adapter.getCandles("AAPL", "1h", 61)).length, 61);

  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Bulk über beide Beine: je ein Bulk-Call, Ergebnis in Eingangsreihenfolge", async () => {
  const { fx, adapter } = await harness();
  const bulk = await bulkOf(adapter)(["EURUSD=X", "BTC", "AAPL"]);
  assert.deepEqual(
    bulk.map((t) => t.symbol),
    ["EURUSD=X", "BTC", "AAPL"],
  );
  assert.deepEqual(
    bulk.map((t) => t.source),
    ["paper:yahoo", "paper:binance", "paper:yahoo"],
  );
  assert.equal(fx.count("/api/v3/ticker/24hr"), 1, "ein Binance-Bulk");
  assert.equal(fx.count("/v7/finance/quote"), 1, "ein Yahoo-Bulk");
});

test("unbekanntes Symbol ⇒ INVALID_SYMBOL ohne Request", async () => {
  const { fx, adapter } = await harness();
  const before = fx.requests.length;
  const err = (await adapter.getTicker("NOPE").then(
    () => null,
    (e: unknown) => e,
  )) as Error;
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "INVALID_SYMBOL");
  assert.equal(r.retryable, false);
  assert.equal(fx.requests.length, before, "kein Request für unbekannte Symbole");
});

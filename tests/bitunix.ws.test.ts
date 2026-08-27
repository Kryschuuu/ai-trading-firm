/**
 * Bitunix Public-WS: Ingest, Snapshot-Delta, Reconnect/Resubscribe, SSRF.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { backoffMs, BitunixPublicWs, klineChannel, type WsLike } from "../src/brokers/bitunix/ws";

class FakeWs implements WsLike {
  sent: string[] = [];
  listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  readyState = 1;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

function cfg(over: Record<string, string> = {}) {
  return loadBitunixConfig({
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_WS_URL: "ws://127.0.0.1:9/public/",
    ...over,
  });
}

test("klineChannel + backoffMs", () => {
  assert.equal(klineChannel("1m"), "market_kline_1min");
  assert.equal(klineChannel("1h"), "market_kline_60min");
  assert.equal(klineChannel("99x"), "market_kline_99x");
  assert.equal(backoffMs(1), 500);
  assert.equal(backoffMs(6), 8000);
  assert.equal(backoffMs(99), 8000);
});

test("ingest: Ticker-Replace und Kline-Delta gleicher time", () => {
  const ticks: number[] = [];
  const ws = new BitunixPublicWs({
    config: cfg(),
    open: () => new FakeWs(),
    handlers: { onTicker: (t) => ticks.push(t.price) },
  });
  ws.ingest({
    ch: "ticker",
    symbol: "BTCUSDT",
    ts: 1,
    data: { s: "BTCUSDT", la: "65000", markPrice: "65001", q: "1", b: "2", h: "66", l: "64" },
  });
  assert.equal(ws.tickers.get("BTCUSDT")?.price, 65000);
  assert.equal(ws.tickers.get("BTCUSDT")?.markPrice, 65001);
  ws.ingest({ ch: "ticker", data: { s: "BTCUSDT", lastPrice: "65100" } });
  assert.equal(ws.tickers.get("BTCUSDT")?.price, 65100);
  ws.ingest({
    ch: "market_kline_1min",
    symbol: "BTCUSDT",
    data: { t: 100, o: 1, h: 2, l: 0.5, c: 1.5, b: 9 },
  });
  ws.ingest({
    ch: "market_kline_1min",
    symbol: "BTCUSDT",
    data: { t: 100, o: 1, h: 3, l: 0.5, c: 2, b: 11 },
  });
  assert.equal(ws.klines.get("BTCUSDT:market_kline_1min")?.high, 3);
  ws.ingest("not-json");
  ws.ingest(42);
  ws.ingest({ ch: "ticker", data: { la: "0" } });
});

test("Reconnect resubscribed Ticker+Kline (injizierter Backoff)", async () => {
  const sockets: FakeWs[] = [];
  const reconnects: number[] = [];
  const ws = new BitunixPublicWs({
    config: cfg(),
    open: () => {
      const s = new FakeWs();
      sockets.push(s);
      return s;
    },
    backoff: () => 5,
    handlers: { onReconnect: (n) => reconnects.push(n) },
  });
  ws.subscribeTicker("BTCUSDT");
  ws.subscribeKline("BTCUSDT", "1m");
  await ws.start();
  sockets[0].emit("open");
  assert.match(sockets[0].sent[0] ?? "", /subscribe/);
  sockets[0].close();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sockets.length >= 2, `reconnect open, got ${sockets.length}`);
  sockets[sockets.length - 1].emit("open");
  const lastSent = sockets[sockets.length - 1].sent.join(" ");
  assert.match(lastSent, /ticker/);
  assert.match(lastSent, /market_kline_1min/);
  assert.ok(reconnects.length >= 1);
  ws.stop();
});

test("WS-SSRF: fremder Host und ws ohne Insecure-Flag", async () => {
  const evil = new BitunixPublicWs({
    config: loadBitunixConfig({ BITUNIX_WS_URL: "wss://evil.example/" }),
    open: () => new FakeWs(),
  });
  await assert.rejects(() => evil.start(), (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf");
  const plain = new BitunixPublicWs({
    config: loadBitunixConfig({ BITUNIX_WS_URL: "ws://127.0.0.1/public/" }),
    open: () => new FakeWs(),
  });
  await assert.rejects(() => plain.start(), (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf");
  const userinfo = new BitunixPublicWs({
    config: loadBitunixConfig({ BITUNIX_WS_URL: "wss://user:pass@fapi.bitunix.com/public/" }),
    open: () => new FakeWs(),
  });
  await assert.rejects(() => userinfo.start(), (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf");
  const ws = new BitunixPublicWs({
    config: cfg(),
    open: () => new FakeWs(),
  });
  ws.ingest(JSON.stringify({ ch: "ticker", data: { s: "ETHUSDT", last: "3300" } }));
  assert.equal(ws.tickers.get("ETHUSDT")?.price, 3300);
});

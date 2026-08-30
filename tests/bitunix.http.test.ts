/**
 * Bitunix HTTP/REST: Public-Client gegen Fixture, Private-Signatur,
 * SSRF-Allowlist, Token-Bucket. Kein echtes Netzwerk.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BitunixFixtureServer } from "./fixtures/bitunixFixtureServer";
import { loadBitunixConfig, BITUNIX_PATHS } from "../src/brokers/bitunix/config";
import { BitunixPublicClient } from "../src/brokers/bitunix/publicClient";
import { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { assertUrlAllowed, TokenBucket } from "../src/brokers/bitunix/http";
import { serializePlaceOrder } from "../src/brokers/bitunix/orders";
import { clearBitunixPrivateAuditForTests, readBitunixPrivateAudit } from "../src/brokers/bitunix/audit";

const servers: BitunixFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

async function started(): Promise<{ fx: BitunixFixtureServer; base: string }> {
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  return { fx, base };
}

function cfg(base: string, extra: Record<string, string> = {}) {
  return loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: base,
    BITUNIX_RETRY_MAX: "1",
    ...extra,
  });
}

test("Public REST: trading_pairs / ticker / kline / depth (Fixture)", async () => {
  const { fx, base } = await started();
  const client = new BitunixPublicClient({ config: cfg(base) });
  const pairs = await client.fetchTradingPairs();
  assert.ok(pairs.some((p) => p.id === "BITUNIX:BTCUSDT" && p.marketType === "perpetual"));
  assert.ok(pairs.every((p) => p.symbol !== "??"));
  const ticker = await client.fetchTicker("BTCUSDT");
  assert.equal(ticker.price, 65000.5);
  assert.equal(ticker.markPrice, 65001);
  assert.equal(ticker.source, "bitunix");
  assert.equal(ticker.quoteVol, 120000000);
  const klines = await client.fetchKlines("BTCUSDT", "1m", 10);
  assert.equal(klines.length, 2);
  assert.ok(klines[0].time < klines[1].time);
  const book = await client.fetchOrderBook("BTCUSDT", "15");
  assert.equal(book.bids[0].price, 64999);
  assert.equal(book.asks[0].qty, 0.8);
  assert.equal(fx.privateCalls, 0);
  assert.ok(fx.publicCalls >= 4);
});

test("Public REST: Venue-code ≠ 0 und HTTP-Fehler", async () => {
  const { fx, base } = await started();
  fx.failPublic = true;
  const client = new BitunixPublicClient({ config: cfg(base) });
  await assert.rejects(() => client.fetchTickers("BTCUSDT"), BitunixApiError);
  fx.failPublic = false;
  fx.httpStatus = 400;
  await assert.rejects(() => client.fetchTickers("BTCUSDT"), (e: unknown) => {
    assert.ok(e instanceof BitunixApiError);
    assert.equal(e.kind, "unknown");
    return true;
  });
});

test("Private REST: Signatur wird vom Fixture akzeptiert; Audit ohne Secrets", async () => {
  const { fx, base } = await started();
  clearBitunixPrivateAuditForTests();
  const client = new BitunixPrivateClient({
    config: cfg(base),
    credentials: { apiKey: fx.apiKey, apiSecret: fx.apiSecret },
  });
  const acct = await client.getAccount();
  assert.equal(acct.cash, 10000);
  const pos = await client.getPositions();
  assert.equal(pos[0]?.symbol, "BTCUSDT");
  assert.equal(pos[0]?.side, "LONG");
  const placed = await client.placeSerializedOrder(
    serializePlaceOrder({
      symbol: "BTCUSDT",
      side: "LONG",
      qty: 0.01,
      riskNotional: 650,
      stopLoss: 60000,
      takeProfit: 70000,
    })
  );
  assert.equal(placed.orderId, "BX-1");
  assert.equal(fx.privateCalls, 3);
  const audit = readBitunixPrivateAudit(10);
  assert.ok(audit.length >= 3);
  const blob = JSON.stringify(audit);
  assert.ok(!blob.includes(fx.apiKey));
  assert.ok(!blob.includes(fx.apiSecret));
  assert.ok(!blob.includes("sign"));
});

test("Private REST: falsche Signatur → 401 auth, kein Retry-Leak", async () => {
  const { fx, base } = await started();
  const client = new BitunixPrivateClient({
    config: cfg(base),
    credentials: { apiKey: fx.apiKey, apiSecret: "wrong-secret-value" },
  });
  await assert.rejects(() => client.getAccount(), (e: unknown) => {
    assert.ok(e instanceof BitunixApiError);
    assert.equal(e.kind, "auth");
    assert.ok(!e.message.includes("wrong-secret"));
    return true;
  });
  assert.equal(fx.privateCalls, 1);
});

test("SSRF: fremder Host, Userinfo, http ohne Insecure-Flag", () => {
  const prod = loadBitunixConfig({});
  assert.throws(
    () => assertUrlAllowed("https://evil.example/api", prod),
    (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf"
  );
  assert.throws(
    () => assertUrlAllowed("https://user:pass@fapi.bitunix.com/", prod),
    (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf"
  );
  assert.throws(
    () => assertUrlAllowed("http://fapi.bitunix.com/", prod),
    (e: unknown) => e instanceof BitunixApiError && e.kind === "ssrf"
  );
  const loop = loadBitunixConfig({ BITUNIX_ALLOW_INSECURE_HTTP: "true" });
  const ok = assertUrlAllowed("http://127.0.0.1:9/x", loop);
  assert.equal(ok.hostname, "127.0.0.1");
});

test("TokenBucket: take() gibt Tokens frei", async () => {
  const b = new TokenBucket(1000, 2);
  await b.take();
  await b.take();
  const t0 = Date.now();
  await b.take();
  assert.ok(Date.now() - t0 < 2000);
});

test("HTTP: ungültige URL, 5xx-Retry, leere Envelope, fehlender Ticker", async () => {
  const prod = loadBitunixConfig({});
  assert.throws(() => assertUrlAllowed("not-a-url", prod), BitunixApiError);
  const { BitunixHttp } = await import("../src/brokers/bitunix/http");
  let hits = 0;
  const cfgRetry = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: "http://127.0.0.1:9",
    BITUNIX_RETRY_MAX: "2",
    BITUNIX_TIMEOUT_MS: "200",
  });
  const http = new BitunixHttp({
    config: cfgRetry,
    fetchImpl: (async () => {
      hits += 1;
      return new Response(JSON.stringify({ code: 1, msg: "boom" }), { status: 503 });
    }) as typeof fetch,
  });
  await assert.rejects(() => http.request({ method: "GET", path: "/api/v1/futures/market/tickers" }), BitunixApiError);
  assert.equal(hits, 2);

  const emptyPublic = new BitunixPublicClient({
    config: cfgRetry,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => emptyPublic.fetchTicker("BTCUSDT"), BitunixApiError);

  const { fx, base } = await started();
  const priv = new BitunixPrivateClient({
    config: cfg(base),
    credentials: { apiKey: fx.apiKey, apiSecret: fx.apiSecret },
  });
  const pos = await priv.getPositions("BTCUSDT");
  assert.equal(pos.length, 1);
});

test("Payload-Kappe: zu große Antwort wird abgebrochen, nicht erneut angefragt", async () => {
  const cfgCap = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: "http://127.0.0.1:9",
    BITUNIX_RETRY_MAX: "3",
    BITUNIX_TIMEOUT_MS: "4000",
  });
  const { BitunixHttp } = await import("../src/brokers/bitunix/http");
  const isPayloadError = (e: unknown) =>
    e instanceof BitunixApiError && e.kind === "payload" && e.code === "BITUNIX_PAYLOAD";

  // 1) content-length-Vorabfilter: die Bytes werden nie gelesen.
  let declaredHits = 0;
  // Synthetische Response: undicis `new Response()` setzt content-length selbst,
  // der Vorabfilter ist daher nur mit einem manuellen Header-Objekt prüfbar.
  const declared = new BitunixHttp({
    config: cfgCap,
    fetchImpl: (async () => {
      declaredHits += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(6 * 1024 * 1024) }),
        body: null,
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch,
  });
  await assert.rejects(
    () => declared.request({ method: "GET", path: BITUNIX_PATHS.tickers }),
    isPayloadError,
    "content-length über der Kappe muss abbrechen"
  );
  assert.equal(declaredHits, 1, "kein Retry gegen eine zu große Antwort");

  // 2) Chunked Response ohne content-length: die Kappe greift am Stream.
  let streamHits = 0;
  const chunked = new BitunixHttp({
    config: cfgCap,
    fetchImpl: (async () => {
      streamHits += 1;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // 3 × 2 MB ohne content-length — über der 5-MB-Kappe.
          if (sent >= 3) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => chunked.request({ method: "GET", path: BITUNIX_PATHS.tickers }),
    isPayloadError,
    "Stream-Volumen über der Kappe muss abbrechen"
  );
  assert.equal(streamHits, 1, "auch hier: kein Retry");

  // 3) Kleine Antworten bleiben unangetastet.
  const small = new BitunixHttp({
    config: cfgCap,
    fetchImpl: (async () => new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })) as typeof fetch,
  });
  const smallRes = await small.request({ method: "GET", path: BITUNIX_PATHS.tickers });
  assert.deepEqual(smallRes.json, { code: 0, data: [] }, "kleine Antwort bleibt vollständig lesbar");
});

test("Pfade sind die offiziellen Futures-Endpunkte", () => {
  assert.equal(BITUNIX_PATHS.tradingPairs, "/api/v1/futures/market/trading_pairs");
  assert.equal(BITUNIX_PATHS.tickers, "/api/v1/futures/market/tickers");
  assert.equal(BITUNIX_PATHS.kline, "/api/v1/futures/market/kline");
  assert.equal(BITUNIX_PATHS.depth, "/api/v1/futures/market/depth");
  assert.equal(BITUNIX_PATHS.account, "/api/v1/futures/account");
  assert.equal(BITUNIX_PATHS.positions, "/api/v1/futures/position/get_pending_positions");
  assert.equal(BITUNIX_PATHS.placeOrder, "/api/v1/futures/trade/place_order");
});

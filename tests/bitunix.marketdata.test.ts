/**
 * BitunixBrokerAdapter als `MarketDataAdapter` (FEHLER-2: Verdrahtung).
 *
 * Prüft die konkrete Implementierung, die zentrale `AdapterRegistry`
 * (einzige Instanzierungsstelle), die Orderbook-Struktur gegen das
 * `/depth`-Schema, den leeren-Discovery-Edge-Case, die
 * Sync-Kontext-Sicherheit (0 Private-Credentials) und die
 * 429-Retry/Backoff-Regression.
 *
 * Mock-Public-Client: 0 echtes Netz, 0 Credentials, 0 Signaturen.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BitunixBrokerAdapter } from "../src/brokers/bitunix/adapter";
import { BITUNIX_PATHS } from "../src/brokers/bitunix/config";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { TokenBucket } from "../src/brokers/bitunix/http";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../src/universe/registry";
import { createAdapterRegistry } from "../src/marketdata/adapterRegistry";
import { MarketDataSyncService, type MarketDataAdapter } from "../src/marketdata/sync";
import type { MarketOrderBook } from "../src/marketdata/types";
import { createMockBitunixFetch, mockBitunixPublicClient } from "./fixtures/bitunixMockClient";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "bitunix-md-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Test-Env: Bitunix an, keine Credentials — Public-Pfad nur. */
const ENABLED: Record<string, string> = { BITUNIX_ENABLED: "true" };

function tmpRegistry(): InstrumentRegistry {
  return new InstrumentRegistry({ dir: tmp(), autoSave: false });
}

test("bitunix discovery upserts discovered instruments", async () => {
  const registry = tmpRegistry();
  const adapter = new BitunixBrokerAdapter("paper", {
    env: ENABLED,
    publicClient: mockBitunixPublicClient(),
    registry,
  });

  const instruments = await adapter.discoverInstruments();

  assert.ok(instruments.length > 0);
  assert.ok(registry.size > 0);
  assert.ok(registry.get("BITUNIX:BTCUSDT"));
  // Kaputte Fixture-Zeile (`??`) wird vom Venue-Mapper verworfen.
  assert.equal(registry.get("BITUNIX:??"), null);
});

test("BitunixBrokerAdapter erfüllt das MarketDataAdapter-Interface (Compile-Time-Check)", () => {
  const adapter = new BitunixBrokerAdapter("paper", {
    env: ENABLED,
    publicClient: mockBitunixPublicClient(),
    registry: tmpRegistry(),
  });
  // Compile-Time-Check:
  const _typeCheck: MarketDataAdapter = adapter;
  assert.ok(typeof _typeCheck.discoverInstruments === "function");
  assert.ok(typeof _typeCheck.getTicker === "function");
  assert.ok(typeof _typeCheck.getTickers === "function", "Batch-getTickers vorhanden (1× tickers)");
  assert.ok(typeof _typeCheck.getOrderBook === "function");
  assert.ok(typeof _typeCheck.getCandles === "function");
  // Broker-Contract bleibt parallel erfüllt.
  assert.equal(adapter.id, "BITUNIX");
  assert.equal(adapter.mode, "paper");
});

test("adapterRegistry: get(\"BITUNIX\") liefert Instanz, get(\"UNKNOWN\") undefined", () => {
  // Gate ist die ENV-Flag `BITUNIX_ENABLED` (nicht Credentials) — hier
  // explizit gesetzt, damit der Test nicht vom ambienten Prozess-Env abhängt.
  const registry = createAdapterRegistry({ venues: ["BITUNIX"], ignoreEnvGates: true });

  const adapter = registry.get("BITUNIX");
  assert.ok(adapter, "BITUNIX muss registriert sein");
  assert.ok(adapter instanceof BitunixBrokerAdapter);
  assert.equal((adapter as BitunixBrokerAdapter).mode, "paper", "Sync-Kontext läuft IMMER paper");

  assert.equal(registry.get("UNKNOWN"), undefined);
  assert.ok(!registry.has("NOPE"));
  assert.ok(registry.has("bitunix"), "Venue-Keys sind case-insensitiv");
  assert.deepEqual(registry.list(), ["BITUNIX"]);
  assert.deepEqual(registry.known(), ["BITUNIX"]);
  assert.deepEqual(registry.skipped, []);
});

test("getOrderBook() liefert korrekt strukturiertes MarketOrderBook (bids/asks) gegen /depth-Schema", async () => {
  const adapter = new BitunixBrokerAdapter("paper", {
    env: ENABLED,
    publicClient: mockBitunixPublicClient(),
  });

  const book: MarketOrderBook = await adapter.getOrderBook("BTCUSDT");

  assert.equal(book.symbol, "BTCUSDT");
  assert.ok(Array.isArray(book.bids) && book.bids.length >= 2, "bids-Array erwartet");
  assert.ok(Array.isArray(book.asks) && book.asks.length >= 2, "asks-Array erwartet");
  for (const level of [...book.bids, ...book.asks]) {
    assert.ok(Number.isFinite(level.price) && level.price > 0, "Preis muss positiv endliche Zahl sein");
    assert.ok(Number.isFinite(level.qty) && level.qty >= 0, "Qty muss endliche Zahl ≥ 0 sein");
  }
  assert.ok(book.ts > 0, "ts (epoch-ms) gesetzt");
  assert.ok(book.bids[0].price < book.asks[0].price, "Book-Ordner: bid < ask");
});

test("Edge Case: leeres trading_pairs-Array → discoverInstruments() liefert [], kein Crash im Sync-Service", async () => {
  const { fetchImpl } = createMockBitunixFetch({ emptyTradingPairs: true });
  const client = mockBitunixPublicClient({ fetchImpl });
  const registry = tmpRegistry();
  const history = new HistoricalStore(path.join(tmp(), "history"));
  const adapter = new BitunixBrokerAdapter("paper", { env: ENABLED, publicClient: client, registry });

  const instruments = await adapter.discoverInstruments();
  assert.deepEqual(instruments, []);

  const service = new MarketDataSyncService(registry, history, new Map([["BITUNIX", adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.discovered, 0);
  assert.equal(result.tickersEnriched, 0);
  assert.equal(result.orderbooksEnriched, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(registry.size, 0);
  assert.equal(history.count(), 0);
});

test("Sync-Kontext-Sicherheit: AdapterRegistry referenziert keine Private-Credentials", () => {
  // 1) Statisch: Die Instanzierungsstelle kennt weder PrivateClient noch Keys.
  const registrySrc = readFileSync(path.join(process.cwd(), "src/marketdata/adapterRegistry.ts"), "utf8");
  assert.equal(
    /from\s+["'][^"']*privateClient["']|new\s+BitunixPrivateClient|loadBitunixCredentials/i.test(registrySrc),
    false,
    "adapterRegistry darf PrivateClient/Credentials weder importieren noch laden",
  );
  assert.equal(
    /BITUNIX_API_KEY|BITUNIX_API_SECRET/i.test(registrySrc),
    false,
    "adapterRegistry darf keine API-Key/Secret-Env referenzieren",
  );

  // 2) Statisch: Der Scanner kennt keinen konkreten Adapter.
  const scannerDir = path.join(process.cwd(), "src/scanner");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts")) files.push(full);
    }
  };
  walk(scannerDir);
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.equal(
      /BitunixBrokerAdapter|from\s+["'][^"']*brokers\/bitunix[^"']*["']/.test(src),
      false,
      `${path.relative(process.cwd(), f)} importiert keinen konkreten Bitunix-Adapter`,
    );
  }

  // 3) Dynamisch: Discovery/Enrichment laufen ohne jegliche Credentials.
  const registry = createAdapterRegistry({ registry: tmpRegistry(), env: { ...ENABLED } });
  assert.equal((registry.get("BITUNIX") as BitunixBrokerAdapter).mode, "paper");
  assert.equal(process.env.BITUNIX_API_KEY, undefined, "Test-Env trägt ohnehin keine Key");
});

test("Security Audit: /depth (Public) sendet keine Credential-Header", async () => {
  const { fetchImpl, calls } = createMockBitunixFetch();
  const client = mockBitunixPublicClient({ fetchImpl });

  await client.fetchOrderBook("BTCUSDT");
  await client.fetchTickers("BTCUSDT");

  const publicCalls = calls.filter(
    (c) => c.path === BITUNIX_PATHS.depth || c.path === BITUNIX_PATHS.tickers,
  );
  assert.ok(publicCalls.length >= 2, "depth + tickers aufgerufen");
  for (const call of publicCalls) {
    for (const forbidden of ["sign", "api-key", "apikey", "nonce", "timestamp", "authorization", "x-api-key"]) {
      assert.equal(
        call.headers[forbidden],
        undefined,
        `${call.path} darf "${forbidden}" nicht senden — Public-Endpoint ohne Credentials`,
      );
    }
  }
});

test("Rate-Limit-Eskalation: N Depth-Calls laufen über den Token-Bucket (8 req/s), nicht als Burst", async () => {
  const { fetchImpl, calls } = createMockBitunixFetch();
  // Produktions-Default: TokenBucket(publicRatePerSec = 8, burst = 8).
  const client = mockBitunixPublicClient({ fetchImpl });

  const t0 = Date.now();
  for (let i = 0; i < 12; i += 1) await client.fetchOrderBook("BTCUSDT");
  const elapsed = Date.now() - t0;

  assert.equal(
    calls.filter((c) => c.path === BITUNIX_PATHS.depth).length,
    12,
    "alle Depth-Calls kamen an",
  );
  // burst 8 sofort, danach 4 × 125 ms ⇒ ≥ 500 ms; konservativ 400 ms Schwelle.
  assert.ok(elapsed >= 400, `Drosselung fehlt: 12 Calls in ${elapsed} ms (erwartet ≥ 400 ms)`);
});

test("TokenBucket: Burst wird respektiert, danach greift die Rate", async () => {
  const bucket = new TokenBucket(8, 8);
  const burstStart = Date.now();
  for (let i = 0; i < 8; i += 1) await bucket.take();
  const burstMs = Date.now() - burstStart;
  assert.ok(burstMs < 100, `Burst von 8 muss sofort durchgehen (war ${burstMs} ms)`);

  const throttled = Date.now();
  await bucket.take();
  assert.ok(Date.now() - throttled >= 100, "das 9. Token kostet ~125 ms");
});

test("Rate-Limit-Regression: 429 → Retry mit Backoff bleibt erhalten", async () => {
  const { fetchImpl, calls } = createMockBitunixFetch({ depthStatus: 429, depth429BeforeSuccess: 2 });
  const client = mockBitunixPublicClient({ fetchImpl }); // retryMax = 3 (Produktions-Default)

  const t0 = Date.now();
  const book = await client.fetchOrderBook("BTCUSDT");
  const elapsed = Date.now() - t0;

  const depthCalls = calls.filter((c) => c.path === BITUNIX_PATHS.depth);
  assert.equal(depthCalls.length, 3, "2×429 + 1×200");
  assert.ok(book.bids.length >= 2 && book.asks.length >= 2, "nach Retry liefert der Call Daten");
  // Backoff: 200 ms + 400 ms exponentiell — der Client muss tatsächlich warten.
  assert.ok(elapsed >= 400, `Backoff-Verhalten fehlt (nur ${elapsed} ms)`);
});

test("Rate-Limit-Regression: persistente 429 → BitunixApiError(kind=rate-limit), kein auth-Confuse", async () => {
  const { fetchImpl } = createMockBitunixFetch({ depthStatus: 429, depth429BeforeSuccess: 10_000 });
  const client = mockBitunixPublicClient({ fetchImpl });

  await assert.rejects(
    () => client.fetchOrderBook("BTCUSDT"),
    (e: unknown) => {
      assert.ok(e instanceof BitunixApiError);
      assert.equal(e.kind, "rate-limit");
      assert.equal(e.httpStatus, 429);
      return true;
    },
  );
});

test("getCandles() akzeptiert limit-Parameter (MarketDataAdapter-Signatur)", async () => {
  const { fetchImpl, calls } = createMockBitunixFetch();
  const adapter = new BitunixBrokerAdapter("paper", {
    env: ENABLED,
    publicClient: mockBitunixPublicClient({ fetchImpl }),
  });

  const candles = await adapter.getCandles("BTCUSDT", "1h", 150);
  assert.ok(Array.isArray(candles) && candles.length > 0);
  const klineCall = calls.find((c) => c.path === BITUNIX_PATHS.kline);
  assert.ok(klineCall, "kline-Endpunkt aufgerufen");
  assert.equal(klineCall!.query.limit, "150", "limit wird an die API weitergegeben");
  assert.equal(klineCall!.query.interval, "1h");
});

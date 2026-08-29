/**
 * Verhaltenstests des Marktdaten-Pfads (MDERR-006, P1).
 *
 * Beweist die Abgrenzung „echter Fehler wirft typisierten Fehler“ vs.
 * „leere Venue-Antwort ist leeres Array“, Metrik/Lock-Inkrementierung,
 * strukturierte Logs, den bewussten Cache-Fallback mit Staleness sowie die
 * Scanner-Übersetzung in DATA_UNAVAILABLE / Readiness ERROR.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getCandles,
  getCandlesWithFallback,
  resetMarketDataCachesForTests,
  MARKET_DATA_FETCH_ATTEMPTS,
  type Candle,
} from "../src/lib/marketData";
import { MarketDataFetchError } from "../src/lib/marketDataErrors";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";
import { resetTelemetryForTests, marketDataFailureSnapshot } from "../src/lib/telemetry";
import { saveMarketDataErrors, loadMarketDataErrors } from "../src/marketdata/dataErrors";
import { scanUniverse } from "../src/scanner/pipeline";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/config";
import { instrument } from "./fixtures/scannerFixtures";

// ── Test-Umgebung ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realNow = Date.now;

let logs: StructuredLogEntry[] = [];

function mockFetchOnce(impl: (url: string, init?: RequestInit) => Promise<unknown> | unknown): void {
  globalThis.fetch = impl as typeof fetch;
}

function httpResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function okCandles(count = 5): Candle[] {
  const out: Candle[] = [];
  const start = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    out.push({
      time: start + i * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + i,
      volume: 1000,
    });
  }
  return out;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  resetMarketDataCachesForTests();
  resetTelemetryForTests();
  setStructuredLogSinkForTests(null);
  logs = [];
});

// ── 1) Fehler sind beobachtbar ──────────────────────────────────────────────

test("1: market data failure is observable", async () => {
  mockFetchOnce(() => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  });
  await assert.rejects(() => getCandles("BTC", "15m", 150), MarketDataFetchError);
});

test("2: empty upstream response returns empty array without throwing (Abgrenzung)", async () => {
  // Binance liefert `[]` → nachweislich keine Bars, KEIN Fehler.
  mockFetchOnce(() => httpResponse(200, []));
  const candles = await getCandles("BTC", "15m", 150);
  assert.deepEqual(candles, []);
});

test("3: failure increments telemetry counter with classified reason", async () => {
  mockFetchOnce(() => httpResponse(429, {}));
  await assert.rejects(() => getCandles("BTC", "15m", 150), MarketDataFetchError);
  const snap = marketDataFailureSnapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.byReason["RATE_LIMITED"], 1);
  assert.equal(snap.byVenue["binance"], 1);
  assert.equal(snap.byTimeframe["15m"], 1);
  assert.ok(!JSON.stringify(snap).includes("BTCUSDT"), "Metrik enthält kein Symbol (Kardinalität)");
});

test("4: failure emits structured log with venue/symbol/timeframe/reason", async () => {
  setStructuredLogSinkForTests((entry) => logs.push(entry));
  mockFetchOnce(() => httpResponse(503, {}));
  await assert.rejects(() => getCandles("SPY", "1h", 120), MarketDataFetchError);
  const entry = logs.find((l) => l.event === "market_data_fetch_failed");
  assert.ok(entry, "market_data_fetch_failed wurde emittiert");
  assert.equal(entry!.level, "error");
  assert.equal(entry!.fields.venue, "yahoo");
  assert.equal(entry!.fields.symbol, "SPY");
  assert.equal(entry!.fields.timeframe, "1h");
  assert.equal(entry!.fields.reason, "UPSTREAM_5XX");
  assert.equal(entry!.fields.httpStatus, 503);
});

test("4b: UNAUTHORIZED im Public-Pfad wird als Konfigurationsfehler alarmiert", async () => {
  setStructuredLogSinkForTests((entry) => logs.push(entry));
  mockFetchOnce(() => httpResponse(401, {}));
  await assert.rejects(() => getCandles("BTC", "15m", 150), MarketDataFetchError);
  const critical = logs.find((l) => l.event === "market_data_unauthorized_public_endpoint");
  assert.ok(critical, "UNAUTHORIZED erzeugt kritischen Alarm");
  assert.equal(critical!.level, "critical");
});

test("5: getCandlesWithFallback reports source=cache and stale=true", async () => {
  // 1) Erfolgreicher Abruf füllt den Cache.
  mockFetchOnce(() => httpResponse(200, okCandles().map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume])));
  await getCandles("BTC", "15m", 150);
  // 2) Cache künstlich altern lassen (TTL 120 s) und Abruf fehlschlagen lassen.
  Date.now = () => realNow() + 200_000;
  mockFetchOnce(() => httpResponse(500, {}));
  const result = await getCandlesWithFallback("BTC", "15m", 150);
  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.ok(result.ageMs !== null && result.ageMs >= 200_000);
  assert.equal(result.candles.length, okCandles().length);
});

test("6: getCandlesWithFallback surfaces the original error alongside cached data", async () => {
  mockFetchOnce(() => httpResponse(200, okCandles().map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume])));
  await getCandles("BTC", "15m", 150);
  Date.now = () => realNow() + 200_000;
  mockFetchOnce(() => httpResponse(503, {}));
  const result = await getCandlesWithFallback("BTC", "15m", 150);
  assert.ok(result.error instanceof MarketDataFetchError, "Original-Fehler bleibt sichtbar");
  assert.equal(result.error!.reason, "UPSTREAM_5XX");
  assert.equal(result.error!.retryable, true);
});

test("6b: getCandlesWithFallback wirft ohne Cache (kein stilles [] )", async () => {
  mockFetchOnce(() => httpResponse(429, {}));
  await assert.rejects(
    () => getCandlesWithFallback("BTC", "15m", 150),
    MarketDataFetchError,
  );
});

test("7: scanner maps fetch error to DATA_UNAVAILABLE, not min-candles", () => {
  const inst = instrument();
  const scan = scanUniverse({
    instruments: [inst],
    // 0 Kerzen: ohne Datenfehler wäre es min-candles — mit Fehler muss
    // data-unavailable greifen.
    data: { candles: () => [] },
    asOf: "2026-08-29T00:00:00.000Z",
    config: DEFAULT_SCANNER_CONFIG,
    dataErrors: new Map([[inst.id, "RATE_LIMITED"]]),
  });
  assert.equal(scan.readiness.status, "ERROR");
  const rejection = scan.rejections.find((r) => r.instrumentId === inst.id);
  assert.ok(rejection);
  assert.equal(rejection!.ruleId, "data-unavailable");
  assert.equal(rejection!.dataQuality, true);
  assert.match(rejection!.message, /DATA_UNAVAILABLE/);
  assert.doesNotMatch(rejection!.message, /min-candles/);
  assert.equal(scan.rejectionsByRule["min-candles"], undefined);
});

test("8: readiness becomes ERROR when any instrument has a data error", () => {
  const a = instrument({ symbol: "AAAUSDT" });
  const b = instrument({ symbol: "BBBUSDT" });
  const c = instrument({ symbol: "CCCUSDT" });
  const scan = scanUniverse({
    instruments: [a, b, c],
    data: { candles: () => okCandles(80).map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })) },
    asOf: "2026-08-29T00:00:00.000Z",
    config: DEFAULT_SCANNER_CONFIG,
    dataErrors: new Map([[b.id, "UPSTREAM_5XX"]]),
  });
  assert.equal(scan.readiness.status, "ERROR");
  if (scan.readiness.status !== "ERROR") return;
  assert.equal(scan.readiness.failures[0].instrumentId, b.id);
  assert.equal(scan.readiness.failures[0].reason, "UPSTREAM_5XX");
});

test("9: error is serializable and redacted (fetch path with secret in cause)", async () => {
  mockFetchOnce(() => {
    const cause = new Error(
      "X-Api-Key: sk-supersecret-1234567890\nAuthorization: Bearer at-9876543210?full=https://api.example.com/v1/kline?symbol=BTCUSDT&key=sk-supersecret",
    );
    throw Object.assign(cause, { code: "ENOTFOUND", cause });
  });
  try {
    await getCandles("BTC", "15m", 150);
    assert.fail("Fehler erwartet");
  } catch (err) {
    assert.ok(err instanceof MarketDataFetchError);
    const text = JSON.stringify(err);
    assert.doesNotMatch(text, /sk-supersecret|Bearer|X-Api-Key|at-9876543210|https?:\/\//);
    assert.doesNotMatch(JSON.stringify(err.toJSON().cause), /message|stack|sk-supersecret/);
  }
});

test("retry: Fehlerpfad hat ein begrenztes Retry-Budget (kein Endlos-Retry)", async () => {
  let calls = 0;
  mockFetchOnce(() => {
    calls++;
    return httpResponse(500, {});
  });
  try {
    await getCandles("BTC", "15m", 150);
    assert.fail("Fehler erwartet");
  } catch (err) {
    assert.ok(err instanceof MarketDataFetchError);
    assert.equal(err!.reason, "UPSTREAM_5XX");
  }
  assert.equal(calls, MARKET_DATA_FETCH_ATTEMPTS, `genau ${MARKET_DATA_FETCH_ATTEMPTS} Versuche`);
});

test("retry: retryable-Fehler mit Backoff wird nach Erfolg nicht geworfen", async () => {
  let calls = 0;
  mockFetchOnce(async () => {
    calls++;
    if (calls === 1) return httpResponse(503, {});
    return httpResponse(200, okCandles().map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]));
  });
  const candles = await getCandles("BTC", "15m", 150);
  assert.equal(candles.length, okCandles().length);
  assert.equal(calls, 2);
});

test("retry: nicht-retryable Fehler (404) wird sofort geworfen", async () => {
  let calls = 0;
  mockFetchOnce(() => {
    calls++;
    return httpResponse(404, {});
  });
  try {
    await getCandles("BTC", "15m", 150);
    assert.fail("Fehler erwartet");
  } catch (err) {
    assert.ok(err instanceof MarketDataFetchError);
    assert.equal(err!.reason, "NOT_FOUND");
    assert.equal(err!.retryable, false);
  }
  assert.equal(calls, 1);
});

test("ungültiges Symbol → INVALID_SYMBOL statt [] (kein stilles Leer-Array)", async () => {
  try {
    await getCandles("bad symbol!", "15m", 150);
    assert.fail("Fehler erwartet");
  } catch (err) {
    assert.ok(err instanceof MarketDataFetchError);
    assert.equal(err!.reason, "INVALID_SYMBOL");
    assert.equal(err!.retryable, false);
  }
  assert.equal(marketDataFailureSnapshot().byReason["INVALID_SYMBOL"], 1);
});

test("Schema-Abweichung → SCHEMA_MISMATCH (Binance liefert Objekt statt Array)", async () => {
  mockFetchOnce(() => httpResponse(200, { success: true }));
  try {
    await getCandles("BTC", "15m", 150);
    assert.fail("Fehler erwartet");
  } catch (err) {
    assert.ok(err instanceof MarketDataFetchError);
    assert.equal(err!.reason, "SCHEMA_MISMATCH");
    assert.equal(err!.retryable, false);
  }
});

test("Manifest: Sync-Fehler werden klassifiziert persistiert und gelesen", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mderr-"));
  const file = path.join(dir, "errors.json");
  try {
    saveMarketDataErrors(
      [
        {
          stage: "candles" as const,
          instrumentId: "BITUNIX:BTCUSDT",
          symbol: "BTCUSDT",
          timeframe: "15m",
          message: "HTTP 429 rate limit",
        },
        {
          stage: "ticker" as const,
          instrumentId: "BITUNIX:ETHUSDT",
          symbol: "ETHUSDT",
          message: "connect ECONNREFUSED",
        },
      ],
      file,
    );
    const map = loadMarketDataErrors(file);
    assert.equal(map.get("BITUNIX:BTCUSDT"), "RATE_LIMITED");
    assert.equal(map.get("BITUNIX:ETHUSDT"), "NETWORK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

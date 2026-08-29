/**
 * Tests der Marktdaten-Fehler-Taxonomie (MDERR-006, P1).
 *
 * Kernaussagen:
 *   - classifyMarketDataError() deckt die geforderte Äquivalenzklassen-Tabelle
 *     ab (429/5xx/401/403/404/Schema/Abort/Netzwerk/TLS/unbekannt).
 *   - MarketDataFetchError ist typisiert, serialisierbar und redigiert:
 *     weder message, toJSON() noch Logs enthalten Credentials/Header/volle
 *     URLs; `cause` wird nicht ungefiltert weitergereicht.
 *   - retryable-Flags folgen der Security-Vorgabe (RATE_LIMITED/UPSTREAM_5XX/
 *     TIMEOUT/NETWORK = true; UNAUTHORIZED/NOT_FOUND/INVALID_SYMBOL/… = false).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataHttpError,
  MarketDataSchemaError,
  MarketDataTimeoutError,
  MarketDataFetchError,
  classifyMarketDataError,
} from "../src/lib/marketDataErrors";

// ── 1) Äquivalenzklassen der Klassifizierung ────────────────────────────────

test("classify: HTTP 429 → RATE_LIMITED, retryable", () => {
  const r = classifyMarketDataError(new MarketDataHttpError(429, "host"));
  assert.deepEqual(r, { reason: "RATE_LIMITED", retryable: true, httpStatus: 429 });
});

test("classify: HTTP 500/502/503 → UPSTREAM_5XX, retryable", () => {
  for (const status of [500, 502, 503]) {
    const r = classifyMarketDataError(new MarketDataHttpError(status, "host"));
    assert.equal(r.reason, "UPSTREAM_5XX");
    assert.equal(r.retryable, true);
    assert.equal(r.httpStatus, status);
  }
});

test("classify: HTTP 401/403 → UNAUTHORIZED, nicht retryable", () => {
  for (const status of [401, 403]) {
    const r = classifyMarketDataError(new MarketDataHttpError(status, "host"));
    assert.equal(r.reason, "UNAUTHORIZED");
    assert.equal(r.retryable, false);
  }
});

test("classify: HTTP 404 → NOT_FOUND, nicht retryable", () => {
  const r = classifyMarketDataError(new MarketDataHttpError(404, "host"));
  assert.equal(r.reason, "NOT_FOUND");
  assert.equal(r.retryable, false);
});

test("classify: Zod/Schema-Fehler → SCHEMA_MISMATCH, nicht retryable", () => {
  const zodLike = Object.assign(new Error("invalid_type"), { name: "ZodError" });
  const r = classifyMarketDataError(zodLike);
  assert.equal(r.reason, "SCHEMA_MISMATCH");
  assert.equal(r.retryable, false);
  const own = classifyMarketDataError(new MarketDataSchemaError("Antwort ist kein Array"));
  assert.equal(own.reason, "SCHEMA_MISMATCH");
  assert.equal(own.retryable, false);
});

test("classify: AbortError (Timeout) → TIMEOUT, retryable", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const r = classifyMarketDataError(abort);
  assert.equal(r.reason, "TIMEOUT");
  assert.equal(r.retryable, true);
  const own = classifyMarketDataError(new MarketDataTimeoutError("nach 8000 ms"));
  assert.equal(own.reason, "TIMEOUT");
  assert.equal(own.retryable, true);
});

test("classify: ENOTFOUND / ECONNREFUSED → NETWORK, retryable", () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"]) {
    const r = classifyMarketDataError(Object.assign(new Error("fetch failed"), { code }));
    assert.equal(r.reason, "NETWORK", `code ${code}`);
    assert.equal(r.retryable, true);
  }
  // undici kapselt den echten Fehler in `.cause`.
  const wrapped = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" }),
  });
  assert.equal(classifyMarketDataError(wrapped).reason, "NETWORK");
});

test("classify: ERR_TLS_CERT_ALTNAME_INVALID → TLS, nicht retryable", () => {
  const r = classifyMarketDataError(
    Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    }),
  );
  assert.equal(r.reason, "TLS");
  assert.equal(r.retryable, false);
});

test("classify: gewöhnlicher Fehler/string/undefined → UNKNOWN, nicht retryable", () => {
  for (const input of [new Error("boom"), "boom", undefined, 42]) {
    const r = classifyMarketDataError(input);
    assert.equal(r.reason, "UNKNOWN");
    assert.equal(r.retryable, false);
    assert.equal(r.httpStatus, undefined);
  }
});

test("classify: HTTP-Status im Message-Text wird erkannt (Fremd-Clients)", () => {
  const r = classifyMarketDataError(new Error("Upstream antwortete mit HTTP 503 Service Unavailable"));
  assert.equal(r.reason, "UPSTREAM_5XX");
  assert.equal(r.httpStatus, 503);
  assert.equal(r.retryable, true);
});

test("classify: BitunixApiError-artiger Fehler mit httpStatus", () => {
  const bitunixLike = Object.assign(new Error("rate limit exceeded"), { httpStatus: 429 });
  const r = classifyMarketDataError(bitunixLike);
  assert.equal(r.reason, "RATE_LIMITED");
  assert.equal(r.retryable, true);
});

// ── 2) MarketDataFetchError: Typ, Felder, Template, Serialisierung ──────────

test("MarketDataFetchError: Felder und Template", () => {
  const err = new MarketDataFetchError({
    venue: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    reason: "RATE_LIMITED",
    retryable: true,
    httpStatus: 429,
    cause: new Error("upstream 429"),
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, "MarketDataFetchError");
  assert.equal(err.venue, "binance");
  assert.equal(err.symbol, "BTCUSDT");
  assert.equal(err.timeframe, "15m");
  assert.equal(err.reason, "RATE_LIMITED");
  assert.equal(err.retryable, true);
  assert.equal(err.httpStatus, 429);
  assert.match(err.message, /BTCUSDT 15m - RATE_LIMITED/);
  assert.match(err.message, /HTTP 429, retryable/);
  assert.match(err.message, /KEIN "keine Historie vorhanden"/);
  assert.match(err.message, /DATA_UNAVAILABLE/);
});

test("MarketDataFetchError: toJSON enthält keine Header/Credentials/Stacks und keinen cause-Text", () => {
  const secret = "X-Api-Key: sk-supersecret-1234567890, Authorization: Bearer at-9876543210";
  const cause = new Error(secret);
  const err = new MarketDataFetchError({
    venue: "binance",
    symbol: "BTCUSDT",
    timeframe: "15m",
    reason: "UNAUTHORIZED",
    retryable: false,
    httpStatus: 401,
    cause,
  });
  const json = err.toJSON() as Record<string, unknown>;
  const text = JSON.stringify(err); // nutzt toJSON
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /sk-supersecret|Bearer|X-Api-Key|at-9876543210/);
  assert.doesNotMatch(text, /at .+\.ts:\d+/); // kein Stacktrace
  assert.ok(!("stack" in json), "toJSON ohne Stack");
  assert.equal((json.cause as Record<string, unknown>).name, "Error");
  assert.ok(!("message" in (json.cause as Record<string, unknown>)), "cause ohne Message");
  assert.ok(!("stack" in (json.cause as Record<string, unknown>)), "cause ohne Stack");
});

test("MarketDataFetchError: Message ist redigiert und einzeilig (Log-Injection)", () => {
  // Mehrzeilige/Steuerzeichen-Fremdinhalte + Secret-Marker im Symbol.
  const err = new MarketDataFetchError({
    venue: "binance",
    symbol: "SYM\nSECOND-LINE\x1b[31mred\x1b[0m",
    timeframe: "15m",
    reason: "UNKNOWN",
    retryable: false,
    cause: new Error("api_key=abc123 def"),
  });
  // Ausführung des Feld-Sanitizers: keine Steuerzeichen/Zeilenumbrüche,
  // kein Secret, keine Escape-Sequenz als solche.
  assert.doesNotMatch(err.message, /[\r\n\u0000-\u001f\u007f]/);
  assert.doesNotMatch(err.message, /abc123/);
  assert.doesNotMatch(err.message, /\u001b/);
});

test("MarketDataFetchError: ohne HTTP-Status bleibt das Template korrekt", () => {
  const err = new MarketDataFetchError({
    venue: "yahoo",
    symbol: "SPY",
    timeframe: "1h",
    reason: "NETWORK",
    retryable: true,
  });
  assert.match(err.message, /ohne HTTP-Status, retryable/);
  assert.equal(err.httpStatus, undefined);
});

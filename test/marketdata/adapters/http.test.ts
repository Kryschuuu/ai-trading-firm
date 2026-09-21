/**
 * `SyncHttpClient` — Unit-Tests (kein Netz, Stub-`fetch`).
 *
 * Coverage: Query-Encoding, SSRF-Gates (Schema/Host/Credentials),
 * Retry-Nur-Idempotent (429/5xx/Timeout/Netzwerk), Retry-After-Deckel,
 * Payload-Kappe, typisierte Fehler mit `.cause`-Kette, Limiter-Disziplin
 * (ein Token je Versuch), Host-nur-Meldungen (keine Query in Errors).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataHttpError,
  MarketDataSchemaError,
  MarketDataTimeoutError,
} from "../../../src/lib/marketDataErrors";
import { SyncHttpClient, taggedSyncError } from "../../../src/marketdata/adapters/http";

interface StubCall {
  url: string;
  init: Record<string, unknown>;
}

function stubResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as Response;
}

type FetchFn = typeof globalThis.fetch;

function stubFetch(
  handler: (url: string, init: Record<string, unknown>) => Response | Promise<Response> | never,
): { calls: StubCall[]; fetch: FetchFn } {
  const calls: StubCall[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
    return handler(String(url), (init ?? {}) as Record<string, unknown>);
  }) as unknown as FetchFn;
  return { calls, fetch: fetchImpl };
}

function clientFor(
  fetch: FetchFn,
  overrides: Record<string, unknown> = {},
): { client: SyncHttpClient; sleeps: number[]; took: () => number } {
  const sleeps: number[] = [];
  let takes = 0;
  const client = new SyncHttpClient({
    baseUrl: "https://api.example.com",
    fetchImpl: fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    limiter: { take: async () => { takes += 1; } },
    ...(overrides as Record<string, never>),
  });
  return { client, sleeps, took: () => takes };
}

// ── 1) Erfolg + Encoding ─────────────────────────────────────────────────────

test("getJson encodiert Query-Werte (^ , =) und sendet GET + Header", async () => {
  const { calls, fetch } = stubFetch(() => stubResponse(200, '{"ok":true}'));
  const { client } = clientFor(fetch, { headers: { "User-Agent": "ua-test" } });

  const body = await client.getJson<{ ok: boolean }>("/v7/finance/quote", { symbols: "^GSPC,CL=F" });

  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].url.startsWith("https://api.example.com/v7/finance/quote?"));
  assert.ok(calls[0].url.includes("symbols="), calls[0].url);
  assert.ok(!calls[0].url.includes("^"), `unencodiert: ${calls[0].url}`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["User-Agent"], "ua-test");
  assert.equal(headers.Accept, "application/json");
  assert.equal(calls[0].init.redirect, "error");
});

test("getJson lässt undefined-Query-Werte weg", async () => {
  const { calls, fetch } = stubFetch(() => stubResponse(200, "{}"));
  const { client } = clientFor(fetch);
  await client.getJson("/x", { a: undefined, b: "1" });
  assert.ok(calls[0].url.includes("b=1"));
  assert.ok(!calls[0].url.includes("a="));
});

// ── 2) SSRF-Gates ────────────────────────────────────────────────────────────

test("Konstruktor verweigert Credentials/http-fremd/leere Allowlist", () => {
  assert.throws(
    () => new SyncHttpClient({ baseUrl: "https://user:pass@api.example.com" }),
    /Credentials/,
  );
  assert.throws(() => new SyncHttpClient({ baseUrl: "http://api.example.com" }), /Schema/);
  assert.throws(() => new SyncHttpClient({ baseUrl: "notaurl" }), /gültige URL/);
  assert.throws(() => new SyncHttpClient({ baseUrl: "" }), /Pflicht/);
  assert.throws(
    () => new SyncHttpClient({ baseUrl: "https://api.example.com", allowedHosts: [] }),
    /allowedHosts/,
  );
  assert.throws(
    () => new SyncHttpClient({ baseUrl: "https://api.example.com", timeoutMs: 0 }),
    /timeoutMs/,
  );
});

test("http ist nur für Loopback erlaubt", async () => {
  const { fetch } = stubFetch(() => stubResponse(200, "{}"));
  for (const baseUrl of ["http://127.0.0.1:9", "http://localhost:9"]) {
    const client = new SyncHttpClient({ baseUrl, fetchImpl: fetch });
    await client.getJson("/x");
  }
  assert.throws(() => new SyncHttpClient({ baseUrl: "http://10.0.0.1", fetchImpl: fetch }), /Schema/);
  assert.throws(() => new SyncHttpClient({ baseUrl: "ftp://api.example.com", fetchImpl: fetch }), /Schema/);
});

test("Pfad ohne / und Host außerhalb der Allowlist werfen (kein Request)", async () => {
  const { calls, fetch } = stubFetch(() => stubResponse(200, "{}"));
  const { client } = clientFor(fetch);
  await assert.rejects(() => client.getJson("https://evil.example.com/x"), /mit \/ beginnen/);
  const strict = new SyncHttpClient({
    baseUrl: "https://api.example.com",
    allowedHosts: ["other.example.com"],
    fetchImpl: fetch,
  });
  await assert.rejects(() => strict.getJson("/x"), /Allowlist/);
  assert.equal(calls.length, 0);
});

// ── 3) Retry-Disziplin ───────────────────────────────────────────────────────

test("429/503: Retry mit exponentiellem Backoff, dann Erfolg", async () => {
  let n = 0;
  const { calls, fetch } = stubFetch(() => {
    n += 1;
    if (n === 1) return stubResponse(429, "{}");
    if (n === 2) return stubResponse(503, "{}");
    return stubResponse(200, '{"ok":true}');
  });
  const ctx = clientFor(fetch);
  const body = await ctx.client.getJson<{ ok: boolean }>("/x");

  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(ctx.sleeps, [250, 500]);
  assert.equal(ctx.took(), 3, "ein Token je Versuch, auch bei Retries");
});

test("429 mit Retry-After wartet mindestens so lange (gedeckelt)", async () => {
  let n = 0;
  const { fetch } = stubFetch(() => {
    n += 1;
    if (n === 1) return stubResponse(429, "{}", { "retry-after": "2" });
    return stubResponse(200, "{}");
  });
  const ctx = clientFor(fetch);
  await ctx.client.getJson("/x");
  assert.deepEqual(ctx.sleeps, [2000]);

  // Deckel: 3600 s Retry-After parken den Sync nicht eine Stunde.
  let m = 0;
  const capped = stubFetch(() => {
    m += 1;
    if (m === 1) return stubResponse(429, "{}", { "retry-after": "3600" });
    return stubResponse(200, "{}");
  });
  const ctx2 = clientFor(capped.fetch);
  await ctx2.client.getJson("/x");
  assert.deepEqual(ctx2.sleeps, [10_000]);
});

test("4xx außer 429: SOFORT werfen, kein Retry, kein Sleep", async () => {
  for (const status of [400, 401, 403, 404, 418]) {
    const { calls, fetch } = stubFetch(() => stubResponse(status, "{}"));
    const ctx = clientFor(fetch);
    const err = await ctx.client.getJson("/x").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof MarketDataHttpError, `Status ${status}`);
    assert.equal((err as MarketDataHttpError).httpStatus, status);
    assert.equal(calls.length, 1, `Status ${status}: genau 1 Versuch`);
    assert.deepEqual(ctx.sleeps, [], `Status ${status}: kein Backoff`);
  }
});

test("Netzwerk-/Timeout-Fehler sind retrybar; danach fliegt der letzte Fehler", async () => {
  const { calls, fetch } = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const ctx = clientFor(fetch);
  await assert.rejects(() => ctx.client.getJson("/x"), /fetch failed/);
  assert.equal(calls.length, 3);
  assert.deepEqual(ctx.sleeps, [250, 500]);
});

test("Timeout-Abbruch wird typisiert (MarketDataTimeoutError) und wiederholt", async () => {
  let n = 0;
  const { calls, fetch } = stubFetch(() => {
    n += 1;
    if (n === 1) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    return stubResponse(200, '{"ok":true}');
  });
  const ctx = clientFor(fetch);
  await ctx.client.getJson("/x");
  assert.equal(calls.length, 2);

  const always = stubFetch(() => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  });
  const ctx2 = clientFor(always.fetch);
  const err = await ctx2.client.getJson("/x").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof MarketDataTimeoutError);
});

// ── 4) Payload / Schema ──────────────────────────────────────────────────────

test("ungültiges JSON: SchemaError mit .cause-Kette (SyntaxError), kein Retry", async () => {
  const { calls, fetch } = stubFetch(() => stubResponse(200, "{oops-kein-json"));
  const ctx = clientFor(fetch);
  const err = (await ctx.client.getJson("/x").then(
    () => null,
    (e: unknown) => e,
  )) as MarketDataSchemaError;
  assert.ok(err instanceof MarketDataSchemaError);
  assert.equal(calls.length, 1, "Schema-Fehler: kein Retry");
  assert.ok(err.cause instanceof SyntaxError, "Original-Parse-Fehler in .cause");
});

test("Antwort über der Payload-Kappe wirft (kein Retry, kein OOM)", async () => {
  const { fetch } = stubFetch(() => stubResponse(200, `{"a":"${"x".repeat(1000)}"}`));
  const ctx = clientFor(fetch, { maxResponseBytes: 100 });
  const err = (await ctx.client.getJson("/x").then(
    () => null,
    (e: unknown) => e,
  )) as MarketDataSchemaError;
  assert.ok(err instanceof MarketDataSchemaError);
  assert.match(err.message, /Payload-Kappe/);
});

// ── 5) Redaktion + taggedSyncError ───────────────────────────────────────────

test("Fehlermeldungen tragen den Host, nie die Query (Symbole)", async () => {
  const { fetch } = stubFetch(() => stubResponse(503, "{}"));
  const ctx = clientFor(fetch, { maxAttempts: 1 });
  const err = (await ctx.client.getJson("/x", { symbols: "SECRET-SYMBOL" }).then(
    () => null,
    (e: unknown) => e,
  )) as Error;
  assert.ok(err instanceof MarketDataHttpError);
  assert.match(err.message, /api\.example\.com/);
  assert.ok(!err.message.includes("SECRET-SYMBOL"), err.message);
  assert.ok(!err.message.includes("symbols="), err.message);
});

test("taggedSyncError setzt den Taxonomie-Code (Klassifikator übernimmt ihn)", async () => {
  const { classifyMarketDataError } = await import("../../../src/lib/marketDataErrors");
  const err = taggedSyncError("INVALID_SYMBOL", "Kraken kennt das Paar nicht");
  assert.equal((err as { code?: unknown }).code, "INVALID_SYMBOL");
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "INVALID_SYMBOL");
  assert.equal(r.retryable, false);
});

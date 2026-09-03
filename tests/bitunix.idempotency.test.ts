/**
 * H4 — Order-Idempotenz (CRITICAL). Belegt, dass der Bitunix-Live-Pfad einen
 * stabilen `clientOrderId` generiert/mitsendet und einen nicht-idempotenten
 * place_order-POST NIE blind wiederholt: Bei ambivalentem Ausgang (429/
 * Timeout/Netz/5xx) wird erst per `clientOrderId` der echte Status abgefragt.
 *
 *   (a) 429 + bereits existierende Order → bestehende Order (kein Duplikat).
 *   (b) 429 + Query leer → genau EIN kontrollierter Retry mit identischem
 *       clientOrderId.
 *
 * Kein echtes Netz: in-prozess `fetch`-Mock gegen das Bitunix-REST-Schema.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBitunixConfig, BITUNIX_PATHS } from "../src/brokers/bitunix/config";
import { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";
import { serializePlaceOrder, clientOrderIdFor } from "../src/brokers/bitunix/orders";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { clearBitunixPrivateAuditForTests } from "../src/brokers/bitunix/audit";

function cfg(base = "http://127.0.0.1:9") {
  return loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: base,
    BITUNIX_RETRY_MAX: "1",
    BITUNIX_TIMEOUT_MS: "500",
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
  });
}

interface IdemCall {
  method: string;
  path: string;
  body: string;
  query: Record<string, string>;
  clientId?: string;
}

function orderRequest() {
  return {
    symbol: "BTCUSDT",
    side: "LONG" as const,
    qty: 0.01,
    riskNotional: 650,
    stopLoss: 60000,
    takeProfit: 70000,
  };
}

/**
 * In-prozess `fetch`: simuliert place_order-429 und get_order_detail per
 * clientId (bestehende Order oder leere Antwort). Zählt alle Calls.
 */
function idempotencyFetch(opts: {
  /** true → der ERSTE place_order-POST antwortet mit HTTP 429. */
  firstPost429?: boolean;
  /** Beim Query-by-clientId zurückzugebende bestehende Order-ID (oder leer). */
  existingOrderId?: string;
}) {
  const calls: IdemCall[] = [];
  let postIndex = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const query = Object.fromEntries(url.searchParams);
    let clientId: string | undefined;
    try {
      clientId = body ? (JSON.parse(body) as { clientId?: string }).clientId : undefined;
    } catch {
      clientId = undefined;
    }
    calls.push({ method, path: url.pathname, body, query, clientId });

    if (method === "POST" && url.pathname === BITUNIX_PATHS.placeOrder) {
      postIndex += 1;
      if (opts.firstPost429 && postIndex === 1) {
        return new Response(JSON.stringify({ code: 429, msg: "rate limited", data: null }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ code: 0, data: { orderId: "BX-NEW-1", clientId }, msg: "Success" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (method === "GET" && url.pathname === BITUNIX_PATHS.orderDetail) {
      if (opts.existingOrderId) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              orderId: opts.existingOrderId,
              clientId: query.clientId,
              symbol: "BTCUSDT",
              qty: "0.01",
              tradeQty: "0",
              side: "BUY",
              orderType: "MARKET",
              status: "NEW",
            },
            msg: "Success",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ code: 0, data: null, msg: "Success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 0, data: null, msg: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function makeClient(opts: { firstPost429?: boolean; existingOrderId?: string }) {
  const { fetchImpl, calls } = idempotencyFetch(opts);
  const c = new BitunixPrivateClient({
    config: cfg(),
    credentials: { apiKey: "fixture-api-key", apiSecret: "fixture-api-secret" },
    fetchImpl,
  });
  return { client: c, calls };
}

test("clientOrderIdFor: ATF-Präfix, stabil, kollisionsresistent", () => {
  const req = orderRequest();
  const id1 = clientOrderIdFor(req, 1700000000000, "abc123");
  assert.match(id1, /^ATF-[A-F0-9]+$/);
  // Identische Eingabe → identischer Wert (testbar/deterministisch mit ts+rand).
  assert.equal(clientOrderIdFor(req, 1700000000000, "abc123"), id1);
  // Anderes Rand → anderer Wert (kollisionsresistent über Intents).
  assert.notEqual(clientOrderIdFor(req, 1700000000000, "def456"), id1);
  // Andere qty/side → anderer Wert.
  assert.notEqual(clientOrderIdFor({ ...req, qty: 0.02 }, 1700000000000, "abc123"), id1);
  assert.notEqual(clientOrderIdFor({ ...req, side: "SHORT" }, 1700000000000, "abc123"), id1);
});

test("serializePlaceOrder: setzt clientId und bleibt bei Retry-Body identisch", () => {
  const req = orderRequest();
  const body = serializePlaceOrder(req, { ts: 1700000000000, rand: "abc123" });
  assert.match(String(body.clientId), /^ATF-/);
  // Derselbe Body wird für Retry WIEDERVERWENDET → exakt derselbe clientId.
  const retryBody = { ...body };
  assert.equal(retryBody.clientId, body.clientId);
  // Mit festem ts+rand bleibt die ClientOrderId auch bei erneuter
  // Serialisierung deterministisch (Testbarkeit), ohne dass die Produktion
  // davon abhängt (dort wird der Body für den Retry einfach wiederverwendet).
  assert.equal(serializePlaceOrder(req, { ts: 1700000000000, rand: "abc123" }).clientId, body.clientId);
});

test("(a) 429 + Query findet bestehende Order → KEIN Doppel-Order", async () => {
  clearBitunixPrivateAuditForTests();
  const { client, calls } = makeClient({ firstPost429: true, existingOrderId: "BX-EXISTING" });
  const body = serializePlaceOrder(orderRequest(), { ts: 1700000000000 });
  const res = await client.placeSerializedOrder(body);

  assert.equal(res.orderId, "BX-EXISTING");
  assert.equal(res.clientOrderId, body.clientId);
  // Der place_order-POST wurde nur EINMAL gesendet — kein zweiter Versuch,
  // kein Duplikat.
  const posts = calls.filter((c) => c.method === "POST" && c.path === BITUNIX_PATHS.placeOrder);
  assert.equal(posts.length, 1);
  const queries = calls.filter((c) => c.method === "GET" && c.path === BITUNIX_PATHS.orderDetail);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.query.clientId, body.clientId);
  // Beleg: der gesendete Body trug DEN clientId, nach dem abgefragt wurde.
  assert.equal(posts[0]?.clientId, body.clientId);
});

test("(b) 429 + Query leer → genau EIN Retry mit identischem clientOrderId", async () => {
  clearBitunixPrivateAuditForTests();
  const { client, calls } = makeClient({ firstPost429: true, existingOrderId: undefined });
  const body = serializePlaceOrder(orderRequest(), { ts: 1700000000000 });
  const res = await client.placeSerializedOrder(body);

  assert.equal(res.orderId, "BX-NEW-1");
  assert.equal(res.clientOrderId, body.clientId);
  const posts = calls.filter((c) => c.method === "POST" && c.path === BITUNIX_PATHS.placeOrder);
  assert.equal(posts.length, 2, "genau ein kontrollierter Retry nach dem 429");
  // Der Retry nutzt DENSELBEN clientOrderId wie der erste Versuch.
  assert.equal(posts[0]?.clientId, body.clientId);
  assert.equal(posts[1]?.clientId, body.clientId);
  assert.equal(posts[0]?.body, posts[1]?.body, "derselbe Body (kein Neu-Serialisieren)");
  const queries = calls.filter((c) => c.method === "GET" && c.path === BITUNIX_PATHS.orderDetail);
  assert.equal(queries.length, 1, "Status-Query zwischen den POSTs");
  assert.equal(queries[0]?.query.clientId, body.clientId);
});

test("definitiver 4xx (Validierung) → kein Status-Query, kein Retry, kein ambiguous", async () => {
  clearBitunixPrivateAuditForTests();
  const calls: IdemCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify({ code: 400, msg: "invalid symbol", data: null }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  const c = new BitunixPrivateClient({
    config: cfg(),
    credentials: { apiKey: "fixture-api-key", apiSecret: "fixture-api-secret" },
    fetchImpl,
  });
  const body = serializePlaceOrder(orderRequest(), { ts: 1700000000000 });
  await assert.rejects(() => c.placeSerializedOrder(body), (e: unknown) => {
    assert.ok(e instanceof BitunixApiError);
    // 400 = definitiv abgelehnt → nicht als "ambiguous" markiert (kein Query).
    assert.notEqual((e as BitunixApiError).kind, "ambiguous");
    assert.equal((e as BitunixApiError).httpStatus, 400);
    return true;
  });
  const posts = calls.filter((x) => x.method === "POST" && x.path === BITUNIX_PATHS.placeOrder);
  assert.equal(posts.length, 1, "kein Retry einer definitiven 4xx-Ablehnung");
  const queries = calls.filter((x) => x.method === "GET" && x.path === BITUNIX_PATHS.orderDetail);
  assert.equal(queries.length, 0, "kein Status-Query nach definitiver Ablehnung");
});

test("http.ts: nicht-idempotenter POST bei 429 → BitunixAmbiguousError (kein Auto-Retry)", async () => {
  const { calls, fetchImpl } = idempotencyFetch({ firstPost429: true });
  const { BitunixHttp } = await import("../src/brokers/bitunix/http");
  const http = new BitunixHttp({ config: cfg(), fetchImpl });
  await assert.rejects(
    () => http.request({ method: "POST", path: BITUNIX_PATHS.placeOrder, body: "{}" }),
    (e: unknown) => {
      assert.ok(e instanceof BitunixApiError);
      assert.equal((e as BitunixApiError).kind, "ambiguous");
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === BITUNIX_PATHS.placeOrder).length, 1);
});

test("http.ts: idempotenter GET bei 429 bleibt Retry-fähig", async () => {
  let getCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === BITUNIX_PATHS.orderDetail) {
      getCount += 1;
      return new Response(JSON.stringify({ code: 429, msg: "rate limited", data: null }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 0, data: null }), { status: 200 });
  };
  const cfgRetry = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: "http://127.0.0.1:9",
    BITUNIX_RETRY_MAX: "3",
    BITUNIX_TIMEOUT_MS: "500",
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
  });
  const { BitunixHttp } = await import("../src/brokers/bitunix/http");
  const http = new BitunixHttp({ config: cfgRetry, fetchImpl });
  await assert.rejects(
    () => http.request({ method: "GET", path: BITUNIX_PATHS.orderDetail }),
    (e: unknown) => e instanceof BitunixApiError && (e as BitunixApiError).kind === "rate-limit"
  );
  assert.equal(getCount, 3, "GET = idempotent → 429 wird bis retryMax wiederholt");
});

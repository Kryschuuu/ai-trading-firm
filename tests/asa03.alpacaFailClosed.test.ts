/**
 * ASA-03 regression coverage: Alpaca positions fail closed, emergency closes
 * always reach the venue, and ambiguous retries require an idempotency proof.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AlpacaBrokerAdapter } from "../src/brokers/alpaca/adapter";
import {
  loadAlpacaPublicConfig,
  loadAlpacaTradeConfig,
  type AlpacaRuntimeConfig,
} from "../src/brokers/alpaca/config";
import { clearAlpacaPrivateAuditForTests, readAlpacaPrivateAudit } from "../src/brokers/alpaca/audit";
import { AlpacaHttp, TokenBucket } from "../src/brokers/alpaca/http";
import type { AlpacaHttpOptions } from "../src/brokers/alpaca/http";
import { AlpacaPrivateClient } from "../src/brokers/alpaca/privateClient";
import type { AlpacaPosition } from "../src/brokers/alpaca/types";
import { BrokerError } from "../src/contracts/broker";
import { setAuditTransportForTests } from "../src/lib/auditSink";

const ENV: Record<string, string> = {
  ALPACA_ENABLED: "true",
  ALPACA_ALLOW_INSECURE_HTTP: "true",
  ALPACA_TRADE_BASE_URL: "http://127.0.0.1:43871",
  ALPACA_DATA_BASE_URL: "http://127.0.0.1:43871",
  ALPACA_RETRY_MAX: "1",
  ALPACA_TIMEOUT_MS: "200",
};

const OPEN_POSITION: AlpacaPosition = {
  asset_id: "fixture-asset-id",
  symbol: "AAPL",
  exchange: "NASDAQ",
  asset_class: "us_equity",
  qty: "2",
  avg_entry_price: "190",
  side: "long",
  market_value: "390",
  cost_basis: "380",
  unrealized_pl: "10",
  unrealized_plpc: "0.0263",
  current_price: "195",
  lastday_price: "194",
  change_today: "0.005",
};

const ACCOUNT = {
  id: "fixture-account-id",
  account_number: "PA12345678",
  status: "ACTIVE",
  currency: "USD",
  cash: "50000",
  portfolio_value: "100000",
};

type FetchView = { url: URL; method: string; body: string | undefined };
type FetchHandler = (request: FetchView) => Response | Promise<Response>;
type TestHttpOptions = Pick<AlpacaHttpOptions, "maxRetryDelayMs" | "retryBaseDelayMs" | "sleepImpl">;

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(handler: FetchHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    return handler({
      url: new URL(String(input)),
      method: String(init?.method ?? "GET"),
      body,
    });
  }) as typeof fetch;
}

function makeConfig(retryMax = 1): AlpacaRuntimeConfig {
  return { ...loadAlpacaTradeConfig(ENV), retryMax, timeoutMs: 200 };
}

function makeHttp(
  fetchImpl: typeof fetch,
  retryMax = 1,
  options: TestHttpOptions = {},
): AlpacaHttp {
  const config = makeConfig(retryMax);
  return new AlpacaHttp({
    config,
    fetchImpl,
    bucket: new TokenBucket(10_000, 10_000),
    ...options,
  });
}

function makeAdapter(fetchImpl: typeof fetch, retryMax = 1): AlpacaBrokerAdapter {
  const config = makeConfig(retryMax);
  const client = new AlpacaPrivateClient({
    config,
    credentials: { apiKey: "fixture-key", apiSecret: "fixture-secret" },
    http: new AlpacaHttp({
      config,
      fetchImpl,
      bucket: new TokenBucket(10_000, 10_000),
      retryBaseDelayMs: 0,
    }),
  });
  return new AlpacaBrokerAdapter("testnet", {
    env: ENV,
    publicConfig: loadAlpacaPublicConfig(ENV),
    tradeConfig: config,
    privateClient: client,
  });
}

beforeEach(() => {
  clearAlpacaPrivateAuditForTests();
  setAuditTransportForTests(async () => undefined);
});

afterEach(() => {
  setAuditTransportForTests(null);
});

test("Positions-GET 503/429 fail closed: getPositions, getAccount und verifyFlat werfen BrokerError", async () => {
  const positionStatuses = [503, 429, 503];
  let positionReads = 0;
  const fetchImpl = mockFetch(({ url, method }) => {
    if (method === "GET" && url.pathname === "/v2/account") return response(ACCOUNT);
    if (method === "GET" && url.pathname === "/v2/positions") {
      const status = positionStatuses[positionReads++] ?? 503;
      return response({ code: status, message: "fixture unavailable" }, status);
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  const adapter = makeAdapter(fetchImpl);

  await assert.rejects(() => adapter.getPositions(), BrokerError);
  await assert.rejects(() => adapter.getAccount(), BrokerError);
  await assert.rejects(() => adapter.verifyFlat(), BrokerError);
  assert.equal(positionReads, 3);
});

test("Malformed positions response is a BrokerError, never an empty/flat snapshot", async () => {
  const adapter = makeAdapter(
    mockFetch(({ url }) => {
      if (url.pathname === "/v2/positions") return response({ positions: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }),
  );

  await assert.rejects(() => adapter.getPositions(), BrokerError);
  await assert.rejects(() => adapter.verifyFlat(), BrokerError);
});

test("Malformed open position row is not silently filtered into a false-flat result", async () => {
  const adapter = makeAdapter(
    mockFetch(({ url }) => {
      if (url.pathname === "/v2/positions") {
        return response([{ ...OPEN_POSITION, qty: "not-a-number" }]);
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }),
  );

  await assert.rejects(() => adapter.getPositions(), BrokerError);
  await assert.rejects(() => adapter.verifyFlat(), BrokerError);
});

test("Close always DELETEs positions after failed preflight; 207/empty response is verified by GET", async () => {
  const calls: FetchView[] = [];
  let positionReads = 0;
  const fetchImpl = mockFetch((request) => {
    calls.push(request);
    if (request.method === "DELETE" && request.url.pathname === "/v2/orders") {
      // Cancel is best-effort and may fail without blocking the liquidate call.
      return response({ code: 503, message: "cancel unavailable" }, 503);
    }
    if (request.method === "GET" && request.url.pathname === "/v2/positions") {
      positionReads += 1;
      return positionReads === 1
        ? response({ code: 429, message: "rate limited" }, 429)
        : response([], 200);
    }
    if (request.method === "DELETE" && request.url.pathname === "/v2/positions") {
      return response([], 207);
    }
    throw new Error(`Unexpected request ${request.method} ${request.url.pathname}`);
  });
  const adapter = makeAdapter(fetchImpl);

  assert.deepEqual(await adapter.closeAllPositions("ASA-03-test"), []);
  const closeRequest = calls.find(
    (request) => request.method === "DELETE" && request.url.pathname === "/v2/positions",
  );
  assert.ok(closeRequest, "DELETE /v2/positions muss trotz fehlgeschlagenem Vorab-GET laufen");
  assert.equal(closeRequest.url.searchParams.get("cancel_orders"), "true");
  assert.equal(closeRequest.url.search, "?cancel_orders=true");
  assert.equal(positionReads, 2, "Vorher- und Nachher-Snapshot wurden versucht");
  assert.ok(
    readAlpacaPrivateAudit(20).some(
      (entry) => entry.method === "DELETE" && entry.path === "/v2/orders" && entry.outcome === "ERROR",
    ),
    "Best-effort-Cancel-Fehler ist auditiert",
  );
});

test("Close wirft BrokerError, wenn der strikte Nachher-GET nach dem DELETE fehlschlägt", async () => {
  const calls: FetchView[] = [];
  let positionReads = 0;
  const adapter = makeAdapter(
    mockFetch((request) => {
      calls.push(request);
      if (request.method === "DELETE" && request.url.pathname === "/v2/orders") return response([], 200);
      if (request.method === "GET" && request.url.pathname === "/v2/positions") {
        positionReads += 1;
        return positionReads === 1
          ? response([OPEN_POSITION], 200)
          : response({ code: 503, message: "post-close verification unavailable" }, 503);
      }
      if (request.method === "DELETE" && request.url.pathname === "/v2/positions") {
        return response([{ symbol: "AAPL", status: "closed" }], 207);
      }
      throw new Error(`Unexpected request ${request.method} ${request.url.pathname}`);
    }),
  );

  await assert.rejects(() => adapter.closeAllPositions("ASA-03-test"), BrokerError);
  assert.ok(
    calls.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.pathname === "/v2/positions" &&
        request.url.searchParams.get("cancel_orders") === "true",
    ),
    "Liquidierungs-DELETE wurde vor der Nachkontrolle gesendet",
  );
});

test("429 respektiert Retry-After: 1 und wartet mindestens eine Sekunde", async () => {
  let calls = 0;
  const http = makeHttp(
    mockFetch(() => {
      calls += 1;
      return calls === 1
        ? response({ code: 429, message: "rate limited" }, 429, { "Retry-After": "1" })
        : response({ ok: true });
    }),
    2,
    { maxRetryDelayMs: 1_500, retryBaseDelayMs: 0 },
  );
  const startedAt = Date.now();

  await http.request({ method: "GET", base: ENV.ALPACA_TRADE_BASE_URL!, path: "/retry-after" });

  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 1_000, "Retry darf nicht vor Retry-After starten");
});

test("Retry-After parst Dezimal-Sekunden und HTTP-Datum und begrenzt beide Delays", async () => {
  const delays: number[] = [];
  const futureDate = new Date(Date.now() + 5_000).toUTCString();
  let calls = 0;
  const http = makeHttp(
    mockFetch(() => {
      calls += 1;
      if (calls === 1) return response({ code: 429 }, 429, { "Retry-After": "0.25" });
      if (calls === 2) return response({ code: 503 }, 503, { "Retry-After": futureDate });
      return response({ ok: true });
    }),
    3,
    {
      maxRetryDelayMs: 1_000,
      retryBaseDelayMs: 0,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    },
  );

  await http.request({ method: "GET", base: ENV.ALPACA_TRADE_BASE_URL!, path: "/retry-after-formats" });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 1_000]);
});

test("Ambiguous POST timeout is not retried without body client_order_id; keyed POST may retry", async () => {
  const timeout = () => {
    const error = new Error("fixture timeout");
    error.name = "AbortError";
    return error;
  };
  let unsafeCalls = 0;
  const unsafeHttp = makeHttp(
    mockFetch(() => {
      unsafeCalls += 1;
      throw timeout();
    }),
    3,
    { retryBaseDelayMs: 0, sleepImpl: async () => undefined },
  );

  await assert.rejects(
    () =>
      unsafeHttp.request({
        method: "POST",
        base: ENV.ALPACA_TRADE_BASE_URL!,
        path: "/v2/orders",
        body: JSON.stringify({ symbol: "AAPL", qty: "1" }),
        headers: { "Idempotency-Key": "header-alone-is-not-proof" },
        idempotent: true,
      }),
    BrokerError,
  );
  assert.equal(unsafeCalls, 1, "Caller-Hint oder Header darf den POST ohne Body-Key nicht wiederholen");

  let safeCalls = 0;
  const bodies: Record<string, unknown>[] = [];
  const safeHttp = makeHttp(
    mockFetch(({ body }) => {
      safeCalls += 1;
      bodies.push(JSON.parse(body ?? "{}") as Record<string, unknown>);
      if (safeCalls === 1) throw timeout();
      return response({ id: "order-1" });
    }),
    2,
    { retryBaseDelayMs: 0, sleepImpl: async () => undefined },
  );

  await safeHttp.request({
    method: "POST",
    base: ENV.ALPACA_TRADE_BASE_URL!,
    path: "/v2/orders",
    body: JSON.stringify({ symbol: "AAPL", qty: "1", client_order_id: "asa03-order-1" }),
  });
  assert.equal(safeCalls, 2);
  assert.equal(bodies[0].client_order_id, "asa03-order-1");
});

test("AlpacaPrivateClient sendet client_order_id im POST-Body an Alpaca", async () => {
  const sentBodies: Record<string, unknown>[] = [];
  const config = makeConfig();
  const client = new AlpacaPrivateClient({
    config,
    credentials: { apiKey: "fixture-key", apiSecret: "fixture-secret" },
    http: makeHttp(
      mockFetch(({ body }) => {
        sentBodies.push(JSON.parse(body ?? "{}") as Record<string, unknown>);
        return response({ id: "order-1", symbol: "AAPL", client_order_id: "asa03-order-1" });
      }),
    ),
  });

  await client.placeOrder(
    { symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", qty: "1" },
    "asa03-order-1",
  );
  assert.equal(sentBodies[0]?.client_order_id, "asa03-order-1");
});

/**
 * Unit-Tests (Task 02): Health-Flag-Semantik und Remote-Check-Kern.
 * `BROKER_HEALTHCHECK_REMOTE` ist Default OFF — Sicherheitsinvariante
 * (kein Netzwerk ohne explizite Betreiber-Entscheidung).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  REMOTE_HEALTHCHECK_FLAG,
  remoteHealthCheckEnabled,
  runRemoteHealthCheck,
} from "../src/brokers/health";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.BROKER_HEALTHCHECK_REMOTE;
});

test("Flag-Default: nicht gesetzt / leer / 'false' / 'off' => OFF", () => {
  assert.equal(REMOTE_HEALTHCHECK_FLAG, "BROKER_HEALTHCHECK_REMOTE");
  delete process.env.BROKER_HEALTHCHECK_REMOTE;
  assert.equal(remoteHealthCheckEnabled(), false, "nicht gesetzt = OFF");
  assert.equal(remoteHealthCheckEnabled({}), false, "leeres Env = OFF");
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "" }), false);
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "false" }), false);
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "off" }), false);
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "1" }), false, "nur exakt 'true'");
});

test("Flag AN: nur exakt 'true' schaltet den Remote-Check ein", () => {
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "true" }), true);
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  assert.equal(remoteHealthCheckEnabled(), true, "aus process.env lesbar");
  delete process.env.BROKER_HEALTHCHECK_REMOTE;
});

test("runRemoteHealthCheck: Flag OFF => null (kein Netzwerk, kein Aufruf)", async () => {
  delete process.env.BROKER_HEALTHCHECK_REMOTE;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  assert.equal(await runRemoteHealthCheck("BINANCE"), null, "Flag OFF => null");
  assert.equal(await runRemoteHealthCheck("KRAKEN"), null);
  assert.equal(fetchCalls, 0, "kein einziger fetch-Aufruf");
});

test("runRemoteHealthCheck: Flag AN, Venue ohne Checker => null", async () => {
  assert.equal(await runRemoteHealthCheck("ALPACA", { BROKER_HEALTHCHECK_REMOTE: "true" }), null);
  assert.equal(await runRemoteHealthCheck("IBKR", { BROKER_HEALTHCHECK_REMOTE: "true" }), null);
  assert.equal(await runRemoteHealthCheck("DYDX", { BROKER_HEALTHCHECK_REMOTE: "true" }), null);
  assert.equal(await runRemoteHealthCheck("PAPER", { BROKER_HEALTHCHECK_REMOTE: "true" }), null);
});

test("runRemoteHealthCheck: Flag AN, BINANCE online (gestubbt)", async () => {
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  const res = await runRemoteHealthCheck("BINANCE", { BROKER_HEALTHCHECK_REMOTE: "true" });
  assert.ok(res);
  assert.equal(res.status, "online");
  assert.equal(res.details.endpoint, "public-ping");
  assert.equal(typeof res.details.latencyMs, "number");
});

test("runRemoteHealthCheck: Flag AN, BINANCE HTTP-Fehler => degraded", async () => {
  globalThis.fetch = (async () => new Response("err", { status: 503 })) as typeof fetch;
  const res = await runRemoteHealthCheck("BINANCE", { BROKER_HEALTHCHECK_REMOTE: "true" });
  assert.ok(res);
  assert.equal(res.status, "degraded");
  assert.equal(res.details.httpStatus, 503);
});

test("runRemoteHealthCheck: Netzwerkfehler => offline + redigierte Meldung", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch failed postgresql://u:p@10.1.1.1:5432/x");
  }) as typeof fetch;
  const res = await runRemoteHealthCheck("BINANCE", { BROKER_HEALTHCHECK_REMOTE: "true" });
  assert.ok(res);
  assert.equal(res.status, "offline");
  assert.equal(res.details.reason, "REMOTE_CHECK_FAILED");
  const err = String(res.details.error);
  assert.ok(!/postgresql:|10\.1\.1\.1|u:p/.test(err), `Leak-Schutz: ${err}`);
});

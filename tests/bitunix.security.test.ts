/**
 * Sicherheits-Regressionen für den Bitunix-Live-Pfad (Broker-Anbindung-Audit):
 *
 *   1. Kill-Switch + Code-Guardrails greifen UNMITTELBAR vor jeder echten
 *      Order in `BrokerExecutionEngine.submit` (vorher: gar nicht — die Datei
 *      importierte riskGuard überhaupt nicht).
 *   2. `place_order` (POST, nicht idempotent) wird bei Timeout/Netzwerkfehler/
 *      5xx NICHT wiederholt (Doppel-Order-Gefahr); nur 429 bleibt Retry-fähig.
 *   3. Der zentrale Live-Gate-Enforcer konsultiert AUCH den prozessweiten
 *      Not-Halt (riskGuard.killSwitch, /api/firm/kill) — vorher nur die
 *      dateibasierte Kill-Sperre.
 *   4. `credentialStatus()` behauptet keine Rechte mehr, die es nie geprüft
 *      hat, und die Logger-Redaction-Liste wird deterministisch (synchron mit
 *      dem Credential-Laden) befüllt — kein Fire-and-Forget-Fenster.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BitunixBrokerAdapter } from "../src/brokers/bitunix/adapter";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { BitunixApiError } from "../src/brokers/bitunix/errors";
import { BitunixHttp } from "../src/brokers/bitunix/http";
import { BrokerExecutionEngine } from "../src/brokers/bitunix/execution";
import { EnvSecretStore } from "../src/brokers/bitunix/secrets";
import type { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import { evaluateLiveOrder } from "../src/live-gate/enforcer";

const dirs: string[] = [];
after(() => {
  killSwitch.disarm();
  resetRuntimeLimits();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "bitunix-sec-"));
  dirs.push(d);
  return d;
}

const TICKER = {
  symbol: "BTCUSDT",
  price: 60000,
  source: "bitunix",
  markPrice: 60000,
  quoteVol: 1_000_000,
  ts: Date.now(),
};

/** Fake-Private-Client mit Zählern: dokumentiert, ob eine Order die Venue erreicht. */
function fakeClient(opts?: { failAccount?: boolean }) {
  const calls = { place: 0, getAccount: 0, getPositions: 0 };
  const client = {
    placeSerializedOrder: async () => {
      calls.place += 1;
      return { orderId: "BX-LIVE-SEC-1" };
    },
    getAccount: async () => {
      calls.getAccount += 1;
      if (opts?.failAccount) throw new BitunixApiError("unknown", "Konto-Abruf fehlgeschlagen.");
      return {
        equity: 10_000,
        cash: 10_000,
        walletBalance: 10_000,
        availableCash: 10_000,
        usedMargin: 0,
        maintenanceMargin: 0,
        unrealizedPnl: 0,
        openPositions: 0,
        startingEquity: 10_000,
        drawdownPct: 0,
      };
    },
    getPositions: async () => {
      calls.getPositions += 1;
      return [];
    },
  } as unknown as BitunixPrivateClient;
  return { client, calls };
}

const ORDER = {
  symbol: "BTCUSDT",
  side: "LONG" as const,
  qty: 0.01,
  riskNotional: 600, // 6 % der Equity — unter dem 25-%-Cap
  stopLoss: 57_000,
};

test("Live-Engine: armierter Kill-Switch (/api/firm/kill) stoppt die Order VOR dem Senden", async () => {
  const { client, calls } = fakeClient();
  const engine = new BrokerExecutionEngine(client);
  killSwitch.pull("test:not-halt");
  try {
    const res = await engine.submit(ORDER, TICKER);
    assert.equal(res.status, "REJECTED");
    assert.equal(res.reason, "KILL_SWITCH_ARMED");
    assert.equal(calls.place, 0, "keine Order darf die Venue erreichen");
  } finally {
    killSwitch.disarm();
  }
});

test("Live-Engine: Code-Guardrails rechnen gegen die ECHTE Konto-Equity", async () => {
  const { client, calls } = fakeClient();
  const engine = new BrokerExecutionEngine(client);

  // H1 FIX: Guard nutzt estimatedNotional = qty*Preis (nicht riskNotional).
  // Daher qty groß wählen, um die 25-%-Cap (2500) zu reißen: 0.1 * 60000 = 6000 > 2500.
  // riskNotional 5_000 ist irrelevant — server-seitig wird 6000 geprüft.
  const oversized = await engine.submit({ ...ORDER, qty: 0.1, riskNotional: 6_000 }, TICKER);
  assert.equal(oversized.status, "REJECTED");
  assert.match(oversized.reason ?? "", /position-size/);

  // Pflicht-Stop-Loss fehlt → REJECT.
  const noStop = await engine.submit({ ...ORDER, stopLoss: undefined }, TICKER);
  assert.equal(noStop.status, "REJECTED");
  assert.match(noStop.reason ?? "", /stop-loss/);

  assert.equal(calls.place, 0, "abgewiesene Orders erreichen die Venue nie");

  // Regelkonforme Order passiert die Schutzkette und wird gesendet — aber
  // die Venue-Annahme ist KEIN Fill: Status NEW (H3), nicht FILLED.
  const ok = await engine.submit(ORDER, TICKER);
  assert.equal(ok.status, "NEW", "akzeptierte Live-Order ist NEW, nicht FILLED");
  assert.equal(ok.fillPrice, 0, "kein fiktiver Fill-Preis bei NEW");
  assert.equal(ok.reason, "ORDER_ACCEPTED");
  assert.equal(calls.place, 1);
});

test("Live-Engine: fail-closed — scheitert der Konto-Abruf, wird NICHT gesendet", async () => {
  const { client, calls } = fakeClient({ failAccount: true });
  const engine = new BrokerExecutionEngine(client);
  await assert.rejects(() => engine.submit(ORDER, TICKER), BitunixApiError);
  assert.equal(calls.place, 0, "ohne belegbare Equity keine Order");
});

test("Transport: nicht-idempotenter POST wird bei 5xx/Timeout/429 NICHT automatisch wiederholt (H4)", async () => {
  const cfg = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: "http://127.0.0.1:9",
    BITUNIX_RETRY_MAX: "3",
    BITUNIX_TIMEOUT_MS: "200",
  });
  const PATH = "/api/v1/futures/trade/place_order";
  const isAmbiguous = (e: unknown) =>
    e instanceof BitunixApiError && (e as BitunixApiError).kind === "ambiguous";

  // 5xx: ambivalent (Order kann serverseitig angekommen sein) → exakt 1 Versuch,
  // aufgeschlüsselt als "ambiguous" (H4: Aufrufer muss per clientOrderId queryen).
  let hits5xx = 0;
  const http5xx = new BitunixHttp({
    config: cfg,
    fetchImpl: (async () => {
      hits5xx += 1;
      return new Response(JSON.stringify({ code: 1, msg: "boom" }), { status: 503 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => http5xx.request({ method: "POST", path: PATH, body: "{}", idempotent: false }),
    isAmbiguous
  );
  assert.equal(hits5xx, 1, "kein Auto-Retry eines nicht-idempotenten POST bei 5xx");

  // Netzwerkfehler: ebenso ambivalent → exakt 1 Versuch, "ambiguous".
  let hitsNet = 0;
  const httpNet = new BitunixHttp({
    config: cfg,
    fetchImpl: (async () => {
      hitsNet += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => httpNet.request({ method: "POST", path: PATH, body: "{}", idempotent: false }),
    isAmbiguous
  );
  assert.equal(hitsNet, 1, "kein Auto-Retry eines nicht-idempotenten POST bei Netzwerkfehler");

  // 429: NIE blind wiederholen (H4) — der Aufrufer entscheidet nach einem
  // clientOrderId-Status-Query. Der Transport stellt nur "ambiguous" bereit.
  let hits429 = 0;
  const http429 = new BitunixHttp({
    config: cfg,
    fetchImpl: (async () => {
      hits429 += 1;
      return new Response(JSON.stringify({ code: 1, msg: "rate" }), { status: 429 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => http429.request({ method: "POST", path: PATH, body: "{}", idempotent: false }),
    isAmbiguous
  );
  assert.equal(hits429, 1, "kein Auto-Retry eines nicht-idempotenten POST bei 429");

  // Gegenprobe: idempotenter GET wiederholt bei 5xx weiterhin.
  let hitsGet = 0;
  const httpGet = new BitunixHttp({
    config: cfg,
    fetchImpl: (async () => {
      hitsGet += 1;
      return new Response(JSON.stringify({ code: 1, msg: "boom" }), { status: 503 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => httpGet.request({ method: "GET", path: "/api/v1/futures/market/tickers" }),
    BitunixApiError
  );
  assert.equal(hitsGet, 3, "GET bleibt idempotent und Retry-fähig");
});

test("Enforcer: der prozessweite Not-Halt (/api/firm/kill) blockiert eine Live-Order", () => {
  const env = { LIVE_GATE_DATA_DIR: tmp() };
  killSwitch.pull("test:firmen-not-halt");
  try {
    const denied = evaluateLiveOrder("BITUNIX", { env, audit: false });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, "KILL_SWITCH_ACTIVE");
    assert.equal(denied.killed, true);
  } finally {
    killSwitch.disarm();
  }
  // Ohne Not-Halt fällt derselbe Aufruf auf den nächsten Deny-Grund zurück —
  // der Kill-Check dominiert also wirklich, statt zufällig zu greifen.
  const after = evaluateLiveOrder("BITUNIX", { env, audit: false });
  assert.equal(after.code, "STATE_NOT_LIVE_ENABLED");
});

test("credentialStatus: keine behaupteten Rechte ohne Verifikation; verify belegt maximal READ", async () => {
  const env = {
    BITUNIX_ENABLED: "true",
    BITUNIX_API_KEY: "test-key-0123456789abcdef",
    BITUNIX_API_SECRET: "test-secret-0123456789abcdef",
  };
  const { client } = fakeClient();
  const adapter = new BitunixBrokerAdapter("paper", {
    env,
    config: loadBitunixConfig(env),
    secretStore: new EnvSecretStore(env),
    privateClient: client,
  });

  // Ohne verify: hinterlegt ≠ verbunden ≠ berechtigt.
  const plain = await adapter.credentialStatus();
  assert.equal(plain.configured, true);
  assert.equal(plain.connected, false);
  assert.deepEqual(plain.permissions, []);
  assert.equal(plain.permissionsVerified, false);

  // Mit verify: read-only Konto-Abruf belegt READ — und nur READ (TRADE wäre
  // nur durch eine echte Order beweisbar; Bitunix' Account-Antwort weist keine
  // Handelsberechtigung aus).
  const verified = await adapter.credentialStatus({ verify: true });
  assert.equal(verified.connected, true);
  assert.deepEqual(verified.permissions, ["READ"]);
  assert.equal(verified.permissionsVerified, true);

  // Deterministisches Redaction-Fenster: synchron mit dem Credential-Laden
  // stehen die Klartexte in der Maskierliste des Loggers — kein Race.
  const cache = (adapter as unknown as { redactionSecrets: string[] }).redactionSecrets;
  assert.ok(cache.includes(env.BITUNIX_API_KEY));
  assert.ok(cache.includes(env.BITUNIX_API_SECRET));
});

test("credentialStatus: fail-closed — scheitert der verify-Abruf, wird KEIN Recht gemeldet", async () => {
  const env = {
    BITUNIX_ENABLED: "true",
    BITUNIX_API_KEY: "test-key-0123456789abcdef",
    BITUNIX_API_SECRET: "test-secret-0123456789abcdef",
  };
  const { client } = fakeClient({ failAccount: true });
  const adapter = new BitunixBrokerAdapter("paper", {
    env,
    config: loadBitunixConfig(env),
    secretStore: new EnvSecretStore(env),
    privateClient: client,
  });
  const status = await adapter.credentialStatus({ verify: true });
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.deepEqual(status.permissions, []);
  assert.equal(status.permissionsVerified, false);
});

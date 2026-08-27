/**
 * Integrationstests (Task 02): `GET /api/brokers` und
 * `GET /api/brokers/{venue}/health`.
 *
 * Kein echter Netzwerkverkehr: Route-Handler werden direkt mit
 * `Request`-Objekten aufgerufen; Remote-Checks sind Default OFF
 * (`BROKER_HEALTHCHECK_REMOTE=false`) und werden bei aktiviertem Flag
 * mit einem gestubten `fetch` deterministisch getestet.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BROKER_VENUE_IDS } from "../src/contracts/broker";

let GET_LIST: (req: Request) => Promise<Response>;
let GET_HEALTH: (
  req: Request,
  ctx: { params: Promise<{ venue: string }> }
) => Promise<Response>;

const realFetch = globalThis.fetch;
before(async () => {
  ({ GET: GET_LIST } = await import("../src/app/api/brokers/route"));
  ({ GET: GET_HEALTH } = await import("../src/app/api/brokers/[venue]/health/route"));
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.BROKER_HEALTHCHECK_REMOTE;
});

async function health(venue: string): Promise<Response> {
  return GET_HEALTH(
    new Request(`http://localhost/api/brokers/${encodeURIComponent(venue)}/health`),
    { params: Promise.resolve({ venue }) }
  );
}

test("API: GET /api/brokers liefert 6 Broker mit capabilities + health", async () => {
  const res = await GET_LIST(new Request("http://localhost/api/brokers"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as unknown as {
    ok: boolean;
    count: number;
    brokers: Array<{
      id: string;
      label: string;
      assets: string;
      capabilities: Record<string, unknown>;
      paperAvailable: boolean;
      liveAvailable: boolean;
      executionModes: Record<string, { available: boolean }>;
      health: { status: string; latencyMs: number; details: Record<string, unknown> };
    }>;
    remoteHealthCheck: { enabled: boolean; flag: string };
  };
  assert.equal(body.ok, true);
  assert.equal(body.count, 6);
  assert.deepEqual(body.brokers.map((b) => b.id).sort(), [...BROKER_VENUE_IDS].sort());
  for (const b of body.brokers) {
    // capabilities-Form:
    for (const k of ["discovery", "marketData", "trading", "paper", "testnet", "live", "stopAtVenue"]) {
      assert.equal(typeof b.capabilities[k], "boolean", `${b.id}.capabilities.${k}`);
    }
    const it = b.capabilities.instrumentTypes as Record<string, unknown>;
    for (const k of ["spot", "perpetual", "future", "option"]) {
      assert.equal(typeof it[k], "boolean", `${b.id}.instrumentTypes.${k}`);
    }
    // Registry-Projektion in der Antwort:
    assert.equal(typeof b.paperAvailable, "boolean");
    assert.equal(b.liveAvailable, false, `${b.id}: liveAvailable=false (Stadium)`);
    assert.equal(b.paperAvailable, b.id === "PAPER");
    // Health-Form:
    assert.ok(["online", "degraded", "offline"].includes(b.health.status), `${b.id}: health-Enum`);
    assert.equal(typeof b.health.latencyMs, "number");
    // PAPER online (lokale Simulation), Stubs offline (ehrliche Ist-Lage):
    if (b.id === "PAPER") assert.equal(b.health.status, "online");
    else assert.equal(b.health.status, "offline");
    // Execution-Modi: live ist prinzipiell nie verfügbar:
    assert.equal(b.executionModes.live.available, false, `${b.id}: live gesperrt`);
  }
  // Remote-Health ist Default OFF:
  assert.equal(body.remoteHealthCheck.enabled, false);
  assert.equal(body.remoteHealthCheck.flag, "BROKER_HEALTHCHECK_REMOTE");
});

test("API: GET /api/brokers/PAPER/health → 200, online (lokal)", async () => {
  const res = await health("PAPER");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    venue: string;
    health: { status: string; details: Record<string, unknown> };
    remoteHealthCheck: { enabled: boolean };
  };
  assert.equal(body.ok, true);
  assert.equal(body.venue, "PAPER");
  assert.equal(body.health.status, "online");
  assert.equal(body.health.details.simulated, true);
  assert.equal(body.remoteHealthCheck.enabled, false);
});

test("API: GET /api/brokers/ALPACA/health → 200, offline + Grund (Remote default OFF)", async () => {
  const res = await health("ALPACA");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    venue: string;
    health: { status: string; details: Record<string, unknown> };
  };
  assert.equal(body.ok, true);
  assert.equal(body.venue, "ALPACA");
  assert.equal(body.health.status, "offline");
  assert.equal(body.health.details.implemented, false);
  assert.match(String(body.health.details.remoteCheck), /deaktiviert/);
});

test("API: Venue-Normalisierung (kleinschreibung) + Unbekannte Venues → 404", async () => {
  const lower = await health("paper");
  assert.equal(lower.status, 200);
  assert.equal(((await lower.json()) as { venue: string }).venue, "PAPER");

  for (const bad of ["BITUNIX", "NOPE", "PAPER%20X", ".."]) {
    const res = await health(bad.replace("%20", " "));
    assert.equal(res.status, 404, `${bad}: 404 erwartet`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "UNKNOWN_VENUE");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Remote-Checks (Flag AN, gestubter fetch — kein echtes Netzwerk)
// ─────────────────────────────────────────────────────────────────────────────

test("API: Remote-Check AN: BINANCE public ping → online (gestubbt)", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const res = await health("BINANCE");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    health: { status: string; details: Record<string, unknown> };
    remoteHealthCheck: { enabled: boolean };
  };
  assert.equal(body.ok, true);
  assert.equal(body.health.status, "online");
  assert.equal(body.health.details.endpoint, "public-ping");
  assert.equal(body.remoteHealthCheck.enabled, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.binance\.com\/api\/v3\/ping$/);
});

test("API: Remote-Check AN: KRAKEN public Time → online (gestubbt)", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: [] }), { status: 200 })) as typeof fetch;

  const res = await health("KRAKEN");
  const body = (await res.json()) as { health: { status: string; details: Record<string, unknown> } };
  assert.equal(res.status, 200);
  assert.equal(body.health.status, "online");
  assert.equal(body.health.details.endpoint, "public-time");
});

test("API: Remote-Check AN: ALPACA/IBKR/DYDX → degraded mit Grund, KEIN Netzwerk", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const expectReason = async (venue: string, reason: string) => {
    const res = await health(venue);
    assert.equal(res.status, 200, venue);
    const body = (await res.json()) as { health: { status: string; details: Record<string, unknown> } };
    assert.equal(body.health.status, "degraded", `${venue}: degraded erwartet`);
    assert.equal(body.health.details.reason, reason, venue);
  };

  await expectReason("ALPACA", "CREDENTIALS_REQUIRED");
  await expectReason("IBKR", "GATEWAY_REQUIRED");
  await expectReason("DYDX", "REMOTE_CHECK_NOT_IMPLEMENTED");
  // Credentials/Gateway-freie Venues stellen NIEMALS Requests:
  assert.equal(fetchCalls, 0, "ALPACA/IBKR/DYDX dürfen ohne Credentials kein Netzwerk nutzen");
});

test("API: Remote-Check AN: Ausfall → offline mit redigierter Meldung", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  globalThis.fetch = (async () => {
    throw new Error(
      "connect ECONNREFUSED postgresql://secret-user:secret-pw@10.0.0.1:5432/internal"
    );
  }) as typeof fetch;

  const res = await health("BINANCE");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    health: { status: string; details: Record<string, unknown> };
  };
  assert.equal(body.health.status, "offline");
  assert.equal(body.health.details.reason, "REMOTE_CHECK_FAILED");
  const err = String(body.health.details.error);
  assert.ok(err.length > 0, "Fehlermeldung vorhanden");
  // Kein Leak von Credential-/Infrastruktur-Details:
  assert.ok(!/postgresql:|secret-user|secret-pw|10\.0\.0\.1/.test(err), `Leak-Schutz: ${err}`);
});

test("API: Remote-Check AN: KRAKEN mit nicht-JSON-Antwort → degraded (keine Exception)", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;

  const res = await health("KRAKEN");
  const body = (await res.json()) as { health: { status: string; details: Record<string, unknown> } };
  assert.equal(res.status, 200);
  assert.equal(body.health.status, "degraded");
  assert.equal(body.health.details.reason, "UNEXPECTED_RESPONSE");
});

test("API: Remote-Check AN: KRAKEN mit ungültiger Antwort → degraded", async () => {
  process.env.BROKER_HEALTHCHECK_REMOTE = "true";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: ["E:]General:Error"] }), { status: 200 })) as typeof fetch;

  const res = await health("KRAKEN");
  const body = (await res.json()) as { health: { status: string; details: Record<string, unknown> } };
  assert.equal(res.status, 200);
  assert.equal(body.health.status, "degraded");
  assert.equal(body.health.details.reason, "UNEXPECTED_RESPONSE");
});

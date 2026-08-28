/**
 * API-Tests der Broker Control Plane (Task 08).
 *
 * Testet die Route-Handler direkt (kein Netzwerk): RBAC (nicht-Admin → 403),
 * CSRF (ohne Token → 403), Rate-Limit (5/min → 429), status-only-Vertrag
 * (kein keyHint, keine Secret-Echos), Fehler-Contract 404/409/422.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySecretStorage,
  clearControlPlaneAuditForTests,
  createAesGcmSecretStore,
  resetControlPlaneForTests,
  resetCredentialRateLimiterForTests,
  setControlPlaneSecretStoreForTests,
} from "../src/brokers/control-plane";
import { scanJsonBody, scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

type Ctx = { params: Promise<{ venue: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let POST_CRED: Handler;
let DELETE_CRED: Handler;
let GET_STATUS: Handler;
let POST_TEST: Handler;
let POST_DISCOVER: Handler;

const VALID = {
  apiKey: "k-api-test-abcdef01234567",
  apiSecret: "s-api-test-abcdef01234567",
};

const CSRF = { "x-csrf-token": "local" };

before(async () => {
  ({ POST: POST_CRED, DELETE: DELETE_CRED } = await import(
    "../src/app/api/brokers/[venue]/credentials/route"
  ));
  ({ GET: GET_STATUS } = await import("../src/app/api/brokers/[venue]/status/route"));
  ({ POST: POST_TEST } = await import("../src/app/api/brokers/[venue]/test/route"));
  ({ POST: POST_DISCOVER } = await import("../src/app/api/brokers/[venue]/discover/route"));
});

beforeEach(() => {
  resetControlPlaneForTests();
  resetCredentialRateLimiterForTests();
  clearControlPlaneAuditForTests();
  setControlPlaneSecretStoreForTests(
    createAesGcmSecretStore({
      storage: new MemorySecretStorage(),
      keyBuffer: Buffer.alloc(32, 6),
    })
  );
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.BROKER_CREDENTIAL_RATE_LIMIT;
  delete process.env.SECRET_STORE_KEY;
});

after(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.BROKER_CREDENTIAL_RATE_LIMIT;
});

function credReq(venue: string, body: unknown, headers: Record<string, string> = CSRF): Request {
  return new Request(`http://localhost/api/brokers/${venue}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function postReq(venue: string, path: string, headers: Record<string, string> = CSRF): Request {
  return new Request(`http://localhost/api/brokers/${venue}/${path}`, {
    method: "POST",
    headers,
  });
}

function delReq(venue: string, headers: Record<string, string> = CSRF): Request {
  return new Request(`http://localhost/api/brokers/${venue}/credentials`, {
    method: "DELETE",
    headers,
  });
}

// ── CSRF ────────────────────────────────────────────────────────────────────

test("CSRF: POST/DELETE ohne x-csrf-token → 403 CSRF_INVALID", async () => {
  const res = await POST_CRED(credReq("BITUNIX", VALID, {}), { params: Promise.resolve({ venue: "BITUNIX" }) });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "CSRF_INVALID");

  const res2 = await DELETE_CRED(delReq("BITUNIX", {}), { params: Promise.resolve({ venue: "BITUNIX" }) });
  assert.equal(res2.status, 403);
});

test("CSRF: falscher Wert → 403; korrekter Wert (local, Offen-Betrieb) → durch", async () => {
  const bad = await POST_CRED(
    credReq("BITUNIX", VALID, { "x-csrf-token": "falsch" }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(bad.status, 403);
  const ok = await POST_CRED(credReq("BITUNIX", VALID), {
    params: Promise.resolve({ venue: "BITUNIX" }),
  });
  assert.equal(ok.status, 200);
});

// ── RBAC ────────────────────────────────────────────────────────────────────

test("RBAC: FIRM_ADMIN_TOKEN gesetzt — ohne/falscher x-admin-token → 403 FORBIDDEN", async () => {
  process.env.FIRM_ADMIN_TOKEN = "admin-secret-token-123456";
  const noHeader = await POST_CRED(credReq("BITUNIX", VALID), {
    params: Promise.resolve({ venue: "BITUNIX" }),
  });
  assert.equal(noHeader.status, 403);
  assert.equal(((await noHeader.json()) as { error: string }).error, "FORBIDDEN");

  const wrong = await POST_CRED(
    credReq("BITUNIX", VALID, {
      ...CSRF,
      "x-admin-token": "falscher-token-000000",
      "x-csrf-token": "admin-secret-token-123456",
    }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(wrong.status, 403);
});

test("RBAC: korrekter x-admin-token (oder x-firm-token) → erlaubt; CSRF-Wert = Admin-Token", async () => {
  process.env.FIRM_ADMIN_TOKEN = "admin-secret-token-123456";
  const viaAdmin = await POST_CRED(
    credReq("BITUNIX", VALID, {
      "x-admin-token": "admin-secret-token-123456",
      "x-csrf-token": "admin-secret-token-123456",
    }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(viaAdmin.status, 200);

  const viaFirm = await POST_CRED(
    credReq("BITUNIX", VALID, {
      "x-firm-token": "admin-secret-token-123456",
      "x-csrf-token": "admin-secret-token-123456",
    }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(viaFirm.status, 409); // bereits verbunden — aber AUTH war ok
});

test("RBAC: FIRM_API_TOKEN als Operator-Fallback — ohne Token → 401", async () => {
  process.env.FIRM_API_TOKEN = "operator-token-abcdef";
  const res = await POST_CRED(
    credReq("BITUNIX", VALID, { "x-csrf-token": "operator-token-abcdef" }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(res.status, 401);
});

// ── Rate-Limit ──────────────────────────────────────────────────────────────

test("Rate-Limit: 6. Credential-Versuch in 60 s → 429 (Limit 5/min/IP)", async () => {
  process.env.BROKER_CREDENTIAL_RATE_LIMIT = "5";
  for (let i = 0; i < 5; i += 1) {
    const res = await POST_CRED(credReq("BINANCE", VALID), {
      params: Promise.resolve({ venue: "BINANCE" }),
    });
    assert.notEqual(res.status, 429, `Versuch ${i + 1} nicht limitiert`);
  }
  const limited = await POST_CRED(credReq("BINANCE", VALID), {
    params: Promise.resolve({ venue: "BINANCE" }),
  });
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: string }).error, "RATE_LIMITED");
});

// ── Status-only-Vertrag ─────────────────────────────────────────────────────

test("Vertrag: POST credentials antwortet status-only — kein Echo, kein keyHint, Scanner leer", async () => {
  const res = await POST_CRED(credReq("BITUNIX", VALID), {
    params: Promise.resolve({ venue: "BITUNIX" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;

  // Secret-Werte duerfen nirgends auftauchen (weder Key noch Secret noch Maskierung):
  assert.ok(!text.includes(VALID.apiKey), "kein apiKey-Echo");
  assert.ok(!text.includes(VALID.apiSecret), "kein apiSecret-Echo");
  assert.ok(!text.includes("keyHint"), "kein keyHint (empfohlen: gar nicht)");
  assert.ok(!text.includes("****"), "keine Maskierungs-Replik");

  const allowedKeys = new Set([
    "ok", "venue", "configured", "connected", "permissions",
    "liveEnabled", "probe", "layers", "state", "at", "detail",
    "errorCode", "message",
  ]);
  for (const key of Object.keys(body)) {
    assert.ok(allowedKeys.has(key), `unerlaubtes Top-Level-Feld: ${key}`);
  }
  assert.equal(body.configured, true);
  assert.equal(body.liveEnabled, false);
  assert.deepEqual(body.permissions, ["READ", "TRADE"]);
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("Vertrag: DELETE antwortet status-only (configured:false, liveEnabled:false)", async () => {
  await POST_CRED(credReq("KRAKEN", VALID), { params: Promise.resolve({ venue: "KRAKEN" }) });
  const res = await DELETE_CRED(delReq("KRAKEN"), { params: Promise.resolve({ venue: "KRAKEN" }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "configured", "connected", "liveEnabled", "ok", "permissions", "venue",
  ]);
  assert.equal(body.configured, false);
  assert.equal(body.connected, false);
  assert.equal(body.liveEnabled, false);
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("Vertrag: GET status liefert 6 Ebenen mit gueltigen Zustaenden, live off", async () => {
  await POST_CRED(credReq("BITUNIX", VALID), { params: Promise.resolve({ venue: "BITUNIX" }) });
  const res = await GET_STATUS(new Request("http://localhost/api/brokers/BITUNIX/status"), {
    params: Promise.resolve({ venue: "BITUNIX" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    connected: boolean;
    liveEnabled: boolean;
    layers: Record<string, { state: string }>;
  };
  assert.equal(body.connected, true);
  assert.equal(body.liveEnabled, false);
  for (const id of ["connection", "marketDiscovery", "permissions", "paper", "testnet", "live"]) {
    assert.ok(["off", "pending", "active", "error"].includes(body.layers[id].state), id);
  }
  assert.equal(body.layers.live.state, "off");
  assert.deepEqual(scanTextForSecrets(text), []);
});

// ── Fehler-Contract ─────────────────────────────────────────────────────────

test("Fehler: PAPER → 422 NO_CREDENTIALS_REQUIRED (kein Secret-Pfad fuer den Simulator)", async () => {
  const res = await POST_CRED(credReq("PAPER", VALID), { params: Promise.resolve({ venue: "PAPER" }) });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, "NO_CREDENTIALS_REQUIRED");
});

test("Fehler: unbekanntes Venue → 404 UNKNOWN_VENUE (alle Endpoints)", async () => {
  const res = await POST_CRED(credReq("HACKER", VALID), { params: Promise.resolve({ venue: "HACKER" }) });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "UNKNOWN_VENUE");

  const res2 = await GET_STATUS(new Request("http://localhost/api/brokers/HACKER/status"), {
    params: Promise.resolve({ venue: "HACKER" }),
  });
  assert.equal(res2.status, 404);
});

test("Fehler: ungueltiger Body → 422 VALIDATION_ERROR; kaputtes JSON → 422", async () => {
  const short = await POST_CRED(
    credReq("ALPACA", { apiKey: "kurz", apiSecret: "auch-kurz" }),
    { params: Promise.resolve({ venue: "ALPACA" }) }
  );
  assert.equal(short.status, 422);
  assert.equal(((await short.json()) as { error: string }).error, "VALIDATION_ERROR");

  const badJson = new Request("http://localhost/api/brokers/ALPACA/credentials", {
    method: "POST",
    headers: { "content-type": "application/json", ...CSRF },
    body: "{kein json",
  });
  const res = await POST_CRED(badJson, { params: Promise.resolve({ venue: "ALPACA" }) });
  assert.equal(res.status, 422);
});

test("Fehler: test ohne Credentials → 409 NO_CREDENTIALS; delete ohne Konfiguration → 409 NOT_CONFIGURED", async () => {
  const res = await POST_TEST(postReq("ALPACA", "test"), { params: Promise.resolve({ venue: "ALPACA" }) });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "NO_CREDENTIALS");

  const res2 = await DELETE_CRED(delReq("ALPACA"), { params: Promise.resolve({ venue: "ALPACA" }) });
  assert.equal(res2.status, 409);
  assert.equal(((await res2.json()) as { error: string }).error, "NOT_CONFIGURED");
});

test("Fehler: discover ohne Adapter-Implementation → 422 DISCOVERY_NOT_IMPLEMENTED", async () => {
  await POST_CRED(credReq("BITUNIX", VALID), { params: Promise.resolve({ venue: "BITUNIX" }) });
  const res = await POST_DISCOVER(postReq("BITUNIX", "discover"), {
    params: Promise.resolve({ venue: "BITUNIX" }),
  });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, "DISCOVERY_NOT_IMPLEMENTED");
});

test("Test-Flow: POST test nach Speichern → 200 mit permissions + liveEnabled:false", async () => {
  await POST_CRED(credReq("BITUNIX", VALID), { params: Promise.resolve({ venue: "BITUNIX" }) });
  const res = await POST_TEST(postReq("BITUNIX", "test"), { params: Promise.resolve({ venue: "BITUNIX" }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    connected: boolean;
    permissions: string[];
    liveEnabled: boolean;
  };
  assert.equal(body.connected, true);
  assert.deepEqual(body.permissions, ["READ", "TRADE"]);
  assert.equal(body.liveEnabled, false);
});

test("Sicherheit: Audit-Ring nach API-Aktionen enthaelt Ereignisse OHNE Secrets", async () => {
  await POST_CRED(credReq("BITUNIX", VALID), { params: Promise.resolve({ venue: "BITUNIX" }) });
  await POST_TEST(postReq("BITUNIX", "test"), { params: Promise.resolve({ venue: "BITUNIX" }) });
  const { readControlPlaneAudit } = await import("../src/brokers/control-plane/audit");
  const entries = readControlPlaneAudit(100);
  assert.ok(entries.length >= 4, "saved/probe/test/transition protokolliert");
  assert.deepEqual(scanJsonBody(entries), []);
});

/**
 * E2E-Test der Broker Control Plane (Task 08) — Voll-Flow ueber die
 * Route-Handler (repo-konform: keine Playwright-Abhaengigkeit, s. Docs).
 *
 * Ablauf: Connect (masked form → POST credentials) → Test → Status sichtbar
 * → Disconnect/Delete. Assertions:
 *   - Secret-Feld bleibt maskiert: KEINE API-Response enthaelt die
 *     eingereichten Secrets (Scanner + Textsuche).
 *   - Live-Chip zeigt "gesperrt/off": liveEnabled IMMER false, Live-Ebene
 *     IMMER off (auch nach erfolgreicher Verbindung).
 *   - Audit-Log enthaelt je Aktion einen Eintrag (actor/venue/result/at).
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySecretStorage,
  clearControlPlaneAuditForTests,
  createAesGcmSecretStore,
  readControlPlaneAudit,
  resetControlPlaneForTests,
  resetCredentialRateLimiterForTests,
  setControlPlaneSecretStoreForTests,
} from "../src/brokers/control-plane";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

type Ctx = { params: Promise<{ venue: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let POST_CRED: Handler;
let DELETE_CRED: Handler;
let GET_STATUS: Handler;
let POST_TEST: Handler;

const VENUE = "BITUNIX";
const SECRET_KEY = "e2e-key-0123456789abcdef";
const SECRET_VALUE = "e2e-secret-0123456789abcdef";

const CSRF = { "x-csrf-token": "local", "content-type": "application/json" };

before(async () => {
  ({ POST: POST_CRED, DELETE: DELETE_CRED } = await import(
    "../src/app/api/brokers/[venue]/credentials/route"
  ));
  ({ GET: GET_STATUS } = await import("../src/app/api/brokers/[venue]/status/route"));
  ({ POST: POST_TEST } = await import("../src/app/api/brokers/[venue]/test/route"));
});

beforeEach(() => {
  resetControlPlaneForTests();
  resetCredentialRateLimiterForTests();
  clearControlPlaneAuditForTests();
  setControlPlaneSecretStoreForTests(
    createAesGcmSecretStore({
      storage: new MemorySecretStorage(),
      keyBuffer: Buffer.alloc(32, 8),
    })
  );
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
});

after(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
});

/** Sammelt jede Response und prueft sie auf Secret-Spuren. */
function assertNoSecretLeak(text: string, step: string) {
  assert.ok(!text.includes(SECRET_KEY), `${step}: kein API-Key-Echo`);
  assert.ok(!text.includes(SECRET_VALUE), `${step}: kein API-Secret-Echo`);
  assert.deepEqual(
    scanTextForSecrets(text),
    [],
    `${step}: Scanner findet keine Secret-Muster`
  );
}

test("E2E: Connect → Test → Status sichtbar → Disconnect/Delete (maskiert, Live off)", async () => {
  // 0) Ausgangslage: nicht konfiguriert, alle Ebenen off.
  const status0 = await GET_STATUS(
    new Request(`http://localhost/api/brokers/${VENUE}/status`),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  assert.equal(status0.status, 200);
  const s0 = (await status0.json()) as {
    configured: boolean;
    connected: boolean;
    liveEnabled: boolean;
  };
  assert.equal(s0.configured, false);
  assert.equal(s0.connected, false);
  assert.equal(s0.liveEnabled, false);

  // 1) Connect: masked form → POST credentials (Secret einmalig).
  const connect = await POST_CRED(
    new Request(`http://localhost/api/brokers/${VENUE}/credentials`, {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({ apiKey: SECRET_KEY, apiSecret: SECRET_VALUE }),
    }),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  assert.equal(connect.status, 200);
  const connectText = await connect.text();
  assertNoSecretLeak(connectText, "connect");
  const connectBody = JSON.parse(connectText) as {
    configured: boolean;
    connected: boolean;
    permissions: string[];
    liveEnabled: boolean;
    probe: { state: string };
  };
  assert.equal(connectBody.configured, true);
  assert.equal(connectBody.connected, true);
  assert.deepEqual(connectBody.permissions, ["READ", "TRADE"]);
  assert.equal(connectBody.liveEnabled, false);
  assert.equal(connectBody.probe.state, "ok");

  // 2) Status sichtbar: 6 Ebenen, Live gesperrt/off.
  const status1 = await GET_STATUS(
    new Request(`http://localhost/api/brokers/${VENUE}/status`),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  assert.equal(status1.status, 200);
  const status1Text = await status1.text();
  assertNoSecretLeak(status1Text, "status");
  const s1 = JSON.parse(status1Text) as {
    connected: boolean;
    permissions: string[];
    liveEnabled: boolean;
    layers: Record<string, { state: string }>;
    discovery: { state: string; count: number };
  };
  assert.equal(s1.connected, true);
  assert.deepEqual(s1.permissions, ["READ", "TRADE"]);
  assert.equal(s1.layers.connection.state, "active");
  assert.equal(s1.layers.permissions.state, "active");
  assert.equal(s1.layers.paper.state, "active");
  assert.equal(s1.layers.live.state, "off", "Live-Chip bleibt gesperrt/off");
  assert.equal(s1.liveEnabled, false);

  // 3) Verbindungstest (read-only Probe).
  const testRes = await POST_TEST(
    new Request(`http://localhost/api/brokers/${VENUE}/test`, {
      method: "POST",
      headers: CSRF,
    }),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  assert.equal(testRes.status, 200);
  const testText = await testRes.text();
  assertNoSecretLeak(testText, "test");
  const testBody = JSON.parse(testText) as { connected: boolean; liveEnabled: boolean };
  assert.equal(testBody.connected, true);
  assert.equal(testBody.liveEnabled, false);

  // 4) Disconnect/Delete: Credential-Referenz entfernen.
  const del = await DELETE_CRED(
    new Request(`http://localhost/api/brokers/${VENUE}/credentials`, {
      method: "DELETE",
      headers: CSRF,
    }),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  assert.equal(del.status, 200);
  const delText = await del.text();
  assertNoSecretLeak(delText, "delete");
  const delBody = JSON.parse(delText) as {
    configured: boolean;
    connected: boolean;
    liveEnabled: boolean;
  };
  assert.equal(delBody.configured, false);
  assert.equal(delBody.connected, false);
  assert.equal(delBody.liveEnabled, false);

  // 5) Zustand zurueckgesetzt, Live weiterhin gesperrt.
  const status2 = await GET_STATUS(
    new Request(`http://localhost/api/brokers/${VENUE}/status`),
    { params: Promise.resolve({ venue: VENUE }) }
  );
  const s2 = (await status2.json()) as {
    connected: boolean;
    liveEnabled: boolean;
    layers: Record<string, { state: string }>;
  };
  assert.equal(s2.connected, false);
  assert.equal(s2.liveEnabled, false);
  assert.equal(s2.layers.live.state, "off");

  // 6) Audit je Aktion — ohne Secrets.
  const audit = readControlPlaneAudit(100);
  const actions = audit.map((entry) => entry.action);
  for (const expected of [
    "credential.saved",
    "permission.probe",
    "state.transition",
    "connection.test",
    "credential.deleted",
  ] as const) {
    assert.ok(actions.includes(expected), `Audit-Aktion ${expected}`);
  }
  assert.deepEqual(scanTextForSecrets(JSON.stringify(audit)), []);
});

test("E2E: PAPER — Verbinden ohne Credentials, Status sichtbar, Live gesperrt", async () => {
  const testRes = await POST_TEST(
    new Request("http://localhost/api/brokers/PAPER/test", {
      method: "POST",
      headers: CSRF,
    }),
    { params: Promise.resolve({ venue: "PAPER" }) }
  );
  assert.equal(testRes.status, 200);
  const body = (await testRes.json()) as {
    connected: boolean;
    permissions: string[];
    liveEnabled: boolean;
  };
  assert.equal(body.connected, true);
  assert.ok(body.permissions.includes("READ"));
  assert.equal(body.liveEnabled, false);

  const status = await GET_STATUS(
    new Request("http://localhost/api/brokers/PAPER/status"),
    { params: Promise.resolve({ venue: "PAPER" }) }
  );
  const s = (await status.json()) as {
    layers: Record<string, { state: string }>;
    liveEnabled: boolean;
  };
  assert.equal(s.layers.connection.state, "active");
  assert.equal(s.layers.live.state, "off");
  assert.equal(s.liveEnabled, false);
});

/**
 * API-Tests Operations Center + /api/auth/me (Task 10, Phase 1).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

let GET_ME: (req: Request) => Promise<Response>;
let GET_OPS: (req: Request) => Promise<Response>;

before(async () => {
  ({ GET: GET_ME } = await import("../src/app/api/auth/me/route"));
  ({ GET: GET_OPS } = await import("../src/app/api/ops/route"));
});

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
  delete process.env.LIVE_TRADING_ENABLED;
  delete process.env.BITUNIX_LIVE_ENABLED;
});

test("GET /api/auth/me: local-open → 200 Admin, keine Token-Felder", async () => {
  const res = await GET_ME(new Request("http://localhost/api/auth/me"));
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    ok: boolean;
    actor: { role: string; source: string; permissions: string[] };
  };
  assert.equal(body.ok, true);
  assert.equal(body.actor.role, "admin");
  assert.equal(body.actor.source, "local-open");
  // Task 11: live.gate ist Admin (local-open) exklusiv gewährt — die harte
  // Live-Sperre liegt im Enforcer, nicht in der Permission.
  assert.equal(body.actor.permissions.includes("live.gate"), true);
  assert.ok(!text.toLowerCase().includes("token-wert"));
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("GET /api/auth/me: Token konfiguriert, kein Header → 401", async () => {
  process.env.FIRM_API_TOKEN = "operator-token-abcdef";
  const res = await GET_ME(new Request("http://localhost/api/auth/me"));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "UNAUTHORIZED");
});

test("GET /api/ops: liveEnabled hart false, auch mit Live-Flags", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  process.env.BITUNIX_LIVE_ENABLED = "true";
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    ok: boolean;
    liveEnabled: boolean;
    modules: { id: string }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.liveEnabled, false);
  assert.ok(body.modules.some((m) => m.id === "live"));
  assert.ok(body.modules.some((m) => m.id === "brokers"));
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("GET /api/ops: Actor im Offen-Betrieb vorhanden", async () => {
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  const body = (await res.json()) as { actor: { role: string } | null };
  assert.equal(body.actor?.role, "admin");
});

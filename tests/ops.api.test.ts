/**
 * API-Tests Operations Center (Task 10, vollständige Integration) + /api/auth/me.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";
import { OPS_SECTION_IDS } from "../src/ops/types";

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
    liveLockedReason: string;
    sections: { id: string; status: string }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.liveEnabled, false);
  assert.ok(body.liveLockedReason.length > 0);
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("GET /api/ops: alle zehn Sektionen, keine Stub-Zustände", async () => {
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  const body = (await res.json()) as {
    sections: { id: string; status: string; title: string; sources: string[]; metrics: unknown[] }[];
    health: Record<string, number>;
  };
  const ids = body.sections.map((s) => s.id);
  assert.deepEqual([...ids].sort(), [...OPS_SECTION_IDS].sort());
  for (const section of body.sections) {
    assert.notEqual(section.status, "stub", `Sektion ${section.id} ist noch ein Stub`);
    assert.ok(section.title.length > 0);
    assert.ok(section.sources.length > 0, `Sektion ${section.id} nennt keine Quelle`);
  }
  assert.equal(body.health.total, 10);
  const summed = body.health.ready + body.health.degraded + body.health.empty + body.health.locked + body.health.unavailable;
  assert.equal(summed, 10);
});

test("GET /api/ops: Actor im Offen-Betrieb vorhanden", async () => {
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  const body = (await res.json()) as { actor: { role: string } | null };
  assert.equal(body.actor?.role, "admin");
});

test("GET /api/ops: Sektionen bleiben bei Teilausfall einzeln begründet", async () => {
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  const body = (await res.json()) as {
    sections: { id: string; status: string; error: string | null; metrics: unknown[] }[];
  };
  for (const section of body.sections) {
    if (section.status === "unavailable") {
      assert.ok(section.error && section.error.length > 0, `Sektion ${section.id} ohne Fehlermeldung`);
    } else {
      assert.equal(section.error, null);
      assert.ok(section.metrics.length > 0, `Sektion ${section.id} ohne Kennzahlen`);
    }
  }
});

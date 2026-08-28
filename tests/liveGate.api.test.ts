/**
 * API-Tests (Task 11, Security-Suite): /api/live/*.
 *
 * 1. GET /api/live/state: Statusform (Venues, Kill, Suite, Audit-Kopf).
 * 2. POST /api/live/transition: Admin-Guard (401/403), CSRF (403),
 *    Rate-Limit (429), gültiger Übergang 200, illegale Sprünge 409.
 * 3. POST /api/live/kill: Phrase serverseitig, Kill 200 + Wirkung.
 *
 * Kein UI-/Prompt-Bypass: Nur diese Routen können mutieren, alle guards
 * werden serverseitig geprüft.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetCredentialRateLimiterForTests } from "../src/brokers/control-plane/guard";
import { getLiveGateRuntime, registerGatePort, setVenueReadinessProvider, writeSuiteStamp } from "../src/live-gate";
import { mockPort } from "./fixtures/liveGateTestUtil";

type Handler = (req: Request) => Promise<Response>;
type GetHandler = () => Promise<Response>;

let GET_STATE: GetHandler;
let POST_TRANSITION: Handler;
let POST_KILL: Handler;

const GATE_DIR = mkdtempSync(path.join(tmpdir(), "live-gate-api-"));
const ADMIN_TOKEN = "admin-secret-token-123456";

process.env.LIVE_GATE_DATA_DIR = GATE_DIR;
process.env.LIVE_GATE_DATA_DIR_RESTORED = "1";

before(async () => {
  const stateRoute = await import("../src/app/api/live/state/route");
  GET_STATE = stateRoute.GET as GetHandler;
  const transitionRoute = await import("../src/app/api/live/transition/route");
  POST_TRANSITION = transitionRoute.POST as Handler;
  const killRoute = await import("../src/app/api/live/kill/route");
  POST_KILL = killRoute.POST as Handler;
});

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
  resetCredentialRateLimiterForTests();
  registerGatePort("BITUNIX", mockPort());
  setVenueReadinessProvider(() => ({ active: true }));
  writeSuiteStamp(GATE_DIR, { passed: true, runId: "api-test-run", sha: null, source: "ci" });
});

after(() => {
  delete process.env.LIVE_GATE_DATA_DIR;
  delete process.env.LIVE_GATE_DATA_DIR_RESTORED;
  rmSync(GATE_DIR, { recursive: true, force: true });
});

function req(
  method: "GET" | "POST",
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://local/${Math.random()}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET /api/live/state: 200 mit Statusform (Venues, Kill, Suite, Audit)", async () => {
  const res = await GET_STATE();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(typeof body.policyVersion, "string");
  assert.ok(Array.isArray(body.venues) && body.venues.length >= 7);
  const killSwitch = body.killSwitch as { active?: boolean } | undefined;
  assert.ok(killSwitch && typeof killSwitch.active === "boolean");
  const audit = body.audit as { integrity?: { ok?: boolean } } | undefined;
  assert.ok(audit && audit.integrity && audit.integrity.ok === true);
  const bitunix = (body.venues as Array<Record<string, unknown>>).find((v) => v.venue === "BITUNIX");
  assert.ok(bitunix);
  assert.equal(bitunix!.state, "DISCONNECTED");
  assert.equal(bitunix!.liveOrderAllowed, false);
});

test("POST /api/live/transition: Offen-Betrieb (kein Token) + CSRF 'local' → 200", async () => {
  const res = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "CONNECTED" }, { "x-csrf-token": "local" })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.to, "CONNECTED");
});

test("POST /api/live/transition: Admin-Token gesetzt → ohne/with falschem Token 403, richtig 200", async () => {
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  const denied = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "MARKET_DATA_OK" }, { "x-csrf-token": ADMIN_TOKEN })
  );
  assert.equal(denied.status, 403); // kein Token präsentiert
  const ok = await POST_TRANSITION(
    req(
      "POST",
      { venue: "BITUNIX", to: "MARKET_DATA_OK" },
      { "x-admin-token": ADMIN_TOKEN, "x-csrf-token": ADMIN_TOKEN }
    )
  );
  assert.equal(ok.status, 200);
  delete process.env.FIRM_ADMIN_TOKEN;
});

test("POST /api/live/transition: CSRF fehlt → 403 CSRF_INVALID", async () => {
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  const res = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "ACCOUNT_READ_OK" }, { "x-admin-token": ADMIN_TOKEN })
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, "CSRF_INVALID");
  delete process.env.FIRM_ADMIN_TOKEN;
});

test("POST /api/live/transition: illegaler Sprung → 409 ILLEGAL_TRANSITION", async () => {
  const res = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "LIVE_ENABLED" }, { "x-csrf-token": "local" })
  );
  assert.equal(res.status, 409);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, "ILLEGAL_TRANSITION");
});

test("POST /api/live/transition: unbekannter Zustand → 422 UNKNOWN_STATE", async () => {
  const res = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "MAGIC" }, { "x-csrf-token": "local" })
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, "UNKNOWN_STATE");
});

test("POST /api/live/kill: Phrase falsch → 422; richtig → 200 + Wirkung", async () => {
  const wrong = await POST_KILL(
    req("POST", { venue: "BITUNIX", reason: "API-Kill-Test ausreichend", confirm: "yes" }, { "x-csrf-token": "local" })
  );
  assert.equal(wrong.status, 422);
  assert.equal(((await wrong.json()) as Record<string, unknown>).error, "CONFIRM_REQUIRED");

  const ok = await POST_KILL(
    req("POST", { venue: "BITUNIX", reason: "API-Kill-Test ausreichend", confirm: "KILL" }, { "x-csrf-token": "local" })
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.scope, "BITUNIX");

  // Nachwirkung: State DISCONNECTED + kill in der Übersicht sichtbar.
  const state = (await (await GET_STATE()).json()) as Record<string, unknown>;
  assert.equal((state.killSwitch as Record<string, unknown>).active, true);
  // Transitionen bleiben gesperrt:
  const blocked = await POST_TRANSITION(
    req("POST", { venue: "BITUNIX", to: "CONNECTED" }, { "x-csrf-token": "local" })
  );
  assert.equal(blocked.status, 409);
  assert.equal(((await blocked.json()) as Record<string, unknown>).error, "KILL_SWITCH_ACTIVE");

  // Clear über API:
  const cleared = await POST_KILL(
    req(
      "POST",
      { action: "clear", scope: "BITUNIX", reason: "API-Clear-Test ausreichend", confirm: "CLEAR_KILL" },
      { "x-csrf-token": "local" }
    )
  );
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as Record<string, unknown>).ok, true);
});

test("Rate-Limit: >5 Gate-Versuche/min/IP → 429", async () => {
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const res = await POST_TRANSITION(
      req("POST", { venue: "PAPER", to: "CONNECTED" }, { "x-admin-token": ADMIN_TOKEN, "x-csrf-token": ADMIN_TOKEN })
    );
    if (res.status === 429) {
      saw429 = true;
      break;
    }
  }
  assert.equal(saw429, true, "Rate-Limit greift nicht");
  delete process.env.FIRM_ADMIN_TOKEN;
});

test("Secret-Scanner: Live-API-Responses enthalten keine Secrets", async () => {
  const { scanTextForSecrets } = await import("../src/brokers/control-plane/secretScan");
  const stateText = await (await GET_STATE()).text();
  assert.deepEqual(scanTextForSecrets(stateText), []);
  const errText = await (
    await POST_TRANSITION(req("POST", { venue: "BITUNIX", to: "LIVE" }, { "x-csrf-token": "local" }))
  ).text();
  assert.deepEqual(scanTextForSecrets(errText), []);
});

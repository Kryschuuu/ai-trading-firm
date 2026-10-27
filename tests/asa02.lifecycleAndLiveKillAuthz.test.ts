/**
 * ASA-02 (CRITICAL) — Regression: Rollen-Spoofing, echtes Vier-Augen-Prinzip
 * und Live-Kill-Autorisierung.
 *
 * Geprüft gegen die ECHTEN HTTP-Handler (keine gemockten Guards):
 *
 *  1. `/api/firm/lifecycle`: `x-admin-token: <invalid>` verleiht keinem
 *     Operator eine Admin-Rolle; Admin-Kanten bleiben 403. Audit-Akteur und
 *     Rolle stammen aus `resolveAuth().principal`.
 *  2. Vier-Augen: ein Principal (auch mit "alice"/"bob" im Body) wird
 *     abgewiesen; zwei getrennte authentifizierte Principals (Operator-Session
 *     + Admin-Token, bzw. Admin-Token + Admin-Session) bestehen den
 *     2-Schritt-Flow. local-open ist fail-closed. TTL wird geprüft.
 *  3. `/api/live/kill`: `arm` für Operator erlaubt, Viewer 403; `clear` nur
 *     für Admin + gültige Einmal-Nonce aus `GET /api/live/kill` (Replay 403).
 *
 * Die Lifecycle-Erfolgsfälle laufen gegen eine eingebettete PostgreSQL
 * (Port 55_481) mit der echten Migration; alle Ablehnungen passieren VOR
 * jedem DB-Zugriff. Das Live-Gate nutzt hermetische temporäre Data-Dirs.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import { resolveAuth } from "../src/auth";
import { issueSession, SESSION_COOKIE } from "../src/lib/authSession";
import { setAuditTransportForTests } from "../src/lib/auditSink";
import { resetRateLimiterForTests } from "../src/lib/apiAuth";
import { resetCredentialRateLimiterForTests } from "../src/brokers/control-plane/guard";
import {
  FOUR_EYES_TTL_MS,
  createFourEyesPending,
  evaluateFourEyes,
  resetFourEyesApprovalsForTests,
} from "../src/lib/fourEyesApproval";
import { resetKillNoncesForTests } from "../src/lib/killSwitchNonce";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { ensureLifecycleDraft } from "../src/strategyLifecycle/service";
import {
  getLiveGateRuntime,
  getLiveGateService,
  registerGatePort,
  resetLiveGateForTests,
  setVenueReadinessProvider,
  writeSuiteStamp,
} from "../src/live-gate";
import { mockPort, resetLiveGateTestGlobals } from "./fixtures/liveGateTestUtil";

type Handler = (req: Request) => Promise<Response>;

const ADMIN_TOKEN = "asa02-admin-token-0123456789";
const OPERATOR_TOKEN = "asa02-operator-token-0123456789";
const VIEWER_TOKEN = "asa02-viewer-token-0123456789";
const SESSION_SECRET = "asa02-independent-session-secret-0123456789";
const CSRF_LOCAL = "local";

const PG_PORT = 55_481;
const DB_NAME = "asa02_authz_test";

const ENV_KEYS = [
  "AUTH_MODE",
  "NODE_ENV",
  "FIRM_ADMIN_TOKEN",
  "FIRM_API_TOKEN",
  "FIRM_VIEWER_TOKEN",
  "FIRM_SESSION_SECRET",
  "FIRM_RATE_LIMIT",
  "BROKER_CREDENTIAL_RATE_LIMIT",
  "DATABASE_URL",
  "LIVE_GATE_DATA_DIR",
  "LIVE_GATE_FOUR_EYES",
  "LIVE_GATE_COOLDOWN_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();
let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let pgDir = "";
const gateDirs: string[] = [];

let POST_LIFECYCLE: Handler;
let POST_TRANSITION: Handler;
let POST_KILL: Handler;
let GET_KILL: Handler;

/** Frisches, hermetisches Live-Gate-Data-Dir je Test. */
function freshGateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "asa02-live-gate-"));
  gateDirs.push(dir);
  return dir;
}

function withTokens(): void {
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
  process.env.FIRM_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.FIRM_SESSION_SECRET = SESSION_SECRET;
  process.env.FIRM_RATE_LIMIT = "0";
  process.env.BROKER_CREDENTIAL_RATE_LIMIT = "0";
  delete process.env.AUTH_MODE;
  delete process.env.LIVE_GATE_FOUR_EYES;
  process.env.LIVE_GATE_COOLDOWN_MS = "0";
}

/** Auth-Header + CSRF für einen Token-Principal. */
function headers(tokenHeader: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [tokenHeader]: token, "x-csrf-token": token, ...extra };
}

const ADMIN_HEADERS = (extra: Record<string, string> = {}) =>
  headers("x-admin-token", ADMIN_TOKEN, extra);

/**
 * Signierte Browser-Session (eigener kryptographischer Principal). Der
 * CSRF-Wert kommt aus dem signierten Payload, nicht aus einem Token-Header.
 */
function sessionHeaders(credentialHeader: string, token: string): Record<string, string> {
  const login = request("/api/auth/login", { method: "GET", headers: { [credentialHeader]: token } });
  const resolved = resolveAuth(login);
  assert.ok(resolved.ok, "Login-Credential muss auflösen");
  const issued = issueSession(login, resolved.actor);
  assert.ok(issued.ok, `Session muss ausstellbar sein: ${issued.ok ? "" : issued.error}`);
  return { cookie: `${SESSION_COOKIE}=${issued.sessionToken}`, "x-csrf-token": issued.csrf };
}

function request(
  urlPath: string,
  opts: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown } = {}
): Request {
  const method = opts.method ?? "POST";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Request(`https://asa02.test${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

before(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  Reflect.deleteProperty(process.env, "NODE_ENV"); // Dev-Default für local-open-Test

  pgDir = mkdtempSync(path.join(tmpdir(), "asa02-pg-"));
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: "postgres",
    password: "password",
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  process.env.DATABASE_URL = `postgresql://postgres:password@127.0.0.1:${PG_PORT}/${DB_NAME}`;

  const G = globalThis as typeof globalThis & {
    __arenaNextJsPostgresqlPool?: Pool;
    __arenaNextJsPostgresqlDb?: unknown;
  };
  delete G.__arenaNextJsPostgresqlPool;
  delete G.__arenaNextJsPostgresqlDb;

  pool = new Pool({
    host: "127.0.0.1",
    port: PG_PORT,
    user: "postgres",
    password: "password",
    database: DB_NAME,
  });
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  // Live-Gate-Audit schreibt einen Zweitabzug in audit_log (best-effort).
  // Die Minimaltabelle verhindert Warnungen und prüft die Audit-Kette mit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event text NOT NULL,
      agent_id uuid,
      mission_id uuid,
      level text NOT NULL DEFAULT 'INFO',
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id text NOT NULL,
      timeframe text NOT NULL,
      from_ts timestamptz NOT NULL,
      to_ts timestamptz NOT NULL,
      params_json jsonb NOT NULL,
      metrics_json jsonb NOT NULL,
      windows_json jsonb NOT NULL,
      code_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/2026-09-23_strategy_lifecycle.sql"),
    "utf8"
  );
  await pool.query(migration);
  setAuditTransportForTests(async () => {});

  process.env.LIVE_GATE_DATA_DIR = freshGateDir();
  const lifecycle = await import("../src/app/api/firm/lifecycle/route");
  POST_LIFECYCLE = lifecycle.POST as Handler;
  const transition = await import("../src/app/api/live/transition/route");
  POST_TRANSITION = transition.POST as Handler;
  const kill = await import("../src/app/api/live/kill/route");
  POST_KILL = kill.POST as Handler;
  GET_KILL = kill.GET as Handler;
});

after(async () => {
  setAuditTransportForTests(null);
  resetLiveGateTestGlobals();
  await pool?.end();
  if (pg) await pg.stop();
  rmSync(pgDir, { recursive: true, force: true });
  for (const dir of gateDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
});

beforeEach(() => {
  withTokens();
  __resetAllSingletonsForTests();
  resetRateLimiterForTests();
  resetCredentialRateLimiterForTests();
  resetFourEyesApprovalsForTests();
  resetKillNoncesForTests();
  resetLiveGateForTests();
  resetLiveGateTestGlobals();
  process.env.LIVE_GATE_DATA_DIR = freshGateDir();
  // erst den Service-Singleton erzeugen (registriert die CP-Bridge), danach
  // den hermetischen Readiness-Provider und Mock-Ports setzen.
  getLiveGateService();
  setVenueReadinessProvider(() => ({ active: true }));
  registerGatePort("BITUNIX", mockPort());
  registerGatePort("KRAKEN", mockPort());
  writeSuiteStamp(getLiveGateRuntime().dir, {
    passed: true,
    runId: "asa02-suite",
    sha: null,
    source: "ci",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1) Rollen-Spoofing
// ─────────────────────────────────────────────────────────────────────────────

test("ASA-02: gefälschter x-admin-token verleiht einem Operator keine Admin-Rolle", async () => {
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);
  const spoof = { "x-admin-token": "invalid-forged-admin-token" };

  // a) Identität: Rolle + Audit-ID kommen ausschließlich aus resolveAuth.
  const operatorReq = request("/api/firm/lifecycle", {
    headers: { ...opSession, ...spoof },
  });
  const opAuth = resolveAuth(operatorReq);
  const adminAuth = resolveAuth(
    request("/api/firm/lifecycle", { headers: ADMIN_HEADERS() })
  );
  assert.ok(opAuth.ok && adminAuth.ok);
  assert.equal(opAuth.principal.role, "operator");
  assert.equal(opAuth.principal.auditId, "operator");
  assert.equal(adminAuth.principal.role, "admin");
  assert.notEqual(opAuth.principal.id, adminAuth.principal.id);
  assert.ok(opAuth.principal.id.length >= 32, "Principal muss ein kryptographischer Fingerprint sein");

  // b) ensure schreibt den verifizierten Operator (nicht "admin") in den Audit.
  const ensured = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: { ...opSession, ...spoof },
      body: { action: "ensure", strategyKey: "asa02-spoof", strategyVersion: 1 },
    })
  );
  assert.equal(ensured.status, 200);
  const ensuredBody = (await json(ensured)) as { state?: { updatedBy?: string } };
  assert.equal(ensuredBody.state?.updatedBy, "api:operator");

  // c) Admin-Kanten bleiben für den Operator trotz gefälschtem Header zu.
  const direct = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: { ...opSession, ...spoof },
      body: {
        action: "transition",
        strategyKey: "asa02-spoof",
        strategyVersion: 1,
        to: "LIVE_LIMITED",
        reason: "Spoofing-Versuch",
        actor: "alice",
        approvedBy: "bob",
      },
    })
  );
  assert.ok(direct.status === 401 || direct.status === 403, `erwartet 401/403, bekam ${direct.status}`);
  assert.notEqual((await json(direct)).ok, true);

  const approve = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: { ...opSession, ...spoof },
      body: {
        action: "approve",
        strategyKey: "asa02-spoof",
        strategyVersion: 1,
        to: "LIVE_LIMITED",
        reason: "Spoofing-Versuch",
        approvalId: "forged",
      },
    })
  );
  assert.ok(approve.status === 401 || approve.status === 403, `erwartet 401/403, bekam ${approve.status}`);
});

test("ASA-02: Viewer (nur firm.read) wird auf /api/firm/lifecycle mit 403 abgewiesen", async () => {
  const viewer = { "x-viewer-token": VIEWER_TOKEN };
  const lifecycle = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: viewer,
      body: { action: "ensure", strategyKey: "asa02-viewer", strategyVersion: 1 },
    })
  );
  assert.equal(lifecycle.status, 403); // firm.write fehlt (vor CSRF/DB)
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Vier-Augen-Prinzip
// ─────────────────────────────────────────────────────────────────────────────

const FOUR_EYES_BODY = {
  strategyKey: "asa02-four-eyes",
  strategyVersion: 1,
  to: "DRAFT",
  actionKind: "override",
  reason: "ASA-02 Vier-Augen-Regression Override",
};

test("ASA-02: Ein-Request-Vier-Augen (alice/bob im selben Body) ist abgewiesen", async () => {
  const direct = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: ADMIN_HEADERS(),
      body: {
        action: "override",
        actor: "alice",
        approvedBy: "bob",
        ...FOUR_EYES_BODY,
      },
    })
  );
  assert.equal(direct.status, 403);
  assert.equal((await json(direct)).error, "FOUR_EYES_REQUIRED");
});

test("ASA-02: derselbe Principal wird auch mit unterschiedlichen Body-Namen abgewiesen", async () => {
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);
  const proposed = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: opSession,
      body: { action: "propose", approvedBy: "alice", ...FOUR_EYES_BODY },
    })
  );
  assert.equal(proposed.status, 202);
  const { approvalId } = (await json(proposed)) as { approvalId: string };
  assert.ok(approvalId);

  // Derselbe authentifizierte Principal, aber "bob" statt "alice" im Body.
  const samePrincipal = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: opSession,
      body: {
        action: "approve",
        approvedBy: "bob",
        actor: "alice",
        approvalId,
        ...FOUR_EYES_BODY,
      },
    })
  );
  // Operator hat ohnehin kein strategy.rules.activate ⇒ 403; zusätzlich
  // prüfen wir denselben Principal als Admin (siehe nächster Test).
  assert.equal(samePrincipal.status, 403);

  const adminProposed = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: ADMIN_HEADERS(),
      body: { action: "propose", approvedBy: "alice", ...FOUR_EYES_BODY },
    })
  );
  assert.equal(adminProposed.status, 202);
  const adminApprovalId = ((await json(adminProposed)) as { approvalId: string }).approvalId;
  const adminSamePrincipal = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: ADMIN_HEADERS(),
      body: {
        action: "approve",
        approvedBy: "bob",
        actor: "alice",
        approvalId: adminApprovalId,
        ...FOUR_EYES_BODY,
      },
    })
  );
  assert.equal(adminSamePrincipal.status, 403);
  assert.equal((await json(adminSamePrincipal)).error, "FOUR_EYES_SAME_PRINCIPAL");
});

test("ASA-02: zwei getrennte authentifizierte Principals bestehen den 2-Schritt-Flow (200)", async () => {
  await ensureLifecycleDraft(FOUR_EYES_BODY.strategyKey, FOUR_EYES_BODY.strategyVersion, {
    actor: "test",
    role: "operator",
  });
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);

  const step1 = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: opSession,
      body: { action: "propose", approvedBy: "alice", ...FOUR_EYES_BODY },
    })
  );
  assert.equal(step1.status, 202);
  const pending = (await json(step1)) as { phase: string; approvalId: string; expiresAt: number };
  assert.equal(pending.phase, "PENDING");
  assert.ok(pending.expiresAt > Date.now());

  // Schritt 2: anderer Principal (Admin-Token). Freitext "bob" ist irrelevant.
  const step2 = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: ADMIN_HEADERS(),
      body: {
        action: "approve",
        approvedBy: "bob",
        actor: "alice",
        approvalId: pending.approvalId,
        ...FOUR_EYES_BODY,
      },
    })
  );
  const result = await json(step2);
  assert.equal(step2.status, 200, `2-Principal-Flow muss durchgehen: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true);

  // Wiederverwendung derselben approvalId (Replay) ist gesperrt.
  const replay = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: ADMIN_HEADERS(),
      body: {
        action: "approve",
        approvalId: pending.approvalId,
        ...FOUR_EYES_BODY,
      },
    })
  );
  assert.equal(replay.status, 403);
  assert.equal((await json(replay)).error, "FOUR_EYES_NO_PROPOSAL");
});

test("ASA-02: local-open lehnt Vier-Augen-Live-Freigaben fail-closed ab", async () => {
  for (const key of ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET"]) {
    delete process.env[key];
  }
  process.env.AUTH_MODE = "local-open";

  const local = { "x-csrf-token": CSRF_LOCAL };
  const lifecycle = await POST_LIFECYCLE(
    request("/api/firm/lifecycle", {
      headers: local,
      body: { action: "propose", approvedBy: "alice", ...FOUR_EYES_BODY },
    })
  );
  assert.equal(lifecycle.status, 403);
  const lifecycleBody = await json(lifecycle);
  assert.equal(lifecycleBody.error, "FOUR_EYES_PRINCIPALS_REQUIRED");
  assert.match(String(lifecycleBody.hint ?? ""), /authentifizierte|Principals/);

  // Auch der finale Live-Gate-Schritt ist im Offen-Betrieb gesperrt.
  const runtime = getLiveGateRuntime();
  const rec = runtime.store.read("BITUNIX");
  rec.state = "HUMAN_APPROVED";
  runtime.store.write("BITUNIX", rec);
  const transition = await POST_TRANSITION(
    request("/api/live/transition", {
      headers: local,
      body: {
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        reason: "ASA-02 Local-Open Live-Freigabe",
        confirm: true,
        approvedBy: "admin",
      },
    })
  );
  assert.equal(transition.status, 403);
  assert.equal((await json(transition)).error, "FOUR_EYES_PRINCIPALS_REQUIRED");
});

test("ASA-02: Erstfreigabe läuft nach TTL ab und bindet den Intent", () => {
  const now = Date.now();
  const pending = createFourEyesPending({
    intent: "A",
    principal: { id: "principal-a", auditId: "operator", distinct: true },
    now,
  });
  assert.ok(pending);
  assert.equal(pending.expiresAt - now, FOUR_EYES_TTL_MS);
  assert.equal(
    evaluateFourEyes(pending, {
      intent: "A",
      approver: { id: "principal-b", auditId: "admin", distinct: true },
      approvalId: pending.approvalId,
      now: now + FOUR_EYES_TTL_MS + 1,
    }).ok,
    false
  );
  const expired = evaluateFourEyes(pending, {
    intent: "A",
    approver: { id: "principal-b", auditId: "admin", distinct: true },
    approvalId: pending.approvalId,
    now: now + FOUR_EYES_TTL_MS + 1,
  });
  assert.ok(!expired.ok && expired.reason === "EXPIRED");
  const wrongIntent = evaluateFourEyes(pending, {
    intent: "B",
    approver: { id: "principal-b", auditId: "admin", distinct: true },
    approvalId: pending.approvalId,
    now,
  });
  assert.ok(!wrongIntent.ok && wrongIntent.reason === "INTENT_MISMATCH");
});

test("ASA-02: Live-Gate-Vier-Augen verlangt zwei getrennte Principals (Route, 2 Requests)", async () => {
  process.env.LIVE_GATE_FOUR_EYES = "true";
  const adminA = ADMIN_HEADERS();
  const adminB = sessionHeaders("x-admin-token", ADMIN_TOKEN); // getrennte Admin-Session

  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED", "LIVE_PENDING"]) {
    const res = await POST_TRANSITION(
      request("/api/live/transition", {
        headers: adminA,
        body: { venue: "KRAKEN", to, reason: "ASA-02 Vier-Augen Setup" },
      })
    );
    assert.equal(res.status, 200, `Setup ${to}: ${JSON.stringify(await json(res))}`);
  }

  const common = {
    venue: "KRAKEN",
    to: "HUMAN_APPROVED",
    reason: "ASA-02 Vier-Augen-Freigabe",
    confirm: true,
  };
  const step1 = await POST_TRANSITION(
    request("/api/live/transition", {
      headers: adminA,
      body: { ...common, approvedBy: "alice" },
    })
  );
  assert.equal(step1.status, 409);
  const pending = await json(step1);
  assert.equal(pending.error, "FOUR_EYES_PENDING");
  const approvalId = String(pending.approvalId ?? "");
  assert.ok(approvalId, "Schritt 1 muss eine approvalId liefern");

  const samePrincipal = await POST_TRANSITION(
    request("/api/live/transition", {
      headers: adminA,
      body: { ...common, approvedBy: "bob", approvalId },
    })
  );
  assert.equal(samePrincipal.status, 409);
  assert.equal((await json(samePrincipal)).error, "FOUR_EYES_SAME_APPROVER");

  const step2 = await POST_TRANSITION(
    request("/api/live/transition", {
      headers: adminB,
      body: { ...common, approvedBy: "bob", approvalId },
    })
  );
  const step2Body = await json(step2);
  assert.equal(step2.status, 200, `2-Principal-Gegenzeichnung: ${JSON.stringify(step2Body)}`);
  assert.equal(step2Body.to, "HUMAN_APPROVED");
  assert.equal(getLiveGateRuntime().store.read("KRAKEN").pendingApproval, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Live-Kill-Autorisierung + Nonce
// ─────────────────────────────────────────────────────────────────────────────

const ARM_BODY = {
  venue: "BITUNIX",
  reason: "ASA-02 Not-Halt Drill",
  confirm: "KILL",
};
const CLEAR_BODY = {
  action: "clear",
  scope: "BITUNIX",
  reason: "ASA-02 Clear Drill",
  confirm: "CLEAR_KILL",
};

test("ASA-02: POST /api/live/kill (arm) — Operator 200 (Audit-Akteur gebunden), Viewer 403", async () => {
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);
  const armed = await POST_KILL(
    request("/api/live/kill", { headers: opSession, body: ARM_BODY })
  );
  const armedBody = await json(armed);
  assert.equal(armed.status, 200, `Operator muss den Not-Aus ziehen dürfen: ${JSON.stringify(armedBody)}`);
  const audit = getLiveGateRuntime().audit.recent(5).filter((e) => e.action === "kill");
  assert.ok(audit.some((e) => e.actor === "operator"), "Audit-Akteur muss der verifizierte Operator sein");

  const viewer = await POST_KILL(
    request("/api/live/kill", {
      headers: { "x-viewer-token": VIEWER_TOKEN },
      body: ARM_BODY,
    })
  );
  assert.equal(viewer.status, 403);
});

test("ASA-02: expliziter action=arm funktioniert ohne Nonce; unbekannte action → 400; Riesen-Body → 413", async () => {
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);
  const armed = await POST_KILL(
    request("/api/live/kill", { headers: opSession, body: { action: "arm", ...ARM_BODY } })
  );
  assert.equal(armed.status, 200);
  const unknown = await POST_KILL(
    request("/api/live/kill", { headers: opSession, body: { action: "disable", ...ARM_BODY } })
  );
  assert.equal(unknown.status, 400);
  assert.equal((await json(unknown)).error, "UNKNOWN_ACTION");
  const huge = await POST_KILL(
    request("/api/live/kill", { headers: opSession, body: { ...ARM_BODY, reason: "x".repeat(9000) } })
  );
  assert.equal(huge.status, 413);
});

test("ASA-02: clear — Operator 403, Admin ohne Nonce 400/403, gültige Nonce 200, Replay 403", async () => {
  const opSession = sessionHeaders("x-firm-token", OPERATOR_TOKEN);
  const admin = ADMIN_HEADERS();

  // Vorbedingung: Kill-Switch aktiv.
  assert.equal(
    (await POST_KILL(request("/api/live/kill", { headers: admin, body: ARM_BODY }))).status,
    200
  );

  const asOperator = await POST_KILL(
    request("/api/live/kill", { headers: opSession, body: CLEAR_BODY })
  );
  assert.equal(asOperator.status, 403, "Operator darf nicht entschärfen");

  const withoutNonce = await POST_KILL(
    request("/api/live/kill", { headers: admin, body: CLEAR_BODY })
  );
  assert.ok([400, 403].includes(withoutNonce.status));
  assert.equal((await json(withoutNonce)).error, "NONCE_REQUIRED");

  const challenge = await GET_KILL(request("/api/live/kill", { method: "GET", headers: admin }));
  assert.equal(challenge.status, 200);
  const { nonce, expiresAt } = (await json(challenge)) as { nonce: string; expiresAt: number };
  assert.ok(nonce && expiresAt > Date.now());

  const cleared = await POST_KILL(
    request("/api/live/kill", { headers: admin, body: { ...CLEAR_BODY, nonce } })
  );
  const clearedBody = await json(cleared);
  assert.equal(cleared.status, 200, `Admin + gültige Nonce muss clear dürfen: ${JSON.stringify(clearedBody)}`);
  assert.equal(clearedBody.ok, true);
  const clearAudit = getLiveGateRuntime().audit.recent(5).filter((e) => e.action === "kill-clear");
  assert.ok(clearAudit.some((e) => e.actor === "admin"), "Clear-Audit muss den Admin-Principal nennen");

  const replay = await POST_KILL(
    request("/api/live/kill", { headers: admin, body: { ...CLEAR_BODY, nonce } })
  );
  assert.ok([400, 403].includes(replay.status));
  assert.equal((await json(replay)).error, "NONCE_REPLAYED");

  // GET-Challenge selbst ist Admin-only.
  const viewerChallenge = await GET_KILL(
    request("/api/live/kill", { method: "GET", headers: { "x-viewer-token": VIEWER_TOKEN } })
  );
  assert.equal(viewerChallenge.status, 403);
});

test("ASA-02: abgelaufene/falsche Kill-Nonce wird nicht akzeptiert", async () => {
  const admin = ADMIN_HEADERS();
  const bogus = await POST_KILL(
    request("/api/live/kill", { headers: admin, body: { ...CLEAR_BODY, nonce: "bogus-nonce" } })
  );
  assert.equal(bogus.status, 400);
  assert.equal((await json(bogus)).error, "NONCE_REQUIRED");
});

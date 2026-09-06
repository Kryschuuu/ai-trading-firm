/**
 * SEC-02 (v1.36.31) — sensitive Dashboard-Read-APIs dürfen bei aktivem
 * Token-Betrieb weder Daten noch Fehler aus ihren Backends preisgeben, bevor
 * `firm.read` geprüft wurde.
 *
 * Die Tests rufen die echten Route-Handler auf. Damit braucht der negative
 * Pfad keine Datenbank und beweist zugleich: AuthN/AuthZ wird vor DB-,
 * Router- oder Health-Zugriffen ausgeführt. Die Quellenprüfung ist ein
 * bewusst enger CI-Drift-Schutz für die sechs im Security-Finding erfassten
 * Endpunkte; neue sensitive Reads müssen denselben Guard erhalten.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveAuth } from "../src/auth";
import { issueSession, SESSION_COOKIE } from "../src/lib/authSession";

type GetHandler = (req: Request) => Promise<Response>;
type SensitiveRoute = {
  path: string;
  source: string;
  get: GetHandler;
};

const OPERATOR_TOKEN = "sec02-operator-token-0123456789";
const VIEWER_TOKEN = "sec02-viewer-token-0123456789";
const SESSION_SECRET = randomBytes(32).toString("hex");
const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"] as const;
const savedEnv = new Map<string, string | undefined>();

let routes: SensitiveRoute[] = [];

before(async () => {
  // `unknown` hält den Test gegen die vor dem Fix parameterlosen Handler und
  // die nach dem Fix Request-basierten Handler typsicher kompatibel.
  const firm = (await import("../src/app/api/firm/route")).GET as unknown as GetHandler;
  const log = (await import("../src/app/api/firm/log/route")).GET as GetHandler;
  const report = (await import("../src/app/api/firm/report/route")).GET as GetHandler;
  const rules = (await import("../src/app/api/firm/rules/route")).GET as unknown as GetHandler;
  const providers = (await import("../src/app/api/providers/route")).GET as GetHandler;
  const routing = (await import("../src/app/api/routing/route")).GET as unknown as GetHandler;

  routes = [
    { path: "/api/firm?include=positions,auditLog,riskLimits", source: "src/app/api/firm/route.ts", get: firm },
    { path: "/api/firm/log?limit=200&event=ORDER_REJECTED", source: "src/app/api/firm/log/route.ts", get: log },
    { path: "/api/firm/report?period=month", source: "src/app/api/firm/report/route.ts", get: report },
    { path: "/api/firm/rules", source: "src/app/api/firm/rules/route.ts", get: rules },
    { path: "/api/providers?refresh=1", source: "src/app/api/providers/route.ts", get: providers },
    { path: "/api/routing", source: "src/app/api/routing/route.ts", get: routing },
  ];

  for (const key of AUTH_KEYS) savedEnv.set(key, process.env[key]);
});

beforeEach(() => {
  for (const key of AUTH_KEYS) delete process.env[key];
  // Sobald ein Token konfiguriert ist, darf kein Request über local-open
  // durchfallen. Ein echter Remote-Angreifer kann Query-Parameter und Header
  // frei wählen, besitzt dieses Credential aber nicht.
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
});

after(() => {
  for (const key of AUTH_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://trading.example.test${path}`, { headers });
}

async function assertUnauthorized(response: Response, path: string): Promise<void> {
  assert.equal(response.status, 401, `${path} muss unauthentifiziert 401 liefern`);
  const body = (await response.json()) as { ok?: unknown; error?: unknown };
  assert.equal(body.ok, false, `${path} darf keinen Erfolgs-Payload liefern`);
  assert.equal(body.error, "UNAUTHORIZED", `${path} muss den standardisierten Auth-Fehler liefern`);
}

test("SEC-02: jeder dokumentierte sensible GET weist anonyme Requests vor Datenzugriff ab", async () => {
  for (const route of routes) {
    await assertUnauthorized(await route.get(request(route.path)), route.path);
  }
});

test("SEC-02: manipulierbare Header und Query-Parameter umgehen firm.read nicht", async () => {
  const attackerHeaders = [
    { authorization: "Bearer forged-token", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
    { "x-firm-token": "forged-operator-token", "x-admin-token": "forged-admin-token" },
    { "x-viewer-token": "forged-viewer-token", cookie: `${SESSION_COOKIE}=forged.session.signature` },
  ];

  for (const headers of attackerHeaders) {
    for (const route of routes) {
      await assertUnauthorized(await route.get(request(route.path, headers)), `${route.path} (${Object.keys(headers).join(", ")})`);
    }
  }
});

test("SEC-02: Viewer mit firm.read kann Provider- und Routing-Dashboard lesen", async () => {
  delete process.env.FIRM_API_TOKEN;
  process.env.FIRM_VIEWER_TOKEN = VIEWER_TOKEN;

  for (const route of routes.filter((route) => route.path.startsWith("/api/providers") || route.path === "/api/routing")) {
    const response = await route.get(request(route.path, { "x-viewer-token": VIEWER_TOKEN }));
    assert.equal(response.status, 200, `${route.path} muss für Viewer mit firm.read lesbar bleiben`);
    assert.equal(((await response.json()) as { ok?: unknown }).ok, true);
  }
});

test("SEC-02: signierte Viewer-Session bleibt für Dashboard-Reads autorisiert", async () => {
  delete process.env.FIRM_API_TOKEN;
  process.env.FIRM_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.FIRM_SESSION_SECRET = SESSION_SECRET;

  const loginRequest = request("/api/auth/login", { "x-firm-token": VIEWER_TOKEN });
  const resolution = resolveAuth(loginRequest);
  assert.ok(resolution.ok, "Viewer-Credential muss zu einem Actor auflösen");
  const issued = issueSession(loginRequest, resolution.actor);
  assert.ok(issued.ok, "signierte Viewer-Session muss ausstellbar sein");

  for (const route of routes.filter((route) => route.path.startsWith("/api/providers") || route.path === "/api/routing")) {
    const response = await route.get(request(route.path, { cookie: `${SESSION_COOKIE}=${issued.sessionToken}` }));
    assert.equal(response.status, 200, `${route.path} muss die HttpOnly-Viewer-Session akzeptieren`);
  }
});

test("SEC-02: CI-Drift-Schutz verlangt firm.read vor jedem sensitiven Handler-Pfad", () => {
  for (const route of routes) {
    const source = readFileSync(resolve(process.cwd(), route.source), "utf8");
    assert.match(source, /import\s*\{\s*requirePermission\s*\}\s*from\s*["']@\/auth["']/,
      `${route.source} muss den gemeinsamen RBAC-Guard importieren`);
    assert.match(source, /export\s+async\s+function\s+GET\s*\(\s*req\s*:\s*Request\s*\)\s*(?::\s*Promise<Response>)?\s*\{[\s\S]{0,600}?const\s+denied\s*=\s*requirePermission\(req,\s*["']firm\.read["']\);\s*if\s*\(denied\)\s*return\s+denied;/,
      `${route.source} muss firm.read vor jeder sensitiven Verarbeitung prüfen`);
  }
});

/**
 * DC-01 (2026-10-06, Docs↔Code-Audit `docs/DOCS_CODE_AUDIT_2026-10-06.md`):
 * Regression für die Proposal-Freigabe.
 *
 * Befund: `POST /api/firm/proposals/[id]/approve` (die menschliche Freigabe der
 * H6-Approval-Chain) war die EINZIGE schreibende Route unter `src/app/api/firm`
 * ohne Autorisierung — kein `requirePermission`, kein `guardWrite`, kein CSRF.
 * In `AUTH_MODE=token-required` konnte jeder anonyme Aufrufer ein
 * PENDING-Proposal auf APPROVED setzen; der Executor führt genau solche
 * Proposals aus. SEC-02 hatte nur die sensiblen GET-Routen gehärtet.
 *
 * Dieser Test hält den Fix fest:
 *   1. Verhalten: anonym ⇒ 401 vor jedem DB-Zugriff, Viewer ⇒ 403,
 *      Operator ohne `x-csrf-token` ⇒ 403 `CSRF_INVALID`,
 *      Operator mit Permission + CSRF ⇒ Guard passiert (nur noch DB/Logik-Fehler).
 *   2. Quell-Drift-Schutz: Import und Guard-Reihenfolge dürfen nicht verwaisen.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CSRF_LOCAL_VALUE } from "../src/brokers/control-plane/config";

type PostHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const ROUTE_FILE = "src/app/api/firm/proposals/[id]/approve/route.ts";
const OPERATOR_TOKEN = "dc01-operator-token-0123456789";
const VIEWER_TOKEN = "dc01-viewer-token-0123456789";
const AUTH_KEYS = [
  "FIRM_ADMIN_TOKEN",
  "FIRM_API_TOKEN",
  "FIRM_VIEWER_TOKEN",
  "AUTH_MODE",
] as const;
const savedEnv = new Map<string, string | undefined>();

let approve: PostHandler;

before(async () => {
  const mod = (await import(
    "../src/app/api/firm/proposals/[id]/approve/route"
  )) as { POST: PostHandler };
  approve = mod.POST;
  for (const key of AUTH_KEYS) savedEnv.set(key, process.env[key]);
});

after(() => {
  for (const key of AUTH_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  for (const key of AUTH_KEYS) delete process.env[key];
  // Sobald ein Token konfiguriert ist, gilt `token-required`: kein Request darf
  // über den lokalen Offen-Betrieb durchfallen.
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
});

function call(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { approvedBy: "dc01-test" },
): Promise<Response> {
  return approve(
    new Request("https://trading.example.test/api/firm/proposals/prop-dc01/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "prop-dc01" }) },
  );
}

test("DC-01: anonyme Freigabe wird als 401 abgewiesen (vor jedem Datenzugriff)", async () => {
  const res = await call();
  assert.equal(res.status, 401, "anonyme Freigabe muss 401 liefern");
  const body = (await res.json()) as { ok?: unknown; error?: unknown };
  assert.equal(body.ok, false);
  assert.equal(body.error, "UNAUTHORIZED");
});

test("DC-01: gefälschte Header heben den Guard nicht auf", async () => {
  const res = await call({
    authorization: "Bearer forged-token",
    "x-firm-token": "forged-operator-token",
    "x-forwarded-for": "127.0.0.1",
  });
  assert.equal(res.status, 401);
});

test("DC-01: Viewer (nur firm.read) darf keine Freigabe erteilen", async () => {
  delete process.env.FIRM_API_TOKEN;
  process.env.FIRM_VIEWER_TOKEN = VIEWER_TOKEN;
  const res = await call({
    "x-viewer-token": VIEWER_TOKEN,
    "x-csrf-token": VIEWER_TOKEN,
  });
  assert.equal(res.status, 403, "Viewer ohne firm.write muss 403 erhalten");
  const body = (await res.json()) as { error?: unknown };
  assert.equal(body.error, "FORBIDDEN");
});

test("DC-01: Operator ohne CSRF-Header wird mit 403 CSRF_INVALID abgewiesen", async () => {
  const res = await call({ "x-firm-token": OPERATOR_TOKEN });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error?: unknown };
  assert.equal(body.error, "CSRF_INVALID");
});

test("DC-01: Operator mit firm.write + CSRF passiert den Guard", async () => {
  const res = await call({
    "x-firm-token": OPERATOR_TOKEN,
    "x-csrf-token": OPERATOR_TOKEN,
  });
  // Ohne Datenbank läuft der Handler bis zum DB-/Audit-Pfad: 404 (kein Datensatz)
  // oder 500 (keine DB) — aber nie ein Auth-/CSRF-Fehler.
  assert.ok(
    res.status === 200 || res.status === 404 || res.status === 500,
    `erwartet 200/404/500 nach bestandenem Guard, bekam ${res.status}`,
  );
  const body = (await res.json()) as { error?: unknown };
  assert.ok(
    body.error !== "UNAUTHORIZED" && body.error !== "FORBIDDEN" && body.error !== "CSRF_INVALID",
    `Guard hat nicht durchgelassen: ${String(body.error)}`,
  );
});

test("DC-01: Im lokalen Offen-Betrieb (Dev-Default) bleibt CSRF Pflicht", async () => {
  delete process.env.FIRM_API_TOKEN;
  process.env.AUTH_MODE = "local-open";
  const res = await call({
    "x-firm-token": "",
    "x-csrf-token": "falsch",
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error?: unknown };
  assert.equal(body.error, "CSRF_INVALID");

  const ok = await call({ "x-csrf-token": CSRF_LOCAL_VALUE });
  assert.ok(
    ok.status === 200 || ok.status === 404 || ok.status === 500,
    `local-open mit lokalem CSRF-Wert muss den Guard passieren, bekam ${ok.status}`,
  );
});

test("DC-01: CI-Drift-Schutz — Guard und Actor-Beleg bleiben in der Route", () => {
  const source = readFileSync(resolve(process.cwd(), ROUTE_FILE), "utf8");
  assert.match(
    source,
    /import\s*\{\s*actorAuditId,\s*requirePermission\s*\}\s*from\s*["']@\/auth["']/,
    "die Route muss den gemeinsamen RBAC-Guard importieren",
  );
  assert.match(
    source,
    /const denied = requirePermission\(request,\s*["']firm\.write["']\) \?\? checkCsrfGuard\(request\);/,
    "firm.write MUSS vor CSRF und vor jeder Verarbeitung geprüft werden",
  );
  assert.match(source, /if \(denied\) return denied;/);
});

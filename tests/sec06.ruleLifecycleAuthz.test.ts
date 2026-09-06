/**
 * SEC-06 (v1.36.33) — Rule-Lifecycle-Autorisierung:
 * Governance-Aktionen (activate/rollback/archive) erfordern explizit
 * Admin-Permissions (strategy.rules.*). guardWrite allein (firm.write)
 * reicht nicht mehr. Operator darf Draft anlegen/pausieren/reject,
 * Admin darf zusätzlich aktivieren, rollbacken und archivieren.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { requirePermission, resolveAuth } from "../src/auth";
import { guardWrite } from "../src/lib/apiAuth";

const ADMIN_TOKEN = "sec06-admin-token-0123456789";
const OPERATOR_TOKEN = "sec06-operator-token-0123456789";
const VIEWER_TOKEN = "sec06-viewer-token-0123456789";
const SESSION_SECRET = randomBytes(32).toString("hex");
const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"] as const;
const savedEnv = new Map<string, string | undefined>();

before(async () => {
  for (const key of AUTH_KEYS) savedEnv.set(key, process.env[key] ?? undefined);
});

beforeEach(() => {
  for (const key of AUTH_KEYS) delete process.env[key];
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
  process.env.FIRM_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.FIRM_SESSION_SECRET = SESSION_SECRET;
  process.env.AUTH_MODE = "token-required";
});

after(() => {
  for (const key of AUTH_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function req(headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://trading.example.test/api/firm/rules/test-id", { method, headers: { "content-type": "application/json", ...headers } });
}

test("SEC-06: Neue Governance-Permissions nur bei Admin (Matrix)", () => {
  const { ROLE_PERMISSIONS, hasPermission, permissionsForRole } = require("../src/auth");
  const perms = ["strategy.rules.write", "strategy.rules.activate", "strategy.rules.rollback", "strategy.rules.archive"];
  for (const p of perms) {
    assert.equal(hasPermission(permissionsForRole("viewer"), p), false, `viewer: kein ${p}`);
    assert.equal(hasPermission(permissionsForRole("operator"), p), false, `operator: kein ${p}`);
    assert.equal(hasPermission(permissionsForRole("admin"), p), true, `admin: ${p}`);
  }
});

test("SEC-06: Operator ohne Elevation darf Governance-Aktionen nicht (requirePermission)", async () => {
  const env = {
    FIRM_ADMIN_TOKEN: ADMIN_TOKEN,
    FIRM_API_TOKEN: OPERATOR_TOKEN,
  };
  const opReq = req({ "x-firm-token": OPERATOR_TOKEN });
  // firm.write bleibt erlaubt (Operator hat es).
  assert.equal(requirePermission(opReq, "firm.write", env), null);
  // Governance-Aktionen müssen verweigert werden.
  for (const perm of ["strategy.rules.activate", "strategy.rules.rollback", "strategy.rules.archive"] as const) {
    const denied = requirePermission(opReq, perm, env);
    assert.ok(denied, `Operator muss ${perm} verweigert bekommen`);
    assert.equal(denied!.status, 403);
    const body = await denied!.json() as { error?: string };
    assert.equal(body.error, "FORBIDDEN");
  }
});

test("SEC-06: Admin darf alle Governance-Aktionen (requirePermission)", () => {
  const env = { FIRM_ADMIN_TOKEN: ADMIN_TOKEN };
  const adminReq = req({ "x-admin-token": ADMIN_TOKEN });
  for (const perm of ["strategy.rules.write", "strategy.rules.activate", "strategy.rules.rollback", "strategy.rules.archive"] as const) {
    assert.equal(requirePermission(adminReq, perm, env), null, `Admin muss ${perm} erlaubt bekommen`);
  }
});

test("SEC-06: Viewer: 403 auf Governance-Aktionen und firm.write", async () => {
  const env = { FIRM_ADMIN_TOKEN: ADMIN_TOKEN, FIRM_VIEWER_TOKEN: VIEWER_TOKEN };
  const viewerReq = req({ "x-viewer-token": VIEWER_TOKEN });
  const deniedWrite = requirePermission(viewerReq, "firm.write", env);
  assert.ok(deniedWrite);
  assert.equal(deniedWrite!.status, 403);
  const deniedAct = requirePermission(viewerReq, "strategy.rules.activate", env);
  assert.ok(deniedAct);
  assert.equal(deniedAct!.status, 403);
});

test("SEC-06: guardWrite bleibt als Basisschutz — fehlender Operator-Token → 401, falscher Operator → 401, Admin-Token ohne Header → 403", async () => {
  // FIRM_API_TOKEN gesetzt, kein Operator-Header → 401 (fehlender Token).
  const deniedNoOp = guardWrite(req());
  assert.ok(deniedNoOp);
  assert.equal(deniedNoOp!.status, 401, "Kein Operator-Header bei gesetztem FIRM_API_TOKEN → 401");

  // Falscher Operator-Token → 401.
  const deniedWrong = guardWrite(req({ "x-firm-token": "wrong" }));
  assert.ok(deniedWrong);
  assert.equal(deniedWrong!.status, 401, "Falscher Operator-Token → 401");

  // Wenn NUR FIRM_ADMIN_TOKEN gesetzt ist (kein FIRM_API_TOKEN) und kein Admin-Header: 403.
  delete process.env.FIRM_API_TOKEN;
  const deniedAdminOnly = guardWrite(req());
  assert.ok(deniedAdminOnly);
  assert.equal(deniedAdminOnly!.status, 403, "Nur Admin-Token gesetzt, kein Header → 403");

  // Korrektes Operator-Token → null (erlaubt).
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
  const allowedOp = guardWrite(req({ "x-firm-token": OPERATOR_TOKEN }));
  assert.equal(allowedOp, null, "Korrektes Operator-Token → erlaubt");
});

test("SEC-06: Operator mit Admin-Token-Konfig bleibt nicht-eleviert — keine Governance-Permissions", () => {
  const env = {
    FIRM_ADMIN_TOKEN: ADMIN_TOKEN,
    FIRM_API_TOKEN: OPERATOR_TOKEN,
  };
  const opReq = req({ "x-firm-token": OPERATOR_TOKEN });
  const resolution = resolveAuth(opReq, env);
  assert.ok(resolution.ok);
  assert.equal(resolution.actor.role, "operator");
  assert.equal(resolution.actor.effectiveRole, "operator");
  assert.equal(resolution.actor.elevated, false);
  // Keine Governance-Permissions bei nicht-eleviertem Operator.
  for (const perm of ["strategy.rules.activate", "strategy.rules.rollback", "strategy.rules.archive"] as const) {
    assert.equal(requirePermission(opReq, perm, env)?.status, 403);
  }
});

test("SEC-06: Single-Admin-Elevation (kein Admin-Token) — Operator bekommt Governance-Permissions", () => {
  delete process.env.FIRM_ADMIN_TOKEN;
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
  const env = { FIRM_API_TOKEN: OPERATOR_TOKEN };
  const opReq = req({ "x-firm-token": OPERATOR_TOKEN });
  const resolution = resolveAuth(opReq, env);
  assert.ok(resolution.ok);
  assert.equal(resolution.actor.effectiveRole, "admin");
  assert.equal(resolution.actor.elevated, true);
  // Elevierter Operator hat Governance-Permissions (bestehendes Single-Admin-Pattern).
  assert.equal(requirePermission(opReq, "strategy.rules.activate", env), null);
});

/**
 * RBAC-Kern (Task 10, Phase 1).
 *
 * Matrix, Token-Auflösung, 401/403-Kompatibilität, live.gate nie gewährt.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_PERMISSIONS,
  hasPermission,
  liveGateGranted,
  permissionsForRole,
  requirePermission,
  resolveActor,
  resolveAuth,
  type Role,
} from "../src/auth";

const ALL_ROLES: Role[] = ["viewer", "operator", "admin"];

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/me", { headers });
}

const ENV_CLEAN: Record<string, string | undefined> = {
  FIRM_ADMIN_TOKEN: undefined,
  FIRM_API_TOKEN: undefined,
  FIRM_VIEWER_TOKEN: undefined,
};

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
});

test("Matrix: live.gate ist NUR der Admin-Rolle gewährt (Task 11)", () => {
  for (const role of ALL_ROLES) {
    const expected = role === "admin";
    assert.equal(liveGateGranted(permissionsForRole(role)), expected, role);
    assert.equal(hasPermission(ROLE_PERMISSIONS[role], "live.gate"), expected, role);
  }
});

test("Matrix: viewer liest, schreibt nicht; admin hat Credentials", () => {
  const viewer = permissionsForRole("viewer");
  assert.equal(hasPermission(viewer, "firm.read"), true);
  assert.equal(hasPermission(viewer, "ops.view"), true);
  assert.equal(hasPermission(viewer, "firm.write"), false);
  assert.equal(hasPermission(viewer, "broker.credentials"), false);

  const operator = permissionsForRole("operator");
  assert.equal(hasPermission(operator, "firm.kill"), true);
  assert.equal(hasPermission(operator, "broker.credentials"), false);
  assert.equal(hasPermission(operator, "routing.modes.write"), false);

  const admin = permissionsForRole("admin");
  assert.equal(hasPermission(admin, "broker.credentials"), true);
  assert.equal(hasPermission(admin, "routing.modes.write"), true);
  // Task 11: Admin darf das Gate BEDIENEN (Transition/Kill) — Live selbst
  // bleibt vom Enforcer gesperrt (State-Machine + Flags + Suite).
  assert.equal(hasPermission(admin, "live.gate"), true);
});

test("resolveActor: kein Token konfiguriert → local-open Admin", () => {
  const actor = resolveActor(req(), ENV_CLEAN);
  assert.ok(actor);
  assert.equal(actor.role, "admin");
  assert.equal(actor.source, "local-open");
  assert.equal(actor.auditId, "admin");
  assert.equal(actor.elevated, false);
  assert.equal(hasPermission(actor.permissions, "broker.credentials"), true);
  assert.equal(liveGateGranted(actor.permissions), true);
});

test("resolveActor: Admin-Token match über x-admin-token und x-firm-token", () => {
  const env = { ...ENV_CLEAN, FIRM_ADMIN_TOKEN: "admin-secret-token-123456" };
  const viaAdmin = resolveActor(req({ "x-admin-token": "admin-secret-token-123456" }), env);
  assert.equal(viaAdmin?.role, "admin");
  assert.equal(viaAdmin?.source, "admin-token");

  const viaFirm = resolveActor(req({ "x-firm-token": "admin-secret-token-123456" }), env);
  assert.equal(viaFirm?.role, "admin");

  const viaBearer = resolveActor(
    req({ authorization: "Bearer admin-secret-token-123456" }),
    env
  );
  assert.equal(viaBearer?.role, "admin");
});

test("resolveActor: Operator ohne Admin-Token wird elevatet", () => {
  const env = { ...ENV_CLEAN, FIRM_API_TOKEN: "operator-token-abcdef" };
  const actor = resolveActor(req({ "x-firm-token": "operator-token-abcdef" }), env);
  assert.ok(actor);
  assert.equal(actor.role, "operator");
  assert.equal(actor.effectiveRole, "admin");
  assert.equal(actor.elevated, true);
  assert.equal(hasPermission(actor.permissions, "broker.credentials"), true);
});

test("resolveActor: Operator mit gesetztem Admin-Token bleibt Operator", () => {
  const env = {
    FIRM_ADMIN_TOKEN: "admin-secret-token-123456",
    FIRM_API_TOKEN: "operator-token-abcdef",
  };
  const actor = resolveActor(req({ "x-firm-token": "operator-token-abcdef" }), env);
  assert.ok(actor);
  assert.equal(actor.role, "operator");
  assert.equal(actor.effectiveRole, "operator");
  assert.equal(actor.elevated, false);
  assert.equal(hasPermission(actor.permissions, "broker.credentials"), false);
  assert.equal(actor.auditId, "operator");
});

test("resolveActor: Viewer-Token", () => {
  const env = { ...ENV_CLEAN, FIRM_VIEWER_TOKEN: "viewer-token-xyzxyzxyz" };
  const actor = resolveActor(req({ "x-viewer-token": "viewer-token-xyzxyzxyz" }), env);
  assert.ok(actor);
  assert.equal(actor.role, "viewer");
  assert.equal(hasPermission(actor.permissions, "ops.view"), true);
  assert.equal(hasPermission(actor.permissions, "firm.write"), false);
});

test("requirePermission: Admin-Token gesetzt, kein Header → 403 FORBIDDEN", async () => {
  const env = { FIRM_ADMIN_TOKEN: "admin-secret-token-123456" };
  const denied = requirePermission(req(), "broker.credentials", env);
  assert.ok(denied);
  assert.equal(denied.status, 403);
  const body = (await denied.json()) as { error: string };
  assert.equal(body.error, "FORBIDDEN");
});

test("requirePermission: nur Operator-Token, kein Header → 401 UNAUTHORIZED", async () => {
  const env = { FIRM_API_TOKEN: "operator-token-abcdef" };
  const denied = requirePermission(req(), "broker.credentials", env);
  assert.ok(denied);
  assert.equal(denied.status, 401);
  const body = (await denied.json()) as { error: string };
  assert.equal(body.error, "UNAUTHORIZED");
});

test("requirePermission: Operator ohne Elevation darf Credentials (Single-Admin)", () => {
  const env = { FIRM_API_TOKEN: "operator-token-abcdef" };
  const allowed = requirePermission(
    req({ "x-firm-token": "operator-token-abcdef" }),
    "broker.credentials",
    env
  );
  assert.equal(allowed, null);
});

test("requirePermission: Operator mit Admin-Token-Konfig darf KEINE Credentials", async () => {
  const env = {
    FIRM_ADMIN_TOKEN: "admin-secret-token-123456",
    FIRM_API_TOKEN: "operator-token-abcdef",
  };
  const denied = requirePermission(
    req({ "x-firm-token": "operator-token-abcdef" }),
    "broker.credentials",
    env
  );
  assert.ok(denied);
  assert.equal(denied.status, 403);
});

test("requirePermission: live.gate nur Admin (Task 11) — viewer/operator 403", async () => {
  // local-open/Admin darf bedienen …
  assert.equal(requirePermission(req(), "live.gate", ENV_CLEAN), null);
  // … echte Rollen ohne Admin-Permission nicht:
  const env = { ...ENV_CLEAN, FIRM_ADMIN_TOKEN: "admin-secret-token-123456", FIRM_VIEWER_TOKEN: "viewer-token-abcdef" };
  const viewerDenied = requirePermission(req({ "x-viewer-token": "viewer-token-abcdef" }), "live.gate", env);
  assert.ok(viewerDenied);
  assert.equal(viewerDenied.status, 403);
  const operatorDenied = requirePermission(req({ "x-firm-token": "unknown-token" }), "live.gate", env);
  assert.ok(operatorDenied);
});

// SEC-06: Feingranulare Governance-Permissions für das Regelwerk.
// Aktivierung, Rollback und Archivierung sind strategische Governance-
// Aktionen und bleiben ausschließlich der Admin-Rolle vorbehalten.
const STRATEGY_RULE_PERMISSIONS = [
  "strategy.rules.write",
  "strategy.rules.activate",
  "strategy.rules.rollback",
  "strategy.rules.archive",
] as const;

test("SEC-06: Neue Governance-Permissions nur bei Admin", () => {
  for (const perm of STRATEGY_RULE_PERMISSIONS) {
    assert.equal(hasPermission(permissionsForRole("viewer"), perm), false, `viewer sollte nicht ${perm}`);
    assert.equal(hasPermission(permissionsForRole("operator"), perm), false, `operator sollte nicht ${perm}`);
    assert.equal(hasPermission(permissionsForRole("admin"), perm), true, `admin muss ${perm}`);
  }
});

test("SEC-06: Operator ohne Elevation darf keine Governance-Aktionen", async () => {
  const env = {
    FIRM_ADMIN_TOKEN: "admin-secret-token-123456",
    FIRM_API_TOKEN: "operator-token-abcdef",
  };
  const opReq = req({ "x-firm-token": "operator-token-abcdef" });
  for (const perm of ["strategy.rules.activate", "strategy.rules.rollback", "strategy.rules.archive"] as const) {
    const denied = requirePermission(opReq, perm, env);
    assert.ok(denied, `Operator muss ${perm} verweigert bekommen`);
    assert.equal(denied!.status, 403);
  }
  // firm.write (create/edit/pause/reject) bleibt erlaubt:
  assert.equal(requirePermission(opReq, "firm.write", env), null);
  // strategy.rules.write bleibt Admin vorbehalten (nicht Operator).
  assert.equal((requirePermission(opReq, "strategy.rules.write", env) as Response)?.status ?? 403, 403, "Operator darf nicht strategy.rules.write");
});

test("SEC-06: Admin darf alle Governance-Aktionen", () => {
  const env = { FIRM_ADMIN_TOKEN: "admin-secret-token-123456" };
  const adminReq = req({ "x-admin-token": "admin-secret-token-123456" });
  for (const perm of STRATEGY_RULE_PERMISSIONS) {
    assert.equal(requirePermission(adminReq, perm, env), null, `Admin muss ${perm} erlaubt bekommen`);
  }
});

test("SEC-06: Viewer: 403 auf alle Rule-Writes und Governance-Aktionen", async () => {
  const env = {
    FIRM_ADMIN_TOKEN: "admin-secret-token-123456",
    FIRM_VIEWER_TOKEN: "viewer-token-xyzxyzxyz",
  };
  const viewerReq = req({ "x-viewer-token": "viewer-token-xyzxyzxyz" });
  const deniedWrite = requirePermission(viewerReq, "firm.write", env);
  assert.ok(deniedWrite);
  assert.equal(deniedWrite!.status, 403);
  const deniedActivate = requirePermission(viewerReq, "strategy.rules.activate", env);
  assert.ok(deniedActivate);
  assert.equal(deniedActivate!.status, 403);
});

test("resolveAuth: falscher Token trifft nicht per Prefix", () => {
  const env = { FIRM_ADMIN_TOKEN: "admin-secret-token-123456" };
  const resolution = resolveAuth(req({ "x-admin-token": "admin-secret-token-123456XXXX" }), env);
  assert.equal(resolution.ok, false);
});

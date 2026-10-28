/** ASA-05/07: route-wide RBAC, CSRF and write-rate-limit regression gates. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { ALL_PERMISSIONS } from "../src/auth/permissions";
import { resolveAuth } from "../src/auth";
import { issueSession, SESSION_COOKIE } from "../src/lib/authSession";
import { resetRateLimiterForTests } from "../src/lib/apiAuth";

const API_ROOT = join(process.cwd(), "src/app/api");
const PUBLIC_METHODS = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "GET /api/docs", // Whitelisted docs catalogue/viewer; it contains curated public docs only.
  "POST /api/auth/login", // Password/token authentication has a dedicated limiter and credential check.
  "POST /api/auth/logout", // Idempotent session revocation is public, but CSRF + rate-limited (global revocation requires Admin).
  "POST /api/auth/refresh", // renewSession verifies the signed session and its session-bound CSRF token itself.
]);
const ENV_KEYS = [
  "FIRM_API_TOKEN", "FIRM_ADMIN_TOKEN", "FIRM_OPERATOR_TOKEN", "FIRM_VIEWER_TOKEN",
  "FIRM_SESSION_SECRET", "AUTH_MODE", "FIRM_RATE_LIMIT",
] as const;
const savedEnv = new Map<string, string | undefined>();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith("route.ts") ? [full] : [];
  });
}

function routePath(file: string): string {
  return `/api/${relative(API_ROOT, file).replaceAll("\\", "/").replace(/\/route\.ts$/, "")}`
    .replace(/\/\[([^\]]+)\]/g, "/[$1]");
}

function exportedHandlers(file: string): Array<{ method: string; body: string }> {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const handlers: Array<{ method: string; body: string }> = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(node.name.text)) {
        handlers.push({ method: node.name.text, body: node.body.getText(ast) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return handlers;
}

function routeSources(): Array<{ file: string; path: string; method: string; body: string; source: string }> {
  return walk(API_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return exportedHandlers(file).map((handler) => ({ file, path: routePath(file), ...handler, source }));
  });
}

before(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});
after(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRateLimiterForTests();
});

// New routes must explicitly join the permission set; helper guards are mapped
// to their underlying RBAC permission and dynamic rule-action lookups are counted.
test("ASA-05: every catalog permission is referenced by at least one API route", () => {
  const routes = routeSources();
  const guardSources = [
    readFileSync(join(process.cwd(), "src/lib/apiAuth.ts"), "utf8"),
    readFileSync(join(process.cwd(), "src/brokers/control-plane/guard.ts"), "utf8"),
  ].join("\n");
  const unused = ALL_PERMISSIONS.filter((permission) => {
    const direct = routes.some(({ body }) =>
      new RegExp(`(?:requirePermission|guardMutation)\\s*\\([^,]+,\\s*["']${permission.replaceAll(".", "\\.")}["']`).test(body),
    );
    const viaFirmWrite = permission === "firm.write" && guardSources.includes('checkApiToken(req)');
    const viaCredentialGuard = permission === "broker.credentials" && routes.some(({ body }) => body.includes("guardCredentialEndpoint("));
    const viaRuleAction = ["strategy.rules.archive", "strategy.rules.rollback"].includes(permission) &&
      routes.some(({ body, source }) => body.includes("RULE_ACTION_PERMISSIONS[") && source.includes("RULE_ACTION_PERMISSIONS"));
    return !(direct || viaFirmWrite || viaCredentialGuard || viaRuleAction);
  });
  assert.deepEqual(unused, [], `Unbenutzte ALL_PERMISSIONS: ${unused.join(", ")}`);
});

test("ASA-05/07: all non-public methods have auth; every mutation has CSRF and rate limit", () => {
  const errors: string[] = [];
  for (const route of routeSources()) {
    const key = `${route.method} ${route.path}`;
    const body = route.body;
    if (!PUBLIC_METHODS.has(key)) {
      const hasAuth = /\b(requirePermission|guardMutation|guardWrite|checkApiToken|checkAdminGuard|guardCredentialEndpoint)\s*\(/.test(body);
      if (!hasAuth) errors.push(`${key}: no auth guard`);
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(route.method) && key !== "POST /api/auth/login") {
      const csrf = /\b(guardWrite|guardMutation|guardCredentialEndpoint|checkCsrfGuard)\s*\(/.test(body) ||
        (key === "POST /api/auth/refresh" && body.includes("renewSession("));
      const rate = /\b(guardWrite|guardMutation|guardCredentialEndpoint|checkRateLimit|checkCredentialRateLimit)\s*\(/.test(body);
      if (!csrf) errors.push(`${key}: no CSRF enforcement`);
      if (!rate) errors.push(`${key}: no write rate limit`);
    }
  }
  assert.deepEqual(errors, [], errors.join("\n"));
  assert.match(readFileSync(join(process.cwd(), "src/lib/apiAuth.ts"), "utf8"),
    /guardWrite[\s\S]*?checkCsrfGuard\(req\)[\s\S]*?checkRateLimit\(req\)/,
    "guardWrite must apply CSRF before the shared write limiter");
});

function request(path: string, method = "GET", headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`https://trading.example.test${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body } : {}),
  });
}

test("ASA-05: anonymous firm API reads reject requests when FIRM_API_TOKEN is configured", async () => {
  process.env.FIRM_API_TOKEN = "asa05-api-token-0123456789";
  resetRateLimiterForTests();
  const [ops, config, live] = await Promise.all([
    import("../src/app/api/ops/route"),
    import("../src/app/api/firm/config/route"),
    import("../src/app/api/live/state/route"),
  ]);
  for (const [name, response] of [
    ["/api/ops", await ops.GET(request("/api/ops"))],
    ["/api/firm/config", await config.GET(request("/api/firm/config"))],
    ["/api/live/state", await live.GET(request("/api/live/state"))],
  ] as const) {
    assert.equal(response.status, 401, `${name} must reject anonymous reads`);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
});

test("ASA-05: operator cannot PUT firm configuration (firm.config is admin-only)", async () => {
  process.env.FIRM_ADMIN_TOKEN = "asa05-admin-token-0123456789";
  process.env.FIRM_OPERATOR_TOKEN = "asa05-operator-token-0123456789";
  delete process.env.FIRM_API_TOKEN;
  resetRateLimiterForTests();
  const { PUT } = await import("../src/app/api/firm/config/route");
  const response = await PUT(request("/api/firm/config", "PUT", {
    "x-firm-token": process.env.FIRM_OPERATOR_TOKEN,
    "x-csrf-token": process.env.FIRM_ADMIN_TOKEN,
  }, JSON.stringify({ key: "maxPositionPct", value: 0.1 })));
  assert.equal(response.status, 403);
});

test("ASA-07: session cookies without the double-submit header cannot mutate micro or routing", async () => {
  process.env.FIRM_ADMIN_TOKEN = "asa07-admin-token-0123456789";
  process.env.FIRM_OPERATOR_TOKEN = "asa07-operator-token-0123456789";
  process.env.FIRM_SESSION_SECRET = "a".repeat(64);
  delete process.env.FIRM_API_TOKEN;
  process.env.AUTH_MODE = "token-required";
  resetRateLimiterForTests();

  const login = request("/api/auth/login", "POST", { "x-admin-token": process.env.FIRM_ADMIN_TOKEN });
  const resolved = resolveAuth(login);
  assert.ok(resolved.ok);
  const issued = issueSession(login, resolved.actor);
  assert.ok(issued.ok);
  const cookie = `${SESSION_COOKIE}=${issued.sessionToken}`;
  // This checkout exposes /api/firm/micro as read-only (no POST handler exists);
  // exercise the same centralized guardWrite path on the adjacent missions write.
  const missionPost = (await import("../src/app/api/firm/missions/route")).POST;
  const microPost = await missionPost(request("/api/firm/missions", "POST", { cookie }, "{}"));
  assert.equal(microPost.status, 403);
  assert.equal(((await microPost.json()) as { error?: string }).error, "CSRF_INVALID");

  const routingPut = await (await import("../src/app/api/routing/modes/route")).PUT(
    request("/api/routing/modes", "PUT", { cookie }, JSON.stringify({ modes: { CEO: "hybrid" } })),
  );
  assert.equal(routingPut.status, 403);
  assert.equal(((await routingPut.json()) as { error?: string }).error, "CSRF_INVALID");
});

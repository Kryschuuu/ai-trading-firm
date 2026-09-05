/**
 * SEC-01: Session-Vertrauensgrenze, Credential-Bindung und Rechteprojektion.
 * Alle Credentials sind isolierte Testwerte; keine DB und keine echten Orders.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { assertAuthConfigured, ConfigurationError } from "../src/auth/authMode";
import { permissionsForRole } from "../src/auth/permissions";
import { requirePermission, resolveAuth } from "../src/auth/resolve";
import { checkApiToken, resetRateLimiterForTests } from "../src/lib/apiAuth";
import {
  issueSession,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionActor,
  sessionSecret,
  verifySessionToken,
} from "../src/lib/authSession";
import { POST as postLogin } from "../src/app/api/auth/login/route";

type Env = Record<string, string | undefined>;
const ADMIN = "sec01-test-admin-credential-not-for-deployment";
const OPERATOR = "sec01-test-operator-credential-not-for-deployment";
const VIEWER = "sec01-test-viewer-credential-not-for-deployment";
const SECRET = randomBytes(32).toString("hex");
const TOKEN_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN"] as const;
const ENV_KEYS = [...TOKEN_KEYS, "FIRM_SESSION_SECRET", "NODE_ENV", "AUTH_MODE"];
const FULL_ENV: Env = {
  FIRM_ADMIN_TOKEN: ADMIN,
  FIRM_API_TOKEN: OPERATOR,
  FIRM_VIEWER_TOKEN: VIEWER,
  FIRM_SESSION_SECRET: SECRET,
  AUTH_MODE: "token-required",
};
const VIEWER_ENV: Env = {
  FIRM_VIEWER_TOKEN: VIEWER,
  FIRM_SESSION_SECRET: SECRET,
  AUTH_MODE: "token-required",
};
const saved = new Map<string, string | undefined>();

function syncEnv(env: Env): void {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  syncEnv({});
  resetRateLimiterForTests();
});

afterEach(() => {
  syncEnv(Object.fromEntries(saved));
  saved.clear();
  resetRateLimiterForTests();
});

function withSession(token: string): Request {
  return new Request("https://localhost/api/firm/tick", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

function signed(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

function issue(token: string, env: Env) {
  const request = new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "x-firm-token": token },
  });
  const resolution = resolveAuth(request, env);
  assert.ok(resolution.ok);
  const result = issueSession(request, resolution.actor, env);
  assert.ok(result.ok);
  assert.equal(result.open, false);
  return result;
}

async function login(token: string, env: Env) {
  syncEnv(env);
  return postLogin(new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }));
}

// Exploit-Reproduktion mit dem alten Schema; darf auch nach einem Upgrade
// niemals durch einen Kompatibilitaets-/Fallback-Pfad wieder akzeptiert werden.
function legacyViewerForgery(): string {
  const oldSecret = createHash("sha256")
    .update(`aitf-session-v1\x00${VIEWER}`)
    .digest("base64url");
  return signed({
    v: 1,
    role: "admin",
    effectiveRole: "admin",
    elevated: false,
    auditId: "admin",
    permissions: [...permissionsForRole("admin")],
    csrf: "ab".repeat(32),
    exp: Date.now() + SESSION_TTL_MS,
  }, oldSecret);
}

test("SEC-01: Viewer-only darf keine selbst signierte Admin-Session authentifizieren", () => {
  const env = { FIRM_VIEWER_TOKEN: VIEWER };
  assert.equal(readSession(withSession(legacyViewerForgery()), env), null);
  assert.equal(resolveAuth(withSession(legacyViewerForgery()), env).ok, false);
});

test("SEC-01: Viewer-only-Faelschung scheitert an RBAC UND altem Firm-Schreib-Guard", () => {
  const env = { FIRM_VIEWER_TOKEN: VIEWER };
  syncEnv(env);
  const req = withSession(legacyViewerForgery());
  for (const permission of permissionsForRole("admin")) {
    assert.ok(requirePermission(req, permission, env), `${permission} muss gesperrt sein`);
  }
  assert.ok(checkApiToken(req), "auch checkApiToken muss die Faelschung ablehnen");
});

test("SEC-01: kein Session-Schluessel aus Login-Credentials, auch nicht in Dev", () => {
  for (const key of TOKEN_KEYS) {
    assert.equal(sessionSecret({ [key]: VIEWER }), "");
  }
});

test("SEC-01: Produktion mit Viewer-Token, aber ohne Session-Secret verweigert Boot", () => {
  assert.throws(
    () => assertAuthConfigured({ NODE_ENV: "production", FIRM_VIEWER_TOKEN: VIEWER }),
    (e: unknown) => e instanceof ConfigurationError && e.code === "SESSION_SECRET_REQUIRED"
  );
});

test("SEC-01: Login ohne unabhaengiges Secret scheitert ohne Cookie, nicht open:true", async () => {
  for (const NODE_ENV of ["development", "production"]) {
    const response = await login(VIEWER, { NODE_ENV, FIRM_VIEWER_TOKEN: VIEWER });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.json();
    assert.equal(body.error, "SESSION_SECRET_REQUIRED");
    assert.equal(body.ok, false);
    assert.ok(!JSON.stringify(body).includes(VIEWER));
  }
});

test("SEC-01: leere, kurze und als Auth-Token wiederverwendete Secrets sind ungueltig", () => {
  for (const secret of ["", "   ", "short", ADMIN, OPERATOR, VIEWER, ` ${VIEWER} `]) {
    const env = { ...FULL_ENV, NODE_ENV: "production", FIRM_SESSION_SECRET: secret };
    assert.equal(sessionSecret(env), "");
    assert.throws(() => assertAuthConfigured(env), ConfigurationError);
  }
});

test("SEC-01: korrekt signierte Permission-/Rollen-Snapshots werden nicht vertraut", () => {
  const original = decode(issue(VIEWER, VIEWER_ENV).sessionToken);
  const mutations = [
    { permissions: [...permissionsForRole("admin")] },
    { permissions: ["firm.read", "firm.write"] },
    { permissions: ["firm.read", "live.gate"] },
    { role: "admin", effectiveRole: "admin", elevated: false, auditId: "admin", permissions: [...permissionsForRole("admin")] },
    { effectiveRole: "admin", elevated: true },
    { role: "operator" },
    { role: "__proto__" },
    { effectiveRole: "constructor" },
    { auditId: "admin" },
    { permissions: ["firm.read", "firm.read"] },
  ];
  for (const mutation of mutations) {
    const token = signed({ ...original, ...mutation });
    assert.equal(verifySessionToken(token, SECRET), null, JSON.stringify(mutation));
    assert.equal(readSession(withSession(token), VIEWER_ENV), null);
  }
});

test("SEC-01: sessionActor akzeptiert auch direkt keinen manipulierten Snapshot", () => {
  const payload = readSession(withSession(issue(VIEWER, VIEWER_ENV).sessionToken), VIEWER_ENV);
  assert.ok(payload);
  const modified = { ...payload, permissions: [...permissionsForRole("admin")] };
  assert.equal(sessionActor(modified, VIEWER_ENV), null);
});

test("SEC-01: Credential-Selektor ist an die ausstellende Identitaet gebunden", () => {
  const original = decode(issue(VIEWER, FULL_ENV).sessionToken);
  for (const credential of ["admin-token", "api-token", "local-open", "api-session", "__proto__", "constructor", "unknown"]) {
    const token = signed({ ...original, credential });
    assert.equal(readSession(withSession(token), FULL_ENV), null, credential);
    assert.equal(resolveAuth(withSession(token), FULL_ENV).ok, false, credential);
  }
});

test("SEC-01: Rotation/Entfernung jedes Credentials widerruft bestehende Sessions", () => {
  const tokens = [ADMIN, OPERATOR, VIEWER].map((token) => issue(token, FULL_ENV).sessionToken);
  for (const key of TOKEN_KEYS) {
    for (const replacement of [undefined, `${FULL_ENV[key]}-rotated`]) {
      const changed = { ...FULL_ENV, [key]: replacement };
      for (const token of tokens) {
        assert.equal(readSession(withSession(token), changed), null, `${key}: ${replacement ? "Rotation" : "Entfernung"}`);
      }
    }
  }
});

test("SEC-01: Single-Admin-Elevation bleibt nach Einrichtung eines Admins nicht erhalten", () => {
  const env = { FIRM_API_TOKEN: OPERATOR, FIRM_SESSION_SECRET: SECRET };
  const old = issue(OPERATOR, env).sessionToken;
  const changed = { ...env, FIRM_ADMIN_TOKEN: ADMIN };
  assert.equal(readSession(withSession(old), changed), null);
  assert.ok(requirePermission(withSession(old), "live.gate", changed));
  const fresh = resolveAuth(withSession(issue(OPERATOR, changed).sessionToken), changed);
  assert.ok(fresh.ok);
  assert.equal(fresh.actor.elevated, false);
  assert.equal(fresh.actor.effectiveRole, "operator");
  assert.ok(!fresh.actor.permissions.includes("live.gate"));
});

test("SEC-01: Operator-Credential zu Viewer degradiert verliert Schreibrechte sofort", () => {
  const old = issue(OPERATOR, FULL_ENV).sessionToken;
  const changed = { ...FULL_ENV, FIRM_API_TOKEN: undefined, FIRM_VIEWER_TOKEN: OPERATOR };
  syncEnv(changed);
  assert.equal(readSession(withSession(old), changed), null);
  assert.ok(checkApiToken(withSession(old)));
  assert.ok(requirePermission(withSession(old), "firm.write", changed));
});

test("SEC-01: exakt am Ablaufzeitpunkt ist eine Session nicht mehr gueltig", () => {
  const token = issue(VIEWER, VIEWER_ENV).sessionToken;
  const payload = decode(token);
  assert.equal(verifySessionToken(token, SECRET, payload.exp as number), null);
});

test("SEC-01: echtes local-open stellt auch mit separatem Secret keine Session aus", async () => {
  const response = await login("unused", { AUTH_MODE: "local-open", FIRM_SESSION_SECRET: SECRET });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.open, true);
  assert.equal(body.session, false);
  assert.equal(response.headers.get("set-cookie"), null);
});

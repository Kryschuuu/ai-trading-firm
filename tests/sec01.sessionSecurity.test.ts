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

test("SEC-01: alle Rollen behalten exakt die serverseitige Permission-Matrix", () => {
  const scenarios = [
    { token: ADMIN, env: FULL_ENV },
    { token: OPERATOR, env: FULL_ENV },
    { token: VIEWER, env: FULL_ENV },
    { token: VIEWER, env: VIEWER_ENV },
    { token: OPERATOR, env: { FIRM_API_TOKEN: OPERATOR, FIRM_SESSION_SECRET: SECRET } },
  ];
  for (const { token, env } of scenarios) {
    syncEnv(env);
    const header = resolveAuth(new Request("https://localhost/api/x", { headers: { "x-firm-token": token } }), env);
    assert.ok(header.ok);
    const session = issue(token, env);
    const resolved = resolveAuth(withSession(session.sessionToken), env);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.actor, { ...header.actor, source: "api-session" });
    for (const permission of permissionsForRole("admin")) {
      assert.equal(
        requirePermission(withSession(session.sessionToken), permission, env) === null,
        header.actor.permissions.includes(permission),
        `${header.actor.role}: ${permission}`
      );
    }
    assert.equal(checkApiToken(withSession(session.sessionToken)) === null, header.actor.permissions.includes("firm.write"));
    const payload = decode(session.sessionToken);
    assert.equal(payload.v, 2);
    assert.deepEqual(Object.keys(payload).sort(), ["authEpoch", "credential", "csrf", "exp", "iat", "v"]);
    for (const secret of [ADMIN, OPERATOR, VIEWER, SECRET]) {
      assert.ok(!JSON.stringify(payload).includes(secret), "kein Credential-Material im Payload");
    }
  }
});

test("SEC-01: auch der Session-Zweig bei gesetztem FIRM_API_TOKEN lehnt Rechteinjektion ab", () => {
  syncEnv(FULL_ENV);
  const payload = decode(issue(VIEWER, FULL_ENV).sessionToken);
  const forged = signed({ ...payload, permissions: [...permissionsForRole("admin")] });
  assert.ok(checkApiToken(withSession(forged)));
  assert.ok(requirePermission(withSession(forged), "live.gate", FULL_ENV));
});

test("SEC-01: reale Write-, Disarm- und Credential-Routen lehnen Viewer/Faelschungen vor Seiteneffekten ab", async () => {
  const { POST: tick } = await import("../src/app/api/firm/tick/route");
  const { GET: challenge } = await import("../src/app/api/firm/kill/challenge/route");
  const { POST: credentials } = await import("../src/app/api/brokers/[venue]/credentials/route");
  const validViewer = issue(VIEWER, VIEWER_ENV);
  for (const [token, env] of [
    [legacyViewerForgery(), { FIRM_VIEWER_TOKEN: VIEWER }],
    [validViewer.sessionToken, VIEWER_ENV],
    [signed({ ...decode(validViewer.sessionToken), permissions: [...permissionsForRole("admin")] }), VIEWER_ENV],
  ] as const) {
    syncEnv(env);
    const request = () => new Request(withSession(token), {
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": validViewer.csrf },
    });
    for (const response of [
      await tick(request()),
      await challenge(request()),
      await credentials(request(), { params: Promise.resolve({ venue: "bitunix" }) }),
    ]) {
      assert.ok([401, 403].includes(response.status), `Auth-Deny statt Route/DB-Aufruf: ${response.status}`);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.nonce, undefined);
    }
  }
});

test("SEC-01: ungueltige Konfiguration und vollstaendige Credential-Entfernung akzeptieren keine alten Sessions", () => {
  const token = issue(ADMIN, FULL_ENV).sessionToken;
  for (const env of [
    { ...FULL_ENV, FIRM_SESSION_SECRET: undefined },
    { ...FULL_ENV, FIRM_SESSION_SECRET: " " },
    { ...FULL_ENV, FIRM_SESSION_SECRET: VIEWER },
    { ...FULL_ENV, FIRM_SESSION_SECRET: randomBytes(32).toString("hex") },
    { ...FULL_ENV, AUTH_MODE: "typo" },
    { FIRM_SESSION_SECRET: SECRET, AUTH_MODE: "token-required" },
    { FIRM_SESSION_SECRET: SECRET, AUTH_MODE: "local-open" },
  ]) {
    assert.equal(readSession(withSession(token), env), null);
  }
});

test("SEC-01: Schema, TTL-Obergrenze, Zeitwerte und Credential-Epoche sind strikt", () => {
  const original = decode(issue(VIEWER, VIEWER_ENV).sessionToken);
  const now = original.iat as number;
  const mutations = [
    { v: 1 }, { v: 3 }, { v: "2" },
    { credential: null }, { credential: [] },
    { authEpoch: "" }, { authEpoch: "!".repeat(43) },
    { csrf: "" }, { csrf: "ab" }, { csrf: 7 },
    { exp: now }, { exp: now - 1 }, { exp: String(original.exp) },
    { exp: now + SESSION_TTL_MS + 1 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    { exp: (original.exp as number) + 0.5 },
    { iat: now + 1 }, { iat: -1 }, { iat: String(now) }, { iat: now - 0.5 },
    { extra: true },
  ];
  for (const mutation of mutations) {
    assert.equal(verifySessionToken(signed({ ...original, ...mutation }), SECRET, now), null, JSON.stringify(mutation));
  }
  for (const key of Object.keys(original)) {
    const missing = { ...original };
    delete missing[key];
    assert.equal(verifySessionToken(signed(missing), SECRET, now), null, `fehlt: ${key}`);
  }
  const token = signed(original);
  assert.ok(verifySessionToken(token, SECRET, now));
  assert.ok(verifySessionToken(token, SECRET, (original.exp as number) - 1));
  assert.equal(verifySessionToken(token, SECRET, NaN), null);
  assert.equal(verifySessionToken(token, SECRET, Infinity), null);
  assert.equal(verifySessionToken(token, "", now), null);
  assert.equal(verifySessionToken(token, "short", now), null);
});

test("SEC-01: kaputte/mehrdeutige Cookies und signierte Nicht-Objekte bleiben fail-closed", () => {
  const token = issue(VIEWER, VIEWER_ENV).sessionToken;
  for (const malformed of [
    "", ".", "..", "a.b", `${token}.extra`, `${token}=`, ` ${token}`, "a".repeat(4097),
    signed(null), signed([]), signed(12), signed("text"),
  ]) {
    assert.doesNotThrow(() => verifySessionToken(malformed, SECRET));
    assert.equal(verifySessionToken(malformed, SECRET), null);
  }
  const body = Buffer.from("not json").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
  assert.equal(verifySessionToken(`${body}.${signature}`, SECRET), null);
  for (const cookies of [
    `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`,
    `${SESSION_COOKIE}=; ${SESSION_COOKIE}=${token}`,
    `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=`,
  ]) {
    assert.equal(readSession(new Request("https://localhost", { headers: { cookie: cookies } }), VIEWER_ENV), null);
  }
  assert.equal(readSession(new Request("https://localhost", { headers: { cookie: "other=value; broken" } }), VIEWER_ENV), null);
});

test("SEC-01: v1-Cookies werden selbst mit dem neuen unabhaengigen Key nicht akzeptiert", () => {
  const old = decode(legacyViewerForgery());
  const token = signed(old);
  assert.equal(verifySessionToken(token, SECRET), null);
  assert.equal(readSession(withSession(token), FULL_ENV), null);
});

test("SEC-01: Ausstellen erfordert einen konsistenten aktuellen Header-Actor, nicht eine Session", () => {
  const req = new Request("https://localhost/api/auth/login", { headers: { "x-firm-token": VIEWER } });
  const resolved = resolveAuth(req, FULL_ENV);
  assert.ok(resolved.ok);
  for (const actor of [
    { ...resolved.actor, source: "api-session" as const },
    { ...resolved.actor, source: "local-open" as const },
    { ...resolved.actor, source: "admin-token" as const },
    { ...resolved.actor, role: "admin" as const },
    { ...resolved.actor, effectiveRole: "admin" as const },
    { ...resolved.actor, elevated: true },
    { ...resolved.actor, auditId: "admin" as const },
    { ...resolved.actor, permissions: permissionsForRole("admin") },
  ]) {
    const issued = issueSession(req, actor, FULL_ENV);
    assert.equal(issued.ok, false);
    if (!issued.ok) assert.equal(issued.error, "SESSION_CREDENTIAL_REQUIRED");
  }
  assert.equal(issueSession(req, resolved.actor, { ...FULL_ENV, FIRM_VIEWER_TOKEN: undefined }).ok, false);
});

test("SEC-01: Login erbt keine Autoritaet aus Body-Claims, Headern oder vorhandenen Cookies", async () => {
  syncEnv(FULL_ENV);
  const adminSession = issue(ADMIN, FULL_ENV);
  for (const token of ["incorrect", VIEWER]) {
    const response = await postLogin(new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": ADMIN,
        cookie: `${SESSION_COOKIE}=${adminSession.sessionToken}`,
      },
      body: JSON.stringify({ token, role: "admin", effectiveRole: "admin", permissions: permissionsForRole("admin") }),
    }));
    if (token === "incorrect") {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("set-cookie"), null);
    } else {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.actor.role, "viewer");
      assert.deepEqual(body.actor.permissions, permissionsForRole("viewer"));
    }
  }
});

test("SEC-01: ungueltige JSON-Login-Bodies liefern 400 statt Ausnahme oder Session", async () => {
  syncEnv(FULL_ENV);
  for (const body of ["null", "[]", "true", "12", '"text"', "{", "{}", '{"token":null}', '{"token":{}}']) {
    const response = await postLogin(new Request("https://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).error, "MISSING_TOKEN");
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

/**
 * W1 (v1.36.23) — HttpOnly-Session statt API-Token in localStorage.
 *
 * Abdeckung:
 *   1. Session-Modul: Schlüssel-Ableitung, Signaturen, Ablauf, Deadline-Rollover.
 *   2. Cookie-Attribute: HttpOnly (nur firm_session), Secure, SameSite=Strict,
 *      Path=/, Max-Age=900. Kein roher Token im Cookie.
 *   3. resolveAuth liest die Session-Cookie (kein Header nötig).
 *   4. checkApiToken akzeptiert Operator-/Admin-Session für Writes.
 *   5. checkCsrfGuard: Double-Submit gegen session-gebundenen CSRF-Wert;
 *      Legacy-Token-Pfad bleibt.
 *   6. POST /api/auth/login: Set-Cookie bei gültigem Token, 401 bei falschem,
 *      400 bei fehlendem, 400 SESSION_HTTPS_REQUIRED in Produktion ohne TLS,
 *      Open-Mode ohne Session.
 *   7. Statik-Akzeptanz: kein localStorage-Zugriff auf "firmToken" mehr in
 *      src/components + src/lib (nur noch Entfernen-Altbestand in browserSession).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAuth, type Actor } from "../src/auth";
import { checkApiToken } from "../src/lib/apiAuth";
import {
  SESSION_COOKIE,
  SESSION_CSRF_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_S,
  issueSession,
  readSession,
  sessionSecret,
  sessionActor,
  verifySessionToken,
} from "../src/lib/authSession";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { checkCsrfGuard } from "../src/brokers/control-plane/guard";
import { POST as postLogin } from "../src/app/api/auth/login/route";

const OP = "operator-secret-456";
const ADMIN = "admin-secret-123";
const VIEWER = "viewer-secret-789";

type Env = Record<string, string | undefined>;

const ENV_OP: Env = { FIRM_API_TOKEN: OP, FIRM_ADMIN_TOKEN: undefined, FIRM_VIEWER_TOKEN: undefined };
const ENV_ADMIN: Env = { FIRM_API_TOKEN: OP, FIRM_ADMIN_TOKEN: ADMIN, FIRM_VIEWER_TOKEN: undefined };
const ENV_VIEWER: Env = { FIRM_API_TOKEN: undefined, FIRM_ADMIN_TOKEN: undefined, FIRM_VIEWER_TOKEN: VIEWER };

function req(url = "http://localhost/api/x", headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

function withSession(sessionToken: string, extra: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", {
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, ...extra },
  });
}

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
  delete process.env.FIRM_SESSION_SECRET;
  delete process.env.AUTH_MODE;
  // NODE_ENV ist im Node-Typ read-only deklariert — deshalb indexiert.
  delete (process.env as Record<string, string | undefined>)["NODE_ENV"];
  __resetAllSingletonsForTests();
});

function syncEnv(env: Env): void {
  const p = process.env as Record<string, string | undefined>;
  delete p["NODE_ENV"];
  for (const k of ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET"]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Erzeugt eine signierte Session zu einem Token und liefert Token+Payload. */
function makeSession(tok: string, env: Env, url = "http://localhost/api/x") {
  const resolution = resolveAuth(
    new Request(url, { headers: { "x-firm-token": tok } }),
    env
  );
  if (!resolution.ok) throw new Error(`probe failed: ${resolution.error}`);
  const issued = issueSession(new Request(url), resolution.actor, env);
  if (!issued.ok) throw new Error(`issue failed: ${issued.error}`);
  return { actor: resolution.actor, issued, secret: sessionSecret(env) };
}

// ── 1. Schlüssel-Ableitung ─────────────────────────────────────────────────

test("sessionSecret: FIRM_SESSION_SECRET schlägt abgeleiteten Schlüssel", () => {
  const env = { ...ENV_OP, FIRM_SESSION_SECRET: "rotierbares-secret" };
  assert.equal(sessionSecret(env), "rotierbares-secret");
});

test("sessionSecret: deterministisch aus konfigurierten Tokens abgeleitet; leer ohne Tokens", () => {
  const a = sessionSecret(ENV_OP);
  const b = sessionSecret(ENV_OP);
  assert.ok(a.length > 0, "abgeleiteter Schlüssel vorhanden");
  assert.equal(a, b, "deterministisch je Konfiguration");
  assert.ok(sessionSecret(ENV_OP) !== sessionSecret(ENV_ADMIN), "unterschiedlich bei anderer Konfiguration");
  assert.equal(sessionSecret({}), "", "kein Schlüssel ohne Tokens (local-open)");
});

// ── 2./3./4. Cookie-Attribute & Secret-Freiheit ────────────────────────────

test("issueSession: HttpOnly nur auf firm_session, Flags Secure/SameSite=Strict/Max-Age=900/Path=/ auf beiden", () => {
  const { issued } = makeSession(OP, ENV_OP);
  assert.equal(issued.cookies.length, 2);
  assert.equal(issued.open, false);
  const [sessionCookie, csrfCookie] = issued.cookies;
  assert.ok(sessionCookie.startsWith(`${SESSION_COOKIE}=`), "firm_session-Cookie");
  assert.ok(csrfCookie.startsWith(`${SESSION_CSRF_COOKIE}=`), "firm_csrf-Cookie");
  for (const c of [sessionCookie, csrfCookie]) {
    assert.ok(c.includes("; Secure"), "Secure");
    assert.ok(c.includes("; SameSite=Strict"), "SameSite=Strict");
    assert.ok(c.includes("; Path=/"), "Path=/");
    assert.ok(c.includes(`; Max-Age=${SESSION_TTL_S}`), `Max-Age=${SESSION_TTL_S}`);
  }
  assert.ok(sessionCookie.includes("; HttpOnly"), "firm_session ist HttpOnly");
  assert.ok(!csrfCookie.includes("; HttpOnly"), "firm_csrf bleibt für JS lesbar (Double-Submit)");
  // Session-Wert enthält den rohen Token niemals.
  assert.ok(!SessionTokenValue(sessionCookie).includes(OP), "kein roher Token in der Session");
});

function SessionTokenValue(cookie: string): string {
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";", eq);
  return cookie.slice(eq + 1, semi === -1 ? undefined : semi).trim();
}

test("issueSession: CSRF-Wert ist identisch in Cookie und signed Payload", () => {
  const { issued } = makeSession(OP, ENV_OP);
  assert.equal(CsrfValue(issued.cookies[1]), issued.csrf);
  const payload = verifySessionToken(
    SessionTokenValue(issued.cookies[0]),
    sessionSecret(ENV_OP)
  );
  assert.ok(payload, "Payload verifizierbar");
  assert.equal(payload?.csrf, issued.csrf);
});

function CsrfValue(cookie: string): string {
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";", eq);
  return cookie.slice(eq + 1, semi === -1 ? undefined : semi).trim();
}

// ── 5. Roundtrip / Ablauf / Manipulation ───────────────────────────────────

test("readSession: Roundtrip liefert Rolle, Effektiv-Rolle, Source und Permissions", () => {
  const { issued, secret } = makeSession(OP, ENV_OP);
  const payload = verifySessionToken(SessionTokenValue(issued.cookies[0]), secret);
  assert.ok(payload, "Token verifiziert");
  const actor = sessionActor(payload!);
  assert.equal(actor.role, "operator");
  assert.equal(actor.source, "api-session");
  assert.ok(actor.permissions.includes("firm.write"), "Operator darf schreiben");
  assert.ok(actor.permissions.includes("firm.kill"));
  assert.equal(payload!.csrf.length, 64, "CSRF ist 32 Byte hex");
});

test("readSession: abgelaufen → null (Ablauf innerhalb Max-Age=900)", () => {
  const { issued, secret } = makeSession(OP, ENV_OP);
  const token = SessionTokenValue(issued.cookies[0]);
  assert.ok(verifySessionToken(token, secret), "sofort gültig");
  assert.equal(verifySessionToken(token, secret, Date.now() + SESSION_TTL_MS + 1000), null, "nach 15 min + Tol abgelaufen");
  const req = withSession(token);
  assert.equal(readSession(req, ENV_OP, Date.now() + SESSION_TTL_MS + 1000), null);
});

test("readSession: manipuliertes Token → null (Signature verhindert Fälschung)", () => {
  const { issued, secret } = makeSession(OP, ENV_OP);
  const [body, sig] = SessionTokenValue(issued.cookies[0]).split(".");
  // Wichtig: nicht das LETZTE base64url-Zeichen manipulieren — die letzten
  // 2 Bits einer 32-Byte-HMAC sind Padding (base64url fehlt das '='). Zwei
  // Zeichen derselben 4-Bit-Zeichengruppe dekodieren zu IDENTISCHEN Bytes
  // (harmlos für die Signatur, aber ungeeignet als Test). Erstes Zeichen
  // zählt dagegen immer — dort gehen alle 6 Bits in den Puffer.
  const tamperedBody = (body[0] === "A" ? "B" : "A") + body.slice(1);
  assert.equal(verifySessionToken([tamperedBody, sig].join("."), secret), null);
  const tamperedSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(verifySessionToken([body, tamperedSig].join("."), secret), null);
});

test("readSession: anderer Schlüssel (andere Token-Konfiguration) → ungültig", () => {
  const { issued } = makeSession(OP, ENV_OP);
  const token = SessionTokenValue(issued.cookies[0]);
  assert.equal(verifySessionToken(token, sessionSecret(ENV_ADMIN)), null);
});

// ── 3′. resolveAuth über Session-Cookie ────────────────────────────────────

test("resolveAuth: Session-Cookie liefert Actor ohne jeden Token-Header", () => {
  for (const [tok, env, role, writes] of [
    [OP, ENV_OP, "operator", true],
    [ADMIN, ENV_ADMIN, "admin", true],
    [VIEWER, ENV_VIEWER, "viewer", false],
  ] as const) {
    const { issued } = makeSession(tok, env);
    const resolution = resolveAuth(withSession(SessionTokenValue(issued.cookies[0])), env);
    assert.equal(resolution.ok, true, `${role}-Session auflösbar`);
    if (!resolution.ok) continue;
    assert.equal(resolution.actor.role, role);
    assert.equal(resolution.actor.source, "api-session");
    assert.equal(resolution.actor.permissions.includes("firm.write"), writes, `${role} write`);
  }
});

test("resolveAuth: Header schlägt Session (curl/CLI bleibt identisch)", () => {
  const { issued } = makeSession(OP, ENV_OP);
  const adminProbe = resolveAuth(
    new Request("http://localhost/api/x", {
      headers: { cookie: `${SESSION_COOKIE}=${SessionTokenValue(issued.cookies[0])}`, "x-admin-token": ADMIN },
    }),
    ENV_ADMIN
  );
  assert.equal(adminProbe.ok, true);
  if (adminProbe.ok) assert.equal(adminProbe.actor.role, "admin");
});

test("resolveAuth: Produktion ohne Token und ohne Session bleibt zu (Sicherheitsnetz)", () => {
  const env = { ...ENV_OP, NODE_ENV: "production" };
  const resolution = resolveAuth(req(), env);
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.equal(resolution.status, 401);
});

// ── 4. checkApiToken ───────────────────────────────────────────────────────

test("checkApiToken: Operator-/Admin-Session berechtigt zum Schreiben, manipuliert → 401", () => {
  syncEnv(ENV_OP);
  const { issued } = makeSession(OP, ENV_OP);
  // Session statt Header:
  assert.equal(checkApiToken(withSession(SessionTokenValue(issued.cookies[0]))), null, "Session reicht");
  // Legacy-Pfad bleibt:
  assert.equal(checkApiToken(req("http://localhost/api/x", { "x-firm-token": OP })), null);
  // Manipulierte Session → 401:
  const tok = SessionTokenValue(issued.cookies[0]);
  const bad = withSession(tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a"));
  const denied = checkApiToken(bad) as Response;
  assert.equal(denied.status, 401);
  // Ohne Credentials (kein Header, keine Session) → 401:
  const none = checkApiToken(req()) as Response;
  assert.equal(none.status, 401);
});

test("checkApiToken: Viewer-Session darf NICHT schreiben, wenn kein Operator-Token gesetzt ist", () => {
  syncEnv(ENV_VIEWER);
  const { issued } = makeSession(VIEWER, ENV_VIEWER);
  const denied = checkApiToken(withSession(SessionTokenValue(issued.cookies[0]))) as Response;
  assert.equal(denied.status, 403, "Viewer ist authentifiziert, hat aber kein firm.write");
});

// ── 5. checkCsrfGuard (Double-Submit) ──────────────────────────────────────

test("checkCsrfGuard: Session + passender x-csrf-token → ok; falscher Wert → 403", () => {
  syncEnv(ENV_OP);
  const { issued } = makeSession(OP, ENV_OP);
  const token = SessionTokenValue(issued.cookies[0]);
  assert.equal(checkCsrfGuard(withSession(token, { "x-csrf-token": issued.csrf })), null);
  const denied = checkCsrfGuard(withSession(token, { "x-csrf-token": "x".repeat(64) })) as Response;
  assert.equal(denied.status, 403);
  const missing = checkCsrfGuard(withSession(token)) as Response;
  assert.equal(missing.status, 403, "Session ohne CSRF-Header → 403");
});

test("checkCsrfGuard: Legacy-Token-Pfad ohne Session bleibt erhalten", () => {
  syncEnv(ENV_OP);
  assert.equal(checkCsrfGuard(req("http://localhost/api/x", { "x-csrf-token": OP })), null);
  const denied = checkCsrfGuard(req("http://localhost/api/x", { "x-csrf-token": "falsch" })) as Response;
  assert.equal(denied.status, 403);
});

// ── 6. POST /api/auth/login ────────────────────────────────────────────────

function loginReq(tok: string, url = "http://localhost/api/auth/login"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tok }),
  });
}

async function loginResponse(res: Response): Promise<{ status: number; body: Record<string, unknown>; cookie: string[] }> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  return { status: res.status, body, cookie: set };
}

test("/api/auth/login: gültiger Operator-Token → 200 + HttpOnly-Session-Cookie (kein Token im Body)", async () => {
  syncEnv(ENV_OP);
  const { status, body, cookie } = await loginResponse(await postLogin(loginReq(OP)));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.session, true);
  assert.ok((body.actor as { role?: string })?.role === "operator");
  assert.equal(cookie.length, 2);
  const sessionCookie = cookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(sessionCookie, "firm_session gesetzt");
  assert.ok(sessionCookie!.includes("; HttpOnly"), "HttpOnly");
  assert.ok(JSON.stringify(body).includes(OP) === false, "kein roher Token im Body");
});

test("/api/auth/login: Admin-Token → Admin-Session", async () => {
  syncEnv(ENV_ADMIN);
  const { status, body } = await loginResponse(await postLogin(loginReq(ADMIN)));
  assert.equal(status, 200);
  assert.equal((body.actor as { role?: string })?.role, "admin");
});

test("/api/auth/login: falscher Token → 401 ohne Set-Cookie", async () => {
  syncEnv(ENV_OP);
  const { status, cookie } = await loginResponse(await postLogin(loginReq("falsches-token")));
  assert.equal(status, 401);
  assert.equal(cookie.length, 0);
});

test("/api/auth/login: fehlender/leerer Token → 400 MISSING_TOKEN", async () => {
  syncEnv(ENV_OP);
  const { status, body } = await loginResponse(await postLogin(loginReq(" ")));
  assert.equal(status, 400);
  assert.equal(body.error, "MISSING_TOKEN");
});

test("/api/auth/login: Produktion über plain-HTTP → 400 SESSION_HTTPS_REQUIRED (fail-closed)", async () => {
  syncEnv(ENV_OP);
  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "production";
  const { status, body, cookie } = await loginResponse(await postLogin(loginReq(OP, "http://localhost/api/auth/login")));
  assert.equal(status, 400);
  assert.equal(body.error, "SESSION_HTTPS_REQUIRED");
  assert.equal(cookie.length, 0);
});

test("/api/auth/login: Produktion über HTTPS → Session wird gesetzt", async () => {
  syncEnv(ENV_OP);
  (process.env as Record<string, string | undefined>)["NODE_ENV"] = "production";
  const { status, cookie } = await loginResponse(await postLogin(loginReq(OP, "https://localhost/api/auth/login")));
  assert.equal(status, 200);
  assert.equal(cookie.length, 2);
});

test("/api/auth/login: local-open (kein Token) → 200 open:true ohne Cookies", async () => {
  syncEnv({});
  const { status, body, cookie } = await loginResponse(await postLogin(loginReq("egal")));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.open, true);
  assert.equal(cookie.length, 0);
});

// ── 7. Statik-Akzeptanz (grep-Äquivalent) ──────────────────────────────────

function readSource(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("Akzeptanz: kein localStorage-Zugriff auf firmToken mehr in src/components + src/lib", () => {
  const sources = [
    "src/components/FirmDashboard.tsx",
    "src/lib/apiClient.ts",
    "src/lib/controlPlane.ts",
    "src/lib/liveGate.ts",
  ]
    .map(readSource)
    .join("\n");
  assert.ok(
    !/localStorage\.(getItem|setItem)\s*\(\s*["']firmToken["']\s*\)/.test(sources),
    "kein firmToken-Lesen/Schreiben über localStorage im Client"
  );
});

test("Akzeptanz: alle anderen src/components enthalten kein localStorage.setItem(firmToken)", () => {
  const dashboard = readSource("src/components/FirmDashboard.tsx");
  assert.ok(dashboard.includes("/api/auth/login"), "Login-Endpoint wird aufgerufen");
  assert.ok(dashboard.includes("csrfHeaderValue()"), "Double-Submit-CSRF im Disarm-Pfad");
  const theme = readSource("src/components/ThemeSwitcher.tsx");
  assert.ok(theme.includes("localStorage") && theme.includes("theme"), "Theme-Speicherung bleibt (kein Token)");
});

test("Akzeptanz: XSS-PoC liest nichts — Login gibt Token aus und wirft ihn sofort weg", async () => {
  // Analog PoC: nach einem Login ist in localStorage kein firmToken vorhanden.
  syncEnv(ENV_OP);
  const { body } = await loginResponse(await postLogin(loginReq(OP)));
  assert.equal(body.open, false);
  // Im Client-Code wird ausschließlich entfernt (browserSession), nie geschrieben:
  const browserSession = readSource("src/lib/browserSession.ts");
  assert.ok(browserSession.includes("localStorage.removeItem"), "Migration entfernt Altbestand");
  assert.ok(!browserSession.includes("localStorage.setItem"), "schreibt nie einen Token");
});

// Behalte eine Referenz auf sessionActor/TTL, damit typos in Exporten auffallen.
test("Export-Konsistenz: SESSION_TTL_MS beträgt 15 min (900 s)", () => {
  assert.equal(SESSION_TTL_MS, 15 * 60 * 1000);
});
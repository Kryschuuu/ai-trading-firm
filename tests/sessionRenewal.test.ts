/**
 * S1 (v1.39.0) — Sitzung gilt, bis das Browserfenster geschlossen wird.
 *
 * Getestet wird die gesamte Laufzeit-Kette, Server wie Route:
 *
 *   1  Cookie-Policy: `firm_session`/`firm_csrf` OHNE `Max-Age`/`Expires`
 *      (Browser-Session-Cookie), alle Sicherheitsflags bleiben gesetzt.
 *   2  Fristen aus `src/lib/authSession.ts`: Idle-TTL, absolute Grenze,
 *      Nachfrist — Defaults, Klemmbereiche und fail-closed bei Müllwerten.
 *   3  `renewSession`: nur innerhalb des Fensters oder der Nachfrist, immer
 *      mit Double-Submit-CSRF, nie über `maxExp`, nie für widerrufene oder durch
 *      Credential-Rotation entwertete Sessions; `iat`/`csrf`/`maxExp` bleiben.
 *   4  Die Nachfrist autorisiert NIRGENDWO sonst (readSession/Guards bleiben strikt).
 *   5  `POST /api/auth/refresh` und `GET /api/auth/status` als ausgelieferte Routen.
 *   6  Revocation ueberlebt Verlaengerung (Logout prueft beide Generationen).
 *   7  Secret-Hygiene: die neuen Antworten nennen Fristen, nie Credential-Werte.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomBytes } from "node:crypto";
import { resolveAuth } from "../src/auth/resolve";
import { checkApiToken, resetRateLimiterForTests } from "../src/lib/apiAuth";
import {
  SESSION_ABSOLUTE_LIFE_CEILING_MS,
  SESSION_COOKIE,
  SESSION_CSRF_COOKIE,
  SESSION_GRACE_S,
  SESSION_RENEW_WINDOW_S,
  SESSION_TTL_S,
  clearSessionCookies,
  emptyLifetime,
  inspectSessionToken,
  issueSession,
  readSession,
  renewSession,
  revokeAllSessions,
  revokeSession,
  sessionGraceS,
  sessionIdleTtlS,
  sessionMaxLifeS,
  sessionRenewWindowS,
  sessionStatus,
  verifySessionToken,
  type SessionPayload,
} from "../src/lib/authSession";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { POST as postLogin } from "../src/app/api/auth/login/route";
import { POST as postLogout } from "../src/app/api/auth/logout/route";
import { POST as postRefresh } from "../src/app/api/auth/refresh/route";
import { GET as getStatus } from "../src/app/api/auth/status/route";

type Env = Record<string, string | undefined>;

const OPERATOR = "s1-operator-credential-not-for-deployment";
const ADMIN = "s1-admin-credential-not-for-deployment";
const SECRET = randomBytes(32).toString("hex");
const ENV_KEYS = [
  "FIRM_ADMIN_TOKEN",
  "FIRM_API_TOKEN",
  "FIRM_VIEWER_TOKEN",
  "FIRM_SESSION_SECRET",
  "FIRM_SESSION_IDLE_TTL_S",
  "FIRM_SESSION_MAX_LIFE_S",
  "FIRM_SESSION_GRACE_S",
  "AUTH_MODE",
  "NODE_ENV",
  "FIRM_RATE_LIMIT",
];

const BASE: Env = {
  FIRM_API_TOKEN: OPERATOR,
  FIRM_SESSION_SECRET: SECRET,
  AUTH_MODE: "token-required",
  FIRM_RATE_LIMIT: "0",
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
  __resetAllSingletonsForTests();
});

afterEach(() => {
  syncEnv(Object.fromEntries(saved));
  saved.clear();
  resetRateLimiterForTests();
  __resetAllSingletonsForTests();
});

function decode(token: string): SessionPayload {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as SessionPayload;
}

/** Frische Session wie beim Login, optional mit Backdatierung und Env. */
function issue(env: Env = BASE, actorToken = OPERATOR, at: number = Date.now()) {
  const probe = new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "x-firm-token": actorToken },
  });
  const resolution = resolveAuth(probe, env);
  assert.ok(resolution.ok, `Login-Probe muss durch: ${resolution.ok ? "" : resolution.error}`);
  const issued = issueSession(probe, resolution.actor, env, at);
  assert.ok(issued.ok, `issueSession muss durch: ${issued.ok ? "" : issued.error}`);
  if (!issued.ok) throw new Error("unreachable");
  return { issued, secret: env.FIRM_SESSION_SECRET ?? "" };
}

function withSession(token: string, csrf = "", extra: Record<string, string> = {}): Request {
  const headers = new Headers(extra);
  headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  if (csrf) headers.set("x-csrf-token", csrf);
  return new Request("https://localhost/api/auth/refresh", { method: "POST", headers });
}

// ── 1 · Cookie-Policy: Browser-Session statt Max-Age ────────────────────────

test("issueSession: beide Cookies ohne Max-Age/Expires — alle Sicherheitsflags bleiben", () => {
  const { issued } = issue();
  assert.equal(issued.cookies.length, 2);
  for (const cookie of issued.cookies) {
    assert.ok(cookie.includes("Path=/"), "Path=/");
    assert.ok(cookie.includes("Secure"), "Secure (nur über TLS)");
    assert.ok(cookie.includes("SameSite=Strict"), "SameSite=Strict");
    assert.ok(!/Max-Age/i.test(cookie), "kein Max-Age ⇒ Browser legt das Cookie mit dem Fenster ab");
    assert.ok(!/Expires/i.test(cookie), "kein Expires");
  }
  assert.ok(issued.cookies[0].includes("HttpOnly"), "firm_session bleibt HttpOnly");
  assert.ok(!issued.cookies[1].includes("HttpOnly"), "firm_csrf bleibt für JS lesbar (Double-Submit)");
  assert.ok(!issued.cookies[0].includes(OPERATOR), "kein roher Token im Cookie");
});

test("issueSession: Payload v3 trägt Anmeldung, Idle-Frist und absolute Grenze", () => {
  const now = 1_789_000_000_000;
  const { issued, secret } = issue(BASE, OPERATOR, now);
  const payload = decode(issued.sessionToken);
  assert.equal(payload.v, 3);
  assert.equal(payload.iat, now, "iat = Anmeldung");
  assert.equal(payload.exp, now + SESSION_TTL_S * 1000, "Idle-Frist ab Anmeldung");
  assert.equal(payload.maxExp, now + 86_400_000, "absolute Grenze = 24 h ab Anmeldung");
  const verified = verifySessionToken(issued.sessionToken, secret, now);
  assert.ok(verified);
  assert.equal(verified?.csrf, issued.csrf, "Session-Identität ist der CSRF-Wert");
});

test("clearSessionCookies löscht auch Browser-Session-Cookies (Max-Age=0)", () => {
  const [session, csrf] = clearSessionCookies();
  for (const cookie of [session, csrf]) {
    assert.ok(cookie.includes("Max-Age=0"), "Max-Age=0 ist das Löschmittel für beide Typen");
    assert.ok(cookie.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"), "plus Legacy-Expires");
  }
  assert.ok(session.includes(SESSION_COOKIE) && session.includes("HttpOnly"));
  assert.ok(csrf.includes(SESSION_CSRF_COOKIE));
});

// ── 2 · Fristen: Defaults, Klemmung, fail-closed bei Müll ───────────────────

test("Defaults: 900 s Idle, 24 h absolut, 900 s Nachfrist, 300 s Fenster", () => {
  assert.equal(sessionIdleTtlS({}), SESSION_TTL_S);
  assert.equal(sessionMaxLifeS({}), 86_400);
  assert.equal(sessionGraceS({}), SESSION_GRACE_S);
  assert.equal(sessionRenewWindowS({}), SESSION_RENEW_WINDOW_S);
});

test("Idle-Frist ist konfigurierbar und wird geklemmt; Müll fällt auf den Default", () => {
  assert.equal(sessionIdleTtlS({ FIRM_SESSION_IDLE_TTL_S: "3600" }), 3600);
  assert.equal(sessionIdleTtlS({ FIRM_SESSION_IDLE_TTL_S: "5" }), 60, "mindestens 60 s");
  assert.equal(sessionIdleTtlS({ FIRM_SESSION_IDLE_TTL_S: "999999999" }), 86_400, "höchstens 24 h");
  for (const garbage of ["", "   ", "abc", "0", "-60", "1e999", "NaN", "12.5x"]) {
    assert.equal(sessionIdleTtlS({ FIRM_SESSION_IDLE_TTL_S: garbage }), SESSION_TTL_S, `Müll: ${garbage}`);
  }
});

test("absolute Grenze: mindestens eine Idle-Frist, höchstens die harte Decke", () => {
  assert.equal(sessionMaxLifeS({ FIRM_SESSION_MAX_LIFE_S: "7200" }), 7200);
  assert.equal(
    sessionMaxLifeS({ FIRM_SESSION_IDLE_TTL_S: "3600", FIRM_SESSION_MAX_LIFE_S: "600" }),
    3600,
    "maxLife darf nie unter der Idle-Frist liegen"
  );
  const clamped = sessionMaxLifeS({ FIRM_SESSION_MAX_LIFE_S: "999999999" });
  assert.equal(clamped, Math.floor(SESSION_ABSOLUTE_LIFE_CEILING_MS / 1000), "harte 7-Tage-Decke");
  assert.ok(
    decode(issue({ ...BASE, FIRM_SESSION_MAX_LIFE_S: "999999999" }, OPERATOR, 1_789_000_000_000).issued.sessionToken).maxExp -
      1_789_000_000_000 <=
      SESSION_ABSOLUTE_LIFE_CEILING_MS,
    "kein signierter Payload behauptet eine längere Lebensdauer als erlaubt"
  );
});

test("Nachfrist abschaltbar (0 = strikte Idle-Frist), nie negativ, nie unbegrenzt", () => {
  assert.equal(sessionGraceS({ FIRM_SESSION_GRACE_S: "0" }), 0);
  assert.equal(sessionGraceS({ FIRM_SESSION_GRACE_S: "120" }), 120);
  assert.equal(sessionGraceS({ FIRM_SESSION_GRACE_S: "-5" }), SESSION_TTL_S, "negativ ⇒ Default");
  assert.equal(sessionGraceS({ FIRM_SESSION_GRACE_S: "999999999" }), 86_400);
});

test("emptyLifetime spiegelt die Konfiguration, auch ohne Session", () => {
  const env = { ...BASE, FIRM_SESSION_IDLE_TTL_S: "1800", FIRM_SESSION_MAX_LIFE_S: "7200" };
  const lifetime = emptyLifetime(env);
  assert.equal(lifetime.idleTtlS, 1800);
  assert.equal(lifetime.maxLifeS, 7200);
  assert.equal(lifetime.remainingS, 0);
  assert.equal(lifetime.expiresAt, 0);
  assert.equal(lifetime.cookieLifetime, "browser-session");
});

// ── 3 · renewSession: Fenster, Nachfrist, unverrückbare Grenzen ──────────────

test("renewSession außerhalb des Fensters: keine Cookies, Restzeit korrekt", () => {
  const now = Date.now();
  const { issued } = issue(BASE, OPERATOR, now);
  const token = issued.sessionToken;
  const result = renewSession(withSession(token, issued.csrf), BASE, now + 60_000);
  assert.ok(result.ok);
  assert.equal(result.renewed, false);
  assert.equal(result.cookies.length, 0);
  assert.equal(result.actor?.role, "operator");
  assert.ok(result.lifetime.remainingS > SESSION_TTL_S - 61, "Restzeit wird projiziert");
});

test("renewSession im Fenster: neue Idle-Frist, identische Session-Identität", () => {
  const now = Date.now();
  const { issued } = issue({ ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" }, OPERATOR, now);
  const token = issued.sessionToken;
  const before = decode(token);
  // 100 s nach Anmeldung: Rest 20 s < Fenster (60 s) ⇒ Verlängerung.
  const result = renewSession(withSession(token, issued.csrf), { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" }, now + 100_000);
  assert.ok(result.ok && result.renewed, "muss verlängern");
  assert.equal(result.cookies.length, 2);
  const after = decode(renewedToken(result.cookies));
  assert.equal(after.csrf, before.csrf, "Session-Identität bleibt (Logout trifft beide Generationen)");
  assert.equal(after.iat, before.iat, "Anmeldung bleibt die Anmeldung");
  assert.equal(after.maxExp, before.maxExp, "absolute Grenze wird NIE verschoben");
  assert.ok(after.exp > before.exp, "Idle-Frist rueckt nach vorne");
  assert.ok(!/Max-Age/i.test(result.cookies.join("")), "neue Generation bleibt Browser-Session-Cookie");
  // Und sie autorisiert weiterhin, aber nur bis maxExp.
  assert.ok(readSession(withSession(renewedToken(result.cookies)), { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" }, now + 121_000));
});

test("renewSession heilt eine inaktiv abgelaufene Session (Nachfrist)", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_GRACE_S: "600" };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  // 300 s nach der Anmeldung: Idle um, Nachfrist (600 s) laeuft noch.
  assert.equal(readSession(withSession(token, issued.csrf), env, now + 1_200_000), null, "readSession bleibt strikt");
  const result = renewSession(withSession(token, issued.csrf), env, now + 1_200_000);
  assert.ok(result.ok && result.renewed, "der Refresh-Pfad darf die Nachfrist nutzen");
  const after = decode(renewedToken(result.cookies));
  assert.ok(after.exp > now + 1_200_000, "neue Frist liegt in der Zukunft");
  assert.equal(after.iat, now, "Zeitbasis der Anmeldung bleibt erhalten");
});

test("Nachfrist vorbei ⇒ 401, und die Nachfrist gilt NUR für den Refresh", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_GRACE_S: "600" };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  const late = now + 2_000_000;
  const result = renewSession(withSession(token, issued.csrf), env, late);
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.error, "SESSION_INVALID");
    assert.ok(!JSON.stringify(result).includes(OPERATOR), "kein Credential in der Meldung");
  }
  assert.equal(readSession(withSession(token), env, late), null);
  assert.equal(revokeSession(decode(token), late), true, "Registereintrag bleibt moeglich");
});

test("maxExp ist hart: Verlängerung nahe der Grenze wird verweigert", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_MAX_LIFE_S: "600", FIRM_SESSION_IDLE_TTL_S: "60" };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  const result = renewSession(withSession(token, issued.csrf), env, now + 560_000);
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.error, "SESSION_MAX_LIFE_REACHED");
    assert.equal(result.status, 401);
    assert.ok(result.hint.includes("600 s"), "die Meldung nennt die konfigurierte Grenze");
  }
  // Auch ein spaeter hochgesetzter Wert aendert nichts an einer bestehenden Sitzung.
  const raised = { ...env, FIRM_SESSION_MAX_LIFE_S: "86400" };
  const late = renewSession(withSession(token, issued.csrf), raised, now + 560_000);
  assert.ok(!late.ok, "die absolute Grenze einer Sitzung ist unverrückbar");
});

test("renewSession braucht Double-Submit: fehlender oder falscher Header ⇒ 403", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  for (const csrf of ["", "falsch", issued.csrf.slice(0, 63) + "0"]) {
    const result = renewSession(withSession(token, csrf), env, now + 110_000);
    assert.ok(!result.ok, `CSRF '${csrf}' darf nicht verlängern`);
    if (!result.ok) {
      assert.equal(result.error, "CSRF_INVALID");
      assert.equal(result.status, 403);
    }
  }
});

test("renewSession ohne Cookie ⇒ 401 SESSION_REQUIRED; ohne Secret ⇒ 503", () => {
  const missing = renewSession(new Request("https://localhost/api/auth/refresh", { method: "POST" }), BASE);
  assert.ok(!missing.ok);
  if (!missing.ok) {
    assert.equal(missing.error, "SESSION_REQUIRED");
    assert.equal(missing.status, 401);
  }
  const noSecret = renewSession(withSession(issue().issued.sessionToken), { FIRM_API_TOKEN: OPERATOR });
  assert.ok(!noSecret.ok);
  if (!noSecret.ok) assert.equal(noSecret.error, "SESSION_SECRET_REQUIRED");
});

test("renewSession im Offen-Betrieb: offen, keine Cookies, kein Fehler", () => {
  const result = renewSession(
    new Request("https://localhost/api/auth/refresh", { method: "POST" }),
    { AUTH_MODE: "local-open", FIRM_SESSION_SECRET: SECRET }
  );
  assert.ok(result.ok);
  assert.equal(result.open, true);
  assert.equal(result.renewed, false);
  assert.equal(result.cookies.length, 0);
});

test("Verlängerung scheitert an Widerruf, Credential-Rotation und Moduswechsel", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  const at = now + 110_000;

  // 1) Logout zuerst: die Session ist weg, Verlängern kann sie nicht zurückholen.
  revokeSession(decode(token), now);
  const revoked = renewSession(withSession(token, issued.csrf), env, at);
  assert.ok(!revoked.ok);
  if (!revoked.ok) assert.equal(revoked.error, "SESSION_REVOKED");
  __resetAllSingletonsForTests();

  // 2) Globaler Notfallschnitt (SEC-08): iat liegt vor dem Cut — waschen unmöglich.
  const second = issue(env, OPERATOR, now);
  const secondToken = second.issued.sessionToken;
  revokeAllSessions(now + 1_000);
  const cut = renewSession(withSession(secondToken, second.issued.csrf), env, at);
  assert.ok(!cut.ok, "nach globalem Schnitt ist auch eine Verlängerung tot");
  __resetAllSingletonsForTests();

  // 3) Operator-Token rotiert ⇒ authEpoch passt nicht mehr.
  const third = issue(env, OPERATOR, now);
  const rotated = { ...env, FIRM_API_TOKEN: "rotated-operator-credential" };
  const rotatedResult = renewSession(withSession(third.issued.sessionToken, third.issued.csrf), rotated, at);
  assert.ok(!rotatedResult.ok);
  if (!rotatedResult.ok) {
    assert.equal(rotatedResult.error, "SESSION_INVALID");
    assert.ok(rotatedResult.hint.includes("neu anmelden"));
  }

  // 4) Moduswechsel auf local-open: Sessions werden nicht mehr ausgestellt.
  const modeSwitch = renewSession(
    withSession(third.issued.sessionToken, third.issued.csrf),
    { AUTH_MODE: "local-open", FIRM_SESSION_SECRET: SECRET, FIRM_API_TOKEN: undefined },
    at
  );
  assert.ok(!modeSwitch.ok || modeSwitch.renewed === false);
});

// ── 4 · Nachfrist autorisiert nirgends sonst ─────────────────────────────────

test("abgelaufene Session: kein Schreibzugriff, kein Read — auch in der Nachfrist nicht", () => {
  const env = { ...BASE, FIRM_SESSION_GRACE_S: "3600" };
  syncEnv(env);
  // Session 20 min zurueckdatieren: Idle-Frist (900 s) laengst um, die
  // Nachfrist (3600 s) wuerde gelten — der Cookie liegt also real im Browser.
  const past = Date.now() - 1_200_000;
  const { issued } = issue(env, OPERATOR, past);
  const token = issued.sessionToken;
  assert.ok(
    verifySessionToken(token, SECRET, Date.now(), { graceMs: 3_600_000 }),
    "Nachfrist: signierter Payload ist formal noch nutzbar"
  );
  assert.equal(readSession(withSession(token), env), null, "readSession ignoriert die Nachfrist");
  const denied = checkApiToken(
    new Request("https://localhost/api/firm/tick", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` } })
  );
  assert.ok(denied, "der Schreib-Guard muss ablehnen");
  assert.equal(denied?.status, 401);
  // Nur der Refresh-Pfad darf heilen — und dann autorisiert die neue Generation wieder.
  const healed = renewSession(withSession(token, issued.csrf), env);
  assert.ok(healed.ok && healed.renewed, "Verlaengerung innerhalb der Nachfrist");
  if (healed.ok && healed.renewed) {
    assert.ok(readSession(withSession(renewedToken(healed.cookies)), env), "neue Generation autorisiert");
  }
});

// ── 5 · Inspektion: Zustandsunterscheidung ohne Oracle ──────────────────────

test("inspectSessionToken unterscheidet missing/invalid/expired/max-life/revoked", () => {
  const now = Date.now();
  // Idle 60 s, absolute Grenze 600 s (= unterer Klemmbereich), keine Nachfrist —
  // damit sind alle vier Zonen eindeutig anfahrbar.
  const env = {
    ...BASE,
    FIRM_SESSION_IDLE_TTL_S: "60",
    FIRM_SESSION_MAX_LIFE_S: "600",
    FIRM_SESSION_GRACE_S: "0",
  };
  const { issued } = issue(env, OPERATOR, now);
  const token = issued.sessionToken;
  assert.equal(inspectSessionToken("", SECRET, now).state, "missing");
  assert.equal(inspectSessionToken("quatsch", SECRET, now).state, "invalid");
  assert.equal(inspectSessionToken(token, "another-secret-that-is-long-enough-32", now).state, "invalid");
  assert.equal(inspectSessionToken(token, SECRET, now).state, "valid");
  assert.equal(inspectSessionToken(token, SECRET, now + 61_000).state, "expired", "Idle um, Grenze laeuft");
  assert.equal(inspectSessionToken(token, SECRET, now + 601_000).state, "max-life", "beide Fristen um");
  revokeSession(decode(token), now);
  assert.equal(inspectSessionToken(token, SECRET, now + 10_000).state, "revoked");
});

// ── 6 · Routen: refresh und status ──────────────────────────────────────────

async function setCookie(res: Response): Promise<string[]> {
  return typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
}

function cookieValue(setCookies: string[], name: string): string {
  const line = setCookies.find((c) => c.startsWith(`${name}=`)) ?? "";
  return line.slice(name.length + 1).split(";")[0].trim();
}

test("POST /api/auth/refresh: erneuert im Fenster, setzt Cookies ohne Max-Age", async () => {
  syncEnv({ ...BASE, FIRM_SESSION_IDLE_TTL_S: "60" });
  // Session 45 s zurueckdatieren ⇒ Restzeit 15 s < Fenster 30 s ⇒ Renewal.
  const { issued } = issue({ ...BASE, FIRM_SESSION_IDLE_TTL_S: "60" }, OPERATOR, Date.now() - 45_000);
  const token = issued.sessionToken;

  const res = await postRefresh(
    new Request("https://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": issued.csrf },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.session, true);
  assert.equal(body.renewed, true);
  assert.equal(body.cookieLifetime, "browser-session");
  assert.ok(body.expiresInS >= 10, `neue Frist in der Zukunft: ${body.expiresInS}`);
  assert.ok(body.actor && body.actor.role === "operator", "die eigene Rolle wird projiziert");
  const cookies = await setCookie(res);
  assert.equal(cookies.length, 2);
  for (const line of cookies) assert.ok(!/Max-Age/i.test(line), "auch die neue Generation ist ein Browser-Session-Cookie");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("POST /api/auth/refresh: ohne Session 401, ohne Double-Submit 403 — nie ein Cookie", async () => {
  syncEnv(BASE);
  const anon = await postRefresh(new Request("https://localhost/api/auth/refresh", { method: "POST" }));
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error, "SESSION_REQUIRED");
  assert.equal((await setCookie(anon)).length, 0);

  const { issued } = issue(BASE, OPERATOR, Date.now());
  const noCsrf = await postRefresh(
    new Request("https://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${issued.sessionToken}` },
    })
  );
  // Außerhalb des Fensters wird nicht verlängert — und CSRF trotzdem verlangt.
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error, "CSRF_INVALID");
  assert.equal((await setCookie(noCsrf)).length, 0);
});

test("POST /api/auth/refresh: Token im Legacy-Header reicht NICHT für eine Verlängerung", async () => {
  syncEnv(BASE);
  const { issued } = issue(BASE, OPERATOR, Date.now() - (SESSION_TTL_S - 10) * 1000);
  const res = await postRefresh(
    new Request("https://localhost/api/auth/refresh", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${issued.sessionToken}`,
        // Der Control-Plane-Legacy-Wert (Header == Token) gilt hier bewusst nicht.
        "x-csrf-token": OPERATOR,
      },
    })
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "CSRF_INVALID");
});

test("GET /api/auth/status: beantwortet eingetragen/nicht eingetragen ohne Session", async () => {
  syncEnv({ ...BASE, FIRM_ADMIN_TOKEN: ADMIN });
  const res = await getStatus(new Request("https://localhost/api/auth/status"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.firmApi.configured, true);
  assert.equal(body.firmApi.admin, true);
  assert.equal(body.firmApi.operator, true);
  assert.equal(body.firmApi.viewer, false);
  assert.equal(body.firmApi.sessionsAvailable, true);
  assert.equal(body.session.active, false);
  assert.equal(body.session.state, "missing");
  assert.equal(body.session.cookieLifetime, "browser-session");
  const raw = JSON.stringify(body);
  for (const secret of [OPERATOR, ADMIN, SECRET]) assert.ok(!raw.includes(secret), "nie ein Credential-Wert");
  assert.ok(!raw.includes("permissions"), "keine Permissions-Liste (die bleibt in /api/auth/me)");
});

test("GET /api/auth/status: aktive Session mit Restzeit, danach renewable/expired", async () => {
  const env = { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120", FIRM_SESSION_GRACE_S: "600" };
  syncEnv(env);
  const { issued } = issue(env, OPERATOR, Date.now());
  const token = issued.sessionToken;
  const cookie = `${SESSION_COOKIE}=${token}`;

  const active = await getStatus(new Request("https://localhost/api/auth/status", { headers: { cookie } }));
  const activeBody = await active.json();
  assert.equal(activeBody.session.active, true);
  assert.equal(activeBody.session.state, "active");
  assert.equal(activeBody.session.role, "operator");
  assert.ok(activeBody.session.remainingS > 0 && activeBody.session.remainingS <= 120);
  assert.equal(activeBody.session.idleTtlS, 120);
  assert.ok(typeof activeBody.session.expiresAt === "string", "ISO-Zeitstempel für die Anzeige");

  // Cookie liegt noch im Browser, Idle-Frist ist um, Nachfrist laeuft: renewable.
  const stale = new Request("https://localhost/api/auth/status", { headers: { cookie } });
  const staleStatus = sessionStatus(stale, env, Date.now() + 200_000);
  assert.equal(staleStatus.state, "renewable");
  assert.equal(staleStatus.active, false, "renewable autorisiert nicht — nur der Refresh heilt");

  const expiredStatus = sessionStatus(stale, env, Date.now() + 5_000_000);
  assert.equal(expiredStatus.state, "expired");
});

test("GET /api/auth/status: Offen-Betrieb und fehlendes Secret werden korrekt benannt", async () => {
  syncEnv({ AUTH_MODE: "local-open" });
  const open = await getStatus(new Request("https://localhost/api/auth/status"));
  const openBody = await open.json();
  assert.equal(openBody.firmApi.configured, false);
  assert.equal(openBody.authMode.mode, "local-open");
  assert.equal(openBody.session.state, "open");
  assert.equal(openBody.session.active, true);
  assert.equal(openBody.session.role, "admin");

  syncEnv({ FIRM_API_TOKEN: OPERATOR, NODE_ENV: "development" });
  const noSecret = await getStatus(new Request("https://localhost/api/auth/status"));
  const noSecretBody = await noSecret.json();
  assert.equal(noSecretBody.firmApi.configured, true);
  assert.equal(noSecretBody.firmApi.sessionsAvailable, false, "ohne unabhaengiges Secret gibt es keine Sessions");
  assert.ok(!JSON.stringify(noSecretBody).includes(OPERATOR));
});

test("GET /api/auth/status: ungueltiges/verfaelschtes Cookie bleibt 'invalid', kein Oracle", () => {
  const forged = `${"abc".repeat(30)}.not-a-signature`;
  const status = sessionStatus(
    new Request("https://localhost/api/auth/status", {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    }),
    BASE
  );
  assert.equal(status.state, "invalid");
  assert.equal(status.active, false);
  assert.equal(status.role, null);
});

test("Login antwortet mit Browser-Session-Cookie und den Fristen, logout loescht", async () => {
  syncEnv(BASE);
  const login = await postLogin(
    new Request("https://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: OPERATOR }),
    })
  );
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.cookieLifetime, "browser-session");
  assert.equal(loginBody.lifetime.idleTtlS, SESSION_TTL_S);
  assert.equal(loginBody.lifetime.maxLifeS, 86_400);
  const cookies = await setCookie(login);
  const token = cookieValue(cookies, SESSION_COOKIE);
  assert.ok(token, "Session-Cookie gesetzt");
  assert.ok(!cookies.join("").includes("Max-Age"), "kein Max-Age beim Setzen");

  const logout = await postLogout(
    new Request("https://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
  );
  assert.equal(logout.status, 200);
  const cleared = await setCookie(logout);
  assert.ok(cleared.some((c) => c.includes(`${SESSION_COOKIE}=`) && c.includes("Max-Age=0")), "Loesch-Header");
  assert.equal(readSession(new Request("https://localhost/api/firm", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), BASE), null);
});

// ── 7 · Revocation ueberlebt die Verlängerung ───────────────────────────────

test("Logout nach Verlängerung entwertet beide Cookie-Generationen", () => {
  const now = Date.now();
  const env = { ...BASE, FIRM_SESSION_IDLE_TTL_S: "120" };
  const { issued } = issue(env, OPERATOR, now);
  const first = issued.sessionToken;
  const result = renewSession(withSession(first, issued.csrf), env, now + 110_000);
  assert.ok(result.ok && result.renewed);
  const second = renewedToken(result.cookies);

  assert.ok(readSession(withSession(second), env, now + 121_000), "vor dem Logout gueltig");
  revokeSession(decode(second), now + 121_000);
  assert.equal(readSession(withSession(second), env, now + 121_000), null, "neue Generation widerrufen");
  assert.equal(readSession(withSession(first), env, now + 111_000), null, "alte Generation ebenfalls");
});

/** Wert des `firm_session`-Cookies aus einer Set-Cookie-Liste. */
function renewedToken(cookies: string[]): string {
  const line = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(line, "Set-Cookie muss firm_session enthalten");
  return line!.slice(SESSION_COOKIE.length + 1).split(";")[0].trim();
}

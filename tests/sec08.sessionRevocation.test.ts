/**
 * SEC-08: Sofortige Session-Revocation, Logout-Endpunkt und Lebenszyklus-Sicherheit.
 *
 * Testet serverseitigen Widerruf vor TTL-Ablauf, Einzel-Logout, globale
 * Epochen-Revocation, Memory-Hygiene (Pruning) und Angriffsvektoren.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import {
  clearSessionCookies,
  issueSession,
  isSessionRevoked,
  pruneRevokedSessions,
  readSession,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  SESSION_CSRF_COOKIE,
  SESSION_TTL_MS,
  sessionActor,
} from "../src/lib/authSession";
import { requirePermission, resolveAuth } from "../src/auth/resolve";
import { checkApiToken, resetRateLimiterForTests } from "../src/lib/apiAuth";
import { checkCsrfGuard } from "../src/brokers/control-plane/guard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { POST as postLogin } from "../src/app/api/auth/login/route";
import { POST as postLogout } from "../src/app/api/auth/logout/route";
import { GET as getMe } from "../src/app/api/auth/me/route";
import { POST as postTick } from "../src/app/api/firm/tick/route";
import { permissionsForRole } from "../src/auth/permissions";

type Env = Record<string, string | undefined>;
const ADMIN = "sec08-test-admin-secret-not-for-production";
const OPERATOR = "sec08-test-operator-secret-not-for-production";
const VIEWER = "sec08-test-viewer-secret-not-for-production";
const SECRET = randomBytes(32).toString("hex");

const ENV_KEYS = [
  "FIRM_ADMIN_TOKEN",
  "FIRM_API_TOKEN",
  "FIRM_VIEWER_TOKEN",
  "FIRM_SESSION_SECRET",
  "NODE_ENV",
  "AUTH_MODE",
  "FIRM_RATE_LIMIT",
];

const FULL_ENV: Env = {
  FIRM_ADMIN_TOKEN: ADMIN,
  FIRM_API_TOKEN: OPERATOR,
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
  syncEnv(FULL_ENV);
  __resetAllSingletonsForTests();
  resetRateLimiterForTests();
});

afterEach(() => {
  syncEnv(Object.fromEntries(saved));
  saved.clear();
  __resetAllSingletonsForTests();
  resetRateLimiterForTests();
});

function createSession(token: string, env: Env = FULL_ENV) {
  const req = new Request("https://localhost/api/auth/login", {
    method: "POST",
    headers: { "x-firm-token": token },
  });
  const res = resolveAuth(req, env);
  assert.ok(res.ok, "resolveAuth muss fuer Test-Token erfolgreich sein");
  const issue = issueSession(req, res.actor, env);
  assert.ok(issue.ok && !issue.open);
  return issue;
}

function sessionRequest(
  url: string,
  sessionToken: string,
  options: { method?: string; csrf?: string; body?: string; headers?: Record<string, string> } = {}
): Request {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", `${SESSION_COOKIE}=${sessionToken}`);
  if (options.csrf) {
    headers.set("x-csrf-token", options.csrf);
  }
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body,
  });
}

test("SEC-08: Logout widerruft die Session serverseitig vor Ablauf der TTL (PoC / Red Test)", async () => {
  const session = createSession(OPERATOR);
  const verifyReq = () => sessionRequest("https://localhost/api/auth/me", session.sessionToken);

  // Vor Logout: Session ist gueltig
  const beforeRes = await getMe(verifyReq());
  assert.equal(beforeRes.status, 200);
  const beforeJson = await beforeRes.json();
  assert.equal(beforeJson.ok, true);
  assert.equal(beforeJson.actor.role, "operator");

  // Logout ausfuehren
  const logoutReq = sessionRequest("https://localhost/api/auth/logout", session.sessionToken, {
    method: "POST",
    csrf: session.csrf,
  });
  const logoutRes = await postLogout(logoutReq);
  assert.equal(logoutRes.status, 200);
  const logoutJson = await logoutRes.json();
  assert.equal(logoutJson.ok, true);
  assert.equal(logoutJson.session, false);
  assert.equal(logoutJson.revoked, true);

  // Cookie-Loeschung im Logout-Response pruefen
  const setCookie = logoutRes.headers.get("set-cookie") ?? "";
  assert.ok(setCookie.includes(`${SESSION_COOKIE}=;`));
  assert.ok(setCookie.includes("Max-Age=0"));

  // Angriffsvektor: Replay des alten Session-Cookies nach Logout MUSS abgewiesen werden (401/403)
  const afterRes = await getMe(verifyReq());
  assert.ok([401, 403].includes(afterRes.status), "Nach Logout muss die Session serverseitig abgewiesen werden");
  assert.equal(readSession(verifyReq()), null, "readSession muss null fuer widerrufene Session liefern");
});

test("SEC-08: Angreifer mit gestohlenem Cookie scheitert nach Logout an schreibenden APIs", async () => {
  const session = createSession(OPERATOR);
  const tickReq = () =>
    sessionRequest("https://localhost/api/firm/tick", session.sessionToken, {
      method: "POST",
      csrf: session.csrf,
    });

  // Vor Logout darf der Operator schreiben
  assert.equal(checkApiToken(tickReq()), null);

  // Opfer fuehrt Logout durch
  const logoutRes = await postLogout(
    sessionRequest("https://localhost/api/auth/logout", session.sessionToken, { method: "POST" })
  );
  assert.equal(logoutRes.status, 200);

  // Angreifer sendet Replay mit gestohlenem Cookie + CSRF
  const tickDenied = checkApiToken(tickReq());
  assert.ok(tickDenied, "checkApiToken muss nach Logout ablehnen");
  assert.equal(tickDenied?.status, 401);

  // Auch die Route direkt weist ab
  const routeRes = await postTick(tickReq());
  assert.equal(routeRes.status, 401);
});

test("SEC-08: Gezielter Einzel-Widerruf beruehrt andere aktive Sessions nicht", async () => {
  const session1 = createSession(OPERATOR);
  const session2 = createSession(ADMIN);

  assert.ok(readSession(sessionRequest("https://localhost", session1.sessionToken)));
  assert.ok(readSession(sessionRequest("https://localhost", session2.sessionToken)));

  // Nur session1 widerrufen
  const revoked = revokeSession(session1.sessionToken);
  assert.equal(revoked, true);

  // session1 ist abgewiesen, session2 funktioniert weiterhin
  assert.equal(readSession(sessionRequest("https://localhost", session1.sessionToken)), null);
  assert.ok(readSession(sessionRequest("https://localhost", session2.sessionToken)));
});

test("SEC-08: Globale Revocation invalidiert alle vorher ausgestellten Sessions (Admin all:true)", async () => {
  const sessionOp = createSession(OPERATOR);
  const sessionViewer = createSession(VIEWER);
  const adminSession = createSession(ADMIN);

  // Admin loest globale Revocation aus
  const logoutAllReq = sessionRequest(
    "https://localhost/api/auth/logout",
    adminSession.sessionToken,
    {
      method: "POST",
      csrf: adminSession.csrf,
      body: JSON.stringify({ all: true }),
    }
  );
  const res = await postLogout(logoutAllReq);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.allRevoked, true);

  // Alle vor dem Schnitt ausgestellten Sessions sind nun ungueltig
  assert.equal(readSession(sessionRequest("https://localhost", sessionOp.sessionToken)), null);
  assert.equal(readSession(sessionRequest("https://localhost", sessionViewer.sessionToken)), null);
  assert.equal(readSession(sessionRequest("https://localhost", adminSession.sessionToken)), null);

  // Neu ausgestellte Session nach dem Schnitt funktioniert
  const freshSession = createSession(OPERATOR);
  assert.ok(readSession(sessionRequest("https://localhost", freshSession.sessionToken)));
});

test("SEC-08: Nicht-Admin darf keine globale Session-Revocation ausloesen (403)", async () => {
  const operatorSession = createSession(OPERATOR);
  const viewerSession = createSession(VIEWER);

  for (const session of [operatorSession, viewerSession]) {
    const maliciousReq = sessionRequest(
      "https://localhost/api/auth/logout",
      session.sessionToken,
      {
        method: "POST",
        csrf: session.csrf,
        body: JSON.stringify({ all: true }),
      }
    );
    const res = await postLogout(maliciousReq);
    assert.equal(res.status, 403, "Nur Admin darf globale Revocation ausloesen");
  }
});

test("SEC-08: Unauthentifizierter / Idempotenter Logout liefert 200 und loescht Cookies", async () => {
  // Kein Cookie
  const emptyReq = new Request("https://localhost/api/auth/logout", { method: "POST" });
  const emptyRes = await postLogout(emptyReq);
  assert.equal(emptyRes.status, 200);
  const emptyBody = await emptyRes.json();
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.revoked, false);
  assert.ok(emptyRes.headers.get("set-cookie")?.includes("Max-Age=0"));

  // Ungueltiger Cookie-Wert
  const bogusReq = new Request("https://localhost/api/auth/logout", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=invalid.signature.value` },
  });
  const bogusRes = await postLogout(bogusReq);
  assert.equal(bogusRes.status, 200);
  assert.ok(bogusRes.headers.get("set-cookie")?.includes("Max-Age=0"));
});

test("SEC-08: Pruning raeumt abgelaufene Revocation-Eintraege automatisch auf", () => {
  const session = createSession(OPERATOR);
  revokeSession(session.sessionToken);

  const req = sessionRequest("https://localhost", session.sessionToken);
  // Unmittelbar nach Revocation: als widerrufen erkannt
  assert.equal(readSession(req), null);

  // Nach natuerlichem TTL-Ablauf: Pruning bereinigt den Eintrag
  const nowAfterExp = Date.now() + SESSION_TTL_MS + 5000;
  const pruned = pruneRevokedSessions(nowAfterExp);
  assert.ok(pruned >= 1, "Abgelaufener Revocation-Eintrag muss gepruned werden");
});

test("SEC-08: clearSessionCookies liefert Standard-konforme Loesch-Header", () => {
  const cookies = clearSessionCookies();
  assert.equal(cookies.length, 2);
  const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const csrfCookie = cookies.find((c) => c.startsWith(`${SESSION_CSRF_COOKIE}=`));
  assert.ok(sessionCookie?.includes("Max-Age=0"));
  assert.ok(sessionCookie?.includes("HttpOnly"));
  assert.ok(sessionCookie?.includes("SameSite=Strict"));
  assert.ok(csrfCookie?.includes("Max-Age=0"));
  assert.ok(csrfCookie?.includes("SameSite=Strict"));
});

test("SEC-08: Rate-Limit auf POST /api/auth/logout bremst Flood-Angriffe", async () => {
  const req = () => new Request("https://localhost/api/auth/logout", { method: "POST" });
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const res = await postLogout(req());
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, "Logout muss gegen Flooding geschuetzt sein");
});

test("SEC-08: Widerrufene Session scheitert an allen RBAC-Permissions und CSRF-Guards", () => {
  const session = createSession(ADMIN);
  const req = sessionRequest("https://localhost/api/x", session.sessionToken, {
    method: "POST",
    csrf: session.csrf,
  });

  // Vor Widerruf: CSRF und Permissions erlaubt
  assert.equal(checkCsrfGuard(req), null);
  for (const perm of permissionsForRole("admin")) {
    assert.equal(requirePermission(req, perm), null, `Perm ${perm} vor Revoke erlaubt`);
  }

  // Session widerrufen
  revokeSession(session.sessionToken);

  // Nach Widerruf: CSRF und alle Permissions verweigert
  assert.ok(checkCsrfGuard(req), "CSRF-Guard muss widerrufene Session abweisen");
  for (const perm of permissionsForRole("admin")) {
    const denied = requirePermission(req, perm);
    assert.ok(denied, `Perm ${perm} nach Revoke abgewiesen`);
    assert.ok([401, 403].includes(denied!.status));
  }
});

test("SEC-08: revokeSession behandelt ungueltige Parameter fail-safe", () => {
  assert.equal(revokeSession(""), false);
  assert.equal(revokeSession("not-a-token"), false);
  assert.equal(revokeSession({} as never), false);
  assert.equal(revokeSession(null as never), false);
});

/**
 * Friert `Date.now()` fuer die Dauer von `run` auf einen festen Zeitpunkt ein.
 * Reproduziert deterministisch die Millisekunden-Kollision zwischen globalem
 * Revocation-Cut und Neuanmeldung: `Date.now()` loest nur in ganzen
 * Millisekunden auf, auf schnellen CI-Runnern fallen Cut und Login regelmaessig
 * in denselben Tick (Red Gate fuer den `security:live-gate`-Abbruch in PR #120).
 */
async function withFrozenClock<T>(run: () => T | Promise<T>): Promise<T> {
  const frozen = Date.now();
  const realNow = Date.now;
  try {
    Date.now = () => frozen;
    return await run();
  } finally {
    Date.now = realNow;
  }
}

test("SEC-08: Globaler Cut und Neuanmeldung in derselben Millisekunde (CI-Regress)", async () => {
  await withFrozenClock(() => {
    const oldSession = createSession(OPERATOR);
    const oldPayload = readSession(sessionRequest("https://localhost", oldSession.sessionToken));
    assert.ok(oldPayload, "Session muss vor dem globalen Cut gueltig sein");

    revokeAllSessions();

    // Alt-Sessions sind am Cut sofort ungueltig (fail-closed).
    assert.equal(isSessionRevoked(oldPayload), true, "Globaler Cut muss die Altsession als widerrufen kennzeichnen");
    assert.equal(readSession(sessionRequest("https://localhost", oldSession.sessionToken)), null);

    // Neuanmeldung im SELBEN Millisekunden-Tick wie der Cut: ohne strikt
    // monotone Ausgabe waere iat == cutoff und die frische Session sofort tot.
    const fresh = createSession(OPERATOR);
    assert.ok(
      readSession(sessionRequest("https://localhost", fresh.sessionToken)),
      "Neuanmeldung in derselben Millisekunde wie der Cut darf nicht sofort widerrufen sein"
    );
    assert.ok(
      sessionActor(
        readSession(sessionRequest("https://localhost", fresh.sessionToken))!,
        FULL_ENV
      ),
      "Auch sessionActor muss die frische Session nach dem Cut akzeptieren"
    );
  });
});

test("SEC-08: Zwei globale Schnitte in derselben Millisekunde erfassen auch die Session dazwischen", async () => {
  await withFrozenClock(() => {
    const first = createSession(OPERATOR);
    revokeAllSessions();
    const between = createSession(OPERATOR);
    revokeAllSessions();

    assert.equal(readSession(sessionRequest("https://localhost", first.sessionToken)), null);
    assert.equal(
      readSession(sessionRequest("https://localhost", between.sessionToken)),
      null,
      "Der zweite Cut muss die zwischenzeitlich ausgestellte Session widerrufen"
    );

    const after = createSession(OPERATOR);
    assert.ok(readSession(sessionRequest("https://localhost", after.sessionToken)), "Session nach dem zweiten Cut bleibt gueltig");
  });
});

test("SEC-08: Login-Route unmittelbar nach globalem Admin-Cut liefert nutzbare Session (End-to-End)", async () => {
  await withFrozenClock(async () => {
    const adminSession = createSession(ADMIN);
    const cutRes = await postLogout(
      sessionRequest("https://localhost/api/auth/logout", adminSession.sessionToken, {
        method: "POST",
        csrf: adminSession.csrf,
        body: JSON.stringify({ all: true }),
      })
    );
    assert.equal(cutRes.status, 200);
    assert.equal((await cutRes.json()).allRevoked, true);

    const loginRes = await postLogin(
      new Request("https://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: OPERATOR }),
      })
    );
    assert.equal(loginRes.status, 200, "Login darf direkt nach dem globalen Cut nicht scheitern");
    const issued = /firm_session=([^;]+)/.exec(loginRes.headers.get("set-cookie") ?? "");
    assert.ok(issued?.[1], "Login muss ein Session-Cookie setzen");

    const meRes = await getMe(sessionRequest("https://localhost/api/auth/me", issued![1]));
    assert.equal(meRes.status, 200, "Die im selben Tick ausgestellte Session muss sofort nutzbar sein");
  });
});

test("SEC-08: Rueckwaerts springender Takt hebt einen globalen Cut nicht auf (kein Fail-Open)", () => {
  const t0 = Date.now();
  const realNow = Date.now;
  try {
    Date.now = () => t0;
    const before = createSession(OPERATOR);
    revokeAllSessions();

    // Systemtakt springt eine Minute zurueck (NTP-Step / VM-Migration).
    Date.now = () => t0 - 60_000;

    assert.equal(
      readSession(sessionRequest("https://localhost", before.sessionToken)),
      null,
      "Clock-Skew darf eine widerrufene Session nicht wieder gueltig machen"
    );
    const after = createSession(OPERATOR);
    assert.ok(
      readSession(sessionRequest("https://localhost", after.sessionToken)),
      "Neuanmeldung muss auch mit zurueckgesprungenem Takt moeglich bleiben (kein Lockout)"
    );
  } finally {
    Date.now = realNow;
  }
});

/**
 * Regressionstests: Session-Ablauf darf nicht als Datenbankfehler aussehen
 * (v1.36.41, Bug 2 aus `docs/HOWTO_LAN_SESSION.md`).
 *
 * Geprüft wird die echte ausgelieferte Logik (`src/lib/firmSession.ts`) —
 * dieselbe, die `FirmDashboard.load()` und `saveToken()` verwenden:
 *
 *   1  401  → Auth-Hinweis, `needsLogin`, **kein** DB-Text
 *   2  403  → Permission-Hinweis mit Server-`hint`, **kein** DB-Text
 *   3  503  → DB-Hinweis inklusive `.fix` bleibt erhalten
 *   4  500 ohne `.fix` → DB-Hinweis mit Fallback-Anleitung
 *   5  Vertrag: nur ein echter Snapshot gilt als Erfolg (FIX v1.23.0)
 *   6  Netzwerkfehler → „nicht erreichbar", nie „Datenbank"
 *   7  Login → Firm-Status wird automatisch neu geladen (kein F5 mehr)
 *   8  Abgelehnter Login → kein Reload, Feld bleibt offen
 *   9  Secret-Hygiene: Token nur im Body, nie in URL/Header/Meldung
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFirmFailure,
  describeSession,
  diagnosePostLogin,
  fetchFirmSnapshot,
  fetchSessionStatus,
  formatSessionCountdown,
  isFirmSnapshot,
  parseSessionStatus,
  renewSession,
  sessionNeedsLogin,
  sessionRemainingS,
  sessionRenewDelayMs,
  submitSessionToken,
  type SessionSnapshot,
} from "../src/lib/firmSession";

const TOKEN = "firm-test-token-abc123";

/** Originalgetreue Denial-Antwort (`denialResponse`, src/auth/resolve.ts). */
const UNAUTHORIZED_BODY = {
  ok: false,
  error: "UNAUTHORIZED",
  hint: "Fehlender/falscher x-firm-token Header.",
};

/** Originalgetreue Permission-Ablehnung (`requirePermission`). */
const FORBIDDEN_BODY = {
  ok: false,
  error: "FORBIDDEN",
  hint: 'Permission "firm.read" ist fuer Rolle viewer nicht erteilt.',
};

/** Originalgetreue DB-Störung (`GET /api/firm`, Catch-Zweig). */
const DB_BODY = {
  ok: false,
  error: "Dashboard-Daten nicht verfügbar: connect ECONNREFUSED 127.0.0.1:5432",
  fix: "PostgreSQL läuft? DATABASE_URL korrekt? `npx drizzle-kit push` ausgeführt?",
};

const SNAPSHOT = {
  version: "1.36.41",
  agents: [],
  missions: [],
  positions: [],
  proposals: [],
  account: { equity: 10000 },
};

/** Begriffe, die bei einem Auth-Problem nirgends auftauchen dürfen. */
const DB_TERMS = ["Datenbank", "PostgreSQL", "DATABASE_URL", "drizzle-kit"];

type Recorded = { url: string; init?: RequestInit };

/**
 * Minimales `fetch`-Double: antwortet pro URL, zeichnet Aufrufe auf.
 * `throws` simuliert einen nicht erreichbaren Dienst.
 */
function stubFetch(
  responder: (url: string) => { status: number; body: unknown } | "throw"
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = responder(url);
    if (answer === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Titel + Detail + Hinweis als ein Text — die Box rendert genau diese drei. */
function rendered(issue: { title: string; detail: string; hint: string }): string {
  return `${issue.title} ${issue.detail} ${issue.hint}`;
}

// ── 1 · 401 = Session, nicht Datenbank ────────────────────────────────────────

test("401 UNAUTHORIZED wird als Sitzungsproblem klassifiziert — ohne DB-Text", () => {
  const issue = classifyFirmFailure(401, UNAUTHORIZED_BODY);

  assert.equal(issue.kind, "session");
  assert.equal(issue.needsLogin, true, "das Token-Feld muss sofort aufgehen");
  assert.match(issue.title, /Sitzung abgelaufen/);
  assert.match(issue.title, /neu anmelden/);
  assert.equal(issue.detail, "UNAUTHORIZED", "Server-Fehlercode bleibt sichtbar");

  for (const term of DB_TERMS) {
    assert.ok(
      !rendered(issue).includes(term),
      `Auth-Fehler darf '${term}' nicht nennen — gerendert: ${rendered(issue)}`
    );
  }
});

test("401 ohne Fehlerkörper behält denselben Auth-Titel", () => {
  const issue = classifyFirmFailure(401, null);
  assert.equal(issue.kind, "session");
  assert.equal(issue.needsLogin, true);
  assert.equal(issue.detail, "HTTP 401");
});

// ── 2 · 403 = Permission, nicht Datenbank ─────────────────────────────────────

test("403 FORBIDDEN nennt die fehlende Permission statt der Datenbank", () => {
  const issue = classifyFirmFailure(403, FORBIDDEN_BODY);

  assert.equal(issue.kind, "forbidden");
  assert.equal(issue.needsLogin, true, "Anmeldung mit anderem Token muss möglich bleiben");
  assert.match(issue.hint, /firm\.read/, "der Server-Hint ist die eigentliche Erklärung");
  for (const term of DB_TERMS) {
    assert.ok(!rendered(issue).includes(term), `403 darf '${term}' nicht nennen`);
  }
});

// ── 3 · 503 = Datenbank bleibt Datenbank ──────────────────────────────────────

test("503 mit .fix behält den DB-Titel und die Original-Anleitung", () => {
  const issue = classifyFirmFailure(503, DB_BODY);

  assert.equal(issue.kind, "database");
  assert.equal(issue.needsLogin, false, "ein DB-Fehler ist kein Login-Problem");
  assert.match(issue.title, /Datenbank/);
  assert.equal(issue.detail, DB_BODY.error, "die echte Fehlerursache bleibt sichtbar");
  assert.equal(issue.hint, DB_BODY.fix, "die fix-Anleitung des Servers wird übernommen");
  assert.match(issue.hint, /drizzle-kit/);
});

test("500 ohne .fix bekommt die DB-Fallback-Anleitung", () => {
  const issue = classifyFirmFailure(500, { ok: false, error: "INTERNAL" });
  assert.equal(issue.kind, "database");
  assert.match(issue.hint, /PostgreSQL/);
  assert.match(issue.hint, /drizzle-kit/);
});

test("200 mit ok:false und .fix gilt ebenfalls als Datenquellen-Fehler", () => {
  const issue = classifyFirmFailure(200, DB_BODY);
  assert.equal(issue.kind, "database");
  assert.equal(issue.hint, DB_BODY.fix);
});

test("unerwartete 4xx-Antwort erfindet keine Ursache", () => {
  const issue = classifyFirmFailure(429, { ok: false, error: "RATE_LIMITED" });
  assert.equal(issue.kind, "unexpected");
  assert.equal(issue.needsLogin, false);
  assert.equal(issue.hint, "");
  for (const term of DB_TERMS) {
    assert.ok(!rendered(issue).includes(term), `429 darf '${term}' nicht nennen`);
  }
});

// ── 4 · Vertragsprüfung des Snapshots ─────────────────────────────────────────

test("isFirmSnapshot akzeptiert nur einen vollständigen Firm-Zustand", () => {
  assert.equal(isFirmSnapshot(SNAPSHOT), true);
  assert.equal(isFirmSnapshot({ ...SNAPSHOT, positions: undefined }), false);
  assert.equal(isFirmSnapshot(DB_BODY), false);
  assert.equal(isFirmSnapshot(UNAUTHORIZED_BODY), false);
  assert.equal(isFirmSnapshot(null), false);
  assert.equal(isFirmSnapshot("UNAUTHORIZED"), false);
});

// ── 5 · fetchFirmSnapshot: die drei Pfade von load() ──────────────────────────

test("fetchFirmSnapshot liefert bei 401 den Auth-Issue statt Daten", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 401, body: UNAUTHORIZED_BODY }));

  const result = await fetchFirmSnapshot(fetchImpl);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issue.kind, "session");
  assert.equal(result.issue.needsLogin, true);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/firm"]
  );
});

test("fetchFirmSnapshot liefert bei 503 den DB-Issue mit fix-Anleitung", async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 503, body: DB_BODY }));

  const result = await fetchFirmSnapshot(fetchImpl);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issue.kind, "database");
  assert.equal(result.issue.hint, DB_BODY.fix);
});

test("fetchFirmSnapshot liefert den Snapshot bei 200", async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: SNAPSHOT }));

  const result = await fetchFirmSnapshot(fetchImpl);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, SNAPSHOT);
});

test("fetchFirmSnapshot meldet Netzwerkfehler als unerreichbar, nicht als Datenbank", async () => {
  const { fetchImpl } = stubFetch(() => "throw");

  const result = await fetchFirmSnapshot(fetchImpl);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issue.kind, "network");
  assert.equal(result.issue.needsLogin, false);
  for (const term of DB_TERMS) {
    assert.ok(!rendered(result.issue).includes(term), `Netzwerkfehler darf '${term}' nicht nennen`);
  }
});

// ── 6 · Login lädt automatisch neu (kein F5) ──────────────────────────────────

test("erfolgreicher Login lädt /api/firm automatisch neu", async () => {
  const { fetchImpl, calls } = stubFetch((url) =>
    url === "/api/auth/login"
      ? {
          status: 200,
          body: {
            ok: true,
            expiresInS: 900,
            // v1.39.0: der Server nennt seine Fristen, der Client rät nicht.
            lifetime: { idleTtlS: 900, maxLifeS: 86_400, graceS: 900 },
            cookieLifetime: "browser-session",
          },
        }
      : { status: 200, body: SNAPSHOT }
  );
  const notices: string[] = [];
  const reloads: string[] = [];

  const authenticated = await submitSessionToken(TOKEN, {
    fetchImpl,
    onNotice: (message) => notices.push(message),
    reload: async () => {
      reloads.push("load");
      await fetchFirmSnapshot(fetchImpl);
    },
  });

  assert.equal(authenticated, true);
  assert.deepEqual(reloads, ["load"], "load() muss genau einmal nachgerufen werden");
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/auth/login", "/api/firm"],
    "erst Login, dann der automatische Reload"
  );
  const notice = notices[0] ?? "";
  assert.match(notice, /Sitzung gilt bis zum Schlie.{0,2}n des Browserfensters/, "die neue Zusage gehoert dem Nutzer gesagt");
  assert.match(notice, /Frist 900 s/, "die Idle-Frist kommt vom Server, nicht aus einem Client-Default");
  assert.match(notice, /absolute Grenze 24 h/, "auch die absolute Obergrenze wird genannt");
  assert.match(notice, /neu geladen/, "kein Aufruf zum manuellen F5 mehr");
});

test("Offen-Betrieb wird als solcher gemeldet und lädt ebenfalls neu", async () => {
  const { fetchImpl } = stubFetch((url) =>
    url === "/api/auth/login"
      ? { status: 200, body: { ok: true, open: true, expiresInS: 0 } }
      : { status: 200, body: SNAPSHOT }
  );
  const notices: string[] = [];
  let reloaded = 0;

  const authenticated = await submitSessionToken(TOKEN, {
    fetchImpl,
    onNotice: (message) => notices.push(message),
    reload: () => {
      reloaded += 1;
    },
  });

  assert.equal(authenticated, true);
  assert.equal(reloaded, 1);
  assert.match(notices[0] ?? "", /Offen-Betrieb/);
});

test("abgelehnter Login lädt nicht neu und nennt den Server-Hint", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 401,
    body: { ok: false, error: "INVALID_TOKEN", hint: "Token stimmt nicht mit FIRM_API_TOKEN überein." },
  }));
  const notices: string[] = [];
  let reloaded = 0;

  const authenticated = await submitSessionToken(TOKEN, {
    fetchImpl,
    onNotice: (message) => notices.push(message),
    reload: () => {
      reloaded += 1;
    },
  });

  assert.equal(authenticated, false, "das Token-Feld muss offen bleiben");
  assert.equal(reloaded, 0, "ohne Session gibt es keinen Reload");
  assert.match(notices[0] ?? "", /Anmeldung abgelehnt/);
  assert.match(notices[0] ?? "", /FIRM_API_TOKEN/);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/auth/login"]
  );
});

test("Netzwerkfehler beim Login lädt nicht neu", async () => {
  const { fetchImpl } = stubFetch(() => "throw");
  const notices: string[] = [];
  let reloaded = 0;

  const authenticated = await submitSessionToken(TOKEN, {
    fetchImpl,
    onNotice: (message) => notices.push(message),
    reload: () => {
      reloaded += 1;
    },
  });

  assert.equal(authenticated, false);
  assert.equal(reloaded, 0);
  assert.match(notices[0] ?? "", /Netzwerkfehler/);
});

// ── 7 · Secret-Hygiene ────────────────────────────────────────────────────────

test("der Token reist nur im Body — nie in URL, Header oder Meldung", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 401,
    body: { ok: false, error: "INVALID_TOKEN", hint: "Token unbekannt." },
  }));
  const notices: string[] = [];

  await submitSessionToken(TOKEN, {
    fetchImpl,
    onNotice: (message) => notices.push(message),
    reload: () => undefined,
  });

  const login = calls[0];
  assert.ok(login, "Login muss aufgerufen worden sein");
  assert.ok(!login.url.includes(TOKEN), "Token darf nie in der URL stehen");
  assert.equal(JSON.parse(String(login.init?.body)).token, TOKEN, "Body trägt das Token");

  const headers = new Headers(login.init?.headers as HeadersInit);
  for (const [, value] of headers) {
    assert.ok(!value.includes(TOKEN), "Token darf in keinem Header stehen");
  }
  for (const message of notices) {
    assert.ok(!message.includes(TOKEN), "keine Meldung darf das Token echoen");
  }
});

// ── 10 · Anmeldestatus und Verlaengerung (v1.39.0) ─────────────────────────

const NOW = 1_789_000_000_000;

/** Serverantwort von `GET /api/auth/status`, wie die Route sie liefert. */
function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    authMode: { mode: "token-required", reason: "tokens-configured", production: false, tokensConfigured: true },
    firmApi: { configured: true, admin: false, operator: true, viewer: false, sessionsAvailable: true },
    session: {
      active: true,
      state: "active",
      role: "operator",
      remainingS: 600,
      maxLifeRemainingS: 43_200,
      renewInS: 300,
      idleTtlS: 900,
      maxLifeS: 86_400,
      graceS: 900,
      expiresAt: new Date(NOW + 600_000).toISOString(),
      maxExpiresAt: new Date(NOW + 43_200_000).toISOString(),
      cookieLifetime: "browser-session",
      ...over,
    },
  };
}

function snap(over: Partial<SessionSnapshot["session"]> = {}): SessionSnapshot {
  return parseSessionStatus(statusBody(over), NOW) as SessionSnapshot;
}

test("parseSessionStatus: toleranter Parser mit sinnvollen Defaults", () => {
  const parsed = parseSessionStatus(statusBody(), NOW);
  assert.ok(parsed);
  assert.equal(parsed.session.state, "active");
  assert.equal(parsed.session.role, "operator");
  assert.equal(parsed.session.idleTtlS, 900);
  assert.equal(parsed.session.renewInS, 300);
  assert.equal(parsed.observedAt, NOW);

  //muelliger bzw. fehlender Body ⇒ null, nie ein Teil-Zustand
  assert.equal(parseSessionStatus(null, NOW), null);
  assert.equal(parseSessionStatus({ ok: true }, NOW), null);
  assert.equal(parseSessionStatus({ ok: false, error: "X" }, NOW), null);
  // Unbekannter State => invalid (fail-closed), Zahlen muellen auf 0/Default
  const weird = parseSessionStatus(
    { ...statusBody(), session: { state: "geheim", remainingS: -5, renewInS: "x", idleTtlS: null } },
    NOW
  );
  assert.ok(weird);
  assert.equal(weird.session.state, "invalid");
  assert.equal(weird.session.remainingS, 0);
  assert.equal(weird.session.renewInS, 15);
  assert.equal(weird.session.idleTtlS, 900);
});

test("sessionRemainingS: zaehlt gegen die Uhr, nie unter null", () => {
  const snapshot = snap();
  assert.equal(sessionRemainingS(snapshot, NOW), 600);
  assert.equal(sessionRemainingS(snapshot, NOW + 120_000), 480);
  assert.equal(sessionRemainingS(snapshot, NOW + 3_600_000), 0);
});

test("sessionRenewDelayMs: ein Timer pro Zustand, kein Dauerintervall", () => {
  assert.equal(sessionRenewDelayMs(snap(), NOW), 300_000, "renewInS des Servers");
  assert.equal(sessionRenewDelayMs(snap({ state: "expiring" }), NOW), 300_000);
  assert.equal(sessionRenewDelayMs(snap({ state: "renewable", remainingS: 0 }), NOW), 0, "sofort heilen");
  assert.equal(sessionRenewDelayMs(snap({ state: "expired", remainingS: 0 }), NOW), null);
  assert.equal(sessionRenewDelayMs(snap({ state: "missing", active: false, remainingS: 0 }), NOW), null);
  assert.equal(sessionRenewDelayMs(snap({ state: "max-life", remainingS: 0 }), NOW), null);
  assert.equal(
    sessionRenewDelayMs(snap({ state: "open", active: true, remainingS: 0 }), NOW),
    null,
    "Offen-Betrieb hat keine Session zu verlaengern"
  );
  assert.equal(sessionRenewDelayMs(null, NOW), null);
  // Nie unter 15 s: ein 1-s-Ticker waer ein Denial-of-Service gegen den eigenen Server.
  assert.equal(sessionRenewDelayMs(snap({ renewInS: 1 }), NOW), 15_000);
});

test("sessionNeedsLogin: Feld nur, wenn eine Anmeldung etwas aendert", () => {
  assert.equal(sessionNeedsLogin(snap()), false, "aktive Session braucht kein Feld");
  assert.equal(sessionNeedsLogin(snap({ state: "expiring" })), false);
  assert.equal(sessionNeedsLogin(snap({ state: "renewable", remainingS: 0 })), false, "Nachfrist heilt ohne Eingabe");
  assert.equal(sessionNeedsLogin(snap({ state: "open", remainingS: 0 })), false);
  assert.equal(sessionNeedsLogin(snap({ state: "missing", active: false, remainingS: 0 })), true);
  assert.equal(sessionNeedsLogin(snap({ state: "expired", active: false, remainingS: 0 })), true);
  assert.equal(sessionNeedsLogin(snap({ state: "revoked", active: false, remainingS: 0 })), true);
  // Kein Token und keine Sessions ⇒ das Feld fuehrt zu nichts.
  assert.equal(
    sessionNeedsLogin(parseSessionStatus(
      { ...statusBody(), firmApi: { configured: false, admin: false, operator: false, viewer: false, sessionsAvailable: false } },
      NOW
    )),
    false
  );
});

test("formatSessionCountdown und describeSession: lesbarer Zustand statt Raten", () => {
  assert.equal(formatSessionCountdown(0), "00:00");
  assert.equal(formatSessionCountdown(780), "13:00");
  assert.equal(formatSessionCountdown(43_200), "12:00:00");

  const active = describeSession(snap(), NOW);
  assert.match(active.label, /Firm-API: eingetragen/);
  assert.match(active.label, /angemeldet als Operator/);
  assert.equal(active.warning, false, "aktive Sitzung ist kein Warnzustand");

  assert.match(describeSession(snap({ state: "open" }), NOW).label, /Lokaler Offen-Betrieb/);
  assert.match(describeSession(snap({ state: "missing", active: false }), NOW).label, /nicht angemeldet/);
  assert.match(describeSession(snap({ state: "missing", active: false }), NOW).label, /Schlie.{0,2}n des Browserfensters/);
  const noToken = parseSessionStatus(
    {
      ...statusBody(),
      session: { ...(statusBody().session as Record<string, unknown>), state: "invalid" },
      firmApi: { configured: false, admin: false, operator: false, viewer: false, sessionsAvailable: false },
    },
    NOW
  );
  assert.match(describeSession(noToken, NOW).label, /KEIN Token gesetzt/);
});

test("fetchSessionStatus: 200 => Snapshot, Fehler => ok:false ohne Wurf", async () => {
  const { fetchImpl } = stubFetch((url) =>
    url === "/api/auth/status" ? { status: 200, body: statusBody() } : { status: 500, body: null }
  );
  const result = await fetchSessionStatus(fetchImpl, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.snapshot.session.state, "active");

  const broken = stubFetch(() => ({ status: 200, body: "<html>login</html>" }));
  assert.equal((await fetchSessionStatus(broken.fetchImpl)).ok, false);

  const down = stubFetch(() => "throw");
  const failed = await fetchSessionStatus(down.fetchImpl);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /Netzwerkfehler/);
});

test("renewSession: POST mit Double-Submit-Header, nie mit Token im Query", async () => {
  const { fetchImpl, calls } = stubFetch((url) =>
    url === "/api/auth/refresh"
      ? { status: 200, body: { ok: true, renewed: true, session: true, expiresInS: 890, cookieLifetime: "browser-session" } }
      : { status: 500, body: null }
  );
  const result = await renewSession("c".repeat(64), fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.renewed, true);
  assert.equal(result.remainingS, 890);
  const call = calls[0];
  assert.equal(call.url, "/api/auth/refresh");
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.credentials, "same-origin");
  assert.equal(new Headers(call.init?.headers as HeadersInit).get("x-csrf-token"), "c".repeat(64));
});

test("renewSession: 401 des Servers wird zur Meldung, nicht zur Ausnahme", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 401,
    body: { ok: false, error: "SESSION_INVALID", hint: "Bitte neu anmelden." },
  }));
  const result = await renewSession("", fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Bitte neu anmelden.", "der Server-Hint fuehrt die Antwort");
});

test("renewSession: Offen-Betrieb ist kein Fehler", async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: { ok: true, open: true, renewed: false } }));
  const result = await renewSession("x".repeat(64), fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.renewed, false);
  assert.match(result.error, /Offen-Betrieb/);
});

test("diagnosePostLogin: Login 200, aber Cookie nicht übernommen → TLS-Hinweis", () => {
  assert.equal(diagnosePostLogin(snap()), "", "aktive Session: nichts zu melden");
  assert.match(
    diagnosePostLogin(snap({ state: "missing", active: false, remainingS: 0 })),
    /Secure\S*Cookies brauchen TLS/,
    "der haufigste LAN-Bruch wird benannt"
  );
  assert.match(diagnosePostLogin(null), /plain-HTTP/, "ohne Statusantwort bleibt der Hinweis bestehen");
  // Andere Zustnde sind keine Cookie-Ursache (abgelaufen, widerrufen, …).
  for (const state of ["expired", "revoked", "max-life", "renewable", "invalid"] as const) {
    assert.equal(diagnosePostLogin(snap({ state, active: false, remainingS: 0 })), "", state);
  }
});

test("describeSession unterscheidet „wird geprueft“ von „nicht erreichbar“", () => {
  assert.match(describeSession(null, NOW).label, /wird gepraft/);
  assert.equal(describeSession(null, NOW).warning, false, "beim ersten Render ist nichts warnend");
  assert.match(describeSession(null, NOW, true).label, /nicht ermittelbar/);
  assert.equal(describeSession(null, NOW, true).warning, true);
});

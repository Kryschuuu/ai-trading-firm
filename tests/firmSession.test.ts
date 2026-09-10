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
  fetchFirmSnapshot,
  isFirmSnapshot,
  submitSessionToken,
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
      ? { status: 200, body: { ok: true, expiresInS: 900 } }
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
  assert.match(notices[0] ?? "", /Session aktiv \(900 s\)/);
  assert.match(notices[0] ?? "", /neu geladen/, "kein Aufruf zum manuellen F5 mehr");
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

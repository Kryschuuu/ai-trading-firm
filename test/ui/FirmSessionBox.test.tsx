/**
 * Render-Tests der Session-Hinweisbox (v1.36.41) — die echten Komponenten,
 * keine Nachbildung: `FirmIssueBox` + `SessionNoticeBar`, beide mit Props aus
 * `classifyFirmFailure`, also exakt dem Pfad, den `FirmDashboard` fährt.
 *
 *   1  401 → „Sitzung abgelaufen" + Token-Feld sichtbar, **kein** DB-Text
 *   2  403 → „Zugriff verweigert" + fehlende Permission, **kein** DB-Text
 *   3  503 → DB-Titel und `drizzle-kit`-Anleitung bleiben erhalten
 *   4  Netzwerk → „nicht erreichbar", kein DB-Text, kein Token-Feld
 *   5  Token-Feld nur bei Bedarf; sonst ist „Abmelden" sichtbar
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  classifyFirmFailure,
  fetchFirmSnapshot,
  type FirmIssue,
  type SessionSnapshot,
} from "../../src/lib/firmSession";
import { FirmIssueBox } from "../../src/components/common/FirmIssueBox";
import { SessionNoticeBar } from "../../src/components/common/SessionNoticeBar";

const DB_TERMS = ["Datenbank", "PostgreSQL", "DATABASE_URL", "drizzle-kit"];

function renderBox(issue: FirmIssue): string {
  return renderToStaticMarkup(createElement(FirmIssueBox, { issue }));
}

/** Der Hinweisbalken, wie das Dashboard ihn bei `showTokenField` rendert. */
function renderBar(showTokenField: boolean, session: SessionSnapshot | null = null): string {
  return renderToStaticMarkup(
    createElement(SessionNoticeBar, {
      notice: "",
      showTokenField,
      tokenDraft: "",
      onTokenDraftChange: () => undefined,
      onSubmit: () => undefined,
      onLogout: () => undefined,
      onRenew: () => undefined,
      onShowLogin: () => undefined,
      statusUnavailable: !showTokenField && session === null ? true : false,
      session,
      now: NOW,
    })
  );
}

/** Fester Anker, damit kein Test von der Uhr abhängt. */
const NOW = 1_789_000_000_000;

/** Session-Snapshot, wie `parseSessionStatus` ihn aus `GET /api/auth/status` baut. */
function snapshot(
  over: Partial<SessionSnapshot["session"]> = {},
  firmApi: Partial<SessionSnapshot["firmApi"]> = {}
): SessionSnapshot {
  return {
    mode: "token-required",
    reason: "tokens-configured",
    firmApi: {
      configured: true,
      admin: true,
      operator: true,
      viewer: false,
      sessionsAvailable: true,
      ...firmApi,
    },
    session: {
      active: true,
      state: "active",
      role: "operator",
      remainingS: 780,
      maxLifeRemainingS: 43_200,
      renewInS: 480,
      idleTtlS: 900,
      maxLifeS: 86_400,
      graceS: 900,
      cookieLifetime: "browser-session",
      expiresAt: NOW + 780_000,
      ...over,
    },
    observedAt: NOW,
  };
}

function assertNoDatabaseText(html: string, context: string): void {
  for (const term of DB_TERMS) {
    assert.ok(!html.includes(term), `${context}: '${term}' darf nicht gerendert werden`);
  }
}

test("401: Auth-Hinweis und Token-Feld statt Datenbank-Diagnose", () => {
  const issue = classifyFirmFailure(401, {
    ok: false,
    error: "UNAUTHORIZED",
    hint: "Fehlender/falscher x-firm-token Header.",
  });

  const box = renderBox(issue);
  assert.match(box, /Sitzung abgelaufen/, "der Titel muss die Ursache nennen");
  assert.match(box, /neu anmelden/);
  assert.match(box, /UNAUTHORIZED/, "der Server-Fehlercode bleibt sichtbar");
  assertNoDatabaseText(box, "401-Box");

  // Der Hinweisbalken zeigt das Token-Feld ohne vorherige Aktion.
  const bar = renderBar(issue.needsLogin);
  assert.match(bar, /type="password"/, "das Token-Feld muss sofort sichtbar sein");
  assert.match(bar, /Anmelden/);
  assert.match(bar, /FIRM_API_TOKEN/, "die Platzhalter-Anleitung nennt die Env-Variable");
  assertNoDatabaseText(bar, "401-Balken");
});

test("403: Permission-Hinweis nennt firm.read, nicht die Datenbank", () => {
  const issue = classifyFirmFailure(403, {
    ok: false,
    error: "FORBIDDEN",
    hint: 'Permission "firm.read" ist fuer Rolle viewer nicht erteilt.',
  });

  const box = renderBox(issue);
  assert.match(box, /Zugriff verweigert/);
  assert.match(box, /firm\.read/);
  assertNoDatabaseText(box, "403-Box");
});

test("503: Datenbank-Titel und Original-Anleitung bleiben erhalten", () => {
  const issue = classifyFirmFailure(503, {
    ok: false,
    error: "Dashboard-Daten nicht verfügbar: connect ECONNREFUSED 127.0.0.1:5432",
    fix: "PostgreSQL läuft? DATABASE_URL korrekt? `npx drizzle-kit push` ausgeführt?",
  });

  const box = renderBox(issue);
  assert.match(box, /Firm-Status nicht verfügbar \(Datenbank\)/);
  assert.match(box, /ECONNREFUSED/, "die echte Ursache bleibt sichtbar");
  assert.match(box, /drizzle-kit/, "die DB-Anleitung gehört hierhin");
  assert.match(box, /Modul-Tabs/, "der Hinweis auf weiter nutzbare Tabs bleibt");

  // Kein Login-Feld: Ein DB-Fehler ist kein Anmeldeproblem.
  const bar = renderBar(issue.needsLogin);
  assert.ok(!bar.includes('type="password"'), "bei 503 darf kein Token-Feld erscheinen");
  assert.match(bar, /Abmelden/);
});

test("Netzwerkfehler: unerreichbar statt Datenbank, kein Token-Feld", async () => {
  // Echter Pfad: fetchFirmSnapshot fängt den Wurf und liefert den Issue.
  const throwingFetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await fetchFirmSnapshot(throwingFetch);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issue.kind, "network");

  const box = renderBox(result.issue);
  assert.match(box, /nicht erreichbar/);
  assertNoDatabaseText(box, "Netzwerk-Box");
  const bar = renderBar(result.issue.needsLogin);
  assert.ok(!bar.includes('type="password"'));
});

test("Token-Feld ist ausgeblendet, solange eine gültige Session besteht", () => {
  const bar = renderBar(false);
  assert.ok(!bar.includes('type="password"'));
  assert.match(bar, /Abmelden/);
});

// ── 6 · Anmeldestatus im Balken (v1.39.0) ─────────────────────────────────────

test("aktive Session: Balken nennt API-Konfiguration, Rolle und Restzeit", () => {
  const bar = renderBar(false, snapshot());
  assert.match(bar, /Firm-API: eingetragen/, "die Frage „API eingetragen?“ steht endlich da");
  assert.match(bar, /angemeldet als Operator/);
  assert.match(bar, /automatische Verlaengerung/);
  assert.match(bar, /13:00/, "780 s Restzeit werden angezeigt");
  assert.match(bar, /absolute Grenze in 12:00:00/, "der absolute Deckel bleibt sichtbar");
  assert.match(bar, /Verlängern/, "manuelle Verlängerung direkt bedienbar");
  assert.match(bar, /Abmelden/);
  assert.ok(!bar.includes('type="password"'), "mit gültiger Session ist kein Tokenfeld nötig");
  assertNoDatabaseText(bar, "Session-Balken");
});

test("abgelaufene Idle-Frist mit Nachfrist: heilt ohne Token-Eingabe", () => {
  const bar = renderBar(
    false,
    snapshot({ active: false, state: "renewable", remainingS: 0 })
  );
  assert.match(bar, /automatisch wiederhergestellt/);
  assert.ok(!bar.includes('type="password"'), "renewable ist kein Anmeldegrund");
});

test("Nachfrist vorbei: klarer Hinweis aufs Neuanmelden, kein DB-Text", () => {
  const bar = renderBar(
    true,
    snapshot({ active: false, state: "expired", remainingS: 0, maxLifeRemainingS: 0, expiresAt: null })
  );
  assert.match(bar, /auch Nachfrist vorbei/);
  assert.match(bar, /bitte neu anmelden/);
  assert.match(bar, /type="password"/, "jetzt darf das Tokenfeld erscheinen");
  assertNoDatabaseText(bar, "expired-Balken");
});

test("absolute Grenze erreicht: Neu-Anmeldung, nicht Verlängern", () => {
  const bar = renderBar(
    true,
    snapshot({ active: false, state: "max-life", remainingS: 0, maxLifeRemainingS: 0, expiresAt: null })
  );
  assert.match(bar, /Maximale Sitzungsdauer erreicht/);
  assert.match(bar, /24 h/);
  assert.ok(!bar.includes("Verlängern"), "Verlängern ist hier sinnlos und wird nicht angeboten");
});

test("kein Token gesetzt: der Balken benennt die Konfiguration, statt zu schweigen", () => {
  const bar = renderBar(
    false,
    snapshot(
      { active: false, state: "invalid", role: null, remainingS: 0, expiresAt: null },
      { configured: false, admin: false, operator: false, sessionsAvailable: false }
    )
  );
  assert.match(bar, /Firm-API: KEIN Token gesetzt/);
  assert.match(bar, /Abmelden/, "ohne Konfiguration führt Anmelden zu nichts — Abmelden räumt auf");
  assert.ok(!bar.includes('type="password"'), "ohne Token bringt das Feld nichts");
});

test("Lokal-Offen-Betrieb: keine Anmeldung nötig, aber klarer Warnhinweis", () => {
  const bar = renderBar(
    false,
    snapshot(
      { active: true, state: "open", role: "admin", remainingS: 0, maxLifeRemainingS: 0, expiresAt: null },
      { configured: false, admin: false, operator: false, sessionsAvailable: false }
    )
  );
  assert.match(bar, /Lokaler Offen-Betrieb/);
  assert.match(bar, /nur fuer Entwicklung\/Loopback/);
  assert.ok(!bar.includes("Anmelden"), "offener Betrieb braucht keinen Login-Knopf");
});

test("Status unbekannt (Netzwerk): Warnung ohne Fehldiagnose", () => {
  const bar = renderBar(false, null);
  assert.match(bar, /Anmeldestatus nicht ermittelbar/);
  assertNoDatabaseText(bar, "Snapshot-los-Balken");
});

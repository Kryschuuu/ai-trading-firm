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
} from "../../src/lib/firmSession";
import { FirmIssueBox } from "../../src/components/common/FirmIssueBox";
import { SessionNoticeBar } from "../../src/components/common/SessionNoticeBar";

const DB_TERMS = ["Datenbank", "PostgreSQL", "DATABASE_URL", "drizzle-kit"];

function renderBox(issue: FirmIssue): string {
  return renderToStaticMarkup(createElement(FirmIssueBox, { issue }));
}

/** Der Hinweisbalken, wie das Dashboard ihn bei `showTokenField` rendert. */
function renderBar(showTokenField: boolean): string {
  return renderToStaticMarkup(
    createElement(SessionNoticeBar, {
      notice: "",
      showTokenField,
      tokenDraft: "",
      onTokenDraftChange: () => undefined,
      onSubmit: () => undefined,
      onLogout: () => undefined,
    })
  );
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

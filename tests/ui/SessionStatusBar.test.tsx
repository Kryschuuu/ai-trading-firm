/**
 * Der Dashboard-Balken als Ganzes (v1.39.0) — die Frage „Ist die Firm-API
 * eingetragen, und laeuft meine Session?“ muss beantwortet werden, *ohne* dass
 * erst eine Aktion fehlschlaegt. Deshalb hier das echte `FirmDashboard`
 * (statischer Render, keine Effekte) plus die Zustandsmatrix des Balkens.
 *
 *   1  Erster Render: Balken ist da, Beschriftung wartet, kein Tokenfeld-Zwang
 *   2  Aktive Session: Rolle + Restzeit + „Verlaengern“/„Abmelden“, kein Feld
 *   3  Ohne Konfiguration: der Balken sagt „KEIN Token gesetzt“, nicht „DB“
 *   4  Kein Modus-Raten: der Text kommt ausschliesslich aus `describeSession`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FirmDashboard from "../../src/components/FirmDashboard";
import { SessionNoticeBar } from "../../src/components/common/SessionNoticeBar";
import { parseSessionStatus, type SessionSnapshot } from "../../src/lib/firmSession";

const NOW = 1_789_000_000_000;

function snapshot(
  session: Partial<SessionSnapshot["session"]> = {},
  firmApi: Partial<SessionSnapshot["firmApi"]> = {}
): SessionSnapshot {
  const parsed = parseSessionStatus(
    {
      ok: true,
      authMode: { mode: "token-required", reason: "tokens-configured", production: false, tokensConfigured: true },
      firmApi: { configured: true, admin: false, operator: true, viewer: false, sessionsAvailable: true, ...firmApi },
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
        ...session,
      },
    },
    NOW
  );
  assert.ok(parsed, "der Snapshot muss parsebar sein");
  return parsed;
}

function bar(props: Partial<Parameters<typeof SessionNoticeBar>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionNoticeBar, {
      notice: "",
      showTokenField: false,
      tokenDraft: "",
      onTokenDraftChange: () => undefined,
      onSubmit: () => undefined,
      onLogout: () => undefined,
      onRenew: () => undefined,
      onShowLogin: () => undefined,
      session: snapshot(),
      now: NOW,
      ...props,
    })
  );
}

test("FirmDashboard: Balken ist beim ersten Render da und beschriftet", () => {
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.match(html, /Anmeldestatus wird gepraft/, "den Status zu zeigen ist die Zusage dieses Releases");
  assert.match(html, /Autonomous AI Trading Firm/, "das Dashboard selbst rendert weiter");
  assert.ok(!html.includes('type="password"'), "ohne Befund kein Anmeldefeld aufdraengeln");
});

test("aktive Session: Rolle, Restzeit, Verlaengern und Abmelden — kein Tokenfeld", () => {
  const html = bar();
  assert.match(html, /Firm-API: eingetragen/);
  assert.match(html, /angemeldet als Operator/);
  assert.match(html, /10:00/, "600 s Restzeit");
  assert.match(html, /Verlängern/);
  assert.match(html, /Abmelden/);
  assert.ok(!html.includes('type="password"'));
});

test("ohne konfiguriertes Credential sagt der Balken genau das", () => {
  const html = bar({
    session: snapshot(
      { active: false, state: "invalid", role: null, remainingS: 0, expiresAt: null },
      { configured: false, admin: false, operator: false, sessionsAvailable: false }
    ),
  });
  assert.match(html, /KEIN Token gesetzt/);
  assert.match(html, /Abmelden/, "Abmelden raumt ein etwaiges Alt-Cookie weg");
  assert.ok(!html.includes("Anmelden"), "ohne Credential fuehrt Anmelden zu nichts");
});

test("nicht angemeldet, API eingetragen: Anmeldeknopf blendet das Feld ein", () => {
  const html = bar({ session: snapshot({ active: false, state: "missing", role: null, remainingS: 0, expiresAt: null }) });
  assert.match(html, /nicht angemeldet/);
  assert.match(html, />Anmelden</, "der Knopf ist da, wo eine Anmeldung moeglich ist");
  assert.match(html, /bis zum Schließen des Browserfensters/, "die neue Zusage steht schon hier");
  assert.ok(!html.includes('type="password"'), "erst ein Klick zeigt das Feld");
});

test("Nachfrist-Zustand: der Klick auf Verlaengern ist das Heilmittel — kein Anmeldefeld", () => {
  const html = bar({ session: snapshot({ state: "renewable", active: false, remainingS: 0 }) });
  assert.match(html, /wird automatisch wiederhergestellt/);
  assert.match(html, />Verl\u00e4ngern</, "genau hier muss der Knopf stehen");
  assert.ok(!html.includes('type="password"'), "Nachfrist ist kein Anmeldegrund");
});

test("abgelaufene Sitzung: Anmeldefeld mit erklaerendem Text, keine Fehldiagnose", () => {
  const html = bar({
    showTokenField: true,
    session: snapshot({ active: false, state: "expired", role: null, remainingS: 0, expiresAt: null }),
  });
  assert.match(html, /type="password"/);
  assert.match(html, /HttpOnly-Sitzung/, "die Zusage: der Token bleibt nicht im Browser");
  assert.match(html, /bitte neu anmelden/);
});

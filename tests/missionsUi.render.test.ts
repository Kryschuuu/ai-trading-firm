/**
 * Render-Tests des Missions-Baukastens (v1.35.0) — die echten Komponenten,
 * keine Nachbildung. `renderToStaticMarkup` beweist ohne Browser und ohne
 * Netzwerk:
 *
 *   1  die Vorlagen-Auswahl rendert den kompletten Katalog (gruppiert, mit
 *      Risikoprofil, Erfolgskriterium und Drei-Ebenen-Hilfe),
 *   2  das Missionsformular bietet beide Missions-Typen als Radiogruppe an,
 *   3  die Missionsliste zeigt den Missions-Typ als Badge (Symbol bzw.
 *      „Markt-Scan: <Segment>“),
 *   4  Accessibility: Tooltips hängen als `sr-only`-Text im DOM und die
 *      Radiogruppe ist beschriftet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FirmDashboard from "../src/components/FirmDashboard";
import MissionTemplatePicker from "../src/components/workshop/MissionTemplatePicker";
import MissionsPanel from "../src/components/workshop/MissionsPanel";
import { MISSION_TEMPLATES, missionTemplateDto } from "../src/lib/missionTemplates";
import type { MissionRow, MissionTemplateDto } from "../src/lib/types";

const TEMPLATES: MissionTemplateDto[] = MISSION_TEMPLATES.map(missionTemplateDto);

function row(overrides: Partial<MissionRow> & { id: string; title: string }): MissionRow {
  return {
    objective: "Nur Long, Stop 5 %, bei Unsicherheit HOLD.",
    symbol: "BTC",
    scope: "SINGLE_SYMBOL",
    segment: null,
    templateId: "paper-btc-long-only",
    riskBudget: "0.02",
    maxPositionPct: "0.25",
    status: "PENDING",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  };
}

const noop = () => {};

// ── 1) Vorlagen-Auswahl ──────────────────────────────────────────────────────

test("Vorlagen: Katalog wird gruppiert und vollständig gerendert", () => {
  const html = renderToStaticMarkup(
    createElement(MissionTemplatePicker, { templates: TEMPLATES, onApply: noop })
  );

  assert.match(html, /1 · Vorlage wählen/, "Schritt-1-Überschrift fehlt");
  assert.match(html, new RegExp(`${TEMPLATES.length} Vorlagen`), "Anzahl der Vorlagen wird nicht genannt");
  assert.match(html, /14 davon werden bei der Installation angelegt/, "Hinweis auf die Standard-Missionen fehlt");

  // Kategorien als optgroup:
  for (const label of ["Einstieg &amp; Einzelwerte", "Markt-Scans (Segment)", "Strategien", "Diagnose &amp; Tests"]) {
    assert.ok(html.includes(label), `Kategorie ${label} fehlt in der Auswahlliste`);
  }

  // Jede Vorlage ist als Option vorhanden:
  for (const template of TEMPLATES) {
    assert.ok(html.includes(template.id), `Vorlage ${template.id} fehlt in der Auswahl`);
  }
  assert.match(html, /In Formular übernehmen/, "Übernehmen-Knopf fehlt");
});

test("Vorlagen: Drei-Ebenen-Hilfe und Erfolgskriterium sind lesbar hinterlegt", () => {
  const html = renderToStaticMarkup(
    createElement(MissionTemplatePicker, {
      templates: TEMPLATES,
      onApply: noop,
      activeTemplateId: "scan-all-markets",
    })
  );
  const scan = missionTemplateDto(MISSION_TEMPLATES.find((t) => t.id === "scan-all-markets")!);

  assert.match(html, /Hilfe zu dieser Vorlage/, "Hilfe-Aufklapper fehlt");
  assert.ok(html.includes("Kurzinfo") && html.includes("Technische Info") && html.includes("Risiko"));
  assert.ok(html.includes(scan.help.kurzinfo), "Kurzinfo der Vorlage fehlt");
  assert.ok(html.includes(scan.help.risiko), "Risiko-Hinweis der Vorlage fehlt");
  assert.ok(html.includes("Markt-Scan: Alle Märkte"), "Scope + Segment werden nicht angezeigt");
  assert.match(html, /wird mitinstalliert/, "Seed-Kennzeichnung fehlt");
});

test("Vorlagen: ohne Katalog erscheint ein erklärender Hinweis statt eines leeren Kastens", () => {
  const html = renderToStaticMarkup(createElement(MissionTemplatePicker, { templates: [], onApply: noop }));
  assert.match(html, /Vorlagenkatalog nicht geladen/);
  assert.match(html, /\/api\/firm\/missions/);
});

// ── 2) Missionsformular ──────────────────────────────────────────────────────

test("Missionsformular: beide Missions-Typen sind als beschriftete Radiogruppe wählbar", () => {
  const html = renderToStaticMarkup(
    createElement(MissionsPanel, { missions: [], onChanged: noop, onUnauthorized: noop })
  );

  assert.match(html, /2 · Mission anlegen/, "Formular-Überschrift fehlt");
  assert.match(html, /Missions-Typ/);
  assert.match(html, /role="radiogroup"/, "Missions-Typ muss als Radiogruppe gerendert werden");
  assert.match(html, /Einzel-Symbol/);
  assert.match(html, /Markt-Scan \(Segment\)/);
  assert.match(html, /name="scope"/);
  // Default ist Einzel-Symbol → Symbolfeld sichtbar, Segmentfeld nicht:
  assert.match(html, /id="mission-symbol"/);
  assert.equal(/id="mission-segment"/.test(html), false, "Segmentfeld gehört nicht zum Einzel-Symbol-Formular");
  assert.match(html, /id="mission-symbol-tip"/, "Tooltip-Text muss als sr-only im DOM hängen");
});

test("Missionsformular: Tooltip-Texte sind ohne Hover im DOM (Screen Reader)", () => {
  const html = renderToStaticMarkup(
    createElement(MissionsPanel, { missions: [], onChanged: noop, onUnauthorized: noop })
  );
  for (const needle of [
    "Eine Mission ist der Auftrag an die Firma",
    "Maximaler Verlust pro Trade als Anteil des Kapitals",
    "Größter Anteil des Kapitals",
    "aria-describedby",
  ]) {
    assert.ok(html.includes(needle), `Tooltip-/A11y-Inhalt fehlt: ${needle}`);
  }
});

// ── 3) Missionsliste ─────────────────────────────────────────────────────────

test("Missionsliste: Badge zeigt Symbol bzw. „Markt-Scan: <Segment>“", () => {
  const missions: MissionRow[] = [
    row({ id: "m1", title: "Erste Paper-Mission: BTC Long-Only" }),
    row({
      id: "m2",
      title: "Indizes & ETFs: Trendfolge über der 50-Tage-Linie",
      symbol: null,
      scope: "SCAN_UNIVERSE",
      segment: "INDICES",
      templateId: "indices-trend-follow",
      riskBudget: "0.01",
      maxPositionPct: "0.2",
    }),
    row({
      id: "m3",
      title: "⚠️ PENNY-DESK: Spekulative US-Smallcaps < $5 (MINI-RISIKO)",
      symbol: null,
      scope: "SCAN_UNIVERSE",
      segment: "PENNY",
      templateId: "penny-desk-mini",
      riskBudget: "0.005",
      maxPositionPct: "0.05",
    }),
    // Alt-Zeile ohne scope/segment (vor v1.35.0 angelegt):
    row({ id: "m4", title: "Legacy-Mandat", scope: undefined, segment: undefined, templateId: undefined, symbol: "ETH" }),
  ];

  const html = renderToStaticMarkup(
    createElement(MissionsPanel, { missions, onChanged: noop, onUnauthorized: noop })
  );

  assert.match(html, /4 Mandate/, "Anzahl der Missionen fehlt");
  assert.ok(html.includes("BTC"), "Einzel-Symbol-Mission zeigt ihr Symbol");
  assert.ok(html.includes("Markt-Scan: Indizes &amp; ETFs"), "Scan-Mission zeigt ihr Segment");
  assert.ok(html.includes("Markt-Scan: Penny Stocks"), "Penny-Scan zeigt sein Segment");
  assert.ok(html.includes("ETH"), "Alt-Zeile ohne scope wird als Einzel-Symbol angezeigt");
  assert.ok(html.includes("Vorlage indices-trend-follow"), "Herkunftsvorlage wird genannt");
  assert.ok(html.includes("Bearbeiten"), "Bearbeiten-Knopf fehlt");
});

test("Missionsliste: leerer Zustand verweist auf Vorlagen und Seed", () => {
  const html = renderToStaticMarkup(
    createElement(MissionsPanel, { missions: [], onChanged: noop, onUnauthorized: noop })
  );
  assert.match(html, /Noch keine Missionen/);
  assert.match(html, /14 Standard-Missionen/, "Hinweis auf die mitinstallierten Missionen fehlt");
});

// ── 4) Dashboard-Übersicht ───────────────────────────────────────────────────

test("Dashboard: FirmDashboard rendert ohne Firm-Daten (Setup-Zustand) fehlerfrei", () => {
  // Ohne Datenbank liefert /api/firm nichts; der Startbildschirm muss trotzdem
  // rendern — damit ist der Import von missionScopeLabel und die JSX der
  // Missions-Tabelle (Spalte „Symbol / Segment“) abgedeckt.
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.ok(html.length > 1000, "Dashboard sollte Inhalt rendern");
  assert.equal(typeof html, "string");
});

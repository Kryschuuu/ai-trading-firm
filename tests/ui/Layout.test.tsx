/**
 * Layout-Vertrag der Oberfläche (v0.15.0) — Render-Tests ohne Browser.
 *
 * Warum eigene Tests für „nur“ Layout: Die Überarbeitung hat zwei Zusagen,
 * die sich still zurückentwickeln könnten, wenn sie niemand prüft:
 *
 *   1. **Volle Breite** — kein Seitenrahmen begrenzt die Oberfläche mehr auf
 *      `max-w-7xl`; die Hüllen nutzen den fluiden Rand (`PAGE_GUTTER`), und
 *      die Statusleiste wächst bis `3xl` auf sieben Spalten.
 *   2. **Responsive Tabellen** — `DataTable` hält die Tabellensemantik,
 *      bleibt per Tastatur scrollbar (`role="region"`, `tabIndex=0`) und
 *      trägt je Zelle `data-label`, damit die mobile Kartenansicht
 *      (`fs-table-stack` + CSS) beschriftet ist statt nackte Werte zu zeigen.
 *
 * Geprüft wird das gerenderte Markup (`renderToStaticMarkup`) — dieselbe
 * Technik wie in den übrigen UI-Tests: kein Browser, kein Netz, keine DB.
 * Dazu kommt ein Quelltext-Scan, der die Zusage „keine `max-w-7xl`-Hülle“
 * als Regressionsschutz im Repo verankert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import FirmDashboard from "../../src/components/FirmDashboard";
import DataTable from "../../src/components/ui/DataTable";
import MetricTile from "../../src/components/ui/MetricTile";
import Chip from "../../src/components/ui/Chip";
import Button from "../../src/components/ui/Button";
import TabBar, { TabPanel } from "../../src/components/ui/Tabs";
import { PageShell } from "../../src/components/ui/PageShell";
import { PAGE_GUTTER } from "../../src/components/ui/layout";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Alle Dateien unter `src/` (nur die für den Scan relevanten Endungen). */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(rel);
  }
  return out;
}

// ── 1 · Volle Breite ─────────────────────────────────────────────────────────

test("Dashboard-Hülle nutzt die volle Breite (kein max-w-7xl)", () => {
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.match(html, /class="w-full px-3 sm:px-5 lg:px-8 2xl:px-10 3xl:px-12/);
  assert.doesNotMatch(html, /max-w-7xl/);
  assert.doesNotMatch(html, /max-w-6xl|max-w-5xl/);
});

test("PageShell rendert Seitenkopf, Aktionen und fluiden Rand", () => {
  const html = renderToStaticMarkup(
    <PageShell
      eyebrow="Überzeile"
      title="Titel"
      subtitle="Untertitel"
      actions={<button>Aktion</button>}
    >
      <p>Inhalt</p>
    </PageShell>
  );
  assert.match(html, new RegExp(`class="w-full ${PAGE_GUTTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} py-4 sm:py-6"`));
  assert.match(html, /<h1[^>]*>Titel<\/h1>/);
  assert.match(html, /Überzeile/);
  assert.match(html, /Untertitel/);
  assert.match(html, /Inhalt/);
});

test("Statusleiste wächst bis Ultrawide auf sieben Spalten", () => {
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.match(html, /grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 3xl:grid-cols-7/);
  for (const label of [
    "Paper-Equity",
    "Freies Cash",
    "Drawdown",
    "Offene Positionen",
    "Not-Halt",
    "Monitor",
    "Lokales LLM",
  ]) {
    assert.ok(html.includes(label), `Kennzahl fehlt: ${label}`);
  }
});

test("Statusleiste zeigt beim Laden Platzhalter statt irreführender Nullen", () => {
  // Der erste Render (vor `GET /api/firm`) hat keine Zahlen. Würde er `0 $`
  // oder `0 %` zeigen, sähe das wie ein Alarm aus; Label und InfoTip bleiben
  // deshalb stehen, der Wert ist ein pulsierender Balken.
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /animate-pulse/);
  assert.ok(html.includes("Paper-Equity"), "Kennzahl-Label fehlt im Ladezustand");
  assert.doesNotMatch(html, />\$0</, "Ladezustand darf keinen 0-$-Wert zeigen");
});

test("Der aktive Reiter bleibt im Ladezustand verknüpft (kein ins-Leere-zeigendes aria-controls)", () => {
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  const controls = html.match(/aria-controls="(tab-panel-[a-z]+)"/g) ?? [];
  assert.ok(controls.length > 0, "keine Reiter gefunden");
  for (const c of controls) {
    const id = c.match(/"([^"]+)"/)![1];
    // Nur der aktive Reiter hat ein Panel — dieses muss existieren.
    const selected = new RegExp(`id="(tab-[a-z]+)"[^>]*aria-controls="${id}"[^>]*aria-selected="true"`).test(html);
    if (selected) assert.ok(html.includes(`id="${id}"`), `Panel ${id} fehlt zum aktiven Reiter`);
  }
});

test("Keine Seite setzt noch einen zentrierten max-w-Rahmen", () => {
  const violations: string[] = [];
  for (const file of sourceFiles()) {
    const text = read(file);
    text.split("\n").forEach((line, index) => {
      // Nur echte Klassenlisten prüfen — Erklärkommentare, die den alten
      // Zustand dokumentieren, sind kein Verstoß.
      if (!/class(Name)?=/.test(line)) return;
      // `max-w-none`/`max-w-xl` für Textblöcke sind erlaubt; gesucht sind
      // Seitenrahmen: `mx-auto max-w-…` oder ein `max-w-7xl`-Rahmen.
      if (/mx-auto max-w-(\d|xl|screen)/.test(line) || /max-w-7xl/.test(line)) {
        violations.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `zentrierte Seitenrahmen gefunden: ${violations.join(", ")}`);
});

// ── 2 · Reiterleiste ────────────────────────────────────────────────────────

test("Dashboard-Reiter sind eine echte Tablist mit neun Bereichen", () => {
  const html = renderToStaticMarkup(createElement(FirmDashboard));
  assert.match(html, /role="tablist" aria-label="Dashboard-Bereiche"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 9);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /id="tab-overview"[^>]*aria-selected="true"/);
  assert.match(html, /aria-controls="tab-panel-overview"/);
  // Nicht gewählte Reiter sind aus der Tab-Reihenfolge genommen (Roving Tabindex).
  assert.match(html, /id="tab-reports"[^>]*tabindex="-1"/);
  assert.match(html, /sticky top-0/);
});

test("TabBar und TabPanel teilen IDs und Rollen (WAI-ARIA-Muster)", () => {
  const html = renderToStaticMarkup(
    createElement(TabBar<string>, {
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B", badge: 3, title: "zweiter Bereich" },
      ],
      active: "a",
      onChange: () => {},
      ariaLabel: "Testbereiche",
      idPrefix: "x",
    })
  );
  assert.match(html, /role="tablist" aria-label="Testbereiche"/);
  assert.match(html, /id="x-a"[^>]*aria-selected="true"/);
  assert.match(html, /role="tab"[^>]*aria-controls="x-panel-a"/);
  assert.match(html, /title="zweiter Bereich"/);
  assert.match(html, /aria-selected="false"[^>]*>[\s\S]*?3/, "Badge fehlt am Reiter");

  const panel = renderToStaticMarkup(
    <TabPanel id="a" idPrefix="x">
      <p>Inhalt</p>
    </TabPanel>
  );
  assert.match(panel, /id="x-panel-a"[^>]*role="tabpanel"[^>]*aria-labelledby="x-a"[^>]*tabindex="0"/);
});

// ── 3 · DataTable ───────────────────────────────────────────────────────────

test("DataTable hält Tabellensemantik und ist per Tastatur scrollbar", () => {
  const html = renderToStaticMarkup(
    createElement(DataTable, {
      label: "Positionen",
      head: ["Symbol", "PnL"],
      rows: [
        ["BTCUSDT", "12.50"],
        ["ETHUSDT", "−3.00"],
      ],
      align: ["left", "right"],
    })
  );
  assert.match(html, /class="fs-table-scroll"[^>]*role="region"[^>]*aria-label="Positionen"[^>]*tabindex="0"/);
  assert.match(html, /<table class="fs-table w-full text-left text-sm fs-table-stack">/);
  assert.match(html, /<th scope="col" class="px-3 py-2 font-semibold sm:px-4 text-left">Symbol<\/th>/);
  assert.match(html, /<th scope="col" class="px-3 py-2 font-semibold sm:px-4 text-right">PnL<\/th>/);
  // Zwei Zeilen × zwei Zellen mit Spaltenkopf als `data-label` (mobile Karten).
  assert.equal((html.match(/data-label="Symbol"/g) ?? []).length, 2);
  assert.equal((html.match(/data-label="PnL"/g) ?? []).length, 2);
});

test("DataTable ohne `stack` bleibt eine reine Tabelle (breite Matrizen)", () => {
  const html = renderToStaticMarkup(
    createElement(DataTable, {
      label: "Risiko",
      stack: false,
      stickyHead: true,
      maxHeight: "70vh",
      head: ["Limit"],
      rows: [["maxRiskPerTrade"]],
    })
  );
  assert.doesNotMatch(html, /fs-table-stack/);
  assert.match(html, /<thead class="fs-table-sticky">/);
  assert.match(html, /style="max-height:70vh"/);
  assert.doesNotMatch(html, /data-label/);
});

test("DataTable zeigt den Leerzustand statt einer leeren Tabelle", () => {
  const html = renderToStaticMarkup(
    createElement(DataTable, { label: "Positionen", head: ["Symbol"], rows: [], empty: "Keine Positionen." })
  );
  assert.match(html, /Keine Positionen\./);
  assert.doesNotMatch(html, /<table/);
});

// ── 4 · Kennzahl, Chip, Schaltfläche ────────────────────────────────────────

test("MetricTile färbt nach Ton, markiert Alarm und erklärt per InfoTip", () => {
  const good = renderToStaticMarkup(
    createElement(MetricTile, { label: "Equity", value: "$10.000", tone: "good", hint: "Kontostand." })
  );
  assert.match(good, /text-emerald-400[^>]*>\$10\.000/);
  assert.match(good, /aria-label="Hilfe: Equity"/);

  const alarm = renderToStaticMarkup(
    createElement(MetricTile, { label: "Not-Halt", value: "AKTIV", alarm: true })
  );
  assert.match(alarm, /border-red-700 bg-red-950\/40/);
  assert.match(alarm, /text-red-400/);
});

test("Chip trägt Ton, Titel und Text (kein HTML-Inhalt)", () => {
  const html = renderToStaticMarkup(
    <Chip tone="bad" title="Live-Gate gesperrt">
      Live gesperrt
    </Chip>
  );
  assert.match(html, /class="inline-flex[^"]*border-red-700\/60 bg-red-500\/15 text-red-300"/);
  assert.match(html, /title="Live-Gate gesperrt"/);
  assert.match(html, />Live gesperrt</);
});

test("Button kennt vier Rollen, Busy-Zustand und Fokusring", () => {
  const html = renderToStaticMarkup(
    createElement(Button, { variant: "primary", busy: true, onClick: () => {} }, "Pipeline")
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled/);
  assert.match(html, /focus-visible:ring-2 focus-visible:ring-emerald-400/);
  assert.match(html, />Pipeline</);
});

// ── 5 · CSS-Vertrag (Globals) ───────────────────────────────────────────────

test("Globals definieren Ultrawide-Breakpoints, Karten-Stack und Tabellen-Scroll", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /--breakpoint-3xl: 120rem/);
  assert.match(css, /--breakpoint-4xl: 160rem/);
  assert.match(css, /\.fs-table-scroll/);
  assert.match(css, /\.fs-table thead th/);
  assert.match(css, /@media \(max-width: 639\.98px\)/);
  assert.match(css, /\.fs-table-stack tbody td::before\s*\{\s*content: attr\(data-label\)/);
  // Der Druckpfad darf die mobile Kartenansicht nicht mitschleppen.
  assert.match(css, /@media print[\s\S]*fs-table-stack/);
});

test("Kartenraster nutzen die Ultrawide-Stufen 3xl/4xl statt Zwischenwerte", () => {
  // `min-[1900px]` war ein Einzelweg im Doku-Katalog; die Skala gehört ins
  // Theme (`@theme` in globals.css), damit alle Seiten dieselben Stufen nutzen.
  const dashboard = read("src/components/FirmDashboard.tsx");
  assert.match(dashboard, /3xl:grid-cols-7/, "Statusleiste muss bis 3xl wachsen");
  assert.match(dashboard, /3xl:columns-2/, "Guide muss ab 3xl zweispaltig sein");
  const docsIndex = read("src/components/docs/DocsIndex.tsx");
  assert.match(docsIndex, /3xl:grid-cols-4/, "Doku-Katalog muss 3xl nutzen");
  assert.match(docsIndex, /4xl:grid-cols-5/, "Doku-Katalog muss 4xl nutzen");
  for (const file of ["src/components/docs/DocsIndex.tsx", "src/components/docs/DocsView.tsx"]) {
    assert.ok(!read(file).includes("min-[1900px]"), `${file}: Zwischenwert min-[1900px] gefunden`);
    assert.ok(read(file).includes("PAGE_GUTTER"), `${file}: muss den gemeinsamen Seitenrand nutzen`);
  }
});

test("Auto-fit-Raster stehen als vollständige Klassennamen im Quelltext", () => {
  // Tailwind v4 sammelt Kandidaten statisch aus dem Quelltext. Zur Laufzeit
  // zusammengesetzte Klassen landen NICHT im CSS (im Build aufgefallen) —
  // deshalb müssen die Raster-Literale ausgeschrieben bleiben.
  const layout = read("src/components/ui/layout.ts");
  for (const min of ["17rem", "22rem", "30rem"]) {
    assert.ok(
      layout.includes(`[grid-template-columns:repeat(auto-fit,minmax(min(100%,${min}),1fr))]`),
      `Raster-Literal für ${min} fehlt`
    );
  }
  assert.doesNotMatch(layout, /return `grid gap-4 \[grid-template-columns/);
});

/**
 * Render-Tests des Doku-Markdown-Renderers — die echte Komponente, keine
 * Nachbildung. `renderToStaticMarkup` beweist ohne Browser und ohne Netz:
 *
 *   A2  Überschriften bekommen `id`s (rehype-slug ist verdrahtet)
 *   A3  Die IDs sind github-slugger-kompatibel: Umlaute bleiben erhalten,
 *       Satzzeichen erzeugen die erwarteten Doppelschrägungen, Duplikate
 *       bekommen den `-1`-Suffix — sonst springen die ~194 Bestandsanker
 *       der Doku ins Leere.
 *   B1  Relative `.md`-Links landen auf der kanonischen URL aus der
 *       serverseitigen Link-Map.
 *   B7  Ziele außerhalb der Doku werden als nicht klickbarer Code-Text
 *       gerendert — kein toter Link, kein falsches Dokument.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import DocsMarkdown from "../../src/components/docs/DocsMarkdown";

function render(content: string, links?: Record<string, string | null>): string {
  return renderToStaticMarkup(createElement(DocsMarkdown, { content, links }));
}

test("A2 — Überschriften bekommen eine id", () => {
  const html = render("## Ein Kapitel\n\nText.");
  assert.match(html, /<h2 id="ein-kapitel">/, `erwartet id="ein-kapitel" in: ${html}`);
});

test("A3 — Anker-IDs sind github-slugger-kompatibel", () => {
  // Umlaute bleiben erhalten (der alte Nachbau im Validator entfernte sie).
  assert.match(render("## 4. Steuerung über die API"), /<h2 id="4-steuerung-über-die-api">/);
  // Satzzeichen erzeugen die Doppelschrägungen, die GitHub auch erzeugt.
  assert.match(render("## 3. … geführtes Beispiel"), /<h2 id="3--geführtes-beispiel">/);
  assert.match(render("## Sitzung: Start &amp; Stopp"), /<h2 id="sitzung-start--stopp">/);
  assert.match(render("## FAQ — Häufige Fragen (2026-09)"), /<h2 id="faq--häufige-fragen-2026-09">/);
  // Duplikate bekommen den Zähler-Suffix wie auf GitHub.
  const dup = render("## Kapitel\n\n## Kapitel");
  assert.match(dup, /<h2 id="kapitel">/);
  assert.match(dup, /<h2 id="kapitel-1">/);
});

test("B1 — Relative .md-Links werden auf die kanonische URL umgeschrieben", () => {
  const html = render(
    "Siehe [Audit](audits/2026-09-18-feature-gap/README.md#befunde).",
    { "audits/2026-09-18-feature-gap/README.md#befunde": "/docs/audits/2026-09-18-feature-gap/README.md#befunde" },
  );
  assert.match(html, /href="\/docs\/audits\/2026-09-18-feature-gap\/README\.md#befunde"/);
  assert.doesNotMatch(html, /href="audits\//);
});

test("B7 — Ziele außerhalb der Doku werden nicht klickbar gerendert", () => {
  const html = render("Siehe [Schema](../src/db/schema.ts).", { "../src/db/schema.ts": null });
  assert.doesNotMatch(html, /<a [^>]*href="\.\.\/src\/db\/schema\.ts"/);
  assert.doesNotMatch(html, /<a [^>]*>Schema<\/a>/);
  assert.match(html, /<span[^>]*title="[^"]*außerhalb von docs\/[^"]*">Schema<\/span>/);
});

test("Externe Links bleiben Links und gehen in einem neuen Tab auf", () => {
  const html = render("[Handbuch](https://example.com/handbuch)");
  assert.match(html, /href="https:\/\/example\.com\/handbuch"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("Ohne Link-Map bleibt der Link unverändert (kein stiller Bruch)", () => {
  const html = render("[Kapitel](#kapitel)");
  assert.match(html, /href="#kapitel"/);
});

/**
 * Tabellen-Overflow (2026-10-04): Breite Tabellen — z. B. die 11-spaltige
 * Faktorübersicht in `DAILY_WEEKLY_RESEARCH.md` — ragten aus dem Artikel heraus
 * bis unter das Inhaltsverzeichnis bzw. über den Viewport-Rand. Der Renderer
 * setzt deshalb jede Tabelle in einen Scroll-Container (`.docs-table-scroll`);
 * die CSS-Regeln dazu liegen in `src/app/globals.css`.
 */
test("Tabellen sitzen in einem horizontal scrollbaren Container", () => {
  const html = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /class="docs-table-scroll"/, `Scroll-Container fehlt: ${html}`);
  assert.match(html, /role="region"/);
  assert.match(html, /tabindex="0"/, "Container muss per Tastatur scrollbar sein");
  // Die Tabelle selbst bleibt eine echte Tabelle innerhalb des Containers.
  assert.match(html, /<div class="docs-table-scroll"[^>]*>\s*<table>/);
});

test("Der Scroll-Container bekommt den Dokumentpfad als Datenattribut", () => {
  const html = renderToStaticMarkup(
    createElement(DocsMarkdown, { content: "Text", docPath: "/docs/README.md" }),
  );
  assert.match(html, /data-doc="\/docs\/README\.md"/);
});

/**
 * Der mdast-Knoten von react-markdown darf **nicht** im DOM landen.
 *
 * Befund 2026-10-04: `<a node="[object Object]">` bzw. `<table
 * node="[object Object]">` — ungültige DOM-Attribute, die React in der Konsole
 * verwirft und die im serverseitig gerenderten HTML sichtbar waren. Der
 * `node`-Prop wird in den Komponenten explizit verworfen.
 */
test("Kein `node`-Attribut im gerenderten HTML (Links und Tabellen)", () => {
  const html = render("Siehe [Kapitel](#kapitel).\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.doesNotMatch(html, /node="\[object Object\]"/, `node-Prop leckt ins DOM: ${html}`);
  assert.doesNotMatch(html, /\snode=/);
});

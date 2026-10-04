/**
 * Themen-Navigation der Doku (`src/lib/docsNav.ts`) — statisch, ohne DB/Netz.
 *
 * Anlass (2026-10-04): Der Doku-Katalog war eine flache Liste mit ~80
 * Einträgen. Die Übersicht ist jetzt thematisch gruppiert (Suche, Sprungleiste,
 * Abschnitts-Raster, Dateibaum). Eine Gruppierung, die still auseinanderläuft,
 * ist schlimmer als keine: Ein neuer Katalogeintrag ohne Abschnitt würde im
 * „Archiv“ landen und nie auffallen. Deshalb prüft diese Suite:
 *
 *   1. Jeder Katalog-Slug hat einen **expliziten** Abschnitt (kein Fallback).
 *   2. Kein Abschnitt zeigt auf einen unbekannten Slug (keine Leichen).
 *   3. Die Abschnitts-IDs sind eindeutig und in {@link DOCS_SECTIONS} definiert.
 *   4. Der Schnellzugriff zeigt nur auf existierende Katalogeinträge.
 *   5. Jeder Abschnitt ist nicht leer (außer dem bewussten Archiv-Fallback).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DOCS_CATALOG } from "@/lib/docsCatalog";
import {
  DOCS_QUICK_ACCESS,
  DOCS_SECTIONS,
  FALLBACK_SECTION,
  SLUG_SECTION,
  docsSection,
  isDocsSectionId,
  sectionForSlug,
} from "@/lib/docsNav";

const CATALOG_SLUGS = Object.keys(DOCS_CATALOG);
const SECTION_IDS = DOCS_SECTIONS.map((s) => s.id);

test("Jeder Katalog-Slug hat einen expliziten Abschnitt", () => {
  const missing = CATALOG_SLUGS.filter((slug) => !SLUG_SECTION[slug]);
  assert.deepEqual(missing, [], `Slugs ohne Abschnitt: ${missing.join(", ")}`);
});

test("Kein Abschnitt zeigt auf einen unbekannten Slug", () => {
  const known = new Set(CATALOG_SLUGS);
  const orphans = Object.keys(SLUG_SECTION).filter((slug) => !known.has(slug));
  assert.deepEqual(orphans, [], `SLUG_SECTION kennt unbekannte Slugs: ${orphans.join(", ")}`);
});

test("Abschnitts-IDs sind eindeutig, bekannt und beschrieben", () => {
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length, "IDs müssen eindeutig sein");
  for (const section of DOCS_SECTIONS) {
    assert.ok(isDocsSectionId(section.id), `${section.id}: gültige ID`);
    assert.ok(section.label.trim().length > 0, `${section.id}: Label fehlt`);
    assert.ok(section.short.trim().length > 0, `${section.id}: Kurzform fehlt`);
    assert.ok(section.description.trim().length > 0, `${section.id}: Beschreibung fehlt`);
    assert.ok(docsSection(section.id), `${section.id}: docsSection() muss auflösen`);
  }
});

test("Jeder Abschnitt ist besetzt — und der Fallback bleibt sichtbar", () => {
  const counts = new Map(SECTION_IDS.map((id) => [id, 0]));
  for (const slug of CATALOG_SLUGS) counts.set(sectionForSlug(slug), (counts.get(sectionForSlug(slug)) ?? 0) + 1);
  for (const [id, count] of counts) {
    assert.ok(count > 0, `${id}: Abschnitt ist leer`);
  }
  // Ein unbekannter Slug fällt in den dokumentierten Archiv-Abschnitt, nicht auf undefined.
  assert.equal(sectionForSlug("gibt-es-nicht"), FALLBACK_SECTION);
  assert.ok(SECTION_IDS.includes(FALLBACK_SECTION));
});

test("Der Schnellzugriff zeigt auf existierende, nicht-leere Einträge", () => {
  assert.ok(DOCS_QUICK_ACCESS.length >= 3, "mindestens drei Schnellzugriffe");
  assert.equal(new Set(DOCS_QUICK_ACCESS).size, DOCS_QUICK_ACCESS.length, "keine Duplikate");
  for (const slug of DOCS_QUICK_ACCESS) {
    assert.ok(DOCS_CATALOG[slug], `Schnellzugriff ${slug}: Eintrag fehlt`);
    assert.ok(DOCS_CATALOG[slug].title.trim().length > 0, `${slug}: Titel fehlt`);
  }
});

test("Indikator-Dokumente sind auffindbar und gruppiert (Nachtrag 2026-10-04)", () => {
  // Der Auftrag war ausdrücklich: Indikatoren beschreiben und den Claude-
  // Indikator (CTI) mit aufnehmen. Beides muss im Katalog **und** in der
  // Indikator-Gruppe stehen — nicht im Archiv.
  for (const slug of ["indicators", "claudeTradingIndicator", "indicatorRanking"]) {
    assert.ok(DOCS_CATALOG[slug], `${slug}: Katalogeintrag fehlt`);
    assert.equal(sectionForSlug(slug), "indikatoren", `${slug}: muss in der Indikator-Gruppe stehen`);
  }
  // Alle vier Dokumente der Gruppe existieren auf der Platte.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  for (const slug of ["indicators", "claudeTradingIndicator", "indicatorRanking"]) {
    assert.ok(existsSync(DOCS_CATALOG[slug].file), `${slug}: Datei ${DOCS_CATALOG[slug].file} fehlt`);
  }
});

// ── Suche über den Katalog (Client-Filter der Navigation) ──────────────────
test("filterDocs findet über Titel, Untertitel, Pfad und Abschnitt", async () => {
  // Dynamischer Import: die Komponentendatei zieht React/next-link mit — der
  // Rest dieser Suite bleibt bewusst frei davon.
  const { filterDocs } = await import("@/components/docs/DocsNav");
  const sections = DOCS_SECTIONS;
  const items = [
    {
      slug: "claudeTradingIndicator",
      title: "Claude Trading Indicator (CTI)",
      subtitle: "Pine-Script-v6-Portierung",
      path: "/docs/CLAUDE_TRADING_INDICATOR.md",
      section: "indikatoren" as const,
    },
    {
      slug: "backtesting",
      title: "Walk-Forward-Backtesting",
      subtitle: "Zeitmaske, IS/OOS-Fenster",
      path: "/docs/BACKTESTING.md",
      section: "strategie" as const,
    },
  ];

  assert.equal(filterDocs(items, sections as never, "").length, 2, "leere Suche = alles");
  assert.deepEqual(filterDocs(items, sections as never, "claude").map((d) => d.slug), ["claudeTradingIndicator"]);
  assert.deepEqual(filterDocs(items, sections as never, "cti").map((d) => d.slug), ["claudeTradingIndicator"]);
  assert.deepEqual(filterDocs(items, sections as never, "is/oos").map((d) => d.slug), ["backtesting"]);
  assert.deepEqual(filterDocs(items, sections as never, "docs/backtesting").map((d) => d.slug), ["backtesting"]);
  // Mehrere Begriffe wirken als UND-Verknüpfung.
  assert.equal(filterDocs(items, sections as never, "walk zeitmaske").length, 1);
  assert.equal(filterDocs(items, sections as never, "walk claude").length, 0);
});

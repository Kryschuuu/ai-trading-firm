/**
 * Operations Center — Payload-, Aggregations- und Render-Tests (Task 10).
 *
 * Beweist, dass das Operations Center ein vollständiges Cockpit ist:
 *   - zehn Sektionen mit echten Zuständen (kein `stub`),
 *   - fail-soft je Sektion statt 500 für das ganze Cockpit,
 *   - Live-Lock sichtbar, Rolle sichtbar,
 *   - Loading / Error / Empty als eigene Zustände gerendert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OPS_SECTIONS, buildOpsPayload, summarizeSections } from "../src/auth/ops";
import {
  OPS_SECTION_IDS,
  OPS_SECTION_STATUSES,
  isOpsSectionId,
  type OpsSectionData,
  type OpsSectionId,
  type OpsSectionStatus,
} from "../src/ops/types";
import { collectSectionData } from "../src/ops/collect";
import { OperationsCenterView } from "../src/components/ops/OperationsCenterPanel";

function dataOf(id: OpsSectionId, status: OpsSectionStatus, patch: Partial<OpsSectionData> = {}): OpsSectionData {
  return {
    id,
    status,
    asOf: null,
    metrics: [],
    items: [],
    note: null,
    error: null,
    ...patch,
  };
}

const FULL: Record<OpsSectionId, OpsSectionData> = {
  "market-universe": dataOf("market-universe", "ready", {
    asOf: "2026-08-29T00:00:00.000Z",
    metrics: [{ label: "Instrumente", value: "26" }],
    items: [{ label: "PAPER", value: "9" }],
  }),
  scanner: dataOf("scanner", "empty", {
    metrics: [{ label: "Gescannt", value: "26" }],
    note: "Trichter leer: keine Kerzenhistorie.",
  }),
  "portfolio-analytics": dataOf("portfolio-analytics", "unavailable", { error: "Datenbank nicht erreichbar" }),
  "research-operations": dataOf("research-operations", "ready", {
    metrics: [{ label: "Zyklus-Läufe", value: "2" }],
  }),
  "broker-operations": dataOf("broker-operations", "ready", {
    metrics: [{ label: "Venues", value: "7" }],
  }),
  "llm-operations": dataOf("llm-operations", "degraded", {
    metrics: [{ label: "Provider online", value: "0 / 4" }],
  }),
  "agent-operations": dataOf("agent-operations", "ready", {
    metrics: [{ label: "Agenten", value: "6" }],
  }),
  risk: dataOf("risk", "locked", { metrics: [{ label: "Kill-Switch", value: "scharf" }] }),
  audit: dataOf("audit", "ready", { metrics: [{ label: "Ereignisse", value: "120" }] }),
  help: dataOf("help", "ready", { metrics: [{ label: "Hilfe-Dateien", value: "9" }] }),
};

test("Katalog: zehn Sektionen, deckungsgleich mit OPS_SECTION_IDS", () => {
  assert.equal(OPS_SECTIONS.length, 10);
  assert.deepEqual(
    OPS_SECTIONS.map((s) => s.id),
    [...OPS_SECTION_IDS]
  );
  for (const section of OPS_SECTIONS) {
    assert.ok(isOpsSectionId(section.id));
    assert.ok(section.title.length > 0);
    assert.ok(section.summary.length > 0);
    assert.ok(section.sources.length > 0, `${section.id} ohne Quellangabe`);
  }
});

test("Zustandsraum kennt kein `stub` mehr", () => {
  assert.equal(OPS_SECTION_STATUSES.includes("stub" as OpsSectionStatus), false);
  assert.deepEqual([...OPS_SECTION_STATUSES], ["ready", "degraded", "empty", "locked", "unavailable"]);
});

test("buildOpsPayload ohne Daten: zehn Sektionen, jede begründet unavailable", () => {
  const payload = buildOpsPayload(null);
  assert.equal(payload.ok, true);
  assert.equal(payload.sections.length, 10);
  assert.equal(payload.actor, null);
  assert.equal(payload.liveEnabled, false);
  assert.ok(payload.liveLockedReason.length > 0);
  for (const section of payload.sections) {
    assert.equal(section.status, "unavailable");
    assert.ok(section.error && section.error.length > 0);
  }
  assert.deepEqual(payload.health, { total: 10, ready: 0, degraded: 0, empty: 0, locked: 0, unavailable: 10 });
});

test("buildOpsPayload mit Daten: Katalog und Ist-Daten werden zusammengeführt", () => {
  const payload = buildOpsPayload(null, FULL);
  const byId = new Map(payload.sections.map((s) => [s.id, s]));
  const universe = byId.get("market-universe");
  assert.ok(universe);
  assert.equal(universe.status, "ready");
  assert.equal(universe.asOf, "2026-08-29T00:00:00.000Z");
  assert.equal(universe.metrics[0]?.value, "26");
  assert.equal(universe.items[0]?.label, "PAPER");
  assert.equal(universe.sources.length > 0, true); // Kataloganteil bleibt erhalten

  assert.equal(byId.get("scanner")?.status, "empty");
  assert.equal(byId.get("scanner")?.note, "Trichter leer: keine Kerzenhistorie.");
  assert.equal(byId.get("portfolio-analytics")?.error, "Datenbank nicht erreichbar");
  assert.equal(byId.get("risk")?.status, "locked");
  assert.equal(byId.get("llm-operations")?.status, "degraded");

  assert.deepEqual(payload.health, { total: 10, ready: 6, degraded: 1, empty: 1, locked: 1, unavailable: 1 });
});

test("summarizeSections zählt jeden Zustand genau einmal", () => {
  const payload = buildOpsPayload(null, FULL);
  const health = summarizeSections(payload.sections);
  const sum = health.ready + health.degraded + health.empty + health.locked + health.unavailable;
  assert.equal(health.total, payload.sections.length);
  assert.equal(sum, payload.sections.length);
});

test("Kollektoren liefern für alle zehn Sektionen einen gültigen Zustand", async () => {
  const data = await collectSectionData();
  assert.equal(Object.keys(data).length, 10);
  for (const id of OPS_SECTION_IDS) {
    const section = data[id];
    assert.ok(section, `Kollektor für ${id} fehlt`);
    assert.equal(section.id, id);
    assert.ok(OPS_SECTION_STATUSES.includes(section.status), `${id}: ungültiger Status ${section.status}`);
    if (section.status === "unavailable") {
      assert.ok(section.error && section.error.length > 0, `${id}: Fehlerzustand ohne Meldung`);
    } else {
      assert.equal(section.error, null);
      assert.ok(section.metrics.length > 0, `${id}: ohne Kennzahlen`);
    }
    assert.ok(section.items.length <= 8, `${id}: zu viele Detailzeilen`);
  }
});

// ── Rendering ────────────────────────────────────────────────────────────────

test("Render: alle zehn Sektionen mit Werten und Live-Sperre im Markup", () => {
  const payload = buildOpsPayload(null, FULL);
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, { payload, loading: false, error: "" })
  );
  for (const section of payload.sections) {
    assert.ok(html.includes(section.title), `Sektion „${section.title}“ fehlt im Markup`);
  }
  assert.ok(html.includes("Live: gesperrt"));
  assert.ok(html.includes(payload.liveLockedReason));
  assert.ok(html.includes("Sektionen bereit"));
  assert.ok(html.includes("Datenbank nicht erreichbar"), "Fehlermeldung der Sektion fehlt");
  assert.ok(html.includes("Trichter leer"), "Hinweis der Sektion fehlt");
  assert.ok(html.includes("Kill-Switch"), "Kennzahl der Risiko-Sektion fehlt");
});

test("Render: Fehlerzustand ohne Daten zeigt eigene Meldung", () => {
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, {
      payload: null,
      loading: false,
      error: "Operations Center konnte nicht geladen werden. (HTTP 503)",
    })
  );
  assert.ok(html.includes("Operations Center nicht verfügbar."));
  assert.ok(html.includes("HTTP 503"));
});

test("Render: leere Antwort (keine Sektionen) ist ein eigener Zustand", () => {
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, {
      payload: { ...buildOpsPayload(null), sections: [] },
      loading: false,
      error: "",
    })
  );
  assert.ok(html.includes("Keine Sektionen gemeldet"));
});

test("Render: Ladezustand zeigt Skeletons statt alter Werte", () => {
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, { payload: null, loading: true, error: "" })
  );
  assert.ok(html.includes("animate-pulse"));
  assert.ok(!html.includes("Operations Center nicht verfügbar."));
});

test("Render: veraltete Werte bei fehlgeschlagenem Refresh bleiben sichtbar", () => {
  const payload = buildOpsPayload(null, FULL);
  const html = renderToStaticMarkup(
    createElement(OperationsCenterView, { payload, loading: false, error: "Netzwerkfehler" })
  );
  assert.ok(html.includes("Letzte Aktualisierung fehlgeschlagen"));
  assert.ok(html.includes("Market Universe"), "veraltete Werte dürfen nicht verschwinden");
});

/**
 * Tests der Kurven-Zeiträume (`src/lib/equityRange.ts`).
 *
 * Der Anlass: API, Chart-Buttons und Report müssen dieselben Zeiträume kennen.
 * Vorher fiel ein unbekannter `range`-Parameter still auf „week“ zurück, das
 * Chart konnte aber „3 M“ anbieten — die Anzeige log dann über den Zeitraum.
 * Hier ist festgehalten, welche Schreibweisen gültig sind und wo sie starten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EQUITY_RANGES,
  EQUITY_RANGE_LABELS,
  EQUITY_RANGE_TITLES,
  equityRangeStart,
  equityRangeWindowMs,
  isEquityRange,
  normalizeEquityRange,
} from "../src/lib/equityRange";

const NOW = new Date("2026-05-20T09:00:00Z"); // Mittwoch, 11:00 Berlin (CEST)

test("normalizeEquityRange nimmt kanonische IDs und übliche Aliase", () => {
  assert.equal(normalizeEquityRange("day"), "day");
  assert.equal(normalizeEquityRange("quarter"), "quarter");
  assert.equal(normalizeEquityRange("1d"), "day");
  assert.equal(normalizeEquityRange("24h"), "day");
  assert.equal(normalizeEquityRange("7d"), "week");
  assert.equal(normalizeEquityRange("3m"), "quarter");
  assert.equal(normalizeEquityRange("1y"), "year");
  assert.equal(normalizeEquityRange("max"), "all");
  assert.equal(normalizeEquityRange(" 1J "), "year"); // Groß-/Kleinschreibung + Leerraum
});

test("normalizeEquityRange fällt bei Unbekanntem auf week zurück (nie auf „alles“)", () => {
  assert.equal(normalizeEquityRange("gestern"), "week");
  assert.equal(normalizeEquityRange(""), "week");
  assert.equal(normalizeEquityRange(null), "week");
  assert.equal(normalizeEquityRange("<script>"), "week");
});

test("isEquityRange erkennt kanonische IDs und Aliase", () => {
  for (const range of EQUITY_RANGES) assert.equal(isEquityRange(range), true, `${range} muss gültig sein`);
  assert.equal(isEquityRange("1d"), true);
  assert.equal(isEquityRange("nope"), false);
});

test("Jeder Zeitraum hat einen Button-Text und eine Hover-Erklärung", () => {
  for (const range of EQUITY_RANGES) {
    assert.ok(EQUITY_RANGE_LABELS[range]?.length > 0, `Label fehlt für ${range}`);
    assert.ok(EQUITY_RANGE_TITLES[range]?.length > 0, `Tooltip fehlt für ${range}`);
  }
  assert.equal(EQUITY_RANGE_LABELS.all, "Max");
});

test("equityRangeStart liefert Berliner Kalendergrenzen; „all“ hat keinen Anfang", () => {
  assert.equal(equityRangeStart("day", NOW)?.toISOString(), "2026-05-19T22:00:00.000Z");
  assert.equal(equityRangeStart("week", NOW)?.toISOString(), "2026-05-17T22:00:00.000Z"); // Montag
  assert.equal(equityRangeStart("month", NOW)?.toISOString(), "2026-04-30T22:00:00.000Z");
  assert.equal(equityRangeStart("quarter", NOW)?.toISOString(), "2026-03-31T22:00:00.000Z");
  assert.equal(equityRangeStart("halfyear", NOW)?.toISOString(), "2025-12-31T23:00:00.000Z");
  assert.equal(equityRangeStart("year", NOW)?.toISOString(), "2025-12-31T23:00:00.000Z");
  assert.equal(equityRangeStart("all", NOW), null);
});

test("equityRangeWindowMs beschreibt die Fensterbreite (0 = unbekannt bei „all“)", () => {
  assert.equal(equityRangeWindowMs("all", NOW), 0);
  assert.ok(equityRangeWindowMs("year", NOW) > equityRangeWindowMs("month", NOW));
  assert.ok(equityRangeWindowMs("month", NOW) > equityRangeWindowMs("day", NOW));
});

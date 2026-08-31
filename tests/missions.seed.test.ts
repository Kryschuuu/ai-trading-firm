/**
 * Installationszustand der Missionen (v1.35.0).
 *
 * `ensureSeeded()` legt beim ersten Start bzw. bei „Seed / Reset“ die
 * Standard-Mandate an. Seit v1.35.0 stammen sie aus dem Vorlagenkatalog
 * (`seeded: true`) — dieser Test prüft den **tatsächlichen Seed-Inhalt**
 * (`defaultMissions()`), ohne eine Datenbank zu brauchen:
 *
 *   * exakt 14 Missionen,
 *   * Titel eindeutig (daran erkennt der Seed bestehende Installationen),
 *   * jede Zeile würde von der API-Validierung akzeptiert,
 *   * die vier historischen Mandate sind unverändert dabei,
 *   * die im Ticket genannten Aufträge („alle Märkte“, „Penny Stocks“,
 *     „Indizes“) sind als Scan-Missionen vorhanden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultMissions } from "../src/lib/seed";
import { validateMissionInput } from "../src/lib/workshop";
import { MISSION_SEGMENT_IDS, MISSION_SCOPES, seededMissionTemplates } from "../src/lib/missionTemplates";
import { LIMIT_CEILINGS } from "../src/lib/riskGuard";

const LEGACY_TITLES = [
  "Erste Paper-Mission: BTC Long-Only",
  "Beobachtungsmandat: SPY",
  "Swing-Research: Multi-Asset (Tage bis Wochen)",
  "⚠️ PENNY-DESK: Spekulative US-Smallcaps < $5 (MINI-RISIKO)",
];

test("Seed: exakt 14 Missionen, Titel eindeutig, Status PENDING", () => {
  const rows = defaultMissions();
  assert.equal(rows.length, 14, "Installation muss 14 Missionen anlegen");
  assert.equal(rows.length, seededMissionTemplates().length, "Seed und Katalog müssen deckungsgleich sein");

  const titles = rows.map((r) => r.title);
  assert.equal(new Set(titles).size, titles.length, "Titel müssen eindeutig sein (Seed-Idempotenz am Titel)");

  for (const row of rows) {
    assert.equal(row.status, "PENDING", `${row.title}: neue Missionen starten als PENDING`);
    assert.ok((MISSION_SCOPES as readonly string[]).includes(row.scope), `${row.title}: ungültiger Scope ${row.scope}`);
    assert.ok(row.templateId && row.templateId.length > 2, `${row.title}: templateId fehlt`);
  }
});

test("Seed: jede Zeile besteht die API-Validierung", () => {
  for (const row of defaultMissions()) {
    const res = validateMissionInput(row);
    assert.equal(res.ok, true, `${row.title} würde abgelehnt: ${res.ok ? "" : res.error}`);
    if (res.ok) {
      assert.equal(res.value.scope, row.scope);
      assert.equal(res.value.segment, row.segment);
      assert.equal(res.value.symbol, row.symbol);
      assert.equal(res.value.templateId, row.templateId);
      assert.equal(res.warnings.length, 0, `${row.title} erzeugt Warnungen: ${res.warnings.join(" | ")}`);
    }
  }
});

test("Seed: Budgets sind DB-Strings innerhalb der Code-Deckel", () => {
  const [riskMin, riskMax] = LIMIT_CEILINGS.maxRiskPerTrade;
  const [posMin, posMax] = LIMIT_CEILINGS.maxPositionPct;
  for (const row of defaultMissions()) {
    assert.equal(typeof row.riskBudget, "string", "numeric-Spalten werden als String geschrieben");
    assert.equal(typeof row.maxPositionPct, "string");
    const risk = Number(row.riskBudget);
    const pos = Number(row.maxPositionPct);
    assert.ok(risk >= riskMin && risk <= riskMax, `${row.title}: riskBudget ${risk} außerhalb der Deckel`);
    assert.ok(pos >= posMin && pos <= posMax, `${row.title}: maxPositionPct ${pos} außerhalb der Deckel`);
  }
});

test("Seed: historische Mandate bleiben erhalten (kein Duplikat bei Alt-Installationen)", () => {
  const titles = defaultMissions().map((r) => r.title);
  for (const legacy of LEGACY_TITLES) assert.ok(titles.includes(legacy), `Fehlt: ${legacy}`);

  const byTitle = new Map(defaultMissions().map((r) => [r.title, r]));
  assert.equal(byTitle.get(LEGACY_TITLES[0])?.symbol, "BTC");
  assert.equal(byTitle.get(LEGACY_TITLES[1])?.symbol, "SPY");
  // Die beiden Multi-Asset-Mandate sind jetzt echte Scan-Missionen:
  assert.equal(byTitle.get(LEGACY_TITLES[2])?.scope, "SCAN_UNIVERSE");
  assert.equal(byTitle.get(LEGACY_TITLES[2])?.symbol, null);
  assert.equal(byTitle.get(LEGACY_TITLES[3])?.segment, "PENNY");
});

test("Seed: die geforderten Scan-Aufträge sind dabei (alle Märkte, Penny, Indizes)", () => {
  const rows = defaultMissions();
  const scanSegments = rows.filter((r) => r.scope === "SCAN_UNIVERSE").map((r) => r.segment);
  assert.ok(scanSegments.includes("ALL"), "„alle Märkte scannen“ fehlt");
  assert.ok(scanSegments.includes("PENNY"), "„nur Penny Stocks“ fehlt");
  assert.ok(scanSegments.includes("INDICES"), "„nur Indizes“ fehlt");
  assert.ok(scanSegments.includes("CRYPTO"), "Krypto-Scan fehlt");
  assert.ok(scanSegments.includes("EQUITIES"), "Aktien-Scan fehlt");
  assert.ok(scanSegments.includes("FX"), "Devisen-Scan fehlt");
  assert.ok(scanSegments.includes("COMMODITIES"), "Rohstoff-Scan fehlt");
  assert.ok(scanSegments.includes("VOLATILE"), "Volatilitäts-Scan fehlt");
  assert.ok(scanSegments.includes("LIQUID"), "Liquiditäts-Scan fehlt");

  for (const segment of scanSegments) {
    assert.ok(
      (MISSION_SEGMENT_IDS as readonly string[]).includes(String(segment)),
      `Seed nutzt unbekanntes Segment ${String(segment)}`
    );
  }

  // Mindestens eine reine Diagnose-Mission (HOLD-Baseline) für den Workshop:
  assert.ok(
    rows.some((r) => /Baseline/i.test(r.title)),
    "eine HOLD-Baseline gehört zum Standard-Set"
  );
  // Und mindestens eine Einzel-Symbol-Mission zum Einstieg:
  assert.ok(rows.some((r) => r.scope === "SINGLE_SYMBOL" && r.symbol === "BTC"));
});

test("Seed: Risikoreihenfolge ist plausibel (Penny < Krypto/Indizes)", () => {
  const rows = new Map(defaultMissions().map((r) => [String(r.segment ?? r.symbol), r]));
  const penny = Number(rows.get("PENNY")?.riskBudget ?? "0");
  const indices = Number(rows.get("INDICES")?.riskBudget ?? "0");
  const crypto = Number(rows.get("CRYPTO")?.riskBudget ?? "0");
  assert.ok(penny > 0 && indices > 0 && crypto > 0, "Budgets müssen gesetzt sein");
  assert.ok(penny < indices, "Penny-Desk muss kleineres Risiko haben als der Indizes-Scan");
  assert.ok(penny <= crypto, "Penny-Desk muss das kleinste Risiko tragen");
});

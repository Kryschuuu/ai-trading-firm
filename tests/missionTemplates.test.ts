/**
 * Missions-Vorlagen, Marktsegmente und Missions-Typen (v1.35.0).
 *
 * Diese Tests sichern den **Katalog** ab — also genau die Daten, aus denen
 * Workshop-UI, API, Seed und Doku entstehen. Ein Tippfehler in einem Segment
 * oder ein Budget außerhalb der Code-Deckel fällt hier auf, bevor er in einer
 * Installation landet.
 *
 * Kein Netzwerk, keine Datenbank: `src/lib/missionTemplates.ts` ist bewusst
 * nebenwirkungsfrei (dieselbe Regel wie `src/lib/workshop.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MISSION_RISK_PROFILES,
  MISSION_RISK_PROFILE_LABELS,
  MISSION_SCOPES,
  MISSION_SEGMENT_IDS,
  MISSION_SEGMENTS,
  MISSION_TEMPLATE_CATEGORIES,
  MISSION_TEMPLATE_CATEGORY_LABELS,
  MISSION_TEMPLATE_ID_RE,
  MISSION_TEMPLATE_IDS,
  MISSION_TEMPLATES,
  applyMissionTemplate,
  findMissionSegment,
  findMissionTemplate,
  isMissionSegmentId,
  isMissionScope,
  missionScopeLabel,
  missionSegmentDto,
  missionTemplateDto,
  normalizeMissionScope,
  seededMissionTemplates,
  templateToMissionDraft,
  type MissionHelp,
} from "../src/lib/missionTemplates";
import { MISSION_SYMBOLS, validateMissionInput } from "../src/lib/workshop";
import { LIMIT_CEILINGS } from "../src/lib/riskGuard";

/** Pflicht: jede der drei Hilfe-Ebenen trägt mindestens 20 Zeichen. */
function assertHelp(help: MissionHelp, where: string) {
  for (const level of ["kurzinfo", "technischeInfo", "risiko"] as const) {
    const value = help[level];
    assert.equal(typeof value, "string", `${where}: Hilfe-Ebene ${level} fehlt`);
    assert.ok(value.trim().length >= 20, `${where}: Hilfe-Ebene ${level} ist kürzer als 20 Zeichen`);
  }
}

// ── Missions-Typen (Scope) ───────────────────────────────────────────────────

test("Scopes: genau zwei Typen, Normalisierung ist fehlertolerant", () => {
  assert.deepEqual([...MISSION_SCOPES], ["SINGLE_SYMBOL", "SCAN_UNIVERSE"]);
  assert.equal(normalizeMissionScope("scan_universe"), "SCAN_UNIVERSE");
  assert.equal(normalizeMissionScope(" Single_Symbol "), "SINGLE_SYMBOL");
  assert.equal(normalizeMissionScope("QUATSCH"), null);
  assert.equal(normalizeMissionScope(null), null);
  assert.equal(normalizeMissionScope(42), null);
  assert.equal(isMissionScope("SCAN_UNIVERSE"), true);
  assert.equal(isMissionScope("SCAN-UNIVERSE"), false);
});

// ── Marktsegmente ────────────────────────────────────────────────────────────

test("Segmente: IDs eindeutig, Allowlist deckungsgleich, Lookup funktioniert", () => {
  const ids = MISSION_SEGMENTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "Segment-IDs müssen eindeutig sein");
  assert.deepEqual([...ids].sort(), [...MISSION_SEGMENT_IDS].sort(), "Katalog und Allowlist müssen deckungsgleich sein");

  // Die drei im Ticket genannten Fälle müssen existieren:
  assert.ok(findMissionSegment("ALL"), "„alle Märkte“ muss als Segment existieren");
  assert.ok(findMissionSegment("PENNY"), "„nur Penny Stocks“ muss als Segment existieren");
  assert.ok(findMissionSegment("INDICES"), "„nur Indizes“ muss als Segment existieren");

  assert.equal(findMissionSegment("indices")?.label, "Indizes & ETFs", "Lookup ignoriert Groß-/Kleinschreibung");
  assert.equal(findMissionSegment("GIBT_ES_NICHT"), null);
  assert.equal(findMissionSegment(undefined), null);
  assert.equal(isMissionSegmentId("LIQUID"), true);
  assert.equal(isMissionSegmentId("'; DROP TABLE missions;--"), false);
});

test("Segmente: Anlageklassen-Filter sind gültig und Vorschläge innerhalb der Code-Deckel", () => {
  const validClasses = ["crypto", "equity", "etf", "fx", "commodity", "index", "other"];
  const [riskMin, riskMax] = LIMIT_CEILINGS.maxRiskPerTrade;
  const [posMin, posMax] = LIMIT_CEILINGS.maxPositionPct;

  for (const segment of MISSION_SEGMENTS) {
    const classes = segment.universeQuery.assetClass;
    if (classes !== undefined) {
      const list = Array.isArray(classes) ? classes : [classes];
      for (const c of list) assert.ok(validClasses.includes(c), `${segment.id}: unbekannte Anlageklasse ${c}`);
    }
    assert.ok(segment.maxCandidates >= 3 && segment.maxCandidates <= 25, `${segment.id}: maxCandidates unplausibel`);
    assert.ok(
      segment.suggestedRiskBudget >= riskMin && segment.suggestedRiskBudget <= riskMax,
      `${segment.id}: Risiko-Vorschlag außerhalb der LIMIT_CEILINGS`
    );
    assert.ok(
      segment.suggestedMaxPositionPct >= posMin && segment.suggestedMaxPositionPct <= posMax,
      `${segment.id}: Positions-Vorschlag außerhalb der LIMIT_CEILINGS`
    );
    assert.ok(segment.rule.trim().length >= 10, `${segment.id}: Filterregel fehlt`);
    assert.ok(segment.description.trim().length >= 40, `${segment.id}: Beschreibung zu kurz`);
    assertHelp(segment.help, `Segment ${segment.id}`);
  }

  // Das Penny-Segment ist das spekulativste → kleinstes Risikobudget.
  const penny = findMissionSegment("PENNY")!;
  const others = MISSION_SEGMENTS.filter((s) => s.id !== "PENNY");
  for (const o of others) {
    assert.ok(
      penny.suggestedRiskBudget <= o.suggestedRiskBudget,
      `PENNY (${penny.suggestedRiskBudget}) muss das kleinste Risikobudget haben (≥ ${o.id})`
    );
  }
  assert.ok(penny.runtimeFilterNote?.includes("5 USD"), "PENNY muss die Laufzeit-Preisgrenze dokumentieren");
});

test("Segmente: Zusatzfilter arbeiten wie dokumentiert", () => {
  const volatile = findMissionSegment("VOLATILE")!;
  const liquid = findMissionSegment("LIQUID")!;
  const penny = findMissionSegment("PENNY")!;

  const base = {
    id: "PAPER:TEST",
    venue: "ALPACA",
    symbol: "TEST",
    base: null,
    quote: "USD",
    assetClass: "equity" as const,
    marketType: "spot" as const,
    status: "active" as const,
    minQuantity: 1,
    priceStep: 0.01,
    quantityStep: 1,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable: false,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: true,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: "2026-08-31T00:00:00.000Z",
  };

  assert.equal(volatile.filter?.({ ...base, volatility: 0.61 }), true);
  assert.equal(volatile.filter?.({ ...base, volatility: 0.59 }), false);
  assert.equal(volatile.filter?.({ ...base, volatility: null }), false, "ohne Metrik kein Treffer (kein Raten)");

  assert.equal(liquid.universeQuery.minVolume24h, 10_000_000);
  assert.equal(penny.filter?.({ ...base, marketType: "spot", venue: "ALPACA" }), true);
  assert.equal(penny.filter?.({ ...base, marketType: "future", venue: "IBKR" }), false);
});

test("Segmente: DTO ist serialisierbar und enthält die Hilfe-Ebenen", () => {
  const dto = missionSegmentDto(findMissionSegment("INDICES")!);
  const json = JSON.stringify(dto); // darf keine Funktionen enthalten
  assert.equal(JSON.parse(json).id, "INDICES");
  assert.equal(dto.label, "Indizes & ETFs");
  assert.ok(dto.help.kurzinfo.length >= 20);
  assert.equal("universeQuery" in dto, false, "Registry-Query bleibt serverseitig");
  assert.equal("filter" in dto, false, "Filter-Funktionen gehören nicht ins DTO");
});

// ── Vorlagenkatalog ──────────────────────────────────────────────────────────

test("Vorlagen: IDs und Titel eindeutig, Slug-Format stabil", () => {
  const ids = MISSION_TEMPLATES.map((t) => t.id);
  const titles = MISSION_TEMPLATES.map((t) => t.title);
  assert.equal(new Set(ids).size, ids.length, "Vorlagen-IDs müssen eindeutig sein");
  assert.equal(new Set(titles).size, titles.length, "Missions-Titel müssen eindeutig sein (Seed-Idempotenz!)");
  assert.deepEqual([...MISSION_TEMPLATE_IDS], ids, "MISSION_TEMPLATE_IDS muss dem Katalog entsprechen");
  for (const id of ids) assert.match(id, MISSION_TEMPLATE_ID_RE, `Vorlagen-ID ${id} verletzt das Slug-Format`);
});

test("Vorlagen: exakt 14 werden mitinstalliert, die 4 historischen Titel sind dabei", () => {
  const seeded = seededMissionTemplates();
  assert.equal(seeded.length, 14, "Installation muss 14 Missionen anlegen");
  assert.equal(MISSION_TEMPLATES.length, 18, "Katalog: 14 Standard- + 4 Zusatzvorlagen");
  assert.ok(MISSION_TEMPLATES.length > seeded.length, "Zusatzvorlagen dürfen nicht geseedet werden");

  const titles = seeded.map((t) => t.title);
  for (const legacy of [
    "Erste Paper-Mission: BTC Long-Only",
    "Beobachtungsmandat: SPY",
    "Swing-Research: Multi-Asset (Tage bis Wochen)",
    "⚠️ PENNY-DESK: Spekulative US-Smallcaps < $5 (MINI-RISIKO)",
  ]) {
    assert.ok(titles.includes(legacy), `Historischer Titel fehlt: ${legacy} (Seed würde duplizieren)`);
  }

  // Mindestens je ein Auftrag pro im Ticket genanntem Anwendungsfall:
  const scanSegments = new Set(seeded.filter((t) => t.scope === "SCAN_UNIVERSE").map((t) => t.segment));
  assert.ok(scanSegments.has("ALL"), "„alle Märkte scannen“ muss als Standard-Mission existieren");
  assert.ok(scanSegments.has("PENNY"), "„nur Penny Stocks“ muss als Standard-Mission existieren");
  assert.ok(scanSegments.has("INDICES"), "„nur Indizes“ muss als Standard-Mission existieren");
});

test("Vorlagen: Typ, Symbol und Segment passen zusammen", () => {
  for (const t of MISSION_TEMPLATES) {
    if (t.scope === "SINGLE_SYMBOL") {
      assert.equal(t.segment, null, `${t.id}: Einzel-Symbol-Vorlage darf kein Segment haben`);
      assert.ok(t.symbol, `${t.id}: Einzel-Symbol-Vorlage braucht ein Symbol`);
      assert.ok(MISSION_SYMBOLS.includes(t.symbol!), `${t.id}: Symbol ${t.symbol} kennt der Paper-Broker nicht`);
    } else {
      assert.equal(t.symbol, null, `${t.id}: Scan-Vorlage darf kein Einzel-Symbol haben`);
      assert.ok(t.segment, `${t.id}: Scan-Vorlage braucht ein Segment`);
      assert.ok(findMissionSegment(t.segment), `${t.id}: unbekanntes Segment ${t.segment}`);
    }
    assert.ok(
      (MISSION_TEMPLATE_CATEGORIES as readonly string[]).includes(t.category),
      `${t.id}: unbekannte Kategorie ${t.category}`
    );
    assert.ok(
      (MISSION_RISK_PROFILES as readonly string[]).includes(t.riskProfile),
      `${t.id}: unbekanntes Risikoprofil ${t.riskProfile}`
    );
    assert.ok(t.why.trim().length >= 30, `${t.id}: Begründung fehlt`);
    assert.ok(t.successCriteria.trim().length >= 20, `${t.id}: Erfolgskriterium fehlt (Handbuch 5.2)`);
    assertHelp(t.help, `Vorlage ${t.id}`);
  }
});

test("Vorlagen: Budgets liegen innerhalb der Code-Deckel (LIMIT_CEILINGS)", () => {
  const [riskMin, riskMax] = LIMIT_CEILINGS.maxRiskPerTrade;
  const [posMin, posMax] = LIMIT_CEILINGS.maxPositionPct;
  for (const t of MISSION_TEMPLATES) {
    assert.ok(
      t.riskBudget >= riskMin && t.riskBudget <= riskMax,
      `${t.id}: riskBudget ${t.riskBudget} außerhalb [${riskMin}, ${riskMax}]`
    );
    assert.ok(
      t.maxPositionPct >= posMin && t.maxPositionPct <= posMax,
      `${t.id}: maxPositionPct ${t.maxPositionPct} außerhalb [${posMin}, ${posMax}]`
    );
  }
});

test("Vorlagen: jede einzelne wird von validateMissionInput akzeptiert", () => {
  for (const t of MISSION_TEMPLATES) {
    const draft = templateToMissionDraft(t);
    const res = validateMissionInput(draft);
    assert.equal(res.ok, true, `${t.id} muss gültig sein: ${res.ok ? "" : res.error}`);
    if (res.ok) {
      assert.equal(res.value.scope, t.scope);
      assert.equal(res.value.segment, t.segment);
      assert.equal(res.value.symbol, t.symbol);
      assert.equal(res.value.templateId, t.id);
      assert.equal(res.value.status, "PENDING");
      // Scan-Vorlagen nennen Zahlen im Zieltext → keine Vagheits-Warnung.
      assert.equal(res.warnings.length, 0, `${t.id} erzeugt Warnungen: ${res.warnings.join(" | ")}`);
    }
  }
});

test("Vorlagen: Risikoprofile haben Klartext und Hilfe", () => {
  for (const profile of MISSION_RISK_PROFILES) {
    const entry = MISSION_RISK_PROFILE_LABELS[profile];
    assert.ok(entry.label.length >= 3, `${profile}: Label fehlt`);
    assert.ok(entry.hint.length >= 15, `${profile}: Hinweis fehlt`);
    assertHelp(entry.help, `Risikoprofil ${profile}`);
  }
  for (const category of MISSION_TEMPLATE_CATEGORIES) {
    assert.ok(MISSION_TEMPLATE_CATEGORY_LABELS[category].length >= 5, `${category}: Label fehlt`);
  }
});

test("Vorlagen: DTO enthält alles, was das Formular zum Vorausfüllen braucht", () => {
  const dto = missionTemplateDto(findMissionTemplate("scan-all-markets")!);
  const json = JSON.parse(JSON.stringify(dto));
  assert.equal(json.id, "scan-all-markets");
  assert.equal(json.scope, "SCAN_UNIVERSE");
  assert.equal(json.scopeLabel, "Markt-Scan (Segment)");
  assert.equal(json.segment, "ALL");
  assert.equal(json.segmentLabel, "Alle Märkte");
  assert.equal(json.symbol, null);
  assert.equal(json.seeded, true);
  assert.equal(json.riskProfileLabel, "Defensiv");
  assert.ok(json.objective.length > 50);
  assert.ok(json.successCriteria.length > 10);
  assert.ok(json.help.kurzinfo.length >= 20);
});

// ── applyMissionTemplate ─────────────────────────────────────────────────────

test("applyMissionTemplate: füllt leere Felder und lässt eigene Eingaben stehen", () => {
  const filled = applyMissionTemplate({ templateId: "indices-trend-follow" });
  assert.equal(filled.templateId, "indices-trend-follow");
  assert.equal(filled.warnings.length, 0);
  assert.equal(filled.payload.scope, "SCAN_UNIVERSE");
  assert.equal(filled.payload.segment, "INDICES");
  assert.equal(filled.payload.symbol, null);
  assert.equal(filled.payload.riskBudget, 0.01);
  assert.equal(filled.payload.status, "PENDING");
  // Ergebnis ist sofort speicherbar:
  assert.equal(validateMissionInput(filled.payload).ok, true);

  // Bewusste Eingaben gewinnen — die Vorlage überschreibt nichts:
  const custom = applyMissionTemplate({
    templateId: "indices-trend-follow",
    title: "Mein eigener Titel",
    riskBudget: 0.004,
  });
  assert.equal(custom.payload.title, "Mein eigener Titel");
  assert.equal(custom.payload.riskBudget, 0.004);
  assert.equal(custom.payload.objective, findMissionTemplate("indices-trend-follow")!.objective);
});

test("applyMissionTemplate: unbekannte oder fehlende ID ändert nichts", () => {
  const unknown = applyMissionTemplate({ templateId: "gibt-es-nicht", title: "Bleibt" });
  assert.equal(unknown.templateId, null);
  assert.equal(unknown.payload.title, "Bleibt");
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /Unbekannte Vorlage/);

  const without = applyMissionTemplate({ title: "Ohne Vorlage" });
  assert.equal(without.templateId, null);
  assert.equal(without.warnings.length, 0);
  assert.deepEqual(without.payload, { title: "Ohne Vorlage" });

  const garbage = applyMissionTemplate(null);
  assert.equal(garbage.templateId, null);
  assert.deepEqual(garbage.payload, {});
});

// ── Anzeige-Helfer ───────────────────────────────────────────────────────────

test("missionScopeLabel: Symbol, Segment und Legacy-Fälle", () => {
  assert.equal(missionScopeLabel({ scope: "SINGLE_SYMBOL", symbol: "BTC" }), "BTC");
  assert.equal(missionScopeLabel({ symbol: "ETH" }), "ETH", "Alt-Zeilen ohne scope gelten als Einzel-Symbol");
  assert.equal(missionScopeLabel({ scope: "SINGLE_SYMBOL", symbol: null }), "—");
  assert.equal(missionScopeLabel({ scope: "SCAN_UNIVERSE", segment: "INDICES" }), "Markt-Scan: Indizes & ETFs");
  assert.equal(missionScopeLabel({ scope: "SCAN_UNIVERSE", segment: "PENNY" }), "Markt-Scan: Penny Stocks (< 5 USD)");
  assert.equal(missionScopeLabel({ scope: "SCAN_UNIVERSE", segment: "NIX" }), "Markt-Scan: kein Segment");
});

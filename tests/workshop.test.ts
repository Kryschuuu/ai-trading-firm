import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_SYMBOLS,
  isUuid,
  aggregateOutcomes,
  classifyTurnOutcome,
  JSON_DEBUG_TIPS,
  JSON_TIPS_MIN_COUNT,
  JSON_TIPS_MIN_SHARE,
  validateMissionInput,
  validatePromptInput,
  type OutcomeCategory,
} from "../src/lib/workshop";

// ── validateMissionInput: gültige Eingaben ───────────────────────────────────

const validMission = {
  title: "ETH Trendfolge, defensiv",
  objective:
    "Nur Long in ETH und nur bei klarem Aufwärtstrend. Stop-Loss zwischen 4 und 7 Prozent. Bei unklarer Lage HOLD antworten.",
  symbol: "eth",
  riskBudget: 0.01,
  maxPositionPct: 0.15,
};

test("validateMissionInput: normalisiert Symbol und akzeptiert gültige Werte", () => {
  const res = validateMissionInput(validMission);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.symbol, "ETH");
    assert.equal(res.value.status, "PENDING"); // Default
    assert.equal(res.value.title, "ETH Trendfolge, defensiv");
  }
  assert.equal(res.warnings.length, 0);
});

test("validateMissionInput: Zahlen als Strings mit Komma/Punkt (Formular-Form) werden gelesen", () => {
  // Das UI sendet Anteile (0.015 = 1,5 %) — auch als String mit Komma.
  const res = validateMissionInput({ ...validMission, riskBudget: "0,015", maxPositionPct: "0.15" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.riskBudget, 0.015);
    assert.equal(res.value.maxPositionPct, 0.15);
  }
});

test("validateMissionInput: weiche Warnung bei vagen Zielen, aber kein Block", () => {
  const res = validateMissionInput({ ...validMission, objective: "Maximiere den Gewinn mit ETH. Handle clever und schnell." });
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /vage/i);
});

// ── validateMissionInput: Edge Cases / ungültige Eingaben ────────────────────

test("validateMissionInput: leere/fehlende Felder werden abgelehnt", () => {
  assert.equal(validateMissionInput(null).ok, false);
  assert.equal(validateMissionInput(undefined).ok, false);
  assert.equal(validateMissionInput("string").ok, false);
  assert.equal(validateMissionInput({}).ok, false);

  const noTitle = validateMissionInput({ ...validMission, title: "  " });
  assert.equal(noTitle.ok, false);
  if (!noTitle.ok) assert.match(noTitle.error, /Titel/);

  const shortTitle = validateMissionInput({ ...validMission, title: "ab" });
  assert.equal(shortTitle.ok, false);
  if (!shortTitle.ok) assert.match(shortTitle.error, /Titel/);

  const noObjective = validateMissionInput({ ...validMission, objective: "" });
  assert.equal(noObjective.ok, false);
  if (!noObjective.ok) assert.match(noObjective.error, /Ziel/);

  const shortObjective = validateMissionInput({ ...validMission, objective: "zu kurz" });
  assert.equal(shortObjective.ok, false);
});

test("validateMissionInput: nur Paper-Broker-Symbole sind erlaubt (Handbuch 5.3)", () => {
  for (const bad of ["TSLA", "DOGE", 'BTC"; DROP TABLE missions;--', "BTC&x=1", "", null]) {
    const res = validateMissionInput({ ...validMission, symbol: bad });
    assert.equal(res.ok, false, `Symbol ${String(bad)} darf nicht durchgehen`);
    if (!res.ok) assert.match(res.error, /Symbol/);
  }
  for (const good of MISSION_SYMBOLS) {
    const res = validateMissionInput({ ...validMission, symbol: good.toLowerCase() });
    assert.equal(res.ok, true, `Symbol ${good} muss erlaubt sein`);
  }
  assert.ok(MISSION_SYMBOLS.includes("BTC"));
  assert.ok(MISSION_SYMBOLS.includes("MSFT"));
});

test("validateMissionInput: Risikobudget außerhalb der LIMIT_CEILINGS wird abgelehnt", () => {
  // 90 % Risiko (der klassische Halluzinations-Fall) muss hier abgelehnt
  // werden — nicht erst vom Broker.
  const reckless = validateMissionInput({ ...validMission, riskBudget: 0.9 });
  assert.equal(reckless.ok, false);
  if (!reckless.ok) assert.match(reckless.error, /Risikobudget/);

  assert.equal(validateMissionInput({ ...validMission, riskBudget: 0.001 }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, riskBudget: 0 }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, riskBudget: -0.01 }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, riskBudget: "abc" }).ok, false);

  const maxOk = validateMissionInput({ ...validMission, riskBudget: 0.05 });
  assert.equal(maxOk.ok, true, "Obergrenze 5 % muss erlaubt sein");
});

test("validateMissionInput: Positionsgröße außerhalb des Code-Fensters wird abgelehnt", () => {
  const tooBig = validateMissionInput({ ...validMission, maxPositionPct: 0.9 });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.match(tooBig.error, /Positionsgröße/);

  assert.equal(validateMissionInput({ ...validMission, maxPositionPct: 0.005 }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, maxPositionPct: Number.NaN }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, maxPositionPct: 0.5 }).ok, true, "Deckel 50 % muss erlaubt sein");
});

test("validateMissionInput: Status-Allowlist", () => {
  assert.equal(validateMissionInput({ ...validMission, status: "ACTIVE" }).ok, true);
  assert.equal(validateMissionInput({ ...validMission, status: "COMPLETED" }).ok, true);
  assert.equal(validateMissionInput({ ...validMission, status: "KILLED" }).ok, true);
  assert.equal(validateMissionInput({ ...validMission, status: "DROPPED" }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, status: "pending" }).ok, true, "Groß-/Kleinschreibung ist egal");
});

// ── validatePromptInput ──────────────────────────────────────────────────────

const UUID = "9b2f0d5a-1111-4222-8333-444455556666";
const goodPrompt =
  'Du bist Marktanalystin. Antworte AUSSCHLIESSLICH mit diesem JSON:\n{"type":"TRADE","symbol":"ETH","side":"LONG","stopLossPct":5,"reason":"trend intakt","riskScore":0.4}';

test("validatePromptInput: akzeptiert Prompt mit Format-Beispiel ohne Warnung", () => {
  const res = validatePromptInput({ agentId: UUID, systemPrompt: goodPrompt });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.systemPrompt, goodPrompt.trim());
  assert.equal(res.warnings.length, 0);
});

test("validatePromptInput: leere, zu kurze, zu lange und fehlende Eingaben", () => {
  assert.equal(validatePromptInput(null).ok, false);
  assert.equal(validatePromptInput({}).ok, false);
  assert.equal(validatePromptInput({ agentId: UUID, systemPrompt: "" }).ok, false);
  assert.equal(validateMissionInput({ ...validMission, objective: "" }).ok, false);
  const short = validatePromptInput({ agentId: UUID, systemPrompt: "zu kurz" });
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /systemPrompt/);

  const long = validatePromptInput({ agentId: UUID, systemPrompt: "x".repeat(8001) });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /8000/);

  const noAgent = validatePromptInput({ agentId: "", systemPrompt: goodPrompt });
  assert.equal(noAgent.ok, false);
  if (!noAgent.ok) assert.match(noAgent.error, /agentId/);

  const badAgent = validatePromptInput({ agentId: "'; DROP TABLE agents;--", systemPrompt: goodPrompt });
  assert.equal(badAgent.ok, false);
});

test("validatePromptInput: warnt, wenn JSON/Beispiel im Prompt fehlt (blockiert nicht)", () => {
  const proseOnly = validatePromptInput({
    agentId: UUID,
    systemPrompt: "Sei ein guter Analyst und antworte immer höflich und ausführlich.",
  });
  assert.equal(proseOnly.ok, true);
  assert.equal(proseOnly.warnings.length, 2);
  assert.match(proseOnly.warnings.join(" "), /JSON/);
  assert.match(proseOnly.warnings.join(" "), /Beispiel/);
});

// ── classifyTurnOutcome (Trefferquote, Handbuch 6.4) ─────────────────────────

test("classifyTurnOutcome: TRADE, normaler HOLD, REPORT (OTHER)", () => {
  assert.equal(
    classifyTurnOutcome({ ok: true, result: { decision: { type: "TRADE" } } }),
    "TRADE"
  );
  assert.equal(
    classifyTurnOutcome({ ok: true, result: { decision: { type: "HOLD", reason: "Lage unklar, kein Setup" } } }),
    "HOLD"
  );
  assert.equal(
    classifyTurnOutcome({ ok: true, result: { decision: { type: "REPORT" } } }),
    "OTHER"
  );
  assert.equal(
    classifyTurnOutcome({ ok: true, result: { decision: { type: "KILL" } } }),
    "OTHER"
  );
});

test("classifyTurnOutcome: HOLD wegen kaputtem JSON wird erkannt", () => {
  assert.equal(
    classifyTurnOutcome({
      ok: true,
      result: { source: "ollama", decision: { type: "HOLD", reason: "Antwort des Modells war kein gültiges JSON." } },
    }),
    "INVALID_JSON"
  );
  // Fallback-Quelle mit gleicher Begründung zählt genauso:
  assert.equal(
    classifyTurnOutcome({
      ok: true,
      result: { source: "fallback", decision: { type: "HOLD", reason: "Antwort des Modells war kein gültiges JSON." } },
    }),
    "INVALID_JSON"
  );
  // HOLD mit anderer Begründung bleibt normaler HOLD:
  assert.equal(
    classifyTurnOutcome({ ok: true, result: { decision: { type: "HOLD", reason: "RSI überkauft" } } }),
    "HOLD"
  );
});

test("classifyTurnOutcome: API-Fehler und forme lose Antworten → ERROR", () => {
  assert.equal(classifyTurnOutcome({ ok: false, error: "boom" }), "ERROR");
  assert.equal(classifyTurnOutcome({ ok: true, result: {} }), "ERROR");
  assert.equal(classifyTurnOutcome({ ok: true, result: { decision: { type: "WASANDERS" } } }), "ERROR");
});

// ── aggregateOutcomes ────────────────────────────────────────────────────────

test("aggregateOutcomes: zählt, rechnet Prozente und löst Debug-Tipps aus", () => {
  const outcomes: OutcomeCategory[] = [
    "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE",
    "INVALID_JSON", "INVALID_JSON",
  ];
  const stats = aggregateOutcomes(outcomes);
  assert.equal(stats.total, 10);
  assert.equal(stats.counts.TRADE, 8);
  assert.equal(stats.counts.INVALID_JSON, 2);
  assert.equal(stats.pct.TRADE, 80);
  assert.equal(stats.pct.INVALID_JSON, 20);
  assert.equal(stats.showJsonTips, true, "2 Fälle à 20 % müssen die Tipps auslösen");
});

test("aggregateOutcomes: unterhalb der Schwelle keine Tipps, Division durch 0 sicher", () => {
  const one = aggregateOutcomes(["TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "TRADE", "INVALID_JSON"]);
  assert.equal(one.showJsonTips, false, "1 Fall à 10 % löst keine Tipps aus");

  const empty = aggregateOutcomes([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.pct.TRADE, 0);
  assert.equal(empty.showJsonTips, false);
  assert.equal(Object.keys(empty.counts).length, 5);
});

test("aggregateOutcomes: unbekannte Kategorien werden ignoriert (kein Crash)", () => {
  const stats = aggregateOutcomes(["TRADE", "QUATSCH" as OutcomeCategory]);
  assert.equal(stats.total, 2);
  assert.equal(stats.counts.TRADE, 1);
});

test("isUuid: kanonische UUIDs ja, kaputte/Injection-Strings nein", () => {
  assert.equal(isUuid("9b2f0d5a-1111-4222-8333-444455556666"), true);
  assert.equal(isUuid("9B2F0D5A-1111-4222-8333-444455556666"), true);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("abc"), false);
  assert.equal(isUuid("'; DROP TABLE agents;--"), false);
  assert.equal(isUuid("9b2f0d5a-1111-4222-8333-44445555666"), false); // zu kurz
});

test("JSON_DEBUG_TIPS: die vier Handbuch-Tipps sind vollständig", () => {
  assert.equal(JSON_DEBUG_TIPS.length, 4);
  assert.match(JSON_DEBUG_TIPS.join(" "), /Format erzwingen/);
  assert.match(JSON_DEBUG_TIPS.join(" "), /Prompt kürzen/);
  assert.match(JSON_DEBUG_TIPS.join(" "), /Beispiel mitgeben/);
  assert.match(JSON_DEBUG_TIPS.join(" "), /Modell wechseln/);
  assert.equal(JSON_TIPS_MIN_COUNT, 2);
  assert.equal(JSON_TIPS_MIN_SHARE, 0.2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProtocolTurn,
  normalizeProtocolMessage,
  toTurnLogEntry,
  type ProtocolAgentLookup,
} from "../src/lib/protocol";

const agents = new Map<string, ProtocolAgentLookup>([
  ["cassini-id", { id: "cassini-id", name: "Cassini (Macro)", role: "MACRO_ANALYST" }],
  ["hubble-id", { id: "hubble-id", name: "Hubble (News)", role: "NEWS_ANALYST" }],
  ["rhea-id", { id: "rhea-id", name: "Rhea (Research)", role: "RESEARCH" }],
]);

const at = new Date("2026-08-26T07:35:01.000Z");

test("Protokoll: echter Kern-Turn bleibt eine Entscheidung mit sauberem Trace", () => {
  const entry = normalizeProtocolMessage({
    id: "turn-1",
    createdAt: at,
    agentId: "rhea-id",
    missionId: "mission-1",
    type: "REPORT",
    content: "Trend bestätigt.",
    meta: {
      decision: { type: "TRADE", symbol: "BTC", side: "LONG", reason: "Trend bestätigt." },
      source: "ollama",
      model: "qwen",
      latencyMs: 1340,
      prompt: "prompt",
      rawResponse: '{"type":"TRADE"}',
    },
  }, agents);

  assert.equal(entry.kind, "turn");
  if (!isProtocolTurn(entry)) throw new Error("Turn wurde nicht erkannt");
  assert.equal(entry.actor.name, "Rhea (Research)");
  assert.equal(entry.decision.type, "TRADE");
  assert.equal(entry.trace.latencyMs, 1340);

  const legacyTurn = toTurnLogEntry(entry);
  assert.equal(legacyTurn.agent, "Rhea (Research)");
  assert.equal(legacyTurn.source, "ollama");
  assert.equal(legacyTurn.latencyMs, 1340);
});

test("Protokoll: Cassini/Hubble-Analysen werden nie als Entscheidung mit ? gerendert", () => {
  const entry = normalizeProtocolMessage({
    id: "analysis-1",
    createdAt: at,
    agentId: "hubble-id",
    missionId: null,
    type: "ANALYSIS",
    content: "[NEWS] NEUTRAL: Gemischte Schlagzeilen.",
    // Alte Zeile: kein source/model/latencyMs und noch kein verschachteltes analysis-Feld.
    meta: { kind: "ANALYSIS", view: "NEUTRAL", confidence: "0.65", thesis: "Gemischte Schlagzeilen." },
  }, agents);

  assert.equal(entry.kind, "analysis");
  if (entry.kind !== "analysis") throw new Error("Analyse wurde nicht erkannt");
  assert.equal(entry.actor.name, "Hubble (News)");
  assert.equal(entry.actor.role, "NEWS_ANALYST");
  assert.equal(entry.analysis.view, "NEUTRAL");
  assert.equal(entry.analysis.confidence, 0.65);
  assert.equal(entry.analysis.thesis, "Gemischte Schlagzeilen.");
  assert.equal(entry.trace.latencyMs, null, "fehlende Alt-Latenz muss null statt NaN sein");
});

test("Protokoll: Fallback-HOLD eines Analysten bleibt ein Analystenbericht", () => {
  const entry = normalizeProtocolMessage({
    id: "macro-fallback",
    createdAt: at,
    agentId: "cassini-id",
    missionId: null,
    type: "ANALYSIS",
    content: "[MACRO] NEUTRAL: Keine Aktion.",
    meta: {
      kind: "ANALYSIS",
      // Die frühere Regel-Engine antwortet bei Analysten mit einem Decision-Schema.
      type: "HOLD",
      reason: "Keine Aktion für diese Rolle.",
      latencyMs: Number.NaN,
    },
  }, agents);

  assert.equal(entry.kind, "analysis");
  if (entry.kind !== "analysis") throw new Error("Analyse wurde nicht erkannt");
  assert.equal(entry.actor.name, "Cassini (Macro)");
  assert.equal(entry.analysis.view, "NEUTRAL");
  assert.equal(entry.analysis.thesis, "Keine Aktion für diese Rolle.");
  assert.equal(entry.trace.latencyMs, null);
});

test("Protokoll: agentId=null Markt-Scan ist sauber als Systemmeldung attribuiert", () => {
  const entry = normalizeProtocolMessage({
    id: "scan-1",
    createdAt: at,
    agentId: null,
    missionId: null,
    type: "MARKET_SCAN",
    content: "[MARKTSCAN] BTC: Daten vorhanden",
    meta: { source: "monitor" },
  }, agents);

  assert.equal(entry.kind, "system");
  assert.equal(entry.actor.name, "Marktmonitor");
  assert.equal(entry.actor.role, "SYSTEM");
  assert.equal(entry.actor.source, "system");
  assert.equal(entry.trace.latencyMs, null);
});

test("Protokoll: Platzhalter-Actorwerte werden nie als ? ausgegeben", () => {
  const brokenAgents = new Map<string, ProtocolAgentLookup>([
    ["broken", { id: "broken", name: "?", role: "unbekannt" }],
  ]);
  const entry = normalizeProtocolMessage({
    id: "broken-actor",
    createdAt: at,
    agentId: "broken",
    missionId: null,
    type: "ANALYSIS",
    content: "Historischer Bericht",
    meta: { kind: "ANALYSIS" },
  }, brokenAgents);

  assert.equal(entry.actor.name, "Agent");
  assert.equal(entry.actor.role, "AGENT");
});

test("Protokoll: Actor-Snapshot erhält Attribution bei nicht mehr vorhandenem Agenten", () => {
  const entry = normalizeProtocolMessage({
    id: "archived-1",
    createdAt: at,
    agentId: "deleted-agent-id",
    missionId: null,
    type: "ANALYSIS",
    content: "Archivierter Bericht",
    meta: {
      kind: "ANALYSIS",
      actor: { name: "Voyager (Penny Scout)", role: "SCOUT" },
      analysis: { view: "BULLISH", confidence: 1.7, thesis: "Volumen auffällig." },
    },
  }, agents);

  assert.equal(entry.kind, "analysis");
  assert.equal(entry.actor.name, "Voyager (Penny Scout)");
  assert.equal(entry.actor.role, "SCOUT");
  assert.equal(entry.actor.source, "snapshot");
  if (entry.kind === "analysis") assert.equal(entry.analysis.confidence, 1, "Konfidenz wird auf 1 geklemmt");
});

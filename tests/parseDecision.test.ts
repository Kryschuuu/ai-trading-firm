// parseDecision lebt in engine.ts, das eine DATABASE_URL erwartet (Pool-Erzeugung).
// Die Test-Env kommt aus dem npm-Test-Skript (siehe package.json → scripts.test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecision } from "../src/lib/engine";

test("pures JSON wird direkt geparst", () => {
  const d = parseDecision('{"type":"TRADE","symbol":"BTC","side":"LONG","stopLossPct":5,"reason":"x"}');
  assert.equal(d.type, "TRADE");
  assert.equal(d.symbol, "BTC");
});

test("JSON in Code-Fences wird extrahiert", () => {
  const raw = 'Hier meine Analyse:\n```json\n{"type":"HOLD","reason":"unklar"}\n```\nViele Grüße';
  const d = parseDecision(raw);
  assert.equal(d.type, "HOLD");
  assert.equal(d.reason, "unklar");
});

test("Prosa um JSON herum stört nicht", () => {
  const d = parseDecision('Die Entscheidung lautet {"type":"REPORT","reason":"Markt ruhig"} bitte weiter.');
  assert.equal(d.type, "REPORT");
});

test("Müll ohne JSON → HOLD (nie raten)", () => {
  const d = parseDecision("Ich bin mir nicht sicher, aber vielleicht kaufen?");
  assert.equal(d.type, "HOLD");
});

test("unbekannter type mit symbol+side fällt auf TRADE zurück", () => {
  const d = parseDecision('{"type":"BUY_NOW_PLEASE","symbol":"ETH","side":"LONG","reason":"setup"}');
  assert.equal(d.type, "TRADE");
});

test("unbekannter type ohne symbol → HOLD", () => {
  const d = parseDecision('{"type":"Yolo"}');
  assert.equal(d.type, "HOLD");
});

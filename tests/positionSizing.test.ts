/**
 * GAP-04 (v1.48.0, D1) — Vol-basiertes Position-Sizing: Sizing-Mathe,
 * ATR-Fallback-Stop, Fractional-Kelly-Deckel, Clamp an die LIMIT_CEILINGS,
 * UNKNOWN-Pfad bei fehlendem ATR.
 *
 * Rein deterministisch: `computePositionSize()` ist eine reine Funktion;
 * Kelly-Edge wird als Eingabe übergeben (kein I/O).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  computePositionSize,
  DEFAULT_SIZING_CONFIG,
  loadSizingConfig,
  SIZING_CONFIG_BOUNDS,
  type KellyEdge,
  type PositionSizeResult,
} from "../src/lib/positionSizing";
import {
  applyRuntimeLimits,
  resetRuntimeLimits,
  RiskValidationError,
} from "../src/lib/riskGuard";

/** Deterministischer Kelly-Edge (kein I/O). */
function edge(over: Partial<KellyEdge> = {}): KellyEdge {
  return {
    source: "trade_journal",
    trades: 40,
    wins: 24,
    losses: 16,
    winRate: 0.6,
    avgWin: 150,
    avgLoss: 100,
    payoff: 1.5,
    fullKelly: (1.5 * 0.6 - 0.4) / 1.5, // = 1/3
    at: "2026-09-19T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  resetRuntimeLimits();
});

// ── Standardfall (LONG, expliziter Stop) ─────────────────────────────────────

test("Standardfall LONG: qty = Risikobudget/Stop-Abstand", () => {
  // 10.000 € × 1 % Risiko = 100 €; Stop-Abstand 5 (100 → 95) → qty 20,
  // Notional 2.000 € (unter dem 25 %-Cap → kein Clamp).
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    side: "LONG",
  });
  assert.equal(r.stopSource, "EXPLICIT");
  assert.equal(r.stopPrice, 95);
  assert.equal(r.stopDistance, 5);
  assert.equal(r.notional, 2_000);
  assert.equal(r.qty, 20);
  assert.equal(r.unknown, false);
  assert.deepEqual(r.clampedBy, []);
  assert.equal(r.riskPerTrade, 0.01);
  assert.equal(r.capPct, 0.25);
});

test("Short gespiegelt: Stop über dem Entry, gleiche Größe", () => {
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 105,
    side: "SHORT",
  });
  assert.equal(r.stopSource, "EXPLICIT");
  assert.equal(r.stopPrice, 105);
  assert.equal(r.notional, 2_000);
  assert.equal(r.qty, 20);

  // Seitenfalscher Stop (über dem Entry bei LONG) wird verworfen →
  // kein EXPLICIT, sondern Fallback-Pfad.
  const wrong = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 105,
    side: "LONG",
  });
  assert.notEqual(wrong.stopSource, "EXPLICIT");
});

// ── ATR-Fallback-Stop ────────────────────────────────────────────────────────

test("ATR-Fallback-Stop: kein expliziter Stop → k·ATR (Default k=2)", () => {
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    atr: 2, // 2 Preis-Einheiten
    stopLoss: null,
    side: "LONG",
  });
  assert.equal(r.stopSource, "ATR");
  assert.equal(r.atrStopMult, 2);
  assert.equal(r.stopDistance, 4); // 2 × ATR
  assert.equal(r.stopPrice, 96);
  assert.equal(r.notional, 2_500); // 100/4 = 25 → 2.500 €, unter Cap
  assert.equal(r.unknown, false);
});

test("ATR-Fallback-Stop SHORT gespiegelt: Stop über dem Entry", () => {
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    atr: 2,
    side: "SHORT",
  });
  assert.equal(r.stopSource, "ATR");
  assert.equal(r.stopPrice, 104);
});

test("ATR-Multiplikator aus der Konfiguration (Bounds [0.5, 6])", () => {
  // k=6 (Obergrenze): 100 €, Stop-Abstand 6 → 10000*0.01/6*100 = 1.666,67 €
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    atr: 1,
    cfg: { ...DEFAULT_SIZING_CONFIG, atrStopMult: 6 },
  });
  assert.equal(r.stopDistance, 6);
  assert.ok(Math.abs(r.notional - 10_000 * 0.01 * 100 / 6) < 1e-9);

  // Konfig-Clamp: k=100 → 6; k=-3 → 0.5
  const cfg = loadSizingConfig({ RISK_ATR_STOP_MULT: "100" });
  assert.equal(cfg.atrStopMult, SIZING_CONFIG_BOUNDS.atrStopMult[1]);
  const cfg2 = loadSizingConfig({ RISK_ATR_STOP_MULT: "-3" });
  assert.equal(cfg2.atrStopMult, SIZING_CONFIG_BOUNDS.atrStopMult[0]);
  const cfg3 = loadSizingConfig({ RISK_ATR_STOP_MULT: "garbage" });
  assert.equal(cfg3.atrStopMult, DEFAULT_SIZING_CONFIG.atrStopMult);
});

// ── UNKNOWN-Pfad (kein ATR, kein Stop) ───────────────────────────────────────

test("UNKNOWN-Pfad: fehlende ATR + fehlender Stop → Basis-Größe + Kennzeichnung", () => {
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    atr: null,
    stopLoss: null,
    side: "LONG",
  });
  assert.equal(r.stopSource, "FALLBACK");
  assert.equal(r.unknown, true, "muss als UNKNOWN gekennzeichnet sein");
  assert.equal(r.stopDistancePct, 0.05, "Fallback = defaultStopLossPct (5 %)");
  assert.equal(r.stopDistance, 5);
  assert.ok(r.note.includes("UNKNOWN"), "Notiz muss den UNKNOWN-Zustand benennen");

  // NaN-ATR wird wie fehlend behandelt (kein stiller Wert).
  const nan = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    atr: Number.NaN,
  });
  assert.equal(nan.stopSource, "FALLBACK");
  assert.equal(nan.unknown, true);
});

// ── Fractional-Kelly-Deckel ──────────────────────────────────────────────────

test("Kelly-Deckel wirkt nur bei verfügbaren Statistiken", () => {
  const input = {
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    cfg: { ...DEFAULT_SIZING_CONFIG, kellyFraction: 0.5 },
  };

  // 1) Ohne Statistiken (null) → wirkungslos (kein stiller Zwangswert).
  const noStats = computePositionSize({ ...input, kelly: null });
  assert.equal(noStats.kelly.enabled, true);
  assert.equal(noStats.kelly.applied, false);
  assert.equal(noStats.kelly.reason, "no-stats");
  assert.equal(noStats.notional, 2_000);
  assert.deepEqual(noStats.clampedBy, []);

  // 2) Deckel AUS (Fraction 0) → auch mit Statistiken wirkungslos.
  const off = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    kelly: edge(),
    cfg: { ...DEFAULT_SIZING_CONFIG, kellyFraction: 0 },
  });
  assert.equal(off.kelly.reason, "off");
  assert.equal(off.notional, 2_000);

  // 3) Mit Statistiken: Cap = equity·fraction·f* = 10000·0.5·1/3 ≈ 1666,67
  //    < 2.000 → Deckel greift.
  const capped = computePositionSize({ ...input, kelly: edge() });
  assert.equal(capped.kelly.applied, true);
  assert.equal(capped.kelly.reason, "applied");
  assert.ok(Math.abs(capped.notional - (10_000 * 0.5 * 1) / 3) < 1e-9);
  assert.ok(capped.clampedBy.includes("kelly"));

  // 4) Cap über dem Basis-Notional → neutral (keine Reduktion).
  const neutral = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    kelly: edge({ fullKelly: 1.0, payoff: 2, winRate: 0.75 }),
    cfg: { ...DEFAULT_SIZING_CONFIG, kellyFraction: 1 },
  });
  assert.equal(neutral.kelly.reason, "neutral");
  assert.equal(neutral.notional, 2_000);

  // 5) Kein positiver Edge (f* ≤ 0) → Cap 0 → keine Größe.
  const zeroEdge = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    kelly: edge({ winRate: 0.3, payoff: 1, fullKelly: -0.4 }),
    cfg: { ...DEFAULT_SIZING_CONFIG, kellyFraction: 0.5 },
  });
  assert.equal(zeroEdge.kelly.reason, "zero-edge");
  assert.equal(zeroEdge.notional, 0);
  assert.equal(zeroEdge.qty, 0);
  assert.ok(zeroEdge.clampedBy.includes("kelly"));
});

test("Kelly-Fraction wird an Bounds [0, 1] geklemmt", () => {
  const over = loadSizingConfig({ RISK_KELLY_FRACTION: "1.7" });
  assert.equal(over.kellyFraction, 1);
  const under = loadSizingConfig({ RISK_KELLY_FRACTION: "-0.2" });
  assert.equal(under.kellyFraction, 0);
});

// ── Clamp an die bestehenden Grenzen (LIMIT_CEILINGS) ────────────────────────

test("Clamp: maxPositionPct begrenzt das Notional", () => {
  // 10.000 € × 2 % / 5 % Stop-Abstand → 4.000 €; Cap 25 % → 2.500 €.
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.02,
    entryPrice: 100,
    stopLoss: 95,
  });
  assert.equal(r.notional, 2_500);
  assert.deepEqual(r.clampedBy, ["maxPositionPct"]);
});

test("Clamp: Missions-Cap verschärft, lockert nie (Sandbox-Prinzip)", () => {
  const base = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    missionMaxPositionPct: 0.05,
  });
  assert.equal(base.notional, 500, "Missions-Cap 5 % begrenzt auf 500 €");
  assert.deepEqual(base.clampedBy, ["maxPositionPct"]);
  assert.equal(base.capPct, 0.05);

  // Missions-Cap über dem globalen Maximum → globales Maximum gewinnt.
  const wide = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopLoss: 95,
    missionMaxPositionPct: 0.9,
  });
  assert.equal(wide.capPct, 0.25);
  assert.equal(wide.notional, 2_000); // unter 25 % → kein Clamp

  // Laufzeit-Limit 10 % (via applyRuntimeLimits) → Cap 10 %.
  applyRuntimeLimits({ maxPositionPct: 0.1 });
  const runtime = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.02,
    entryPrice: 100,
    stopLoss: 95,
    missionMaxPositionPct: 0.2,
  });
  assert.equal(runtime.capPct, 0.1, "Mission (20 %) darf das Laufzeit-Limit (10 %) nicht überschreiten");
  assert.equal(runtime.notional, 1_000);
  resetRuntimeLimits();
});

test("Clamp: Risikobudget wird auf maxRiskPerTrade geklemmt (nie lockern)", () => {
  // 50 % „Risiko“ aus dem Agenten-Output → wirkt nur die 2 % Basis-Grenze.
  const r = computePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.5,
    entryPrice: 100,
    stopLoss: 95,
  });
  assert.equal(r.riskPerTrade, 0.02);
  assert.equal(r.notional, 2_500); // = 2 % / 5 % Stop, an Cap geklemmt
});

// ── Fail-closed Numerik ──────────────────────────────────────────────────────

test("Fail-closed: Equity/Entry ≤ 0 oder nicht endlich → RiskValidationError", () => {
  assert.throws(
    () => computePositionSize({ equity: 0, riskPerTradePct: 0.01, entryPrice: 100, stopLoss: 95 }),
    RiskValidationError
  );
  assert.throws(
    () => computePositionSize({ equity: 10_000, riskPerTradePct: 0.01, entryPrice: Number.NaN, stopLoss: 95 }),
    RiskValidationError
  );
  assert.throws(
    () => computePositionSize({ equity: -5, riskPerTradePct: 0.01, entryPrice: 100, stopLoss: 95 }),
    RiskValidationError
  );
});

// ── Determinismus ────────────────────────────────────────────────────────────

test("Determinismus: gleiche Eingabe → byte-gleiches Ergebnis", () => {
  const input = {
    equity: 10_000,
    riskPerTradePct: 0.02,
    entryPrice: 67_431.5,
    atr: 812.25,
    stopLoss: null,
    side: "LONG" as const,
    kelly: edge(),
    cfg: { ...DEFAULT_SIZING_CONFIG, kellyFraction: 0.25 },
  };
  const a: PositionSizeResult = computePositionSize(input);
  const b: PositionSizeResult = computePositionSize(input);
  assert.deepEqual(a, b);
  assert.equal(a.stopSource, "ATR");
});

/**
 * Unit-Tests des adaptiven Risk-Limit-Systems (src/lib/adaptiveRisk.ts).
 *
 * Abgedeckt:
 *   - assessRegime(): die komplette Regime-Entscheidungsmatrix (rein)
 *   - RegimeStateMachine(): Hysterese / Anti-Flapping (rein)
 *   - clampVolatilityConfig(): Klemmung der Laufzeit-Konfiguration (rein)
 *   - riskGuard-Kopplung: Faktor senkt maxRiskPerTrade, nie erhöht;
 *     DB-Neuladung rechnet aus dem frischen Basiswert (keine Kumulation)
 *
 * Alle Tests deterministisch, ohne Netzwerk und ohne DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOLATILITY_CONFIG,
  RegimeStateMachine,
  assessRegime,
  clampVolatilityConfig,
  type IndicatorReadings,
  type VolatilityConfig,
} from "../src/lib/adaptiveRisk";
import {
  applyAdaptiveRisk,
  applyRuntimeLimits,
  getAdaptiveRiskState,
  getBaseLimits,
  getLimits,
  resetRuntimeLimits,
  RISK_LIMITS,
} from "../src/lib/riskGuard";

beforeEach(() => {
  resetRuntimeLimits();
  applyAdaptiveRisk(null);
});

const CALM: IndicatorReadings = { vix: 18, atr: 0.004, bbw: 0.02, retStdDev: 0.004 };
const cfg = (over: Partial<VolatilityConfig> = {}): VolatilityConfig => ({
  ...DEFAULT_VOLATILITY_CONFIG,
  ...over,
});

// ── assessRegime: Regime-Matrix ─────────────────────────────────────────────

test("assessRegime: ruhiger Markt → NORMAL, Faktor 1, keine Trigger", () => {
  const r = assessRegime(CALM, cfg());
  assert.equal(r.regime, "NORMAL");
  assert.equal(r.factor, 1);
  assert.deepEqual(r.triggered, []);
  assert.ok(r.indicators.every((i) => i.available && !i.triggered));
});

test("assessRegime: VIX = 30 (Grenze inklusive) → ELEVATED, Faktor 0.5", () => {
  const r = assessRegime({ ...CALM, vix: 30 }, cfg());
  assert.equal(r.regime, "ELEVATED");
  assert.equal(r.factor, 0.5);
  assert.deepEqual(r.triggered, ["VIX"]);
});

test("assessRegime: VIX 31 (primärer Trigger) + ruhiger Korb → ELEVATED", () => {
  const r = assessRegime({ ...CALM, vix: 31 }, cfg());
  assert.equal(r.regime, "ELEVATED");
  assert.equal(r.factor, 0.5);
  assert.ok(r.reason.includes("VIX"));
});

test("assessRegime: VIX 35 + ein Korb-Indikator (ATR) → EXTREME (Belegung)", () => {
  const r = assessRegime({ ...CALM, vix: 35, atr: 0.012 }, cfg());
  assert.equal(r.regime, "EXTREME");
  assert.equal(r.factor, 0.25);
  assert.deepEqual(r.triggered.sort(), ["ATR", "VIX"]);
});

test("assessRegime: VIX 45 (extrem) + ruhiger Korb → direkt EXTREME", () => {
  const r = assessRegime({ ...CALM, vix: 45 }, cfg());
  assert.equal(r.regime, "EXTREME");
  assert.equal(r.factor, 0.25);
});

test("assessRegime: ohne VIX — zwei Korb-Indikatoren (ATR+BBW) → ELEVATED", () => {
  const r = assessRegime({ vix: 25, atr: 0.012, bbw: 0.06, retStdDev: 0.004 }, cfg());
  assert.equal(r.regime, "ELEVATED");
  assert.equal(r.factor, 0.5);
});

test("assessRegime: alle drei Korb-Indikatoren → EXTREME (auch ohne VIX)", () => {
  const r = assessRegime({ vix: 25, atr: 0.012, bbw: 0.06, retStdDev: 0.02 }, cfg());
  assert.equal(r.regime, "EXTREME");
  assert.equal(r.factor, 0.25);
  assert.deepEqual(r.triggered.sort(), ["ATR", "BBW", "RET_STDDEV"]);
});

test("assessRegime: Schwellwert-Grenze ist inklusive (≥ triggert)", () => {
  const r = assessRegime({ vix: null, atr: 0.01, bbw: 0.05, retStdDev: 0.01 }, cfg());
  assert.equal(r.regime, "EXTREME", "alle drei exakt auf der Schwelle → alle triggern");
});

// ── assessRegime: Edge Cases (fehlende/kaputte Daten) ────────────────────────

test("assessRegime: ALLE Quellen ohne Daten → Kern-Bewertung NORMAL, Orchestrator wertet als UNKNOWN", () => {
  const r = assessRegime({ vix: null, atr: null, bbw: null, retStdDev: null }, cfg());
  assert.equal(r.regime, "NORMAL");
  assert.equal(r.factor, 1);
  assert.ok(r.indicators.every((i) => !i.available && !i.triggered));
  // Kein „Fail-Open, Basis-Limit bleibt aktiv“ mehr — die reine Matrix ist
  // neutrale Datenbasis, der UNKNOWN-Fallback passiert in updateAdaptiveRisk.
  assert.match(r.reason, /nicht bewertbar|UNKNOWN/);
});

test("assessRegime: NaN / negative / Infinity-Werte gelten als keine Daten", () => {
  const r = assessRegime(
    { vix: Number.NaN, atr: -0.05, bbw: Number.POSITIVE_INFINITY, retStdDev: undefined as unknown as number },
    cfg()
  );
  assert.equal(r.regime, "NORMAL");
  assert.ok(r.indicators.every((i) => !i.available));
});

test("assessRegime: fehlende VIX allein lässt ruhigen Markt NORMAL", () => {
  const r = assessRegime({ ...CALM, vix: null }, cfg());
  assert.equal(r.regime, "NORMAL");
});

test("assessRegime: deaktiviertes System (enabled=false) bleibt immer NORMAL", () => {
  const c = cfg({ enabled: false });
  assert.equal(assessRegime({ vix: 99, atr: 0.2, bbw: 0.5, retStdDev: 0.2 }, c).regime, "NORMAL");
  assert.equal(assessRegime(CALM, c).factor, 1);
  assert.match(assessRegime(CALM, c).reason, /deaktiviert/);
});

test("assessRegime: Misskonfiguration vixExtreme < vixHigh bleibt monotone", () => {
  const c = cfg({ vixHigh: 30, vixExtreme: 20 });
  // Nur VIX-Hoch ohne Korbbestätigung → ELEVATED, nicht EXTREME.
  assert.equal(assessRegime({ ...CALM, vix: 35 }, c).regime, "ELEVATED");
  // Mit Korbbestätigung trotzdem EXTREME.
  assert.equal(assessRegime({ ...CALM, vix: 35, atr: 0.012 }, c).regime, "EXTREME");
});

test("assessRegime: Faktoren aus der Konfiguration fließen ein", () => {
  const c = cfg({ elevatedFactor: 0.4, extremeFactor: 0.1 });
  assert.equal(assessRegime({ ...CALM, vix: 31 }, c).factor, 0.4);
  assert.equal(assessRegime({ ...CALM, vix: 45 }, c).factor, 0.1);
});

// ── clampVolatilityConfig ────────────────────────────────────────────────────

test("clamp: Werte außerhalb des Fensters werden geklemmt", () => {
  const c = clampVolatilityConfig({
    vixHigh: 500,
    vixExtreme: 1,
    atrHigh: 0,
    elevatedFactor: 2,
    extremeFactor: 0.001,
    deescalateAfter: 99,
    enabled: 0,
  });
  assert.equal(c.vixHigh, 80);
  assert.equal(c.vixExtreme, 5);
  assert.equal(c.atrHigh, 0.0005);
  assert.equal(c.elevatedFactor, 1, "Faktor > 1 ist verboten → 1");
  assert.equal(c.extremeFactor, 0.02);
  assert.equal(c.deescalateAfter, 10);
  assert.equal(c.enabled, false);
});

test("clamp: ungültige Zahlen behalten den Basiswert (Fail-Safe)", () => {
  const c = clampVolatilityConfig({ vixHigh: Number.NaN, elevatedFactor: Number.POSITIVE_INFINITY } as never, cfg({ vixHigh: 33 }));
  assert.equal(c.vixHigh, 33);
  assert.equal(c.elevatedFactor, 0.5);
});

test("clamp: deescalateAfter wird auf Ganzzahl gerundet", () => {
  assert.equal(clampVolatilityConfig({ deescalateAfter: 3.6 }).deescalateAfter, 4);
  assert.equal(clampVolatilityConfig({ deescalateAfter: 2.2 }).deescalateAfter, 2);
});

// ── RegimeStateMachine: Hysterese / Anti-Flapping ───────────────────────────

test("StateMachine: Eskalation ist sofort (beide Stufen)", () => {
  const m = new RegimeStateMachine();
  assert.equal(m.update("ELEVATED", 3).changed, true);
  assert.equal(m.update("EXTREME", 3).changed, true);
  assert.equal(m.regime, "EXTREME");
});

test("StateMachine: De-Eskalation braucht N konsekutive ruhige Bewertungen", () => {
  const m = new RegimeStateMachine();
  m.update("ELEVATED", 3);
  m.update("EXTREME", 3);
  assert.equal(m.update("NORMAL", 3).changed, false, "Streak 1 < 3 → bleibt");
  assert.equal(m.update("NORMAL", 3).changed, false, "Streak 2 < 3 → bleibt");
  assert.equal(m.update("NORMAL", 3).changed, true, "Streak 3 = 3 → De-Eskalation");
  assert.equal(m.regime, "NORMAL");
});

test("StateMachine: Zwischenstufenzustand (EXTREME→ELEVATED) zählt mit", () => {
  const m = new RegimeStateMachine();
  m.update("ELEVATED", 2);
  m.update("EXTREME", 2);
  assert.equal(m.update("ELEVATED", 2).changed, false, "Streak 1");
  assert.equal(m.update("ELEVATED", 2).changed, true, "Streak 2 → ELEVATED");
  assert.equal(m.regime, "ELEVATED");
});

test("StateMachine: erneute Eskalation bricht die ruhige Streak ab (kein Flapping)", () => {
  const m = new RegimeStateMachine();
  m.update("ELEVATED", 2);
  m.update("NORMAL", 2); // De-Eskalations-Streak 1
  const back = m.update("ELEVATED", 2); // Kandidat == aktuell → Streak wird abgebrochen
  assert.equal(back.changed, false, "Regime war schon ELEVATED — kein Change");
  assert.equal(m.regime, "ELEVATED");
  assert.equal(m.streak, 0, "Streak muss zurückgesetzt sein");
  m.update("NORMAL", 2); // zählt von vorn: Streak 1
  assert.equal(m.update("NORMAL", 2).changed, true, "erst ab Streak 2 de-eskalieren");
  assert.equal(m.regime, "NORMAL");
});

test("StateMachine: gleiche Kandidaten halten das Regime ohne De-Eskalation", () => {
  const m = new RegimeStateMachine();
  m.update("ELEVATED", 2);
  for (let i = 0; i < 5; i++) assert.equal(m.update("ELEVATED", 2).changed, false);
  assert.equal(m.regime, "ELEVATED");
});

test("StateMachine: deescalateAfter=1 → sofortige De-Eskalation", () => {
  const m = new RegimeStateMachine();
  m.update("EXTREME", 1);
  assert.equal(m.update("NORMAL", 1).changed, true);
  assert.equal(m.regime, "NORMAL");
});

test("StateMachine: kaputter deescalateAfter-Wert fällt auf Minimum 1", () => {
  const m = new RegimeStateMachine();
  m.update("ELEVATED", Number.NaN);
  assert.equal(m.update("NORMAL", Number.NaN).changed, true, "NaN → need=1 → sofort");
});

// ── Kopplung an riskGuard: Faktor wirkt nur senkend ─────────────────────────

test("riskGuard: ELEVATED-Faktor halbiert maxRiskPerTrade (0.02 → 0.01)", () => {
  const before = getLimits().maxRiskPerTrade;
  assert.equal(before, 0.02);
  applyAdaptiveRisk({ regime: "ELEVATED", factor: 0.5, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.01);
  assert.equal(getBaseLimits().maxRiskPerTrade, 0.02, "Basis-Limit bleibt konfiguriert");
  assert.equal(RISK_LIMITS.maxRiskPerTrade, 0.01, "Proxy liest wirksamen Wert");
});

test("riskGuard: EXTREME-Faktor viertelt (0.02 → 0.005)", () => {
  applyAdaptiveRisk({ regime: "EXTREME", factor: 0.25, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.005);
});

test("riskGuard: Faktor > 1 wird geklemmt — Risiko kann nie steigen", () => {
  applyAdaptiveRisk({ regime: "NORMAL", factor: 5, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.02);
  assert.equal(getAdaptiveRiskState()?.factor, 1);
});

test("riskGuard: null hebt die Reduktion vollständig auf", () => {
  applyAdaptiveRisk({ regime: "EXTREME", factor: 0.25, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.005);
  applyAdaptiveRisk(null);
  assert.equal(getLimits().maxRiskPerTrade, 0.02);
  assert.equal(getAdaptiveRiskState(), null);
});

test("riskGuard: Reduktion bleibt über DB-Neuladung UND mit neuem Basiswert (keine Kumulation)", () => {
  applyAdaptiveRisk({ regime: "ELEVATED", factor: 0.5, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.01);

  // DB-Dashboard setzt Basis auf 0.04 → wirksam 0.02 (neue Basis × Faktor).
  applyRuntimeLimits({ maxRiskPerTrade: 0.04 });
  assert.equal(getBaseLimits().maxRiskPerTrade, 0.04);
  assert.equal(getLimits().maxRiskPerTrade, 0.02, "0.04 × 0.5 — NICHT 0.01 × 0.5");

  // Zurück auf Default → wirksam 0.01.
  resetRuntimeLimits();
  assert.equal(getLimits().maxRiskPerTrade, 0.01, "Reduktion überlebt resetRuntimeLimits");
});

test("riskGuard: wirksames Limit bleibt über dem absoluten Code-Minimum", () => {
  // Basis am Code-Minimum 0.002, Faktor 0.25 → 0.0005 würde den Boden brechen.
  applyRuntimeLimits({ maxRiskPerTrade: 0.002 });
  applyAdaptiveRisk({ regime: "EXTREME", factor: 0.25, reason: "t", at: "t", indicators: {} });
  assert.equal(getLimits().maxRiskPerTrade, 0.002, "LIMIT_CEILINGS-Boden (0.002) gewinnt");
});

test("riskGuard: PERSISTED-Zustand (Micro-Prozess) wendet nur den Faktor an", () => {
  applyAdaptiveRisk({
    regime: "PERSISTED",
    factor: 0.5,
    reason: "persistiert",
    at: new Date().toISOString(),
    indicators: {},
  });
  assert.equal(getLimits().maxRiskPerTrade, 0.01);
});

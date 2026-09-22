/**
 * Tests: Risk-Guard-Composition des Drawdown-Risk-Scalings (RMA-P5-04, v1.68.0).
 *
 * Kaskade: Code-Ceilings → Basis-Limit → Regime-Faktor × VolTarget-Faktor
 *           × Drawdown-Faktor → Code-Boden; PAUSE blockiert neue Einstiege.
 *
 * Pflicht-Prüfungen:
 *   - Monitor-only (null-Zustand) ändert die Limits NICHTS
 *   - Der kombinierte Faktor überschreitet Basis-Limit und Code-Ceilings NIE
 *   - Alle Faktoren ≤ 1 ⇒ Produkt ≤ 1 (multiplikativ, nur senkend)
 *   - Boden = LIMIT_CEILINGS.maxRiskPerTrade[0] (nie darunter)
 *   - Keine Kumulation bei Neuladung (immer aus dem frischen Basiswert)
 *   - ungültige Faktoren (NaN/0/negativ) werden verworfen (fail-closed)
 *   - PAUSE blockiert neue Einstiege vollständig; ein Widerspruch
 *     (paused ohne PAUSE-Stufe) blockiert nie
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  applyAdaptiveRisk,
  applyDrawdownScaling,
  applyRuntimeLimits,
  applyVolatilityTargeting,
  drawdownPauseState,
  getBaseLimits,
  getDrawdownScalingState,
  getLimits,
  LIMIT_CEILINGS,
  validateOrder,
  type AdaptiveRiskState,
  type DrawdownRiskState,
  type VolatilityTargetingState,
} from "../src/lib/riskGuard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

const BASE_RISK = 0.02; // DEFAULT_LIMITS.maxRiskPerTrade
const FLOOR = LIMIT_CEILINGS.maxRiskPerTrade[0]; // 0.002
const POLICY = "ddp1:" + "0".repeat(64);

function adaptive(factor: number): AdaptiveRiskState {
  return {
    regime: "NORMAL",
    factor,
    reason: "test",
    at: new Date().toISOString(),
    indicators: {},
  };
}

function volTarget(factor: number, mode: "active" | "persisted" = "active"): VolatilityTargetingState {
  return {
    factor,
    at: new Date().toISOString(),
    asOf: new Date().toISOString(),
    reason: "test",
    mode,
  };
}

function drawdown(
  factor: number,
  overrides: Partial<DrawdownRiskState> = {}
): DrawdownRiskState {
  return {
    factor,
    stage: "SOFT",
    paused: false,
    drawdownPct: 0.06,
    hwm: 10_000,
    at: new Date().toISOString(),
    asOf: new Date().toISOString(),
    reason: "test",
    mode: "active",
    policyVersion: POLICY,
    ...overrides,
  };
}

beforeEach(() => {
  __resetAllSingletonsForTests();
});

afterEach(() => {
  __resetAllSingletonsForTests();
});

describe("Monitor-only: keine Wirkung auf die Limits", () => {
  test("null-Zustand ⇒ currentLimits = baseLimits (unverändert)", () => {
    assert.equal(getDrawdownScalingState(), null);
    applyDrawdownScaling(null);
    assert.deepEqual(getLimits(), getBaseLimits(), "Monitor-only darf nichts ändern");
    assert.equal(drawdownPauseState().blocked, false);
  });
});

describe("Faktorwirkung (nur senkend)", () => {
  test("Faktor 0.5 ⇒ maxRiskPerTrade halbiert", () => {
    applyDrawdownScaling(drawdown(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.5) < 1e-15);
    assert.ok(getLimits().maxRiskPerTrade < getBaseLimits().maxRiskPerTrade);
  });

  test("Faktor = 1 ⇒ neutral (keine Änderung)", () => {
    applyDrawdownScaling(drawdown(1, { stage: "NORMAL", drawdownPct: 0.01 }));
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
  });

  test("null hebt eine zuvor gesetzte Reduktion auf (Rollback/Monitor-Pfad)", () => {
    applyDrawdownScaling(drawdown(0.5));
    assert.ok(getLimits().maxRiskPerTrade < BASE_RISK);
    applyDrawdownScaling(null);
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK, "Rollback-Pfad: zurück auf Basis");
    assert.equal(getDrawdownScalingState(), null);
  });

  test("ungültiger Faktor (NaN/0/negativ/∞) wird ignoriert (fail-closed, nie risikosteigernd)", () => {
    for (const bad of [Number.NaN, 0, -0.5, Number.NEGATIVE_INFINITY]) {
      applyDrawdownScaling(drawdown(bad));
      assert.equal(getDrawdownScalingState(), null, `Faktor ${bad} muss verworfen werden`);
      assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
    }
  });

  test("Faktor > 1 wird auf 1 geklemmt (keine risikosteigernde Wirkung)", () => {
    applyDrawdownScaling(drawdown(2.5));
    assert.equal(getDrawdownScalingState()!.factor, 1);
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
  });

  test("persisted-Modus (Mikro-Executor-Sicht) wirkt wie active", () => {
    applyDrawdownScaling(drawdown(0.6, { mode: "persisted" }));
    assert.equal(getDrawdownScalingState()!.mode, "persisted");
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.6) < 1e-15);
  });
});

describe("Multiplikative Komposition (Regime × VolTarget × Drawdown)", () => {
  test("drei Faktoren stacken: 0.5 × 0.5 × 0.5 = 0.125", () => {
    applyAdaptiveRisk(adaptive(0.5));
    applyVolatilityTargeting(volTarget(0.5));
    applyDrawdownScaling(drawdown(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.125) < 1e-15);
  });

  test("kombiniert ≤ jeder Einzel-Faktor und ≤ Basis-Limit", () => {
    applyAdaptiveRisk(adaptive(0.5));
    const adaptiveOnly = getLimits().maxRiskPerTrade;
    applyVolatilityTargeting(volTarget(0.5));
    const twoFactors = getLimits().maxRiskPerTrade;
    applyDrawdownScaling(drawdown(0.5));
    const threeFactors = getLimits().maxRiskPerTrade;
    assert.ok(twoFactors <= adaptiveOnly + 1e-15);
    assert.ok(threeFactors <= twoFactors + 1e-15, "jede weitere Stufe senkt nur");
    assert.ok(threeFactors <= getBaseLimits().maxRiskPerTrade, "nie über das Basis-Limit");
  });

  test("Kombination ist symmetrisch (Reihenfolge irrelevant)", () => {
    applyAdaptiveRisk(adaptive(0.3));
    applyVolatilityTargeting(volTarget(0.7));
    applyDrawdownScaling(drawdown(0.9));
    const abc = getLimits().maxRiskPerTrade;

    __resetAllSingletonsForTests();
    applyDrawdownScaling(drawdown(0.9));
    applyVolatilityTargeting(volTarget(0.7));
    applyAdaptiveRisk(adaptive(0.3));
    const cba = getLimits().maxRiskPerTrade;
    assert.ok(Math.abs(abc - cba) < 1e-15);
  });

  test("Ceiling: kein Zustand kann die Code-Obergrenze überschreiten", () => {
    applyAdaptiveRisk(adaptive(1));
    applyVolatilityTargeting(volTarget(1));
    applyDrawdownScaling(drawdown(1));
    assert.ok(getLimits().maxRiskPerTrade <= LIMIT_CEILINGS.maxRiskPerTrade[1]);
    assert.ok(getLimits().maxRiskPerTrade <= getBaseLimits().maxRiskPerTrade);

    // Höheres Basis-Limit (DB) bleibt innerhalb der Ceilings, und die
    // Drawdown-Reduktion wirkt relativ dazu.
    applyRuntimeLimits({ maxRiskPerTrade: 0.05 });
    applyDrawdownScaling(drawdown(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - 0.025) < 1e-15);
    assert.ok(getLimits().maxRiskPerTrade <= LIMIT_CEILINGS.maxRiskPerTrade[1]);
  });

  test("Boden: extreme Kombination bleibt ≥ LIMIT_CEILINGS.maxRiskPerTrade[0]", () => {
    applyAdaptiveRisk(adaptive(0.25));
    applyVolatilityTargeting(volTarget(0.25));
    applyDrawdownScaling(drawdown(0.25)); // 0.02 × 0.015625 = 0.0003125 < 0.002
    assert.ok(getLimits().maxRiskPerTrade >= FLOOR, `Boden ${FLOOR} nicht unterschritten`);
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - FLOOR) < 1e-15, "exakt auf dem Boden");
  });
});

describe("Keine Kumulation", () => {
  test("neuer Faktor rechnet aus dem FRISCHEN Basiswert (nicht aus dem reduzierten)", () => {
    applyDrawdownScaling(drawdown(0.5)); // 0.02 → 0.01
    applyDrawdownScaling(drawdown(0.75)); // 0.02 × 0.75 = 0.015 (NICHT 0.01 × 0.75)
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.75) < 1e-15);
  });

  test("DB-Neuladung (applyRuntimeLimits) kumuliert nicht", () => {
    applyDrawdownScaling(drawdown(0.5));
    applyRuntimeLimits({ maxRiskPerTrade: 0.04 });
    assert.ok(
      Math.abs(getLimits().maxRiskPerTrade - 0.04 * 0.5) < 1e-15,
      "aus dem frischen Basiswert 0.04, nicht aus 0.02×0.5"
    );
  });
});

describe("PAUSE-Veto (Authority Chain)", () => {
  test("paused in PAUSE-Stufe blockiert validateOrder", () => {
    applyDrawdownScaling(drawdown(0.25, { stage: "PAUSE", paused: true, drawdownPct: 0.18 }));
    assert.equal(drawdownPauseState().blocked, true);
    assert.equal(drawdownPauseState().stage, "PAUSE");

    const result = validateOrder({
      symbol: "TEST",
      notional: 100,
      equity: 10_000,
      leverage: 1,
      side: "LONG",
      hasStopLoss: true,
      openPositions: 0,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.blockedBy.includes("drawdown-pause:new-entries-blocked"));
  });

  test("Blockaufhebung gibt neue Einstiege wieder frei", () => {
    applyDrawdownScaling(drawdown(0.25, { stage: "PAUSE", paused: true }));
    assert.equal(drawdownPauseState().blocked, true);
    applyDrawdownScaling(drawdown(0.5, { stage: "SOFT" }));
    assert.equal(drawdownPauseState().blocked, false);
    const result = validateOrder({
      symbol: "TEST",
      notional: 100,
      equity: 10_000,
      leverage: 1,
      side: "LONG",
      hasStopLoss: true,
      openPositions: 0,
    });
    assert.equal(result.blockedBy.includes("drawdown-pause:new-entries-blocked"), false);
  });

  test("Widerspruch paused ohne PAUSE-Stufe wird verworfen (blockiert nie still)", () => {
    applyDrawdownScaling(drawdown(0.5, { stage: "DEEP", paused: true }));
    assert.equal(getDrawdownScalingState()!.paused, false);
    assert.equal(drawdownPauseState().blocked, false);
  });
});

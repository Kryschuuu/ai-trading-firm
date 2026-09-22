/**
 * Tests: Risk-Guard-Composition des Volatility-Targetings (RMA-P5-01, v1.67.0).
 *
 * Kaskade: Code-Ceilings → Basis-Limit → Regime-Faktor × VolTarget-Faktor
 * → Code-Boden.
 *
 * Pflicht-Prüfungen:
 *   - Monitor-only (null-Zustand) ändert die Limits NICHTS
 *   - Der kombinierte Faktor überschreitet Basis-Limit und Code-Ceilings NIE
 *   - Beide Faktoren ≤ 1 ⇒ Produkt ≤ 1 (multiplikativ, nur senkend)
 *   - Boden = LIMIT_CEILINGS.maxRiskPerTrade[0] (nie darunter)
 *   - Keine Kumulation bei Neuladung (immer aus dem frischen Basiswert)
 *   - null hebt die Reduktion auf (Rollback/Monitor-Pfad)
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  applyAdaptiveRisk,
  applyRuntimeLimits,
  applyVolatilityTargeting,
  getAdaptiveRiskState,
  getBaseLimits,
  getLimits,
  getVolatilityTargetingState,
  LIMIT_CEILINGS,
  type AdaptiveRiskState,
  type VolatilityTargetingState,
} from "../src/lib/riskGuard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

const BASE_RISK = 0.02; // DEFAULT_LIMITS.maxRiskPerTrade
const FLOOR = LIMIT_CEILINGS.maxRiskPerTrade[0]; // 0.002

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

beforeEach(() => {
  __resetAllSingletonsForTests();
});

afterEach(() => {
  __resetAllSingletonsForTests();
});

describe("Monitor-only: keine Wirkung auf die Limits", () => {
  test("null-Zustand ⇒ currentLimits = baseLimits (unverändert)", () => {
    assert.equal(getVolatilityTargetingState(), null);
    applyVolatilityTargeting(null);
    assert.deepEqual(getLimits(), getBaseLimits(), "Monitor-only darf nichts ändern");
  });

  test("analog: ohne adaptiveReduktion bleibt alles neutral", () => {
    assert.equal(getAdaptiveRiskState(), null);
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
  });
});

describe("Faktorwirkung (nur senkend)", () => {
  test("VolTarget-Faktor 0.5 ⇒ maxRiskPerTrade halbiert", () => {
    applyVolatilityTargeting(volTarget(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.5) < 1e-15);
    assert.ok(getLimits().maxRiskPerTrade < getBaseLimits().maxRiskPerTrade);
  });

  test("Faktor = 1 ⇒ neutral (keine Änderung)", () => {
    applyVolatilityTargeting(volTarget(1));
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
  });

  test("null hebt eine zuvor gesetzte Reduktion auf", () => {
    applyVolatilityTargeting(volTarget(0.5));
    assert.ok(getLimits().maxRiskPerTrade < BASE_RISK);
    applyVolatilityTargeting(null);
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK, "Rollback-Pfad: zurück auf Basis");
  });

  test("ungültiger Faktor (NaN/0/negativ) wird ignoriert (fail-closed, nie risikosteigernd)", () => {
    for (const bad of [Number.NaN, 0, -0.5, Number.POSITIVE_INFINITY]) {
      applyVolatilityTargeting(volTarget(bad));
      assert.equal(getVolatilityTargetingState(), null, `Faktor ${bad} muss verworfen werden`);
      assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
    }
  });
});

describe("Multiplikative Komposition (Regime × VolTarget)", () => {
  test("beide Faktoren stacken: 0.5 × 0.5 = 0.25", () => {
    applyAdaptiveRisk(adaptive(0.5));
    applyVolatilityTargeting(volTarget(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.25) < 1e-15);
  });

  test("kombiniert ≤ jeder Einzel-Faktor (Produkt ≤ 1)", () => {
    applyAdaptiveRisk(adaptive(0.5));
    const adaptiveOnly = getLimits().maxRiskPerTrade;
    applyVolatilityTargeting(volTarget(0.5));
    const combined = getLimits().maxRiskPerTrade;
    assert.ok(combined <= adaptiveOnly + 1e-15, "komponierter Faktor senkt nie über den Einzel-Faktor");
    assert.ok(combined <= getBaseLimits().maxRiskPerTrade, "nie über das Basis-Limit");
  });

  test("Kombination ist symmetrisch (Reihenfolge irrelevant)", () => {
    applyAdaptiveRisk(adaptive(0.3));
    applyVolatilityTargeting(volTarget(0.7));
    const ab = getLimits().maxRiskPerTrade;
    __resetAllSingletonsForTests();
    applyVolatilityTargeting(volTarget(0.7));
    applyAdaptiveRisk(adaptive(0.3));
    const ba = getLimits().maxRiskPerTrade;
    assert.ok(Math.abs(ab - ba) < 1e-15);
  });
});

describe("Ceilings und Boden (nie darüber, nie darunter)", () => {
  test("Faktor > 1 wird auf 1 geklemmt (keine risikosteigernde Wirkung)", () => {
    applyVolatilityTargeting(volTarget(2.5));
    assert.equal(getVolatilityTargetingState()!.factor, 1);
    assert.equal(getLimits().maxRiskPerTrade, BASE_RISK);
  });

  test("Boden: extrem kleine Faktoren bleiben ≥ LIMIT_CEILINGS.maxRiskPerTrade[0]", () => {
    applyAdaptiveRisk(adaptive(0.25));
    applyVolatilityTargeting(volTarget(0.25)); // 0.02 × 0.0625 = 0.00125 < 0.002
    assert.ok(getLimits().maxRiskPerTrade >= FLOOR, `Boden ${FLOOR} nicht unterschritten`);
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - FLOOR) < 1e-15, "exakt auf dem Boden");
  });

  test("höheres Basis-Limit (DB): Reduktion wirkt, Ceiling wird nicht überschritten", () => {
    applyRuntimeLimits({ maxRiskPerTrade: 0.05 }); // DB-Reload
    assert.equal(getBaseLimits().maxRiskPerTrade, 0.05);
    applyVolatilityTargeting(volTarget(0.5));
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - 0.025) < 1e-15);
    assert.ok(getLimits().maxRiskPerTrade <= 0.05);
  });
});

describe("Keine Kumulation", () => {
  test("neuer Faktor rechnet aus dem FRESCHEN Basiswert (nicht aus dem reduzierten)", () => {
    applyVolatilityTargeting(volTarget(0.5)); // 0.02 → 0.01
    applyVolatilityTargeting(volTarget(0.75)); // 0.02 × 0.75 = 0.015 (NICHT 0.01 × 0.75)
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.75) < 1e-15);
  });

  test("DB-Neuladung (applyRuntimeLimits) kumuliert nicht", () => {
    applyVolatilityTargeting(volTarget(0.5));
    applyRuntimeLimits({ maxRiskPerTrade: 0.04 }); // DB-Reload
    assert.ok(
      Math.abs(getLimits().maxRiskPerTrade - 0.04 * 0.5) < 1e-15,
      "aus dem frischen Basiswert 0.04, nicht aus 0.02×0.5"
    );
  });
});

describe("persisted-Modus (Mikro-Executor-Sicht)", () => {
  test("persisted-Faktor wirkt wie active (nur der Faktor zählt)", () => {
    applyVolatilityTargeting(volTarget(0.6, "persisted"));
    assert.equal(getVolatilityTargetingState()!.mode, "persisted");
    assert.ok(Math.abs(getLimits().maxRiskPerTrade - BASE_RISK * 0.6) < 1e-15);
  });
});

/**
 * Tests: Hysteretisches Drawdown-Risk-Scaling — PURE Policy (RMA-P5-04, v1.68.0).
 *
 * Deckt die Pflicht-Matrix des Kerns ab:
 *   - Kurve: exakt, monoton nicht-steigend, bounded, stetig an den Schwellen
 *   - wachsender Drawdown kann den Faktor NIE erhöhen
 *   - Hysterese: Degradation sofort, Recovery nur nach Cooldown + Bestätigungen
 *     und höchstens `recoveryStep` je Schritt (kein Flapping)
 *   - Ein-/Auszahlungs-Fixture verfälscht Drawdown/HWM nicht
 *   - unverifizierte Attribution neutralisiert NICHT (konservativer Bias)
 *   - stale/invalide/zukünftige/nicht abgeglichene Equity ⇒ fail-closed
 *   - Bootstrap: kein Reset des HWM durch Deployment, bestehendes Konto startet
 *     mit seinem echten Drawdown
 *   - PAUSE-Schwelle: Veto nur in der Stufe PAUSE, Faktor am Boden
 *   - Konfiguration: Klemmen, Invarianten (soft < hard, pause ≥ hard, min ≤ 1)
 *   - Determinismus, Policyversion, Idempotency-Key, Zustands-Roundtrip
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DRAWDOWN_SCALING_CONFIG,
  DRAWDOWN_SCALING_BOUNDS,
  buildDrawdownScalingIdempotencyKey,
  drawdownStageFor,
  drawdownStateFromRow,
  drawdownTargetFactor,
  EMPTY_DRAWDOWN_SCALING_STATE,
  evaluateDrawdownScaling,
  hashDrawdownScalingData,
  hashDrawdownScalingPolicy,
  resolveDrawdownScalingConfig,
  type DrawdownEquityObservation,
  type DrawdownScalingConfig,
  type DrawdownScalingState,
} from "../src/portfolio/drawdownScaling";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20T12:00:00Z

/** Policy im Test: 5 % soft, 12 % hard, Boden 0.25, PAUSE bei 15 %. */
function testConfig(overrides: Partial<DrawdownScalingConfig> = {}): DrawdownScalingConfig {
  return resolveDrawdownScalingConfig({
    softThresholdPct: 5,
    hardThresholdPct: 12,
    minFactor: 0.25,
    pauseThresholdPct: 15,
    recoveryCooldownMs: 60 * MIN,
    recoveryConfirmations: 2,
    recoveryStep: 0.05,
    maxEquityStalenessMs: 15 * MIN,
    requireReconciliation: true,
    reconciliationMaxAgeMs: 6 * 3600_000,
    cashflowToleranceAbs: 0.05,
    cashflowTolerancePct: 0.001,
    bootstrapFromBaseline: true,
    ...overrides,
  });
}

/** Frische, saubere Reconciliation (Gate erfüllt). */
function cleanRecon(at: number) {
  return { at, clean: true };
}

function observation(partial: Partial<DrawdownEquityObservation> & { equity: number }): DrawdownEquityObservation {
  return {
    availableAt: T0,
    baselineEquity: 10_000,
    tradingPnl: { realized: 0, unrealized: 0 },
    reconciliation: cleanRecon(T0),
    source: "db-snapshot:TICK",
    ...partial,
  };
}

function near(actual: number, expected: number, eps = 1e-9, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${msg ?? "Wert"}: erwartet ${expected}, erhalten ${actual}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Kurve
// ─────────────────────────────────────────────────────────────────────────────

describe("Policy-Kurve (Drawdown → Faktor)", () => {
  test("exakte Werte: 1 unter der Soft-Schwelle, linear dazwischen, Boden ab Hard", () => {
    const cfg = testConfig();
    assert.equal(drawdownTargetFactor(0, cfg), 1);
    assert.equal(drawdownTargetFactor(0.05, cfg), 1, "dd = soft ⇒ 1");
    near(drawdownTargetFactor(0.08, cfg), 0.6785714285714286, 1e-12, "dd = 8 %");
    near(drawdownTargetFactor(0.085, cfg), 0.625, 1e-12, "Mittelpunkt");
    assert.equal(drawdownTargetFactor(0.12, cfg), 0.25, "dd = hard ⇒ minFactor");
    assert.equal(drawdownTargetFactor(0.5, cfg), 0.25, "oberhalb hard bleibt Boden");
    assert.equal(drawdownTargetFactor(1, cfg), 0.25);
  });

  test("monoton nicht-steigend über den gesamten Bereich (mehr Drawdown ⇒ nie mehr Risiko)", () => {
    const cfg = testConfig();
    let prev = Number.POSITIVE_INFINITY;
    for (let dd = 0; dd <= 1.0000001; dd += 0.001) {
      const f = drawdownTargetFactor(dd, cfg);
      assert.ok(f <= prev + 1e-12, `Faktor stieg bei dd=${dd}: ${prev} → ${f}`);
      assert.ok(f >= cfg.minFactor - 1e-12 && f <= 1 + 1e-12, `Faktor außerhalb der Bounds: ${f}`);
      prev = f;
    }
  });

  test("nicht-endliche Drawdown-Eingabe ⇒ Boden (fail-closed, nicht neutral)", () => {
    const cfg = testConfig();
    assert.equal(drawdownTargetFactor(Number.NaN, cfg), cfg.minFactor);
    assert.equal(drawdownTargetFactor(Number.POSITIVE_INFINITY, cfg), cfg.minFactor);
  });

  test("Stufen: NORMAL ≤ soft, SOFT dazwischen, DEEP ≥ hard, PAUSE ≥ pauseThreshold", () => {
    const cfg = testConfig();
    assert.equal(drawdownStageFor(0.03, cfg), "NORMAL");
    assert.equal(drawdownStageFor(0.05, cfg), "NORMAL");
    assert.equal(drawdownStageFor(0.06, cfg), "SOFT");
    assert.equal(drawdownStageFor(0.12, cfg), "DEEP");
    assert.equal(drawdownStageFor(0.149, cfg), "DEEP");
    assert.equal(drawdownStageFor(0.15, cfg), "PAUSE");
    assert.equal(drawdownStageFor(0.9, cfg), "PAUSE");
    // PAUSE deaktiviert (0) ⇒ keine PAUSE-Stufe, egal wie tief der Drawdown ist.
    assert.equal(drawdownStageFor(0.9, testConfig({ pauseThresholdPct: 0 })), "DEEP");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Bootstrap + HWM
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap & High-Water-Mark", () => {
  test("erste Bewertung etabliert den HWM aus der Startbasis (bestehendes Konto startet mit echtem Drawdown)", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 9_000, baselineEquity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.status, "BOOTSTRAP");
    assert.equal(r.reasonCode, "BOOTSTRAP");
    assert.equal(r.transition, "BOOTSTRAP");
    assert.equal(r.hwm, 10_000, "HWM = Startkapital (kein Reset auf die aktuelle Equity)");
    near(r.drawdownPct as number, 0.1, 1e-12);
    near(r.appliedFactor, 0.4642857142857143, 1e-12, "Konto startet degradiert");
    assert.equal(r.nextState.hwm, 10_000);
    assert.equal(r.nextState.factor, r.appliedFactor);
    assert.equal(r.paused, false, "PAUSE (15 %) ist bei 10 % noch nicht erreicht");
  });

  test("Bootstrap ohne Startbasis: HWM = aktuelle (cashflow-bereinigte) Equity, Faktor 1", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 12_345, baselineEquity: null }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.status, "BOOTSTRAP");
    assert.equal(r.hwm, 12_345);
    assert.equal(r.drawdownPct, 0);
    assert.equal(r.appliedFactor, 1);
  });

  test("Bootstrap unterhalb der Startbasis hebt den HWM NICHT an (kein Reset durch Deployment)", () => {
    const cfg = testConfig({ bootstrapFromBaseline: true });
    const restored: DrawdownScalingState = {
      ...EMPTY_DRAWDOWN_SCALING_STATE,
      hwm: 10_500,
      factor: 0.5,
      cumulativeNetFlow: 0,
      lastEquity: 9_450,
      lastObservationAt: T0 - 5 * MIN,
      lastTradingPnl: -1_050,
      lastDegradeAt: T0 - 5 * MIN,
      recoveryStreak: 0,
      stage: "SOFT",
      policyVersion: "ddp1:" + "0".repeat(64),
    };
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 11_000, availableAt: T0, tradingPnl: { realized: 500, unrealized: 0 } }),
      state: restored,
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.hwm, 11_000, "neue Equity über dem HWM hebt ihn an");
    assert.equal(r.status, "OK");
    assert.equal(r.drawdownPct, 0);
    // Neustart (gleicher Zustand) reproduziert denselben HWM/Faktor.
    const again = evaluateDrawdownScaling({
      observation: observation({ equity: 11_000, availableAt: T0, tradingPnl: { realized: 500, unrealized: 0 } }),
      state: restored,
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.deepEqual(again, r, "identische Eingabe ⇒ identisches Ergebnis");
  });

  test("HWM fällt nie (kein Look-back-Reset bei erholter Equity)", () => {
    const cfg = testConfig();
    const first = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const second = evaluateDrawdownScaling({
      observation: observation({ equity: 9_500, availableAt: T0 + MIN, tradingPnl: { realized: -500, unrealized: 0 } }),
      state: first.nextState,
      asOf: T0 + MIN,
      computedAt: T0 + MIN,
      config: cfg,
    });
    assert.equal(second.hwm, 10_000, "HWM bleibt der Höchststand");
    near(second.drawdownPct as number, 0.05, 1e-12);
    const third = evaluateDrawdownScaling({
      observation: observation({ equity: 10_400, availableAt: T0 + 2 * MIN, tradingPnl: { realized: 400, unrealized: 0 } }),
      state: second.nextState,
      asOf: T0 + 2 * MIN,
      computedAt: T0 + 2 * MIN,
      config: cfg,
    });
    assert.equal(third.hwm, 10_400);
    assert.equal(third.drawdownPct, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Monotonie in der Zeit (wachsender Drawdown erhöht den Faktor nie)
// ─────────────────────────────────────────────────────────────────────────────

describe("Monotonie in der Zeit", () => {
  test("wachsender Drawdown senkt den Faktor im selben Schritt (Degradation ist sofort)", () => {
    const cfg = testConfig();
    let state = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    let t = T0;
    let prevFactor = state.appliedFactor;
    for (const equity of [10_000, 9_800, 9_600, 9_400, 9_200, 9_000, 8_800, 8_700, 8_600]) {
      t += MIN;
      const pnl = equity - 10_000;
      const r = evaluateDrawdownScaling({
        observation: observation({ equity, availableAt: t, tradingPnl: { realized: pnl, unrealized: 0 } }),
        state: state.nextState,
        asOf: t,
        computedAt: t,
        config: cfg,
      });
      assert.ok(
        r.appliedFactor <= prevFactor + 1e-12,
        `Faktor stieg bei fallender Equity: ${prevFactor} → ${r.appliedFactor}`
      );
      assert.ok(r.appliedFactor >= cfg.minFactor - 1e-12);
      state = r;
      prevFactor = r.appliedFactor;
    }
    // Bei dd = 14 % (Equity 8.600 gegen HWM 10.000) liegt der Faktor am Boden.
    near(state.appliedFactor, cfg.minFactor, 1e-12);
    assert.equal(state.stage, "DEEP");
  });

  test("Sprung über die harte Schwelle wirkt in EINEM Schritt (keine Rampenschleppe)", () => {
    const cfg = testConfig();
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const crash = evaluateDrawdownScaling({
      observation: observation({
        equity: 8_700,
        availableAt: T0 + MIN,
        tradingPnl: { realized: -1_300, unrealized: 0 },
      }),
      state: boot.nextState,
      asOf: T0 + MIN,
      computedAt: T0 + MIN,
      config: cfg,
    });
    assert.equal(crash.transition, "DEGRADE");
    assert.equal(crash.appliedFactor, cfg.minFactor, "13 % Drawdown ⇒ sofort der Boden");
    assert.equal(crash.stage, "DEEP");
    assert.equal(crash.lastDegradeAt, T0 + MIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Hysterese & Recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("Hysterese: sofortige Degradation, bestätigte Recovery", () => {
  /** Bootstrap + Absturz auf 8 % Drawdown (Faktor 0.678571…). */
  function degraded(config: DrawdownScalingConfig, at = T0) {
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000, availableAt: at, reconciliation: cleanRecon(at) }),
      asOf: at,
      computedAt: at,
      config,
    });
    const degradedAt = at + 10 * MIN;
    const r = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_200,
        availableAt: degradedAt,
        tradingPnl: { realized: -800, unrealized: 0 },
        reconciliation: cleanRecon(degradedAt),
      }),
      state: boot.nextState,
      asOf: degradedAt,
      computedAt: degradedAt,
      config,
    });
    assert.equal(r.stage, "SOFT");
    near(r.appliedFactor, 0.6785714285714286, 1e-12);
    return r;
  }

  test("Recovery wartet auf Cooldown und Bestätigungen statt sofort zu flappen", () => {
    const cfg = testConfig();
    const down = degraded(cfg);
    // (a) Erholung, aber Cooldown läuft noch ⇒ Faktor bleibt stehen, und die
    // Bewertung zählt NICHT als Bestätigung (sonst könnte der Cooldown durch
    // vorgelagerte Beobachtungen unterlaufen werden).
    const t1 = T0 + 20 * MIN;
    const attempt1 = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_950,
        availableAt: t1,
        tradingPnl: { realized: -50, unrealized: 0 },
        reconciliation: cleanRecon(t1),
      }),
      state: down.nextState,
      asOf: t1,
      computedAt: t1,
      config: cfg,
    });
    assert.equal(attempt1.transition, "NONE", "kein Recovery-Schritt im Cooldown");
    assert.equal(attempt1.appliedFactor, down.appliedFactor);
    assert.ok((attempt1.targetFactor as number) > 0.99, "Kurvenziel ist bereits (fast) neutral");
    assert.equal(attempt1.recoveryStreak, 0, "Cooldown blockiert die Bestätigungszählung");

    // (b) Cooldown vorbei, aber erst die erste Bestätigung.
    const t2 = down.lastDegradeAt! + 60 * MIN + MIN;
    const attempt2 = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_950,
        availableAt: t2,
        tradingPnl: { realized: -50, unrealized: 0 },
        reconciliation: cleanRecon(t2),
      }),
      state: attempt1.nextState,
      asOf: t2,
      computedAt: t2,
      config: cfg,
    });
    assert.equal(attempt2.transition, "NONE");
    assert.equal(attempt2.appliedFactor, down.appliedFactor, "2 Bestätigungen sind Pflicht");
    assert.equal(attempt2.recoveryStreak, 1);

    // (c) Zweite Bestätigung ⇒ genau EIN begrenzter Schritt.
    const t3 = t2 + MIN;
    const step = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_950,
        availableAt: t3,
        tradingPnl: { realized: -50, unrealized: 0 },
        reconciliation: cleanRecon(t3),
      }),
      state: attempt2.nextState,
      asOf: t3,
      computedAt: t3,
      config: cfg,
    });
    assert.equal(step.transition, "RECOVER");
    near(step.appliedFactor, down.appliedFactor + 0.05, 1e-12, "Recovery-Schritt = recoveryStep");
    assert.ok(step.appliedFactor < 1, "kein Sprung auf neutral in einem Schritt");
  });

  test("Recovery ist langsamer oder gleich schnell wie die Degradation (Zeitvergleich)", () => {
    const cfg = testConfig();
    const down = degraded(cfg);
    // Degradation: 1 Schritt (10 min nach Bootstrap).
    assert.equal(down.transition, "DEGRADE");
    // Recovery: braucht Cooldown (60 min) + 2 Bestätigungen + je Schritt 0.05.
    let state = down.nextState;
    let steps = 0;
    const target = 1;
    for (let i = 0; i < 200 && state.factor! < target - 1e-9; i++) {
      const t = down.lastDegradeAt! + 61 * MIN + (i + 1) * MIN;
      const r = evaluateDrawdownScaling({
        observation: observation({
          equity: 9_950,
          availableAt: t,
          tradingPnl: { realized: -50, unrealized: 0 },
          reconciliation: cleanRecon(t),
        }),
        state,
        asOf: t,
        computedAt: t,
        config: cfg,
      });
      assert.ok(
        r.appliedFactor - state.factor! <= cfg.recoveryStep + 1e-12,
        "kein Recovery-Schritt über recoveryStep hinaus"
      );
      state = r.nextState;
      steps++;
    }
    assert.ok(steps >= 6, `Recovery braucht mehrere Schritte, war ${steps}`);
    assert.equal(state.factor, target);
  });

  test("erneute Verschlechterung setzt die Bestätigungszählung zurück und senkt sofort", () => {
    const cfg = testConfig();
    const down = degraded(cfg);
    const t1 = down.lastDegradeAt! + 70 * MIN;
    const recovered1 = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_950,
        availableAt: t1,
        tradingPnl: { realized: -50, unrealized: 0 },
        reconciliation: cleanRecon(t1),
      }),
      state: { ...down.nextState, recoveryStreak: 2 },
      asOf: t1,
      computedAt: t1,
      config: cfg,
    });
    assert.equal(recovered1.transition, "RECOVER");
    // Kursrutsch: 10 % Drawdown ⇒ wieder Degradation, Zähler auf 0. Das
    // Fixture ist bewusst PnL-konsistent (ΔEquity = ΔPnL), sonst würde das
    // Residuum als Cashflow fehlinterpretiert.
    const t2 = t1 + MIN;
    const worse = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_100,
        availableAt: t2,
        tradingPnl: { realized: -900, unrealized: 0 },
        reconciliation: cleanRecon(t2),
      }),
      state: recovered1.nextState,
      asOf: t2,
      computedAt: t2,
      config: cfg,
    });
    assert.equal(worse.transition, "DEGRADE");
    assert.equal(worse.recoveryStreak, 0);
    assert.equal(worse.cashflow.detected, 0, "konsistentes Fixture ⇒ kein Schein-Cashflow");
    near(worse.drawdownPct as number, 0.09, 1e-12, "9 % Drawdown (HWM 10.000)");
    near(worse.appliedFactor, 1 - 0.75 * (0.04 / 0.07), 1e-12, "9 % Drawdown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Cashflows (Ein-/Auszahlungen)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cashflows: Ein-/Auszahlungen sind keine Performance", () => {
  test("Einzahlung erzeugt weder neuen HWM noch Drawdown und ändert den Faktor nicht", () => {
    const cfg = testConfig();
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    // Reiner Gewinn (HWM steigt legitim).
    const t1 = T0 + MIN;
    const profit = evaluateDrawdownScaling({
      observation: observation({
        equity: 10_500,
        availableAt: t1,
        tradingPnl: { realized: 500, unrealized: 0 },
        reconciliation: cleanRecon(t1),
      }),
      state: boot.nextState,
      asOf: t1,
      computedAt: t1,
      config: cfg,
    });
    assert.equal(profit.hwm, 10_500);
    assert.equal(profit.cashflow.detected, 0);

    // Einzahlung von 5.000: Equity steigt, Trading-PnL unverändert.
    const t2 = t1 + MIN;
    const deposit = evaluateDrawdownScaling({
      observation: observation({
        equity: 15_500,
        availableAt: t2,
        tradingPnl: { realized: 500, unrealized: 0 },
        reconciliation: cleanRecon(t2),
      }),
      state: profit.nextState,
      asOf: t2,
      computedAt: t2,
      config: cfg,
    });
    assert.equal(deposit.hwm, 10_500, "Einzahlung hebt den HWM NICHT");
    assert.equal(deposit.drawdownPct, 0, "Einzahlung erzeugt keinen Drawdown");
    assert.equal(deposit.appliedFactor, 1);
    near(deposit.cashflow.detected, 5_000, 1e-9, "Einzahlung erkannt");
    near(deposit.cashflow.cumulative, 5_000, 1e-9);
    assert.equal(deposit.cashflow.verification, "verified");
    assert.equal(deposit.adjustedEquity, 10_500);
  });

  test("Auszahlung erzeugt keinen falschen Drawdown", () => {
    const cfg = testConfig();
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const t1 = T0 + MIN;
    const withdrawal = evaluateDrawdownScaling({
      observation: observation({
        equity: 9_000,
        availableAt: t1,
        tradingPnl: { realized: 0, unrealized: 0 },
        reconciliation: cleanRecon(t1),
      }),
      state: boot.nextState,
      asOf: t1,
      computedAt: t1,
      config: cfg,
    });
    near(withdrawal.cashflow.detected, -1_000, 1e-9);
    assert.equal(withdrawal.hwm, 10_000, "Auszahlung senkt den HWM nicht");
    assert.equal(withdrawal.drawdownPct, 0, "Auszahlung ist kein Verlust");
    assert.equal(withdrawal.appliedFactor, 1);
    assert.equal(withdrawal.paused, false);
    assert.equal(withdrawal.stage, "NORMAL");
    near(withdrawal.adjustedEquity as number, 10_000, 1e-9, "PnL-bereinigte Equity bleibt unverändert");

    // Echter Verlust danach: 1.000 auf die ursprüngliche Kapitalbasis. Der
    // Drawdown wird auf der PnL-Ebene gemessen (HWM ist ein absolutes
    // PnL-Niveau), nicht auf der geschrumpften Restkapitalbasis.
    const t2 = t1 + MIN;
    const realLoss = evaluateDrawdownScaling({
      observation: observation({
        equity: 8_000,
        availableAt: t2,
        tradingPnl: { realized: -1_000, unrealized: 0 },
        reconciliation: cleanRecon(t2),
      }),
      state: withdrawal.nextState,
      asOf: t2,
      computedAt: t2,
      config: cfg,
    });
    assert.equal(realLoss.cashflow.detected, 0, "echter Verlust ist kein Cashflow");
    near(realLoss.cashflow.cumulative, -1_000, 1e-9, "Cashflow-Detektion driftet nicht");
    near(realLoss.drawdownPct as number, 0.10, 1e-12, "10 % echter Verlust wird erkannt");
    assert.equal(realLoss.stage, "SOFT");
    assert.equal(realLoss.transition, "DEGRADE");
    near(realLoss.appliedFactor, 1 - 0.75 * (0.05 / 0.07), 1e-12, "Degradation greift sofort");
  });

  test("unverifizierte Attribution neutralisiert NICHT (konservativer Bias statt Raten)", () => {
    const cfg = testConfig();
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const t1 = T0 + MIN;
    const unverified = evaluateDrawdownScaling({
      observation: observation({
        equity: 15_500,
        availableAt: t1,
        // Attribution unvollständig ⇒ null ist NICHT 0.
        tradingPnl: { realized: null, unrealized: null },
        reconciliation: cleanRecon(t1),
      }),
      state: boot.nextState,
      asOf: t1,
      computedAt: t1,
      config: cfg,
    });
    assert.equal(unverified.cashflow.verification, "unverified");
    assert.equal(unverified.cashflow.detected, 0);
    assert.equal(unverified.hwm, 15_500, "Zufluss gilt konservativ als Performance (HWM steigt)");
    assert.equal(unverified.drawdownPct, 0);

    // Konsequenz: der nächste echte Rückgang misst gegen den höheren HWM ⇒
    // strenger, nie lockerer.
    const t2 = t1 + MIN;
    const afterwards = evaluateDrawdownScaling({
      observation: observation({
        equity: 14_700,
        availableAt: t2,
        tradingPnl: { realized: -800, unrealized: 0 },
        reconciliation: cleanRecon(t2),
      }),
      state: unverified.nextState,
      asOf: t2,
      computedAt: t2,
      config: cfg,
    });
    assert.ok((afterwards.drawdownPct as number) > 0, "Rückgang wird als Drawdown gemessen");
    assert.ok(afterwards.appliedFactor < 1);
  });

  test("veraltete Vorbewertung ⇒ keine Cashflow-Neutralisierung (keine Fernattribution)", () => {
    const cfg = testConfig();
    const boot = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const gap = T0 + 4 * 3600_000; // weit jenseits maxEquityStalenessMs
    const r = evaluateDrawdownScaling({
      observation: observation({
        equity: 15_000,
        availableAt: gap,
        tradingPnl: { realized: 0, unrealized: 0 },
        reconciliation: cleanRecon(gap),
      }),
      state: boot.nextState,
      asOf: gap,
      computedAt: gap,
      config: cfg,
    });
    assert.equal(r.cashflow.verification, "unverified");
    assert.equal(r.cashflow.detected, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("Fail-closed: fehlende, stale, invalide oder nicht abgeglichene Equity", () => {
  const base: DrawdownScalingState = {
    ...EMPTY_DRAWDOWN_SCALING_STATE,
    hwm: 10_000,
    factor: 1,
    cumulativeNetFlow: 0,
    lastEquity: 10_000,
    lastObservationAt: T0 - MIN,
    lastTradingPnl: 0,
    recoveryStreak: 2,
    stage: "NORMAL",
    policyVersion: "ddp1:" + "0".repeat(64),
  };

  function run(obs: DrawdownEquityObservation, cfg = testConfig(), computedAt = T0) {
    return evaluateDrawdownScaling({
      observation: obs,
      state: base,
      asOf: computedAt,
      computedAt,
      config: cfg,
    });
  }

  test("keine Equity ⇒ NO_EQUITY, Faktor auf den Boden, Drawdown null (nicht 0)", () => {
    const r = run({ equity: Number.NaN, availableAt: Number.NaN });
    assert.equal(r.status, "CONSERVATIVE");
    assert.equal(r.reasonCode, "NO_EQUITY");
    assert.equal(r.drawdownPct, null);
    assert.equal(r.appliedFactor, testConfig().minFactor);
    assert.equal(r.stage, "DEEP");
    assert.equal(r.hwm, 10_000, "HWM bleibt erhalten");
    assert.equal(r.recoveryStreak, 0, "Bestätigungen werden verworfen");
  });

  test("Equity ≤ 0 ⇒ INVALID_EQUITY (insolvent ist kein Sonderfall)", () => {
    const r = run(observation({ equity: -5 }));
    assert.equal(r.reasonCode, "INVALID_EQUITY");
    assert.equal(r.appliedFactor, testConfig().minFactor);
  });

  test("stale Equity ⇒ STALE_EQUITY", () => {
    const r = run(observation({ equity: 10_000, availableAt: T0 - 20 * MIN }));
    assert.equal(r.reasonCode, "STALE_EQUITY");
    assert.equal(r.appliedFactor, testConfig().minFactor);
  });

  test("Equity-Zeitstempel in der Zukunft ⇒ FUTURE_EQUITY (Look-ahead-Verdacht)", () => {
    const r = run(observation({ equity: 10_000, availableAt: T0 + MIN }));
    assert.equal(r.reasonCode, "FUTURE_EQUITY");
    assert.equal(r.appliedFactor, testConfig().minFactor);
  });

  test("fehlender Reconciliation-Bericht ⇒ RECONCILIATION_MISSING", () => {
    const r = run(observation({ equity: 10_000, reconciliation: null }));
    assert.equal(r.reasonCode, "RECONCILIATION_MISSING");
    assert.equal(r.appliedFactor, testConfig().minFactor);
  });

  test("kritische Reconciliation-Diskrepanz ⇒ RECONCILIATION_FAILED", () => {
    const r = run(observation({ equity: 10_000, reconciliation: { at: T0, clean: false } }));
    assert.equal(r.reasonCode, "RECONCILIATION_FAILED");
  });

  test("zu alter Reconciliation-Bericht ⇒ RECONCILIATION_STALE", () => {
    const r = run(observation({ equity: 10_000, reconciliation: { at: T0 - 7 * 3600_000, clean: true } }));
    assert.equal(r.reasonCode, "RECONCILIATION_STALE");
  });

  test("Reconciliation-Pflicht abschaltbar (requireReconciliation=false ⇒ Normalpfad)", () => {
    const cfg = testConfig({ requireReconciliation: false });
    const r = run(observation({ equity: 9_200, availableAt: T0, tradingPnl: { realized: -800, unrealized: 0 }, reconciliation: null }), cfg);
    assert.equal(r.status, "OK");
    near(r.drawdownPct as number, 0.08, 1e-12);
    assert.ok(r.appliedFactor < 1 && r.appliedFactor > cfg.minFactor);
  });

  test("fail-closed senkt sofort (auch aus neutraler Vorstufe) und bleibt bounded", () => {
    const r = run(observation({ equity: 10_000, availableAt: Number.NaN }));
    assert.equal(r.transition, "DEGRADE");
    assert.equal(r.prevFactor, 1);
    assert.equal(r.appliedFactor, 0.25);
    assert.ok(r.factorDelta < 0);
    assert.equal(r.lastDegradeAt, T0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) PAUSE
// ─────────────────────────────────────────────────────────────────────────────

describe("PAUSE-Stufe", () => {
  test("ab der PAUSE-Schwelle: Faktor am Boden + Veto für neue Einstiege", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({
        equity: 8_400,
        baselineEquity: 10_000,
        tradingPnl: { realized: -1_600, unrealized: 0 },
      }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.stage, "PAUSE");
    assert.equal(r.paused, true);
    assert.equal(r.appliedFactor, cfg.minFactor);
    assert.equal(r.drawdownPct! >= 0.15, true);
  });

  test("unterhalb der PAUSE-Schwelle bleibt der Block aus (DEEP statt PAUSE)", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 8_700, baselineEquity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.stage, "DEEP");
    assert.equal(r.paused, false);
  });

  test("fail-closed behauptet KEINE PAUSE (kein Block ohne Messung) und blockiert auch nicht", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000, reconciliation: null }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.status, "CONSERVATIVE");
    assert.equal(r.paused, false, "ohne Messung wird kein Dauerblock behauptet");
    assert.equal(r.appliedFactor, cfg.minFactor, "der Faktor ist trotzdem am Boden");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

describe("Konfiguration", () => {
  test("Defaults sind risikoneutral (monitor) und unter dem Kill-Switch", () => {
    assert.equal(DEFAULT_DRAWDOWN_SCALING_CONFIG.mode, "monitor");
    assert.equal(DEFAULT_DRAWDOWN_SCALING_CONFIG.enabled, true);
    assert.ok(DEFAULT_DRAWDOWN_SCALING_CONFIG.softThresholdPct < DEFAULT_DRAWDOWN_SCALING_CONFIG.hardThresholdPct);
    // Der Kill-Switch-Default (maxEquityDrawdownPct = 15 %) liegt über der Hard-Schwelle.
    assert.ok(DEFAULT_DRAWDOWN_SCALING_CONFIG.hardThresholdPct <= 15);
    assert.ok(DEFAULT_DRAWDOWN_SCALING_CONFIG.minFactor > 0);
    assert.ok(DEFAULT_DRAWDOWN_SCALING_CONFIG.minFactor <= 1);
  });

  test("Werte werden geklemmt, minFactor nie > 1 (keine Risikoerhöhung per Konfiguration)", () => {
    const cfg = resolveDrawdownScalingConfig({ minFactor: 5, softThresholdPct: 1e9, hardThresholdPct: -3 });
    assert.equal(cfg.minFactor, 1);
    assert.equal(cfg.softThresholdPct, DRAWDOWN_SCALING_BOUNDS.softThresholdPct[1]);
    // Die harte Invariante `hard > soft` gewinnt gegen die Einzelklemmung —
    // nie ein invertiertes Fenster, nie Risikoerhöhung.
    assert.ok(cfg.hardThresholdPct > cfg.softThresholdPct);
    assert.ok(
      cfg.hardThresholdPct >= DRAWDOWN_SCALING_BOUNDS.hardThresholdPct[0] &&
        cfg.hardThresholdPct <= DRAWDOWN_SCALING_BOUNDS.hardThresholdPct[1]
    );
    assert.ok(cfg.minFactor <= 1);
  });

  test("Invarianten: hard > soft, PAUSE ≥ hard (oder aus), minFactor > 0", () => {
    const cfg = resolveDrawdownScalingConfig({ softThresholdPct: 20, hardThresholdPct: 12, pauseThresholdPct: 13, minFactor: 0 });
    assert.ok(cfg.hardThresholdPct > cfg.softThresholdPct, `hard ${cfg.hardThresholdPct} > soft ${cfg.softThresholdPct}`);
    assert.ok(cfg.pauseThresholdPct === 0 || cfg.pauseThresholdPct >= cfg.hardThresholdPct);
    assert.ok(cfg.minFactor > 0);
  });

  test("ungültige Werte behalten den Basiswert; unbekannter Modus fällt auf den Basiswert zurück", () => {
    const base = testConfig();
    const cfg = resolveDrawdownScalingConfig({ minFactor: "abc", mode: "hyper" }, base);
    assert.equal(cfg.minFactor, base.minFactor);
    assert.equal(cfg.mode, base.mode);
    const mode = resolveDrawdownScalingConfig({ mode: "ACTIVE" }, base);
    assert.equal(mode.mode, "active", "Modus wird case-insensitiv validiert");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) Determinismus, Policyversion, Idempotenz, Zustands-Roundtrip
// ─────────────────────────────────────────────────────────────────────────────

describe("Determinismus & Versionierung", () => {
  test("gleiche Eingabe ⇒ bit-identisches Ergebnis (Replay-Fähigkeit)", () => {
    const cfg = testConfig();
    const a = evaluateDrawdownScaling({
      observation: observation({ equity: 9_300, availableAt: T0, tradingPnl: { realized: -700, unrealized: 0 } }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const b = evaluateDrawdownScaling({
      observation: observation({ equity: 9_300, availableAt: T0, tradingPnl: { realized: -700, unrealized: 0 } }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.deepEqual(a, b);
  });

  test("Policyversion: stabil bei gleicher Policy, neu bei jeder Policyänderung", () => {
    const cfg = testConfig();
    const v1 = hashDrawdownScalingPolicy(cfg);
    assert.match(v1, /^ddp1:[0-9a-f]{64}$/);
    assert.equal(hashDrawdownScalingPolicy(testConfig()), v1, "gleiche Policy ⇒ gleiche Version");
    const v2 = hashDrawdownScalingPolicy(testConfig({ softThresholdPct: 6 }));
    assert.notEqual(v2, v1, "Schwellwertänderung ⇒ neue Version");
    const v3 = hashDrawdownScalingPolicy(testConfig({ recoveryStep: 0.06 }));
    assert.notEqual(v3, v1, "Hystereseänderung ⇒ neue Version");
    const modeOnly = hashDrawdownScalingPolicy(testConfig({ mode: "active" }));
    assert.equal(modeOnly, v1, "der Betriebsmodus ändert die Policy NICHT (nur ihre Wirksamkeit)");
    // Historische Zeilen bleiben lesbar: die Bewertung trägt ihre eigene Version.
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 10_000 }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    assert.equal(r.policyVersion, v1);
  });

  test("Idempotency-Key: gleiche Minute ⇒ identisch, neue Minute ⇒ neu; Datenhash reagiert auf Daten", () => {
    const cfg = testConfig();
    const policyVersion = hashDrawdownScalingPolicy(cfg);
    const obs = observation({ equity: 9_800, availableAt: T0 });
    const hashA = hashDrawdownScalingData({ observation: obs, asOf: T0, computedAt: T0 });
    const hashB = hashDrawdownScalingData({ observation: obs, asOf: T0, computedAt: T0 });
    assert.equal(hashA, hashB);
    assert.match(hashA, /^dd1:[0-9a-f]{64}$/);
    const hashC = hashDrawdownScalingData({
      observation: observation({ equity: 9_801, availableAt: T0 }),
      asOf: T0,
      computedAt: T0,
    });
    assert.notEqual(hashC, hashA);

    const key1 = buildDrawdownScalingIdempotencyKey(T0, policyVersion, hashA);
    const key2 = buildDrawdownScalingIdempotencyKey(T0 + 30_000, policyVersion, hashA);
    const key3 = buildDrawdownScalingIdempotencyKey(T0 + 60_000, policyVersion, hashA);
    assert.match(key1, /^dsc1:[0-9a-f]{64}$/);
    assert.equal(key2, key1, "innerhalb derselben Minute identisch");
    assert.notEqual(key3, key1, "neue Minute ⇒ neue Zeile");
  });

  test("konfigurationsbasierte Datenhash-Trennung: Equity-Beobachtung ist Teil des Hashes", () => {
    const base = observation({ equity: 10_000, availableAt: T0, tradingPnl: { realized: 5, unrealized: 0 } });
    const variant = observation({ equity: 10_000, availableAt: T0, tradingPnl: { realized: 5, unrealized: 1 } });
    assert.notEqual(
      hashDrawdownScalingData({ observation: base, asOf: T0, computedAt: T0 }),
      hashDrawdownScalingData({ observation: variant, asOf: T0, computedAt: T0 })
    );
  });

  test("Zustands-Roundtrip über die persistierte Zeile (Neustart-Rekonstruktion)", () => {
    const cfg = testConfig();
    const r = evaluateDrawdownScaling({
      observation: observation({ equity: 9_300, availableAt: T0, tradingPnl: { realized: -700, unrealized: 0 } }),
      asOf: T0,
      computedAt: T0,
      config: cfg,
    });
    const restored = drawdownStateFromRow({
      hwm: String(r.nextState.hwm),
      appliedFactor: String(r.nextState.factor),
      cumulativeNetFlow: String(r.nextState.cumulativeNetFlow),
      lastEquity: String(r.nextState.lastEquity),
      lastObservationAt: new Date(r.nextState.lastObservationAt as number),
      lastTradingPnl: String(r.nextState.lastTradingPnl),
      lastDegradeAt: r.nextState.lastDegradeAt !== null ? new Date(r.nextState.lastDegradeAt) : null,
      lastTransitionAt: r.nextState.lastTransitionAt !== null ? new Date(r.nextState.lastTransitionAt) : null,
      recoveryStreak: r.nextState.recoveryStreak,
      stage: r.nextState.stage,
      policyVersion: r.nextState.policyVersion,
    });
    assert.deepEqual(restored, r.nextState, "Zustand ist ohne Verlust rekonstruierbar");

    // Weiterbewertung aus dem rekonstruierten Zustand ⇒ identisches Ergebnis
    // wie aus dem RAM-Zustand (Neustart-Parität).
    const t1 = T0 + MIN;
    const obs = observation({ equity: 9_350, availableAt: t1, tradingPnl: { realized: -650, unrealized: 0 } });
    const fromRam = evaluateDrawdownScaling({ observation: obs, state: r.nextState, asOf: t1, computedAt: t1, config: cfg });
    const fromDb = evaluateDrawdownScaling({ observation: obs, state: restored, asOf: t1, computedAt: t1, config: cfg });
    assert.deepEqual(fromDb, fromRam);
  });

  test("drawdownStateFromRow ist tolerant gegenüber fehlenden/ungültigen Feldern", () => {
    const s = drawdownStateFromRow({
      hwm: null,
      appliedFactor: "not-a-number",
      cumulativeNetFlow: null,
      stage: "BOGUS",
      recoveryStreak: -4,
    });
    assert.equal(s.hwm, null);
    assert.equal(s.factor, null);
    assert.equal(s.cumulativeNetFlow, null);
    assert.equal(s.stage, null);
    assert.equal(s.recoveryStreak, 0);
  });
});

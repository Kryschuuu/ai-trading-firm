/**
 * Unit-Tests Strategy-Lifecycle State Machine (RMA-P1-05, v1.73.0).
 *
 * - Übergangstabelle: jeder strukturell erlaubte und verbotene Übergang
 * - DRAFT → LIVE und Promotion ohne Evidenz werden abgelehnt (Struktur)
 * - Rollen-/Trigger-Preconditions
 * - Order-Gate: off/monitor/enforce, stale/fehlend fail-closed
 * - Promotion-Gates: stale/zu kleine Stichprobe blockiert
 * - Drift: Schwellenüberschreitung, INCONCLUSIVE, keine Risikoerhöhung
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  STRATEGY_LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LIVE_CAPABLE_STATES,
  allowedTargets,
  canTransition,
  isStrategyLifecycleState,
  roleAllowed,
  triggerAllowed,
  transitionDef,
  type StrategyLifecycleState,
} from "../src/strategyLifecycle/states";
import {
  DEFAULT_PROMOTION_POLICY,
  evaluateBacktestGate,
  evaluatePaperGate,
  resolvePromotionPolicy,
} from "../src/strategyLifecycle/policies";
import {
  DEFAULT_DRIFT_POLICY,
  DRIFT_METRIC_SPECS,
  evaluateDrift,
  metricWindow,
} from "../src/strategyLifecycle/drift";
import { evaluateLifecycleOrderGate } from "../src/strategyLifecycle/orderGate";
import { strategyLifecycleConfig } from "../src/strategyLifecycle/config";
import {
  evidenceContentHash,
  evidenceIdempotencyKey,
  normalizeStrategyKey,
  normalizeStrategyVersion,
  transitionKey,
} from "../src/strategyLifecycle/evidence";
import {
  applyStrategyLifecycleScale,
  getLimits,
  strategyLifecyclePauseState,
  validateOrder,
} from "../src/lib/riskGuard";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { evaluateSubmitGates, type GateContext } from "../src/execution/gates";
import type { BrokerVenueId } from "../src/contracts/broker";

const NOW = 1_700_000_000_000;

describe("strategyLifecycle states: Übergangstabelle", () => {
  test("alle neun Pflichtzustände sind definiert", () => {
    assert.deepEqual(
      [...STRATEGY_LIFECYCLE_STATES].sort(),
      [
        "BACKTEST_PASSED",
        "BACKTEST_PENDING",
        "DEGRADED",
        "DRAFT",
        "LIVE",
        "LIVE_LIMITED",
        "PAUSED",
        "PAPER",
        "REJECTED",
      ].sort()
    );
  });

  test("jede erlaubte Kante der Tabelle ist canTransition=true; verbotene false", () => {
    const allowed = new Set(
      LIFECYCLE_TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    );
    for (const from of STRATEGY_LIFECYCLE_STATES) {
      for (const to of STRATEGY_LIFECYCLE_STATES) {
        const key = `${from}->${to}`;
        assert.equal(
          canTransition(from, to),
          allowed.has(key),
          `Kante ${key} ungleich Transitions-Tabelle`
        );
      }
    }
  });

  test("DRAFT → LIVE ist strukturell verboten (kein Direktsprung)", () => {
    assert.equal(canTransition("DRAFT", "LIVE"), false);
    assert.equal(canTransition("DRAFT", "LIVE_LIMITED"), false);
    assert.equal(canTransition("DRAFT", "PAPER"), false);
    assert.equal(transitionDef("DRAFT", "LIVE"), null);
  });

  test("Evidenzpflicht nur auf Promotion-Kanten", () => {
    const withEvidence = LIFECYCLE_TRANSITIONS.filter(
      (t) => t.requiresEvidence && t.from !== t.to
    );
    for (const t of withEvidence) {
      assert.ok(
        ["BACKTEST_PASSED", "PAPER", "LIVE_LIMITED", "LIVE", "PAPER"].includes(
          t.to
        ) || t.to === "PAPER",
        `${t.from}→${t.to} unerwartet evidenzpflichtig`
      );
      assert.ok(t.evidenceKinds.length > 0, `${t.from}→${t.to} ohne Evidenzarten`);
    }
    // Explizit: Draft-Start braucht keine Evidence
    const start = transitionDef("DRAFT", "BACKTEST_PENDING");
    assert.ok(start);
    assert.equal(start.requiresEvidence, false);
  });

  test("Degradations-Kanten senken die Ziel-Risk-Scale (nie > 0.5 bei DEGRADED/PAUSED)", () => {
    for (const t of LIFECYCLE_TRANSITIONS) {
      if (t.to === "DEGRADED" || t.to === "PAUSED") {
        assert.ok(
          t.targetRiskScale <= 0.5,
          `${t.from}→${t.to} riskScale ${t.targetRiskScale}`
        );
        // Self-Edges (idempotente No-Ops) setzen bewusst keinen neuen Cooldown.
        if (t.from !== t.to) {
          assert.ok(t.setsCooldown, `${t.from}→${t.to} muss Cooldown setzen`);
        }
      }
      assert.ok(t.targetRiskScale > 0 && t.targetRiskScale <= 1);
    }
  });

  test("Rollenmatrix: viewer nie, admin/system immer, operator nur gelistet", () => {
    const draftStart = transitionDef("DRAFT", "BACKTEST_PENDING")!;
    assert.equal(roleAllowed(draftStart, "viewer"), false);
    assert.equal(roleAllowed(draftStart, "admin"), true);
    assert.equal(roleAllowed(draftStart, "system"), true);
    assert.equal(roleAllowed(draftStart, "operator"), true);

    const paperToLimited = transitionDef("PAPER", "LIVE_LIMITED")!;
    // operator nur wenn gelistet — Promotion-Paper→LIVE_LIMITED: roles admin only
    // (admin/system erfüllen immer; operator nur wenn in roles)
    assert.equal(roleAllowed(paperToLimited, "operator"), paperToLimited.roles.includes("operator"));
    assert.equal(roleAllowed(paperToLimited, "viewer"), false);
  });

  test("Trigger-Preconditions: drift-Kanten tragen drift-Trigger", () => {
    const deg = transitionDef("LIVE", "DEGRADED")!;
    assert.ok(triggerAllowed(deg, "drift"));
    assert.ok(triggerAllowed(deg, "system"));
    assert.equal(triggerAllowed(deg, "backtest"), deg.trigger.includes("backtest"));
  });

  test("Recovery-Kanten sind evidenzpflichtig (kein Auto-Re-Promotion)", () => {
    for (const t of LIFECYCLE_TRANSITIONS) {
      if (t.from === "DEGRADED" && t.to === "LIVE_LIMITED") {
        assert.equal(t.requiresEvidence, true);
        assert.ok(t.evidenceKinds.includes("RECOVERY"));
      }
      if (t.from === "PAUSED" && (t.to === "PAPER" || t.to === "LIVE_LIMITED")) {
        assert.equal(t.requiresEvidence, true);
      }
    }
  });

  test("isStrategyLifecycleState lehnt Fremdwerte ab", () => {
    assert.equal(isStrategyLifecycleState("LIVE"), true);
    assert.equal(isStrategyLifecycleState("ARCHIVED"), false);
    assert.equal(isStrategyLifecycleState(42), false);
    assert.equal(isStrategyLifecycleState(null), false);
  });

  test("allowedTargets enthält nie den eigenen Zustand", () => {
    for (const s of STRATEGY_LIFECYCLE_STATES) {
      assert.ok(!allowedTargets(s).includes(s), s);
      assert.ok(allowedTargets(s).length > 0, `${s} braucht mind. eine Kante`);
    }
  });

  test("LIVE_CAPABLE_STATES nur LIVE_LIMITED und LIVE", () => {
    assert.deepEqual([...LIVE_CAPABLE_STATES], ["LIVE_LIMITED", "LIVE"]);
  });
});

describe("promotion gates: fail-closed", () => {
  const freshWindow = {
    windowStartMs: NOW - 20 * 24 * 3600_000,
    windowEndMs: NOW - 1000,
    availableAtMs: NOW - 3600_000,
  };

  test("vollständige frische Backtest-Evidenz besteht", () => {
    const g = evaluateBacktestGate(
      {
        ...freshWindow,
        trades: 50,
        winRate: 0.55,
        profitFactor: 1.2,
        maxDrawdownPct: 10,
        dataQualityScore: 0.95,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, true, JSON.stringify(g.checks));
    assert.equal(g.policyVersion, DEFAULT_PROMOTION_POLICY.version);
  });

  test("zu kleine Stichprobe blockiert", () => {
    const g = evaluateBacktestGate(
      {
        ...freshWindow,
        trades: 5,
        winRate: 0.6,
        profitFactor: 1.5,
        maxDrawdownPct: 5,
        dataQualityScore: 1,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, false);
    const sample = g.checks.find((c) => c.id === "sample.trades");
    assert.equal(sample?.status, "FAIL");
  });

  test("stale Evidenz blockiert (availableAt zu alt)", () => {
    const g = evaluateBacktestGate(
      {
        windowStartMs: NOW - 400 * 24 * 3600_000,
        windowEndMs: NOW - 350 * 24 * 3600_000,
        availableAtMs: NOW - 400 * 24 * 3600_000,
        trades: 100,
        winRate: 0.5,
        profitFactor: 1.1,
        maxDrawdownPct: 8,
        dataQualityScore: 0.9,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, false);
    assert.equal(g.checks.find((c) => c.id === "evidence.freshness")?.status, "STALE");
  });

  test("fehlende Kennzahl (null) ist MISSING, nicht 0", () => {
    const g = evaluateBacktestGate(
      {
        ...freshWindow,
        trades: null,
        winRate: null,
        profitFactor: null,
        maxDrawdownPct: null,
        dataQualityScore: null,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, false);
    for (const id of ["sample.trades", "risk.maxDrawdownPct", "data.quality"]) {
      const c = g.checks.find((x) => x.id === id);
      assert.ok(c, id);
      assert.equal(c.status, "MISSING", id);
      assert.equal(c.observed, null, id);
    }
  });

  test("Drawdown über Policy-Schwelle blockiert", () => {
    const g = evaluateBacktestGate(
      {
        ...freshWindow,
        trades: 40,
        winRate: 0.5,
        profitFactor: 1.0,
        maxDrawdownPct: 40,
        dataQualityScore: 0.9,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, false);
    assert.equal(
      g.checks.find((c) => c.id === "risk.maxDrawdownPct")?.status,
      "FAIL"
    );
  });

  test("Paper-Gate: unbekannte Reconciliation ist fail-closed", () => {
    const g = evaluatePaperGate(
      {
        windowStartMs: NOW - 10 * 24 * 3600_000,
        windowEndMs: NOW - 1000,
        availableAtMs: NOW - 3600_000,
        trades: 30,
        reconClean: null,
        reconAtMs: null,
        avgSlippageBps: 5,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, false);
    assert.equal(g.checks.find((c) => c.id === "recon.clean")?.status, "MISSING");
  });

  test("Paper-Gate: saubere frische Reconciliation + Stichprobe besteht", () => {
    const g = evaluatePaperGate(
      {
        windowStartMs: NOW - 10 * 24 * 3600_000,
        windowEndMs: NOW - 1000,
        availableAtMs: NOW - 3600_000,
        trades: 30,
        reconClean: true,
        reconAtMs: NOW - 3600_000,
        avgSlippageBps: 5,
      },
      DEFAULT_PROMOTION_POLICY,
      NOW
    );
    assert.equal(g.ok, true, JSON.stringify(g.checks));
  });

  test("Policy-Version ändert sich bei Wertänderung, bleibt bei identischen Werten", () => {
    const a = resolvePromotionPolicy();
    const b = resolvePromotionPolicy();
    assert.equal(a.version, b.version);
    assert.equal(a.version, DEFAULT_PROMOTION_POLICY.version);
    const c = resolvePromotionPolicy({ paperMinTrades: 50 });
    assert.notEqual(c.version, a.version);
    assert.equal(c.paperMinTrades, 50);
    assert.match(c.version, /^slp1:[0-9a-f]{64}$/);
  });
});

describe("drift evaluation", () => {
  const base = {
    winRate: 0.55,
    profitFactor: 1.2,
    avgTradePnl: 0.001,
    maxDrawdownPct: 10,
    avgSlippageBps: 5,
    dataQualityScore: 0.95,
  };

  function pairs(overrides: Partial<Record<string, { v: number | null; n: number | null }>>) {
    return DRIFT_METRIC_SPECS.map((spec) => {
      const o = overrides[spec.key];
      return {
        key: spec.key,
        baseline: metricWindow(
          o?.v !== undefined ? o.v : base[spec.key as keyof typeof base],
          o?.n ?? 100,
          NOW - 3600_000,
          NOW
        ),
        current: metricWindow(
          o?.v !== undefined ? o.v : base[spec.key as keyof typeof base],
          o?.n ?? 100,
          NOW - 60_000,
          NOW
        ),
      };
    });
  }

  test("identische Metriken ⇒ OK", () => {
    const r = evaluateDrift(pairs({}), DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "OK");
    assert.equal(r.recommendedAction, "NONE");
    assert.equal(r.policyVersion, DEFAULT_DRIFT_POLICY.version);
  });

  test("Drawdown-Breach ⇒ scale-down/degrade, nie Risikoerhöhung", () => {
    const p = pairs({});
    // risk segment: maxDrawdownPct current viel schlechter
    const idx = p.findIndex((x) => x.key === "maxDrawdownPct");
    p[idx] = {
      ...p[idx],
      current: metricWindow(35, 100, NOW - 60_000, NOW),
    };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "BREACH");
    assert.notEqual(r.recommendedAction, "NONE");
    assert.ok(["SCALE_DOWN", "DEGRADE", "PAUSE"].includes(r.recommendedAction));
    const risk = r.segments.find((s) => s.segment === "risk");
    assert.equal(risk?.verdict, "BREACH");
  });

  test("fehlende Current-Metrik ⇒ INCONCLUSIVE (fail-closed), kein OK", () => {
    const p = pairs({});
    const idx = p.findIndex((x) => x.key === "winRate");
    p[idx] = {
      ...p[idx],
      current: metricWindow(null, 50, NOW - 60_000, NOW),
    };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.notEqual(r.recommendedAction, "NONE");
    assert.ok(["DEGRADE", "SCALE_DOWN", "PAUSE"].includes(r.recommendedAction));
  });

  test("zu kleine Stichprobe ⇒ INCONCLUSIVE", () => {
    const p = pairs({});
    p[0] = {
      ...p[0],
      current: metricWindow(0.5, 3, NOW - 60_000, NOW),
      baseline: metricWindow(0.5, 3, NOW - 3600_000, NOW),
    };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "INCONCLUSIVE");
    const perf = r.segments.find((s) => s.segment === "performance");
    assert.equal(perf?.verdict, "INCONCLUSIVE");
  });

  test("stale Metrik (availableAt zu alt) ⇒ INCONCLUSIVE", () => {
    const p = pairs({});
    p[0] = {
      ...p[0],
      current: metricWindow(0.55, 100, NOW - DEFAULT_DRIFT_POLICY.maxMetricAgeMs - 1000, NOW),
    };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "INCONCLUSIVE");
  });

  test("mehrere Segmente breach + Confidence ⇒ PAUSE-Empfehlung möglich", () => {
    const p = pairs({});
    const iDd = p.findIndex((x) => x.key === "maxDrawdownPct");
    const iSlip = p.findIndex((x) => x.key === "avgSlippageBps");
    p[iDd] = { ...p[iDd], current: metricWindow(40, 100, NOW - 1000, NOW) };
    p[iSlip] = { ...p[iSlip], current: metricWindow(80, 100, NOW - 1000, NOW) };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    assert.equal(r.verdict, "BREACH");
    assert.ok(["DEGRADE", "PAUSE"].includes(r.recommendedAction));
  });

  test("null-Baseline nie als 0 gewertet", () => {
    const p = pairs({});
    p[0] = {
      ...p[0],
      baseline: metricWindow(null, 100, NOW - 3600_000, NOW),
    };
    const r = evaluateDrift(p, DEFAULT_DRIFT_POLICY, NOW);
    const m = r.segments.find((s) => s.segment === "performance")?.metrics[0];
    assert.equal(m?.reasonCode, "NULL_VALUE");
    assert.equal(m?.baselineValue, null);
  });
});

describe("order gate: off/monitor/enforce", () => {
  const liveState = {
    state: "LIVE",
    riskScale: 1,
    cooldownUntilMs: null,
    lastEvidenceAvailableAtMs: NOW - 3600_000,
    stateSeq: 5,
  };

  test("off: immer Allow (Default, rückwärtskompatibel)", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "off",
      strategyKey: null,
      strategyVersion: null,
      state: null,
      nowMs: NOW,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.code, "LIFECYCLE_DISABLED");
    assert.equal(d.blocked, false);
  });

  test("enforce ohne Strategie ⇒ Deny (STRATEGY_REQUIRED)", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "enforce",
      strategyKey: null,
      strategyVersion: null,
      state: null,
      nowMs: NOW,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.blocked, true);
    assert.equal(d.code, "STRATEGY_REQUIRED");
  });

  test("enforce ohne State-Zeile ⇒ Deny (STATE_NOT_FOUND)", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "enforce",
      strategyKey: "s1",
      strategyVersion: 1,
      state: null,
      nowMs: NOW,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "STATE_NOT_FOUND");
  });

  test("enforce LIVE + frische Evidenz ⇒ Allow mit Zustandsreferenz", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "enforce",
      strategyKey: "s1",
      strategyVersion: 1,
      state: liveState,
      nowMs: NOW,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.code, "ALLOWED");
    assert.equal(d.lifecycleState, "LIVE");
    assert.equal(d.strategyVersion, 1);
  });

  test("enforce PAUSED/DEGRADED/DRAFT ⇒ Deny", () => {
    for (const st of ["PAUSED", "DEGRADED", "DRAFT", "PAPER", "REJECTED"] as StrategyLifecycleState[]) {
      const d = evaluateLifecycleOrderGate({
        mode: "enforce",
        strategyKey: "s1",
        strategyVersion: 1,
        state: { ...liveState, state: st },
        nowMs: NOW,
      });
      assert.equal(d.allowed, false, st);
      assert.equal(d.blocked, true, st);
    }
  });

  test("enforce aktiver Cooldown ⇒ Deny", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "enforce",
      strategyKey: "s1",
      strategyVersion: 1,
      state: { ...liveState, cooldownUntilMs: NOW + 60_000 },
      nowMs: NOW,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "COOLDOWN_ACTIVE");
  });

  test("enforce stale Evidenz ⇒ Deny", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "enforce",
      strategyKey: "s1",
      strategyVersion: 1,
      state: { ...liveState, lastEvidenceAvailableAtMs: NOW - 400 * 24 * 3600_000 },
      nowMs: NOW,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.code, "EVIDENCE_STALE");
  });

  test("monitor Deny-Konstellation ⇒ allowed true + LIFECYCLE_MONITOR_ALLOW/Code sichtbar", () => {
    const d = evaluateLifecycleOrderGate({
      mode: "monitor",
      strategyKey: "s1",
      strategyVersion: 1,
      state: { ...liveState, state: "PAUSED" },
      nowMs: NOW,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.blocked, false);
    assert.equal(d.code, "STATE_PAUSED");
  });

  test("Config: unbekannter Modus ⇒ off", () => {
    const cfg = strategyLifecycleConfig({ STRATEGY_LIFECYCLE_MODE: "banana" });
    assert.equal(cfg.mode, "off");
    const enforce = strategyLifecycleConfig({ STRATEGY_LIFECYCLE_MODE: "enforce" });
    assert.equal(enforce.mode, "enforce");
  });
});

describe("riskGuard integration: Lifecycle-Faktor + PAUSE-Veto", () => {
  test("Faktor 0.5 senkt maxRiskPerTrade, Boden bleibt Code-Minimum", () => {
    __resetAllSingletonsForTests();
    const before = getLimits().maxRiskPerTrade;
    applyStrategyLifecycleScale({
      factor: 0.5,
      paused: false,
      at: new Date(NOW).toISOString(),
      reason: "test",
      mode: "active",
      policyVersion: "slp1:test",
      state: "DEGRADED",
    });
    const after = getLimits().maxRiskPerTrade;
    assert.ok(after < before, `${after} < ${before}`);
    assert.ok(after >= 0.002);
    applyStrategyLifecycleScale(null);
    assert.equal(getLimits().maxRiskPerTrade, before);
  });

  test("Faktor > 1 wird geklemmt (nie risikoerhöhend)", () => {
    __resetAllSingletonsForTests();
    const before = getLimits().maxRiskPerTrade;
    applyStrategyLifecycleScale({
      factor: 5,
      paused: false,
      at: new Date(NOW).toISOString(),
      reason: "evil",
      mode: "active",
      policyVersion: "x",
      state: "LIVE",
    });
    assert.equal(getLimits().maxRiskPerTrade, before);
    applyStrategyLifecycleScale(null);
  });

  test("paused=true vetot neue Einstiege in validateOrder", () => {
    __resetAllSingletonsForTests();
    applyStrategyLifecycleScale({
      factor: 1,
      paused: true,
      at: new Date(NOW).toISOString(),
      reason: "lifecycle:PAUSED",
      mode: "active",
      policyVersion: "x",
      state: "PAUSED",
    });
    assert.equal(strategyLifecyclePauseState().blocked, true);
    const guard = validateOrder({
      notional: 100,
      equity: 10_000,
      openPositions: 0,
      side: "LONG",
      leverage: 1,
      hasStopLoss: true,
      symbol: "BTC/USDT",
    });
    assert.equal(guard.allowed, false);
    assert.ok(
      guard.blockedBy.some((b) => b.startsWith("strategy-lifecycle-pause")),
      guard.blockedBy.join("|")
    );
    applyStrategyLifecycleScale(null);
    const after = validateOrder({
      notional: 100,
      equity: 10_000,
      openPositions: 0,
      side: "LONG",
      leverage: 1,
      hasStopLoss: true,
      symbol: "BTC/USDT",
    });
    assert.equal(after.allowed, true);
  });
});

describe("execution gates: Lifecycle-Gate vor Live-Submit", () => {
  function liveCtx(over: Partial<GateContext> = {}): GateContext {
    return {
      venue: "BITUNIX" as BrokerVenueId,
      mode: "live",
      symbol: "BTCUSDT",
      side: "LONG",
      qty: 0.01,
      price: 100,
      hasStopLoss: true,
      quote: {
        mid: 100,
        bid: 99.9,
        ask: 100.1,
        spread: 0.002,
        eventTime: NOW - 1000,
        availableAt: NOW - 1000,
      },
      account: { equity: 10_000, openPositions: 0 },
      now: NOW,
      maxSpreadBps: 50,
      maxQuoteAgeMs: 60_000,
      maxNotional: 0,
      minQuantity: 0.001,
      quantityStep: 0.001,
      liveGateAllowed: () => ({ allowed: true, code: "ALLOWED" }),
      ...over,
    };
  }

  test("Lifecycle-Deny blockiert Live-Order mit LIFECYCLE_GATE_DENY", () => {
    const d = evaluateSubmitGates(
      liveCtx({
        lifecycleGate: () => ({
          allowed: false,
          code: "STATE_NOT_LIVE",
        }),
      }),
      "SUBMIT"
    );
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "LIFECYCLE_GATE_DENY");
  });

  test("Lifecycle-Allow + Live-Gate-Allow ⇒ OK", () => {
    const d = evaluateSubmitGates(
      liveCtx({
        lifecycleGate: () => ({
          allowed: true,
          code: "ALLOWED",
          strategyKey: "s1",
          strategyVersion: 2,
          lifecycleState: "LIVE",
        }),
      }),
      "SUBMIT"
    );
    assert.equal(d.allowed, true, d.reason);
    assert.equal(d.reason, "OK");
  });

  test("ohne lifecycleGate-Callback bleibt bestehendes Live-Gate-Verhalten (kompatibel)", () => {
    const d = evaluateSubmitGates(liveCtx(), "SUBMIT");
    assert.equal(d.allowed, true, d.reason);
  });
});

describe("evidence keys", () => {
  test("Content-Hash und Transition-Key sind stabil und präfixiert", () => {
    const input = {
      strategyKey: "alpha",
      strategyVersion: 1,
      kind: "BACKTEST_RUN" as const,
      result: "PASS" as const,
      codeVersion: "1.73.0",
      policyVersion: "slp1:x",
      snapshot: {
        metrics: { winRate: 0.5, profitFactor: null },
        sampleSize: 30,
        windowStartMs: 1,
        windowEndMs: 2,
      },
      eventTimeMs: 10,
      availableAtMs: 20,
      computedAtMs: 30,
    };
    const h1 = evidenceContentHash(input);
    const h2 = evidenceContentHash({ ...input });
    assert.equal(h1, h2);
    assert.match(h1, /^sle1:[0-9a-f]{64}$/);
    assert.match(evidenceIdempotencyKey(h1), /^slei1:[0-9a-f]{64}$/);
    // null ≠ 0 im Hash
    const hNull = evidenceContentHash({
      ...input,
      snapshot: { ...input.snapshot, metrics: { winRate: 0.5, profitFactor: null } },
    });
    const hZero = evidenceContentHash({
      ...input,
      snapshot: { ...input.snapshot, metrics: { winRate: 0.5, profitFactor: 0 } },
    });
    assert.notEqual(hNull, hZero);

    const k1 = transitionKey({
      strategyKey: "alpha",
      strategyVersion: 1,
      from: "DRAFT",
      to: "BACKTEST_PENDING",
      nonce: "a",
    });
    assert.match(k1, /^slt1:[0-9a-f]{64}$/);
    const k2 = transitionKey({
      strategyKey: "alpha",
      strategyVersion: 1,
      from: "DRAFT",
      to: "BACKTEST_PENDING",
      nonce: "b",
    });
    assert.notEqual(k1, k2);
  });

  test("normalizeStrategyKey/version lehnt ungültige Identität ab", () => {
    assert.equal(normalizeStrategyKey("alpha"), "alpha");
    assert.equal(normalizeStrategyKey(""), null);
    assert.equal(normalizeStrategyKey("a b"), null);
    assert.equal(normalizeStrategyKey("x".repeat(200)), null);
    assert.equal(normalizeStrategyVersion(1), 1);
    assert.equal(normalizeStrategyVersion(0), null);
    assert.equal(normalizeStrategyVersion(1.5), null);
    assert.equal(normalizeStrategyVersion("x"), null);
  });
});

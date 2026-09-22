/**
 * RMA-P5-05: versionierte Signal-Decay-Exits — pure Funktion, Priorität,
 * Look-ahead-Audit und Backtest-Parität. Keine DB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideExit, DEFAULT_EXIT_CONFIG } from "../src/lib/exits";
import {
  SIGNAL_CONTRACT_VERSION,
  SIGNAL_CONFIG_VERSION,
  SIGNAL_FEATURE_VERSION,
  SIGNAL_MODEL_VERSION,
  SIGNAL_SEMANTICS_VERSION,
  buildAudit,
  evaluateSignalDecay,
  loadSignalDecayConfig,
  previewSignalDecayOverride,
  resolveSignalDecayConfig,
  type SignalDecayConfig,
  type SignalDecayInput,
  type SignalSnapshot,
} from "../src/lib/signalDecay";
import { stepBacktestSignalDecay, createBacktestSignalDecayRuntime } from "../src/backtest/signalDecay";
import { runMultiAssetBacktest } from "../src/backtest";
import type { CandleLike, RuleSpec } from "../src/lib/ruleEngine";

const T0 = Date.parse("2026-09-22T12:00:00.000Z");

function snap(partial: Partial<SignalSnapshot> & { availableAt: string; strength: number; direction: "LONG" | "SHORT" | "FLAT" }): SignalSnapshot {
  return {
    contractVersion: SIGNAL_CONTRACT_VERSION,
    semanticsVersion: SIGNAL_SEMANTICS_VERSION,
    featureVersion: SIGNAL_FEATURE_VERSION,
    modelVersion: SIGNAL_MODEL_VERSION,
    configVersion: SIGNAL_CONFIG_VERSION,
    confidence: 0.9,
    calculatedAsOf: partial.availableAt,
    computedAt: partial.availableAt,
    coverage: 1,
    strategyClass: "trend",
    migrationId: null,
    ...partial,
  };
}

function policy(mode: "monitor" | "active", patch: Record<string, unknown> = {}): SignalDecayConfig {
  return resolveSignalDecayConfig({
    mode,
    classes: {
      trend: {
        enabled: true,
        minHoldMs: 0,
        confirmationCount: 3,
        halfLifeMs: null,
        absoluteDrop: 0.3,
        relativeDrop: 0.9,
        thresholdMode: "absolute",
        reversalEnabled: true,
        reversalMinStrength: 0.35,
        reversalMinConfidence: 0.6,
        maxStalenessMs: 2 * 3_600_000,
        minCoverage: 0.75,
        ...patch,
      },
    },
  });
}

function input(over: Partial<SignalDecayInput> & Pick<SignalDecayInput, "entry" | "current" | "config">): SignalDecayInput {
  return {
    openedAtMs: T0,
    asOfMs: T0 + 3_600_000,
    side: "LONG",
    qty: 2,
    entryPrice: 100,
    markPrice: 110,
    strategyClass: "trend",
    confirmation: { streak: 0, lastObservationKey: null, policyVersion: null },
    mode: over.config.mode,
    killSwitchArmed: false,
    ...over,
  };
}

function step(cfg: SignalDecayConfig, currents: SignalSnapshot[], entry: SignalSnapshot) {
  let streak = 0;
  let lastKey: string | null = null;
  let policyVersion: string | null = null;
  const evals = [];
  for (const current of currents) {
    const evaluation = evaluateSignalDecay(input({
      entry,
      current,
      config: cfg,
      confirmation: { streak, lastObservationKey: lastKey, policyVersion },
    }));
    evals.push(evaluation);
    streak = evaluation.streak;
    lastKey = evaluation.observationKey;
    policyVersion = evaluation.policyVersion;
  }
  return evals;
}

describe("Signal-Decay pure Funktion (RMA-P5-05)", () => {
  const entry = snap({ availableAt: new Date(T0).toISOString(), strength: 0.8, direction: "LONG" });

  it("stabiles Signal schließt nicht und setzt die Bestätigung zurück", () => {
    const cfg = policy("active");
    const currents = [0, 1, 2].map((i) => snap({
      availableAt: new Date(T0 + (i + 1) * 60_000).toISOString(),
      strength: 0.78,
      direction: "LONG",
    }));
    const evals = step(cfg, currents, entry);
    assert.equal(evals.at(-1)?.reasonCode, "HOLD");
    assert.equal(evals.at(-1)?.shouldExit, false);
    assert.equal(evals.at(-1)?.streak, 0);
  });

  it("langsamer Verfall unter der Schwelle ist kein Exit", () => {
    const cfg = policy("active");
    const slow = snap({ availableAt: new Date(T0 + 60_000).toISOString(), strength: 0.6, direction: "LONG" });
    const evaluation = evaluateSignalDecay(input({ entry, current: slow, config: cfg }));
    assert.equal(evaluation.breach, false);
    assert.equal(evaluation.shouldExit, false);
    assert.notEqual(evaluation.reasonCode, "EXIT");
  });

  it("harte Umkehr braucht die konfigurierte Bestätigung und ist kein Time-Stop", () => {
    const cfg = policy("active", { confirmationCount: 2 });
    const reversal = (i: number) => snap({
      availableAt: new Date(T0 + (i + 1) * 60_000).toISOString(),
      strength: 0.7,
      direction: "SHORT",
      confidence: 0.8,
    });
    const evals = step(cfg, [reversal(0), reversal(1)], entry);
    assert.equal(evals[0]?.reasonCode, "CONFIRMING");
    assert.equal(evals[0]?.shouldExit, false);
    assert.equal(evals[1]?.reasonCode, "EXIT");
    assert.equal(evals[1]?.breachKind, "REVERSAL");
    assert.equal(evals[1]?.shouldExit, true);
    assert.notEqual(evals[1]?.reasonCode, "MIN_HOLD");
  });

  it("Rauschen setzt die Hysterese zurück; dieselbe Beobachtung zählt nicht doppelt", () => {
    const cfg = policy("active", { confirmationCount: 3 });
    const decay = (i: number, strength: number) => snap({
      availableAt: new Date(T0 + (i + 1) * 60_000).toISOString(),
      strength,
      direction: "LONG",
    });
    const noisy = step(cfg, [decay(0, 0.4), decay(1, 0.4), decay(2, 0.75), decay(3, 0.4)], entry);
    assert.equal(noisy[1]?.streak, 2);
    assert.equal(noisy[2]?.streak, 0);
    assert.equal(noisy[3]?.streak, 1);
    assert.equal(noisy[3]?.shouldExit, false);

    const again = evaluateSignalDecay(input({
      entry,
      current: decay(3, 0.4),
      config: cfg,
      confirmation: {
        streak: noisy[3]!.streak,
        lastObservationKey: noisy[3]!.observationKey,
        policyVersion: noisy[3]!.policyVersion,
      },
    }));
    assert.equal(again.duplicate, true);
    assert.equal(again.streak, noisy[3]?.streak);
    assert.equal(again.shouldExit, false);
  });

  it("fehlend, stale und inkompatibel erzwingen keinen Signal-Exit", () => {
    const cfg = policy("active", { confirmationCount: 1 });
    const missing = evaluateSignalDecay(input({ entry, current: null, config: cfg }));
    assert.equal(missing.reasonCode, "MISSING_CURRENT");
    assert.equal(missing.shouldExit, false);

    const legacy = evaluateSignalDecay(input({ entry: null, current: entry, config: cfg }));
    assert.equal(legacy.reasonCode, "MISSING_ENTRY");
    assert.equal(legacy.shouldExit, false);

    const stale = evaluateSignalDecay(input({
      entry,
      current: snap({
        availableAt: new Date(T0 - 5 * 3_600_000).toISOString(),
        strength: 0.1,
        direction: "SHORT",
      }),
      asOfMs: T0 + 3_600_000,
      config: cfg,
    }));
    assert.equal(stale.reasonCode, "STALE");
    assert.equal(stale.shouldExit, false);
    assert.equal(stale.streak, 0);

    const foreign = evaluateSignalDecay(input({
      entry,
      current: snap({
        availableAt: new Date(T0 + 60_000).toISOString(),
        strength: 0.1,
        direction: "SHORT",
        semanticsVersion: "mkt-sig-other",
      }),
      config: cfg,
    }));
    assert.equal(foreign.reasonCode, "INCOMPATIBLE");
    assert.equal(foreign.shouldExit, false);
  });

  it("Zukunftssignal wird verworfen und steht nicht im Audit", () => {
    const cfg = policy("active", { confirmationCount: 1 });
    const futureIso = new Date(T0 + 2 * 3_600_000).toISOString();
    const future = snap({ availableAt: futureIso, strength: 0.1, direction: "SHORT" });
    const asOfMs = T0 + 3_600_000;
    const evaluation = evaluateSignalDecay(input({ entry, current: future, asOfMs, config: cfg }));
    assert.equal(evaluation.reasonCode, "FUTURE");
    assert.equal(evaluation.shouldExit, false);
    const audit = evaluation.audit ?? buildAudit(input({ entry, current: future, asOfMs, config: cfg }), evaluation, cfg.classes.trend);
    assert.equal(audit.currentStrength, null);
    assert.equal(audit.currentAvailableAt, null);
    assert.equal(JSON.stringify(audit).includes(futureIso), false);
  });

  it("Monitor schließt nicht; Kill-Switch unterdrückt SIGNAL_DECAY", () => {
    const confirmed = {
      streak: 2,
      lastObservationKey: null,
      policyVersion: null,
    };
    const current = snap({ availableAt: new Date(T0 + 60_000).toISOString(), strength: 0.7, direction: "SHORT", confidence: 0.9 });
    const monitor = evaluateSignalDecay(input({
      entry,
      current,
      config: policy("monitor", { confirmationCount: 1 }),
      confirmation: confirmed,
    }));
    assert.equal(monitor.wouldExit, true);
    assert.equal(monitor.shouldExit, false);
    assert.equal(monitor.reasonCode, "WOULD_EXIT");

    const armed = evaluateSignalDecay(input({
      entry,
      current,
      config: policy("active", { confirmationCount: 1 }),
      confirmation: confirmed,
      killSwitchArmed: true,
    }));
    assert.equal(armed.reasonCode, "SUPPRESSED_KILL_SWITCH");
    assert.equal(armed.shouldExit, false);
  });

  it("Safety-Exits bleiben vor SIGNAL_DECAY", () => {
    const cfg = policy("active", { confirmationCount: 1 });
    const current = snap({ availableAt: new Date(T0 + 60_000).toISOString(), strength: 0.7, direction: "SHORT", confidence: 0.9 });
    const signal = input({ entry, current, config: cfg });
    const sl = decideExit({
      side: "LONG",
      entryPrice: 100,
      price: 90,
      stopLoss: 95,
      takeProfit: 120,
      trailingStop: null,
      trailingArmed: false,
      createdAtMs: T0,
      nowMs: T0 + 3_600_000,
      signal,
    }, DEFAULT_EXIT_CONFIG);
    assert.equal(sl.reason, "STOP_LOSS");
    assert.equal(sl.signalDecay?.shouldExit, true);

    const time = decideExit({
      side: "LONG",
      entryPrice: 100,
      price: 110,
      stopLoss: 90,
      takeProfit: 130,
      trailingStop: null,
      trailingArmed: false,
      createdAtMs: T0,
      nowMs: T0 + 5 * 3_600_000,
      signal,
    }, { ...DEFAULT_EXIT_CONFIG, timeStopHours: 1 });
    assert.equal(time.reason, "TIME_STOP");
    assert.notEqual(time.reason, "SIGNAL_DECAY");

    const only = decideExit({
      side: "LONG",
      entryPrice: 100,
      price: 110,
      stopLoss: 90,
      takeProfit: 130,
      trailingStop: null,
      trailingArmed: false,
      createdAtMs: T0,
      nowMs: T0 + 3_600_000,
      signal,
    }, DEFAULT_EXIT_CONFIG);
    assert.equal(only.reason, "SIGNAL_DECAY");
  });

  it("ohne Signal-Kontext bleibt der Preis-Pfad ohne SIGNAL_DECAY", () => {
    const decision = decideExit({
      side: "LONG",
      entryPrice: 100,
      price: 110,
      stopLoss: 90,
      takeProfit: 130,
      trailingStop: null,
      trailingArmed: false,
      createdAtMs: T0,
      nowMs: T0,
    }, DEFAULT_EXIT_CONFIG);
    assert.equal(decision.reason, null);
    assert.equal(decision.signalDecay, null);
  });

  it("Backtest-Schritt und Runtime nutzen dieselbe Entscheidung", () => {
    const runtime = createBacktestSignalDecayRuntime({
      mode: "active",
      strategyClass: "trend",
      policy: { confirmationCount: 1, minHoldMs: 0, halfLifeMs: null },
    }, 3_600_000);
    assert.ok(runtime);
    const current = snap({ availableAt: new Date(T0 + 60_000).toISOString(), strength: 0.2, direction: "LONG" });
    const shared = input({ entry, current, config: runtime.config, asOfMs: T0 + 60_000 });
    const pure = evaluateSignalDecay(shared);
    const stepped = stepBacktestSignalDecay({
      runtime,
      position: {
        side: "LONG",
        qty: 2,
        entryPrice: 100,
        openedAtMs: T0,
        entrySignal: entry,
        streak: 0,
        lastKey: null,
        policyVersion: null,
        strategyClass: "trend",
      },
      current,
      asOfMs: T0 + 60_000,
      markPrice: 110,
      exitConfig: DEFAULT_EXIT_CONFIG,
    });
    assert.equal(stepped.evaluation.reasonCode, pure.reasonCode);
    assert.equal(stepped.decision.reason, pure.shouldExit ? "SIGNAL_DECAY" : null);
    assert.equal(stepped.close, pure.shouldExit);
  });

  it("unbekannter Modus fällt auf monitor; Klassen bleiben default-off", () => {
    const cfg = loadSignalDecayConfig({ SIGNAL_DECAY_MODE: "live-please" });
    assert.equal(cfg.mode, "monitor");
    assert.equal(cfg.classes.trend.enabled, false);
    assert.equal(cfg.classes.unclassified.enabled, false);
    const preview = previewSignalDecayOverride("sdc.trend.absoluteDrop", 5);
    assert.equal(preview.ok, true);
    if (preview.ok) assert.equal(preview.stored, 0.95);
    const bad = previewSignalDecayOverride("sdc.nope.enabled", 1);
    assert.equal(bad.ok, false);
  });
});

describe("Backtest-Engine Signal-Decay (RMA-P5-05)", () => {
  const H = 3_600_000;
  const start = Date.UTC(2024, 0, 1);

  function candles(): CandleLike[] {
    return Array.from({ length: 40 }, (_, i) => ({
      time: start + i * H,
      open: 110,
      high: 111,
      low: 109,
      close: 110,
      volume: 1000,
    }));
  }

  function rule(): RuleSpec {
    return {
      name: "Preis über 100",
      symbol: "SDTEST",
      missionId: null,
      rationale: "Test",
      sourceRole: "MANUAL",
      riskScore: 0.2,
      condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: 100 }] },
      action: {
        side: "LONG",
        stopLossPct: 20,
        takeProfitRR: 5,
        riskBudgetPct: 0.02,
        maxPositionPct: 0.2,
        positionSizeMode: "risk",
      },
      window: {
        timeframe: "1h",
        validFrom: null,
        validUntil: null,
        maxExecutionsPerDay: 5,
        cooldownMinutes: 0,
        volumeWindow: 20,
      },
    };
  }

  function signalAt(asOfMs: number): SignalSnapshot {
    const entryBar = start + 30 * H;
    return snap({
      availableAt: new Date(asOfMs).toISOString(),
      strength: asOfMs <= entryBar ? 0.9 : 0.2,
      direction: "LONG",
      strategyClass: "trend",
    });
  }

  it("ohne Option kein Summary und kein SIGNAL_DECAY", () => {
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([["SDTEST", candles()]]),
      strategies: [{ type: "rule", spec: rule(), id: "R-SD" }],
      config: { initialCapital: 10_000, warmupBars: 30, enableShorts: false },
    });
    assert.equal(result.signalDecay, undefined);
    assert.equal(result.trades.some((t) => t.exitReason === "SIGNAL_DECAY"), false);
  });

  it("active schließt mit SIGNAL_DECAY; monitor nur Counterfactual", () => {
    const base = {
      candlesBySymbol: new Map([["SDTEST", candles()]]),
      strategies: [{ type: "rule" as const, spec: rule(), id: "R-SD" }],
    };
    const active = runMultiAssetBacktest({
      ...base,
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        enableShorts: false,
        signalDecay: {
          mode: "active",
          strategyClass: "trend",
          policy: { confirmationCount: 2, minHoldMs: 0, halfLifeMs: null, absoluteDrop: 0.3 },
          timeBasis: "close",
          signalAt: ({ asOfMs }) => signalAt(asOfMs),
        },
      },
    });
    assert.ok(active.signalDecay);
    assert.equal(active.signalDecay?.mode, "active");
    assert.ok((active.signalDecay?.exits ?? 0) >= 1);
    assert.equal(active.trades.some((t) => t.exitReason === "SIGNAL_DECAY"), true);

    const monitor = runMultiAssetBacktest({
      ...base,
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        enableShorts: false,
        signalDecay: {
          mode: "monitor",
          strategyClass: "trend",
          policy: { confirmationCount: 2, minHoldMs: 0, halfLifeMs: null, absoluteDrop: 0.3 },
          timeBasis: "close",
          signalAt: ({ asOfMs }) => signalAt(asOfMs),
        },
      },
    });
    assert.equal(monitor.trades.some((t) => t.exitReason === "SIGNAL_DECAY"), false);
    assert.ok((monitor.signalDecay?.wouldExit ?? 0) >= 1);
    assert.equal(monitor.signalDecay?.exits, 0);
  });
});

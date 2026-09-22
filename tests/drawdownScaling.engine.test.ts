/**
 * Tests: Drawdown-Risk-Scaling Engine (LIVE-Orchestrator, RMA-P5-04, v1.68.0).
 *
 * Deckt die Pflicht-Paths mit INJIZIERTEN Dependencies ab (kein echtes DB,
 * kein echter Broker):
 *   - monitor-Modus (Default): Persistenz + Status, Faktorwirkung NEIN
 *   - active-Modus: Faktor wirkt auf die Risk-Guard-Kaskade + Persistenz
 *     (`dsp.activeFactor`/`dsp.activeAt`/`dsp.pause`)
 *   - off-Modus: Faktor und PAUSE werden zurückgenommen (Rollback-Pfad)
 *   - Komposition: wirksames Budget = Basis × Drawdown-Faktor (nie > Basis)
 *   - PAUSE: Veto für neue Einstiege über die Authority Chain (`validateOrder`)
 *   - Fail-closed: fehlende/stale/nicht abgeglichene Equity ⇒ minFactor
 *   - Einzahlung verändert den High-Water-Mark nicht
 *   - Idempotenz: Retry in derselben Minute ⇒ keine doppelte Zeile
 *   - Neustart: identischer HWM/Faktor aus der persistierten Zeile
 *   - Min-Interval/Single-Flight
 *   - Status-API (synchron) spiegelt den letzten Lauf
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __resetDrawdownScalingForTests,
  getDrawdownScalingStatus,
  updateDrawdownScaling,
  type DdsDbLike,
  type DrawdownScalingDeps,
} from "../src/lib/drawdownScaling";
import {
  drawdownStateFromRow,
  resolveDrawdownScalingConfig,
  type DrawdownEquityObservation,
  type DrawdownReconciliationGate,
} from "../src/portfolio/drawdownScaling";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import {
  applyDrawdownScaling,
  drawdownPauseState,
  getBaseLimits,
  getDrawdownScalingState,
  getLimits,
  validateOrder,
} from "../src/lib/riskGuard";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Doppel: strukturelles DdsDbLike mit Zustands-Rekonstruktion
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRow {
  [k: string]: unknown;
}

class FakeDdsDb implements DdsDbLike {
  /** Alle Snapshot-Rows (inserts in drawdownScalingSnapshots). */
  readonly snapshots: FakeRow[] = [];
  /** risk_config-Keys (dsp.*). */
  readonly riskConfig = new Map<string, string>();
  /** Simulierte `risk_config`-Zeilen für den Konfig-Load. */
  readonly riskConfigRows: { key: string; value: string }[] = [];
  snapshotInserts = 0;
  riskConfigUpserts = 0;
  private seenSnapshotIds = new Set<string>();

  select() {
    const self = this;
    return {
      async from(_t: unknown): Promise<FakeRow[]> {
        return self.riskConfigRows.map((r) => ({ ...r }));
      },
    };
  }

  insert(_t: unknown) {
    const self = this;
    return {
      values(v: Record<string, unknown>) {
        return {
          onConflictDoNothing() {
            return {
              async returning(_f?: unknown): Promise<FakeRow[]> {
                self.snapshotInserts += 1;
                const id = v.snapshotId as string;
                if (self.seenSnapshotIds.has(id)) return [];
                self.seenSnapshotIds.add(id);
                self.snapshots.push(v);
                return [{ id: self.snapshots.length }];
              },
            };
          },
          async onConflictDoUpdate() {
            self.riskConfigUpserts += 1;
            self.riskConfig.set(v.key as string, v.value as string);
          },
        };
      },
    };
  }

  /** DB-shape der jüngsten Zeile (NUMERIC kommt als String, Timestamps als Date). */
  lastPersistedRow(): Parameters<typeof drawdownStateFromRow>[0] | null {
    const s = this.snapshots[this.snapshots.length - 1];
    if (!s) return null;
    const str = (v: unknown): string | number | null => (v as string | number | null) ?? null;
    const dt = (v: unknown): string | Date | null => (v as string | Date | null) ?? null;
    return {
      hwm: str(s.hwm),
      appliedFactor: str(s.appliedFactor),
      cumulativeNetFlow: str(s.cumulativeNetFlow),
      lastEquity: str(s.lastEquity),
      lastObservationAt: dt(s.lastObservationAt),
      lastTradingPnl: str(s.lastTradingPnl),
      lastDegradeAt: dt(s.lastDegradeAt),
      lastTransitionAt: dt(s.lastTransitionAt),
      recoveryStreak: s.recoveryStreak as number,
      stage: (s.stage as string | null) ?? null,
      policyVersion: (s.policyVersion as string | null) ?? null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MIN = 60_000;

/** Referenzzeit: aktuelle Minute (das Min-Interval nutzt `Date.now`). */
function makeNow(): number {
  return Math.floor(Date.now() / MIN) * MIN;
}

function obs(p: Partial<DrawdownEquityObservation> & { equity: number }): DrawdownEquityObservation {
  return {
    availableAt: makeNow(),
    baselineEquity: 10_000,
    tradingPnl: { realized: 0, unrealized: 0 },
    reconciliation: { at: makeNow(), clean: true },
    source: "db-snapshot:TICK",
    ...p,
  };
}

const CLEAN_RECON: DrawdownReconciliationGate = { at: makeNow(), clean: true };

/**
 * Deps-Fabrik. Der Zustand wird standardmäßig aus der Fake-DB rekonstruiert
 * (`drawdownStateFromRow` über die jüngste Zeile) — genau wie im Neustart-Pfad.
 */
function makeDeps(opts: {
  db?: FakeDdsDb;
  now?: number;
  observation?: DrawdownEquityObservation | null;
  reconciliation?: DrawdownReconciliationGate | null;
  withStateReader?: boolean;
} = {}): { deps: DrawdownScalingDeps; db: FakeDdsDb } {
  const db = opts.db ?? new FakeDdsDb();
  const now = opts.now ?? makeNow();
  const deps: DrawdownScalingDeps = {
    now: () => now,
    db,
    readEquity: async () => opts.observation ?? null,
    readReconciliation: async () =>
      opts.reconciliation === undefined ? CLEAN_RECON : opts.reconciliation,
  };
  if (opts.withStateReader !== false) {
    deps.readState = async () => {
      const row = db.lastPersistedRow();
      return row ? drawdownStateFromRow(row) : null;
    };
  }
  return { deps, db };
}

function testConfig(overrides: Record<string, number | boolean> = {}) {
  return resolveDrawdownScalingConfig({
    softThresholdPct: 5,
    hardThresholdPct: 12,
    minFactor: 0.25,
    pauseThresholdPct: 15,
    recoveryCooldownMs: 60 * MIN,
    recoveryConfirmations: 2,
    recoveryStep: 0.05,
    enabled: true,
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

function setMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env.DRAWDOWN_SCALING_MODE;
  else process.env.DRAWDOWN_SCALING_MODE = mode;
}

beforeEach(() => {
  savedEnv.DRAWDOWN_SCALING_MODE = process.env.DRAWDOWN_SCALING_MODE;
  savedEnv.AUDIT_SPOOL_DIR = process.env.AUDIT_SPOOL_DIR;
  savedEnv.AUDIT_RETRY_MAX = process.env.AUDIT_RETRY_MAX;
  savedEnv.AUDIT_RETRY_BASE_MS = process.env.AUDIT_RETRY_BASE_MS;
  savedEnv.AUDIT_DB_COOLDOWN_MS = process.env.AUDIT_DB_COOLDOWN_MS;
  process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "dds-engine-audit-"));
  process.env.AUDIT_RETRY_MAX = "1";
  process.env.AUDIT_RETRY_BASE_MS = "5";
  process.env.AUDIT_DB_COOLDOWN_MS = "0";
  __resetDrawdownScalingForTests();
  __resetAllSingletonsForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetDrawdownScalingForTests();
  __resetAllSingletonsForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Modi
// ─────────────────────────────────────────────────────────────────────────────

describe("Modi (Feature-Flag DRAWDOWN_SCALING_MODE)", () => {
  test("monitor (Default): Persistenz + Status, aber KEINE Faktorwirkung", async () => {
    setMode(undefined);
    const { deps, db } = makeDeps({ observation: obs({ equity: 9_000, tradingPnl: { realized: -1_000, unrealized: 0 } }) });
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    assert.equal(status.mode, "monitor");
    assert.equal(status.active, false);
    assert.equal(status.status, "BOOTSTRAP");
    assert.equal(db.snapshots.length, 1, "Snapshot wird auch im monitor-Modus persistiert");
    assert.equal(db.snapshots[0].mode, "monitor");
    assert.equal(db.riskConfig.has("dsp.activeFactor"), false, "monitor ⇒ kein aktiver Faktor");
    assert.equal(getDrawdownScalingState(), null, "monitor ⇒ Kaskade unverändert");
    assert.equal(status.paused, false);
    // Status/Report sind trotzdem vollständig (Monitoring, Audit, Dashboard).
    assert.ok(status.appliedFactor > 0.25 && status.appliedFactor < 1);
    assert.equal(status.riskBudget.effective, status.riskBudget.base);
  });

  test("active: Faktor wirkt auf die Kaskade, Komposition bleibt ≤ Basis", async () => {
    setMode("active");
    const { deps, db } = makeDeps({ observation: obs({ equity: 9_000, tradingPnl: { realized: -1_000, unrealized: 0 } }) });
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    assert.equal(status.mode, "active");
    assert.equal(status.active, true);
    const factor = status.appliedFactor;
    assert.ok(factor > 0 && factor <= 1, "Faktor ∈ (0, 1]");

    const applied = getDrawdownScalingState();
    assert.ok(applied !== null, "active ⇒ Drawdown-Zustand gesetzt");
    assert.ok(Math.abs(applied!.factor - factor) < 1e-12);
    assert.equal(applied!.stage, "SOFT");

    // Komposition: wirksames Budget = Basis × Faktor, hart ≤ Basis.
    const base = getBaseLimits();
    const effective = getLimits();
    assert.ok(Math.abs(effective.maxRiskPerTrade - base.maxRiskPerTrade * factor) < 1e-12);
    assert.ok(effective.maxRiskPerTrade <= base.maxRiskPerTrade);
    assert.equal(status.riskBudget.effective, effective.maxRiskPerTrade);
    assert.equal(status.riskBudget.base, base.maxRiskPerTrade);

    // Persistenz für den Mikro-Executor.
    assert.ok(db.riskConfig.has("dsp.activeFactor"));
    assert.ok(Math.abs(Number(db.riskConfig.get("dsp.activeFactor")) - factor) < 1e-12);
    assert.equal(db.riskConfig.get("dsp.pause"), "0");
  });

  test("off: Faktor und PAUSE werden zurückgenommen (Rollback-Pfad)", async () => {
    setMode("active");
    const hot = makeDeps({ observation: obs({ equity: 8_400, tradingPnl: { realized: -1_600, unrealized: 0 } }) });
    const paused = await updateDrawdownScaling({ deps: hot.deps, config: testConfig(), force: true });
    assert.equal(paused.stage, "PAUSE");
    assert.equal(paused.paused, true);
    assert.equal(hot.db.riskConfig.get("dsp.pause"), "1");
    assert.ok(getLimits().maxRiskPerTrade < getBaseLimits().maxRiskPerTrade);

    setMode("off");
    const off = await updateDrawdownScaling({ deps: hot.deps, config: testConfig(), force: true });
    assert.equal(off.mode, "off");
    assert.equal(off.active, false);
    assert.equal(getDrawdownScalingState(), null, "off ⇒ Faktor zurückgenommen");
    assert.equal(drawdownPauseState().blocked, false);
    assert.equal(hot.db.riskConfig.get("dsp.pause"), "0", "off ⇒ PAUSE zurückgenommen");
    assert.equal(getLimits().maxRiskPerTrade, getBaseLimits().maxRiskPerTrade);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PAUSE
// ─────────────────────────────────────────────────────────────────────────────

describe("PAUSE (Veto für neue Einstiege)", () => {
  test("ab der PAUSE-Schwelle blockiert validateOrder neue Einstiege", async () => {
    setMode("active");
    const { deps } = makeDeps({ observation: obs({ equity: 8_400, tradingPnl: { realized: -1_600, unrealized: 0 } }) });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    const pause = drawdownPauseState();
    assert.equal(pause.blocked, true);
    assert.equal(pause.stage, "PAUSE");

    const result = validateOrder({
      symbol: "TEST",
      notional: 100,
      equity: 8_400,
      leverage: 1,
      side: "LONG",
      hasStopLoss: true,
      openPositions: 0,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.blockedBy.includes("drawdown-pause:new-entries-blocked"));
  });

  test("unterhalb der PAUSE-Schwelle blockiert nichts (DEEP statt PAUSE)", async () => {
    setMode("active");
    const { deps } = makeDeps({ observation: obs({ equity: 8_800, tradingPnl: { realized: -1_200, unrealized: 0 } }) });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    assert.equal(getDrawdownScalingState()!.stage, "DEEP");
    assert.equal(drawdownPauseState().blocked, false);
    const result = validateOrder({
      symbol: "TEST",
      notional: 100,
      equity: 8_800,
      leverage: 1,
      side: "LONG",
      hasStopLoss: true,
      openPositions: 0,
    });
    assert.equal(
      result.blockedBy.includes("drawdown-pause:new-entries-blocked"),
      false,
      "kein PAUSE-Veto unterhalb der Schwelle"
    );
  });

  test("inkonsistenter Zustand (paused ohne PAUSE-Stufe) blockiert nie", () => {
    applyDrawdownScaling({
      factor: 0.5,
      stage: "SOFT",
      paused: true, // Widerspruch: wird beim Anwenden verworfen
      drawdownPct: 0.07,
      hwm: 10_000,
      policyVersion: "ddp1:" + "0".repeat(64),
      at: new Date(makeNow()).toISOString(),
      asOf: null,
      reason: "test",
      mode: "active",
    });
    assert.equal(getDrawdownScalingState()!.paused, false);
    assert.equal(drawdownPauseState().blocked, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("Fail-closed: fehlende/stale/nicht abgeglichene Equity", () => {
  test("keine Equity ⇒ NO_EQUITY und Faktor am Boden (nie neutral)", async () => {
    setMode("active");
    const { deps } = makeDeps({ observation: null });
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    assert.equal(status.status, "CONSERVATIVE");
    assert.equal(status.reasonCode, "NO_EQUITY");
    assert.equal(status.appliedFactor, testConfig().minFactor);
    assert.equal(status.drawdownPct, null, "unbekannt ≠ 0");
    assert.equal(getLimits().maxRiskPerTrade, getBaseLimits().maxRiskPerTrade * testConfig().minFactor);
  });

  test("stale Equity ⇒ STALE_EQUITY und Faktor am Boden", async () => {
    setMode("active");
    const now = makeNow();
    const { deps } = makeDeps({
      now,
      observation: obs({ equity: 10_000, availableAt: now - 20 * MIN }),
    });
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    assert.equal(status.reasonCode, "STALE_EQUITY");
    assert.equal(status.appliedFactor, testConfig().minFactor);
  });

  test("fehlende/nicht abgeglichene Reconciliation ⇒ konservativ", async () => {
    setMode("active");
    const missing = makeDeps({ reconciliation: null, observation: obs({ equity: 10_000 }) });
    const status1 = await updateDrawdownScaling({ deps: missing.deps, config: testConfig(), force: true });
    assert.equal(status1.reasonCode, "RECONCILIATION_MISSING");
    assert.equal(status1.appliedFactor, testConfig().minFactor);

    __resetDrawdownScalingForTests();
    const dirty = makeDeps({ reconciliation: { at: makeNow(), clean: false }, observation: obs({ equity: 10_000 }) });
    const status2 = await updateDrawdownScaling({ deps: dirty.deps, config: testConfig(), force: true });
    assert.equal(status2.reasonCode, "RECONCILIATION_FAILED");
    assert.equal(status2.appliedFactor, testConfig().minFactor);
  });

  test("Equity-Lesefehler wird gefangen (kein Absturz) und konservativ bewertet", async () => {
    setMode("active");
    const { deps } = makeDeps();
    deps.readEquity = async () => {
      throw new Error("equity provider down");
    };
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    assert.equal(status.status, "CONSERVATIVE");
    assert.equal(status.reasonCode, "NO_EQUITY");
    assert.equal(status.appliedFactor, testConfig().minFactor);
    assert.match(status.lastError ?? "", /equity provider down/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cashflow
// ─────────────────────────────────────────────────────────────────────────────

describe("Cashflows (Ein-/Auszahlung)", () => {
  test("Einzahlung hebt den HWM nicht und senkt den Faktor nicht", async () => {
    setMode("active");
    const db = new FakeDdsDb();
    const t0 = makeNow();
    const first = makeDeps({ db, now: t0, observation: obs({ equity: 10_000, availableAt: t0 }) });
    const s1 = await updateDrawdownScaling({ deps: first.deps, config: testConfig(), force: true });
    assert.equal(s1.status, "BOOTSTRAP");
    assert.equal(s1.hwm, 10_000);
    assert.equal(s1.appliedFactor, 1);

    // Einzahlung 5.000: Equity steigt, Trading-PnL unverändert.
    const t1 = t0 + MIN;
    const second = makeDeps({
      db,
      now: t1,
      observation: obs({
        equity: 15_000,
        availableAt: t1,
        baselineEquity: 10_000,
        tradingPnl: { realized: 0, unrealized: 0 },
      }),
    });
    const s2 = await updateDrawdownScaling({ deps: second.deps, config: testConfig(), force: true });
    assert.equal(s2.hwm, 10_000, "Einzahlung ist keine Performance");
    assert.equal(s2.drawdownPct, 0);
    assert.equal(s2.appliedFactor, 1);
    assert.ok(Math.abs((s2.cashflow?.detected ?? 0) - 5_000) < 1e-9);
    assert.equal(getLimits().maxRiskPerTrade, getBaseLimits().maxRiskPerTrade);
  });

  test("Auszahlung erzeugt keinen Schein-Drawdown (HWM bleibt)", async () => {
    setMode("active");
    const db = new FakeDdsDb();
    const t0 = makeNow();
    await updateDrawdownScaling({
      deps: makeDeps({ db, now: t0, observation: obs({ equity: 10_000, availableAt: t0 }) }).deps,
      config: testConfig(),
      force: true,
    });
    const t1 = t0 + MIN;
    const s2 = await updateDrawdownScaling({
      deps: makeDeps({
        db,
        now: t1,
        observation: obs({ equity: 9_000, availableAt: t1, tradingPnl: { realized: 0, unrealized: 0 } }),
      }).deps,
      config: testConfig(),
      force: true,
    });
    assert.equal(s2.hwm, 10_000);
    assert.equal(s2.drawdownPct, 0, "Auszahlung ist kein Verlust");
    assert.equal(s2.appliedFactor, 1);
    assert.equal(s2.stage, "NORMAL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotenz, Neustart, Intervalle
// ─────────────────────────────────────────────────────────────────────────────

describe("Idempotenz & Neustart", () => {
  test("Retry in derselben Minute ⇒ genau eine Snapshot-Zeile", async () => {
    setMode("active");
    const { deps, db } = makeDeps({ observation: obs({ equity: 9_500, tradingPnl: { realized: -500, unrealized: 0 } }) });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    assert.equal(db.snapshotInserts, 2, "beide Läufe versuchen den Insert");
    assert.equal(db.snapshots.length, 1, "ON CONFLICT DO NOTHING verhindert Duplikate");
  });

  test("Neustart rekonstruiert denselben HWM/Faktor (kein Reset durch Deployment)", async () => {
    setMode("active");
    const db = new FakeDdsDb();
    const t0 = makeNow();
    const first = makeDeps({ db, now: t0, observation: obs({ equity: 9_000, availableAt: t0, tradingPnl: { realized: -1_000, unrealized: 0 } }) });
    const s1 = await updateDrawdownScaling({ deps: first.deps, config: testConfig(), force: true });
    assert.equal(s1.status, "BOOTSTRAP");
    assert.equal(s1.hwm, 10_000);
    const factorBefore = s1.appliedFactor;

    // Neustart: RAM-Zustand weg (Prozess) — der Zustand kommt aus der DB.
    __resetDrawdownScalingForTests();
    __resetAllSingletonsForTests();

    const t1 = t0 + MIN;
    const second = makeDeps({ db, now: t1, observation: obs({ equity: 9_000, availableAt: t1, tradingPnl: { realized: -1_000, unrealized: 0 } }) });
    const s2 = await updateDrawdownScaling({ deps: second.deps, config: testConfig(), force: true });

    assert.equal(s2.status, "OK", "kein Bootstrap nach Neustart");
    assert.equal(s2.hwm, 10_000, "HWM überlebt den Neustart");
    assert.equal(s2.appliedFactor, factorBefore, "Faktor identisch rekonstruiert");
    assert.equal(s2.lastTransition, "NONE");
    assert.equal(getDrawdownScalingState()!.factor, factorBefore);
  });

  test("Min-Interval: zweiter Lauf ohne force wird übersprungen", async () => {
    setMode("active");
    const { deps, db } = makeDeps({ observation: obs({ equity: 9_500, tradingPnl: { realized: -500, unrealized: 0 } }) });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    await updateDrawdownScaling({ deps, config: testConfig() });
    assert.equal(db.snapshotInserts, 1, "Min-Interval verhindert den zweiten Lauf");
  });

  test("Persistenzfehler bricht den Lauf nicht ab (Fail-Safe)", async () => {
    setMode("active");
    const db = new FakeDdsDb();
    db.insert = () => {
      throw new Error("db down");
    };
    const { deps } = makeDeps({ db, observation: obs({ equity: 9_500, tradingPnl: { realized: -500, unrealized: 0 } }) });
    const status = await updateDrawdownScaling({ deps, config: testConfig(), force: true });
    assert.equal(status.status, "BOOTSTRAP", "Bewertung bleibt gültig");
    assert.ok(status.appliedFactor > 0 && status.appliedFactor <= 1);
    assert.match(status.lastError ?? "", /Persistenz fehlgeschlagen/);
    // Der Faktor wirkt trotzdem (RAM ist konsistent) — der nächste Tick
    // schreibt erneut; ein DB-Ausfall darf die Reduktion nicht aufheben.
    assert.equal(getDrawdownScalingState()!.factor, status.appliedFactor);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

describe("Status-API (synchroner Snapshot)", () => {
  test("vor dem ersten Lauf null, danach vollständig und additiv", async () => {
    setMode("active");
    assert.equal(getDrawdownScalingStatus(), null);

    const { deps } = makeDeps({ observation: obs({ equity: 9_400, tradingPnl: { realized: -600, unrealized: 0 } }) });
    await updateDrawdownScaling({ deps, config: testConfig(), force: true });

    const status = getDrawdownScalingStatus();
    assert.ok(status !== null);
    for (const field of [
      "mode",
      "active",
      "paused",
      "stage",
      "status",
      "reasonCode",
      "reason",
      "equity",
      "hwm",
      "drawdownPct",
      "appliedFactor",
      "targetFactor",
      "policyVersion",
      "lastTransition",
      "lastUpdate",
      "stale",
      "config",
      "bounds",
      "riskBudget",
    ] as const) {
      assert.ok(field in status!, `Feld ${field} fehlt im Status`);
    }
    assert.match(String(status!.policyVersion), /^ddp1:[0-9a-f]{64}$/);
    assert.ok((status!.hwm ?? 0) > 0, "HWM ist gesetzt");
    assert.equal(status!.stale, false);
  });

  test("Drawdown-Defaults sind risikoneutral dokumentiert (monitor, bounded)", () => {
    const cfg = resolveDrawdownScalingConfig({});
    assert.equal(cfg.mode, "monitor");
    assert.ok(cfg.minFactor > 0 && cfg.minFactor <= 1);
    assert.ok(cfg.hardThresholdPct > cfg.softThresholdPct);
  });

  test("Neuberechnung aus dem frischen Basiswert (keine Kumulation)", () => {
    const base = getBaseLimits();
    applyDrawdownScaling({
      factor: 0.5,
      stage: "SOFT",
      paused: false,
      drawdownPct: 0.07,
      hwm: 10_000,
      policyVersion: "ddp1:" + "0".repeat(64),
      at: new Date(makeNow()).toISOString(),
      asOf: null,
      reason: "test",
      mode: "active",
    });
    const first = getLimits().maxRiskPerTrade;
    // Erneutes Anwenden desselben Zustands rechnet aus dem Basiswert neu —
    // keine Kumulation, keine Drift.
    applyDrawdownScaling(getDrawdownScalingState());
    assert.equal(getLimits().maxRiskPerTrade, first, "Neuberechnung ist idempotent");
    assert.ok(Math.abs(first - base.maxRiskPerTrade * 0.5) < 1e-12);
  });
});

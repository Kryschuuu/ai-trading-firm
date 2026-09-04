/**
 * H10 (v1.36.21) — Adaptives Risk fail-closed: expliziter UNKNOWN-Zustand.
 *
 * Befund (Senior-Peer-Review): `ensureAdaptiveRiskFresh()`-Fehler hielten den
 * letzten Zustand und die Gründe/Kommentare sagten „Basis-Limit aktiv
 * (Fail-Open)“. Für ein System, dessen Sicherheitsmodell
 * „Regime → Risikoreduktion / Blockade“ ist, darf ein NICHT-BESTIMMBARES
 * Regime NICHT stil auf volles Basisrisiko zurückfallen.
 *
 * Fix: `AdaptiveRegime` += `"UNKNOWN"`. Fehlende (MISSING), fehlerhafte
 * (ERRORED) oder zu alte (STALE) Bewertung ⇒ expliziter UNKNOWN-Zustand mit
 * konservativstem Faktor (Code-Boden `LIMIT_CEILINGS.maxRiskPerTrade[0]`).
 * `runAgentTurn` blockt Neupositionen bei UNKNOWN (wie bei EXTREME) und
 * protokolliert den Grund im Trace.
 *
 * Abgedeckt (Unit/Integration, ohne Netz/DB):
 *   - resolveAdaptiveUnknown: MISSING / ERRORED / STALE / frisch+fehlerfrei
 *   - adaptiveUnknownFactor: Boden-Faktor (0.2 % ÷ Basis)
 *   - updateAdaptiveRisk: Quellen-Fehler → UNKNOWN + Limit auf dem Boden
 *   - updateAdaptiveRisk: alle Quellen ohne Messwert → UNKNOWN (statt NORMAL)
 *   - Erholung: fehlerfreier Lauf hebt UNKNOWN wieder auf
 *   - deaktiviertes System bleibt bewusst NORMAL (Operator-Entscheid)
 *   - Engine-Gate: adaptiveAllowsNewPositions (UNKNOWN/EXTREME blockieren)
 *
 * DB-gegated (überspringt sich ohne PostgreSQL — Repo-Konvention):
 *   - runAgentTurn blockt bei UNKNOWN neue Trades, Trace zeigt UNKNOWN
 *   - runAgentTurn blockt bei EXTREME mit ADAPTIVE_RISK_EXTREME
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ADAPTIVE_STATE_MAX_AGE_MS,
  applyAdaptiveRisk,
  getAdaptiveRiskState,
  getLimits,
  killSwitch,
  resetRuntimeLimits,
} from "../src/lib/riskGuard";
import {
  DEFAULT_VOLATILITY_CONFIG,
  __resetAdaptiveRiskForTests,
  adaptiveUnknownFactor,
  applyVolatilityConfig,
  getAdaptiveRiskStatus,
  resolveAdaptiveUnknown,
  updateAdaptiveRisk,
  type IndicatorReadings,
  type RegimeAssessment,
  type VolatilityConfig,
} from "../src/lib/adaptiveRisk";
import { adaptiveAllowsNewPositions, runAgentTurn } from "../src/lib/engine";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { db } from "../src/db";
import { agentMessages, agents, auditLog, missions, proposals } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import type { Candle } from "../src/lib/marketData";

const CALM: IndicatorReadings = { vix: 18, atr: 0.004, bbw: 0.02, retStdDev: 0.004 };
const cfg = (over: Partial<VolatilityConfig> = {}): VolatilityConfig => ({
  ...DEFAULT_VOLATILITY_CONFIG,
  ...over,
});

/** Flache Kerzen: ATR/BBW/StdDev ≈ 0 → ruhig. */
function calmCandles(n = 90): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: Date.now() - (n - i) * 600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + Math.sin(i / 7) * 0.05,
    volume: 1_000,
  }));
}

const SAMPLE_ASSESS: RegimeAssessment = {
  regime: "NORMAL",
  factor: 1,
  indicators: [],
  triggered: [],
  reason: "Test-Bewertung",
};

beforeEach(() => {
  __resetAdaptiveRiskForTests();
  __resetAllSingletonsForTests();
});

// ── resolveAdaptiveUnknown (pure) ─────────────────────────────────────────────

test("resolveAdaptiveUnknown: noch nie bewertet → MISSING", () => {
  assert.equal(resolveAdaptiveUnknown(null, null, null), "MISSING");
  assert.equal(
    resolveAdaptiveUnknown(SAMPLE_ASSESS, null, null),
    "STALE",
    "Assessment ohne Zeitstempel ist nicht als frisch beweisbar → konservativ STALE"
  );
});

test("resolveAdaptiveUnknown: letzter Fehler → ERRORED", () => {
  assert.equal(resolveAdaptiveUnknown(SAMPLE_ASSESS, "VIX: timeout", Date.now()), "ERRORED");
});

test("resolveAdaptiveUnknown: älter als ADAPTIVE_STATE_MAX_AGE_MS → STALE", () => {
  const now = 1_000_000_000;
  const old = now - (ADAPTIVE_STATE_MAX_AGE_MS + 1_000);
  assert.equal(resolveAdaptiveUnknown(SAMPLE_ASSESS, null, old, now), "STALE");
  assert.equal(
    resolveAdaptiveUnknown(SAMPLE_ASSESS, null, now - ADAPTIVE_STATE_MAX_AGE_MS, now),
    null,
    "exakt am Limit ist noch frisch"
  );
});

test("resolveAdaptiveUnknown: frisch + fehlerfrei → kein UNKNOWN", () => {
  const now = 1_000_000_000;
  assert.equal(resolveAdaptiveUnknown(SAMPLE_ASSESS, null, now - 60_000, now), null);
});

// ── adaptiveUnknownFactor (pure) ─────────────────────────────────────────────

test("adaptiveUnknownFactor: klemmt 2 % Basis auf 0.2 % Code-Boden (Faktor 0.1)", () => {
  assert.equal(adaptiveUnknownFactor(0.02), 0.1);
  assert.equal(adaptiveUnknownFactor(0.02) * 0.02, 0.002, "wirksames Limit = Boden");
});

test("adaptiveUnknownFactor: Basis schon am Boden → Faktor 1 (nicht über 0.2 % hinaus)", () => {
  assert.equal(adaptiveUnknownFactor(0.002), 1);
  assert.equal(adaptiveUnknownFactor(0.004), 0.5);
});

test("adaptiveUnknownFactor: größere Basis → kleinerer Faktor, Limit bleibt Boden", () => {
  assert.equal(adaptiveUnknownFactor(0.05), 0.04);
  assert.equal(adaptiveUnknownFactor(0.05) * 0.05, 0.002);
});

// ── updateAdaptiveRisk: UNKNOWN-Pfad (Integration, injected Fetcher) ─────────

test("Integration: VIX-Quellen-Fehler → UNKNOWN, Limit auf dem Code-Boden, Event + riskGuard konsistent", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    fetchVix: async () => {
      throw new Error("timeout");
    },
    fetchCandles: () => Promise.resolve(calmCandles()),
    force: true,
  });
  assert.equal(st.regime, "UNKNOWN", "Fehler → UNKNOWN statt Fail-Open-NORMAL");
  assert.match(st.lastError ?? "", /VIX/);
  assert.match(st.reason, /UNKNOWN/);
  assert.equal(st.factor, 0.1, "UNKNOWN-Faktor = Code-Boden (0.2 % / 2 % Basis)");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.002, "wirksames Limit auf dem Boden");
  assert.equal(getLimits().maxRiskPerTrade, 0.002, "riskGuard-Limit ebenfalls auf dem Boden");
  assert.equal(getAdaptiveRiskState()?.regime, "UNKNOWN", "riskGuard-Zustand zeigt UNKNOWN");

  // Event-Historie: Übergang NORMAL → UNKNOWN ist aufgezeichnet.
  const ev = st.events[0];
  assert.ok(ev, "UNKNOWN-Event muss geschrieben sein");
  assert.equal(ev.regime, "UNKNOWN");
  assert.equal(ev.prevRegime, "NORMAL");
  assert.equal(ev.effectiveMaxRiskPerTrade, 0.002);
});

test("Integration: alle Quellen ohne Messwert → UNKNOWN (statt stillem NORMAL)", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    readings: { vix: null, atr: null, bbw: null, retStdDev: null },
    force: true,
  });
  assert.equal(st.regime, "UNKNOWN", "nur null/leere Messwerte ⇒ nicht bewertbar ⇒ UNKNOWN");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.002);
  assert.match(st.lastError ?? "", /Keine Indikator-Daten/);
  assert.match(st.reason, /UNKNOWN/);
});

test("Integration: Erholung — fehlerfreier Lauf hebt UNKNOWN auf (NORMAL + Basis-Limit)", async () => {
  await updateAdaptiveRisk({
    config: cfg(),
    fetchVix: async () => {
      throw new Error("network down");
    },
    fetchCandles: () => Promise.resolve(calmCandles()),
    force: true,
  });
  assert.equal(getAdaptiveRiskStatus()!.regime, "UNKNOWN");

  const st = await updateAdaptiveRisk({ config: cfg(), readings: CALM, force: true });
  assert.equal(st.regime, "NORMAL");
  assert.equal(st.lastError, null, "Fehler ist nach sauberem Lauf verbraucht");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.02);
  assert.equal(getLimits().maxRiskPerTrade, 0.02);
  assert.equal(getAdaptiveRiskState()?.regime, "NORMAL");
});

test("Integration: deaktiviertes System bleibt NORMAL trotz Quellen-Fehler (Operator-Entscheid)", async () => {
  // Der Disabled-Zustand ist Teil des LAUFZEIT-Zustands (Dashboardschalter),
  // nicht einer einmaligen opts.config — deshalb applyVolatilityConfig.
  applyVolatilityConfig({ enabled: false });
  const st = await updateAdaptiveRisk({
    fetchVix: async () => {
      throw new Error("down");
    },
    fetchCandles: () => Promise.resolve(calmCandles()),
    force: true,
  });
  assert.equal(st.enabled, false);
  assert.equal(st.regime, "NORMAL", "enabled=false ⇒ niemals UNKNOWN");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.02, "Basis-Limit bleibt, kein Boden");
  assert.equal(getLimits().maxRiskPerTrade, 0.02);
});

// ── Engine-Gate (pure) ───────────────────────────────────────────────────────

test("Engine-Gate: adaptiveAllowsNewPositions — NORMAL/ELEVATED/PERSISTED erlauben, UNKNOWN/EXTREME/null blockieren", () => {
  assert.equal(adaptiveAllowsNewPositions("NORMAL"), true);
  assert.equal(adaptiveAllowsNewPositions("ELEVATED"), true);
  assert.equal(adaptiveAllowsNewPositions("PERSISTED"), true);
  assert.equal(adaptiveAllowsNewPositions("EXTREME"), false);
  assert.equal(adaptiveAllowsNewPositions("UNKNOWN"), false);
  assert.equal(adaptiveAllowsNewPositions(null), false, "kein Stand ⇒ fail-closed");
  assert.equal(adaptiveAllowsNewPositions(undefined), false, "kein Stand ⇒ fail-closed");
});

// ── runAgentTurn-Akzeptanz (DB-gegated, Repo-Konvention) ────────────────────

async function dbReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM agents LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function insertAgentMission(t: { title: string; objective: string }): Promise<{ agentId: string; missionId: string }> {
  const agentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    name: `h10-${t.title}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "RESEARCH", // lokale Regel-Engine → deterministisch TRADE
    model: "test-model",
    status: "IDLE",
    systemPrompt: "H10-Akzeptanztest: Agent darf bei unbekanntem Risiko keine Trades eingehen.",
  });
  await db.insert(missions).values({
    id: missionId,
    title: t.title,
    objective: t.objective,
    symbol: "SPY",
    scope: "SINGLE_SYMBOL",
    riskBudget: "0.02",
    maxPositionPct: "0.25",
    status: "PENDING",
  });
  return { agentId, missionId };
}

async function cleanup(agentId: string, missionId: string): Promise<void> {
  // Best-effort: Reihenfolge FK-tolerant (Kinder zuerst), jede Aussage einzeln
  // geschützt, damit ein Fehler den Rest des Aufräumens nicht blockiert.
  for (const fn of [
    () => db.delete(agentMessages).where(eq(agentMessages.missionId, missionId)),
    () => db.delete(proposals).where(eq(proposals.missionId, missionId)),
    () => db.delete(auditLog).where(eq(auditLog.missionId, missionId)),
    () => db.delete(missions).where(eq(missions.id, missionId)),
    () => db.delete(agentMessages).where(eq(agentMessages.agentId, agentId)),
    () => db.delete(auditLog).where(eq(auditLog.agentId, agentId)),
    () => db.delete(agents).where(eq(agents.id, agentId)),
  ]) {
    try {
      await fn();
    } catch {
      /* Test-DB darf Toleranz haben */
    }
  }
}

test("H10: runAgentTurn blockt bei UNKNOWN neue Trades — Trace zeigt ADAPTIVES-RISIKO ok=false + GATE", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (h10) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  __resetAdaptiveRiskForTests();
  resetRuntimeLimits();
  applyAdaptiveRisk(null);
  killSwitch.disarm();

  const { agentId, missionId } = await insertAgentMission({
    title: "unknown-block",
    objective: "VIX-Quelle fällt aus → UNKNOWN muss Neupositionen blocken.",
  });

  try {
    const st = await updateAdaptiveRisk({
      config: cfg(),
      fetchVix: async () => {
        throw new Error("h10 acceptance: VIX down");
      },
      fetchCandles: () => Promise.resolve(calmCandles()),
      force: true,
    });
    assert.equal(st.regime, "UNKNOWN", "Set-Up: Quellen-Fehler → UNKNOWN");

    const res = await runAgentTurn(agentId, missionId, { proposalOnly: true });
    assert.equal(res.status, "BLOCKED", "UNKNOWN muss den Trade blocken");
    assert.equal(res.guardrail, "ADAPTIVE_RISK_UNKNOWN");

    const adStep = res.trace?.find((s) => s.layer === "ADAPTIVES-RISIKO");
    assert.ok(adStep, "Trace enthält ADAPTIVES-RISIKO");
    assert.equal(adStep.ok, false, "Trace-Step muss ok=false zeigen");
    assert.match(adStep.detail, /UNKNOWN/, "Trace nennt den UNKNOWN-Zustand");

    const gateStep = res.trace?.find((s) => s.layer === "ADAPTIVES-RISIKO-GATE");
    assert.ok(gateStep, "Trace enthält ADAPTIVES-RISIKO-GATE");
    assert.equal(gateStep.ok, false);
  } finally {
    await cleanup(agentId, missionId);
  }
});

test("H10: runAgentTurn blockt bei EXTREME mit ADAPTIVE_RISK_EXTREME", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (h10) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  __resetAdaptiveRiskForTests();
  resetRuntimeLimits();
  applyAdaptiveRisk(null);
  killSwitch.disarm();

  const { agentId, missionId } = await insertAgentMission({
    title: "extreme-block",
    objective: "EXTREME-Regime sperrt Neupositionen (bestehende Härte).",
  });

  try {
    const st = await updateAdaptiveRisk({
      config: cfg(),
      readings: { vix: 55, atr: 0.2, bbw: 0.5, retStdDev: 0.2 },
      force: true,
    });
    assert.equal(st.regime, "EXTREME", "Set-Up: VIX 55 → EXTREME");

    const res = await runAgentTurn(agentId, missionId, { proposalOnly: true });
    assert.equal(res.status, "BLOCKED");
    assert.equal(res.guardrail, "ADAPTIVE_RISK_EXTREME");
  } finally {
    await cleanup(agentId, missionId);
  }
});
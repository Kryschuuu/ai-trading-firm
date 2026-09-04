/**
 * Integrationstests des adaptiven Risk-Limit-Systems.
 *
 * Simuliert komplette Marktlagen (injected Fetcher/Messwerte — kein
 * Netzwerk, keine DB) und prüft, dass maxRiskPerTrade in der Order-Pipeline
 * (riskGuard.getLimits()) korrekt angepasst wird:
 *
 *   - ruhiger Markt, VIX-Trigger, VIX-Extrem, Korb-Indikatoren (ATR/BBW/StdDev)
 *   - schnelle Volatilitätswechsel (Anti-Flapping in der Pipeline)
 *   - fehlende Daten (VIX-Quellen-Timeout, leere Kerzen) → UNKNOWN (fail-closed seit H10/v1.36.21)
 *   - Laufzeit-Konfigurationsänderung ohne Neustart
 *   - Min-Interval / Single-Flight (kein Re-Fetch im Sonnen-Takt)
 *   - Observability: Status-Objekt + Event-Historie
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOLATILITY_CONFIG,
  __resetAdaptiveRiskForTests,
  getAdaptiveRiskStatus,
  readMarketReadings,
  updateAdaptiveRisk,
  type IndicatorReadings,
  type VolatilityConfig,
} from "../src/lib/adaptiveRisk";
import { applyAdaptiveRisk, getAdaptiveRiskState, getLimits, resetRuntimeLimits } from "../src/lib/riskGuard";
import type { Candle } from "../src/lib/marketData";

const CALM: IndicatorReadings = { vix: 18, atr: 0.004, bbw: 0.02, retStdDev: 0.004 };
const cfg = (over: Partial<VolatilityConfig> = {}): VolatilityConfig => ({
  ...DEFAULT_VOLATILITY_CONFIG,
  ...over,
});

beforeEach(() => {
  __resetAdaptiveRiskForTests();
  resetRuntimeLimits();
  applyAdaptiveRisk(null);
});

// ── Simulierte Kerzen ────────────────────────────────────────────────────────

/** Flache Kerzen: ATR/BBW/StdDev ≈ 0 → ruhig. */
function calmCandles(n = 90): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i, open: 100, high: 100, low: 100, close: 100, volume: 100,
  }));
}

/** Sturm-Kerzen: ±3 % je Kerze, 6 % Range → alle drei Korb-Indikatoren triggern. */
function stormCandles(n = 90): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = i % 2 === 0 ? 97 : 103;
    return { time: i, open: close, high: close + 1.5, low: close - 1.5, close, volume: 100 };
  });
}

// ── Marktlagen → maxRiskPerTrade ─────────────────────────────────────────────

test("Integration: ruhiger Markt → NORMAL, maxRiskPerTrade bleibt 0.02", async () => {
  const st = await updateAdaptiveRisk({ config: cfg(), readings: CALM });
  assert.equal(st.regime, "NORMAL");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.02);
  assert.equal(getLimits().maxRiskPerTrade, 0.02);
});

test("Integration: VIX 35 → ELEVATED → 0.01, dann VIX 45 → EXTREME → 0.005 (ohne Neustart)", async () => {
  await updateAdaptiveRisk({ config: cfg(), readings: { ...CALM, vix: 35 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.01, "2 % × 0.5");

  await updateAdaptiveRisk({ config: cfg(), readings: { ...CALM, vix: 45 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.005, "2 % × 0.25");
  assert.equal(getLimits().maxRiskPerTrade, 0.005, "Order-Pipeline sieht den reduzierten Wert");
});

test("Integration: ohne VIX — Korb-Sturm (ATR+BBW+StdDev) → EXTREME", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    readings: { vix: null, atr: 0.0728, bbw: 0.36, retStdDev: 0.06 },
    force: true,
  });
  assert.equal(st.regime, "EXTREME");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.005);
  assert.deepEqual([...st.events[0].triggered].sort(), ["ATR", "BBW", "RET_STDDEV"]);
});

test("Integration: Einzel-Korb-Trigger (nur ATR) → ELEVATED, nicht EXTREME", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    readings: { vix: 20, atr: 0.015, bbw: 0.02, retStdDev: 0.004 },
    force: true,
  });
  assert.equal(st.regime, "ELEVATED");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.01);
});

test("Integration: schnelle Volatilitätswechsel — kein Flapping (Hysterese in Pipeline)", async () => {
  const c = cfg({ deescalateAfter: 2 });
  const sequence = [35, 18, 35, 18, 35, 18, 18];
  const expected = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02];
  for (let i = 0; i < sequence.length; i++) {
    await updateAdaptiveRisk({ config: c, readings: { ...CALM, vix: sequence[i] }, force: true });
    assert.equal(
      getLimits().maxRiskPerTrade,
      expected[i],
      `Schritt ${i + 1} (VIX ${sequence[i]}) — Limit muss ${expected[i]} sein`
    );
  }
  // Der Status zeigt den de-eskalierten Zustand.
  const st = getAdaptiveRiskStatus()!;
  assert.equal(st.regime, "NORMAL");
  assert.equal(st.factor, 1);
});

test("Integration: VIX-Quellen-Timeout → UNKNOWN (fail-closed), System bleibt funktionsfähig", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    fetchVix: async () => {
      throw new Error("timeout");
    },
    fetchCandles: () => Promise.resolve(calmCandles()),
    force: true,
  });
  // H10 (v1.36.21): Fehler → expliziter UNKNOWN-Zustand, NICHT „fehlende VIX
  // darf nicht eskalieren → NORMAL“. Neupositionen sind jetzt gesperrt.
  assert.equal(st.regime, "UNKNOWN", "Quellen-Fehler → UNKNOWN statt Fail-Open-NORMAL");
  assert.ok(st.reason.includes("UNKNOWN"), "Grund nennt den UNKNOWN-Zustand");
  assert.equal(st.factor, 0.1, "UNKNOWN-Faktor = Code-Boden (0.2 % / 2 % Basis)");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.002, "wirksames Limit auf dem Code-Boden");
  assert.equal(getLimits().maxRiskPerTrade, 0.002, "riskGuard-Limit ebenfalls auf dem Boden");
  assert.equal(getAdaptiveRiskState()?.regime, "UNKNOWN", "riskGuard-Zustand zeigt UNKNOWN");
  assert.match(st.lastError ?? "", /VIX/);
  const vixInd = st.indicators.find((i) => i.name === "VIX");
  assert.ok(vixInd && !vixInd.available && !vixInd.triggered);
});

test("Integration: fehlende Kerzen-Daten (leere Antworten) → Indikatoren null, NORMAL", async () => {
  const st = await updateAdaptiveRisk({
    config: cfg(),
    fetchVix: async () => 19,
    fetchCandles: () => Promise.resolve([]),
    force: true,
  });
  assert.equal(st.regime, "NORMAL");
  assert.equal(st.effectiveMaxRiskPerTrade, 0.02);
  for (const name of ["ATR", "BBW", "RET_STDDEV"]) {
    const ind = st.indicators.find((i) => i.name === name);
    assert.ok(ind && !ind.available, `${name} muss als verfügbar=false markiert sein`);
  }
});

test("Integration: readMarketReadings aggregiert Korb-Spitzenwerte", async () => {
  const { readings, errors } = await readMarketReadings({
    fetchVix: async () => 22,
    fetchCandles: (s) => (s === "BTC" ? Promise.resolve(stormCandles()) : Promise.resolve(calmCandles())),
  });
  assert.deepEqual(errors, []);
  assert.equal(readings.vix, 22);
  assert.ok(readings.atr != null && readings.atr > 0.01, `BTC-Sturm dominiert ATR (war ${readings.atr})`);
  assert.ok(readings.bbw != null && readings.bbw > 0.05, `BTC-Sturm dominiert BBW (war ${readings.bbw})`);
  assert.ok(readings.retStdDev != null && readings.retStdDev > 0.01, `BTC-Sturm dominiert StdDev (war ${readings.retStdDev})`);
});

test("Integration: Schwellwert-Änderung zur Laufzeit (30 → 40) wirkt ohne Neustart", async () => {
  const c = cfg({ deescalateAfter: 2 });
  // VIX 35 > 30 → ELEVATED.
  await updateAdaptiveRisk({ config: c, readings: { ...CALM, vix: 35 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.01);

  // Operator hebt vixHigh auf 40 — VIX 35 ist jetzt „ruhig".
  const c2 = cfg({ deescalateAfter: 2, vixHigh: 40 });
  await updateAdaptiveRisk({ config: c2, readings: { ...CALM, vix: 35 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.01, "Hysterese: Streak 1 < 2 → noch ELEVATED");

  await updateAdaptiveRisk({ config: c2, readings: { ...CALM, vix: 35 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.02, "Streak 2 → de-eskaliert auf Basis-Limit");
});

test("Integration: Min-Interval verhindert Re-Fetch im Sonnen-Takt", async () => {
  let vixCalls = 0;
  const fetchVixCounting = async () => {
    vixCalls += 1;
    return 18;
  };
  await updateAdaptiveRisk({
    config: cfg(), fetchVix: fetchVixCounting, fetchCandles: () => Promise.resolve(calmCandles()), force: true,
  });
  assert.equal(vixCalls, 1);

  // Zweiter Aufruf ohne force innerhalb des Min-Intervalls → Cache, kein Fetch.
  await updateAdaptiveRisk({ config: cfg(), fetchVix: fetchVixCounting, fetchCandles: () => Promise.resolve(calmCandles()) });
  assert.equal(vixCalls, 1, "keine zweite Marktabfrage innerhalb des Min-Intervalls");
});

test("Integration: Observability — Status + Event-Historie für Agenten/Monitoring", async () => {
  assert.equal(getAdaptiveRiskStatus(), null, "vor der ersten Bewertung: null");

  await updateAdaptiveRisk({ config: cfg(), readings: CALM, force: true });
  await updateAdaptiveRisk({ config: cfg(), readings: { ...CALM, vix: 35 }, force: true });
  await updateAdaptiveRisk({ config: cfg(), readings: { ...CALM, vix: 45 }, force: true });

  const st = getAdaptiveRiskStatus()!;
  assert.equal(st.regime, "EXTREME");
  assert.equal(st.enabled, true);
  assert.equal(st.factor, 0.25);
  assert.equal(st.baseMaxRiskPerTrade, 0.02);
  assert.equal(st.effectiveMaxRiskPerTrade, 0.005);
  assert.ok(st.lastUpdate, "Letzte Bewertung muss Zeitstempel haben");
  assert.ok(st.lastChange, "Letzte Änderung muss Zeitstempel haben");
  assert.equal(st.stale, false);
  assert.ok(st.reason.length > 0);

  // Indikator-Meldung: Werte + Schwellen + Trigger-Flag.
  const vixInd = st.indicators.find((i) => i.name === "VIX")!;
  assert.equal(vixInd.value, 45);
  assert.equal(vixInd.threshold, 30);
  assert.equal(vixInd.triggered, true);
  assert.equal(vixInd.available, true);

  // Event-Historie: Erstbewertung + 2 Regime-Wechsel, neuestes zuerst.
  assert.equal(st.events.length, 3);
  assert.equal(st.events[0].regime, "EXTREME");
  assert.equal(st.events[0].prevRegime, "ELEVATED");
  assert.equal(st.events[0].effectiveMaxRiskPerTrade, 0.005);
  assert.equal(st.events[0].triggered.includes("VIX"), true);
  assert.ok(st.events[0].reason.length > 0);
  assert.ok(st.events[0].at >= st.events[1].at, "neuestes Event zuerst");

  // Konfiguration + erlaubtes Fenster sind Teil des Status (Agenten können
  // nachvollziehen, was der Operator ändern darf).
  assert.equal(st.config.vixHigh, 30);
  assert.deepEqual(st.bounds.extremeFactor, [0.02, 1]);
});

test("Integration: Fehler im Markt-Zugriff → UNKNOWN statt letztem Zustand (fail-closed)", async () => {
  // Erst ELEVATED etablieren …
  await updateAdaptiveRisk({ config: cfg(), readings: { ...CALM, vix: 35 }, force: true });
  assert.equal(getLimits().maxRiskPerTrade, 0.01);

  // … dann fällt die VIX-Quelle aus (Network-Ausfall). H10 (v1.36.21):
  // Der Fehler wird pro Quelle gefangen — aber NICHT als NORMAL/letzter
  // Zustand verschluckt: expliziter UNKNOWN-Zustand, Limit auf dem Boden.
  const st = await updateAdaptiveRisk({
    config: cfg(),
    fetchVix: async () => {
      throw new Error("network down");
    },
    fetchCandles: () => Promise.resolve(calmCandles()),
    force: true,
  });
  assert.ok(st, "Status muss auch bei Fehlern geliefert werden");
  assert.equal(st.regime, "UNKNOWN", "Fehler → UNKNOWN, nicht letzter Zustand");
  assert.match(st.reason, /network down/);
  assert.equal(getLimits().maxRiskPerTrade, 0.002, "Fail-closed: Limit auf dem Code-Boden statt 0.01");
  assert.equal(getAdaptiveRiskState()?.regime, "UNKNOWN", "riskGuard-Zustand zeigt UNKNOWN");
});

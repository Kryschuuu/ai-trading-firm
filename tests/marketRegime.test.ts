/**
 * Unit-Tests des Markt-Regime-Klassifikators + Regime-Gates (GAP-06,
 * src/lib/marketRegime.ts).
 *
 * Abgedeckt:
 *   - classifyMarketRegime(): Golden-Cases je Regime (synthetische, feste
 *     Serien) inkl. Grenzfällen und Priorität CRASH > HIGH_VOL > TREND > RANGE
 *   - MarketRegimeStateMachine(): Hysterese (Eskalation sofort, De-Eskalation
 *     und Seitwärtswechsel erst nach REGIME_CONFIRM_CANDLES Bestätigungen,
 *     einzelne Gegenkerzen wechseln nichts)
 *   - evaluateInstrumentRegime(): Tracker, Verlauf, UNKNOWN-Pfad, Audit-Code
 *   - applyRegimeGate(): off/monitor/enforce-Semantik exakt
 *   - Konfiguration: Bounds/Defaults/Env-Parsing/Klemmung
 *   - Determinismus: gleiche Serie → identische Klassifikation (Hash)
 *   - Architektur: kein LLM-Import im Klassifikator (Muster cycle.architecture)
 *
 * Alle Tests deterministisch (feste Serien, injizierte Zeit), ohne Netzwerk
 * und ohne DB (Audit in den Tracker-Tests deaktiviert).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MARKET_REGIME_CONFIG,
  GATE_FACTOR_BOUNDS,
  MARKET_REGIME_BOUNDS,
  MARKET_REGIME_SEVERITY,
  MIN_CLASSIFY_CANDLES,
  MarketRegimeStateMachine,
  applyRegimeGate,
  clampMarketRegimeConfig,
  classifyMarketRegime,
  collectRegimeHistoryArtifact,
  evaluateInstrumentRegime,
  formatRegimeGateContext,
  getInstrumentRegime,
  getMarketRegimeStatus,
  loadMarketRegimeConfig,
  parseGateFactors,
  refreshInstrumentRegimes,
  regimeGateFactor,
  resolveRegimeGateForExecution,
  strategyClassOfTemplate,
  __resetMarketRegimeForTests,
  type MarketRegimeConfig,
  type RegimeCandleLike,
} from "../src/lib/marketRegime";

beforeEach(() => {
  __resetMarketRegimeForTests();
});

// ── Synthetische Serien (deterministisch, ohne Zufall) ──────────────────────

const T0 = 1_750_000_000_000;
const STEP = 900_000; // 15m

function candlesFromCloses(closes: number[]): RegimeCandleLike[] {
  return closes.map((close, i) => {
    const prev = i === 0 ? close : closes[i - 1];
    return {
      time: T0 + i * STEP,
      open: prev,
      high: Math.max(close, prev) + 0.05,
      low: Math.min(close, prev) - 0.05,
      close,
      volume: 1000 + i,
    };
  });
}

function linear(n: number, start: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** Seitwärts: erst ruhig-amplitudig, dann deutlich enger (Ende = niedrige Vol). */
function rangeSeries(n = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const amp = i < 60 ? 1.5 : 0.4;
    out.push(100 + amp * Math.sin((i * 2 * Math.PI) / 12));
  }
  return out;
}

/**
 * Hochvolatil ohne Crash: lange exakt flach (Vol-Fenster dort σ=0), dann
 * ±5-%-Ausschläge um eine leicht steigende Basis; die letzte Kerze liegt
 * auf der Hoch-Seite → Drawdown ~0 (kein CRASH-Trigger).
 */
function highVolSeries(n = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 80) {
      out.push(100);
    } else {
      const base = 100 + (i - 80) * 0.1;
      out.push(base * ((i - 80) % 2 === 1 ? 1.05 : 0.95));
    }
  }
  return out;
}

/** Scharfer Einbruch: stabil, dann zweistelliger Absturz. */
function crashSeries(): number[] {
  const flat = Array.from({ length: 90 }, () => 100);
  const drop = [92, 88, 85, 83, 82, 81, 80.5, 80, 79.5, 79];
  return [...flat, ...drop];
}

const cfg = (over: Partial<MarketRegimeConfig> = {}): MarketRegimeConfig => ({
  ...DEFAULT_MARKET_REGIME_CONFIG,
  ...over,
  gateFactors: over.gateFactors ?? DEFAULT_MARKET_REGIME_CONFIG.gateFactors,
});

/** FNV-1a (nicht-kryptographisch) — Determinismus-Nachweis per Hash. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

// ── D1: Golden-Cases der Klassifikation ─────────────────────────────────────

test("Golden: starker Aufwärtstrend → TREND_UP (ADX hoch, Slope positiv)", () => {
  const r = classifyMarketRegime(candlesFromCloses(linear(60, 100, 0.1)), cfg());
  assert.equal(r.known, true);
  assert.equal(r.regime, "TREND_UP");
  assert.ok(r.features.adx != null && r.features.adx >= cfg().trendAdx, `ADX ${r.features.adx}`);
  assert.ok(r.features.slopePctPerCandle != null && r.features.slopePctPerCandle > 0);
  assert.ok((r.features.drawdownPct ?? 99) < cfg().crashDrawdownPct);
});

test("Golden: Abwärtstrend (flach genug) → TREND_DOWN", () => {
  // Geometrische Abwärtsreihe (konstanter %-Return): Drawdown ~5,8 % unter
  // der Crash-Schwelle, realisierte Vol konstant (kein HIGH_VOL-Trigger).
  const closes = Array.from({ length: 60 }, (_, i) => 110 * Math.pow(0.999, i));
  const r = classifyMarketRegime(candlesFromCloses(closes), cfg());
  assert.equal(r.regime, "TREND_DOWN", r.reason);
  assert.ok(r.features.slopePctPerCandle != null && r.features.slopePctPerCandle < 0);
  assert.ok((r.features.drawdownPct ?? 99) < cfg().crashDrawdownPct, "kein CRASH: Drawdown unter Schwelle");
});

test("Golden: Seitwärts + niedrige Vol → RANGE", () => {
  const r = classifyMarketRegime(candlesFromCloses(rangeSeries()), cfg());
  assert.equal(r.regime, "RANGE", r.reason);
  assert.ok(r.features.adx != null && r.features.adx < cfg().trendAdx);
  assert.ok(r.features.volPercentile == null || r.features.volPercentile < cfg().highVolPercentile);
});

test("Golden: scharfer Einbruch → CRASH (Drawdown + negativer Slope)", () => {
  const r = classifyMarketRegime(candlesFromCloses(crashSeries()), cfg());
  assert.equal(r.regime, "CRASH");
  assert.ok(r.features.drawdownPct != null && r.features.drawdownPct >= cfg().crashDrawdownPct);
  assert.ok(r.features.slopePctPerCandle != null && r.features.slopePctPerCandle < 0);
});

test("Priorität: CRASH schlägt HIGH_VOL (beide Trigger gleichzeitig)", () => {
  const r = classifyMarketRegime(candlesFromCloses(crashSeries()), cfg());
  // Der Einbruch reißt auch das Vol-Perzentil hoch — CRASH muss gewinnen.
  assert.ok(r.features.volPercentile != null && r.features.volPercentile >= cfg().highVolPercentile);
  assert.equal(r.regime, "CRASH");
});

test("Golden: hohe Volatilität ohne Drawdown → HIGH_VOL (nicht Trend, nicht Crash)", () => {
  const r = classifyMarketRegime(candlesFromCloses(highVolSeries()), cfg());
  assert.equal(r.regime, "HIGH_VOL", r.reason);
  assert.ok(r.features.volPercentile != null && r.features.volPercentile >= cfg().highVolPercentile);
  assert.ok((r.features.drawdownPct ?? 99) < cfg().crashDrawdownPct);
});

test("Grenze: Drawdown exakt auf der Schwelle (inklusive) + negativer Slope → CRASH", () => {
  const flat = Array.from({ length: 90 }, () => 100);
  const drop = [98, 96, 95, 94, 93, 92, 91.5, 91, 90.5, 90]; // endet exakt −10 %
  const r = classifyMarketRegime(candlesFromCloses([...flat, ...drop]), cfg({ crashDrawdownPct: 10 }));
  assert.ok(Math.abs((r.features.drawdownPct ?? 0) - 10) < 1e-9);
  assert.equal(r.regime, "CRASH");
});

test("Grenze: hoher Drawdown OHNE negativen Slope ist kein CRASH (V-Erholung)", () => {
  // Tief in der Fenstermitte, danach vollständige Erholung ans Hoch:
  // Drawdown ≈ 0 am Ende, Slope positiv → kein CRASH (Vol/Trend entscheiden).
  const down = linear(50, 100, -0.4); // 100 → 80.4
  const up = linear(50, 80.4 + 0.4, 0.4); // zurück Richtung 100
  const r = classifyMarketRegime(candlesFromCloses([...down, ...up]), cfg());
  assert.notEqual(r.regime, "CRASH");
  assert.ok(r.features.slopePctPerCandle != null && r.features.slopePctPerCandle > 0);
});

test("Grenze: |Slope| unter der Trend-Schwelle → RANGE trotz hohem ADX", () => {
  // Treppe mit minimalem Anstieg: ADX bleibt hoch, Slope aber < Schwelle.
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.001);
  const r = classifyMarketRegime(candlesFromCloses(closes), cfg({ trendSlopePct: 0.05 }));
  assert.ok(r.features.adx != null && r.features.adx >= 25);
  assert.ok(Math.abs(r.features.slopePctPerCandle ?? 1) < 0.05);
  assert.equal(r.regime, "RANGE");
});

test("UNKNOWN: zu wenig Kerzen (< 30) → UNKNOWN, nie still", () => {
  const r = classifyMarketRegime(candlesFromCloses(linear(MIN_CLASSIFY_CANDLES - 1, 100, 0.1)), cfg());
  assert.equal(r.regime, "UNKNOWN");
  assert.equal(r.known, false);
  assert.match(r.reason, /zu wenig Kerzen/i);
  // Exakt die Mindestanzahl wird klassifiziert.
  const ok = classifyMarketRegime(candlesFromCloses(linear(MIN_CLASSIFY_CANDLES, 100, 0.1)), cfg());
  assert.equal(ok.known, true);
});

test("UNKNOWN: leere / kaputte Eingabe → UNKNOWN (kein Wurf)", () => {
  assert.equal(classifyMarketRegime([], cfg()).regime, "UNKNOWN");
  assert.equal(classifyMarketRegime(null as unknown as RegimeCandleLike[], cfg()).regime, "UNKNOWN");
});

// ── Determinismus ────────────────────────────────────────────────────────────

test("Determinismus: gleiche Serie → identische Klassifikation (Hash-Vergleich)", () => {
  const series = candlesFromCloses(crashSeries());
  const a = classifyMarketRegime(series, cfg());
  const b = classifyMarketRegime([...series], cfg());
  assert.equal(fnv1a(JSON.stringify(a)), fnv1a(JSON.stringify(b)));
  // Und über mehrere Regime hinweg stabil:
  for (const closes of [linear(60, 100, 0.1), rangeSeries(), highVolSeries()]) {
    const x = classifyMarketRegime(candlesFromCloses(closes), cfg());
    const y = classifyMarketRegime(candlesFromCloses([...closes]), cfg());
    assert.equal(fnv1a(JSON.stringify(x)), fnv1a(JSON.stringify(y)));
  }
});

// ── Hysterese: Zustandsmaschine ─────────────────────────────────────────────

test("StateMachine: Erstbewertung wird sofort übernommen", () => {
  const m = new MarketRegimeStateMachine();
  assert.equal(m.regime, null);
  const r = m.update("RANGE", 3);
  assert.equal(r.changed, true);
  assert.equal(r.regime, "RANGE");
});

test("StateMachine: Eskalation ist sofort (sichere Richtung)", () => {
  const m = new MarketRegimeStateMachine();
  m.update("RANGE", 3);
  assert.equal(m.update("HIGH_VOL", 3).changed, true, "RANGE → HIGH_VOL sofort");
  assert.equal(m.update("CRASH", 3).changed, true, "HIGH_VOL → CRASH sofort");
  assert.equal(m.regime, "CRASH");
});

test("StateMachine: einzelne Gegenkerze wechselt das Regime nicht", () => {
  const m = new MarketRegimeStateMachine();
  m.update("TREND_UP", 3);
  // Ein Abwärts-Kandidat (De-Eskalation) einmalig → bleibt TREND_UP.
  assert.equal(m.update("TREND_DOWN", 3).changed, false);
  assert.equal(m.regime, "TREND_UP");
  // Kandidat wieder aktuell → Streak bricht ab.
  m.update("TREND_UP", 3);
  assert.equal(m.streak, 0);
});

test("StateMachine: De-Eskalation braucht N konsekutive Bestätigungen", () => {
  const m = new MarketRegimeStateMachine();
  m.update("HIGH_VOL", 3);
  assert.equal(m.update("RANGE", 3).changed, false, "Streak 1 < 3");
  assert.equal(m.update("RANGE", 3).changed, false, "Streak 2 < 3");
  assert.equal(m.update("RANGE", 3).changed, true, "Streak 3 = 3 → Wechsel");
  assert.equal(m.regime, "RANGE");
});

test("StateMachine: Seitwärtswechsel (TREND_UP → TREND_DOWN) braucht ebenfalls Bestätigung", () => {
  const m = new MarketRegimeStateMachine();
  m.update("TREND_UP", 2);
  assert.equal(MARKET_REGIME_SEVERITY.TREND_UP, MARKET_REGIME_SEVERITY.TREND_DOWN);
  assert.equal(m.update("TREND_DOWN", 2).changed, false, "Streak 1 < 2");
  assert.equal(m.update("TREND_DOWN", 2).changed, true, "Streak 2 = 2 → Wechsel");
  assert.equal(m.regime, "TREND_DOWN");
});

test("StateMachine: Unterbrechung (anderer Kandidat) setzt die Bestätigungs-Streak zurück", () => {
  const m = new MarketRegimeStateMachine();
  m.update("HIGH_VOL", 3);
  // De-Eskalations-Streak Richtung RANGE mit Unterbrechung durch TREND_DOWN:
  assert.equal(m.update("RANGE", 3).changed, false, "Streak 1");
  assert.equal(m.update("RANGE", 3).changed, false, "Streak 2");
  assert.equal(m.update("TREND_DOWN", 3).changed, false, "anderer Kandidat → Reset, Streak 1 für TREND_DOWN");
  assert.equal(m.regime, "HIGH_VOL");
  // Jetzt braucht RANGE wieder drei frische Bestätigungen:
  assert.equal(m.update("RANGE", 3).changed, false, "neue Streak 1 < 3");
  assert.equal(m.update("RANGE", 3).changed, false, "Streak 2 < 3");
  assert.equal(m.update("RANGE", 3).changed, true, "Streak 3 = 3");
  assert.equal(m.regime, "RANGE");
  // Eskalation unterbricht ihrerseits und wirkt sofort:
  assert.equal(m.update("TREND_UP", 3).changed, true, "RANGE → TREND_UP ist Eskalation (sofort)");
});

test("StateMachine: confirmCandles=1 → sofortige De-Eskalation; kaputter Wert fällt auf 1", () => {
  const m = new MarketRegimeStateMachine();
  m.update("CRASH", 1);
  assert.equal(m.update("RANGE", 1).changed, true);
  const m2 = new MarketRegimeStateMachine();
  m2.update("HIGH_VOL", Number.NaN);
  assert.equal(m2.update("RANGE", Number.NaN).changed, true, "NaN → need=1 → sofort");
});

// ── Hysterese: End-to-End über den Tracker (mit Kerzen) ─────────────────────

test("Tracker: bestätigte Range-Serie de-eskaliert TREND_UP → RANGE nach 3 Bewertungen", () => {
  const trend = candlesFromCloses(linear(60, 100, 0.1));
  const range = candlesFromCloses(rangeSeries());
  const c = cfg();

  const first = evaluateInstrumentRegime("TEST/TREND", trend, { cfg: c, now: T0, audit: false });
  assert.equal(first.regime, "TREND_UP");

  // Drei konsekutive RANGE-Kandidaten: erst der dritte wechselt.
  const e1 = evaluateInstrumentRegime("TEST/TREND", range, { cfg: c, now: T0 + STEP, audit: false });
  assert.equal(e1.regime, "TREND_UP", "1. Bestätigung < 3 → bleibt");
  const e2 = evaluateInstrumentRegime("TEST/TREND", range, { cfg: c, now: T0 + 2 * STEP, audit: false });
  assert.equal(e2.regime, "TREND_UP", "2. Bestätigung < 3 → bleibt");
  const e3 = evaluateInstrumentRegime("TEST/TREND", range, { cfg: c, now: T0 + 3 * STEP, audit: false });
  assert.equal(e3.regime, "RANGE", "3. Bestätigung → Wechsel");
  assert.equal(e3.changeCount, 2, "UNKNOWN→TREND_UP und TREND_UP→RANGE");
  assert.equal(e3.lastChange?.code, "regime:TEST/TREND:TREND_UP→RANGE");
});

test("Tracker: UNKNOWN lässt die Hysterese-Maschine unangetastet", () => {
  const trend = candlesFromCloses(linear(60, 100, 0.1));
  const c = cfg();
  evaluateInstrumentRegime("TEST/KEEP", trend, { cfg: c, now: T0, audit: false });

  const unknown = evaluateInstrumentRegime("TEST/KEEP", candlesFromCloses(linear(5, 100, 0.1)), {
    cfg: c,
    now: T0 + STEP,
    audit: false,
  });
  assert.equal(unknown.regime, "UNKNOWN", "zu wenig Kerzen → UNKNOWN-Kennzeichnung");

  const back = evaluateInstrumentRegime("TEST/KEEP", trend, { cfg: c, now: T0 + 2 * STEP, audit: false });
  assert.equal(back.regime, "TREND_UP", "Maschine behält ihr Regime über UNKNOWN hinweg");
});

test("Tracker: Verlauf + Audit-Code-Format je Regime-Wechsel", () => {
  const c = cfg();
  const snap = evaluateInstrumentRegime("BTC/USD", candlesFromCloses(crashSeries()), {
    cfg: c,
    now: T0,
    audit: false,
  });
  assert.equal(snap.regime, "CRASH");
  const read = getInstrumentRegime("BTC/USD");
  assert.ok(read);
  assert.equal(read.lastChange?.code, "regime:BTC/USD:UNKNOWN→CRASH");
  assert.equal(read.lastChange?.at, new Date(T0).toISOString());
});

test("refreshInstrumentRegimes: Min-Interval, Fehler-Resilienz, Obergrenze (injizierter Fetcher)", async () => {
  const c = cfg();
  const good = candlesFromCloses(linear(60, 100, 0.1));
  let calls = 0;
  const fetchCandles = async (symbol: string): Promise<typeof good> => {
    calls++;
    if (symbol === "BAD/USD") throw new Error("feed down");
    return good;
  };

  const out = await refreshInstrumentRegimes(["AAA/USD", "BAD/USD", "AAA/USD"], {
    cfg: c,
    now: T0,
    fetchCandles,
    audit: false,
  });
  assert.equal(calls, 2, "Dedup: AAA einmal, BAD einmal");
  assert.equal(out.length, 1, "BAD ohne Vorzustand und mit Fetch-Fehler → kein Eintrag");
  const aaa = out.find((s) => s.symbol === "AAA/USD");
  assert.equal(aaa?.regime, "TREND_UP");

  // Min-Interval: unmittelbar danach wird NICHT neu abgerufen.
  const before = calls;
  await refreshInstrumentRegimes(["AAA/USD"], { cfg: c, now: T0 + 10_000, fetchCandles, audit: false });
  assert.equal(calls, before, "innerhalb des Min-Intervalls kein Fetch");

  // Fehler-Resilienz mit Vorzustand: letzter Stand bleibt ausgewiesen.
  const later = await refreshInstrumentRegimes(["AAA/USD"], {
    cfg: c,
    now: T0 + 60_000,
    fetchCandles: async () => {
      throw new Error("feed down");
    },
    audit: false,
  });
  assert.equal(later[0]?.regime, "TREND_UP", "Datenfehler → letzter bekannter Stand, nie Raten");
});

// ── D2: Gate-Semantik ────────────────────────────────────────────────────────

test("Gate: enforce dämpft Mean-Reversion in TREND_UP exakt mit 0.5", () => {
  const g = applyRegimeGate({ regime: "TREND_UP", strategyClass: "mean-reversion", weight: 1, mode: "enforce" });
  assert.equal(g.factor, 0.5);
  assert.equal(g.effectiveWeight, 0.5);
  assert.equal(g.applied, true);
  const g2 = applyRegimeGate({ regime: "TREND_DOWN", strategyClass: "mean-reversion", weight: 0.8, mode: "enforce" });
  assert.equal(g2.effectiveWeight, 0.4);
});

test("Gate: enforce dämpft Breakout in RANGE exakt mit 0.5; Trend-Klasse bleibt 1", () => {
  const g = applyRegimeGate({ regime: "RANGE", strategyClass: "breakout", weight: 1, mode: "enforce" });
  assert.equal(g.factor, 0.5);
  assert.equal(g.applied, true);
  const t = applyRegimeGate({ regime: "RANGE", strategyClass: "trend", weight: 1, mode: "enforce" });
  assert.equal(t.factor, 1);
  assert.equal(t.applied, false, "Faktor 1 → keine Dämpfung, kein Audit-Zustand");
});

test("Gate: monitor ändert die Entscheidung NICHT (nur Ausweis)", () => {
  const g = applyRegimeGate({ regime: "TREND_UP", strategyClass: "mean-reversion", weight: 1, mode: "monitor" });
  assert.equal(g.factor, 0.5, "Faktor wird ausgewiesen …");
  assert.equal(g.effectiveWeight, 1, "… aber NICHT angewendet");
  assert.equal(g.applied, false);
  assert.match(g.reason, /monitor/i);
});

test("Gate: off → Faktor 1, keine Ausweisung, keine Wirkung", () => {
  const g = applyRegimeGate({ regime: "TREND_UP", strategyClass: "mean-reversion", weight: 1, mode: "off" });
  assert.equal(g.factor, 1);
  assert.equal(g.effectiveWeight, 1);
  assert.equal(g.applied, false);
});

test("Gate: UNKNOWN → Faktor 1 + Kennzeichnung, nie still (auch in enforce)", () => {
  const g = applyRegimeGate({ regime: "UNKNOWN", strategyClass: "mean-reversion", weight: 1, mode: "enforce" });
  assert.equal(g.factor, 1);
  assert.equal(g.applied, false);
  assert.equal(g.unknown, true);
  assert.match(g.reason, /UNKNOWN/);
});

test("Gate: ohne Strategieklasse kein Faktor (keine stillschweigende Zuordnung)", () => {
  const g = applyRegimeGate({ regime: "TREND_UP", strategyClass: null, weight: 1, mode: "enforce" });
  assert.equal(g.factor, 1);
  assert.equal(g.applied, false);
});

test("Gate: REGIME_GATE_FACTORS wird geparst und auf [0, 2] geklemmt", () => {
  const { factors, applied, skipped } = parseGateFactors(
    "TREND_UP:mean-reversion=0.25,HIGH_VOL:breakout=3,RANGE:breakout=-1,BOGUS:x=1,unparsebar"
  );
  assert.equal(factors.TREND_UP["mean-reversion"], 0.25);
  assert.equal(factors.HIGH_VOL.breakout, 2, "> 2 → geklemmt auf 2");
  assert.equal(factors.RANGE.breakout, 0, "< 0 → geklemmt auf 0");
  assert.equal(applied, 3);
  assert.equal(skipped, 2);
  // Defaults bleiben erhalten, wo nichts konfiguriert wurde:
  assert.equal(factors.TREND_DOWN["mean-reversion"], 0.5);
});

test("Gate: Boost > 1 ist im reinen Kontext erlaubt (Klemmung erst an den Ceilings)", () => {
  const { factors } = parseGateFactors("TREND_UP:trend=1.5");
  const c = cfg({ gateFactors: factors });
  const g = applyRegimeGate({ regime: "TREND_UP", strategyClass: "trend", weight: 1, mode: "enforce", cfg: c });
  assert.equal(g.factor, 1.5);
  assert.equal(g.effectiveWeight, 1.5);
  assert.equal(regimeGateFactor("TREND_UP", "trend", c), 1.5);
});

test("Gate: resolveRegimeGateForExecution wirkt nur in enforce (RAM-Lesezugriff)", () => {
  evaluateInstrumentRegime("EXEC/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: cfg(),
    now: T0,
    audit: false,
  });
  const monitor = resolveRegimeGateForExecution("EXEC/USD", "mean-reversion", cfg({ gateMode: "monitor" }));
  assert.equal(monitor.applied, false);
  assert.equal(monitor.factor, 1);
  const enforce = resolveRegimeGateForExecution("EXEC/USD", "mean-reversion", cfg({ gateMode: "enforce" }));
  assert.equal(enforce.applied, true);
  assert.equal(enforce.factor, 0.5);
  // Unbekanntes Symbol → UNKNOWN → fail-safe Faktor 1.
  const missing = resolveRegimeGateForExecution("NEVER/EVALUATED", "mean-reversion", cfg({ gateMode: "enforce" }));
  assert.equal(missing.regime, "UNKNOWN");
  assert.equal(missing.factor, 1);
  assert.equal(missing.applied, false);
});

// ── Strategieklasse aus Mission-Templates ────────────────────────────────────

test("strategyClassOfTemplate: deterministische Keyword-Zuordnung", () => {
  assert.equal(strategyClassOfTemplate("fx-mean-reversion"), "mean-reversion");
  assert.equal(strategyClassOfTemplate("indices-trend-follow"), "trend");
  assert.equal(strategyClassOfTemplate("commodities-trend"), "trend");
  assert.equal(strategyClassOfTemplate("crypto-momentum-247"), "trend");
  assert.equal(strategyClassOfTemplate("some-breakout-setup"), "breakout");
  assert.equal(strategyClassOfTemplate("baseline-hold"), null);
  assert.equal(strategyClassOfTemplate(""), null);
  assert.equal(strategyClassOfTemplate(null), null);
});

// ── Konfiguration: Defaults, Bounds, Env ────────────────────────────────────

test("Defaults + Bounds: PROMPT-06-Werte sind exakt hinterlegt", () => {
  assert.equal(DEFAULT_MARKET_REGIME_CONFIG.lookbackCandles, 100);
  assert.deepEqual(MARKET_REGIME_BOUNDS.lookbackCandles, [20, 500]);
  assert.equal(DEFAULT_MARKET_REGIME_CONFIG.crashDrawdownPct, 10);
  assert.deepEqual(MARKET_REGIME_BOUNDS.crashDrawdownPct, [3, 50]);
  assert.equal(DEFAULT_MARKET_REGIME_CONFIG.highVolPercentile, 90);
  assert.deepEqual(MARKET_REGIME_BOUNDS.highVolPercentile, [50, 99]);
  assert.equal(DEFAULT_MARKET_REGIME_CONFIG.confirmCandles, 3);
  assert.deepEqual(MARKET_REGIME_BOUNDS.confirmCandles, [1, 20]);
  assert.equal(DEFAULT_MARKET_REGIME_CONFIG.gateMode, "monitor", "Rollout monitor-first");
  assert.deepEqual(GATE_FACTOR_BOUNDS, [0, 2]);
});

test("loadMarketRegimeConfig: Env-Parsing mit Klemmung + fail-closed Modus", () => {
  const c = loadMarketRegimeConfig({
    REGIME_LOOKBACK_CANDLES: "1000", // → 500 (Bound)
    CRASH_DRAWDOWN_PCT: "1", // → 3 (Bound)
    HIGH_VOL_PERCENTILE: "49", // → 50 (Bound)
    REGIME_CONFIRM_CANDLES: "0", // → 1 (Bound)
    REGIME_GATE_MODE: "banana", // unbekannt → monitor (nie still enforce)
    REGIME_TREND_ADX: "abc", // ungültig → Default
    REGIME_GATE_FACTORS: "CRASH:mean-reversion=0.1",
  });
  assert.equal(c.lookbackCandles, 500);
  assert.equal(c.crashDrawdownPct, 3);
  assert.equal(c.highVolPercentile, 50);
  assert.equal(c.confirmCandles, 1);
  assert.equal(c.gateMode, "monitor");
  assert.equal(c.trendAdx, DEFAULT_MARKET_REGIME_CONFIG.trendAdx);
  assert.equal(c.gateFactors.CRASH["mean-reversion"], 0.1);
});

test("clampMarketRegimeConfig: ungültige Werte behalten den Basiswert", () => {
  const base = cfg({ lookbackCandles: 123 });
  const c = clampMarketRegimeConfig(
    { lookbackCandles: Number.NaN, crashDrawdownPct: Number.POSITIVE_INFINITY, gateMode: "enforce" },
    base
  );
  assert.equal(c.lookbackCandles, 123);
  assert.equal(c.crashDrawdownPct, base.crashDrawdownPct);
  assert.equal(c.gateMode, "enforce");
});

// ── D3: Ops-Status + Cycle-Artefakt ─────────────────────────────────────────

test("Ops-Status: ohne Bewertung leer, danach nach Schwere sortiert (CRASH zuerst)", () => {
  const empty = getMarketRegimeStatus(cfg());
  assert.equal(empty.instruments.length, 0);
  assert.equal(collectRegimeHistoryArtifact(cfg()), null, "ohne Daten kein Artefakt");

  const c = cfg();
  evaluateInstrumentRegime("UP/USD", candlesFromCloses(linear(60, 100, 0.1)), { cfg: c, now: T0, audit: false });
  evaluateInstrumentRegime("CRASH/USD", candlesFromCloses(crashSeries()), { cfg: c, now: T0, audit: false });
  evaluateInstrumentRegime("RANGE/USD", candlesFromCloses(rangeSeries()), { cfg: c, now: T0, audit: false });

  const status = getMarketRegimeStatus(c);
  assert.equal(status.mode, "monitor");
  assert.deepEqual(
    status.instruments.map((i) => i.symbol),
    ["CRASH/USD", "UP/USD", "RANGE/USD"],
    "Sortierung: Schwere absteigend (CRASH 3 > TREND_UP 1 > RANGE 0), dann Symbol"
  );
  assert.equal(status.instruments[0].regime, "CRASH");
});

test("Cycle-Artefakt: regime-history.json-Payload mit Verlauf je Instrument", () => {
  const c = cfg();
  evaluateInstrumentRegime("HIST/USD", candlesFromCloses(linear(60, 100, 0.1)), { cfg: c, now: T0, audit: false });
  evaluateInstrumentRegime("HIST/USD", candlesFromCloses(crashSeries()), { cfg: c, now: T0 + STEP, audit: false });

  const artifact = collectRegimeHistoryArtifact(c);
  assert.ok(artifact);
  // RMA-P2-01 (v1.61.0): SchemaVersion 2 — Confidence/Coverage/Degraded/
  // Versionen sind im Artefakt sichtbar (additive Felder, Historie gebounded).
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.mode, "monitor");
  assert.equal(artifact.featureMode, c.featureMode);
  assert.equal(artifact.featureVersion, "regime-features@1");
  assert.equal(artifact.modelVersion, "regime-rules@1");
  const entry = (artifact.instruments as Array<Record<string, unknown>>)[0];
  assert.equal(entry.symbol, "HIST/USD");
  assert.equal(entry.regime, "CRASH");
  assert.equal(entry.rawRegime, "CRASH");
  assert.equal(typeof entry.coverage, "number");
  assert.equal(entry.degraded, true, "ohne erweiterte Familien ⇒ Degraded Mode");
  assert.equal(typeof entry.confidence, "number");
  assert.ok(Array.isArray(entry.topDrivers));
  assert.ok(Array.isArray(entry.families));
  const history = entry.history as Array<{ code: string; coverage: number }>;
  assert.equal(history.length, 2);
  assert.equal(history[0].code, "regime:HIST/USD:UNKNOWN→TREND_UP");
  assert.equal(history[1].code, "regime:HIST/USD:TREND_UP→CRASH");
  assert.equal(typeof history[1].coverage, "number", "Wechselereignis trägt Coverage");
});

test("Prompt-Kontext: monitor Zeile ohne Wirkung, off leer, enforce Wirkzeile", () => {
  const c = cfg();
  const snap = evaluateInstrumentRegime("CTX/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: c,
    now: T0,
    audit: false,
  });
  const monitor = applyRegimeGate({ regime: snap.regime, strategyClass: "mean-reversion", weight: 1, mode: "monitor", cfg: c });
  const monitorLine = formatRegimeGateContext(snap, "mean-reversion", monitor);
  assert.match(monitorLine, /REGIME-GATE CTX\/USD/);
  assert.match(monitorLine, /MONITOR/);
  assert.match(monitorLine, /keine Wirkung/);

  const off = applyRegimeGate({ regime: snap.regime, strategyClass: "mean-reversion", weight: 1, mode: "off", cfg: c });
  assert.equal(formatRegimeGateContext(snap, "mean-reversion", off), "", "off → Prompt byte-identisch");

  const enforce = applyRegimeGate({ regime: snap.regime, strategyClass: "mean-reversion", weight: 1, mode: "enforce", cfg: c });
  assert.match(formatRegimeGateContext(snap, "mean-reversion", enforce), /WIRKT/);
});

test("Cycle-Artefakt-Verdrahtung: saveDailyCycleArtifacts schreibt regime-history.json", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const { saveDailyCycleArtifacts } = await import("../src/cycle/artifacts");
  const { readJsonSafe } = await import("../src/cycle/artifacts");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regime-artifacts-"));
  const c = cfg();
  evaluateInstrumentRegime("ART/USD", candlesFromCloses(linear(60, 100, 0.1)), {
    cfg: c,
    now: T0,
    audit: false,
  });

  const record = {
    id: "daily-regime-test",
    type: "daily",
    date: "2026-09-19",
    status: "COMPLETED",
    startedAt: new Date(T0).toISOString(),
    completedAt: new Date(T0 + 60_000).toISOString(),
    steps: [],
    escalations: [],
  };
  const res = saveDailyCycleArtifacts(record as never, {}, root);
  const regimeFile = res.filesWritten.find((f) => f.endsWith("regime-history.json"));
  assert.ok(regimeFile, "regime-history.json muss geschrieben werden, wenn Instrumente bewertet sind");
  const payload = readJsonSafe<{
    schemaVersion: number;
    instruments: { symbol: string; coverage?: number; degraded?: boolean }[];
  }>(regimeFile!);
  assert.equal(payload?.schemaVersion, 2);
  assert.ok(payload?.instruments.some((i) => i.symbol === "ART/USD"));
  const artEntry = payload?.instruments.find((i) => i.symbol === "ART/USD");
  assert.equal(typeof artEntry?.coverage, "number");
  assert.equal(artEntry?.degraded, true, "Cycle-Artefakt weist Degraded Mode aus");

  // Ohne Bewertungen im Prozess: kein (leeres) Artefakt.
  __resetMarketRegimeForTests();
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "regime-artifacts-"));
  const res2 = saveDailyCycleArtifacts({ ...record, id: "daily-regime-empty" } as never, {}, root2);
  assert.ok(!res2.filesWritten.some((f) => f.endsWith("regime-history.json")));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});

// ── Architektur: kein LLM im Klassifikator ───────────────────────────────────

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1]);
  const required = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = required.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

const FORBIDDEN_LLM_IMPORTS = /(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|langchain|prompt)/i;
const FORBIDDEN_ORDER_EXECUTION =
  /(placeOrder|executeOrder|createOrder|submitOrder|cancelOrder|flattenPosition)/i;

test("Architektur: marketRegime.ts importiert kein LLM-Modul (Null-LLM-Garantie)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/marketRegime.ts"), "utf8");
  for (const specifier of importsOf(source)) {
    assert.ok(
      !FORBIDDEN_LLM_IMPORTS.test(specifier),
      `marketRegime.ts importiert verbotenes LLM-Modul: "${specifier}"`
    );
  }
});

test("Architektur: marketRegime.ts enthält keine Order-Ausführung (Gate ≠ Veto)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/marketRegime.ts"), "utf8");
  assert.ok(!FORBIDDEN_ORDER_EXECUTION.test(source), "Regime-Gate darf keine Order-Funktionen aufrufen");
});

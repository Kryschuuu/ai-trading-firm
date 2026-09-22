/**
 * Tests: Backtest-Engine + Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0).
 *
 * Pflicht-Matrix:
 *   - `volatilityTargeting: undefined` (Default) ⇒ Byte-identische Läufe,
 *     kein Summary-Feld (kein stilles Verhalten)
 *   - Determinismus: gleicher Input ⇒ bit-identischer Faktor-Verlauf
 *   - Höhere Volatilität ⇒ kleinerer Faktor ⇒ kleinere Positionen (Sizing)
 *   - Kein Look-ahead: spätere Kerzen ändern factorByBar bis t NICHT
 *   - Faktor immer ∈ (0, 1]; Summary-Felder vollständig
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runMultiAssetBacktest } from "../src/backtest";
import type {
  BacktestStrategyItem,
  BacktestVolatilityTargetingConfig,
  MultiAssetBacktestResult,
} from "../src/backtest";
import type { CandleLike, RuleSpec } from "../src/lib/ruleEngine";

// ── Fixtures (deterministisch, keine Zufallsquelle) ─────────────────────────

const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

function candlesFromCloses(startTs: number, closes: number[], stepMs = H): CandleLike[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    return {
      time: startTs + i * stepMs,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1000 + (i % 7) * 100,
    };
  });
}

/**
 * Hohe, deterministische Volatilität: ±4 %-Schwankungen pro Bar ⇒
 * annualisiert (√8760) ≈ 0.04 × 93.6 ≈ 374 % p. a. — weit über jedem
 * Test-Ziel ⇒ der Faktor fällt auf den Boden (minMultiplier).
 */
function highVolCloses(count: number, mid = 100, ampPct = 0.04, periodBars = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((mid * (1 + ampPct * Math.sin((2 * Math.PI * i) / periodBars))).toFixed(4)));
  }
  return out;
}

function priceRule(symbol: string, threshold: number): RuleSpec {
  return {
    name: `Preis über ${threshold}`,
    symbol,
    missionId: null,
    rationale: "Test-Regel",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: threshold }] },
    action: {
      side: "LONG",
      stopLossPct: 5,
      takeProfitRR: 2,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
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

/**
 * VT-Config für den Test: volatiles Datenmaterial + enges Ziel ⇒ Faktor
 * fällt auf den Boden. `maxStep: 1` ⇒ sofortiger Schritt (kein Ramp-Noise).
 */
function vtConfig(overrides: BacktestVolatilityTargetingConfig["config"] = {}): BacktestVolatilityTargetingConfig {
  return {
    annualization: 8760, // 1h, 24/7-Krypto
    config: {
      targetAnnualizedVolPct: 30,
      lookbackPeriods: 48,
      minObservations: 24,
      smoothingAlpha: 1,
      maxStep: 1,
      shrinkage: 0,
      ...overrides,
    },
  };
}

function runWithVt(candles: CandleLike[], symbol: string, vt: BacktestVolatilityTargetingConfig | undefined) {
  const strategies: BacktestStrategyItem[] = [{ type: "rule", spec: priceRule(symbol, 100), id: "R-VT" }];
  return runMultiAssetBacktest({
    candlesBySymbol: new Map([[symbol, candles]]),
    strategies,
    config: {
      initialCapital: 10_000,
      warmupBars: 30,
      enableShorts: false,
      ...(vt === undefined ? {} : { volatilityTargeting: vt }),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Backtest × Volatility-Targeting (RMA-P5-01)", () => {
  const symbol = "VTTEST";
  const closes = highVolCloses(160);
  const candles = candlesFromCloses(T0, closes);

  it("undefined ⇒ Feature inaktiv: kein Summary-Feld, Läufe byte-identisch", () => {
    const off = runWithVt(candles, symbol, undefined);
    const offExplicit = runMultiAssetBacktest({
      candlesBySymbol: new Map([[symbol, candles]]),
      strategies: [{ type: "rule", spec: priceRule(symbol, 100), id: "R-VT" }],
      config: { initialCapital: 10_000, warmupBars: 30, enableShorts: false, volatilityTargeting: undefined },
    });

    assert.equal(off.volatilityTargeting, undefined, "inaktiv ⇒ Feld fehlt");
    assert.equal(offExplicit.volatilityTargeting, undefined);

    // Byte-Identität (ohne die nicht deterministische Laufzeit-Metrik).
    const strip = (r: MultiAssetBacktestResult) => {
      const { executionDurationMs: _d, ...rest } = r;
      return JSON.stringify(rest);
    };
    assert.equal(strip(offExplicit), strip(off));
    assert.ok(off.trades.length > 0, "Fixture muss Trades erzeugen");
  });

  it("aktiv ⇒ Summary vorhanden, Faktor-Verlauf vollständig und ∈ (0, 1]", () => {
    const on = runWithVt(candles, symbol, vtConfig());
    const vt = on.volatilityTargeting!;
    assert.ok(vt !== undefined, "aktiv ⇒ Summary-Feld vorhanden");
    assert.equal(vt.factorByBar.length, on.barsProcessed);
    for (const f of vt.factorByBar) {
      assert.ok(Number.isFinite(f) && f > 0 && f <= 1 + 1e-15, `Faktor ${f} verletzt (0, 1]`);
    }
    assert.ok(vt.updates > 0, "mind. eine Faktor-Berechnung");
    assert.ok(vt.lastAppliedMultiplier <= 1);
    assert.equal(vt.config.maxMultiplier, 1, "hartes Maximum bleibt 1");
    // Hohe Vol ⇒ mindestens ein Schritt unter Neutral (Faktor < 1).
    assert.ok(vt.factorByBar.some((f) => f < 1), "hohe Vol muss den Faktor senken");
  });

  it("Determinismus: zwei Läufe ⇒ bit-identischer Faktor-Verlauf + Summary", () => {
    const a = runWithVt(candles, symbol, vtConfig());
    const b = runWithVt(candles, symbol, vtConfig());
    assert.deepEqual(a.volatilityTargeting!.factorByBar, b.volatilityTargeting!.factorByBar);
    assert.equal(
      JSON.stringify(a.volatilityTargeting),
      JSON.stringify(b.volatilityTargeting)
    );
    // Und die Trades bleiben identisch (kein versteckter Zufall).
    assert.deepEqual(a.trades, b.trades);
  });

  it("höhere Vol ⇒ kleinerer Sizing: Einstieg mit offener Exposure deutlich kleiner", () => {
    // Zwei Symbole: VTTEST2 (Phasenversatz +4 Bars) kreuzt die Schwelle ZUERST
    // (Bar 32), VTTEST ein Bar später (Bar 33). Beim VTTEST-Einstieg ist die
    // VTTEST2-Position bereits offen ⇒ der Faktor (< 1) reduziert das
    // Risikobudget ⇒ kleineres Notional als im Lauf ohne VT.
    const aCandles = candlesFromCloses(T0, highVolCloses(160));
    const bCloses = highVolCloses(160).map((v, i) =>
      Number((100 * (1 + 0.04 * Math.sin((2 * Math.PI * (i + 4)) / 16))).toFixed(4))
    );
    const bCandles = candlesFromCloses(T0, bCloses);
    const strategies: BacktestStrategyItem[] = [
      { type: "rule", spec: priceRule("VTTEST", 100), id: "R-A" },
      { type: "rule", spec: priceRule("VTTEST2", 100), id: "R-B" },
    ];
    const runBoth = (vt: BacktestVolatilityTargetingConfig | undefined) =>
      runMultiAssetBacktest({
        candlesBySymbol: new Map([["VTTEST", aCandles], ["VTTEST2", bCandles]]),
        strategies,
        config: {
          initialCapital: 10_000,
          warmupBars: 30,
          enableShorts: false,
          ...(vt === undefined ? {} : { volatilityTargeting: vt }),
        },
      });

    const off = runBoth(undefined);
    const on = runBoth(vtConfig());

    const aOff = off.trades.filter((t) => t.symbol === "VTTEST");
    const aOn = on.trades.filter((t) => t.symbol === "VTTEST");
    assert.ok(aOff.length >= 1 && aOn.length >= 1, "beide Läufe brauchen VTTEST-Trades");

    // Erster VTTEST-Einstieg: entryTime muss in beiden Läufen identisch sein
    // (dieselbe Signalsequenz), das Notional aber kleiner im VT-Lauf.
    const firstOff = aOff[0];
    const firstOn = aOn.find((t) => t.entryTime === firstOff.entryTime);
    assert.ok(firstOn, `VTTEST-Einstieg bei ${firstOff.entryTime} fehlt im VT-Lauf`);
    assert.ok(
      firstOn.notional < firstOff.notional,
      `Notional ${firstOn.notional} (VT) sollte < ${firstOff.notional} (ohne VT)`
    );
    // Der Faktor am Einstieg-Bar ist < 1 (Exposure war offen).
    // Timeline: Index k = Bar mit Zeit T0 + k·H (barStep − 1).
    const factorAtEntry = on.volatilityTargeting!.factorByBar[Math.floor((firstOff.entryTime - T0) / H)];
    assert.ok(factorAtEntry !== undefined && factorAtEntry < 1, `Faktor am Einstieg ${factorAtEntry} sollte < 1`);
  });

  it("kein Look-ahead: spätere Kerzen ändern factorByBar bis t NICHT", () => {
    // Lauf A: 100 Kerzen. Lauf B: identisches Präfix + 60 Kerzen, die die
    // Volatilitätsstatistik JEDER Full-Series-Betrachtung verschieben würden.
    const prefix = candlesFromCloses(T0, highVolCloses(100));
    const extendedCloses = [
      ...highVolCloses(100),
      ...Array.from({ length: 60 }, (_, i) =>
        Number((100 * (1 + 0.2 * Math.sin(i / 3))).toFixed(4)) // 20 %-Vol-Schock
      ),
    ];
    const extended = candlesFromCloses(T0, extendedCloses);

    const runA = runWithVt(prefix, symbol, vtConfig());
    const runB = runWithVt(extended, symbol, vtConfig());

    assert.ok(runA.volatilityTargeting!.updates > 0);
    const t = prefix[prefix.length - 1].time;
    const barA = runA.volatilityTargeting!.factorByBar;
    const barB = runB.volatilityTargeting!.factorByBar;
    assert.ok(barB.length > barA.length, "erweiterter Lauf hat mehr Bars");
    // Alle Bars bis t (Index < length(barA)) sind bit-identisch.
    assert.deepEqual(barB.slice(0, barA.length), barA);
    void t;
  });

  it("Fallback-Pfad im Backtest: zu wenig Daten ⇒ minMultiplier, Summary zahlt Fallbacks", () => {
    // Extrem kurzes Fenster (minObservations > verfügbare Bars nach dem
    // ersten Einstieg) ⇒ INSUFFICIENT_DATA-Fallback ⇒ Faktor = minMultiplier.
    const shortCandles = candlesFromCloses(T0, highVolCloses(40));
    const on = runMultiAssetBacktest({
      candlesBySymbol: new Map([[symbol, shortCandles]]),
      strategies: [{ type: "rule", spec: priceRule(symbol, 100), id: "R-VT" }],
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        enableShorts: false,
        volatilityTargeting: vtConfig({ minObservations: 100, lookbackPeriods: 96 }),
      },
    });
    const vt = on.volatilityTargeting!;
    // Jeder Schritt mit Exposure fällt auf den Boden (minMultiplier = 0.25).
    const exposureSteps = vt.factorByBar.filter((f) => f < 1 - 1e-9);
    if (exposureSteps.length > 0) {
      assert.ok(vt.fallbacks > 0, "Fallbacks müssen gezählt werden");
      assert.ok(vt.fallbacksByReason.INSUFFICIENT_DATA ?? 0 > 0, "Grund-Code INSUFFICIENT_DATA");
      for (const f of exposureSteps) {
        assert.ok(Math.abs(f - 0.25) < 1e-9, `Fallback-Faktor 0.25 erwartet, kam ${f}`);
      }
    } else {
      // Keine Exposure-Schritte (Regel triggert nie) ⇒ kein Fallback.
      assert.equal(vt.fallbacks, 0);
    }
  });
});

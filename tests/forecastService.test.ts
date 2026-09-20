/**
 * Forecast-Service — Capture bis Scorebericht ohne Datenbank
 * (RMA-P3-01, v1.55.0).
 *
 * Prüft den End-to-End-Pfad des Captures (Analysten-Ausgabe → Vertrag →
 * Ledger) und die Unabhängigkeit der Auswertung von Trades: derselbe
 * Forecast wird ausschließlich aus Outcome-Daten bewertet. Zusätzlich:
 * Feature-Flag-Rollback, Idempotenz und fail-closed-Verhalten bei
 * fehlender Referenzkerze.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { captureAnalystForecast, forecastScoreReport } from "../src/forecasts/service";
import { runForecastResolution } from "../src/forecasts/resolver";
import { FORECAST_SETTLE_GRACE_MS } from "../src/forecasts/types";
import {
  barOf,
  FC_HOUR,
  FC_T0,
  InMemoryForecastLedger,
  InMemoryOutcomeStore,
} from "./fixtures/forecastTestUtil";

const HOUR = FC_HOUR;

function captureDeps(ledger: InMemoryForecastLedger, store: InMemoryOutcomeStore, opts: { referenceClose?: number | null } = {}) {
  return {
    ledger,
    outcomeSource: store,
    enabled: true,
    regimeProvider: () => "ELEVATED",
    referenceProvider: async (symbol: string, asOf: Date) => {
      const closeAt = Math.floor(asOf.getTime() / HOUR) * HOUR;
      const close = opts.referenceClose ?? null;
      if (close === null) return { referenceClose: null, referenceTime: null, bars: [] };
      return {
        referenceClose: close,
        referenceTime: new Date(closeAt),
        bars: [barOf(closeAt, close)],
      };
    },
  };
}

describe("forecastService: Capture-Hook", () => {
  it("gültige Analyse ⇒ Forecast im Ledger (PAPER-Entity, Regime, Promptversion)", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const result = await captureAnalystForecast(
      {
        role: "TECHNICAL_ANALYST",
        symbol: "BTC",
        view: "BULLISH",
        confidence: 0.6,
        promptVersion: 7,
        model: "qwen-test",
        asOf: new Date(FC_T0 + 30 * 60_000),
      },
      captureDeps(ledger, store, { referenceClose: 100 })
    );
    assert.equal(result.captured, true);
    assert.equal(ledger.forecastCount(), 1);
    const view = await ledger.loadForecast(result.forecastId!);
    assert.ok(view);
    assert.equal(view.contract.entityId, "PAPER:BTC");
    assert.equal(view.contract.agentRole, "TECHNICAL_ANALYST");
    assert.equal(view.contract.promptVersion, 7);
    assert.equal(view.contract.regime, "ELEVATED");
    assert.deepEqual([...view.contract.probabilities], [0.2, 0.8]);
    assert.equal(view.status, "PENDING");
    // Die Referenzkerze wurde in den Outcome-Store geschrieben.
    assert.equal(store.barCount("PAPER:BTC", "1h"), 1);
  });

  it(" identische Wiederholung ⇒ Idempotenz-Treffer (kein zweiter Forecast)", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const input = {
      role: "TECHNICAL_ANALYST",
      symbol: "BTC",
      view: "BULLISH",
      confidence: 0.6,
      promptVersion: 7,
      model: "qwen-test",
      asOf: new Date(FC_T0 + 30 * 60_000),
    };
    const first = await captureAnalystForecast(input, captureDeps(ledger, store, { referenceClose: 100 }));
    const second = await captureAnalystForecast(input, captureDeps(ledger, store, { referenceClose: 100 }));
    assert.equal(first.captured, true);
    assert.equal(second.captured, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.forecastId, first.forecastId);
    assert.equal(ledger.forecastCount(), 1);
  });

  it("FORECAST_LEDGER_ENABLED=false ⇒ kein Capture (Rollback-Pfad)", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const result = await captureAnalystForecast(
      {
        role: "TECHNICAL_ANALYST",
        symbol: "BTC",
        view: "BULLISH",
        confidence: 0.6,
        promptVersion: 1,
        model: "m",
        asOf: new Date(FC_T0 + 30 * 60_000),
      },
      { ...captureDeps(ledger, store, { referenceClose: 100 }), enabled: false }
    );
    assert.equal(result.captured, false);
    assert.equal(result.reason, "DISABLED");
    assert.equal(ledger.forecastCount(), 0);
  });

  it("fehlende Referenzkerze ⇒ NO_REFERENCE_DATA (fail-closed)", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const result = await captureAnalystForecast(
      {
        role: "TECHNICAL_ANALYST",
        symbol: "BTC",
        view: "BULLISH",
        confidence: 0.6,
        promptVersion: 1,
        model: "m",
        asOf: new Date(FC_T0 + 30 * 60_000),
      },
      captureDeps(ledger, store, { referenceClose: null })
    );
    assert.equal(result.captured, false);
    assert.equal(result.reason, "NO_REFERENCE_DATA");
    assert.equal(ledger.forecastCount(), 0);
  });

  it("Rollen ohne Ziel-Entity werden nicht erfasst", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const result = await captureAnalystForecast(
      {
        role: "MACRO_ANALYST",
        symbol: null,
        view: "BULLISH",
        confidence: 0.6,
        promptVersion: 1,
        model: "m",
        asOf: new Date(FC_T0 + 30 * 60_000),
      },
      captureDeps(ledger, store, { referenceClose: 100 })
    );
    assert.equal(result.captured, false);
    assert.equal(result.reason, "ROLE_NOT_FORECASTABLE");
  });
});

describe("forecastService: End-to-End Capture → Auflösung → Scorebericht", () => {
  it("Forecasts werden unabhängig von Trades bewertet (Brier + Coverage + Segmente)", async () => {
    const ledger = new InMemoryForecastLedger();
    const store = new InMemoryOutcomeStore();
    const deps = {
      ledger,
      outcomeRead: store,
      outcomeWrite: store,
      now: () => now,
      codeVersion: "test",
    } as const;
    let now = new Date(FC_T0 + 30 * 60_000);

    // Zwei TECH-Forecasts (verschiedene Zeitfenster), ein SCOUT-Forecast.
    const c1 = await captureAnalystForecast(
      { role: "TECHNICAL_ANALYST", symbol: "BTC", view: "BULLISH", confidence: 0.6, promptVersion: 7, model: "m", asOf: new Date(FC_T0 + 30 * 60_000) },
      captureDeps(ledger, store, { referenceClose: 100 })
    );
    const c2 = await captureAnalystForecast(
      { role: "TECHNICAL_ANALYST", symbol: "BTC", view: "BEARISH", confidence: 0.4, promptVersion: 7, model: "m", asOf: new Date(FC_T0 + 90 * 60_000) },
      captureDeps(ledger, store, { referenceClose: 101 })
    );
    assert.ok(c1.captured && c2.captured);

    // Kerzen: 00:00=100, 01:00=101, 04:00=105 (Forecast 1 ⇒ UP),
    // 05:00=99 (Forecast 2, Referenz 01:00=101 ⇒ DOWN).
    const bars = [barOf(FC_T0 + 4 * HOUR, 105), barOf(FC_T0 + 5 * HOUR, 99)];
    await store.appendBars("PAPER:BTC", "1h", bars, new Date(FC_T0 + 5 * HOUR + 30 * 60_000));

    now = new Date(FC_T0 + 24 * HOUR);
    const run = await runForecastResolution(deps);
    assert.equal(run.counts.resolved, 2);
    assert.equal(run.counts.voided, 0);

    // Scorebericht aus dem Ledger — ohne jeden Trade-Bezug. Ohne explizites
    // minSample gilt die Default-Mindeststichprobe (30) ⇒ n=2 bleibt
    // sichtbar, trägt aber `insufficient-sample`.
    const report = await forecastScoreReport(
      { entityId: "PAPER:BTC", now: new Date(FC_T0 + 24 * HOUR) },
      { ledger }
    );
    assert.equal(report.totalCount, 2);
    assert.equal(report.overall.resolvedCount, 2);
    assert.equal(report.overall.coverage, 1);
    // Forecast 1 (BULLISH 0.6): p_up=0.8, y=1 ⇒ (0.2)²=0.04.
    // Forecast 2 (BEARISH 0.4): p_up=0.3, Kurs fiel ⇒ Target UP nicht
    // eingetreten ⇒ y=0 ⇒ (0.3)²=0.09.  BS = (0.04+0.09)/2 = 0.065.
    assert.ok(Math.abs((report.overall.brierScore ?? Number.NaN) - (0.04 + 0.09) / 2) < 1e-12);
    assert.ok(report.overall.reliability.length === 10);
    assert.ok(report.overall.brierUncertainty !== null);
    assert.equal(report.overall.status, "insufficient-sample", "n=2 < Default-Mindeststichprobe bleibt sichtbar");
    assert.equal(report.segments.length, 1);
    assert.equal(report.segments[0].key.agentRole, "TECHNICAL_ANALYST");
    assert.equal(report.segments[0].key.horizonId, "4h");

    // VOID wirkt in Coverage, nie im Score: dritter Forecast ohne Kerzen.
    await captureAnalystForecast(
      { role: "SWING_RESEARCHER", symbol: "NVDA", view: "BULLISH", confidence: 0.5, promptVersion: 2, model: "m", asOf: new Date(FC_T0 + 30 * 60_000) },
      captureDeps(ledger, store, { referenceClose: 50 })
    );
    now = new Date(FC_T0 + 96 * HOUR + FORECAST_SETTLE_GRACE_MS + HOUR);
    const run2 = await runForecastResolution(deps);
    assert.equal(run2.counts.voided, 1);
    const nvda = await forecastScoreReport(
      { entityId: "PAPER:NVDA", now: new Date(FC_T0 + 120 * HOUR) },
      { ledger }
    );
    assert.equal(nvda.overall.resolvedCount, 0);
    assert.equal(nvda.overall.voidCount, 1);
    assert.equal(nvda.overall.brierScore, null, "VOID erzeugt keinen Score");
    assert.equal(nvda.overall.coverage, 1);
  });
});

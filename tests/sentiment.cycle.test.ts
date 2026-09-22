/**
 * Tests: Kalibrierbare strukturierte Sentiment-Outputs — Cycle Integration (RMA-P2-05).
 *
 * Prüft das Zusammenspiel im täglichen Zyklus:
 *   - newsStep liefert angereicherte, kalibrierbare StructuredSentimentForecasts
 *   - Instrumente ohne Quellen werden als ABSTAIN (coverage = 0) ausgewiesen
 *   - riskStep kann den News-Analyst-Output ohne Fehler oder Typbrüche verarbeiten
 *   - Fallback-Verhalten bei Agenten-Ausfall ist fail-closed und strukturiert
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { newsStep, type NewsStepInput } from "../src/cycle/steps/newsStep";
import { riskStep, type RiskStepInput } from "../src/cycle/steps/riskStep";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import type { StepExecutionContext } from "../src/cycle/types";

function createMockContext<T>(
  input: T,
  ports = createTestPorts(),
  previousOutputs: Record<string, unknown> = {}
): StepExecutionContext<T> {
  const clock = new SimulatedClock(new Date("2026-09-22T09:00:00Z"));
  const logs: string[] = [];

  return {
    cycleId: "test-cycle-p2-05",
    date: "2026-09-22",
    asOf: clock.now(),
    clock,
    input,
    previousStepOutputs: previousOutputs,
    ports,
    emitEscalation: () => {},
    log: (msg: string) => logs.push(msg),
  };
}

describe("RMA-P2-05: Cycle Step 5 (News Analyst) & Step 6 (Risk Manager)", () => {
  it("erzeugt aktive Sentiment-Forecasts für Instrumente mit News und ABSTAIN für Instrumente ohne News", async () => {
    const symbols = ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT"];
    const news = [
      {
        headline: "Bitcoin surges to new monthly high on ETF volume",
        source: "CoinDesk",
        symbol: "BINANCE:BTCUSDT",
        publishedAt: "2026-09-22T08:00:00Z",
      },
    ];

    const ports = createTestPorts();
    ports.agent.setResponseForRole("NEWS_ANALYST", {
      analyses: [
        {
          instrumentId: "BINANCE:BTCUSDT",
          sentiment: "BULLISH",
          impactScore: 80,
          riskFlags: [],
          summary: "Starker ETF-Zufluss treibt BTC",
        },
        {
          instrumentId: "BINANCE:ETHUSDT",
          sentiment: "NEUTRAL",
          impactScore: 50,
          riskFlags: [],
          summary: "Keine wesentlichen News",
        },
        {
          instrumentId: "BINANCE:SOLUSDT",
          sentiment: "NEUTRAL",
          impactScore: 50,
          riskFlags: [],
          summary: "Keine News",
        },
      ],
      systemicRisk: {
        level: "LOW",
        headline: "Ruhiger Gesamtmarkt",
        affectedSectors: [],
      },
    });

    const ctx = createMockContext<NewsStepInput>({ symbols, externalNews: news }, ports);
    const result = await newsStep.execute(ctx);
    assert.equal(result.analyses.length, 3);

    // BTC hat News => ACTIVE
    const btc = result.analyses.find((a) => a.instrumentId === "BINANCE:BTCUSDT");
    assert.ok(btc);
    assert.equal(btc?.sentiment, "BULLISH");
    assert.equal(btc?.status, "ACTIVE");
    assert.equal(btc?.abstain, false);
    assert.ok((btc?.coverage ?? 0) > 0);
    assert.ok((btc?.probability ?? 0) > 0.5);

    // SOL hat keine News => ABSTAIN
    const sol = result.analyses.find((a) => a.instrumentId === "BINANCE:SOLUSDT");
    assert.ok(sol);
    assert.equal(sol?.status, "ABSTAIN");
    assert.equal(sol?.abstain, true);
    assert.equal(sol?.abstainReason, "NO_SOURCES");
    assert.equal(sol?.coverage, 0);
    assert.equal(sol?.probability, null);
    // Legacy-Feld bleibt als NEUTRAL lesbar
    assert.equal(sol?.sentiment, "NEUTRAL");
  });

  it("deterministischer Fallback bei Agenten-Fehlschlag erzeugt strukturierte Envelopes", async () => {
    const symbols = ["BINANCE:BTCUSDT"];
    // Kein Mock-Agent konfiguriert => ruft Fallback auf
    const ports = createTestPorts();
    const ctx = createMockContext<NewsStepInput>({ symbols, externalNews: [] }, ports);

    const result = await newsStep.execute(ctx);
    assert.equal(result.analyses.length, 1);
    const item = result.analyses[0];
    assert.equal(item.status, "ABSTAIN");
    assert.equal(item.abstain, true);
    assert.equal(item.abstainReason, "NO_SOURCES");
    assert.equal(item.coverage, 0);
    assert.equal(item.sentiment, "NEUTRAL");
  });

  it("Risk Manager (Step 6) kann News-Analyst-Ergebnis konsumieren und kritisches Risiko ablehnen", async () => {
    const symbols = ["BINANCE:BTCUSDT", "BINANCE:DANGERUSDT"];

    const newsOutput = {
      analyses: [
        {
          instrumentId: "BINANCE:BTCUSDT",
          sentiment: "BULLISH" as const,
          impactScore: 80,
          riskFlags: [],
          summary: "Positiv",
          status: "ACTIVE" as const,
          abstain: false,
          coverage: 1.0,
        },
        {
          instrumentId: "BINANCE:DANGERUSDT",
          sentiment: "BEARISH" as const,
          impactScore: 10, // < 20 => kritisches News-Risiko!
          riskFlags: ["HALT"],
          summary: "Handel ausgesetzt wegen Exploit",
          status: "ACTIVE" as const,
          abstain: false,
          coverage: 1.0,
        },
      ],
      systemicRisk: {
        level: "MEDIUM" as const,
        headline: "Exploit bei DANGER",
        affectedSectors: ["DeFi"],
      },
    };

    const ports = createTestPorts();
    ports.agent.setResponseForRole("RISK_MANAGER", {
      approvedCandidates: ["BINANCE:BTCUSDT"],
      rejectedCandidates: [{ instrumentId: "BINANCE:DANGERUSDT", reason: "Kritisches News-Risiko" }],
      correlationWarnings: [],
      maxPositionPct: 0.1,
      riskBudgetPerTrade: 0.01,
      rationale: "DANGER wegen kritischem News-Risiko abgelehnt",
    });

    const ctx = createMockContext<RiskStepInput>(
      { symbols },
      ports,
      { "05-news-analyst": newsOutput }
    );

    const riskResult = await riskStep.execute(ctx);
    assert.ok(riskResult.rejectedCandidates.some((r) => r.instrumentId === "BINANCE:DANGERUSDT"));
    assert.ok(riskResult.approvedCandidates.includes("BINANCE:BTCUSDT"));
  });
});

/**
 * Plausibilitäts-Schicht (GAP-08, D1).
 *
 *   - Gut-Fälle passieren unverändert; Schlechtfälle je Code liefern das
 *     korrekte `{code, field}` (inkl. Grenzwerte).
 *   - Retry-Politik: erster Versuch invalid + zweiter valid → genau ein Retry;
 *     beide invalid → Skip + Audit + sichtbarer Zustand (kein Setup-Export).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { researchStep } from "../src/cycle/steps/researchStep";
import { macroStep } from "../src/cycle/steps/macroStep";
import { validateResearchOutput } from "../src/cycle/schemas";
import type { StepExecutionContext } from "../src/cycle/types";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import {
  adaptResearchOutput,
  checkConfidenceRationale,
  checkDecisionPlausibility,
  checkHallucinatedPrices,
  checkMonotonicity,
  checkPriceBand,
  extractPriceCandidates,
  findingCodes,
  formatPlausibilityFeedback,
  loadPlausibilityConfig,
  plausibilityAuditReason,
  runPlausibilitySpec,
  type PlausibilityCandle,
  type PlausibleDecision,
} from "../src/cycle/plausibility";

// ─────────────────────────────────────────────────────────────────────────────
// Helfer
// ─────────────────────────────────────────────────────────────────────────────

const BTC_CANDLES: PlausibilityCandle[] = [
  { close: 65000, high: 65200, low: 64500 },
  { close: 65400, high: 65600, low: 64900 },
  { close: 65600, high: 65800, low: 65100 },
];

const LONG_OK: PlausibleDecision = {
  instrumentId: "BINANCE:BTCUSDT",
  side: "LONG",
  entryPrice: 65400,
  stopLoss: 64000,
  takeProfit: 68500,
  confidence: 0.6,
  rationale: "Long-Fortsetzung am aufsteigenden Trendkanal mit klarem Stop unter dem letzten Tief.",
};

function mockContext<T>(input: T, ports = createTestPorts(), previousOutputs = {}): StepExecutionContext<T> {
  const clock = new SimulatedClock();
  return {
    cycleId: "test-cycle",
    date: "2026-09-19",
    asOf: clock.now(),
    clock,
    input,
    previousStepOutputs: previousOutputs,
    ports,
    emitEscalation: () => {},
    log: () => {},
  };
}

/** Historie in ein Temp-Verzeichnis seeden; gibt das Verzeichnis zurück. */
function seedHistory(
  series: Record<string, Array<{ close: number; high: number; low: number }>>,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gap08-history-"));
  const store = new HistoricalStore(dir);
  const baseTs = Date.parse("2026-09-10T00:00:00.000Z");
  for (const [instrumentId, candles] of Object.entries(series)) {
    store.append(
      candles.map((c, i) => ({
        time: baseTs + i * 3_600_000,
        open: c.close,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 100,
      })),
      instrumentId,
      { venue: "TEST", feed: "test" },
      "1h",
      new Date(baseTs),
    );
  }
  return dir;
}

function emptyHistoryDir(): string {
  return mkdtempSync(path.join(tmpdir(), "gap08-history-empty-"));
}

/** Führt `fn` mit übersteuertem PAPER_HISTORY_DIR aus (danach Restore). */
async function withHistoryDir<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.PAPER_HISTORY_DIR;
  process.env.PAPER_HISTORY_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PAPER_HISTORY_DIR;
    else process.env.PAPER_HISTORY_DIR = prev;
  }
}

function researchResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    setups: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        side: "LONG",
        entryPrice: 65400,
        stopLoss: 64000,
        takeProfit: 68500,
        riskScore: 0.4,
        timeframe: "4h",
        thesis: "Long-Fortsetzung am aufsteigenden Trendkanal mit klarem Stop unter dem letzten Tief.",
        isProposal: true,
        ...overrides,
      },
    ],
    totalSetups: 1,
    disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regel (a): Monotonie
// ─────────────────────────────────────────────────────────────────────────────

test("Plausibilität (a): valides LONG/Setup passiert die Monotonie-Regel", () => {
  assert.deepEqual(checkMonotonicity(LONG_OK, "setups[0]"), []);
  assert.deepEqual(
    checkMonotonicity(
      { side: "SHORT", entryPrice: 3490, stopLoss: 3580, takeProfit: 3350 },
      "setups[0]",
    ),
    [],
  );
});

test("Plausibilität (a): LONG mit Stop über Entry → MONOTONICITY", () => {
  const findings = checkMonotonicity(
    { ...LONG_OK, stopLoss: 66000 },
    "setups[0]",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "MONOTONICITY");
  assert.equal(findings[0].field, "setups[0].stopLoss");
});

test("Plausibilität (a): SHORT mit TP über Entry → MONOTONICITY (gespiegelt)", () => {
  const findings = checkMonotonicity(
    { side: "SHORT", entryPrice: 3490, stopLoss: 3580, takeProfit: 3550 },
    "setups[0]",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "MONOTONICITY");
  assert.equal(findings[0].field, "setups[0].takeProfit");
});

test("Plausibilität (a): Gleichheit verletzt die strikte Monotonie", () => {
  const findings = checkMonotonicity({ ...LONG_OK, stopLoss: 65400 }, "setups[0]");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "MONOTONICITY");
});

// ─────────────────────────────────────────────────────────────────────────────
// Regel (b): Preisband
// ─────────────────────────────────────────────────────────────────────────────

test("Plausibilität (b): Preise im Band passieren, Ausreißer → PRICE_RANGE", () => {
  const ok = checkPriceBand(LONG_OK, BTC_CANDLES, 15, "setups[0]");
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.referenceMissing, false);

  const bad = checkPriceBand(
    { ...LONG_OK, entryPrice: 150000, stopLoss: 140000, takeProfit: 165000 },
    BTC_CANDLES,
    15,
    "setups[0]",
  );
  assert.equal(bad.findings.length, 3);
  assert.ok(bad.findings.every((f) => f.code === "PRICE_RANGE"));
  assert.deepEqual(
    bad.findings.map((f) => f.field).sort(),
    ["setups[0].entryPrice", "setups[0].stopLoss", "setups[0].takeProfit"],
  );
});

test("Plausibilität (b): Bandgrenzen sind inklusive", () => {
  const candles: PlausibilityCandle[] = [{ close: 100, high: 104, low: 98 }];
  const edge = checkPriceBand(
    { entryPrice: 115, stopLoss: 85, takeProfit: 100 },
    candles,
    15,
    "setups[0]",
  );
  assert.deepEqual(edge.findings, []);
  const outside = checkPriceBand({ entryPrice: 115.01 }, candles, 15, "setups[0]");
  assert.equal(outside.findings.length, 1);
  assert.equal(outside.findings[0].field, "setups[0].entryPrice");
});

test("Plausibilität (b): ohne Kerzen → referenceMissing statt Raten", () => {
  const result = checkPriceBand(LONG_OK, [], 15, "setups[0]");
  assert.deepEqual(result.findings, []);
  assert.equal(result.referenceMissing, true);
});

test("Plausibilität (b): ohne Preise nicht anwendbar (Makro-Fall)", () => {
  const result = checkPriceBand({ confidence: 0.5, rationale: "These" }, [], 15, "macro");
  assert.deepEqual(result.findings, []);
  assert.equal(result.referenceMissing, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regel (c): Confidence vs. Begründung
// ─────────────────────────────────────────────────────────────────────────────

test("Plausibilität (c): hohe Confidence ohne Begründung → RATIONALE_MISSING", () => {
  const findings = checkConfidenceRationale(
    { confidence: 0.97, rationale: "Long breakout." },
    40,
    "setups[0]",
    "thesis",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "RATIONALE_MISSING");
  assert.equal(findings[0].field, "setups[0].thesis");
});

test("Plausibilität (c): Schwelle 0.9 exakt, darunter kein Befund", () => {
  assert.equal(
    checkConfidenceRationale({ confidence: 0.9, rationale: "kurz" }, 40, "s").length,
    1,
  );
  assert.deepEqual(
    checkConfidenceRationale({ confidence: 0.899, rationale: "kurz" }, 40, "s"),
    [],
  );
});

test("Plausibilität (c): exakt Mindestlänge passiert; 0 deaktiviert die Regel", () => {
  assert.deepEqual(
    checkConfidenceRationale({ confidence: 0.99, rationale: "x".repeat(40) }, 40, "s"),
    [],
  );
  assert.deepEqual(
    checkConfidenceRationale({ confidence: 0.99, rationale: "" }, 0, "s"),
    [],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regel (d): Zahlenbezug / Halluzinations-Heuristik
// ─────────────────────────────────────────────────────────────────────────────

test("Plausibilität (d): genannter Kurs außerhalb [minLow, maxHigh] → HALLUCINATED_PRICE", () => {
  const result = checkHallucinatedPrices(
    {
      rationale:
        "Ausbruch über 65500 mit Ziel 68250 bei starkem Volumen bestätigt den intakten Aufwärtstrend.",
    },
    BTC_CANDLES,
    "setups[0]",
    "thesis",
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "HALLUCINATED_PRICE");
  assert.equal(result.findings[0].field, "setups[0].thesis");
  assert.equal(result.referenceMissing, false);
});

test("Plausibilität (d): Kurse im Bereich + Prozent + Jahreszahl sind OK", () => {
  const result = checkHallucinatedPrices(
    { rationale: "RSI bei 70 % im Jahr 2026 stark, Einstieg um 65500 bestätigt." },
    BTC_CANDLES,
    "setups[0]",
  );
  assert.deepEqual(result.findings, []);
});

test("Plausibilität (d): Tausendertrennzeichen (en) werden als eine Zahl gelesen", () => {
  assert.deepEqual(extractPriceCandidates("Ziel bei 65,000 Dollar."), [65000]);
  assert.deepEqual(extractPriceCandidates("Stop 63,999.5 und Entry 65,400."), [63999.5, 65400]);
  assert.deepEqual(extractPriceCandidates("70 % und 2026 sind keine Kurse."), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline, Adapter, Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

test("Plausibilität: valide Setups passieren die Schicht unverändert (alle Regeln)", () => {
  const config = loadPlausibilityConfig({});
  assert.deepEqual(config, { priceBandPct: 15, minRationaleChars: 40 });
  const result = checkDecisionPlausibility(LONG_OK, BTC_CANDLES, config, "setups[0]", "thesis");
  assert.deepEqual(result.findings, []);
  assert.equal(result.referenceMissing, false);
});

test("Plausibilität: Research-Adapter bildet riskScore auf Confidence ab", () => {
  const validated = validateResearchOutput(researchResponse({ riskScore: 0.03 }));
  assert.equal(validated.valid, true);
  const decisions = adaptResearchOutput(validated.data);
  assert.equal(decisions.length, 1);
  assert.ok(Math.abs((decisions[0].confidence ?? 0) - 0.97) < 1e-9);
});

test("Plausibilität: Spec sammelt Befunde mehrerer Setups in Feldpfaden", () => {
  const validated = validateResearchOutput({
    setups: [
      (researchResponse() as { setups: unknown[] }).setups[0],
      {
        instrumentId: "BINANCE:BTCUSDT",
        side: "LONG",
        entryPrice: 65400,
        stopLoss: 66000,
        takeProfit: 68500,
        riskScore: 0.5,
        timeframe: "4h",
        thesis: "Long-Versuch mit zu engem Stop direkt über dem Entry ohne Puffer.",
        isProposal: true,
      },
    ],
    totalSetups: 2,
    disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
  });
  assert.equal(validated.valid, true);
  const result = runPlausibilitySpec(
    validated.data,
    { adapt: adaptResearchOutput, candles: BTC_CANDLES, fieldPrefix: "setups" },
    {},
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "MONOTONICITY");
  assert.equal(result.findings[0].field, "setups[1].stopLoss");
  assert.deepEqual(findingCodes(result.findings), ["MONOTONICITY"]);
});

test("Plausibilität: Flags werden auf Bounds geklemmt, Ungültiges → Default", () => {
  assert.deepEqual(loadPlausibilityConfig({
    PLAUSIBILITY_PRICE_BAND_PCT: "500",
    PLAUSIBILITY_MIN_RATIONALE_CHARS: "-5",
  }), { priceBandPct: 90, minRationaleChars: 0 });
  assert.deepEqual(loadPlausibilityConfig({
    PLAUSIBILITY_PRICE_BAND_PCT: "keine-zahl",
    PLAUSIBILITY_MIN_RATIONALE_CHARS: "",
  }), { priceBandPct: 15, minRationaleChars: 40 });
});

test("Plausibilität: Feedback + Audit-Grund sind begrenzt und deterministisch", () => {
  const feedback = formatPlausibilityFeedback([
    { code: "MONOTONICITY", field: "setups[0].stopLoss", detail: "stop >= entry" },
    { code: "PRICE_RANGE", field: "setups[0].entryPrice", detail: "außerhalb" },
  ]);
  assert.match(feedback, /MONOTONICITY/);
  assert.match(feedback, /exactly 1 retry/);
  assert.equal(
    plausibilityAuditReason({
      findings: [
        { code: "PRICE_RANGE", field: "a", detail: "x" },
        { code: "MONOTONICITY", field: "b", detail: "y" },
      ],
    }),
    "plausibility:MONOTONICITY,PRICE_RANGE",
  );
  assert.equal(plausibilityAuditReason({ findings: [], skipReason: "invalid-retry" }), "plausibility:invalid-retry");
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry-Politik am Fake-Port
// ─────────────────────────────────────────────────────────────────────────────

function plausibilitySpec() {
  return {
    adapt: adaptResearchOutput,
    candles: BTC_CANDLES,
    fieldPrefix: "setups",
  };
}

const PLAUSIBILITY_FALLBACK = {
  setups: [],
  totalSetups: 0,
  disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED" as const,
};

test("Plausibilität Retry: erster Versuch invalid, zweiter valid → genau ein Retry", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseSequenceForRole("RESEARCH", [
    researchResponse({ stopLoss: 66000 }),
    researchResponse(),
  ]);
  const res = await ports.agent.invokeAgent({
    role: "RESEARCH",
    systemPrompt: "test",
    userPrompt: "test",
    schemaValidator: validateResearchOutput,
    fallback: PLAUSIBILITY_FALLBACK,
    plausibility: plausibilitySpec(),
  });
  assert.equal(ports.agent.attemptsFor("RESEARCH"), 2);
  assert.equal(res.usedFallback, false);
  assert.equal(res.plausibility?.status, "RETRIED");
  assert.equal(res.plausibility?.attempts, 2);
  assert.equal(res.output.setups.length, 1);
  assert.equal(res.output.setups[0].stopLoss, 64000);
});

test("Plausibilität Retry: beide Versuche invalid → Skip + Fallback (kein dritter Versuch)", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseSequenceForRole("RESEARCH", [
    researchResponse({ stopLoss: 66000 }),
    researchResponse({ stopLoss: 67000 }),
  ]);
  const res = await ports.agent.invokeAgent({
    role: "RESEARCH",
    systemPrompt: "test",
    userPrompt: "test",
    schemaValidator: validateResearchOutput,
    fallback: PLAUSIBILITY_FALLBACK,
    plausibility: plausibilitySpec(),
  });
  assert.equal(ports.agent.attemptsFor("RESEARCH"), 2);
  assert.equal(res.usedFallback, true);
  assert.deepEqual(res.output, PLAUSIBILITY_FALLBACK);
  assert.equal(res.plausibility?.status, "SKIPPED");
  assert.equal(res.plausibility?.skipReason, "plausibility");
  assert.deepEqual(findingCodes(res.plausibility?.findings ?? []), ["MONOTONICITY"]);
});

test("Plausibilität Retry: ohne Sequenz wird die gleiche Antwort genau einmal wiederbewertet", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RESEARCH", researchResponse({ stopLoss: 66000 }));
  const res = await ports.agent.invokeAgent({
    role: "RESEARCH",
    systemPrompt: "test",
    userPrompt: "test",
    schemaValidator: validateResearchOutput,
    fallback: PLAUSIBILITY_FALLBACK,
    plausibility: plausibilitySpec(),
  });
  assert.equal(ports.agent.attemptsFor("RESEARCH"), 2);
  assert.equal(res.plausibility?.status, "SKIPPED");
});

test("Plausibilität Retry: valider Erstversuch → OK ohne Retry; ohne Spec kein Ergebnis", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RESEARCH", researchResponse());
  const spec = {
    role: "RESEARCH" as const,
    systemPrompt: "test",
    userPrompt: "test",
    schemaValidator: validateResearchOutput,
    fallback: PLAUSIBILITY_FALLBACK,
  };
  const ok = await ports.agent.invokeAgent({ ...spec, plausibility: plausibilitySpec() });
  assert.equal(ok.plausibility?.status, "OK");
  assert.equal(ok.plausibility?.attempts, 1);
  const legacy = await ports.agent.invokeAgent(spec);
  assert.equal(legacy.plausibility, undefined);
  assert.equal(legacy.usedFallback, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Research-Step: Skip + Audit + sichtbarer Zustand (kein Setup-Export)
// ─────────────────────────────────────────────────────────────────────────────

test("Research-Step: unplausibler Output → Skip + Audit plausibility:CODE + Leer-Fallback", async () => {
  await withHistoryDir(emptyHistoryDir(), async () => {
    const ports = createTestPorts();
    ports.agent.setResponseForRole("RESEARCH", researchResponse({ stopLoss: 66000 }));
    const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
    const result = await researchStep.execute(ctx);

    // Kein Setup-Export aus verworfenen Antworten.
    assert.deepEqual(result.setups, []);
    assert.equal(result.totalSetups, 0);
    const status = (result as { plausibility?: { status: string } }).plausibility;
    assert.equal(status?.status, "SKIPPED");

    const skips = ports.audit.events.filter((e) => e.event === "CYCLE_STEP_SKIPPED");
    assert.equal(skips.length, 1);
    assert.equal(skips[0].detail.reason, "plausibility:MONOTONICITY");
    assert.equal(skips[0].level, "WARN");
    assert.equal(ports.agent.attemptsFor("RESEARCH"), 2);
  });
});

test("Research-Step: Preisband-Verstoß gegen geseedete Kerzen → Skip mit PRICE_RANGE", async () => {
  const dir = seedHistory({
    "BINANCE:BTCUSDT": [
      { close: 100, high: 104, low: 98 },
      { close: 101, high: 105, low: 99 },
      { close: 102, high: 106, low: 100 },
    ],
  });
  await withHistoryDir(dir, async () => {
    const ports = createTestPorts();
    ports.agent.setResponseForRole(
      "RESEARCH",
      researchResponse({ entryPrice: 150, stopLoss: 140, takeProfit: 165 }),
    );
    const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
    const result = await researchStep.execute(ctx);
    assert.deepEqual(result.setups, []);
    const skips = ports.audit.events.filter((e) => e.event === "CYCLE_STEP_SKIPPED");
    assert.equal(skips.length, 1);
    assert.equal(skips[0].detail.reason, "plausibility:PRICE_RANGE");
  });
});

test("Research-Step: plausibler Output mit Referenzkerzen → OK + Status sichtbar", async () => {
  const dir = seedHistory({
    "BINANCE:BTCUSDT": [
      { close: 65000, high: 65200, low: 64500 },
      { close: 65400, high: 65600, low: 64900 },
      { close: 65600, high: 65800, low: 65100 },
    ],
  });
  await withHistoryDir(dir, async () => {
    const ports = createTestPorts();
    ports.agent.setResponseForRole("RESEARCH", researchResponse());
    const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
    const result = await researchStep.execute(ctx);
    assert.equal(result.setups.length, 1);
    const status = (
      result as { plausibility?: { status: string; referenceMissing: string[] } }
    ).plausibility;
    assert.equal(status?.status, "OK");
    assert.deepEqual(status?.referenceMissing, []);
    assert.equal(ports.audit.events.filter((e) => e.event === "CYCLE_STEP_SKIPPED").length, 0);
  });
});

test("Research-Step: fehlende Referenzkerzen sind sichtbar, aber nicht blockierend", async () => {
  await withHistoryDir(emptyHistoryDir(), async () => {
    const ports = createTestPorts();
    ports.agent.setResponseForRole("RESEARCH", researchResponse());
    const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
    const result = await researchStep.execute(ctx);
    assert.equal(result.setups.length, 1);
    const status = (
      result as { plausibility?: { status: string; referenceMissing: string[] } }
    ).plausibility;
    assert.equal(status?.status, "OK");
    assert.deepEqual(status?.referenceMissing, ["BINANCE:BTCUSDT"]);
  });
});

test("Research-Step: ungültiger Retry → Skip mit plausibility:invalid-retry", async () => {
  await withHistoryDir(emptyHistoryDir(), async () => {
    const ports = createTestPorts();
    ports.agent.setResponseSequenceForRole("RESEARCH", [
      researchResponse({ stopLoss: 66000 }),
      { setups: "kein-array" },
    ]);
    const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
    const result = await researchStep.execute(ctx);
    assert.deepEqual(result.setups, []);
    const skips = ports.audit.events.filter((e) => e.event === "CYCLE_STEP_SKIPPED");
    assert.equal(skips.length, 1);
    assert.equal(skips[0].detail.reason, "plausibility:invalid-retry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Makro-Step: Confidence vs. Begründung
// ─────────────────────────────────────────────────────────────────────────────

test("Makro-Step: hohe Confidence ohne Begründung → Skip + Fallback + Audit", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("MACRO_ANALYST", {
    view: "BEARISH",
    regime: "RISK_OFF",
    volatilityRegime: "HIGH",
    assets: { btc: { price: 65000, trend: "DOWN" } },
    thesis: "Bullish.",
    confidence: 0.95,
  });
  const ctx = mockContext({}, ports);
  const result = await macroStep.execute(ctx);
  assert.equal(result.view, "NEUTRAL");
  const status = (result as { plausibility?: { status: string } }).plausibility;
  assert.equal(status?.status, "SKIPPED");
  const skips = ports.audit.events.filter((e) => e.event === "CYCLE_STEP_SKIPPED");
  assert.equal(skips.length, 1);
  assert.equal(skips[0].detail.reason, "plausibility:RATIONALE_MISSING");
});

test("Makro-Step: begründete Analyse passiert mit sichtbarem OK-Status", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("MACRO_ANALYST", {
    view: "BULLISH",
    regime: "RISK_ON",
    volatilityRegime: "NORMAL",
    assets: { btc: { price: 65000, trend: "UP" } },
    thesis: "Risk-On-Umfeld über alle Assetklassen mit stabiler Volatilität.",
    confidence: 0.7,
  });
  const ctx = mockContext({}, ports);
  const result = await macroStep.execute(ctx);
  assert.equal(result.view, "BULLISH");
  const status = (result as { plausibility?: { status: string } }).plausibility;
  assert.equal(status?.status, "OK");
});

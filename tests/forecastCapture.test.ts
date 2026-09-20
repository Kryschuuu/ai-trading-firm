/**
 * Forecast-Capture-Policy `fp1` — Tests (RMA-P3-01, v1.55.0).
 *
 * Deckt ab:
 *   * Wahrscheinlichkeitsabbildung (view/confidence → p_up inkl. Clip),
 *   * Zeitsemantik (Raster, Horizont, Deadline),
 *   * Rollen-/Horizont-Policy,
 *   * alle geschlossenen Skip-Gründe (fail-closed),
 *   * Vektorvalidierung (Summe = 1),
 *   * Stabilität des Idempotenzschlüssels.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  forecastFromAnalysis,
  isForecastableSymbol,
  probabilityFromView,
  referenceTimeOf,
  validateProbabilityVector,
  viewSign,
} from "../src/forecasts/capture";
import { forecastIdempotencyKey } from "../src/forecasts/hashes";
import { FORECAST_SETTLE_GRACE_MS } from "../src/forecasts/types";
import { FC_T0, FC_HOUR } from "./fixtures/forecastTestUtil";

const HOUR = FC_HOUR;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    role: "TECHNICAL_ANALYST",
    symbol: "BTC",
    view: "BULLISH",
    confidence: 0.6,
    asOf: new Date(FC_T0 + 30 * 60_000), // 00:30
    referenceClose: 100,
    referenceTime: new Date(FC_T0), // 00:00 (geschlossene Kerze)
    entityId: "PAPER:BTC",
    promptVersion: 3,
    model: "test-model",
    regime: "NORMAL",
    ...overrides,
  };
}

describe("forecastCapture: Wahrscheinlichkeitsabbildung (Policy fp1)", () => {
  it("BULLISH 0.6 ⇒ p_up = 0.8; BEARISH 0.6 ⇒ 0.2; NEUTRAL ⇒ 0.5", () => {
    assert.equal(probabilityFromView("BULLISH", 0.6), 0.8);
    assert.equal(probabilityFromView("BEARISH", 0.6), 0.2);
    assert.equal(probabilityFromView("NEUTRAL", 0.9), 0.5);
    assert.equal(probabilityFromView("NEUTRAL", 0), 0.5);
  });

  it("confidence = 0 ist stets der uninformierte Forecast 0.5", () => {
    assert.equal(probabilityFromView("BULLISH", 0), 0.5);
    assert.equal(probabilityFromView("BEARISH", 0), 0.5);
  });

  it("Clip [0.01, 0.99]: confidence = 1 wird nie absolute Sicherheit", () => {
    assert.equal(probabilityFromView("BULLISH", 1), 0.99);
    assert.equal(probabilityFromView("BEARISH", 1), 0.01);
  });

  it("confidence außerhalb [0,1] wird geklemmt, nicht verworfen", () => {
    // > 1 ⇒ Konfidenz 1 ⇒ Clip-Obergrenze; negative Konfidenz ist keine
    // „Gegen-Konfidenz“, sondern wird auf 0 (uninformiert) geklemmt.
    assert.equal(probabilityFromView("BULLISH", 3), 0.99);
    assert.equal(probabilityFromView("BEARISH", -2), 0.5);
  });

  it("unbekannte Views und nicht-endliche Confidence ⇒ null (fail-closed)", () => {
    assert.equal(probabilityFromView("SIDEWAYS", 0.5), null);
    assert.equal(probabilityFromView("BULLISH", Number.NaN), null);
    assert.equal(viewSign("LONG"), null);
  });
});

describe("forecastCapture: Vertragserzeugung und Zeitsemantik", () => {
  it("gültige TECH-Analyse ⇒ vollständiger Vertrag (4h, gerastert, Deadline = +2h)", () => {
    const result = forecastFromAnalysis(baseInput());
    assert.ok(result.ok);
    if (!result.ok) return;
    const c = result.contract;
    assert.equal(c.agentRole, "TECHNICAL_ANALYST");
    assert.equal(c.horizonId, "4h");
    assert.equal(c.timeframe, "1h");
    assert.equal(c.entityId, "PAPER:BTC");
    assert.equal(c.symbol, "BTC");
    assert.equal(c.targetKind, "CLOSE_DIRECTION");
    assert.deepEqual([...c.categories], ["DOWN", "UP"]);
    assert.equal(c.targetCategory, "UP");
    assert.deepEqual(c.probabilities, [0.2, 0.8]);
    approxSum(c.probabilities);
    assert.equal(c.referenceTime.getTime(), FC_T0);
    assert.equal(c.resolvesAt.getTime(), FC_T0 + 4 * HOUR);
    assert.equal(c.availabilityDeadline.getTime(), FC_T0 + 4 * HOUR + FORECAST_SETTLE_GRACE_MS);
    assert.equal(c.regime, "NORMAL");
    assert.equal(c.policyVersion, "fp1");
    assert.equal(c.contractVersion, 1);
    assert.ok(c.referenceTime.getTime() <= c.asOf.getTime());
    assert.ok(c.resolvesAt.getTime() > c.asOf.getTime());
  });

  it("SWING_RESEARCHER / SCOUT / DILIGENCE ⇒ 72h-Horizont", () => {
    for (const role of ["SWING_RESEARCHER", "SCOUT", "DILIGENCE"] as const) {
      const result = forecastFromAnalysis(baseInput({ role, symbol: "NVDA", entityId: "PAPER:NVDA" }));
      assert.ok(result.ok, `Rolle ${role} muss erfassbar sein`);
      if (result.ok) assert.equal(result.contract.horizonId, "72h");
    }
  });

  it("MACRO-/NEWS-Analysen ohne Ziel-Entity werden NICHT erfasst (kein Freitext-Ersatz)", () => {
    for (const role of ["MACRO_ANALYST", "NEWS_ANALYST"] as const) {
      const result = forecastFromAnalysis(baseInput({ role, symbol: null }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "ROLE_NOT_FORECASTABLE");
    }
  });

  it("Sammelbegriff MARKT ist kein Ziel-Entity", () => {
    const result = forecastFromAnalysis(baseInput({ role: "SWING_RESEARCHER", symbol: "MARKT" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NO_ENTITY");
  });

  it("fehlender Referenzkurs ⇒ NO_REFERENCE_DATA (kein Forecast ohne Event-Basis)", () => {
    const result = forecastFromAnalysis(baseInput({ referenceClose: null, referenceTime: null }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NO_REFERENCE_DATA");
  });

  it("nicht endeitliche/ungültige Eingaben ⇒ geschlossene Gründe", () => {
    assert.equal(skipReasonOf(baseInput({ view: "SIDEWAYS" })), "INVALID_VIEW");
    assert.equal(skipReasonOf(baseInput({ confidence: Number.NaN })), "INVALID_CONFIDENCE");
    assert.equal(skipReasonOf(baseInput({ confidence: "hoch" })), "INVALID_CONFIDENCE");
    assert.equal(skipReasonOf(baseInput({ entityId: null })), "UNRESOLVED_INSTRUMENT");
    assert.equal(skipReasonOf(baseInput({ entityId: "" })), "UNRESOLVED_INSTRUMENT");
    assert.equal(skipReasonOf(baseInput({ promptVersion: -1 })), "INVALID_CONTRACT");
    assert.equal(skipReasonOf(baseInput({ model: "" })), "INVALID_CONTRACT");
  });

  it("Referenzzeit außerhalb des Rasters ⇒ INVALID_CONTRACT", () => {
    const result = forecastFromAnalysis(baseInput({ referenceTime: new Date(FC_T0 + 13 * 60_000) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "INVALID_CONTRACT");
  });

  it("Symbolvalidierung: gültige Ticker ja, Freitext/Platzhalter nein", () => {
    assert.ok(isForecastableSymbol("BTC"));
    assert.ok(isForecastableSymbol("EURUSD=X"));
    assert.ok(isForecastableSymbol("BRK.B"));
    assert.equal(isForecastableSymbol("MARKT"), false);
    assert.equal(isForecastableSymbol(""), false);
    assert.equal(isForecastableSymbol("  "), false);
    assert.equal(isForecastableSymbol("BTC US 12 SEP CALL"), false);
    assert.equal(isForecastableSymbol(123), false);
  });
});

describe("forecastCapture: referenceTimeOf (Raster)", () => {
  it("rundet auf das Raster AB (letzte geschlossene Kerze)", () => {
    assert.equal(referenceTimeOf(FC_T0 + 30 * 60_000), FC_T0);
    assert.equal(referenceTimeOf(FC_T0 + HOUR - 1), FC_T0);
  });

  it("exakt auf dem Raster zählt der gerade geschlossene Bar", () => {
    assert.equal(referenceTimeOf(FC_T0 + HOUR), FC_T0 + HOUR);
  });

  it("ungültige Zeiten werden fail-closed abgewiesen", () => {
    assert.throws(() => referenceTimeOf(Number.NaN));
    assert.throws(() => referenceTimeOf(-5));
    assert.throws(() => referenceTimeOf(FC_T0, 0));
  });
});

describe("forecastCapture: Vektorvalidierung und Idempotenzschlüssel", () => {
  it("Vektorsumme muss 1 ± 1e-6 sein", () => {
    assert.ok(validateProbabilityVector([0.5, 0.5]));
    assert.ok(validateProbabilityVector([0.333333333, 0.333333333, 0.333333334]));
    assert.equal(validateProbabilityVector([0.5, 0.4999]), false);
    assert.equal(validateProbabilityVector([0.5, 0.500002]), false);
    assert.equal(validateProbabilityVector([1]), false);
    assert.equal(validateProbabilityVector([0.5, Number.NaN]), false);
    assert.equal(validateProbabilityVector([0.5, -0.1, 0.6]), false);
    assert.equal(validateProbabilityVector("0.5,0.5" as unknown as number[]), false);
  });

  it("Idempotenzschlüssel ist deterministisch und inhaltsabhängig", () => {
    const a = forecastFromAnalysis(baseInput());
    const b = forecastFromAnalysis(baseInput());
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const keyA = forecastIdempotencyKey(a.contract);
    const keyB = forecastIdempotencyKey(b.contract);
    assert.match(keyA, /^fk1:[0-9a-f]{64}$/);
    assert.equal(keyA, keyB);

    // Andere Confidence ⇒ anderer Inhalt ⇒ anderer Schlüssel.
    const c = forecastFromAnalysis(baseInput({ confidence: 0.7 }));
    assert.ok(c.ok);
    if (c.ok) assert.notEqual(forecastIdempotencyKey(c.contract), keyA);

    // Andere As-of-Zeit ⇒ anderer Schlüssel.
    const d = forecastFromAnalysis(baseInput({ asOf: new Date(FC_T0 + 90 * 60_000) }));
    assert.ok(d.ok);
    if (d.ok) assert.notEqual(forecastIdempotencyKey(d.contract), keyA);
  });
});

function skipReasonOf(input: Record<string, unknown>): string | null {
  const result = forecastFromAnalysis(input as unknown as Parameters<typeof forecastFromAnalysis>[0]);
  return result.ok ? null : result.reason;
}

function approxSum(probabilities: readonly number[]): void {
  const sum = probabilities.reduce((acc, p) => acc + p, 0);
  assert.ok(Math.abs(sum - 1) <= 1e-6, `Vektorsumme ${sum} ≠ 1`);
}

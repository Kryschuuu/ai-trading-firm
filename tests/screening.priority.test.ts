/**
 * STX-05-01 — fixturebasierte Invarianztests für Priorität und Frühstatus.
 *
 * Deckt Fail-closed-Nullen, Gewicht-Null, unabhängige Termreihenfolge,
 * optionale Korrelation und die Konfigurations-Kalibrierbarkeit ab.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCREENING_PRIORITY_CONFIG,
  SCREENING_PRIORITY_CONFIG,
  resolveScreeningPriorityConfig,
  type ScreeningPriorityConfig,
} from "../src/screening/config";
import {
  classifyCandidate,
  classifyStatus,
  scoreCandidate,
} from "../src/screening/priority";
import type { StrategyMarketCandidate } from "../src/screening/types";

function candidate(
  overrides: Partial<StrategyMarketCandidate> = {},
): StrategyMarketCandidate {
  return {
    templateId: "ema-adx-trend",
    templateVersion: 1,
    strategyClass: "trend",
    instrumentId: "BITUNIX:BTCUSDT",
    venue: "BITUNIX",
    timeframe: "1h",
    dataQuality: 0.8,
    liquidity: 0.6,
    freshness: 0.5,
    strategyFit: 0.4,
    volatilityOpportunity: 0.3,
    correlationPenalty: 0.1,
    priority: null,
    status: "DISCOVERED",
    reasons: [],
    strategyVersionId: "persisted-version-1",
    ...overrides,
  };
}

test("scoreCandidate: jedes unbekannte Pflichtfeld liefert einen benannten Fehler", () => {
  const requiredFields = [
    "dataQuality",
    "liquidity",
    "freshness",
    "strategyFit",
    "volatilityOpportunity",
  ] as const;

  for (const field of requiredFields) {
    const result = scoreCandidate(
      candidate({ [field]: null } as Partial<StrategyMarketCandidate>),
      SCREENING_PRIORITY_CONFIG,
    );
    assert.equal(result.ok, false, `${field} darf nicht still neutralisiert werden`);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) => error.includes(field)),
        `Fehler muss das Feld ${field} benennen: ${result.errors.join(", ")}`,
      );
    }
  }
});

test("scoreCandidate: Gewicht 0 entfernt nur den Beitrag, nicht die Pflichtvalidierung", () => {
  const zeroDataQualityWeight = resolveScreeningPriorityConfig({
    weights: { dataQuality: 0 },
  });
  const scored = scoreCandidate(candidate(), zeroDataQualityWeight);
  assert.equal(scored.ok, true);
  if (scored.ok) assert.equal(scored.contributions.dataQuality, 0);

  const missingDataWithZeroWeight = scoreCandidate(
    candidate({ dataQuality: null }),
    zeroDataQualityWeight,
  );
  assert.equal(missingDataWithZeroWeight.ok, false);
  if (!missingDataWithZeroWeight.ok) {
    assert.ok(missingDataWithZeroWeight.errors.some((error) => error.includes("dataQuality")));
  }
});

test("scoreCandidate: eine Umordnung der Gewicht-Terme ändert das Ergebnis nicht", () => {
  const reversedWeights = Object.fromEntries(
    Object.entries(DEFAULT_SCREENING_PRIORITY_CONFIG.weights).reverse(),
  ) as ScreeningPriorityConfig["weights"];
  const reversedConfig: ScreeningPriorityConfig = {
    ...DEFAULT_SCREENING_PRIORITY_CONFIG,
    weights: reversedWeights,
  };

  assert.deepEqual(
    scoreCandidate(candidate(), DEFAULT_SCREENING_PRIORITY_CONFIG),
    scoreCandidate(candidate(), reversedConfig),
  );
});

test("scoreCandidate: correlationPenalty null ist identisch zu 0", () => {
  assert.deepEqual(
    scoreCandidate(candidate({ correlationPenalty: null }), SCREENING_PRIORITY_CONFIG),
    scoreCandidate(candidate({ correlationPenalty: 0 }), SCREENING_PRIORITY_CONFIG),
  );
});

test("scoreCandidate: geänderte Config ändert die Priorität", () => {
  const baseline = scoreCandidate(candidate(), DEFAULT_SCREENING_PRIORITY_CONFIG);
  const calibratedConfig = resolveScreeningPriorityConfig({
    weights: { dataQuality: 0 },
  });
  const calibrated = scoreCandidate(candidate(), calibratedConfig);

  assert.equal(baseline.ok, true);
  assert.equal(calibrated.ok, true);
  if (baseline.ok && calibrated.ok) {
    assert.notEqual(calibrated.priority, baseline.priority);
  }
});

test("classifyCandidate: Schwellen blockieren mit Begründung und mutieren den Input nicht", () => {
  const input = candidate({ dataQuality: 0.4 });
  const classified = classifyCandidate(input, DEFAULT_SCREENING_PRIORITY_CONFIG);

  assert.equal(classified.status, "BLOCKED");
  assert.ok(classified.reasons.some((reason) => reason.includes("dataQuality")));
  assert.deepEqual(input.reasons, []);
});

test("classifyStatus: fehlende Persistenz ist DISCOVERED, bestätigte Version ist READY", () => {
  const discovered = candidate({ strategyVersionId: null });
  assert.equal(classifyStatus(discovered, DEFAULT_SCREENING_PRIORITY_CONFIG), "DISCOVERED");
  assert.ok(
    classifyCandidate(discovered, DEFAULT_SCREENING_PRIORITY_CONFIG).reasons.some((reason) =>
      reason.includes("strategy persistence"),
    ),
  );

  // Ein vorhandener Workflow-Status wird nicht als Backtest-/Validierungslogik benutzt.
  assert.equal(
    classifyStatus(candidate({ status: "PAPER" }), DEFAULT_SCREENING_PRIORITY_CONFIG),
    "READY",
  );
});

test("classifyStatus: unbekannte Datenlage blockiert fail-closed statt 0 zu unterstellen", () => {
  const result = classifyCandidate(
    candidate({ liquidity: null }),
    DEFAULT_SCREENING_PRIORITY_CONFIG,
  );

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.some((reason) => reason.includes("liquidity: unbekannt")));
});

test("classifyStatus: Mindestschwellen sind konfigurierbar", () => {
  const stricterConfig = resolveScreeningPriorityConfig({
    thresholds: { minDataQuality: 0.9 },
  });
  assert.equal(classifyStatus(candidate(), stricterConfig), "BLOCKED");
});

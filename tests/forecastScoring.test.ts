/**
 * Forecast-Scoring — analytische Tests (RMA-P3-01, v1.55.0).
 *
 * Deckt die Pflicht-Fixtures ab:
 *   * binäre und kategoriale Brier-Fixtures (handberechnet),
 *   * perfekter, uninformierter und sicher falscher Forecast,
 *   * Log Loss inkl. Klemmung,
 *   * Wilson-Intervalle (Grenzfälle k=0, k=n, n=0),
 *   * Reliability Bins mit exakten Grenzwerten 0/1 und Bingrenzen,
 *   * Expected Calibration Error,
 *   * Brier Skill Score gegen die Klimatologie-Referenz,
 *   * PENDING/VOID gehen nicht in Scores ein, aber in Coverage,
 *   * Mindeststichproben-Gate (`insufficient-sample`),
 *   * Determinismus (zweimal dieselbe Eingabe ⇒ bitidentisches Ergebnis).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  brierScore,
  brierScoreMultiClass,
  brierSkillScore,
  brierUncertainty,
  expectedCalibrationError,
  logLossBinary,
  reliabilityBinIndex,
  reliabilityBins,
  scoreSegment,
  wilsonInterval,
  WILSON_Z_95,
} from "../src/forecasts/scoring";
import type { ScoreRow } from "../src/forecasts/types";

function approx(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Erwartet ${expected} ± ${tolerance}, bekommen ${actual}`
  );
}

function row(overrides: Partial<ScoreRow> & Pick<ScoreRow, "probability" | "status">): ScoreRow {
  return {
    forecastId: `f-${Math.random().toString(36).slice(2)}`,
    agentRole: "TECHNICAL_ANALYST",
    promptVersion: 1,
    model: "m",
    entityId: "PAPER:TEST",
    horizonId: "4h",
    regime: "UNKNOWN",
    asOf: new Date("2026-09-07T00:30:00Z"),
    resolvesAt: new Date("2026-09-07T04:00:00Z"),
    probabilities: [1 - overrides.probability, overrides.probability],
    categories: ["DOWN", "UP"],
    targetCategory: "UP",
    outcomeIndex: null,
    outcomeBinary: null,
    voidReason: null,
    resolutionVersion: null,
    ...overrides,
  };
}

describe("forecastScoring: Brier Score (binär)", () => {
  it("handberechnetes Fixture: mean((p−y)²)", () => {
    const bs = brierScore([
      { p: 0.7, y: 1 },
      { p: 0.4, y: 0 },
      { p: 0.9, y: 1 },
    ]);
    approx(bs, (0.09 + 0.16 + 0.01) / 3);
  });

  it("perfekter Forecast ⇒ 0", () => {
    approx(brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  });

  it("uninformierter Forecast (p=0.5) auf ausgeglichenen Outcomes ⇒ 0.25", () => {
    approx(brierScore([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), 0.25);
  });

  it("sicher falscher Forecast ⇒ 1", () => {
    approx(brierScore([{ p: 1, y: 0 }]), 1);
    approx(brierScore([{ p: 0, y: 1 }]), 1);
  });

  it("leere Stichprobe ist keine Aussage ⇒ Wurf statt 0", () => {
    assert.throws(() => brierScore([]), /leere Stichprobe/);
  });

  it("ungültige Paare werden fail-closed abgewiesen", () => {
    assert.throws(() => brierScore([{ p: Number.NaN, y: 1 }]));
    assert.throws(() => brierScore([{ p: 0.5, y: 2 as 0 | 1 }]));
    assert.throws(() => brierScore([{ p: 1.5, y: 1 }]));
  });
});

describe("forecastScoring: Brier Score (kategorial)", () => {
  it("handberechnetes 3-Kategorien-Fixture", () => {
    const bs = brierScoreMultiClass([{ probabilities: [0.2, 0.3, 0.5], outcomeIndex: 2 }]);
    approx(bs, 0.2 * 0.2 + 0.3 * 0.3 + 0.5 * 0.5 - 2 * 0.5 + 1); // Σ(p−o)² = 0.04+0.09+0.25
    approx(bs, 0.38);
  });

  it("binäre Äquivalenz: 2 Kategorien ⇒ exakt 2·brierScore", () => {
    const pairs = [
      { p: 0.7, y: 1 as const },
      { p: 0.4, y: 0 as const },
    ];
    const binary = brierScore(pairs);
    const multi = brierScoreMultiClass([
      { probabilities: [0.3, 0.7], outcomeIndex: 1 },
      { probabilities: [0.6, 0.4], outcomeIndex: 0 },
    ]);
    approx(multi, 2 * binary);
  });

  it("Vektorsumme ≠ 1 wird fail-closed abgewiesen", () => {
    assert.throws(() => brierScoreMultiClass([{ probabilities: [0.5, 0.6], outcomeIndex: 0 }]), /Vektorsumme/);
    assert.throws(() => brierScoreMultiClass([{ probabilities: [0.4, 0.4], outcomeIndex: 0 }]), /Vektorsumme/);
  });

  it("Outcome-Index außerhalb des Vektors wird abgewiesen", () => {
    assert.throws(() => brierScoreMultiClass([{ probabilities: [0.5, 0.5], outcomeIndex: 2 }]));
  });
});

describe("forecastScoring: Wilson-Intervall", () => {
  it("n=0 ⇒ null (keine Aussage, nie [0,0])", () => {
    assert.equal(wilsonInterval(0, 0), null);
  });

  it("k=0 ⇒ untere Schranke exakt 0", () => {
    const w = wilsonInterval(0, 10);
    assert.ok(w);
    approx(w.lower, 0, 1e-15);
    assert.ok(w.upper > 0 && w.upper < 0.4);
  });

  it("k=n ⇒ obere Schranke exakt 1", () => {
    const w = wilsonInterval(10, 10);
    assert.ok(w);
    approx(w.upper, 1, 1e-15);
    assert.ok(w.lower > 0.6 && w.lower < 1);
  });

  it("symmetrischer Fall k=n/2 ⇒ Zentrum 0.5, Intervall in [0,1]", () => {
    const w = wilsonInterval(5, 10);
    assert.ok(w);
    approx(w.center, 0.5);
    assert.ok(w.lower >= 0 && w.upper <= 1 && w.lower < w.upper);
  });

  it("größeres n ⇒ schmaleres Intervall", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    assert.ok(small && large);
    assert.ok(large.upper - large.lower < small.upper - small.lower);
  });

  it("ungültige Eingaben ⇒ null", () => {
    assert.equal(wilsonInterval(-1, 10), null);
    assert.equal(wilsonInterval(11, 10), null);
    assert.equal(wilsonInterval(1.5, 10), null);
    assert.equal(wilsonInterval(5, 10, Number.NaN), null);
  });
});

describe("forecastScoring: Log Loss", () => {
  it("p=0.5 ⇒ ln(2)", () => {
    approx(logLossBinary([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]), Math.LN2);
  });

  it("perfekter Forecast (p=1−ε) ≈ 0", () => {
    const ll = logLossBinary([{ p: 1 - 1e-6, y: 1 }]);
    assert.ok(ll < 1e-5);
  });

  it("sicher falscher Forecast wird bei −ln(ε) geklemmt (endlich)", () => {
    const ll = logLossBinary([{ p: 1, y: 0 }]);
    approx(ll, -Math.log(1e-6), 1e-9);
  });

  it("leere Stichprobe ⇒ Wurf statt 0", () => {
    assert.throws(() => logLossBinary([]));
  });
});

describe("forecastScoring: Brier Skill Score", () => {
  it("BS = 0 ⇒ BSS = 1; BS = Klimatologie ⇒ BSS = 0", () => {
    approx(brierSkillScore(0, 0.4) ?? Number.NaN, 1);
    // Klimatologie-BS bei Rate 0.4: 0.4·0.6 = 0.24
    approx(brierSkillScore(0.24, 0.4) ?? Number.NaN, 0);
  });

  it("schlechter als Klimatologie ⇒ BSS < 0", () => {
    assert.ok((brierSkillScore(0.3, 0.4) ?? 0) < 0);
  });

  it("degenerierte Basisrate (alle Outcomes gleich) ⇒ null, nie ±∞", () => {
    assert.equal(brierSkillScore(0.1, 0), null);
    assert.equal(brierSkillScore(0.1, 1), null);
  });
});

describe("forecastScoring: Reliability Bins", () => {
  it("Grenzwerte: p=0 ⇒ erster Bin, p=1 ⇒ letzter Bin (exakt)", () => {
    assert.equal(reliabilityBinIndex(0, 10), 0);
    assert.equal(reliabilityBinIndex(1, 10), 9);
  });

  it("Bingrenzen sind links abgeschlossen: p=0.3 ⇒ Bin [0.3, 0.4)", () => {
    assert.equal(reliabilityBinIndex(0.3, 10), 3);
    assert.equal(reliabilityBinIndex(0.29999999, 10), 2);
  });

  it("Bins berichten Count, mittlere Prognose, beobachtete Rate und Wilson-Intervall", () => {
    const bins = reliabilityBins(
      [
        { p: 0.2, y: 0 },
        { p: 0.24, y: 1 },
        { p: 0.85, y: 1 },
      ],
      10
    );
    assert.equal(bins.length, 10);
    const bin2 = bins[2]; // [0.2, 0.3)
    assert.equal(bin2.count, 2);
    approx(bin2.meanForecast ?? Number.NaN, 0.22);
    approx(bin2.observedRate ?? Number.NaN, 0.5);
    assert.ok(bin2.wilson95 && bin2.wilson95.lower <= 0.5 && bin2.wilson95.upper >= 0.5);
    const bin8 = bins[8]; // [0.8, 0.9)
    assert.equal(bin8.count, 1);
    approx(bin8.observedRate ?? Number.NaN, 1);
    assert.ok(bin8.wilson95);
    approx(bin8.wilson95.upper, 1, 1e-12);
    // Leere Bins werden mit count=0 und null-Raten berichtet.
    assert.equal(bins[0].count, 0);
    assert.equal(bins[0].meanForecast, null);
    assert.equal(bins[0].observedRate, null);
    assert.equal(bins[0].wilson95, null);
  });

  it("ECE: konstruiertes Beispiel mit exakter Lösung", () => {
    // 2 Bins: [0,0.5) mit p=0.2/y=0, [0.5,1] mit p=0.8/y=1
    const ece = expectedCalibrationError(
      [
        { p: 0.2, y: 0 },
        { p: 0.2, y: 0 },
        { p: 0.8, y: 1 },
        { p: 0.8, y: 1 },
      ],
      2
    );
    approx(ece ?? Number.NaN, 0.5 * 0.2 + 0.5 * 0.2);
  });

  it("ECE ist null für leere Stichprobe", () => {
    assert.equal(expectedCalibrationError([]), null);
  });
});

describe("forecastScoring: scoreSegment (Status-Gates, Coverage, Unsicherheit)", () => {
  const now = new Date("2026-09-07T12:00:00Z");

  it("PENDING und VOID gehen nicht in Scores ein, aber in Coverage", () => {
    const rows = [
      row({ probability: 0.7, status: "RESOLVED", outcomeIndex: 1, outcomeBinary: 1 }),
      row({ probability: 0.9, status: "RESOLVED", outcomeIndex: 0, outcomeBinary: 0 }),
      row({ probability: 0.6, status: "VOID", voidReason: "MISSING_DATA" }),
      // PENDING und noch nicht fällig (resolvesAt in der Zukunft) — zählt nirgends als Outcome.
      row({ probability: 0.8, status: "PENDING", resolvesAt: new Date("2026-09-08T04:00:00Z") }),
      // PENDING und fällig — zählt in due, aber nie als 0/1.
      row({ probability: 0.3, status: "PENDING" }),
    ];
    const score = scoreSegment(rows, 2, now);
    assert.equal(score.resolvedCount, 2);
    assert.equal(score.voidCount, 1);
    assert.equal(score.pendingCount, 2);
    assert.equal(score.dueCount, 4); // drei resolved/void + ein fälliger PENDING
    approx(score.coverage ?? Number.NaN, 3 / 4);
    approx(score.brierScore ?? Number.NaN, (0.09 + 0.81) / 2);
    // Der VOID mit p=0.9 darf den mittleren Forecast NICHT verfälschen.
    approx(score.meanForecast ?? Number.NaN, 0.8);
  });

  it("unreife (PENDING, nicht fällige) Forecasts zählen weder als 0 noch als korrekt", () => {
    const rows = [row({ probability: 0.99, status: "PENDING", resolvesAt: new Date("2026-09-09T04:00:00Z") })];
    const score = scoreSegment(rows, 1, now);
    assert.equal(score.brierScore, null);
    assert.equal(score.hitRate, null);
    assert.equal(score.coverage, null); // nichts fällig ⇒ keine Coverage-Aussage
    assert.equal(score.dueCount, 0);
  });

  it("Mindeststichprobe: darunter Status insufficient-sample (Zahlen bleiben sichtbar)", () => {
    const rows = [row({ probability: 0.7, status: "RESOLVED", outcomeIndex: 1, outcomeBinary: 1 })];
    const score = scoreSegment(rows, 30, now);
    assert.equal(score.status, "insufficient-sample");
    assert.ok(score.brierScore !== null);
    assert.equal(score.resolvedCount, 1);
  });

  it("Wilson-95 und Brier-Standardfehler werden berichtet", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({
        probability: 0.6,
        status: "RESOLVED",
        outcomeIndex: i % 2 === 0 ? 1 : 0,
        outcomeBinary: i % 2 === 0 ? 1 : 0,
      })
    );
    const score = scoreSegment(rows, 5, now);
    assert.ok(score.hitRateWilson95);
    assert.ok(score.hitRateWilson95.lower < 0.5 && score.hitRateWilson95.upper > 0.5);
    assert.ok(score.brierUncertainty);
    // Handwert: ((0.6−1)² + (0.6−0)²)/2 = (0.16 + 0.36)/2 = 0.26
    approx(score.brierScore ?? Number.NaN, 0.26);
    assert.ok(score.brierUncertainty.se >= 0);
    assert.ok(score.brierUncertainty.lower <= score.brierScore! && score.brierScore! <= score.brierUncertainty.upper);
  });

  it("Determinismus: identische Eingabe ⇒ bitidentischer Bericht", () => {
    const rows = [
      row({ probability: 0.7, status: "RESOLVED", outcomeIndex: 1, outcomeBinary: 1 }),
      row({ probability: 0.4, status: "VOID", voidReason: "TRADING_HALT" }),
    ];
    const a = JSON.stringify(scoreSegment(rows, 1, now));
    const b = JSON.stringify(scoreSegment(rows, 1, now));
    assert.equal(a, b);
  });

  it("brierUncertainty: n<2 ⇒ null; konstante Verluste ⇒ SE 0", () => {
    assert.equal(brierUncertainty([{ p: 0.5, y: 1 }]), null);
    const u = brierUncertainty([
      { p: 0.5, y: 1 },
      { p: 0.5, y: 0 },
    ]);
    assert.ok(u);
    approx(u.se, 0);
  });
});

describe("forecastScoring: Wilson-Konstante", () => {
  it("z = 1.959964… (95 % zweiseitig)", () => {
    approx(WILSON_Z_95, 1.959963984540054);
  });
});

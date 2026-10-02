/**
 * STX-06-04 — `StrategyValidationReport`, Gate-Kette und Regime-Aggregation.
 *
 * Diese Suite ist die Abnahme der deterministischen Entscheidungskette. Sie
 * prüft die Akzeptanzkriterien des Prompts in genau dessen Reihenfolge:
 *
 *   1. **`result` ⊆ `PASS|FAIL|INCONCLUSIVE`** — typseitig (Union) und
 *      laufzeitseitig (`isValidationResult`, `assertValidationResult`).
 *   2. **Kein `PASS` ohne bestandene Kette:** Jedes der sieben inhaltlichen
 *      Gates wird einzeln zum Auslöser gemacht (`1× pro Regel`); nur der
 *      Voll-PASS-Fall ergibt `PASS`.
 *   3. **`INCONCLUSIVE` schlägt `FAIL`:** Ein unklarer Annahmen-Audit mit
 *      gleichzeitig verletzter Policy und zu kleiner Stichprobe bleibt
 *      `INCONCLUSIVE`; spätere Gates stehen als `SKIPPED` im Protokoll.
 *   4. **Regime (ADR-009):** `UNKNOWN` erzeugt **keine** `regimes[]`-Zeile, ein
 *      Trade ohne Snapshot wird ausgeschlossen (Zähler), Punkt-in-Time gewinnt
 *      der letzte Snapshot `asOf ≤ Entry`, Kennzahlen ohne Stichprobe sind
 *      `null` (nie `0`), `featureVersion`/`modelVersion` werden getragen.
 *   5. **Hashbarkeit:** `evidenceHash`/`idempotencyKey` entstehen über
 *      `strategyLifecycle/evidence.ts`; identische Eingaben ⇒ identischer Hash;
 *      nachträglich veränderte Reports werden fail-closed abgewiesen.
 *
 * Dazu die strukturellen Zusagen: Determinismus, keine IO/Uhr/DB im Report,
 * **kein `requestTransition`** in der gesamten Validator-Domäne (statischer
 * Wächter über alle vier Modulquellen).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_VALIDATION_GATE_BOUNDS,
  VALIDATION_GATE_IDS,
  VALIDATION_RESULTS,
  aggregateRegimeTrades,
  assertReportHashIntegrity,
  assertValidationResult,
  buildValidationReport,
  isValidationResult,
  resolveValidationGateBounds,
  validationEvidenceHash,
  validationEvidenceInput,
  validationIdempotencyKey,
  type BuildValidationReportInput,
  type StrategyValidationReport,
  type ValidationMetrics,
} from "../src/strategies/validator/report";
import type {
  AssumptionAudit,
  AssumptionCheck,
  AssumptionCheckStatus,
} from "../src/strategies/validator/assumptions";
import {
  DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
  multipleTestingWarning,
  plateauMetrics,
  type IntegrityCheck,
  type PlateauMetrics,
  type TrainOosGap,
} from "../src/strategies/validator/overfit";
import type { StressSummary } from "../src/strategies/validator/stress";
import type { CandidateScoreRow } from "../src/backtest/walkforward";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function checkFixture(id: string, status: AssumptionCheckStatus): AssumptionCheck {
  return {
    assumptionId: id as AssumptionCheck["assumptionId"],
    status,
    evidence: `${id}: 1 geprüft, Grenze 0 — Fixture.`,
    severity: "BLOCKING",
    templateAssumptions: [],
  };
}

/** Audit-Fixture: `verdict` steuert Zähler und kritische Treffer. */
function auditFixture(verdict: AssumptionAudit["verdict"]): AssumptionAudit {
  const violated = verdict === "FAIL" ? [checkFixture("WARMUP_MET", "VIOLATED")] : [];
  const unknown = verdict === "INCONCLUSIVE" ? [checkFixture("TRADES_SUFFICIENT", "UNKNOWN")] : [];
  return {
    checks: [...violated, ...unknown],
    violated,
    unknown,
    verdict,
    blocking: [...violated],
    criticalFindings: verdict === "INCONCLUSIVE" ? ["kritische-marktannahme"] : [],
    uncoveredCritical: [],
    summary: `Fixture-Audit: ${violated.length} VIOLATED, ${unknown.length} UNKNOWN ⇒ ${verdict}.`,
    auditVersion: "asm1",
  };
}

function integrityFixture(status: IntegrityCheck["status"]): IntegrityCheck {
  return {
    status,
    verdict: status === "CLEAN" ? "CLEAR" : "INCONCLUSIVE",
    checks: [],
    reason: `Fixture-Integrität: ${status} (3 Prüfungen, Fixture).`,
  };
}

function gapFixture(verdict: TrainOosGap["verdict"], gap: number | null): TrainOosGap {
  return {
    isSharpe: 1.4,
    oosSharpe: 0.9,
    gap,
    verdict,
    thresholds: DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
    evidence: `Fixture-Lücke ${String(gap)} mit Schwelle ${DEFAULT_TRAIN_OOS_GAP_THRESHOLDS.suspectGap} ⇒ ${verdict}.`,
  };
}

function scoreRow(candidateId: string, passedGates: boolean, score: number): CandidateScoreRow {
  return {
    candidateId,
    config: { candidateId },
    score,
    passedGates,
    rejectionReason: passedGates ? null : "minTrades: 3 < 10",
    metrics: {
      trades: 12,
      winRate: 50,
      netPnl: score * 100,
      pnl: score / 10,
      sharpeRatio: score,
      sortinoRatio: score,
      profitFactor: 1.2,
      maxDrawdownPct: 10,
    },
  };
}

/** Plateau-Fixture: `stable` von `total` Kandidaten bestehen in allen Fenstern. */
function plateauFixture(stable: number, total: number, windows = 3): PlateauMetrics {
  const tables = Array.from({ length: windows }, () =>
    Array.from({ length: total }, (_, index) => scoreRow(`cand-${index}`, index < stable, total - index)),
  );
  return plateauMetrics(tables);
}

const STRESS_ROBUST: StressSummary = Object.freeze({
  scenarios: [
    { id: "base", sharpe: 1.1, netPnl: 900, maxDrawdownPct: 8, trades: 150 },
    { id: "double", sharpe: 0.9, netPnl: 500, maxDrawdownPct: 10, trades: 150 },
    { id: "triple", sharpe: 0.75, netPnl: 200, maxDrawdownPct: 12, trades: 150 },
  ],
  degradationRatio: 0.68,
  breakevenMultiplier: null,
  verdict: "COST_ROBUST",
});

const METRICS: ValidationMetrics = Object.freeze({
  sharpe: 1.2,
  sortino: 1.6,
  maxDrawdownPct: 12,
  winRate: 0.55,
  profitFactor: 1.4,
  expectancy: 4.2,
  tradeCount: 150,
  netPnl: 4200,
});

const BASE_WINDOW_START = NOW - 40 * DAY;
const BASE_WINDOW_END = NOW - 2 * DAY;
const BASE_EVENT_TIME = BASE_WINDOW_END;
const BASE_AVAILABLE_AT = BASE_WINDOW_END + 60 * 60 * 1000;
const BASE_COMPUTED_AT = BASE_AVAILABLE_AT + 60 * 60 * 1000;

type ReportOverrides = Partial<Omit<BuildValidationReportInput, "metrics">> & {
  metrics?: Partial<ValidationMetrics>;
};

function buildInput(overrides: ReportOverrides = {}): BuildValidationReportInput {
  const mergedMetrics: ValidationMetrics = { ...METRICS, ...(overrides.metrics ?? {}) };
  return {
    strategyKey: "rsi-mean-reversion@v3",
    strategyVersion: 3,
    strategyVersionId: "11111111-1111-4111-8111-111111111111",
    templateId: "rsi-mean-reversion",
    templateVersion: 1,
    strategyClass: "mean-reversion",
    symbol: "BITUNIX:BTCUSDT",
    timeframe: "1h",
    oosWindows: 3,
    windowStart: BASE_WINDOW_START,
    windowEnd: BASE_WINDOW_END,
    dataQualityScore: 0.95,
    assumptions: auditFixture("PASS"),
    integrity: integrityFixture("CLEAN"),
    gap: gapFixture("OK", 0.2),
    plateau: plateauFixture(4, 5),
    multipleTesting: multipleTestingWarning(5),
    stress: STRESS_ROBUST,
    trades: [],
    regimeSnapshots: [],
    eventTime: BASE_EVENT_TIME,
    availableAt: BASE_AVAILABLE_AT,
    computedAt: BASE_COMPUTED_AT,
    ...overrides,
    metrics: mergedMetrics,
  };
}

function build(overrides: ReportOverrides = {}): StrategyValidationReport {
  return buildValidationReport(buildInput(overrides));
}

function gateStatus(report: StrategyValidationReport, id: string): string {
  return report.gates.find((gate) => gate.id === id)?.status ?? "MISSING";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Vokabular & Voll-PASS
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-04: Ergebnis-Vokabular und Voll-PASS", () => {
  it("result ist typ- und laufzeitseitig auf PASS|FAIL|INCONCLUSIVE begrenzt", () => {
    assert.deepEqual([...VALIDATION_RESULTS], ["PASS", "FAIL", "INCONCLUSIVE"]);
    for (const value of VALIDATION_RESULTS) assert.equal(isValidationResult(value), true);
    for (const bad of ["OK", "pass", "", null, 1, undefined, "BLOCKING"]) {
      assert.equal(isValidationResult(bad), false);
    }
    assert.throws(() => assertValidationResult("OK"), /validation:invalid-result/);
    assert.doesNotThrow(() => assertValidationResult("INCONCLUSIVE"));
  });

  it("alle acht Gates bestanden ⇒ PASS; jede Stufe steht mit Zahl im Protokoll", () => {
    const report = build();
    assert.equal(report.result, "PASS");
    assert.deepEqual(
      report.gates.map((gate) => gate.id),
      [...VALIDATION_GATE_IDS],
    );
    assert.deepEqual(
      report.gates.map((gate) => gate.status),
      ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"],
    );
    for (const gate of report.gates) {
      assert.match(gate.evidence, /\d/, `${gate.id} muss eine Zahl nennen`);
    }
    assert.equal(isValidationResult(report.result), true);
  });

  it("INCONCLUSIVE schlägt FAIL: Audit unklar + Policy-Verstoß + zu wenige Trades", () => {
    const report = build({
      assumptions: auditFixture("INCONCLUSIVE"),
      metrics: { tradeCount: 7, maxDrawdownPct: 90, profitFactor: 0.1 },
      oosWindows: 0,
    });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "ASSUMPTIONS"), "INCONCLUSIVE");
    for (const id of ["HOLDOUT_INTEGRITY", "DATA_SUFFICIENCY", "OOS_POLICY_GATES", "COST_STRESS", "FINAL"]) {
      assert.equal(gateStatus(report, id), "SKIPPED", `${id} darf nicht ausgewertet werden`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Gate-Szenarien — 1× pro Regel
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-04: Gate-Szenarien (1× pro Regel)", () => {
  it("Regel 1a: kritischer Annahmen-Bruch ⇒ INCONCLUSIVE", () => {
    const report = build({ assumptions: auditFixture("INCONCLUSIVE") });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "ASSUMPTIONS"), "INCONCLUSIVE");
  });

  it("Regel 1b: BLOCKING-Verletzung ohne kritische Annahme ⇒ FAIL", () => {
    const report = build({ assumptions: auditFixture("FAIL") });
    assert.equal(report.result, "FAIL");
    assert.equal(gateStatus(report, "ASSUMPTIONS"), "FAIL");
  });

  it("Regel 2: kontaminierter Holdout ⇒ INCONCLUSIVE", () => {
    const report = build({ integrity: integrityFixture("CONTAMINATED") });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "HOLDOUT_INTEGRITY"), "INCONCLUSIVE");
  });

  it("Regel 3: zu kleine Stichprobe ⇒ INCONCLUSIVE (nicht FAIL)", () => {
    const report = build({ metrics: { tradeCount: 29 } });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "DATA_SUFFICIENCY"), "INCONCLUSIVE");
  });

  it("Regel 3b: keine OOS-Fenster ⇒ INCONCLUSIVE", () => {
    const report = build({ oosWindows: 0, gap: gapFixture("UNKNOWN", null) });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "DATA_SUFFICIENCY"), "INCONCLUSIVE");
  });

  it("Regel 4: OOS-Drawdown über Policy-Gate ⇒ FAIL", () => {
    const report = build({ metrics: { maxDrawdownPct: 40 } });
    assert.equal(report.result, "FAIL");
    assert.equal(gateStatus(report, "OOS_POLICY_GATES"), "FAIL");
    assert.match(report.gates[3].evidence, /risk\.maxDrawdownPct/);
  });

  it("Regel 4b: fehlende Datenqualität ⇒ INCONCLUSIVE (nicht FAIL)", () => {
    const report = build({ dataQualityScore: null });
    assert.equal(report.result, "INCONCLUSIVE");
    assert.equal(gateStatus(report, "OOS_POLICY_GATES"), "INCONCLUSIVE");
  });

  it("Regel 5a: OOS-Sharpe ≤ 0 ⇒ BROKEN ⇒ FAIL", () => {
    const report = build({ gap: gapFixture("BROKEN", 2.5) });
    assert.equal(report.result, "FAIL");
    assert.equal(gateStatus(report, "TRAIN_OOS_GAP_AND_PLATEAU"), "FAIL");
    assert.equal(report.overfitting.trainOosGap, 2.5);
  });

  it("Regel 5b: IS/OOS-Lücke über Grenze ⇒ SUSPECT ⇒ FAIL", () => {
    const report = build({ gap: gapFixture("SUSPECT", 0.8) });
    assert.equal(report.result, "FAIL");
    assert.equal(gateStatus(report, "TRAIN_OOS_GAP_AND_PLATEAU"), "FAIL");
  });

  it("Regel 5c: Plateau unter Grenze ⇒ FAIL, über Grenze ⇒ PASS", () => {
    const fragile = build({ plateau: plateauFixture(1, 5) });
    assert.equal(fragile.robustness.parameterSensitivity, 0.8);
    assert.equal(fragile.result, "FAIL");

    const robust = build({ plateau: plateauFixture(3, 5) });
    assert.equal(robust.robustness.parameterSensitivity, 0.4);
    assert.equal(robust.result, "PASS");
  });

  it("Regel 5d: fehlende Plateau-Auswertung ⇒ INCONCLUSIVE", () => {
    const report = build({ plateau: plateauMetrics([]) });
    assert.equal(gateStatus(report, "TRAIN_OOS_GAP_AND_PLATEAU"), "INCONCLUSIVE");
    assert.equal(report.result, "INCONCLUSIVE");
  });

  it("Regel 6: COST_DEPENDENT ⇒ FAIL, COST_SENSITIVE ⇒ PASS mit Warnhinweis", () => {
    const dependent = build({
      stress: { ...STRESS_ROBUST, degradationRatio: 0.1, verdict: "COST_DEPENDENT" },
    });
    assert.equal(dependent.result, "FAIL");
    assert.equal(gateStatus(dependent, "COST_STRESS"), "FAIL");

    const sensitive = build({
      stress: { ...STRESS_ROBUST, degradationRatio: 0.4, verdict: "COST_SENSITIVE" },
    });
    assert.equal(sensitive.result, "PASS");
    assert.match(sensitive.gates[5].evidence, /COST_SENSITIVE/);
  });

  it("Regel 7: Multiple Testing BLOCKING (> 20 Kandidaten) ⇒ FAIL", () => {
    const report = build({ multipleTesting: multipleTestingWarning(21) });
    assert.equal(report.result, "FAIL");
    assert.equal(gateStatus(report, "MULTIPLE_TESTING"), "FAIL");
    assert.equal(report.overfitting.multipleTestingWarning, true);
  });

  it("Regel 8: sonst PASS — genau ein Pfad, keine Gewichtung", () => {
    const report = build();
    assert.equal(report.result, "PASS");
    assert.equal(report.gates.filter((gate) => gate.status === "PASS").length, 8);
    assert.equal(report.gates.filter((gate) => gate.status === "SKIPPED").length, 0);
  });

  it("fehlende Vorstufen sind INCONCLUSIVE, nie stilles PASS", () => {
    const cases: readonly { label: string; overrides: ReportOverrides }[] = [
      { label: "assumptions", overrides: { assumptions: null } },
      { label: "integrity", overrides: { integrity: null } },
      { label: "gap", overrides: { gap: null } },
      { label: "plateau", overrides: { plateau: null } },
      { label: "multipleTesting", overrides: { multipleTesting: null } },
      { label: "stress", overrides: { stress: null } },
    ];
    for (const { label, overrides } of cases) {
      const report = build(overrides);
      assert.equal(report.result, "INCONCLUSIVE", `${label} = null muss INCONCLUSIVE liefern`);
    }
  });

  it("Plateau-Grenze ist konfigurierbar, aber fail-closed begrenzt", () => {
    assert.equal(DEFAULT_VALIDATION_GATE_BOUNDS.minPlateauRobustShare, 0.5);
    assert.throws(() => resolveValidationGateBounds({ minPlateauRobustShare: 1.5 }), /gate-bounds/);
    assert.equal(
      build({ bounds: { minPlateauRobustShare: 0.1 }, plateau: plateauFixture(1, 5) }).result,
      "PASS",
    );
  });

  it("Zeitsemantik wird fail-closed geprüft (DB-CHECK)", () => {
    assert.throws(
      () => build({ availableAt: BASE_EVENT_TIME - 1 }),
      /eventTime .* verfügbar|Zeitsemantik/,
    );
    assert.throws(() => build({ computedAt: BASE_AVAILABLE_AT - 1 }), /Zeitsemantik/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Regime-Aggregation (ADR-009/ADR-E2)
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-04: Regime-Aggregator (point-in-time, ADR-009)", () => {
  const entry = (index: number, symbol = "BITUNIX:BTCUSDT", pnlPct = 0.5): { symbol: string; entryTime: number; pnl: number; pnlPct: number } => ({
    symbol,
    entryTime: BASE_WINDOW_START + index * DAY,
    pnl: 10,
    pnlPct,
  });

  it("Punkt-in-Time: der letzte Snapshot mit asOf ≤ Entry gewinnt", () => {
    const aggregate = aggregateRegimeTrades(
      [entry(10)],
      [
        { symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START + 1 * DAY, confirmedRegime: "TREND_UP", featureVersion: "rfe1", modelVersion: "rmo1" },
        { symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START + 5 * DAY, confirmedRegime: "TREND_DOWN", featureVersion: "rfe1", modelVersion: "rmo1" },
        { symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START + 20 * DAY, confirmedRegime: "CRASH", featureVersion: "rfe1", modelVersion: "rmo1" },
      ],
      { minSampleTrades: 30 },
    );
    assert.deepEqual(aggregate.rows.map((row) => row.regime), ["TREND_DOWN"]);
    assert.equal(aggregate.attributedTrades, 1);
    assert.equal(aggregate.unattributedTrades, 0);
  });

  it("UNKNOWN erzeugt keine regimes[]-Zeile und wird gezählt (nie RANGE)", () => {
    const aggregate = aggregateRegimeTrades(
      [entry(1), entry(2)],
      [{ symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START, confirmedRegime: "UNKNOWN", featureVersion: "rfe1", modelVersion: "rmo1" }],
      { minSampleTrades: 30 },
    );
    assert.equal(aggregate.rows.length, 0);
    assert.equal(aggregate.unknownRegimeTrades, 2);
    assert.equal(aggregate.attributedTrades, 0);
    assert.equal(aggregate.rows.some((row) => row.regime === "RANGE"), false);
  });

  it("Trade ohne Snapshot wird ausgeschlossen und als unattributed gezählt", () => {
    const aggregate = aggregateRegimeTrades(
      [entry(1), entry(30)],
      [{ symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START + 5 * DAY, confirmedRegime: "RANGE", featureVersion: "rfe1", modelVersion: "rmo1" }],
      { minSampleTrades: 30 },
    );
    assert.equal(aggregate.unattributedTrades, 1);
    assert.equal(aggregate.attributedTrades, 1);
    assert.equal(aggregate.rows[0]?.regime, "RANGE");
  });

  it("Kennzahl ohne Stichprobe ist null, nie 0; Versionen werden getragen", () => {
    const aggregate = aggregateRegimeTrades(
      [entry(1)],
      [{ symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START, confirmedRegime: "TREND_UP", featureVersion: "rfe9", modelVersion: "rmo7" }],
      { minSampleTrades: 30 },
    );
    assert.equal(aggregate.rows[0]?.sharpe, null);
    assert.notEqual(aggregate.rows[0]?.sharpe, 0);
    assert.deepEqual(aggregate.featureVersions, ["rfe9"]);
    assert.deepEqual(aggregate.modelVersions, ["rmo7"]);
  });

  it("mit ausreichender Stichprobe trägt die Zelle einen Sharpe und der Report die Versionen", () => {
    const trades = Array.from({ length: 40 }, (_, index) => entry(index, "BITUNIX:BTCUSDT", index % 2 === 0 ? 1 : -0.5));
    const report = build({
      trades,
      regimeSnapshots: [
        { symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START, confirmedRegime: "TREND_UP", featureVersion: "rfe1", modelVersion: "rmo1" },
      ],
    });
    assert.equal(report.regimes.length, 1);
    assert.equal(report.regimes[0].regime, "TREND_UP");
    assert.equal(report.regimes[0].trades, 40);
    assert.equal(typeof report.regimes[0].sharpe, "number");
    assert.deepEqual(report.regimeEvidence.featureVersions, ["rfe1"]);
    assert.deepEqual(report.regimeEvidence.modelVersions, ["rmo1"]);
    assert.equal(report.regimeEvidence.attributedTrades, 40);
    assert.equal(report.regimeEvidence.unknownRegimeTrades, 0);
    assert.equal(report.regimeEvidence.unattributedTrades, 0);
  });

  it("Regime-Grenze: weniger Trades als minSampleTrades ⇒ Zeile mit sharpe null", () => {
    const trades = Array.from({ length: 3 }, (_, index) => entry(index));
    const report = build({
      trades,
      regimeSnapshots: [
        { symbol: "BITUNIX:BTCUSDT", asOf: BASE_WINDOW_START, confirmedRegime: "RANGE", featureVersion: "rfe1", modelVersion: "rmo1" },
      ],
      minSampleTrades: 30,
    });
    assert.equal(report.regimes[0].trades, 3);
    assert.equal(report.regimes[0].sharpe, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Hash, Determinismus, Architektur-Wächter
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-04: Hash, Determinismus und Architektur", () => {
  it("evidenceHash/idempotencyKey kommen aus strategyLifecycle/evidence.ts", () => {
    const report = build();
    assert.match(report.evidenceHash, /^sle1:[0-9a-f]{64}$/);
    assert.match(report.idempotencyKey, /^slei1:[0-9a-f]{64}$/);
    assert.equal(validationEvidenceHash(report), report.evidenceHash);
    assert.equal(validationIdempotencyKey(report), report.idempotencyKey);
    assert.equal(validationEvidenceInput(report).kind, "BACKTEST_RUN");
    assert.equal(validationEvidenceInput(report).result, report.result);
  });

  it("identische Eingabe ⇒ byte-identischer Report (Determinismus)", () => {
    const first = build();
    const second = build();
    assert.equal(first.evidenceHash, second.evidenceHash);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("nachträglich veränderter Report wird fail-closed abgewiesen", () => {
    const report = build();
    const tampered = { ...report, result: "FAIL" as const };
    assert.throws(() => assertReportHashIntegrity(tampered), /hash-mismatch|validation:/);
    const swappedHash = { ...report, evidenceHash: `sle1:${"a".repeat(64)}` };
    assert.throws(() => assertReportHashIntegrity(swappedHash), /hash-mismatch/);
  });

  it("Detail-Map ist ausschließlich primitiv (hashbar) und enthält die Gate-Kette", () => {
    const report = build();
    const detail = validationEvidenceInput(report).detail ?? {};
    for (const [key, value] of Object.entries(detail)) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `detail.${key} ist nicht primitiv (${typeof value})`,
      );
    }
    assert.equal(detail.overfittingHoldoutIntegrity, "CLEAN");
    assert.match(String(detail.gatesJson), /ASSUMPTIONS/);
  });

  it("statischer Wächter: kein requestTransition-Aufruf in der Validator-Domäne", () => {
    const root = path.join(process.cwd(), "src/strategies/validator");
    for (const file of ["report.ts", "assumptions.ts", "overfit.ts", "stress.ts", "persist.ts", "index.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8");
      // Prosa darf die Sperre nennen, ein Aufruf nicht.
      assert.doesNotMatch(source, /requestTransition\s*\(/, `${file} darf nicht promoten`);
    }
  });

  it("statischer Wächter: report/assumptions/overfit ohne Uhr, Zufall und DB", () => {
    const root = path.join(process.cwd(), "src/strategies/validator");
    for (const file of ["report.ts", "assumptions.ts", "overfit.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8");
      assert.doesNotMatch(source, /from ["']@\/db["']/, `${file} darf nicht direkt auf die DB`);
      assert.doesNotMatch(source, /Date\.now\(|new Date\(|Math\.random\(/, `${file} muss rein/deterministisch sein`);
    }
  });
});

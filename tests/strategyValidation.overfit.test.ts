/**
 * STX-06-02 — Overfit- & Robustheitsauswertung: Vertrags- und Pfadtests.
 *
 * Diese Suite ist die Abnahme der Plateau-/Lücken-/Multiplizitäts-/Integritäts-
 * Auswertung. Sie prüft die Akzeptanzkriterien des Prompts STX-06-02:
 *
 *  1. **Plateau statt Optimum:** Fixture-Tabellen mit 1/5, 19/20 und 20/20
 *     stabilen Kandidaten liefern drei unterscheidbare `robustShare`-Werte;
 *     „in ALLEN Fenstern" wird nicht mit „in irgendeinem Fenster" verwechselt.
 *  2. **OOS entscheidet:** `oosSharpe <= 0` ⇒ `BROKEN`, unabhängig vom
 *     IS-Sharpe — `isSharpe` allein entscheidet nie.
 *  3. **Multiplizität:** `nCandidates > 20` ⇒ `BLOCKING`.
 *  4. **Holdout-Integrität:** `holdout.from < freeze.oosTo` ⇒ `CONTAMINATED`
 *     (und `INCONCLUSIVE`); gleicher Kandidat + Referenz-Hash ⇒ `CLEAN`.
 *  5. **Vollständigkeitsgrenze:** fehlende Score-Tabelle ⇒ `UNKNOWN` mit Grund,
 *     ausdrücklich nicht „robust, weil nur ein Kandidat geprüft wurde".
 *
 * Dazu die strukturellen Zusagen: Determinismus (zwei Aufrufe ⇒ identische
 * Ausgabe), keine Mutation der Eingabe, Evidenz/Schwellen immer mit Zahl,
 * fail-closed bei falschen Schwellen — und als statischer Wächter: keine
 * IO/Uhr/DB im Modulquelltext sowie **kein** Wert-Import (das Modul liest nur
 * Typen von `walkforward.ts` und erzeugt keine Kandidaten).
 *
 * Keine DB, kein Netz, keine Zeitabhängigkeit: Alle Fakten sind injizierte
 * Fixtures. `walkforward.ts` wird nicht ausgeführt und nicht verändert.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
  INTEGRITY_CHECK_IDS,
  MULTIPLE_TESTING_THRESHOLDS,
  OVERFIT_AUDIT_VERSION,
  TRAIN_OOS_GAP_BOUNDS,
  holdoutIntegrity,
  multipleTestingWarning,
  plateauMetrics,
  trainOosGap,
} from "../src/strategies/validator/overfit";
import type { IntegrityCheck, TrainOosGap } from "../src/strategies/validator/overfit";
import type {
  CandidateScoreRow,
  FreezeArtifact,
  HoldoutReport,
  WalkForwardAggregate,
} from "../src/backtest/walkforward";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Eine Score-Zeile mit vollständigen Metriken (nur die geprüften Felder variieren). */
function row(
  candidateId: string,
  opts: {
    passed?: boolean;
    score?: number;
    netPnl?: number;
    trades?: number;
    maxDrawdownPct?: number;
  } = {},
): CandidateScoreRow {
  const passed = opts.passed ?? true;
  const score = opts.score ?? 1;
  return {
    candidateId,
    candidateName: candidateId,
    config: { candidateId },
    score,
    passedGates: passed,
    rejectionReason: passed ? null : "minTrades: 3 < 10",
    metrics: {
      trades: opts.trades ?? 10,
      winRate: 50,
      netPnl: opts.netPnl ?? 100,
      pnl: 0.1,
      sharpeRatio: score,
      sortinoRatio: 1,
      profitFactor: 1.5,
      maxDrawdownPct: opts.maxDrawdownPct ?? 5,
    },
  };
}

/**
 * `windows` Fenster × `n` Kandidaten (`c1…cn`). Kandidat `i` (0-basiert)
 * besteht in Fenster `w` genau dann, wenn `passed(i, w)` gilt.
 */
function scoreTables(
  n: number,
  windows: number,
  passed: (candidateIndex: number, windowIndex: number) => boolean,
): CandidateScoreRow[][] {
  const tables: CandidateScoreRow[][] = [];
  for (let w = 0; w < windows; w++) {
    const table: CandidateScoreRow[] = [];
    for (let i = 0; i < n; i++) {
      const ok = passed(i, w);
      table.push(row(`c${i + 1}`, { passed: ok, score: ok ? n - i : 1 }));
    }
    tables.push(table);
  }
  return tables;
}

/** Walk-Forward-Aggregat-Fixture; nur `sharpeRatio`/`windows` sind relevant. */
function agg(sharpeRatio: number, windows = 3): WalkForwardAggregate {
  return {
    windows,
    bars: 100,
    trades: 10,
    wins: 5,
    winRate: 50,
    pnl: 1,
    profitFactor: 1.2,
    maxDrawdownPct: 5,
    sharpeRatio,
    sortinoRatio: 1,
    fees: 0,
    funding: 0,
    netPnl: 1,
    slippage: 0,
  };
}

const HEX64 = "a".repeat(64);

/** Freeze-Artefakt-Fixture (letztes Fenster); nur die geprüften Felder zählen. */
function freezeFixture(overrides: Partial<FreezeArtifact> = {}): FreezeArtifact {
  return {
    windowIndex: 2,
    isFrom: 1_700_000_000_000,
    isTo: 1_705_000_000_000,
    oosFrom: 1_705_000_000_000,
    oosTo: 1_710_000_000_000,
    selectedCandidateId: "cand-2",
    selectedCandidate: { id: "cand-2", name: "cand-2", config: {}, strategies: [] },
    scoreTable: [],
    dataManifest: {
      candlesHash: HEX64,
      candleCount: 100,
      from: 1_700_000_000_000,
      to: 1_705_000_000_000,
    },
    candidateHash: "b".repeat(64),
    configHash: "c".repeat(64),
    codeVersion: "0.0.0-test",
    seed: 1,
    cutoffs: {
      isFrom: 1_700_000_000_000,
      isTo: 1_705_000_000_000,
      oosFrom: 1_705_000_000_000,
      oosTo: 1_710_000_000_000,
    },
    freezeHash: "d".repeat(64),
    ...overrides,
  };
}

/** Holdout-Report-Fixture; `from` liegt standardmäßig nach `freeze.oosTo`. */
function holdoutFixture(overrides: Partial<HoldoutReport> = {}): HoldoutReport {
  return {
    from: 1_720_000_000_000,
    to: 1_730_000_000_000,
    candidateId: "cand-2",
    candidate: { id: "cand-2", name: "cand-2", config: {}, strategies: [] },
    summary: {
      from: 1_720_000_000_000,
      to: 1_730_000_000_000,
      bars: 100,
      trades: 10,
      wins: 5,
      winRate: 50,
      pnl: 0.1,
      profitFactor: 1.5,
      maxDrawdownPct: 5,
      sharpeRatio: 1,
      sortinoRatio: 1,
      fees: 1,
      funding: 0,
      netPnl: 10,
      slippage: 1,
      tradeHash: "e".repeat(64),
    },
    trades: [],
    ...overrides,
  };
}

/** Jede Evidenz/jeder Grund trägt eine Zahl (Repo-Regel, `tests/strategyValidation.assumptions.test.ts`). */
function assertHasNumber(text: string, label: string): void {
  assert.match(text, /\d/, `${label} ohne Zahl: „${text}“`);
  assert.ok(text.length > 20, `${label} zu kurz: „${text}“`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) plateauMetrics — Plateau vs. Fragilität
// ─────────────────────────────────────────────────────────────────────────────

describe("plateauMetrics — Plateau statt Optimum", () => {
  test("1 von 5 stabil, 2 nie bestanden ⇒ robustShare 0.2 / neverShare 0.4", () => {
    // c1 besteht überall; c2 scheitert im letzten Fenster; c3 besteht nur im
    // ersten; c4/c5 bestehen nie.
    const tables = scoreTables(5, 3, (i, w) => i === 0 || (i === 1 && w < 2) || (i === 2 && w === 0));

    const metrics = plateauMetrics(tables);

    assert.equal(metrics.status, "OK");
    assert.equal(metrics.candidateCount, 5);
    assert.equal(metrics.windowCount, 3);
    assert.equal(metrics.stableCount, 1);
    assert.equal(metrics.robustShare, 0.2);
    assert.equal(metrics.neverShare, 0.4);
    assertHasNumber(metrics.summary, "plateauMetrics.summary");
  });

  test("19 von 20 stabil ⇒ robustShare 0.95 (eine Ausreißer-Variante in keinem Fenster)", () => {
    const tables = scoreTables(20, 4, (i) => i < 19);

    const metrics = plateauMetrics(tables);

    assert.equal(metrics.status, "OK");
    assert.equal(metrics.stableCount, 19);
    assert.equal(metrics.robustShare, 0.95);
    assert.equal(metrics.neverShare, 0.05);
  });

  test("20 von 20 stabil ⇒ robustShare 1 — und die drei Fälle sind unterscheidbar", () => {
    const one = plateauMetrics(scoreTables(5, 3, (i) => i === 0));
    const nineteen = plateauMetrics(scoreTables(20, 4, (i) => i < 19));
    const twenty = plateauMetrics(scoreTables(20, 4, () => true));

    assert.equal(twenty.robustShare, 1);
    assert.equal(twenty.neverShare, 0);
    assert.equal(twenty.stableCount, 20);

    const values = [one.robustShare, nineteen.robustShare, twenty.robustShare] as number[];
    assert.deepEqual([...values].sort((a, b) => a - b), [0.2, 0.95, 1]);
    assert.notEqual(values[0], values[1]);
    assert.notEqual(values[1], values[2]);
  });

  test("„in ALLEN Fenstern“ ist strikt: 2 von 3 Fenstern ist nicht stabil", () => {
    const tables = [
      [row("c1", { passed: true }), row("c2", { passed: true })],
      [row("c1", { passed: true }), row("c2", { passed: true })],
      [row("c1", { passed: false }), row("c2", { passed: true })],
    ];
    const metrics = plateauMetrics(tables, { selectedCandidateId: "c1" });

    assert.equal(metrics.status, "OK");
    assert.equal(metrics.candidateCount, 2);
    assert.equal(metrics.stableCount, 1, "nur c2 besteht in allen drei Fenstern");
    assert.equal(metrics.robustShare, 0.5);
    assert.equal(metrics.neverShare, 0);
  });

  test("flache Tabelle (Prompt-Signatur) ist genau ein Fenster", () => {
    const metrics = plateauMetrics([
      row("c1", { passed: true }),
      row("c2", { passed: false }),
      row("c3", { passed: false }),
      row("c4", { passed: false }),
      row("c5", { passed: false }),
    ]);

    assert.equal(metrics.status, "OK");
    assert.equal(metrics.windowCount, 1);
    assert.equal(metrics.candidateCount, 5);
    assert.equal(metrics.robustShare, 0.2);
    assert.equal(metrics.neverShare, 0.8);
  });

  test("Rangfolge: Gates vor Score, dann deterministische Tie-Breaker", () => {
    // c9 hat den höchsten Score, besteht die Gates aber nicht ⇒ letzter Platz.
    const table = [
      row("c1", { passed: true, score: 1, netPnl: 10, trades: 10, maxDrawdownPct: 5 }),
      row("c2", { passed: true, score: 1, netPnl: 20, trades: 10, maxDrawdownPct: 5 }),
      row("c3", { passed: true, score: 1, netPnl: 20, trades: 10, maxDrawdownPct: 5 }),
      row("c9", { passed: false, score: 99 }),
    ];

    const metrics = plateauMetrics(table, { selectedCandidateId: "c1" });

    // c1 ist Erster (Score 1 = gleich, netPnl 10 < 20 verliert gegen c2/c3) …
    // Rangfolge erwartet: c2, c3 (gleiche Score/PnL/Trades/DD ⇒ ID aufsteigend), c1, c9.
    assert.equal(metrics.selectedCandidateId, "c1");
    assert.equal(metrics.selectedRankMedian, 3);
  });

  test("Standard-Auswahl = Erstplatzierter des letzten Fensters (Holdout-Kandidat)", () => {
    const tables = [
      [row("c1", { score: 3 }), row("c2", { score: 1 })],
      [row("c2", { score: 3 }), row("c1", { score: 1 })],
    ];

    const metrics = plateauMetrics(tables);

    assert.equal(metrics.selectedCandidateId, "c2");
    assert.equal(metrics.selectedRankMedian, 1.5);
    // Feld 2 ⇒ Stabilität = 1 − (1.5 − 1) / 1 = 0.5
    assert.equal(metrics.selectionStability, 0.5);
  });

  test("selectionStability nutzt die Feldgröße (0 = immer Letzter, 1 = immer Erster)", () => {
    const tables = [
      [row("c1", { score: 4 }), row("c2", { score: 3 }), row("c3", { score: 2 }), row("c4", { score: 1 })],
      [row("c2", { score: 9 }), row("c3", { score: 8 }), row("c4", { score: 7 }), row("c1", { score: 6 })],
    ];

    const last = plateauMetrics(tables); // c2 gewinnt das letzte Fenster
    assert.equal(last.selectedCandidateId, "c2");
    assert.equal(last.selectedRankMedian, 1.5); // Ränge 2, 1
    assert.equal(last.selectionStability, 0.8333); // 1 − 0.5/3

    const worst = plateauMetrics(tables, { selectedCandidateId: "c4" });
    assert.equal(worst.selectedRankMedian, 3.5); // Ränge 4 (erstes) und 3 (letztes Fenster)
    assert.equal(worst.selectionStability, 0.1667); // 1 − 2.5/3
  });

  test("UNKNOWN: fehlende Score-Tabelle (leer, null, undefined) mit Grund", () => {
    for (const input of [[], null, undefined] as const) {
      const metrics = plateauMetrics(input);
      assert.equal(metrics.status, "UNKNOWN");
      assert.equal(metrics.robustShare, null);
      assert.equal(metrics.neverShare, null);
      assert.equal(metrics.windowCount, 0);
      assertHasNumber(metrics.summary, "plateauMetrics.summary (UNKNOWN)");
      assert.match(metrics.summary, /0 Fenster/);
    }
  });

  test("UNKNOWN: ein einzelner Kandidat ist kein Nachbarschafts-Scan", () => {
    const metrics = plateauMetrics([[row("c1")], [row("c1")]]);

    assert.equal(metrics.status, "UNKNOWN");
    assert.equal(metrics.candidateCount, 1);
    assert.equal(metrics.robustShare, null);
    assert.match(metrics.summary, /Nachbarschafts-Scan/);
    assertHasNumber(metrics.summary, "plateauMetrics.summary (ein Kandidat)");
  });

  test("UNKNOWN: leere Fenster-Tabelle ⇒ nicht für alle Fenster entschieden", () => {
    const metrics = plateauMetrics([[row("c1")], []]);

    assert.equal(metrics.status, "UNKNOWN");
    assert.equal(metrics.robustShare, null);
    assertHasNumber(metrics.summary, "plateauMetrics.summary (leeres Fenster)");
  });

  test("flache Verkettung mehrerer Fenster wird abgewiesen (doppelte candidateId)", () => {
    assert.throws(
      () => plateauMetrics([row("c1"), row("c2"), row("c1")]),
      /plateau-window-flattened/,
    );
  });

  test("unbekannter selectedCandidateId wird abgewiesen statt still ignoriert", () => {
    assert.throws(
      () => plateauMetrics([row("c1"), row("c2")], { selectedCandidateId: "c99" }),
      /plateau-selected-unknown/,
    );
  });

  test("deterministisch und eingabe-treu: zwei Aufrufe identisch, Eingabe unverändert", () => {
    const tables = scoreTables(6, 3, (i, w) => (i + w) % 2 === 0);
    const before = JSON.stringify(tables);

    const first = plateauMetrics(tables);
    const second = plateauMetrics(tables);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(tables), before, "plateauMetrics darf die Eingabe nicht mutieren");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) trainOosGap — die OOS-Seite entscheidet
// ─────────────────────────────────────────────────────────────────────────────

describe("trainOosGap — IS/OOS-Lücke", () => {
  test("oosSharpe <= 0 ⇒ BROKEN, unabhängig vom (brillanten) IS-Sharpe", () => {
    const brilliant = trainOosGap({ is: agg(9.5), oos: agg(0) });
    assert.equal(brilliant.verdict, "BROKEN");
    assert.equal(brilliant.isSharpe, 9.5);
    assert.equal(brilliant.oosSharpe, 0);

    const negative = trainOosGap({ is: agg(0.05), oos: agg(-1.2) });
    assert.equal(negative.verdict, "BROKEN");
  });

  test("gap > 0.5 ⇒ SUSPECT; genau 0.5 ⇒ OK (Grenze ist strikt)", () => {
    assert.equal(trainOosGap({ is: agg(1.4), oos: agg(0.7) }).verdict, "SUSPECT");

    const boundary = trainOosGap({ is: agg(1.5), oos: agg(1.0) });
    assert.equal(boundary.gap, 0.5);
    assert.equal(boundary.verdict, "OK");
  });

  test("isSharpe allein entscheidet nie: negativer IS und bessere OOS ⇒ OK", () => {
    const result = trainOosGap({ is: agg(-5), oos: agg(1) });

    assert.equal(result.verdict, "OK");
    assert.equal(result.gap, -6);
    assertHasNumber(result.evidence, "trainOosGap.evidence");
  });

  test("Grenzen sind konfigurierbar (suspectGap und brokenOosAtOrBelow)", () => {
    const relaxed = trainOosGap({ is: agg(1.4), oos: agg(0.7), thresholds: { suspectGap: 1.5 } });
    assert.equal(relaxed.verdict, "OK");
    assert.equal(relaxed.thresholds.suspectGap, 1.5);

    const strict = trainOosGap({
      is: agg(1.2),
      oos: agg(-0.3),
      thresholds: { brokenOosAtOrBelow: -0.5 },
    });
    assert.equal(strict.verdict, "SUSPECT");
    assert.equal(strict.thresholds.brokenOosAtOrBelow, -0.5);
  });

  test("UNKNOWN: Aggregat ohne Fenster ist keine Aussage (nie „OK aus 0 Werten“)", () => {
    const result = trainOosGap({ is: agg(0, 0), oos: agg(0, 0) });

    assert.equal(result.verdict, "UNKNOWN");
    assert.equal(result.gap, null);
    assertHasNumber(result.evidence, "trainOosGap.evidence (UNKNOWN)");
  });

  test("Defaults sind dokumentiert und unverändert", () => {
    assert.equal(DEFAULT_TRAIN_OOS_GAP_THRESHOLDS.suspectGap, 0.5);
    assert.equal(DEFAULT_TRAIN_OOS_GAP_THRESHOLDS.brokenOosAtOrBelow, 0);
    assert.deepEqual(TRAIN_OOS_GAP_BOUNDS.suspectGap, [0, 100]);
  });

  test("Schwellen außerhalb der Bounds und fehlende Aggregate werden abgewiesen (fail-closed)", () => {
    assert.throws(
      () => trainOosGap({ is: agg(1), oos: agg(1), thresholds: { suspectGap: 101 } }),
      /suspectGap/,
    );
    assert.throws(
      () => trainOosGap({ is: agg(1), oos: agg(1), thresholds: { brokenOosAtOrBelow: 1000 } }),
      /brokenOosAtOrBelow/,
    );
    assert.throws(() => trainOosGap({} as unknown as Parameters<typeof trainOosGap>[0]), /"is"/);
    assert.throws(
      () => trainOosGap({ is: { ...agg(1), windows: Number.NaN }, oos: agg(1) }),
      /windows/,
    );
  });

  test("Determinismus: zwei Aufrufe identisch", () => {
    const input = { is: agg(1.3), oos: agg(0.4) };
    const first: TrainOosGap = trainOosGap(input);
    assert.deepEqual(trainOosGap(input), first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) multipleTestingWarning — Statistik, nicht Übervorsicht
// ─────────────────────────────────────────────────────────────────────────────

describe("multipleTestingWarning — Multiplizität", () => {
  test("n <= 5 ⇒ NONE (keine Warnung)", () => {
    for (const n of [1, 3, 5]) {
      const warning = multipleTestingWarning(n);
      assert.equal(warning.level, "NONE");
      assert.equal(warning.blocking, false);
      assertHasNumber(warning.evidence, `multipleTestingWarning(${n}).evidence`);
    }
  });

  test("6…20 ⇒ WARNING im Report", () => {
    for (const n of [6, 12, 20]) {
      const warning = multipleTestingWarning(n);
      assert.equal(warning.level, "WARNING", `n=${n}`);
      assert.equal(warning.blocking, false);
    }
  });

  test("n > 20 ⇒ BLOCKING (der beste ist per Zufall gut)", () => {
    for (const n of [21, 50, 100]) {
      const warning = multipleTestingWarning(n);
      assert.equal(warning.level, "BLOCKING", `n=${n}`);
      assert.equal(warning.blocking, true);
      assertHasNumber(warning.evidence, `multipleTestingWarning(${n}).evidence`);
    }
    assert.equal(multipleTestingWarning(21).level, "BLOCKING");
    assert.equal(multipleTestingWarning(20).level, "WARNING");
  });

  test("Grenzen sind exportiert und begründet (nicht konfigurierbar)", () => {
    assert.deepEqual(MULTIPLE_TESTING_THRESHOLDS, { reportAbove: 5, blockingAbove: 20 });
  });

  test("ungültige Kandidatenzahlen werden abgewiesen (fail-closed)", () => {
    for (const n of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => multipleTestingWarning(n), /multiple-testing-invalid/, `n=${String(n)}`);
    }
  });

  test("Determinismus: zwei Aufrufe identisch", () => {
    assert.deepEqual(multipleTestingWarning(50), multipleTestingWarning(50));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) holdoutIntegrity — der Holdout bleibt unberührt
// ─────────────────────────────────────────────────────────────────────────────

describe("holdoutIntegrity — Kontamination", () => {
  test("holdout.from < freeze.oosTo ⇒ CONTAMINATED und INCONCLUSIVE", () => {
    const holdout = holdoutFixture({ from: 1_709_000_000_000, to: 1_730_000_000_000 });
    const check = holdoutIntegrity(holdout, freezeFixture());

    assert.equal(check.status, "CONTAMINATED");
    assert.equal(check.verdict, "INCONCLUSIVE");
    const finding = check.checks.find((entry) => entry.id === "HOLDOUT_AFTER_OOS");
    assert.equal(finding?.status, "CONTAMINATED");
    assertHasNumber(finding?.evidence ?? "", "HOLDOUT_AFTER_OOS.evidence");
  });

  test("holdout.from === freeze.oosTo ⇒ CLEAN (Grenze ist einschließlich)", () => {
    const holdout = holdoutFixture({ from: 1_710_000_000_000 });
    const check = holdoutIntegrity(holdout, freezeFixture(), { candlesHash: HEX64 });

    assert.equal(check.status, "CLEAN");
    assert.equal(check.verdict, "CLEAR");
  });

  test("anderer Kandidat im Holdout ⇒ CONTAMINATED (Auswahl nach dem Holdout)", () => {
    const check = holdoutIntegrity(holdoutFixture({ candidateId: "cand-9" }), freezeFixture(), {
      candlesHash: HEX64,
    });

    assert.equal(check.status, "CONTAMINATED");
    assert.equal(check.checks.find((entry) => entry.id === "SELECTION_FROZEN")?.status, "CONTAMINATED");
    assert.match(check.reason, /cand-9/);
  });

  test("Kerzen-Hash: Referenz gleich ⇒ CLEAN, abweichend ⇒ CONTAMINATED", () => {
    const same = holdoutIntegrity(holdoutFixture(), freezeFixture(), { candlesHash: HEX64 });
    assert.equal(same.checks.find((entry) => entry.id === "CANDLES_HASH")?.status, "CLEAN");
    assert.equal(same.status, "CLEAN");

    const changed = holdoutIntegrity(holdoutFixture(), freezeFixture(), { candlesHash: "f".repeat(64) });
    assert.equal(changed.status, "CONTAMINATED");
    assert.equal(changed.checks.find((entry) => entry.id === "CANDLES_HASH")?.status, "CONTAMINATED");
  });

  test("ohne Referenz ist der Hash strukturell geprüft, aber UNVERIFIED (kein stilles CLEAN)", () => {
    const check = holdoutIntegrity(holdoutFixture(), freezeFixture());

    const finding = check.checks.find((entry) => entry.id === "CANDLES_HASH");
    assert.equal(finding?.status, "UNVERIFIED");
    assert.equal(check.status, "CLEAN");
    assertHasNumber(finding?.evidence ?? "", "CANDLES_HASH.evidence");
    assertHasNumber(check.reason, "holdoutIntegrity.reason");
  });

  test("fehlende oder kaputte Fakten ⇒ UNKNOWN (nie „clean aus 0 Prüfungen“)", () => {
    const missing = holdoutIntegrity(null, null);
    assert.equal(missing.status, "UNKNOWN");
    assert.equal(missing.verdict, "INCONCLUSIVE");
    assertHasNumber(missing.reason, "holdoutIntegrity.reason (fehlend)");

    const noHash = holdoutIntegrity(
      holdoutFixture(),
      freezeFixture({ dataManifest: { candlesHash: "", candleCount: 0, from: 0, to: 0 } }),
    );
    assert.equal(noHash.status, "UNKNOWN");

    const badHash = holdoutIntegrity(
      holdoutFixture(),
      freezeFixture({ dataManifest: { candlesHash: "abc", candleCount: 1, from: 0, to: 0 } }),
    );
    assert.equal(badHash.status, "UNKNOWN");

    const badReference = holdoutIntegrity(holdoutFixture(), freezeFixture(), { candlesHash: "nope" });
    assert.equal(badReference.status, "UNKNOWN");
  });

  test("CONTAMINATED schlägt UNKNOWN; Prüfungen stehen in fester Reihenfolge", () => {
    const holdout = holdoutFixture({ candidateId: "cand-9", from: 1_709_000_000_000 });
    const check = holdoutIntegrity(holdout, freezeFixture({ selectedCandidateId: "" }));

    assert.equal(check.status, "CONTAMINATED");
    assert.deepEqual(
      check.checks.map((entry) => entry.id),
      [...INTEGRITY_CHECK_IDS],
    );
  });

  test("deterministisch und eingabe-treu: zwei Aufrufe identisch, Eingabe unverändert", () => {
    const holdout = holdoutFixture();
    const freeze = freezeFixture();
    const before = JSON.stringify({ holdout, freeze });

    const first: IntegrityCheck = holdoutIntegrity(holdout, freeze);
    const second: IntegrityCheck = holdoutIntegrity(holdout, freeze);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify({ holdout, freeze }), before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Struktur: reine Funktionen, keine IO, keine Kandidatengenerierung
// ─────────────────────────────────────────────────────────────────────────────

describe("overfit.ts — strukturelle Zusagen", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/strategies/validator/overfit.ts"),
    "utf8",
  );

  test("Version der Auswertungslogik ist exportiert", () => {
    assert.equal(OVERFIT_AUDIT_VERSION, "ovf1");
    assert.ok(source.includes(`"ovf1"`));
  });

  test("Modulquelltext ist IO-frei: keine Uhr, kein Zufall, keine DB, kein fs", () => {
    for (const forbidden of [
      "Date.now(",
      "new Date(",
      "Math.random(",
      "process.env",
      "node:fs",
      "node:net",
      "node:http",
      'from "pg"',
      "@/db",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `Overfit-Auswertung enthält verbotene IO-Referenz „${forbidden}“`,
      );
    }
  });

  test("keine Wert-Importe und keine Kandidatengenerierung im Modul", () => {
    const valueImports = [...source.matchAll(/^import\s+\{[^}]*\}\s+from\s+"([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(valueImports, [], `overfit.ts darf nur Typen importieren, importiert aber ${valueImports.join(", ")}`);

    for (const forbiddenCall of ["runWalkForward(", "runMultiAssetBacktest(", "validateCandidates("]) {
      assert.ok(
        !source.includes(forbiddenCall),
        `Overfit-Auswertung darf keine Läufe erzeugen/starten: „${forbiddenCall}“ gefunden`,
      );
    }
  });
});

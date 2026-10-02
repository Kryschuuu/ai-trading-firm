/**
 * STX-05-04 — Tests des Screening-Runners (`src/screening/runner.ts`).
 *
 * Bewusst **ohne** Engine und **ohne** Datenbank: der Backtest ist ein Stub,
 * der Store ein In-Memory-Port mit denselben Verträgen wie 05-03
 * (idempotenter Run über den `ssr1:`-Hash, insert-only Zellen, monotone
 * Zähler, terminale Status). Genau deshalb ist die Budget-Zusicherung messbar.
 *
 * Abgedeckt werden die Akzeptanzkriterien des Prompts:
 *  - `--dry-run`-Äquivalent (`skipBacktest`) persistiert ohne Backtest-Job.
 *  - `maxCells` ist **hart**: Abbruch mit klarer Meldung, kein Store-Zugriff,
 *    kein stilles Kürzen.
 *  - Budget: 50 Zellen mit Stub ⇒ Wall-Clock << 30 s.
 *  - Caps (`RULE_BACKTEST_MIN_BARS`/`TRADE_CAP`/`EQUITY_CAP`): Zelle wird
 *    `BLOCKED` mit Grund `caps exceeded` — **nicht** gekappt abgelegt.
 *  - Bounded Concurrency: I/O parallel begrenzt, Backtest (CPU) strikt seriell.
 *  - Telemetrie-Labels bounded (kein `instrument_id`, geschlossenes Vokabular).
 *  - Abbruch mitten im Lauf ⇒ `ABORTED`, konsistentes `cells_done`,
 *    Fortsetzung über denselben Inhalt setzt genau dort fort.
 *  - Kein Ergebnis-Overwrite: anderer Inhalt ⇒ neuer Lauf, gleicher Inhalt ⇒
 *    idempotentes Replay (0 neue Zellen).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  RULE_BACKTEST_EQUITY_CAP,
  RULE_BACKTEST_MIN_BARS,
  RULE_BACKTEST_TRADE_CAP,
} from "../src/lib/ruleBacktest";
import { metricLabel, telemetry } from "../src/lib/telemetry";
import {
  MAX_MATRIX_CELLS,
  SCREENING_BACKTEST_PATH,
  SCREENING_CAP_TOKENS,
  SCREENING_CELL_RESULTS,
  SCREENING_DEFAULT_CONCURRENCY,
  SCREENING_MAX_CONCURRENCY,
  checkScreeningCaps,
  mapScreeningBounded,
  runScreening,
  type ScreeningBacktestCounts,
  type ScreeningBacktestOutcome,
  type ScreeningBacktestPort,
  type ScreeningCellOutcome,
  type ScreeningRunInput,
  type ScreeningStorePort,
} from "../src/screening/runner";
import { screeningRunHash } from "../src/screening/keys";
import { SCREENING_CAPS_REASON } from "../src/screening/runner";
import type { RunRow, ScreeningCellInput } from "../src/screening/store";
import type {
  CandidateStatus,
  StrategyMarketCandidate,
} from "../src/screening/types";
import { cell, cells } from "./screening.runner.fixtures";

// ── Fixtures ───────────────────────────────────────────────────────────────

const AS_OF = "2026-10-01T12:00:00.000Z";
const CODE_VERSION = "test-0.9.0";

/** Run-Zeile des Fake-Stores (Shape wie `RunRow` aus 05-03). */
type FakeRunRow = RunRow;

/** In-Memory-Store mit den Verträgen aus 05-03 (idempotent, insert-only, monoton). */
class FakeStore implements ScreeningStorePort {
  readonly runs = new Map<string, FakeRunRow>();
  readonly rows: { runId: string; cell: ScreeningCellInput }[] = [];
  createCalls = 0;
  upsertCalls = 0;
  statusCalls: { status: string; cellsDone: number }[] = [];
  /** Optional: abstürzender Store (Test des Fehlerpfads). */
  failOnUpsert = false;

  async createOrGetRun(input: Parameters<ScreeningStorePort["createOrGetRun"]>[0]): Promise<RunRow> {
    this.createCalls += 1;
    const hash = screeningRunHash(input);
    const existing = [...this.runs.values()].find((r) => r.candidateSetHash === hash);
    if (existing) return existing;
    const row = {
      id: randomUUID(),
      runKind: input.runKind,
      asOf: new Date(input.asOf),
      candidateSetHash: hash,
      codeVersion: input.codeVersion,
      dataVersion: input.dataVersion ?? null,
      configJson: input.config,
      status: "PENDING" as const,
      cellsTotal: input.cells.length,
      cellsDone: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.runs.set(row.id, row);
    return row;
  }

  async upsertCells(runId: string, cells: readonly ScreeningCellInput[]): Promise<number> {
    this.upsertCalls += 1;
    if (this.failOnUpsert) throw new Error("store: Transaktion abgelehnt");
    let inserted = 0;
    for (const c of cells) {
      const key = `${runId}|${String(c.instrumentId)}|${String(c.timeframe)}|${String(c.templateId)}`;
      if (this.rows.some((r) => `${r.runId}|${String(r.cell.instrumentId)}|${String(r.cell.timeframe)}|${String(r.cell.templateId)}` === key)) {
        continue; // ON CONFLICT DO NOTHING
      }
      this.rows.push({ runId, cell: c });
      inserted += 1;
    }
    return inserted;
  }

  async setRunStatus(
    runId: string,
    status: Parameters<ScreeningStorePort["setRunStatus"]>[1],
    counts: Parameters<ScreeningStorePort["setRunStatus"]>[2] = {},
  ): Promise<RunRow> {
    const row = this.runs.get(runId);
    if (!row) throw new Error("store: Run nicht gefunden");
    if (row.status === "DONE" || row.status === "FAILED") return row; // terminal
    const cellsTotal = Math.max(row.cellsTotal, counts.cellsTotal ?? 0);
    const cellsDone = Math.max(row.cellsDone, counts.cellsDone ?? 0);
    if (cellsDone > cellsTotal) throw new Error("store: cellsDone > cellsTotal");
    row.cellsTotal = cellsTotal;
    row.cellsDone = cellsDone;
    row.status = status === "PENDING" && row.status !== "PENDING" ? row.status : status;
    this.statusCalls.push({ status: row.status, cellsDone: row.cellsDone });
    return row;
  }

  runById(id: string): FakeRunRow | undefined {
    return this.runs.get(id);
  }
}

/** Stub-Backtest: kein Engine-Aufruf, nur Zählung und konfigurierbares Ergebnis. */
class StubBacktest implements ScreeningBacktestPort {
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  /** Ergebnis je Zelle; Default: vollständig innerhalb der Caps. */
  outcomeFor: (request: Parameters<ScreeningBacktestPort["run"]>[0]) => ScreeningBacktestOutcome = () => ({
    backtestRunId: null,
    metrics: { sharpeRatio: 1.2, totalReturnPct: 4.5 },
    counts: { bars: 500, trades: 12, equityPoints: 60 },
  });

  async run(request: Parameters<ScreeningBacktestPort["run"]>[0]): Promise<ScreeningBacktestOutcome> {
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Asynchroner Yield: nur so ist überhaupt Parallelität möglich.
      await new Promise((resolve) => setImmediate(resolve));
      return this.outcomeFor(request);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function input(
  overrides: Partial<ScreeningRunInput> & {
    store?: ScreeningStorePort;
    backtest?: ScreeningBacktestPort;
  } = {},
): ScreeningRunInput {
  const { store, backtest, ...rest } = overrides;
  return {
    cells: cells(5),
    runKind: "BACKTEST_BATCH",
    asOf: AS_OF,
    codeVersion: CODE_VERSION,
    config: { priority: { weights: {} }, limits: { maxCells: MAX_MATRIX_CELLS } },
    resolveStrategyVersion: (c) => c.strategyVersionId ?? null,
    backtest: backtest ?? new StubBacktest(),
    store: store ?? new FakeStore(),
    ...rest,
  };
}

// ── Pfad-Entscheidung & Vokabular ──────────────────────────────────────────

test("Pfad-Entscheidung aus 00-01 ist eine Konstante (multiAsset, kein backtestRule)", () => {
  assert.equal(SCREENING_BACKTEST_PATH, "multiAsset");
  // Die Entscheidung steht in BENCH-BASELINE.md §6 — der Code entscheidet nicht.
  assert.equal(SCREENING_DEFAULT_CONCURRENCY, 4, "I/O-Default 4");
  assert.equal(SCREENING_MAX_CONCURRENCY, 8, "I/O hart gedeckelt wie src/marketdata/");
});

test("Zell-Ergebnisse sind ein geschlossenes, gebundenes Vokabular", () => {
  assert.deepEqual([...SCREENING_CELL_RESULTS], [
    "discovered",
    "backtested",
    "blocked",
    "capped",
    "failed",
    "skipped",
  ]);
  for (const token of SCREENING_CELL_RESULTS) {
    // Jeder Token ist ein sicheres Label (Kardinalitäts-/Secret-Regel).
    assert.equal(metricLabel(token, "OTHER"), token);
  }
});

// ── Harte Grenze: maxCells ─────────────────────────────────────────────────

test("maxCells ist hart: 50 Zellen mit maxCells 10 ⇒ {ok:false}, kein Store-Zugriff, kein Kürzen", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  const result = await runScreening(
    input({ cells: cells(50), limits: { maxCells: 10 }, store, backtest }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.runId, null, "kein Lauf angelegt");
  assert.equal(result.cellsTotal, 50, "die wahre Größe wird gemeldet, nicht die gekürzte");
  assert.equal(result.cellsDone, 0);
  assert.equal(store.createCalls, 0, "kein createOrGetRun");
  assert.equal(store.upsertCalls, 0, "kein upsertCells");
  assert.equal(backtest.calls, 0, "kein Backtest");
  assert.match(result.errors[0], /matrix too large: 50 > 10/);
});

test("maxCells: Default aus 05-02 greift ohne Override", async () => {
  const result = await runScreening(input({ cells: cells(MAX_MATRIX_CELLS + 1) }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], new RegExp(`matrix too large: ${MAX_MATRIX_CELLS + 1} > ${MAX_MATRIX_CELLS}`));
});

test("limits: ungültiger Override wird abgelehnt, nicht still geklemmt", async () => {
  const result = await runScreening(input({ limits: { maxCells: 0 } }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /limits\.maxCells: muss eine positive Ganzzahl sein/);
});

// ── Budget: 50 Zellen mit Stub ─────────────────────────────────────────────

test("Budget: 50 Zellen mit Stub laufen in weit unter 30 s und enden DONE", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  const started = Date.now();
  const result = await runScreening(input({ cells: cells(50), store, backtest }));
  const wallClock = Date.now() - started;

  assert.equal(result.ok, true, `Fehler: ${result.errors.join("; ")}`);
  assert.equal(result.cellsTotal, 50);
  assert.equal(result.cellsDone, 50);
  assert.equal(result.summary.backtested, 50);
  assert.equal(store.rows.length, 50, "je Zelle genau eine persistierte Zeile");
  assert.equal(backtest.calls, 50);
  assert.equal(result.wallClockMs > 0, true);
  assert.ok(wallClock < 30_000, `Wall-Clock ${wallClock} ms muss < 30 000 ms sein`);
});

// ── Dry-Run-Äquivalent: skipBacktest ───────────────────────────────────────

test("skipBacktest (Dry-Run-Persistenz): Matrix wird geschrieben, der Backtest-Port bleibt unberührt", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  const result = await runScreening(input({ cells: cells(4), skipBacktest: true, store, backtest }));

  assert.equal(result.ok, true);
  assert.equal(backtest.calls, 0, "kein Backtest-Job");
  assert.equal(result.summary.discovered, 4);
  assert.equal(result.summary.backtested, 0);
  assert.equal(store.rows.length, 4);
  for (const row of store.rows) {
    assert.equal(row.cell.status, "DISCOVERED");
    assert.equal(row.cell.backtestRunId, null);
    assert.deepEqual(row.cell.metrics, {}, "keine erfundenen Metriken");
  }
});

// ── Caps: vergleichbar oder geblockt, nie gekappt ──────────────────────────

test("checkScreeningCaps: unbekannte Größen sind fail-closed ein Verstoß", () => {
  assert.deepEqual(checkScreeningCaps({ bars: 500, trades: 12, equityPoints: 60 }).exceeded, []);
  assert.deepEqual(
    checkScreeningCaps({ bars: RULE_BACKTEST_MIN_BARS - 1, trades: 0, equityPoints: 1 }).exceeded,
    ["min_bars"],
  );
  assert.deepEqual(
    checkScreeningCaps({ bars: 500, trades: RULE_BACKTEST_TRADE_CAP + 1, equityPoints: 1 }).exceeded,
    ["trade_cap"],
  );
  assert.deepEqual(
    checkScreeningCaps({ bars: 500, trades: 0, equityPoints: RULE_BACKTEST_EQUITY_CAP + 1 }).exceeded,
    ["equity_cap"],
  );
  assert.deepEqual(
    checkScreeningCaps({ bars: null, trades: null, equityPoints: null }).exceeded,
    ["min_bars", "trade_cap", "equity_cap"],
    "null ist nicht 'unter dem Cap', null ist unbekannt",
  );
});

test("Caps: ein Lauf über dem Trade-Cap wird BLOCKED mit Grund 'caps exceeded', nicht gekappt", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  backtest.outcomeFor = () => ({
    backtestRunId: randomUUID(),
    metrics: { sharpeRatio: 9.9, totalTrades: 4711 },
    counts: { bars: 5_000, trades: 4711, equityPoints: 5_000 },
  });

  const result = await runScreening(input({ cells: cells(3), store, backtest }));

  assert.equal(result.ok, true, "der Lauf ist grün — die Zelle ist gesperrt, nicht der Lauf");
  assert.equal(result.summary.capped, 3);
  assert.equal(result.summary.backtested, 0);
  assert.equal(result.caps.exceededCells, 3);
  assert.deepEqual(result.caps.byCap, { trade_cap: 3, equity_cap: 3 });

  for (const row of store.rows) {
    assert.equal(row.cell.status, "BLOCKED");
    assert.deepEqual(row.cell.reasons, [SCREENING_CAPS_REASON]);
    assert.equal(row.cell.backtestRunId, null, "kein Link auf einen nicht vergleichbaren Lauf");
    assert.deepEqual(row.cell.metrics, {}, "kein gekapptes Ergebnis");
  }
});

test("Caps: ein Lauf unter min_bars wird BLOCKED und je Cap gezählt", async () => {
  const backtest = new StubBacktest();
  backtest.outcomeFor = () => ({
    backtestRunId: null,
    metrics: null,
    counts: { bars: 40, trades: null, equityPoints: null },
    error: "candles:too-few",
  });
  const result = await runScreening(input({ cells: cells(2), backtest }));

  assert.equal(result.summary.capped, 2);
  assert.deepEqual(result.caps.byCap, { min_bars: 2, trade_cap: 2, equity_cap: 2 });
  const reasons = result.cells.flatMap((c) => c.reasons);
  assert.ok(reasons.includes(SCREENING_CAPS_REASON));
  assert.ok(reasons.some((r) => r.startsWith("backtest: candles:too-few")), "der konkrete Grund bleibt sichtbar");
});

test("Caps: ein vergleichbarer Lauf trägt Metriken + Backtest-Link und Status BACKTEST", async () => {
  const runId = randomUUID();
  const backtest = new StubBacktest();
  backtest.outcomeFor = () => ({
    backtestRunId: runId,
    metrics: { sharpeRatio: 1.5, totalReturnPct: 7.25 },
    counts: { bars: 750, trades: 18, equityPoints: 100 },
  });
  const result = await runScreening(input({ cells: cells(2), backtest }));

  assert.equal(result.summary.backtested, 2);
  assert.equal(result.caps.exceededCells, 0);
  for (const row of result.cells) {
    assert.equal(row.status, "BACKTEST");
    assert.equal(row.result, "backtested");
    assert.equal(row.backtestRunId, runId);
  }
});

// ── BLOCKED-Zellen der Matrix ──────────────────────────────────────────────

test("Bereits gesperrte Matrix-Zellen bekommen keinen Backtest-Job", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  const blocked = cells(2, () => ({ status: "BLOCKED" as CandidateStatus, reasons: ["warmup: 29 < 100"] }));
  const open = cells(2);
  const result = await runScreening(input({ cells: [...blocked, ...open], store, backtest }));

  assert.equal(result.summary.blocked, 2);
  assert.equal(result.summary.backtested, 2);
  assert.equal(backtest.calls, 2, "nur die offenen Zellen");
  const blockedRows = store.rows.filter((r) => r.cell.status === "BLOCKED");
  assert.equal(blockedRows.length, 2);
  assert.deepEqual(blockedRows[0].cell.reasons, ["warmup: 29 < 100"], "Matrix-Gründe bleiben unverändert");
});

test("Fehlende Strategieversion ⇒ Zelle failed, nicht persistiert (FK ist Pflicht)", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  const result = await runScreening(
    input({ cells: cells(3), store, backtest, resolveStrategyVersion: () => null }),
  );

  assert.equal(result.ok, true, "der Lauf läuft weiter — die Zelle ist das Ergebnis");
  assert.equal(result.summary.failed, 3);
  assert.equal(store.rows.length, 0, "keine Zeile ohne Version");
  assert.equal(backtest.calls, 0);
  for (const row of result.cells) {
    assert.equal(row.persisted, false);
    assert.ok(row.reasons.includes("strategy version unresolved"));
  }
});

// ── Bounded Concurrency ────────────────────────────────────────────────────

test("Bounded Concurrency: I/O parallel begrenzt, Backtest (CPU) strikt seriell", async () => {
  const backtest = new StubBacktest();
  const store = new FakeStore();
  const result = await runScreening(
    input({ cells: cells(24), concurrency: 4, store, backtest }),
  );

  assert.equal(result.ok, true);
  assert.equal(backtest.calls, 24);
  assert.equal(
    backtest.maxInFlight,
    1,
    "die Engine läuft nur einen Lauf gleichzeitig — CPU-Last bleibt seriell",
  );
});

test("mapScreeningBounded: hält die Grenze ein und bewahrt die Eingabereihenfolge", async () => {
  for (const limit of [1, 2, 4, 8]) {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapScreeningBounded(items, limit, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    assert.equal(maxInFlight <= limit, true, `Grenze ${limit} eingehalten (war ${maxInFlight})`);
    assert.deepEqual(out, items.map((i) => i * 2), "Ergebnisse in Eingabereihenfolge");
  }
});

test("Concurrency: ungültiger Wert fällt auf den Default, über dem Maximum wird gedeckelt", async () => {
  const backtest = new StubBacktest();
  const result = await runScreening(
    input({ cells: cells(4), concurrency: 999, backtest }),
  );
  assert.equal(result.ok, true);
  assert.equal(backtest.maxInFlight, 1);
});

// ── Telemetrie: bounded Labels ─────────────────────────────────────────────

test("Telemetrie: screening_cells_total{result} mit gebundenen Labels, kein instrument_id", async () => {
  telemetry.screening.reset();
  const backtest = new StubBacktest();
  backtest.outcomeFor = (request) =>
    request.cell.instrumentId.includes("BLOCK")
      ? {
          backtestRunId: null,
          metrics: null,
          counts: { bars: 10, trades: 0, equityPoints: 0 },
          error: "candles:too-few",
        }
      : {
          backtestRunId: null,
          metrics: { sharpeRatio: 1 },
          counts: { bars: 500, trades: 5, equityPoints: 50 },
        };

  const result = await runScreening(
    input({
      cells: [
        ...cells(2, (i) => ({ instrumentId: `BINANCE:BLOCK${i}`, status: "BLOCKED" as CandidateStatus, reasons: ["warmup: 1 < 100"] })),
        ...cells(2),
      ],
      backtest,
    }),
  );

  assert.equal(result.ok, true);
  const snapshot = telemetry.screening.cells.byLabel();
  const labels = JSON.stringify(snapshot);
  // 1) Geschlossenes Vokabular: nur bekannte Tokens.
  for (const key of Object.keys(snapshot)) {
    const result_ = key.split(",").find((p) => p.startsWith("result="))?.slice(7) ?? "";
    assert.ok(
      (SCREENING_CELL_RESULTS as readonly string[]).includes(result_),
      `Label ${key} ist nicht im geschlossenen Vokabular`,
    );
  }
  // 2) Keine Instrument-IDs, Template-IDs, Prioritäten oder UUIDs im Label.
  assert.ok(!labels.includes("instrument_id"), "kein instrument_id-Label");
  assert.ok(!labels.includes("BINANCE:"), "keine Instrument-ID im Label");
  assert.ok(!labels.includes("ema-adx-trend"), "keine Template-ID im Label");
  // 3) Zählung entspricht der Zusammenfassung.
  assert.equal(telemetry.screening.cells.total(), result.cells.length);
});

// ── Fortschritt, Abbruch, Fortsetzung ──────────────────────────────────────

test("Abbruch mitten im Lauf ⇒ ABORTED, cells_done konsistent, mit --run-id fortsetzbar", async () => {
  const store = new FakeStore();
  const backtest = new StubBacktest();
  let seen = 0;
  const abortAfter = 12;
  const shouldAbort = () => seen >= abortAfter;
  backtest.outcomeFor = () => {
    seen += 1;
    return {
      backtestRunId: null,
      metrics: { sharpeRatio: 1 },
      counts: { bars: 500, trades: 5, equityPoints: 50 },
    };
  };

  const aborted = await runScreening(
    input({ cells: cells(30), store, backtest, shouldAbort }),
  );

  assert.equal(aborted.ok, false);
  assert.equal(aborted.aborted, true);
  assert.ok(aborted.cellsDone >= abortAfter, `cells_done ${aborted.cellsDone} ≥ ${abortAfter}`);
  assert.ok(aborted.cellsDone <= 30, "nie mehr als Zellen");
  assert.ok(aborted.cellsDone < 30, "der Lauf ist nicht zu Ende");
  assert.equal(store.runById(aborted.runId!)?.status, "ABORTED");
  assert.equal(store.runById(aborted.runId!)?.cellsDone, aborted.cellsDone);
  assert.match(aborted.errors.join(" "), /abgebrochen/);
  const doneBefore = store.rows.length;

  // Fortsetzung: derselbe Inhalt ⇒ derselbe Lauf; der erledigte Prefix fällt raus.
  const resumed = await runScreening(
    input({ cells: cells(30), store, backtest, resumeRunId: aborted.runId }),
  );

  assert.equal(resumed.runId, aborted.runId, "idempotenter Lauf über den ssr1:-Hash");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.cellsDone, 30);
  assert.equal(resumed.summary.skipped, aborted.cellsDone, "der erledigte Prefix wird übersprungen");
  assert.equal(resumed.summary.backtested, 30 - aborted.cellsDone);
  assert.equal(store.rows.length, doneBefore + (30 - aborted.cellsDone), "keine Zeile doppelt");
  assert.equal(store.runById(resumed.runId!)?.status, "DONE");
});

test("Fortsetzung mit fremder ID bricht ab: ein anderer Inhalt ist ein neuer Lauf", async () => {
  const store = new FakeStore();
  const first = await runScreening(input({ cells: cells(3), store }));
  const otherRunId = randomUUID();
  const resumed = await runScreening(
    input({ cells: cells(4), store, resumeRunId: otherRunId }),
  );

  assert.equal(resumed.ok, false);
  assert.equal(resumed.aborted, true);
  assert.notEqual(resumed.runId, otherRunId);
  assert.match(resumed.errors.join(" "), /gehört nicht zu diesem Inhalt/);
  assert.equal(store.runById(first.runId!)?.status, "DONE", "der erste Lauf bleibt terminal");
});

test("Kein Ergebnis-Overwrite: gleicher Inhalt ⇒ idempotentes Replay (0 neue Zellen)", async () => {
  const store = new FakeStore();
  const first = await runScreening(input({ cells: cells(5), store }));
  const rowsAfterFirst = store.rows.length;
  assert.equal(rowsAfterFirst, 5);

  const replay = await runScreening(input({ cells: cells(5), store }));

  assert.equal(replay.runId, first.runId, "derselbe ssr1:-Hash ⇒ derselbe Lauf");
  assert.equal(store.rows.length, rowsAfterFirst, "keine zweite Zeile");
  assert.equal(replay.summary.skipped, 5);
  assert.equal(replay.ok, true);
});

test("Anderer Inhalt (anderer Cutoff) ⇒ neuer Lauf mit eigenen Zellen", async () => {
  const store = new FakeStore();
  const first = await runScreening(input({ cells: cells(3), store }));
  const second = await runScreening(
    input({ cells: cells(3), store, asOf: "2026-10-02T12:00:00.000Z" }),
  );
  assert.notEqual(first.runId, second.runId);
  assert.equal(store.rows.length, 6, "beide Läufe haben ihre eigenen Zellen");
});

// ── Fortschritts-Schreibzyklus ─────────────────────────────────────────────

test("Fortschritt: cells_done steigt monoton und endet bei cellsTotal", async () => {
  const store = new FakeStore();
  const result = await runScreening(input({ cells: cells(12), store }));

  const doneValues = store.statusCalls
    .filter((c) => c.status === "RUNNING")
    .map((c) => c.cellsDone);
  for (let i = 1; i < doneValues.length; i++) {
    assert.ok(doneValues[i] >= doneValues[i - 1], "monoton — ein Abbruch setzt nichts zurück");
  }
  assert.equal(doneValues.at(-1), 12);
  assert.equal(store.runById(result.runId!)?.cellsDone, 12);
  assert.equal(store.runById(result.runId!)?.status, "DONE");
});

// ── Fehlerpfade ────────────────────────────────────────────────────────────

test("Store ohne Transaktion ⇒ FAILED mit Meldung, Stand bleibt stehen", async () => {
  const store = new FakeStore();
  store.failOnUpsert = true;
  const result = await runScreening(input({ cells: cells(3), store }));

  assert.equal(result.ok, false);
  assert.equal(store.runById(result.runId!)?.status, "FAILED");
  assert.match(result.errors.join(" "), /nicht persistierbar/);
  for (const row of result.cells) assert.equal(row.persisted, false);
});

test("Ungültiger Cutoff bricht vor jedem Store-Zugriff ab", async () => {
  const store = new FakeStore();
  const result = await runScreening(input({ asOf: "kein Zeitpunkt", store }));
  assert.equal(result.ok, false);
  assert.equal(result.runId, null);
  assert.equal(store.createCalls, 0);
});

test("Zell-Ergebnisse sind nach Matrix-Index sortiert (deterministisches Tableau)", async () => {
  const backtest = new StubBacktest();
  backtest.outcomeFor = (request) => ({
    backtestRunId: null,
    metrics: { sharpeRatio: 1 },
    counts: { bars: 500, trades: 5, equityPoints: 50 },
  });
  const result = await runScreening(input({ cells: cells(20), concurrency: 8, backtest }));
  assert.deepEqual(
    result.cells.map((c) => c.index),
    Array.from({ length: 20 }, (_, i) => i),
  );
});

// ── Guard: Cap-Tokens gebunden ─────────────────────────────────────────────

test("Cap-Tokens sind gebunden (kein Freitext in der Zusammenfassung)", () => {
  assert.deepEqual([...SCREENING_CAP_TOKENS], ["min_bars", "trade_cap", "equity_cap"]);
  for (const token of SCREENING_CAP_TOKENS) {
    assert.equal(metricLabel(token, "OTHER"), token);
  }
});

// ── Typ-Sicherheit der Outcomes (Kompilier-Zusicherung) ────────────────────

test("Outcome-Vertrag: jedes Ergebnis trägt Status, Gründe und Persistenz-Flag", async () => {
  const result = await runScreening(input({ cells: cells(4) }));
  const outcomes: readonly ScreeningCellOutcome[] = result.cells;
  assert.equal(outcomes.length, 4);
  for (const outcome of outcomes) {
    assert.equal(typeof outcome.index, "number");
    assert.equal(typeof outcome.status, "string");
    assert.ok(Array.isArray(outcome.reasons));
    assert.equal(typeof outcome.persisted, "boolean");
    assert.ok((SCREENING_CELL_RESULTS as readonly string[]).includes(outcome.result));
  }
});

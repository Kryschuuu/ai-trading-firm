/**
 * Persistente Backtest-Trades als Trade-Level-Wahrheitsquelle — Tests
 * (RMA-P1-04, v1.52.0).
 *
 * Deckung (Definition of Done):
 *   1. Reine Abbildung `BacktestTradeLog` → Zeile: Reihenfolge/`seq`,
 *      Einheiten, Rundung, NULL-Semantik (Funding), Provenienz; negative
 *      Pfade (NaN/Infinity, qty ≤ 0, Exit vor Entry, unbekannte Enums,
 *      verletzte PnL-Identität) werden fail-closed abgewiesen.
 *   2. Abgleich Ledger ↔ Run-Aggregate (Anzahl, Netto-PnL, Gebühren, Funding,
 *      Trade-Hash je Fenster) — konsistente Reports werden RECONCILED,
 *      manipulierte Reports abgelehnt.
 *   3. Idempotency-Key: stabil über `createdAt`, sensitiv gegenüber Inhalt.
 *   4. Cursor/Query-Validatoren (hartes Limit 500, opaker Cursor, Filter).
 *   5. DB (ping → skip, Repo-Konvention): Migration/Constraints, Roundtrip
 *      Run + N Trades geordnet, Fehler bei Trade N rollt den Run zurück,
 *      Retry ⇒ exakt 1 Run + N Trades (sequentiell UND parallel),
 *      Aggregate/Trade-Hash aus DB-Zeilen reproduziert, FK-RESTRICT.
 *   6. Read-API: Detail additiv (`ledger`, `trades`, `links`), Trades-Route
 *      mit Limit/Cursor/Filter, unbekannte Run-ID ⇒ 404, ungültige Query ⇒
 *      400, Alt-Run ⇒ UNAVAILABLE (nie „0 Trades“), Liste lädt keine Trades.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import {
  BACKTEST_TRADES_PAGE_DEFAULT,
  BACKTEST_TRADES_PAGE_MAX,
  BacktestPersistenceError,
  backtestRunIdempotencyKey,
  decodeTradeCursor,
  encodeTradeCursor,
  getBacktestRun,
  hashTrades,
  insertBacktestRun,
  ledgerTotals,
  listBacktestTrades,
  mapReportTrades,
  mapTradeRecordToRow,
  parseTradePageQuery,
  persistBacktestRun,
  reconcileTradeLedger,
  runLedgerView,
  runWalkForward,
  selectRowToTradeRow,
  toBacktestRunInsert,
  TradeLedgerError,
  tradeRowToLog,
  validateIdempotencyKey,
} from "../src/backtest";
import type { BacktestAuditSink, BacktestRunDb, BacktestTradeRow, WalkForwardReport, WalkForwardTradeRecord } from "../src/backtest";
import type { FillSimulatorConfig } from "../src/lib/marketdata/config";
import { ruleSignature, stableStringify, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";
import { db } from "../src/db";
import { backtestRuns, backtestTrades } from "../src/db/schema";

// ── Fixtures (deterministisch; identisch zu tests/backtest.engine.test.ts) ──

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

function waveCloses(count: number, mid = 100, amplitudePct = 0.08, periodBars = 40): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((mid * (1 + amplitudePct * Math.sin((2 * Math.PI * i) / periodBars))).toFixed(4)));
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

function testSimulatorConfig(overrides: Partial<FillSimulatorConfig> = {}): FillSimulatorConfig {
  return {
    makerFeeFallback: 0.0002,
    takerFeeFallback: 0.0006,
    latencyMs: 0,
    slippageBpsBase: 1,
    slippageBpsPerParticipation: 0,
    slippageJitterBps: 0,
    partialFillEnabled: false,
    partialFillMaxFraction: 1,
    seed: 42,
    volume24hFallback: 10_000_000,
    syntheticSpreadBps: 4,
    ...overrides,
  };
}

const SYMBOL = "WFLEDGER";

function sampleReport(nowMs = T0, bars = 750, threshold = 100): WalkForwardReport {
  const spec = priceRule(SYMBOL, threshold);
  return runWalkForward({
    instrumentId: SYMBOL,
    timeframe: "1h",
    candles: candlesFromCloses(T0, waveCloses(bars)),
    strategies: [{ type: "rule", spec, id: "R" }],
    ruleRef: { ruleId: null, ruleKey: null, name: "Ledger-Test", signature: ruleSignature(spec), ruleSymbol: SYMBOL },
    engineConfig: {
      initialCapital: 10_000,
      warmupBars: 30,
      executionModel: "paper",
      paper: { simulator: testSimulatorConfig() },
    },
    walkforward: { isDays: 14, oosDays: 7 },
    nowMs,
  });
}

/** Tiefe Kopie (Report ist reines JSON) für Manipulationstests. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function ledgerReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM backtest_trades LIMIT 1`);
    await db.execute(sql`SELECT idempotency_key, trade_count, reconciliation_status FROM backtest_runs LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function cleanupRun(runId: string): Promise<void> {
  await db.delete(backtestTrades).where(eq(backtestTrades.runId, runId));
  await db.delete(backtestRuns).where(eq(backtestRuns.id, runId));
}

async function cleanupKey(key: string): Promise<void> {
  const runs = await db.select({ id: backtestRuns.id }).from(backtestRuns).where(eq(backtestRuns.idempotencyKey, key));
  for (const r of runs) await cleanupRun(r.id);
}

const SKIP_MSG = "Keine PostgreSQL mit backtest_trades erreichbar — DB-Test übersprungen (Repo-Konvention: ping → skip)";
const noopAudit = async () => {};

// ── 1) REINE ABBILDUNG ──────────────────────────────────────────────────────

describe("Trade-Ledger: reine Abbildung Report → Zeilen", () => {
  const report = sampleReport();
  const runId = randomUUID();

  it("Fixture liefert Trades in beiden Segmenten und mehreren Fenstern", () => {
    assert.ok(report.trades.length >= 10, `zu wenige Trades für aussagekräftige Tests: ${report.trades.length}`);
    assert.ok(report.trades.some((t) => t.segment === "IS"));
    assert.ok(report.trades.some((t) => t.segment === "OOS"));
    assert.ok(new Set(report.trades.map((t) => t.windowIndex)).size >= 2);
    // Additive Report-Felder (v1.52.0): netPnl + slippage je Segment/Aggregat.
    assert.equal(typeof report.aggregateOos.netPnl, "number");
    assert.equal(typeof report.aggregateIs.slippage, "number");
    for (const w of report.windows) {
      assert.equal(typeof w.oos.netPnl, "number");
      assert.equal(typeof w.is.netPnl, "number");
    }
  });

  it("seq ist lückenlos 1..N in Report-Reihenfolge (Fenster ↑, IS vor OOS)", () => {
    const rows = mapReportTrades(report, runId);
    assert.equal(rows.length, report.trades.length);
    rows.forEach((row, i) => {
      assert.equal(row.seq, i + 1);
      assert.equal(row.runId, runId);
      assert.equal(row.windowIndex, report.trades[i].windowIndex);
      assert.equal(row.segment, report.trades[i].segment);
      assert.equal(row.tradeRef, report.trades[i].trade.id);
      if (i > 0) {
        const prev = rows[i - 1];
        const orderKey = (r: BacktestTradeRow) => r.windowIndex * 2 + (r.segment === "IS" ? 0 : 1);
        assert.ok(orderKey(prev) <= orderKey(row), "Fensterreihenfolge verletzt");
      }
    });
  });

  it("Einheiten, Rundung und NULL-Semantik sind dokumentiert und eingehalten", () => {
    const rows = mapReportTrades(report, runId);
    for (const [i, row] of rows.entries()) {
      const src = report.trades[i].trade;
      // Dezimal-Strings ohne Exponent/NaN — genau das, was numeric-Spalten erwarten.
      for (const field of ["qty", "notional", "entryPrice", "exitPrice", "pnlGross", "pnlNet", "pnlPct", "fees", "slippage"] as const) {
        assert.match(row[field], /^-?\d+(\.\d+)?$/, `${field} ist kein Dezimal-String: ${row[field]}`);
      }
      assert.equal(Number(row.pnlNet), src.pnl);
      assert.equal(Number(row.fees), src.fees);
      assert.equal(Number(row.slippage), src.slippage);
      assert.equal(Number(row.qty), src.qty);
      assert.equal(row.entryTs.getTime(), src.entryTime);
      assert.equal(row.exitTs.getTime(), src.exitTime);
      assert.equal(row.durationBars, src.durationBars);
      // Brutto-PnL = qty · Δpreis (8 Stellen), Netto = Brutto − Gebühren + Funding (Identität).
      const gross = Number(row.pnlGross);
      const identity = gross - Number(row.fees) + Number(row.funding ?? 0);
      assert.ok(Math.abs(identity - Number(row.pnlNet)) <= 0.0002, `PnL-Identität verletzt bei seq ${row.seq}`);
      // Funding: Engine liefert immer eine Zahl ⇒ nie NULL im Paper-Pfad.
      assert.equal(typeof row.funding, "string");
      assert.equal(row.provenanceJson.v, 1);
      assert.equal(row.provenanceJson.source, "walk-forward");
      assert.equal(row.provenanceJson.engineTradeId, src.id);
      assert.equal(row.provenanceJson.ruleSignature, report.ruleRef.signature);
      assert.equal(row.provenanceJson.executionModel, "paper");
      assert.equal(row.provenanceJson.simulatorSeed, 42);
      const w = report.windows[row.windowIndex];
      const seg = row.segment === "IS" ? w.is : w.oos;
      assert.equal(row.provenanceJson.windowFrom, seg.from);
      assert.equal(row.provenanceJson.windowTo, seg.to);
    }
  });

  it("Zeile → Trade-Log ist verlustfrei (Roundtrip stellt das Engine-Log wieder her)", () => {
    const rows = mapReportTrades(report, runId);
    rows.forEach((row, i) => {
      assert.deepEqual(tradeRowToLog(row), report.trades[i].trade);
    });
  });

  it("Funding undefined ⇒ NULL (nicht 0); Funding 0 ⇒ '0'", () => {
    const base = report.trades[0];
    const ctx = { runId, seq: 1, windowFrom: 0, windowTo: 1, ruleSignature: "sig", executionModel: "paper", simulatorSeed: 1 };
    const withoutFunding: WalkForwardTradeRecord = {
      ...base,
      trade: { ...base.trade, funding: undefined, pnl: Number((base.trade.pnl - (base.trade.funding ?? 0)).toFixed(4)) },
    };
    assert.equal(mapTradeRecordToRow(withoutFunding, ctx).funding, null);
    const zeroFunding: WalkForwardTradeRecord = {
      ...base,
      trade: { ...base.trade, funding: 0, pnl: Number((base.trade.pnl - (base.trade.funding ?? 0)).toFixed(4)) },
    };
    assert.equal(mapTradeRecordToRow(zeroFunding, ctx).funding, "0");
  });

  it("negative Pfade: NaN/Infinity, qty ≤ 0, Preis ≤ 0, Exit vor Entry, Enums, PnL-Identität ⇒ ledger:invalid-trade", () => {
    const base = report.trades[0];
    const ctx = { runId, seq: 7, windowFrom: 0, windowTo: 1, ruleSignature: "sig", executionModel: "paper", simulatorSeed: 1 };
    const mutate = (patch: Partial<WalkForwardTradeRecord["trade"]>, segment: WalkForwardTradeRecord["segment"] = base.segment) =>
      mapTradeRecordToRow({ ...base, segment, trade: { ...base.trade, ...patch } }, ctx);
    const rejects = (fn: () => unknown, pattern: RegExp) => {
      assert.throws(fn, (e: unknown) => {
        assert.ok(e instanceof TradeLedgerError, `erwartet TradeLedgerError, erhalten ${String(e)}`);
        assert.equal(e.code, "ledger:invalid-trade");
        assert.match(e.message, pattern);
        assert.match(e.message, /#7/);
        return true;
      });
    };
    rejects(() => mutate({ pnl: Number.NaN }), /pnl/);
    rejects(() => mutate({ fees: Number.POSITIVE_INFINITY }), /fees/);
    rejects(() => mutate({ qty: 0 }), /qty/);
    rejects(() => mutate({ qty: -1 }), /qty/);
    rejects(() => mutate({ entryPrice: 0 }), /Preis/);
    rejects(() => mutate({ fees: -0.01 }), /fees/);
    rejects(() => mutate({ slippage: -0.01 }), /slippage/);
    rejects(() => mutate({ exitTime: base.trade.entryTime - 1, durationMs: -1 }), /exitTime|Zeitstempel/);
    rejects(() => mutate({ entryTime: 1.5 }), /Zeitstempel/);
    rejects(() => mutate({ durationBars: 0 }), /durationBars/);
    rejects(() => mutate({ durationMs: base.trade.durationMs + 1 }), /durationMs/);
    rejects(() => mutate({ side: "FLAT" as unknown as "LONG" }), /Seite/);
    rejects(() => mutate({ exitReason: "MOON" as unknown as "STOP_LOSS" }), /Exit-Grund/);
    rejects(() => mutate({}, "WARMUP" as unknown as "IS"), /Segment/);
    rejects(() => mutate({ pnl: base.trade.pnl + 1 }), /PnL-Identität/);
    rejects(() => mutate({ symbol: "" }), /symbol/);
    // Im Report-Kontext: doppelte Trade-ID im selben Fenster/Segment bzw. Reihenfolgebruch ⇒ ledger:invalid-report.
    const dup = clone(report);
    dup.trades.push({ ...dup.trades[dup.trades.length - 1] });
    assert.throws(() => mapReportTrades(dup, runId), (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:invalid-report" && /doppelte/.test(e.message));
    const unordered = clone(report);
    unordered.trades.reverse();
    assert.throws(() => mapReportTrades(unordered, runId), (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:invalid-report");
  });
});

// ── 2) ABGLEICH LEDGER ↔ AGGREGATE ──────────────────────────────────────────

describe("Trade-Ledger: Abgleich mit Run-Aggregaten", () => {
  const report = sampleReport();
  const runId = randomUUID();
  const rows = mapReportTrades(report, runId);

  it("konsistenter Report ⇒ RECONCILED mit vollständiger Evidenz (alle Checks ok)", () => {
    const rec = reconcileTradeLedger(report, rows);
    assert.equal(rec.status, "RECONCILED");
    assert.equal(rec.tradeCount, rows.length);
    assert.ok(rec.checks.length > 0);
    assert.ok(rec.checks.every((c) => c.ok), JSON.stringify(rec.checks.filter((c) => !c.ok)));
    assert.equal(rec.windows.length, report.windows.length * 2);
    // Segment-Summen entsprechen den Report-Aggregaten (Anzahl exakt, Geld innerhalb Rundung).
    assert.equal(rec.segments.OOS.trades, report.aggregateOos.trades);
    assert.equal(rec.segments.IS.trades, report.aggregateIs.trades);
    assert.equal(rec.segments.OOS.wins, report.aggregateOos.wins);
    assert.ok(Math.abs(rec.segments.OOS.netPnl - report.aggregateOos.netPnl) < 1e-6);
    assert.ok(Math.abs(rec.segments.OOS.fees - report.aggregateOos.fees) <= 0.005 * (report.windows.length + 1) + 1e-6);
    // Equity-PnL ≠ Ledger-PnL ist erlaubt (END_OF_DATA-Schließkosten) — aber ausgewiesen.
    assert.equal(typeof rec.equityLedgerGap.OOS, "number");
  });

  it("Trade-Hash je Fenster/Segment aus den Zeilen == Report-Hash (hashTrades über tradeRowToLog)", () => {
    const rec = reconcileTradeLedger(report, rows);
    for (const w of report.windows) {
      for (const segment of ["IS", "OOS"] as const) {
        const logs = rows.filter((r) => r.windowIndex === w.index && r.segment === segment).map(tradeRowToLog);
        const expected = segment === "IS" ? w.is.tradeHash : w.oos.tradeHash;
        assert.equal(hashTrades(logs), expected, `Hash-Abweichung Fenster ${w.index} ${segment}`);
        const ev = rec.windows.find((x) => x.index === w.index && x.segment === segment);
        assert.equal(ev?.tradeHash, expected);
        assert.equal(ev?.trades, logs.length);
      }
    }
  });

  it("manipulierte Aggregate (Anzahl, Netto-PnL, Gebühren, Funding) ⇒ ledger:reconciliation-mismatch", () => {
    const expectMismatch = (mutated: WalkForwardReport, pattern: RegExp) => {
      assert.throws(() => reconcileTradeLedger(mutated, rows), (e: unknown) => {
        assert.ok(e instanceof TradeLedgerError, String(e));
        assert.equal(e.code, "ledger:reconciliation-mismatch");
        assert.match(e.message, pattern);
        return true;
      });
    };
    const wIdx = report.windows.findIndex((w) => w.oos.trades > 0);
    assert.ok(wIdx >= 0);
    const count = clone(report);
    count.windows[wIdx].oos.trades += 1;
    expectMismatch(count, /trades/);
    const pnl = clone(report);
    pnl.windows[wIdx].oos.netPnl = Number((pnl.windows[wIdx].oos.netPnl + 0.01).toFixed(4));
    expectMismatch(pnl, /netPnl/);
    const fees = clone(report);
    fees.windows[wIdx].oos.fees = Number((fees.windows[wIdx].oos.fees + 1).toFixed(2));
    expectMismatch(fees, /fees/);
    const funding = clone(report);
    funding.windows[wIdx].oos.funding = Number((funding.windows[wIdx].oos.funding + 0.001).toFixed(8));
    expectMismatch(funding, /funding/);
    const hash = clone(report);
    hash.windows[wIdx].oos.tradeHash = createHash("sha256").update("anders").digest("hex");
    expectMismatch(hash, /tradeHash/);
    const agg = clone(report);
    agg.aggregateOos.trades += 1;
    expectMismatch(agg, /aggregate/i);
  });

  it("manipulierte Zeilen (fehlende / zusätzliche / veränderte Zeile) ⇒ ledger:reconciliation-mismatch", () => {
    const mismatch = (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:reconciliation-mismatch";
    assert.throws(() => reconcileTradeLedger(report, rows.slice(0, -1)), mismatch);
    assert.throws(() => reconcileTradeLedger(report, [...rows, { ...rows[rows.length - 1], seq: rows.length + 1, tradeRef: "POS-999" }]), mismatch);
    const changed = rows.map((r, i) => (i === 0 ? { ...r, pnlNet: String(Number(r.pnlNet) + 0.5) } : r));
    assert.throws(() => reconcileTradeLedger(report, changed), mismatch);
    // Auch eine Änderung, die Summen unberührt lässt (Exit-Grund), fällt über den Trade-Hash auf.
    const reasonOnly = rows.map((r, i) => (i === 0 ? { ...r, exitReason: r.exitReason === "STOP_LOSS" ? ("SIGNAL_EXIT" as const) : ("STOP_LOSS" as const) } : r));
    assert.throws(() => reconcileTradeLedger(report, reasonOnly), (e: unknown) => mismatch(e) && /tradeHash/.test((e as Error).message));
  });

  it("ledgerTotals: leere Liste ⇒ Nullen, funding null wenn keine Zeile Funding ausweist", () => {
    const empty = ledgerTotals([]);
    assert.equal(empty.trades, 0);
    assert.equal(empty.netPnl, 0);
    assert.equal(empty.fees, 0);
    assert.equal(empty.funding, null);
    const noFunding = ledgerTotals(rows.map((r) => ({ ...r, funding: null })));
    assert.equal(noFunding.funding, null);
    assert.equal(noFunding.trades, rows.length);
  });
});

// ── 3) IDEMPOTENCY-KEY ──────────────────────────────────────────────────────

describe("Trade-Ledger: Idempotency-Key", () => {
  it("stabil über createdAt, sensitiv gegenüber Inhalt, validiertes Format", () => {
    const a = sampleReport(T0);
    const b = sampleReport(T0 + 86_400_000);
    assert.notEqual(a.createdAt, b.createdAt);
    const keyA = backtestRunIdempotencyKey(a);
    assert.equal(keyA, backtestRunIdempotencyKey(b), "createdAt darf den Key nicht ändern");
    assert.match(keyA, /^wf1:[0-9a-f]{64}$/);
    assert.equal(validateIdempotencyKey(keyA), keyA);

    const other = sampleReport(T0, 800);
    assert.notEqual(backtestRunIdempotencyKey(other), keyA, "anderer Zeitraum ⇒ anderer Key");
    const hashChanged = clone(a);
    hashChanged.windows[0].oos.tradeHash = createHash("sha256").update("x").digest("hex");
    assert.notEqual(backtestRunIdempotencyKey(hashChanged), keyA, "anderer Trade-Hash ⇒ anderer Key");

    for (const bad of ["", "kurz", "a".repeat(129), "hat leerzeichen!", 42, null]) {
      assert.throws(() => validateIdempotencyKey(bad), (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:invalid-idempotency-key");
    }
    assert.equal(validateIdempotencyKey("manual:lauf-2026.09.20_a"), "manual:lauf-2026.09.20_a");
  });
});

// ── 4) CURSOR + QUERY ───────────────────────────────────────────────────────

describe("Trade-Ledger: Cursor + Query-Validatoren", () => {
  it("Cursor ist opak, versioniert und roundtrip-stabil; Müll wird abgewiesen", () => {
    for (const seq of [0, 1, 99, 2_147_483_647]) {
      const c = encodeTradeCursor(seq);
      assert.match(c, /^[A-Za-z0-9_-]+$/);
      assert.deepEqual(decodeTradeCursor(c), { ok: true, afterSeq: seq });
    }
    assert.throws(() => encodeTradeCursor(-1), RangeError);
    assert.throws(() => encodeTradeCursor(1.5), RangeError);
    for (const bad of ["", "***", Buffer.from("t0:5").toString("base64url"), Buffer.from("t1:-5").toString("base64url"), Buffer.from("t1:99999999999").toString("base64url"), "x".repeat(65)]) {
      const r = decodeTradeCursor(bad);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /^INVALID_TRADE_CURSOR/);
    }
  });

  it("Defaults, hartes Limit und geschlossene Filtermengen", () => {
    const q = parseTradePageQuery(new URLSearchParams());
    assert.ok(q.ok);
    if (q.ok) {
      assert.equal(q.query.limit, BACKTEST_TRADES_PAGE_DEFAULT);
      assert.equal(q.query.afterSeq, 0);
      assert.equal(q.query.segment, undefined);
    }
    const max = parseTradePageQuery(new URLSearchParams({ limit: String(BACKTEST_TRADES_PAGE_MAX) }));
    assert.ok(max.ok && max.query.limit === BACKTEST_TRADES_PAGE_MAX);
    for (const bad of ["0", String(BACKTEST_TRADES_PAGE_MAX + 1), "abc", "-1", "1e3", "10000"]) {
      const r = parseTradePageQuery(new URLSearchParams({ limit: bad }));
      assert.equal(r.ok, false, `limit=${bad} muss abgewiesen werden`);
      if (!r.ok) assert.match(r.error, /^INVALID_TRADE_LIMIT/);
    }
    const full = parseTradePageQuery(
      new URLSearchParams({ limit: "5", cursor: encodeTradeCursor(12), segment: "oos", window: "3", symbol: "bitunix:btcusdt", side: "long", exitReason: "STOP_LOSS" })
    );
    assert.ok(full.ok);
    if (full.ok) {
      assert.deepEqual(full.query, { limit: 5, afterSeq: 12, segment: "OOS", windowIndex: 3, symbol: "BITUNIX:BTCUSDT", side: "LONG", exitReason: "STOP_LOSS" });
    }
    for (const [key, value] of [
      ["segment", "WARMUP"],
      ["window", "-1"],
      ["window", "1.5"],
      ["symbol", "x".repeat(65)],
      ["symbol", "BTC USDT"],
      ["side", "FLAT"],
      ["exitReason", "MOON"],
      ["cursor", "***"],
    ] as const) {
      const r = parseTradePageQuery(new URLSearchParams({ [key]: value }));
      assert.equal(r.ok, false, `${key}=${value} muss abgewiesen werden`);
      if (!r.ok) assert.match(r.error, /^INVALID_TRADE_(FILTER|CURSOR)/);
    }
  });
});

// ── 5) DATENBANK (ping → skip) ──────────────────────────────────────────────

describe("Trade-Ledger: Persistenz (DB-gegated)", () => {
  it("Migration/Constraints: Checks, UNIQUE (run_id, seq) und FK greifen in der DB", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = sampleReport();
    const runId = randomUUID();
    const key = `test:constraints:${runId}`;
    try {
      const res = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { audit: noopAudit });
      assert.equal(res.created, true);
      const rows = mapReportTrades(report, runId);
      const first = rows[0];
      const insertRaw = async (patch: Partial<typeof backtestTrades.$inferInsert>) =>
        db.insert(backtestTrades).values({
          runId,
          seq: rows.length + 1,
          windowIndex: first.windowIndex,
          segment: first.segment,
          tradeRef: "POS-CONSTRAINT",
          strategyId: first.strategyId,
          symbol: first.symbol,
          side: first.side,
          qty: first.qty,
          notional: first.notional,
          entryTs: first.entryTs,
          exitTs: first.exitTs,
          entryPrice: first.entryPrice,
          exitPrice: first.exitPrice,
          pnlGross: first.pnlGross,
          pnlNet: first.pnlNet,
          pnlPct: first.pnlPct,
          fees: first.fees,
          funding: first.funding,
          slippage: first.slippage,
          exitReason: first.exitReason,
          durationBars: first.durationBars,
          provenanceJson: first.provenanceJson,
          ...patch,
        });
      const expectSqlState = async (patch: Partial<typeof backtestTrades.$inferInsert>, state: string, label: string) => {
        await assert.rejects(insertRaw(patch), (e: unknown) => {
          const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
          assert.equal(code, state, `${label}: erwartet SQLSTATE ${state}, erhalten ${String(code)} (${String(e).split("\n")[0]})`);
          return true;
        });
      };
      await expectSqlState({ seq: 1 }, "23505", "doppelte Sequenz");
      await expectSqlState({ tradeRef: first.tradeRef }, "23505", "doppelte Trade-Referenz je Fenster/Segment");
      await expectSqlState({ seq: 0 }, "23514", "seq ≥ 1");
      await expectSqlState({ qty: "0" }, "23514", "qty > 0");
      await expectSqlState({ fees: "-1" }, "23514", "fees ≥ 0");
      await expectSqlState({ exitTs: new Date(first.entryTs.getTime() - 1) }, "23514", "exit ≥ entry");
      await expectSqlState({ segment: "WARMUP" as "IS" }, "23514", "segment-Enum");
      await expectSqlState({ side: "FLAT" as "LONG" }, "23514", "side-Enum");
      await expectSqlState({ exitReason: "MOON" as "STOP_LOSS" }, "23514", "exit_reason-Enum");
      await expectSqlState({ runId: randomUUID() }, "23503", "FK auf backtest_runs");
      // FK ohne CASCADE (Repo-Konvention): Run mit Ledger kann nicht „unter“ den Trades gelöscht werden.
      await assert.rejects(db.delete(backtestRuns).where(eq(backtestRuns.id, runId)), (e: unknown) => {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
        assert.equal(code, "23503");
        return true;
      });
      // Run-Checks: reconciliation_status nur RECONCILED, trade_count ≥ 0.
      await assert.rejects(
        db.update(backtestRuns).set({ reconciliationStatus: "PENDING" as "RECONCILED" }).where(eq(backtestRuns.id, runId)),
        (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "23514"
      );
      // Idempotency-Key ist partiell UNIQUE (NULL bleibt mehrfach erlaubt).
      const legacyA = randomUUID();
      const legacyB = randomUUID();
      try {
        await insertBacktestRun(toBacktestRunInsert(report, priceRule(SYMBOL, 100), legacyA));
        await insertBacktestRun(toBacktestRunInsert(report, priceRule(SYMBOL, 100), legacyB));
        const legacy = await db.select({ key: backtestRuns.idempotencyKey, count: backtestRuns.tradeCount, status: backtestRuns.reconciliationStatus }).from(backtestRuns).where(eq(backtestRuns.id, legacyA));
        assert.deepEqual(legacy[0], { key: null, count: null, status: null });
        await assert.rejects(
          db.update(backtestRuns).set({ idempotencyKey: key }).where(eq(backtestRuns.id, legacyA)),
          (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "23505"
        );
      } finally {
        await cleanupRun(legacyA);
        await cleanupRun(legacyB);
      }
    } finally {
      await cleanupRun(runId);
    }
  });

  it("Roundtrip: Run + N Trades atomar geschrieben, geordnet gelesen, Aggregate + Hash aus DB-Zeilen reproduziert", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = sampleReport();
    const runId = randomUUID();
    const key = `test:roundtrip:${runId}`;
    const auditEvents: Array<{ event: string; level: string; detail: Record<string, unknown> }> = [];
    const audit: BacktestAuditSink = async (event, level, detail) => {
      auditEvents.push({ event, level, detail: (detail ?? {}) as Record<string, unknown> });
    };
    try {
      const res = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { audit, chunkSize: 3 });
      assert.equal(res.created, true);
      assert.equal(res.id, runId);
      assert.equal(res.tradeCount, report.trades.length);
      assert.equal(res.reconciliation.status, "RECONCILED");
      assert.deepEqual(auditEvents.map((e) => e.event), ["BACKTEST_RUN_PERSISTED"]);
      assert.equal(auditEvents[0].detail.tradeCount, report.trades.length);
      assert.equal(auditEvents[0].detail.created, true);

      const run = await getBacktestRun(runId);
      assert.ok(run);
      assert.equal(run.idempotencyKey, key);
      assert.equal(run.tradeCount, report.trades.length);
      assert.equal(run.reconciliationStatus, "RECONCILED");
      assert.equal(runLedgerView(run).status, "RECONCILED");
      // Bestehende Spalten unverändert (Rückwärtskompatibilität der Run-Zeile).
      const legacyShape = toBacktestRunInsert(report, priceRule(SYMBOL, 100), runId);
      assert.deepEqual(run.metricsJson, JSON.parse(JSON.stringify(legacyShape.metricsJson)));
      assert.deepEqual(run.windowsJson, JSON.parse(JSON.stringify(legacyShape.windowsJson)));

      // Alle Zeilen in DB-Reihenfolge lesen (über die Page-API mit kleinem Limit ⇒ Cursor-Kette).
      const all: Awaited<ReturnType<typeof listBacktestTrades>>["items"] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q = parseTradePageQuery({ limit: "4", cursor });
        assert.ok(q.ok);
        if (!q.ok) break;
        const page = await listBacktestTrades(runId, q.query);
        assert.ok(page.items.length <= 4);
        all.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor !== null);
      assert.equal(all.length, report.trades.length);
      assert.equal(pages, Math.ceil(report.trades.length / 4));
      assert.deepEqual(all.map((x) => x.seq), report.trades.map((_, i) => i + 1));
      // Jede Zeile entspricht dem Engine-Log (Werte, Zeiten, Provenienz).
      all.forEach((view, i) => {
        const src = report.trades[i];
        assert.equal(view.windowIndex, src.windowIndex);
        assert.equal(view.segment, src.segment);
        assert.equal(view.tradeRef, src.trade.id);
        assert.equal(view.pnlNet, src.trade.pnl);
        assert.equal(view.fees, src.trade.fees);
        assert.equal(view.funding, src.trade.funding ?? null);
        assert.equal(view.slippage, src.trade.slippage);
        assert.equal(Date.parse(view.entryTs), src.trade.entryTime);
        assert.equal(Date.parse(view.exitTs), src.trade.exitTime);
        assert.equal(view.durationMs, src.trade.durationMs);
        assert.equal(view.provenance.engineTradeId, src.trade.id);
      });

      // Wahrheitsquelle DB: Rohzeilen → Trade-Logs → Hash/Summen == Run-Metriken.
      const stored = await db.select().from(backtestTrades).where(eq(backtestTrades.runId, runId)).orderBy(backtestTrades.seq);
      const storedRows = stored.map(selectRowToTradeRow);
      const fromDb = reconcileTradeLedger(report, storedRows);
      assert.deepEqual(fromDb, run.reconciliationJson, "Evidenz aus DB-Zeilen muss der gespeicherten Evidenz gleichen");
      for (const w of report.windows) {
        const oosLogs = storedRows.filter((r) => r.windowIndex === w.index && r.segment === "OOS").map(tradeRowToLog);
        assert.equal(hashTrades(oosLogs), w.oos.tradeHash);
        assert.equal(oosLogs.length, w.oos.trades);
        assert.ok(Math.abs(oosLogs.reduce((s, x) => s + x.pnl, 0) - w.oos.netPnl) < 1e-6);
      }
      const totals = ledgerTotals(storedRows.filter((r) => r.segment === "OOS"));
      assert.equal(totals.trades, report.aggregateOos.trades);
      assert.ok(Math.abs(totals.netPnl - report.aggregateOos.netPnl) < 1e-6);

      // Filter arbeiten auf der DB (Segment, Fenster, Symbol, Seite).
      const oosOnly = await listBacktestTrades(runId, { limit: 500, afterSeq: 0, segment: "OOS" });
      assert.equal(oosOnly.items.length, report.aggregateOos.trades);
      assert.ok(oosOnly.items.every((x) => x.segment === "OOS"));
      const w0 = await listBacktestTrades(runId, { limit: 500, afterSeq: 0, windowIndex: 0, segment: "IS" });
      assert.equal(w0.items.length, report.windows[0].is.trades);
      const noSymbol = await listBacktestTrades(runId, { limit: 500, afterSeq: 0, symbol: "NICHTDA" });
      assert.deepEqual(noSymbol.items, []);
      assert.equal(noSymbol.nextCursor, null);
      const shorts = await listBacktestTrades(runId, { limit: 500, afterSeq: 0, side: "SHORT" });
      assert.deepEqual(shorts.items, []);
    } finally {
      await cleanupRun(runId);
    }
  });

  it("Fehler bei Trade N (DB-Constraint bzw. Exception) rollt Run UND Trades zurück — keine Teilwahrheit", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = sampleReport();
    const failAt = Math.min(5, report.trades.length);
    assert.ok(failAt >= 2);

    /** Wrapper um die echte DB: manipuliert den N-ten Trade-Insert innerhalb der Transaktion. */
    const faultyDb = (mode: "constraint" | "throw"): BacktestRunDb => ({
      select: db.select.bind(db),
      transaction: ((fn: (tx: unknown) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          let tradeInserts = 0;
          const proxied = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop !== "insert") return Reflect.get(target, prop, receiver);
              return (table: unknown) => {
                if (table !== backtestTrades) return target.insert(table as typeof backtestRuns);
                tradeInserts++;
                if (tradeInserts !== failAt) return target.insert(backtestTrades);
                if (mode === "throw") throw new Error(`simulierter Ausfall bei Trade ${failAt}`);
                return {
                  values: (vals: Array<typeof backtestTrades.$inferInsert>) =>
                    target.insert(backtestTrades).values(vals.map((v) => ({ ...v, qty: "0" }))),
                };
              };
            },
          });
          return fn(proxied);
        })) as BacktestRunDb["transaction"],
    });

    for (const mode of ["constraint", "throw"] as const) {
      const runId = randomUUID();
      const key = `test:rollback:${mode}:${runId}`;
      const events: string[] = [];
      const audit: BacktestAuditSink = async (event) => {
        events.push(event);
      };
      try {
        await assert.rejects(
          persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { db: faultyDb(mode), audit, chunkSize: 1 }),
          (e: unknown) => {
            assert.ok(e instanceof BacktestPersistenceError, `${mode}: erwartet BacktestPersistenceError, erhalten ${String(e)}`);
            assert.equal(e.code, "persist:db-error");
            if (mode === "constraint") assert.match(e.message, /23514/);
            return true;
          }
        );
        assert.deepEqual(events, ["BACKTEST_RUN_PERSIST_FAILED"]);
        assert.equal(await getBacktestRun(runId), null, `${mode}: Run darf nach Rollback nicht existieren`);
        const orphanTrades = await db.select({ n: sql<number>`count(*)::int` }).from(backtestTrades).where(eq(backtestTrades.runId, runId));
        assert.equal(orphanTrades[0].n, 0, `${mode}: keine Trade-Zeile darf überleben`);
        const byKey = await db.select({ id: backtestRuns.id }).from(backtestRuns).where(eq(backtestRuns.idempotencyKey, key));
        assert.equal(byKey.length, 0);
        // Nach Behebung: derselbe Key + dieselbe Run-ID gehen sauber durch (kein Geister-Zustand).
        const ok = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { audit });
        assert.equal(ok.created, true);
        assert.equal(ok.tradeCount, report.trades.length);
      } finally {
        await cleanupRun(runId);
      }
    }
  });

  it("Read-back-Abgleich fail-closed: manipulierter Report mit gültigen Zeilen wird vor dem Commit abgelehnt", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = clone(sampleReport());
    const wIdx = report.windows.findIndex((w) => w.oos.trades > 0);
    report.windows[wIdx].oos.netPnl = Number((report.windows[wIdx].oos.netPnl + 0.01).toFixed(4));
    const runId = randomUUID();
    const key = `test:mismatch:${runId}`;
    const events: Array<{ event: string; code: unknown }> = [];
    const audit: BacktestAuditSink = async (event, _level, detail) => {
      events.push({ event, code: (detail as { code?: unknown } | undefined)?.code });
    };
    try {
      await assert.rejects(
        persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { audit }),
        (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:reconciliation-mismatch"
      );
      assert.deepEqual(events, [{ event: "BACKTEST_RUN_PERSIST_FAILED", code: "ledger:reconciliation-mismatch" }]);
      assert.equal(await getBacktestRun(runId), null);
    } finally {
      await cleanupRun(runId);
    }
  });

  it("Idempotenz: Retry (sequentiell) ⇒ exakt 1 Run + N Trades, created=false, gleiche ID; abweichender Inhalt ⇒ Konflikt", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = sampleReport();
    const key = backtestRunIdempotencyKey(report);
    await cleanupKey(key);
    const firstId = randomUUID();
    try {
      const first = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId: firstId }, { audit: noopAudit });
      assert.equal(first.created, true);
      assert.equal(first.idempotencyKey, key);
      // Retry mit NEUER Kandidaten-UUID (so arbeitet die CLI) ⇒ bestehender Run gewinnt.
      const retry = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId: randomUUID() }, { audit: noopAudit });
      assert.equal(retry.created, false);
      assert.equal(retry.id, firstId);
      assert.equal(retry.tradeCount, report.trades.length);
      assert.deepEqual(retry.reconciliation, first.reconciliation);
      // Retry mit derselben UUID ebenfalls ok.
      const retrySameId = await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId: firstId }, { audit: noopAudit });
      assert.equal(retrySameId.created, false);

      const runs = await db.select({ id: backtestRuns.id }).from(backtestRuns).where(eq(backtestRuns.idempotencyKey, key));
      assert.equal(runs.length, 1);
      const trades = await db.select({ n: sql<number>`count(*)::int` }).from(backtestTrades).where(eq(backtestTrades.runId, firstId));
      assert.equal(trades[0].n, report.trades.length);

      // Gleicher Key, anderer Inhalt (andere Regel-Schwelle ⇒ andere Trades/Hashes) ⇒ kein stilles Replay.
      const other = sampleReport(T0, 750, 103);
      assert.notDeepEqual(other.windows.map((w) => w.oos.tradeHash), report.windows.map((w) => w.oos.tradeHash));
      await assert.rejects(
        persistBacktestRun({ report: other, spec: priceRule(SYMBOL, 103), runId: randomUUID(), idempotencyKey: key }, { audit: noopAudit }),
        (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:idempotency-conflict"
      );
      // Gleicher Key + gleiche Trade-Anzahl, aber anderer Hash (manipulierte Evidenz) ⇒ ebenfalls Konflikt.
      const tampered = clone(report);
      const wIdx = tampered.windows.findIndex((w) => w.oos.trades > 0);
      tampered.trades = tampered.trades.map((t) =>
        t.windowIndex === tampered.windows[wIdx].index && t.segment === "OOS"
          ? { ...t, trade: { ...t.trade, exitReason: t.trade.exitReason === "STOP_LOSS" ? ("SIGNAL_EXIT" as const) : ("STOP_LOSS" as const) } }
          : t
      );
      tampered.windows[wIdx].oos.tradeHash = hashTrades(
        tampered.trades.filter((t) => t.windowIndex === tampered.windows[wIdx].index && t.segment === "OOS").map((t) => t.trade)
      );
      await assert.rejects(
        persistBacktestRun({ report: tampered, spec: priceRule(SYMBOL, 100), runId: randomUUID(), idempotencyKey: key }, { audit: noopAudit }),
        (e: unknown) => e instanceof TradeLedgerError && e.code === "ledger:idempotency-conflict" && /Trade-Hashes/.test(e.message)
      );
      // Run-ID bereits von einem ANDEREN Key belegt ⇒ Konflikt statt Überschreiben.
      await assert.rejects(
        persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId: firstId, idempotencyKey: `test:other:${firstId}` }, { audit: noopAudit }),
        (e: unknown) => e instanceof BacktestPersistenceError && e.code === "persist:run-id-conflict"
      );
      const after = await db.select({ id: backtestRuns.id }).from(backtestRuns).where(eq(backtestRuns.idempotencyKey, key));
      assert.equal(after.length, 1);
    } finally {
      await cleanupKey(key);
    }
  });

  it("Idempotenz unter Parallelität: zwei gleichzeitige Writes desselben Laufs ⇒ 1 Run, N Trades, beide erhalten dieselbe ID", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    const report = sampleReport();
    const key = `test:parallel:${randomUUID()}`;
    try {
      const results = await Promise.all(
        [0, 1, 2].map(() => persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId: randomUUID(), idempotencyKey: key }, { audit: noopAudit }))
      );
      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 1, "alle Writer müssen dieselbe Run-ID sehen");
      assert.equal(results.filter((r) => r.created).length, 1, "genau ein Writer legt an");
      const [id] = ids;
      const runs = await db.select({ id: backtestRuns.id }).from(backtestRuns).where(eq(backtestRuns.idempotencyKey, key));
      assert.equal(runs.length, 1);
      const trades = await db.select({ n: sql<number>`count(*)::int` }).from(backtestTrades).where(eq(backtestTrades.runId, id));
      assert.equal(trades[0].n, report.trades.length);
      const seqs = await db.select({ seq: backtestTrades.seq }).from(backtestTrades).where(and(eq(backtestTrades.runId, id))).orderBy(backtestTrades.seq);
      assert.deepEqual(seqs.map((s) => s.seq), report.trades.map((_, i) => i + 1));
    } finally {
      await cleanupKey(key);
    }
  });
});

// ── 6) READ-API ─────────────────────────────────────────────────────────────

describe("Read-API: Trade-Ledger (firm.read)", () => {
  const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"] as const;
  const saved = new Map<string, string | undefined>();

  function localOpen(): void {
    for (const key of AUTH_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  function tokenMode(): void {
    localOpen();
    process.env.FIRM_API_TOKEN = "ledger-api-token-0123456789abcdef";
  }

  function restore(): void {
    for (const key of AUTH_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  }

  const BASE = "https://trading.example.test/api/firm/backtests";
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("Trades-Route: ohne Credential im Token-Betrieb 401 — vor jedem DB-Zugriff", async () => {
    tokenMode();
    try {
      const { GET } = await import("../src/app/api/firm/backtests/[id]/trades/route");
      const id = randomUUID();
      const res = await GET(new Request(`${BASE}/${id}/trades`), ctx(id));
      assert.equal(res.status, 401);
    } finally {
      restore();
    }
  });

  it("ungültige Run-ID / Limit / Cursor / Filter ⇒ 400 (ohne DB grün)", async () => {
    localOpen();
    try {
      const trades = await import("../src/app/api/firm/backtests/[id]/trades/route");
      const detail = await import("../src/app/api/firm/backtests/[id]/route");
      const id = randomUUID();
      const bad = await trades.GET(new Request(`${BASE}/keine-uuid/trades`), ctx("keine-uuid"));
      assert.equal(bad.status, 400);
      assert.match(String(((await bad.json()) as { error: unknown }).error), /^INVALID_RUN_ID/);
      for (const [query, pattern] of [
        ["limit=0", /^INVALID_TRADE_LIMIT/],
        ["limit=501", /^INVALID_TRADE_LIMIT/],
        ["cursor=***", /^INVALID_TRADE_CURSOR/],
        ["segment=WARMUP", /^INVALID_TRADE_FILTER/],
        ["window=-3", /^INVALID_TRADE_FILTER/],
        ["side=FLAT", /^INVALID_TRADE_FILTER/],
        ["exitReason=MOON", /^INVALID_TRADE_FILTER/],
      ] as const) {
        const res = await trades.GET(new Request(`${BASE}/${id}/trades?${query}`), ctx(id));
        assert.equal(res.status, 400, `trades ?${query}`);
        assert.match(String(((await res.json()) as { error: unknown }).error), pattern);
        const resDetail = await detail.GET(new Request(`${BASE}/${id}?${query}`), ctx(id));
        assert.equal(resDetail.status, 400, `detail ?${query}`);
      }
    } finally {
      restore();
    }
  });

  it("unbekannte Run-ID ⇒ 404 auf Detail- und Trades-Route (DB-gegated)", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    localOpen();
    try {
      const trades = await import("../src/app/api/firm/backtests/[id]/trades/route");
      const detail = await import("../src/app/api/firm/backtests/[id]/route");
      const id = randomUUID();
      const res = await trades.GET(new Request(`${BASE}/${id}/trades`), ctx(id));
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: unknown }).error, "BACKTEST_RUN_NOT_FOUND");
      const resDetail = await detail.GET(new Request(`${BASE}/${id}`), ctx(id));
      assert.equal(resDetail.status, 404);
    } finally {
      restore();
    }
  });

  it("Detail additiv (ledger/trades/links), Trades-Route mit Limit + Cursor-Kette + Filter, Liste ohne Trades (DB-gegated)", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    localOpen();
    const report = sampleReport();
    const runId = randomUUID();
    const key = `test:api:${runId}`;
    try {
      await persistBacktestRun({ report, spec: priceRule(SYMBOL, 100), runId, idempotencyKey: key }, { audit: noopAudit });
      const n = report.trades.length;
      const detail = await import("../src/app/api/firm/backtests/[id]/route");
      const trades = await import("../src/app/api/firm/backtests/[id]/trades/route");
      const list = await import("../src/app/api/firm/backtests/route");

      type Page = { items: Array<{ seq: number; segment: string; windowIndex: number }>; nextCursor: string | null; limit: number; filter: Record<string, unknown> };
      type DetailBody = { ok: boolean; run: { id: string; tradeCount: number | null }; ledger: { status: string; tradeCount: number | null; idempotencyKey: string | null }; trades: Page; links: { trades: string } };

      const resDetail = await detail.GET(new Request(`${BASE}/${runId}?limit=3`), ctx(runId));
      assert.equal(resDetail.status, 200);
      assert.equal(resDetail.headers.get("cache-control"), "private, no-store");
      const body = (await resDetail.json()) as DetailBody;
      assert.equal(body.ok, true);
      assert.equal(body.run.id, runId);
      assert.equal(body.ledger.status, "RECONCILED");
      assert.equal(body.ledger.tradeCount, n);
      assert.equal(body.ledger.idempotencyKey, key);
      assert.equal(body.trades.items.length, Math.min(3, n));
      assert.deepEqual(body.trades.items.map((x) => x.seq), [1, 2, 3].slice(0, n));
      assert.equal(body.trades.limit, 3);
      assert.equal(body.links.trades, `/api/firm/backtests/${runId}/trades`);
      assert.equal(typeof body.trades.nextCursor, n > 3 ? "string" : "object");

      // Cursor-Kette über die Trades-Route: alle N Zeilen genau einmal, in seq-Reihenfolge, letzte Seite nextCursor=null.
      const seen: number[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const url = `${BASE}/${runId}/trades?limit=4${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await trades.GET(new Request(url), ctx(runId));
        assert.equal(res.status, 200);
        const page = (await res.json()) as { ok: boolean; runId: string; ledger: { status: string }; trades: Page };
        assert.equal(page.ok, true);
        assert.equal(page.runId, runId);
        assert.equal(page.ledger.status, "RECONCILED");
        assert.ok(page.trades.items.length <= 4);
        seen.push(...page.trades.items.map((x) => x.seq));
        cursor = page.trades.nextCursor;
        guard++;
        assert.ok(guard <= n + 1, "Cursor-Kette terminiert nicht");
      } while (cursor !== null);
      assert.deepEqual(seen, report.trades.map((_, i) => i + 1));

      // Default-Limit 100 ⇒ bei N ≤ 100 genau eine Seite; Filter greifen.
      const resAll = await trades.GET(new Request(`${BASE}/${runId}/trades`), ctx(runId));
      const all = (await resAll.json()) as { trades: Page };
      assert.equal(all.trades.limit, 100);
      assert.equal(all.trades.items.length, Math.min(100, n));
      const resOos = await trades.GET(new Request(`${BASE}/${runId}/trades?segment=oos&limit=500`), ctx(runId));
      const oos = (await resOos.json()) as { trades: Page };
      assert.equal(oos.trades.items.length, report.aggregateOos.trades);
      assert.ok(oos.trades.items.every((x) => x.segment === "OOS"));
      assert.equal(oos.trades.filter.segment, "OOS");
      const resW = await trades.GET(new Request(`${BASE}/${runId}/trades?window=0&segment=IS`), ctx(runId));
      const w = (await resW.json()) as { trades: Page };
      assert.equal(w.trades.items.length, report.windows[0].is.trades);
      // Cursor am Ende ⇒ leere Seite, kein Fehler.
      const resEnd = await trades.GET(new Request(`${BASE}/${runId}/trades?cursor=${encodeTradeCursor(n)}`), ctx(runId));
      const end = (await resEnd.json()) as { trades: Page };
      assert.deepEqual(end.trades.items, []);
      assert.equal(end.trades.nextCursor, null);

      // Liste bleibt schlank: Run-Zeilen, keine Trade-Arrays.
      const resList = await list.GET(new Request(`${BASE}?limit=100`));
      assert.equal(resList.status, 200);
      const listBody = (await resList.json()) as { runs: Array<Record<string, unknown>> };
      const mine = listBody.runs.find((r) => r.id === runId);
      assert.ok(mine, "Run muss in der Liste erscheinen");
      assert.equal("trades" in mine, false);
      assert.equal(mine.tradeCount, n);
      assert.equal(mine.reconciliationStatus, "RECONCILED");
    } finally {
      await cleanupRun(runId);
      restore();
    }
  });

  it("Alt-Run ohne Ledger ⇒ ledger.status UNAVAILABLE, tradeCount null (nie 0), leere Seite (DB-gegated)", async (t) => {
    if (!(await ledgerReachable())) {
      t.skip(SKIP_MSG);
      return;
    }
    localOpen();
    const report = sampleReport();
    const runId = randomUUID();
    try {
      await insertBacktestRun(toBacktestRunInsert(report, priceRule(SYMBOL, 100), runId));
      const detail = await import("../src/app/api/firm/backtests/[id]/route");
      const trades = await import("../src/app/api/firm/backtests/[id]/trades/route");
      const resDetail = await detail.GET(new Request(`${BASE}/${runId}`), ctx(runId));
      assert.equal(resDetail.status, 200);
      const body = (await resDetail.json()) as { ledger: { status: string; tradeCount: number | null }; trades: { items: unknown[]; nextCursor: string | null } };
      assert.equal(body.ledger.status, "UNAVAILABLE");
      assert.equal(body.ledger.tradeCount, null);
      assert.deepEqual(body.trades.items, []);
      assert.equal(body.trades.nextCursor, null);
      const resTrades = await trades.GET(new Request(`${BASE}/${runId}/trades?limit=10`), ctx(runId));
      assert.equal(resTrades.status, 200);
      const page = (await resTrades.json()) as { ok: boolean; ledger: { status: string; tradeCount: number | null }; trades: { items: unknown[]; limit: number }; note?: string };
      assert.equal(page.ok, true);
      assert.equal(page.ledger.status, "UNAVAILABLE");
      assert.equal(page.ledger.tradeCount, null);
      assert.deepEqual(page.trades.items, []);
      assert.equal(page.trades.limit, 10);
      assert.match(String(page.note), /v1\.52\.0/);
    } finally {
      await cleanupRun(runId);
      restore();
    }
  });
});

// ── 7) STABILITÄT DES HASH-VERTRAGS ─────────────────────────────────────────

describe("Trade-Ledger: Hash-Vertrag", () => {
  it("hashTrades == sha256(stableStringify(trades)) — der DB-Roundtrip muss genau diesen Vertrag reproduzieren", () => {
    const report = sampleReport();
    const logs = report.trades.filter((t) => t.windowIndex === 0 && t.segment === "OOS").map((t) => t.trade);
    assert.equal(hashTrades(logs), createHash("sha256").update(stableStringify(logs)).digest("hex"));
    assert.equal(hashTrades(logs), report.windows[0].oos.tradeHash);
  });
});

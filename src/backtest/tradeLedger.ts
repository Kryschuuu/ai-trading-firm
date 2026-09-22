/**
 * Trade-Ledger eines Walk-Forward-Runs — reine Abbildung, Validierung und
 * Abgleich (RMA-P1-04, v1.52.0). Kein IO: alles hier ist ohne Datenbank
 * testbar; die Drizzle-Hüllen liegen in `./runStore.ts`.
 *
 * Bausteine:
 *   - `mapReportTrades`      Report-Trades → `backtest_trades`-Zeilen
 *                            (kanonische `seq`, validiert, keine NaN/Infinity,
 *                            Einheiten dokumentiert).
 *   - `tradeRowToLog`        Zeile → `BacktestTradeLog` (exakter Roundtrip;
 *                            daraus wird der Fenster-Trade-Hash reproduziert).
 *   - `reconcileTradeLedger` Zeilen ↔ Run-Aggregate (Anzahl, Wins, Netto-PnL,
 *                            Gebühren, Funding, Slippage, Trade-Hash je
 *                            Fenster/Segment). Abweichung ⇒ `TradeLedgerError`
 *                            (der Write wird abgelehnt, nichts wird gespeichert).
 *   - `backtestRunIdempotencyKey`  stabiler Lauf-Schlüssel (Retry ⇒ derselbe Run).
 *   - Cursor/Query-Validatoren der paginierten Read-API.
 *
 * Einheiten (Kontowährung = Quote-Währung des Instruments, z. B. USDT):
 *   - Preise je Basiseinheit, `qty` in Basiseinheiten, `notional`, PnL,
 *     Gebühren, Funding, Slippage in Kontowährung, `pnlPct` in Prozent des
 *     Notionals. Funding in Kontosicht (negativ = gezahlt).
 *   - Rundung: die Engine liefert `pnl`/`fees`/`slippage`/`notional`/`pnlPct`
 *     mit 4, `funding` mit 8 Nachkommastellen; Preise/`qty` sind ungerundete
 *     Doubles. Zeilen speichern die Zahlen als kürzeste Dezimaldarstellung
 *     (`numeric`, verlustfrei) — es wird hier NICHT weiter gerundet, damit der
 *     Trade-Hash des Reports aus den Zeilen byte-identisch reproduzierbar ist.
 *   - `pnlGross` ist abgeleitet (qty × Preisdifferenz, 8 Nachkommastellen) und
 *     dient der Plausibilitätsprüfung `pnlNet ≈ pnlGross − fees + funding`.
 *
 * Zeitsemantik: `entryTime`/`exitTime` sind Ereigniszeiten (Open-Zeitstempel
 * der Kerze, auf deren Schlusskurs der Fill simuliert wurde — die Engine
 * entscheidet nur auf geschlossenen Kerzen); die Berechnungszeit des Laufs
 * ist `report.createdAt` (persistiert in `params_json.createdAt` und
 * `backtest_runs.created_at`).
 */

import { createHash } from "node:crypto";
import { stableStringify } from "../lib/ruleEngine";
import { hashTrades } from "./walkforward";
import type {
  WalkForwardReport,
  WalkForwardSegment,
  WalkForwardTradeRecord,
  WindowEvalSummary,
} from "./walkforward";
import type { BacktestTradeLog, TradeExitReason } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten & Fehler
// ─────────────────────────────────────────────────────────────────────────────

/** Geschlossene Exit-Grund-Taxonomie (identisch zur DB-CHECK-Constraint). */
export const TRADE_EXIT_REASONS: readonly TradeExitReason[] = [
  "STOP_LOSS",
  "TAKE_PROFIT",
  "SIGNAL_EXIT",
  "MAX_HOLDING",
  "RISK_STOP",
  "END_OF_DATA",
  "SIGNAL_DECAY",
] as const;

export const WALK_FORWARD_SEGMENTS: readonly WalkForwardSegment[] = ["IS", "OOS"] as const;

/** Mapping-Version der Zeilen (steht in `provenance_json.v`). */
export const TRADE_LEDGER_MAPPING_VERSION = 1 as const;

/** Bounds für Textfelder (kein unbegrenzter Fremdtext in der DB). */
const MAX_TEXT_FIELD = 128;
/** Bounds des Idempotency-Keys (Textspalte, partieller UNIQUE-Index). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_.-]{8,128}$/;

/** Fehlercodes des Ledgers (maschinenlesbar, Muster `WalkForwardError`). */
export type TradeLedgerErrorCode =
  | "ledger:invalid-trade"
  | "ledger:invalid-report"
  | "ledger:reconciliation-mismatch"
  | "ledger:readback-mismatch"
  | "ledger:idempotency-conflict"
  | "ledger:invalid-idempotency-key";

export class TradeLedgerError extends Error {
  constructor(
    public readonly code: TradeLedgerErrorCode,
    message: string,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TradeLedgerError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dezimal-Hilfen (verlustfreier numeric-Roundtrip)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kürzeste Dezimaldarstellung eines endlichen Doubles OHNE Exponent
 * (PostgreSQL `numeric` akzeptiert auch `1e-7`, die Klartextform ist aber
 * eindeutig und diff-freundlich). `Number(decimalString(x)) === x` gilt für
 * jeden endlichen Wert (JS garantiert Roundtrip der kürzesten Darstellung).
 */
export function decimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TradeLedgerError("ledger:invalid-trade", `decimalString: nicht endlicher Wert (${String(value)})`);
  }
  if (Object.is(value, -0)) return "0";
  const s = String(value);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1];
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const exp = Number(m[4]);
  const digits = intPart + fracPart;
  const pointIndex = intPart.length + exp;
  if (pointIndex <= 0) return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
  if (pointIndex >= digits.length) return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

/** `numeric`-Text → Zahl; nicht endliche/leere Werte werden abgewiesen. */
export function parseDecimal(raw: unknown, field: string): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "" || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new TradeLedgerError("ledger:readback-mismatch", `Feld ${field}: kein numerischer Wert (${String(raw).slice(0, 40)})`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new TradeLedgerError("ledger:readback-mismatch", `Feld ${field}: nicht endlich (${text.slice(0, 40)})`);
  }
  return n;
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

// ─────────────────────────────────────────────────────────────────────────────
// Zeilen-Typ & Mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Herkunft einer Zeile (bounded, ohne Secrets/PII). */
export interface TradeProvenance {
  v: typeof TRADE_LEDGER_MAPPING_VERSION;
  source: "walk-forward";
  engineTradeId: string;
  windowFrom: number;
  windowTo: number;
  ruleSignature: string;
  executionModel: string;
  simulatorSeed: number;
  /**
   * Fill-/Funding-/Impact-Details des `event_replay`-Pfads (RMA-P1-01,
   * v1.58.0; additiv — fehlt bei `legacy`/`paper`-Zeilen). Bounded:
   * höchstens `REPLAY_TRADE_MAX_FILLS` Fills je Trade (`truncated`-Flag).
   */
  replay?: import("./replayEvents").TradeReplayDetail;
}

/**
 * Insert-/Read-Zeile von `backtest_trades` (Zahlen als Dezimal-Strings, wie
 * Drizzle `numeric` sie schreibt und liest; Zeiten als `Date`).
 */
export interface BacktestTradeRow {
  runId: string;
  seq: number;
  windowIndex: number;
  segment: WalkForwardSegment;
  tradeRef: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: string;
  notional: string;
  entryTs: Date;
  exitTs: Date;
  entryPrice: string;
  exitPrice: string;
  pnlGross: string;
  pnlNet: string;
  pnlPct: string;
  fees: string;
  funding: string | null;
  slippage: string;
  exitReason: TradeExitReason;
  durationBars: number;
  provenanceJson: TradeProvenance;
}

function requireFinite(value: unknown, field: string, seq: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: Feld ${field} ist nicht endlich (${String(value)})`, {
      seq,
      field,
    });
  }
  return value;
}

function requireText(value: unknown, field: string, seq: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_FIELD) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: Feld ${field} fehlt oder ist länger als ${MAX_TEXT_FIELD} Zeichen`, {
      seq,
      field,
    });
  }
  return value;
}

/** Toleranz der Plausibilität `pnlNet ≈ pnlGross − fees + funding` (Rundung 4 + 4 Stellen). */
export const PNL_IDENTITY_TOLERANCE = 0.0002;

/**
 * Bildet EINEN Report-Trade auf eine Zeile ab (rein, validierend).
 *
 * Abgewiesen (fail-closed, `ledger:invalid-trade`): nicht endliche Zahlen,
 * `qty ≤ 0`, Preise `≤ 0`, negative Gebühren/Slippage, `exit < entry`,
 * nicht-ganzzahlige Zeitstempel, `durationBars < 1`, unbekannte Seite/
 * Exit-Grund/Segment, überlange Texte und verletzte PnL-Identität.
 */
export function mapTradeRecordToRow(
  record: WalkForwardTradeRecord,
  ctx: { runId: string; seq: number; windowFrom: number; windowTo: number; ruleSignature: string; executionModel: string; simulatorSeed: number }
): BacktestTradeRow {
  const seq = ctx.seq;
  const t = record.trade;
  if (!WALK_FORWARD_SEGMENTS.includes(record.segment)) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: unbekanntes Segment (${String(record.segment)})`, { seq });
  }
  if (!Number.isInteger(record.windowIndex) || record.windowIndex < 0) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: ungültiger Fensterindex (${String(record.windowIndex)})`, { seq });
  }
  if (t.side !== "LONG" && t.side !== "SHORT") {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: unbekannte Seite (${String(t.side)})`, { seq });
  }
  if (!TRADE_EXIT_REASONS.includes(t.exitReason)) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: unbekannter Exit-Grund (${String(t.exitReason)})`, { seq });
  }

  const qty = requireFinite(t.qty, "qty", seq);
  const notional = requireFinite(t.notional, "notional", seq);
  const entryPrice = requireFinite(t.entryPrice, "entryPrice", seq);
  const exitPrice = requireFinite(t.exitPrice, "exitPrice", seq);
  const pnl = requireFinite(t.pnl, "pnl", seq);
  const pnlPct = requireFinite(t.pnlPct, "pnlPct", seq);
  const fees = requireFinite(t.fees, "fees", seq);
  const slippage = requireFinite(t.slippage, "slippage", seq);
  const entryTime = requireFinite(t.entryTime, "entryTime", seq);
  const exitTime = requireFinite(t.exitTime, "exitTime", seq);
  const durationBars = requireFinite(t.durationBars, "durationBars", seq);
  const funding = t.funding === undefined ? null : requireFinite(t.funding, "funding", seq);

  if (qty <= 0) throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: qty ≤ 0`, { seq, field: "qty" });
  if (notional < 0) throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: notional < 0`, { seq, field: "notional" });
  if (entryPrice <= 0 || exitPrice <= 0) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: Preis ≤ 0`, { seq, field: "price" });
  }
  if (fees < 0) throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: fees < 0`, { seq, field: "fees" });
  if (slippage < 0) throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: slippage < 0`, { seq, field: "slippage" });
  if (!Number.isInteger(entryTime) || !Number.isInteger(exitTime) || entryTime <= 0) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: Zeitstempel müssen positive ganze Millisekunden sein`, { seq, field: "time" });
  }
  if (exitTime < entryTime) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: exitTime < entryTime`, { seq, field: "time" });
  }
  if (!Number.isInteger(durationBars) || durationBars < 1) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: durationBars < 1`, { seq, field: "durationBars" });
  }
  const expectedDurationMs = exitTime - entryTime;
  if (t.durationMs !== expectedDurationMs) {
    throw new TradeLedgerError("ledger:invalid-trade", `Trade #${seq}: durationMs (${String(t.durationMs)}) ≠ exitTime − entryTime (${expectedDurationMs})`, {
      seq,
      field: "durationMs",
    });
  }

  const pnlGross = round(t.side === "LONG" ? qty * (exitPrice - entryPrice) : qty * (entryPrice - exitPrice), 8);
  const identity = pnlGross - fees + (funding ?? 0);
  if (Math.abs(pnl - identity) > PNL_IDENTITY_TOLERANCE) {
    throw new TradeLedgerError(
      "ledger:invalid-trade",
      `Trade #${seq}: PnL-Identität verletzt (pnl ${pnl} vs. gross − fees + funding = ${identity.toFixed(6)})`,
      { seq, field: "pnl", pnl, pnlGross, fees, funding }
    );
  }

  return {
    runId: ctx.runId,
    seq,
    windowIndex: record.windowIndex,
    segment: record.segment,
    tradeRef: requireText(t.id, "id", seq),
    strategyId: requireText(t.strategyId, "strategyId", seq),
    symbol: requireText(t.symbol, "symbol", seq),
    side: t.side,
    qty: decimalString(qty),
    notional: decimalString(notional),
    entryTs: new Date(entryTime),
    exitTs: new Date(exitTime),
    entryPrice: decimalString(entryPrice),
    exitPrice: decimalString(exitPrice),
    pnlGross: decimalString(pnlGross),
    pnlNet: decimalString(pnl),
    pnlPct: decimalString(pnlPct),
    fees: decimalString(fees),
    funding: funding === null ? null : decimalString(funding),
    slippage: decimalString(slippage),
    exitReason: t.exitReason,
    durationBars,
    provenanceJson: {
      v: TRADE_LEDGER_MAPPING_VERSION,
      source: "walk-forward",
      engineTradeId: t.id,
      windowFrom: ctx.windowFrom,
      windowTo: ctx.windowTo,
      ruleSignature: ctx.ruleSignature,
      executionModel: ctx.executionModel,
      simulatorSeed: ctx.simulatorSeed,
      ...(record.replay ? { replay: record.replay } : {}),
    },
  };
}

function windowSummary(report: WalkForwardReport, index: number, segment: WalkForwardSegment): WindowEvalSummary {
  const w = report.windows.find((x) => x.index === index);
  if (!w) {
    throw new TradeLedgerError("ledger:invalid-report", `Report kennt kein Fenster ${index}`, { windowIndex: index });
  }
  return segment === "IS" ? w.is : w.oos;
}

/**
 * Report → kanonische Zeilenliste. Die Reihenfolge ist die des Reports
 * (Fenster ↑, IS vor OOS, Engine-Schließreihenfolge); sie wird hier explizit
 * geprüft, damit `seq` eine stabile, reproduzierbare Sequenz ist.
 */
export function mapReportTrades(report: WalkForwardReport, runId: string): BacktestTradeRow[] {
  if (!Array.isArray(report.trades)) {
    throw new TradeLedgerError("ledger:invalid-report", "Report ohne Trade-Liste — Lauf stammt nicht aus dieser Engine-Version (v1.52.0+).");
  }
  const rows: BacktestTradeRow[] = [];
  let lastKey = -1;
  const seenRefs = new Set<string>();
  for (let i = 0; i < report.trades.length; i++) {
    const record = report.trades[i];
    const seq = i + 1;
    const orderKey = record.windowIndex * 2 + (record.segment === "IS" ? 0 : 1);
    if (orderKey < lastKey) {
      throw new TradeLedgerError("ledger:invalid-report", `Trade #${seq}: Trade-Liste nicht kanonisch geordnet (Fenster ${record.windowIndex}/${record.segment} nach späterem Eintrag)`, { seq });
    }
    lastKey = orderKey;
    const refKey = `${record.windowIndex}:${record.segment}:${record.trade.id}`;
    if (seenRefs.has(refKey)) {
      throw new TradeLedgerError("ledger:invalid-report", `Trade #${seq}: doppelte Engine-Trade-ID ${record.trade.id} in Fenster ${record.windowIndex}/${record.segment}`, { seq });
    }
    seenRefs.add(refKey);
    const summary = windowSummary(report, record.windowIndex, record.segment);
    rows.push(
      mapTradeRecordToRow(record, {
        runId,
        seq,
        windowFrom: summary.from,
        windowTo: summary.to,
        ruleSignature: report.ruleRef.signature,
        executionModel: report.costProfile.executionModel,
        simulatorSeed: report.costProfile.simulatorSeed,
      })
    );
  }
  return rows;
}

/**
 * Zeile → Engine-Trade-Log (exakter Roundtrip). `durationMs` ist per
 * Konstruktion `exitTs − entryTs`; `funding` bleibt weg, wenn NULL (Engine
 * ohne Funding-Ausweis — nicht 0).
 */
export function tradeRowToLog(row: BacktestTradeRow): BacktestTradeLog {
  const entryTime = row.entryTs.getTime();
  const exitTime = row.exitTs.getTime();
  const log: BacktestTradeLog = {
    id: row.tradeRef,
    strategyId: row.strategyId,
    symbol: row.symbol,
    side: row.side,
    entryTime,
    exitTime,
    entryPrice: parseDecimal(row.entryPrice, "entryPrice"),
    exitPrice: parseDecimal(row.exitPrice, "exitPrice"),
    qty: parseDecimal(row.qty, "qty"),
    notional: parseDecimal(row.notional, "notional"),
    pnl: parseDecimal(row.pnlNet, "pnlNet"),
    pnlPct: parseDecimal(row.pnlPct, "pnlPct"),
    fees: parseDecimal(row.fees, "fees"),
    slippage: parseDecimal(row.slippage, "slippage"),
    exitReason: row.exitReason,
    durationBars: row.durationBars,
    durationMs: Math.max(0, exitTime - entryTime),
  };
  if (row.funding !== null) log.funding = parseDecimal(row.funding, "funding");
  return log;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation (Zeilen ↔ Aggregate)
// ─────────────────────────────────────────────────────────────────────────────

/** Trade-Ledger-Summen eines Segments/Fensters. */
export interface LedgerTotals {
  trades: number;
  wins: number;
  /** Σ pnlNet (4 Nachkommastellen). */
  netPnl: number;
  /** Σ fees (4 Nachkommastellen). */
  fees: number;
  /** Σ funding (8 Nachkommastellen) — `null`, wenn KEINE Zeile Funding ausweist. */
  funding: number | null;
  /** Σ slippage (4 Nachkommastellen). */
  slippage: number;
}

export interface ReconciliationCheck {
  /** z. B. `OOS.trades`, `IS.fees`, `window[3].OOS.tradeHash` */
  name: string;
  expected: number | string;
  actual: number | string;
  delta: number;
  tolerance: number;
  ok: boolean;
}

export interface ReconciledWindow {
  index: number;
  segment: WalkForwardSegment;
  trades: number;
  netPnl: number;
  tradeHash: string;
}

/** Persistierte Abgleich-Evidenz (`backtest_runs.reconciliation_json`). */
export interface TradeLedgerReconciliation {
  version: 1;
  status: "RECONCILED";
  tradeCount: number;
  segments: Record<WalkForwardSegment, LedgerTotals>;
  windows: ReconciledWindow[];
  /** Aggregat-Checks (Segment-Ebene) mit Deltas und Toleranzen. */
  checks: ReconciliationCheck[];
  /**
   * Informativ: `pnl` (Equity-Sicht) − `netPnl` (Ledger-Sicht) je Segment =
   * Kostenanteil der `END_OF_DATA`-Schlussglattstellung (siehe
   * `WindowEvalSummary`). Kein Check — dokumentierte, erwartete Differenz.
   */
  equityLedgerGap: Record<WalkForwardSegment, number>;
  /** Kurzbeschreibung der Toleranzregeln (für Leser der Evidenz). */
  toleranceRule: string;
}

export const TOLERANCE_RULE =
  "count/wins/tradeHash exakt; netPnl ±0.0001 (Engine rundet je Trade auf 4 Stellen); " +
  "fees/slippage ±(0.005 × (Fenster + 1) + 0.00005 × Trades) (Aggregat 2, Trade 4 Stellen); " +
  "funding ±(1e-6 + 1e-8 × (Trades + Fenster)) (8 Stellen je Accrual)";

/**
 * `roundings` = Anzahl der 2-Stellen-Rundungen im Vergleichswert (1 je
 * Fenster-Kennzahl, Fenster + 1 im Aggregat), `trades` = 4-Stellen-Rundungen
 * der Summanden.
 */
function feeTolerance(roundings: number, trades: number): number {
  return 0.005 * roundings + 0.00005 * trades + 1e-9;
}

function fundingTolerance(windows: number, trades: number): number {
  return 1e-6 + 1e-8 * (trades + windows);
}

const NET_PNL_TOLERANCE = 0.0001 + 1e-9;

/** Summen über Zeilen (Dezimal-Strings) — rein, ohne DB. */
export function ledgerTotals(rows: ReadonlyArray<BacktestTradeRow>): LedgerTotals {
  let wins = 0;
  let netPnl = 0;
  let fees = 0;
  let slippage = 0;
  let funding = 0;
  let fundingRows = 0;
  for (const r of rows) {
    const pnl = parseDecimal(r.pnlNet, "pnlNet");
    if (pnl > 0) wins++;
    netPnl += pnl;
    fees += parseDecimal(r.fees, "fees");
    slippage += parseDecimal(r.slippage, "slippage");
    if (r.funding !== null) {
      funding += parseDecimal(r.funding, "funding");
      fundingRows++;
    }
  }
  return {
    trades: rows.length,
    wins,
    netPnl: round(netPnl, 4),
    fees: round(fees, 4),
    funding: fundingRows > 0 ? round(funding, 8) : null,
    slippage: round(slippage, 4),
  };
}

function check(name: string, expected: number, actual: number, tolerance: number): ReconciliationCheck {
  const delta = actual - expected;
  return { name, expected, actual, delta: Number(delta.toFixed(10)), tolerance, ok: Math.abs(delta) <= tolerance };
}

/**
 * Gleicht Zeilen mit dem Report ab. Wirft `ledger:reconciliation-mismatch`
 * mit allen fehlgeschlagenen Checks (nie stilles Durchwinken) und liefert
 * sonst die persistierbare Evidenz.
 *
 * Prüfungen:
 *   1. Sequenz: `seq` = 1..N lückenlos in Zeilenreihenfolge.
 *   2. Je Fenster × Segment: Anzahl exakt, Trade-Hash (sha256 über die aus den
 *      Zeilen rekonstruierten Trade-Logs) exakt, Netto-PnL/Gebühren/Funding/
 *      Slippage innerhalb der Rundungstoleranz.
 *   3. Je Segment (Aggregat OOS/IS): Anzahl + Wins exakt, Netto-PnL/Gebühren/
 *      Funding/Slippage innerhalb der Rundungstoleranz.
 */
export function reconcileTradeLedger(report: WalkForwardReport, rows: ReadonlyArray<BacktestTradeRow>): TradeLedgerReconciliation {
  const failures: ReconciliationCheck[] = [];
  const checks: ReconciliationCheck[] = [];
  const windows: ReconciledWindow[] = [];

  rows.forEach((r, i) => {
    if (r.seq !== i + 1) {
      failures.push({ name: `seq[${i}]`, expected: i + 1, actual: r.seq, delta: r.seq - (i + 1), tolerance: 0, ok: false });
    }
  });

  const bySegment: Record<WalkForwardSegment, BacktestTradeRow[]> = { IS: [], OOS: [] };
  for (const w of report.windows) {
    for (const segment of WALK_FORWARD_SEGMENTS) {
      const summary = segment === "IS" ? w.is : w.oos;
      const windowRows = rows.filter((r) => r.windowIndex === w.index && r.segment === segment);
      bySegment[segment].push(...windowRows);
      const totals = ledgerTotals(windowRows);
      const scope = `window[${w.index}].${segment}`;
      const hash = hashTrades(windowRows.map(tradeRowToLog));
      const local: ReconciliationCheck[] = [
        check(`${scope}.trades`, summary.trades, totals.trades, 0),
        check(`${scope}.wins`, summary.wins, totals.wins, 0),
        check(`${scope}.netPnl`, summary.netPnl, totals.netPnl, NET_PNL_TOLERANCE),
        check(`${scope}.fees`, summary.fees, totals.fees, feeTolerance(1, totals.trades)),
        check(`${scope}.slippage`, summary.slippage, totals.slippage, feeTolerance(1, totals.trades)),
        check(`${scope}.funding`, summary.funding, totals.funding ?? 0, fundingTolerance(1, totals.trades)),
        {
          name: `${scope}.tradeHash`,
          expected: summary.tradeHash,
          actual: hash,
          delta: hash === summary.tradeHash ? 0 : 1,
          tolerance: 0,
          ok: hash === summary.tradeHash,
        },
      ];
      // Funding-Semantik: Zeilen ohne Funding (NULL) dürfen nur bei einem
      // Report-Funding von exakt 0 durchgehen — sonst fehlt Information.
      if (totals.funding === null && totals.trades > 0 && summary.funding !== 0) {
        local.push({ name: `${scope}.fundingPresence`, expected: summary.funding, actual: "null", delta: 1, tolerance: 0, ok: false });
      }
      failures.push(...local.filter((c) => !c.ok));
      windows.push({ index: w.index, segment, trades: totals.trades, netPnl: totals.netPnl, tradeHash: hash });
    }
  }

  const known = new Set(report.windows.map((w) => w.index));
  const orphan = rows.filter((r) => !known.has(r.windowIndex));
  if (orphan.length > 0) {
    failures.push({ name: "orphanRows", expected: 0, actual: orphan.length, delta: orphan.length, tolerance: 0, ok: false });
  }

  const segments: Record<WalkForwardSegment, LedgerTotals> = {
    IS: ledgerTotals(bySegment.IS),
    OOS: ledgerTotals(bySegment.OOS),
  };
  const windowCount = report.windows.length;
  for (const segment of WALK_FORWARD_SEGMENTS) {
    const agg = segment === "IS" ? report.aggregateIs : report.aggregateOos;
    const totals = segments[segment];
    checks.push(
      check(`${segment}.trades`, agg.trades, totals.trades, 0),
      check(`${segment}.wins`, agg.wins, totals.wins, 0),
      check(`${segment}.netPnl`, agg.netPnl, totals.netPnl, NET_PNL_TOLERANCE),
      check(`${segment}.fees`, agg.fees, totals.fees, feeTolerance(windowCount + 1, totals.trades)),
      check(`${segment}.slippage`, agg.slippage, totals.slippage, feeTolerance(windowCount + 1, totals.trades)),
      check(`${segment}.funding`, agg.funding, totals.funding ?? 0, fundingTolerance(windowCount, totals.trades))
    );
  }
  failures.push(...checks.filter((c) => !c.ok));

  if (failures.length > 0) {
    throw new TradeLedgerError(
      "ledger:reconciliation-mismatch",
      `Trade-Ledger stimmt nicht mit den Run-Aggregaten überein (${failures.length} Check(s)): ${failures
        .slice(0, 5)
        .map((f) => `${f.name} erwartet ${String(f.expected)} erhalten ${String(f.actual)}`)
        .join("; ")}`,
      { failures }
    );
  }

  return {
    version: 1,
    status: "RECONCILED",
    tradeCount: rows.length,
    segments,
    windows,
    checks,
    equityLedgerGap: {
      IS: round(report.aggregateIs.pnl - segments.IS.netPnl, 4),
      OOS: round(report.aggregateOos.pnl - segments.OOS.netPnl, 4),
    },
    toleranceRule: TOLERANCE_RULE,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency-Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stabiler Schlüssel eines Laufs: sha256 über die Lauf-IDENTITÄT (Instrument,
 * Zeitraum, Regel-Signatur, Fenster, Kostenprofil, Code-Version) und das
 * deterministische ERGEBNIS (Trade-Hash je Fenster/Segment). `createdAt`
 * und die Run-UUID gehen bewusst NICHT ein: ein Wiederholungslauf desselben
 * Backtests (Retry nach Absturz, Restart) erzeugt denselben Key und damit
 * keinen zweiten Run. Präfix `wf1:` versioniert das Schema des Keys.
 */
export function backtestRunIdempotencyKey(report: WalkForwardReport): string {
  const identity = {
    kind: report.kind,
    instrumentId: report.instrumentId,
    timeframe: report.timeframe,
    from: report.from,
    to: report.to,
    rule: { signature: report.ruleRef.signature, ruleSymbol: report.ruleRef.ruleSymbol, ruleId: report.ruleRef.ruleId },
    walkforward: report.walkforward,
    costProfile: report.costProfile,
    codeVersion: report.codeVersion,
    windows: report.windows.map((w) => ({ index: w.index, is: w.is.tradeHash, oos: w.oos.tradeHash })),
    ...(report.selection ? { selection: report.selection } : {}),
    ...(report.freezeArtifacts ? { freezeHashes: report.freezeArtifacts.map((f) => f.freezeHash) } : {}),
    ...(report.holdout ? { holdout: report.holdout.summary.tradeHash } : {}),
  };
  return `wf1:${createHash("sha256").update(stableStringify(identity)).digest("hex")}`;
}

/** Validiert einen (ggf. extern vorgegebenen) Idempotency-Key. */
export function validateIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new TradeLedgerError(
      "ledger:invalid-idempotency-key",
      "Idempotency-Key muss 8..128 Zeichen aus [A-Za-z0-9:_.-] enthalten."
    );
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-API: Cursor + Query (Keyset-Paging über `seq`)
// ─────────────────────────────────────────────────────────────────────────────

export const BACKTEST_TRADES_PAGE_MAX = 500;
export const BACKTEST_TRADES_PAGE_DEFAULT = 100;

const CURSOR_VERSION = "t1";
const MAX_SEQ = 2_147_483_647;

/** Opaker Cursor: base64url(`t1:<seq>`) — Seite beginnt NACH `seq`. */
export function encodeTradeCursor(afterSeq: number): string {
  if (!Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq > MAX_SEQ) {
    throw new RangeError(`encodeTradeCursor: ungültige Sequenz ${String(afterSeq)}`);
  }
  return Buffer.from(`${CURSOR_VERSION}:${afterSeq}`, "utf8").toString("base64url");
}

export function decodeTradeCursor(raw: unknown): { ok: true; afterSeq: number } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { ok: false, error: "INVALID_TRADE_CURSOR: kein gültiger Cursor" };
  }
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const m = /^t1:(\d{1,10})$/.exec(text);
  if (!m) return { ok: false, error: "INVALID_TRADE_CURSOR: unbekanntes Cursor-Format" };
  const afterSeq = Number(m[1]);
  if (!Number.isInteger(afterSeq) || afterSeq > MAX_SEQ) {
    return { ok: false, error: "INVALID_TRADE_CURSOR: Sequenz außerhalb des Bereichs" };
  }
  return { ok: true, afterSeq };
}

export interface TradePageQuery {
  limit: number;
  /** Keyset: nur Zeilen mit `seq > afterSeq` (0 = ab Anfang). */
  afterSeq: number;
  segment?: WalkForwardSegment;
  windowIndex?: number;
  symbol?: string;
  side?: "LONG" | "SHORT";
  exitReason?: TradeExitReason;
}

type QuerySource = URLSearchParams | Record<string, string | null | undefined>;

function readParam(source: QuerySource, key: string): string | null {
  const value = source instanceof URLSearchParams ? source.get(key) : source[key] ?? null;
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Handgeschriebener Validator der Trade-Query (Repo-Stil, kein Zod — R3).
 * Alle Filter sind geschlossene Mengen oder bounded Strings; unbekannte
 * Werte ⇒ 400 statt stiller Ignoranz.
 */
export function parseTradePageQuery(source: QuerySource): { ok: true; query: TradePageQuery } | { ok: false; error: string } {
  const rawLimit = readParam(source, "limit");
  let limit = BACKTEST_TRADES_PAGE_DEFAULT;
  if (rawLimit !== null) {
    const n = /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > BACKTEST_TRADES_PAGE_MAX) {
      return { ok: false, error: `INVALID_TRADE_LIMIT: erwartet 1..${BACKTEST_TRADES_PAGE_MAX}, erhalten ${rawLimit.slice(0, 20)}` };
    }
    limit = n;
  }

  let afterSeq = 0;
  const rawCursor = readParam(source, "cursor");
  if (rawCursor !== null) {
    const decoded = decodeTradeCursor(rawCursor);
    if (!decoded.ok) return decoded;
    afterSeq = decoded.afterSeq;
  }

  const query: TradePageQuery = { limit, afterSeq };

  const segment = readParam(source, "segment");
  if (segment !== null) {
    const upper = segment.toUpperCase();
    if (upper !== "IS" && upper !== "OOS") return { ok: false, error: "INVALID_TRADE_FILTER: segment muss IS oder OOS sein" };
    query.segment = upper;
  }

  const windowIndex = readParam(source, "window");
  if (windowIndex !== null) {
    if (!/^\d{1,6}$/.test(windowIndex)) return { ok: false, error: "INVALID_TRADE_FILTER: window muss eine Ganzzahl ≥ 0 sein" };
    query.windowIndex = Number(windowIndex);
  }

  const symbol = readParam(source, "symbol");
  if (symbol !== null) {
    if (symbol.length > 64 || !/^[A-Za-z0-9:_./-]+$/.test(symbol)) {
      return { ok: false, error: "INVALID_TRADE_FILTER: symbol enthält unzulässige Zeichen oder ist zu lang" };
    }
    query.symbol = symbol.toUpperCase();
  }

  const side = readParam(source, "side");
  if (side !== null) {
    const upper = side.toUpperCase();
    if (upper !== "LONG" && upper !== "SHORT") return { ok: false, error: "INVALID_TRADE_FILTER: side muss LONG oder SHORT sein" };
    query.side = upper;
  }

  const exitReason = readParam(source, "exitReason");
  if (exitReason !== null) {
    const upper = exitReason.toUpperCase() as TradeExitReason;
    if (!TRADE_EXIT_REASONS.includes(upper)) {
      return { ok: false, error: `INVALID_TRADE_FILTER: exitReason muss eines von ${TRADE_EXIT_REASONS.join(", ")} sein` };
    }
    query.exitReason = upper;
  }

  return { ok: true, query };
}

// ─────────────────────────────────────────────────────────────────────────────
// API-Ansicht einer Zeile
// ─────────────────────────────────────────────────────────────────────────────

/** JSON-Form einer Trade-Zeile in der Read-API (Zahlen als Zahlen, Zeiten ISO). */
export interface BacktestTradeView {
  seq: number;
  windowIndex: number;
  segment: WalkForwardSegment;
  tradeRef: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  notional: number;
  entryTs: string;
  exitTs: string;
  entryPrice: number;
  exitPrice: number;
  pnlGross: number;
  pnlNet: number;
  pnlPct: number;
  fees: number;
  /** `null` = Funding nicht ausgewiesen (nicht 0). */
  funding: number | null;
  slippage: number;
  exitReason: TradeExitReason;
  durationBars: number;
  durationMs: number;
  provenance: TradeProvenance;
}

export function tradeRowToView(row: BacktestTradeRow): BacktestTradeView {
  const entry = row.entryTs.getTime();
  const exit = row.exitTs.getTime();
  return {
    seq: row.seq,
    windowIndex: row.windowIndex,
    segment: row.segment,
    tradeRef: row.tradeRef,
    strategyId: row.strategyId,
    symbol: row.symbol,
    side: row.side,
    qty: parseDecimal(row.qty, "qty"),
    notional: parseDecimal(row.notional, "notional"),
    entryTs: row.entryTs.toISOString(),
    exitTs: row.exitTs.toISOString(),
    entryPrice: parseDecimal(row.entryPrice, "entryPrice"),
    exitPrice: parseDecimal(row.exitPrice, "exitPrice"),
    pnlGross: parseDecimal(row.pnlGross, "pnlGross"),
    pnlNet: parseDecimal(row.pnlNet, "pnlNet"),
    pnlPct: parseDecimal(row.pnlPct, "pnlPct"),
    fees: parseDecimal(row.fees, "fees"),
    funding: row.funding === null ? null : parseDecimal(row.funding, "funding"),
    slippage: parseDecimal(row.slippage, "slippage"),
    exitReason: row.exitReason,
    durationBars: row.durationBars,
    durationMs: Math.max(0, exit - entry),
    provenance: row.provenanceJson,
  };
}

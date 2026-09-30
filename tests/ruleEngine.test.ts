/**
 * Tests der Regel-Engine (Makro/Mikro-Brücke, src/lib/ruleEngine.ts).
 *
 * Diese Datei ist bewusst DB- und LLM-frei: getestet wird die deterministische
 * Kernlogik — Validierung/Whitelist/Klemmung, Kompilierung, Snapshot-
 * Berechnung, Fensterprüfung und der Backtest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeRuleSpec,
  compileRuleSpec,
  buildSnapshotFromCandles,
  isWindowOpen,
  berlinDayKeyOf,
  ruleSignature,
  backtestRule,
  RULE_CEILINGS,
  type CandleLike,
  type RuleSnapshot,
} from "../src/lib/ruleEngine";

// ── Testdaten ────────────────────────────────────────────────────────────────

function makeCandles(
  n: number,
  opts?: { dipAt?: number; dipLen?: number; dipDepth?: number; recoverPerBar?: number }
): CandleLike[] {
  const out: CandleLike[] = [];
  const base = 100;
  const dipAt = opts?.dipAt ?? -1;
  const dipLen = opts?.dipLen ?? 20;
  const dipDepth = opts?.dipDepth ?? 12;
  const recoverPerBar = opts?.recoverPerBar ?? 1.4;
  for (let i = 0; i < n; i++) {
    let close = base + Math.sin(i / 5) * 1.5;
    if (i >= dipAt && i < dipAt + dipLen) {
      close -= dipDepth;
    } else if (i >= dipAt + dipLen) {
      close -= dipDepth;
      close += recoverPerBar * (i - (dipAt + dipLen) + 1);
    }
    out.push({
      time: 1_700_000_000_000 + i * 60_000,
      open: close * 0.999,
      high: Math.max(close, close * 0.999) * 1.005,
      low: Math.min(close, close * 0.999) * 0.995,
      close,
      volume: 1000 + (i % 7) * 100,
    });
  }
  return out;
}

const validInput = {
  name: "BTC mean reversion",
  symbol: "btc",
  rationale: "Kaufe bei überverkauftem RSI mit Volumen.",
  condition: {
    logic: "all",
    conditions: [
      { field: "rsi14", op: "lt", value: 30 },
      { field: "volumeRatio", op: "gt", value: 1.2 },
    ],
  },
  action: {
    side: "LONG",
    stopLossPct: 5,
    takeProfitRR: 1.5,
    riskBudgetPct: 0.02,
    maxPositionPct: 0.25,
  },
  window: {
    timeframe: "15m",
    maxExecutionsPerDay: 3,
    cooldownMinutes: 120,
    volumeWindow: 20,
  },
  riskScore: 0.5,
  sourceRole: "RESEARCH",
};

// ── Validierung / Whitelist / Klemmung ───────────────────────────────────────

test("sanitizeRuleSpec: normalisiert einen gültigen Entwurf", () => {
  const r = sanitizeRuleSpec(validInput, "RESEARCH");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.spec.symbol, "BTC");
  assert.equal(r.spec.action.side, "LONG");
  assert.equal(r.spec.condition.conditions.length, 2);
  assert.equal(r.spec.window.timeframe, "15m");
  assert.equal(r.spec.sourceRole, "RESEARCH");
});

test("sanitizeRuleSpec: lehnt unbekannte Felder/Operatoren ab (LLM-Halluzination)", () => {
  const bad = {
    ...validInput,
    condition: {
      logic: "all",
      conditions: [{ field: "apiKey", op: "eq", value: "secret" }],
    },
  };
  const r = sanitizeRuleSpec(bad, "RESEARCH");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes("unbekanntes Feld")));
});

test("sanitizeRuleSpec: verweigert exotische Operatoren", () => {
  const bad = {
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "price", op: "exec", value: "rm -rf" }] },
  };
  const r = sanitizeRuleSpec(bad, "RESEARCH");
  assert.equal(r.ok, false);
});

test("sanitizeRuleSpec: nur LONG erlaubt (Shorts sind im Code gesperrt)", () => {
  const bad = { ...validInput, action: { ...validInput.action, side: "SHORT" } };
  const r = sanitizeRuleSpec(bad, "RESEARCH");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes("LONG")));
});

test("sanitizeRuleSpec: klemmt Risikowerte auf die Code-Ceilings", () => {
  const greedy = {
    ...validInput,
    action: {
      side: "LONG",
      stopLossPct: 999,
      takeProfitRR: 99,
      riskBudgetPct: 0.99,
      maxPositionPct: 0.99,
    },
  };
  const r = sanitizeRuleSpec(greedy, "RESEARCH");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.spec.action.stopLossPct, RULE_CEILINGS.stopLossPct[1]);
  assert.equal(r.spec.action.takeProfitRR, RULE_CEILINGS.takeProfitRR[1]);
  assert.equal(r.spec.action.riskBudgetPct, RULE_CEILINGS.riskBudgetPct[1]);
  assert.equal(r.spec.action.maxPositionPct, RULE_CEILINGS.maxPositionPct[1]);
});

test("sanitizeRuleSpec: verhindert Prototype-Pollution-Schlüssel", () => {
  const polluted = JSON.parse(
    JSON.stringify(validInput).replace(
      '"conditions": [',
      '"conditions": [{"field":"price","op":"gt","value":10,"__proto__":{"polluted":true}},'
    )
  );
  const r = sanitizeRuleSpec(polluted, "RESEARCH");
  // Der Eintrag mit __proto__ ist kein gültiges Feld → Fehler ODER der reine
  // Eintrag wird verworfen; keinesfalls darf ein __proto__-Key durchwandern.
  assert.ok(r.ok === false || (r.ok && !Object.prototype.hasOwnProperty.call(r.spec.condition.conditions[0], "__proto__")));
});

test("sanitizeRuleSpec: zwischen (between) benötigt [lo,hi] mit lo<=hi", () => {
  const ok = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "priceVsEma21Pct", op: "between", value: [-3, 1] }] },
  });
  assert.equal(ok.ok, true);
  const bad = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "priceVsEma21Pct", op: "between", value: [3, 1] }] },
  });
  assert.equal(bad.ok, false);
});

test("sanitizeRuleSpec: trend-Feld nur mit UP/DOWN/FLAT", () => {
  const ok = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "trend", op: "in", value: ["up", "flat"] }] },
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.spec.condition.conditions[0].value, ["UP", "FLAT"]);
  const bad = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "trend", op: "gt", value: 5 }] },
  });
  assert.equal(bad.ok, false);
});

test("sanitizeRuleSpec: ungültige Symbole werden abgelehnt", () => {
  const bad = { ...validInput, symbol: "BTC;DROP TABLE" };
  assert.equal(sanitizeRuleSpec(bad, "RESEARCH").ok, false);
});

// ── Kompilierung ─────────────────────────────────────────────────────────────

const snap: RuleSnapshot = {
  symbol: "BTC",
  ts: 1_700_000_000_000,
  price: 95,
  rsi14: 28.5,
  ema9: 96,
  ema21: 97.5,
  ema50: 98,
  trend: "DOWN",
  atrPct: 2.1,
  volume: 5000,
  volumeMa20: 3000,
  volumeRatio: 1.67,
  changePct24h: -3.2,
  priceVsEma21Pct: -2.56,
  priceVsEma50Pct: -3.06,
  adx14: 22,
  bbwPct: 4.5,
  // STX-02-02: Pflichtfelder des Snapshots — ein Regel-Snapshot ohne
  // Bandposition wäre nicht mehr der Snapshot, den die Engine baut.
  bbZScore: -1.2,
  priceVsUpperBbPct: -4.5,
  priceVsLowerBbPct: 1.3,
  macd: -0.4,
  macdSignal: -0.2,
  macdHist: -0.2,
  vwapPct: 1.25,
  spreadPct: 0.04,
  bookDepthUsd: null,
};

test("compileRuleSpec: all/any, Zahlenvergleiche, between, in — ohne JSON-Parsing", () => {
  const r = sanitizeRuleSpec(validInput, "RESEARCH");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const compiled = compileRuleSpec(r.spec);
  assert.equal(compiled.evaluate(snap), true);

  const anyRule = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "any", conditions: [{ field: "rsi14", op: "gt", value: 90 }, { field: "volumeRatio", op: "gt", value: 1.2 }] },
  });
  assert.equal(anyRule.ok, true);
  if (!anyRule.ok) return;
  assert.equal(compileRuleSpec(anyRule.spec).evaluate(snap), true);

  const between = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "priceVsEma21Pct", op: "between", value: [-5, -1] }] },
  });
  assert.equal(between.ok, true);
  if (!between.ok) return;
  assert.equal(compileRuleSpec(between.spec).evaluate(snap), true);
});

test("compileRuleSpec: null-Felder (atrPct) brechen Vergleiche nicht", () => {
  const r = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "atrPct", op: "gt", value: 1 }] },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const compiled = compileRuleSpec(r.spec);
  assert.equal(compiled.evaluate({ ...snap, atrPct: null }), false);
  assert.equal(compiled.evaluate(snap), true);
});

// ── Snapshot-Berechnung ──────────────────────────────────────────────────────

test("buildSnapshotFromCandles: deterministisch, <25 Kerzen → null", () => {
  assert.equal(buildSnapshotFromCandles("BTC", makeCandles(10)), null);
  const s = buildSnapshotFromCandles("BTC", makeCandles(120), 20);
  assert.ok(s);
  assert.equal(s.symbol, "BTC");
  assert.ok(s.rsi14 > 0 && s.rsi14 < 100);
  assert.ok(s.volumeMa20 > 0);
  assert.ok(s.volumeRatio > 0);
  // Gleiche Eingabe → gleicher Snapshot (Determinismus).
  assert.deepEqual(buildSnapshotFromCandles("BTC", makeCandles(120), 20), s);
});

test("buildSnapshotFromCandles: kurze Historie setzt ADX/MACD auf null, Bedingung bleibt false", () => {
  const short = buildSnapshotFromCandles("BTC", makeCandles(26));
  assert.ok(short);
  assert.equal(short.adx14, null);
  assert.equal(short.macd, null);
  assert.equal(short.macdSignal, null);
  assert.equal(short.macdHist, null);
  assert.ok(short.bbwPct != null && short.bbwPct >= 0);

  const rule = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "adx14", op: "gt", value: 25 }, { field: "macdHist", op: "gt", value: 0 }] },
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;
  assert.equal(compileRuleSpec(rule.spec).evaluate(short), false);

  const long = buildSnapshotFromCandles("BTC", makeCandles(80))!;
  assert.equal(typeof long.adx14, "number");
  assert.equal(typeof long.macdHist, "number");
});

test("buildSnapshotFromCandles: Volumen-Ratio = letztes Volumen / 20er-Schnitt", () => {
  const candles = makeCandles(120);
  const last = candles[candles.length - 1].volume;
  const s = buildSnapshotFromCandles("BTC", candles, 20)!;
  const ma = candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
  assert.ok(Math.abs(s.volumeRatio - last / ma) < 1e-9);
});

test("buildSnapshotFromCandles: vwapPct = Kurs gegen Tages-VWAP (UTC-Anker)", () => {
  // Kerzen bewusst IN EINEM UTC-Tag: 2026-01-05T06:00Z … (1-Minuten-Takt).
  const dayStart = Date.UTC(2026, 0, 5);
  const candles: CandleLike[] = Array.from({ length: 40 }, (_, i) => {
    const close = 100 + i;
    return {
      time: dayStart + 6 * 3_600_000 + i * 60_000,
      open: close,
      high: close,
      low: close,
      close,
      volume: 10,
    };
  });
  const s = buildSnapshotFromCandles("BTC", candles, 20)!;
  // HLC3 = close, Volumen konstant ⇒ VWAP = Mittelwert der Closes = 119,5.
  const expectedVwap = (100 + 139) / 2;
  const last = candles[candles.length - 1].close;
  assert.ok(s.vwapPct != null);
  // Snapshot-Rundung auf 4 Nachkommastellen (wie alle Regel-Felder).
  assert.ok(
    Math.abs(s.vwapPct - ((last - expectedVwap) / expectedVwap) * 100) < 1e-3,
    `vwapPct ${s.vwapPct} vs. Handrechnung ${((last - expectedVwap) / expectedVwap) * 100}`,
  );
});

test("buildSnapshotFromCandles: ohne Volumen kein VWAP — null statt erfundener Neutralität", () => {
  const dayStart = Date.UTC(2026, 0, 5);
  const candles: CandleLike[] = Array.from({ length: 40 }, (_, i) => ({
    time: dayStart + 6 * 3_600_000 + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 0,
  }));
  const s = buildSnapshotFromCandles("BTC", candles, 20)!;
  assert.equal(s.vwapPct, null);

  // null blockiert die Bedingung (fail-closed), statt „unter dem VWAP" zu vorzutäuschen.
  const rule = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "vwapPct", op: "lt", value: 0 }] },
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;
  assert.equal(compileRuleSpec(rule.spec).evaluate(s), false);
});

test("vwapPct-Bedingung feuert nur in der richtigen Richtung", () => {
  const dayStart = Date.UTC(2026, 0, 5);
  // Fallende Serie ⇒ letzter Close unter dem Tages-VWAP ⇒ vwapPct < 0.
  const candles: CandleLike[] = Array.from({ length: 40 }, (_, i) => ({
    time: dayStart + 6 * 3_600_000 + i * 60_000,
    open: 200 - i,
    high: 200 - i,
    low: 200 - i,
    close: 200 - i,
    volume: 10,
  }));
  const s = buildSnapshotFromCandles("BTC", candles, 20)!;
  assert.ok(s.vwapPct != null && s.vwapPct < 0, `erwartet negativ, erhielt ${s.vwapPct}`);

  const under = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "vwapPct", op: "lt", value: 0 }] },
  });
  assert.equal(under.ok, true);
  if (!under.ok) return;
  assert.equal(compileRuleSpec(under.spec).evaluate(s), true);

  const over = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "vwapPct", op: "gt", value: 0 }] },
  });
  assert.equal(over.ok, true);
  if (!over.ok) return;
  assert.equal(compileRuleSpec(over.spec).evaluate(s), false);
});

test("window.timeframe: 1m ist erlaubt (Daytrading-Takt), Unbekanntes fällt auf 15m", () => {
  const with1m = sanitizeRuleSpec({
    ...validInput,
    window: { ...validInput.window, timeframe: "1m" },
  });
  assert.equal(with1m.ok, true);
  if (!with1m.ok) return;
  assert.equal(with1m.spec.window.timeframe, "1m");

  const unknown = sanitizeRuleSpec({
    ...validInput,
    window: { ...validInput.window, timeframe: "2m" },
  });
  assert.equal(unknown.ok, true);
  if (!unknown.ok) return;
  assert.equal(unknown.spec.window.timeframe, "15m", "unbekannter Takt ⇒ sicherer Default 15m");
});

// ── Signatur & Fenster ───────────────────────────────────────────────────────

test("ruleSignature: stabil und änderungssensitiv", () => {
  const a = sanitizeRuleSpec(validInput, "RESEARCH");
  const b = sanitizeRuleSpec({ ...validInput, condition: { logic: "all", conditions: [{ field: "rsi14", op: "lt", value: 25 }] } }, "RESEARCH");
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(ruleSignature(a.spec), ruleSignature(a.spec));
  assert.notEqual(ruleSignature(a.spec), ruleSignature(b.spec));
});

test("isWindowOpen / berlinDayKeyOf: Validity-Fenster wird respektiert", () => {
  const r = sanitizeRuleSpec({
    ...validInput,
    window: { ...validInput.window, validFrom: "2030-01-01T00:00:00Z", validUntil: "2030-01-02T00:00:00Z" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(isWindowOpen(r.spec, new Date("2029-06-01").getTime()), false);
  assert.equal(isWindowOpen(r.spec, new Date("2030-01-01T12:00:00Z").getTime()), true);
  assert.equal(isWindowOpen(r.spec, new Date("2030-06-01").getTime()), false);
  assert.match(berlinDayKeyOf(new Date("2026-08-26T10:00:00Z").getTime()), /^\d{4}-\d{2}-\d{2}$/);
});

// ── Backtest ─────────────────────────────────────────────────────────────────

test("backtestRule: erkennt Dip-Setup und gewinnt beim Take-Profit", () => {
  const r = sanitizeRuleSpec(validInput, "RESEARCH");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Historische Serie mit einem Dip auf RSI<30 und anschließender Erholung.
  const candles = makeCandles(200, { dipAt: 80, dipLen: 15, dipDepth: 12, recoverPerBar: 1.6 });
  const result = backtestRule(r.spec, candles, { startingEquity: 10_000 });
  assert.ok(result.stats.trades >= 1, "mindestens ein Trade");
  assert.ok(result.stats.wins >= 1, "Dip-Regel sollte mindestens einen Winner haben");
  assert.ok(result.stats.pnl > 0, "Gewinn aus Erholung erwartet");
  assert.ok(result.stats.maxDrawdownPct >= 0);
  assert.equal(result.stats.trades, result.trades.length);
  // Jeder Trade hat Stop/Target und eine Begründung.
  for (const t of result.trades) {
    assert.ok(["STOP_LOSS", "TAKE_PROFIT"].includes(t.reason));
    assert.ok(t.exitIndex > t.entryIndex);
  }
});

test("backtestRule: Stop hat Vorrang, wenn SL+TP in derselben Kerze berührt werden", () => {
  const r = sanitizeRuleSpec({
    ...validInput,
    action: { ...validInput.action, stopLossPct: 5, takeProfitRR: 1 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Serie flach (kein Signal), dann eine Kerze mit riesiger Spanne, die in
  // derselben Kerze Stop (low) UND Target (high) berührt → Stop gewinnt.
  const candles = makeCandles(120);
  candles[60] = {
    ...candles[60],
    time: candles[60].time,
    high: 200,
    low: 1,
    close: 100,
  };
  const result = backtestRule(r.spec, candles);
  for (const t of result.trades) {
    assert.equal(t.reason, "STOP_LOSS", "Gleichzeitigkeit → Stop-Vorrang");
  }
});

test("backtestRule: ohne erfüllte Bedingung keine Trades", () => {
  const r = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "rsi14", op: "lt", value: 5 }] },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const result = backtestRule(r.spec, makeCandles(150));
  assert.equal(result.stats.trades, 0);
  assert.equal(result.stats.pnl, 0);
});

// ── bookDepthUsd (v0.4.0, IAD-T-06) ─────────────────────────────────────────

test("buildSnapshotFromCandles: bookDepthUsd wird durchgereicht und fail-closed validiert", () => {
  const candles = makeCandles(120);
  // Tiefe positiv → im Snapshot als Zahl.
  const withDepth = buildSnapshotFromCandles("BTC", candles, 20, 0.0004, 42_000)!;
  assert.equal(withDepth.bookDepthUsd, 42_000);
  // Tiefe null / 0 / negativ → null (nie eine erfundene Tiefe).
  assert.equal(buildSnapshotFromCandles("BTC", candles, 20, 0.0004, null)!.bookDepthUsd, null);
  assert.equal(buildSnapshotFromCandles("BTC", candles, 20, 0.0004, 0)!.bookDepthUsd, null);
  assert.equal(buildSnapshotFromCandles("BTC", candles, 20, 0.0004, -1)!.bookDepthUsd, null);
  // Ohne expliziten Wert (Default) bleibt null.
  assert.equal(buildSnapshotFromCandles("BTC", candles, 20)!.bookDepthUsd, null);
});

test("bookDepthUsd-Bedingung feuert nur bei belastbarer Tiefe (fail-closed null)", () => {
  const candles = makeCandles(120);
  const rule = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "bookDepthUsd", op: "gt", value: 10_000 }] },
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;

  // Ohne Tiefe → null → Bedingung blockiert (false), keine Ausführung.
  const nullSnap = buildSnapshotFromCandles("BTC", candles, 20, null, null)!;
  assert.equal(compileRuleSpec(rule.spec).evaluate(nullSnap), false);

  // Tiefe unter der Schwelle → false.
  const thinSnap = buildSnapshotFromCandles("BTC", candles, 20, null, 5_000)!;
  assert.equal(compileRuleSpec(rule.spec).evaluate(thinSnap), false);

  // Tiefe über der Schwelle → true.
  const deepSnap = buildSnapshotFromCandles("BTC", candles, 20, null, 42_000)!;
  assert.equal(compileRuleSpec(rule.spec).evaluate(deepSnap), true);
});

test("bookDepthUsd ist ein katalogisiertes Whitelist-Feld", async () => {
  const { RULE_FIELDS } = await import("../src/lib/ruleFieldCatalog");
  assert.equal(RULE_FIELDS.bookDepthUsd, "number");
});

// ─────────────────────────────────────────────────────────────────────────────
// STX-01-01 — Rule-Timeframes aus SUPPORTED_TIMEFRAMES (v0.6.2)
//
// Die Tests hier sind rein additiv: kein bestehender Test wurde angefasst. Den
// Beweis „1m…1h unverändert“ führt der Golden-Test mit der Sanitize-Ausgabe
// des Codes VOR der Timeframe-Angleichung (Stand v0.6.1).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RULE_ALLOWED_SIDE,
  RULE_ALLOWED_TIMEFRAMES,
  RULE_FIELDS,
  RULE_LLM_SCHEMA,
} from "../src/lib/ruleEngine";
import { sessionVwap } from "../src/lib/indicators";
import { buildIndicatorCache, snapshotFromCache } from "../src/backtest/indicatorCache";
import { SUPPORTED_TIMEFRAMES, isSupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { telemetry } from "../src/lib/telemetry";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";
import type {
  CachedRule,
  ExecuteContext,
  ExecutionOutcome,
  RuleExecutionAdapter,
} from "../src/lib/microExecutor";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `validInput` mit anderem `window.timeframe` (roh, ungeprüft). */
function withTimeframe(timeframe: unknown) {
  return { ...validInput, window: { ...validInput.window, timeframe } };
}

/** Timeframe, den `sanitizeRuleSpec` für einen rohen Eingabewert liefert. */
function sanitizedTimeframe(raw: unknown): string {
  const r = sanitizeRuleSpec(withTimeframe(raw), "RESEARCH");
  assert.equal(r.ok, true, `Spec muss gültig bleiben (Timeframe ${JSON.stringify(raw)})`);
  if (!r.ok) throw new Error("unreachable");
  return r.spec.window.timeframe;
}

/** Kerzen auf beliebigem Raster: `makeCandles`-Verlauf, Zeitstempel neu gesetzt. */
function seriesAt(n: number, stepMs: number, startMs: number): CandleLike[] {
  return makeCandles(n).map((c, i) => ({ ...c, time: startMs + i * stepMs }));
}

/** `n` Kerzen, deren letzte `barsOnLastDay`-te Kerze ihres UTC-Tages ist (Tag: 2026-01-10). */
function seriesEndingOnBar(n: number, stepMs: number, barsOnLastDay: number): CandleLike[] {
  const lastTime = Date.UTC(2026, 0, 10) + (barsOnLastDay - 1) * stepMs;
  return seriesAt(n, stepMs, lastTime - (n - 1) * stepMs);
}

// ── Single Source of Truth ───────────────────────────────────────────────────

test("STX-01: RULE_ALLOWED_TIMEFRAMES ist aus SUPPORTED_TIMEFRAMES abgeleitet (kein zweites Vokabular)", () => {
  assert.deepEqual([...RULE_ALLOWED_TIMEFRAMES], [...SUPPORTED_TIMEFRAMES]);
  assert.equal(RULE_ALLOWED_TIMEFRAMES.length, 10);

  // Das LLM-Schema liest dieselbe Liste (nicht handgepflegt) — als Kopie, damit
  // kein Schema-Konsument die Allowlist über ein Alias verändern kann.
  const schema = RULE_LLM_SCHEMA as {
    properties: { window: { properties: { timeframe: { enum: string[] } } } };
  };
  const schemaEnum = schema.properties.window.properties.timeframe.enum;
  assert.deepEqual(schemaEnum, [...RULE_ALLOWED_TIMEFRAMES]);
  assert.notEqual(schemaEnum, RULE_ALLOWED_TIMEFRAMES as unknown);
});

test("STX-01: Regel-Pfad, Mikro-Executor und Workshop-Panel pflegen keine eigene Timeframe-Liste", () => {
  // Zwei aufeinanderfolgende Timeframe-Literale sind eine handgepflegte Liste —
  // genau der Fehler, den STX-01 beseitigt (früher `ALLOWED_TIMEFRAMES`,
  // `TIMEFRAME_MS`, Panel-Optionen, Schema-Enum).
  const literal = `["'](?:1m|3m|5m|15m|30m|1h|2h|4h|1d|5d)["']`;
  const handMaintainedList = new RegExp(`${literal}\\s*,\\s*${literal}`);
  for (const file of [
    "src/lib/ruleEngine.ts",
    "src/lib/microExecutor.ts",
    "src/components/workshop/RuleBacktestPanel.tsx",
  ]) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, handMaintainedList, `${file}: handgepflegte Timeframe-Liste`);
    assert.doesNotMatch(source, /\bTIMEFRAME_MS\b/, `${file}: zweite Periodentabelle`);
  }
});

// ── sanitizeRuleSpec: Allowlist ──────────────────────────────────────────────

test("STX-01: sanitizeRuleSpec akzeptiert jeden SupportedTimeframe — insbesondere 4h und 1d", () => {
  assert.equal(sanitizedTimeframe("4h"), "4h");
  assert.equal(sanitizedTimeframe("1d"), "1d");
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.equal(sanitizedTimeframe(timeframe), timeframe, `${timeframe} muss erhalten bleiben`);
  }
});

test("STX-01: sanitizeRuleSpec bleibt fail-closed außerhalb der Allowlist — nie ein durchgereichter Rohwert", () => {
  // „Verwerfen“ heißt hier wie bisher: der Rohwert kommt nicht durch; die Regel
  // läuft auf dem sicheren Default 15m (siehe Test „Unbekanntes fällt auf 15m“).
  const outside: unknown[] = ["2h ", " 1h", "7d", "1w", "2m", "", null, undefined, 15];
  for (const raw of outside) {
    assert.equal(sanitizedTimeframe(raw), "15m", `${JSON.stringify(raw)} ⇒ sicherer Default 15m`);
  }
});

test("STX-01: die Schreibweise wird normalisiert, nicht verworfen (unverändert: \"1H\" → \"1h\")", () => {
  // Bestehende Semantik (per Prompt gesperrt): `sanitizeRuleSpec` kleinschreibt,
  // bevor es gegen die Allowlist prüft. Die strenge Store-Allowlist dagegen lehnt
  // \"1H\" ab — das schützt Reihen vor stiller Vermischung.
  assert.equal(sanitizedTimeframe("1H"), "1h");
  assert.equal(sanitizedTimeframe("4H"), "4h");
  assert.equal(sanitizedTimeframe("1D"), "1d");
  assert.equal(isSupportedTimeframe("1H"), false);
  assert.equal(isSupportedTimeframe("1h"), true);
});

// ── Golden: 1m…1h byte-identisch ─────────────────────────────────────────────

/** Reiche Eingabe: Klemmung aller Ceilings, Normalisierung (Symbol, Trend, Schreibweisen), alle Fensterfelder. */
function goldenInput(timeframe: string) {
  return {
    name: "  Golden — Mean-Reversion mit VWAP/Volumen  ",
    symbol: "eth",
    missionId: " mission-golden ",
    rationale: "  Kaufe überverkaufte Rücksetzer oberhalb der EMA50 bei steigendem Volumen.  ",
    condition: {
      logic: "any",
      conditions: [
        { field: "rsi14", op: "lt", value: 28.5 },
        { field: "volumeRatio", op: "gte", value: "1.3" },
        { field: "trend", op: "in", value: ["up", "flat"] },
        { field: "adx14", op: "between", value: [15, 40] },
        { field: "priceVsEma50Pct", op: "lte", value: -1.5 },
        { field: "vwapPct", op: "lt", value: -0.4 },
        { field: "spreadPct", op: "lt", value: 0.1 },
      ],
    },
    action: { side: "long", stopLossPct: 999, takeProfitRR: 99, riskBudgetPct: 0.99, maxPositionPct: 0.99 },
    window: {
      timeframe,
      validFrom: "2030-01-01T00:00:00Z",
      validUntil: "2030-06-01T00:00:00Z",
      maxExecutionsPerDay: 99,
      cooldownMinutes: 5,
      volumeWindow: 7.9,
    },
    riskScore: 0.42,
    sourceRole: "research",
    unknownKey: "wird verworfen",
  };
}

/**
 * Golden-Fixture: `JSON.stringify(sanitizeRuleSpec(goldenInput(tf), "MANUAL"))` des
 * UNVERÄNDERTEN Codes (v0.6.1, vor STX-01) — mit dem Stand `6e2ebde` erzeugt, nicht
 * mit dem Code unter Test. `%TF%` ist der einzige timeframe-abhängige Teil; die
 * fünf Originalausgaben für 1m|5m|15m|30m|1h unterscheiden sich nur dort.
 */
const GOLDEN_SANITIZE_OUTPUT = `{"ok":true,"spec":{"name":"Golden — Mean-Reversion mit VWAP/Volumen","symbol":"ETH","missionId":"mission-golden","condition":{"logic":"any","conditions":[{"field":"rsi14","op":"lt","value":28.5},{"field":"volumeRatio","op":"gte","value":1.3},{"field":"trend","op":"in","value":["UP","FLAT"]},{"field":"adx14","op":"between","value":[15,40]},{"field":"priceVsEma50Pct","op":"lte","value":-1.5},{"field":"vwapPct","op":"lt","value":-0.4},{"field":"spreadPct","op":"lt","value":0.1}]},"action":{"side":"LONG","stopLossPct":20,"takeProfitRR":5,"riskBudgetPct":0.05,"maxPositionPct":0.5,"positionSizeMode":"risk"},"window":{"timeframe":"%TF%","validFrom":"2030-01-01T00:00:00Z","validUntil":"2030-06-01T00:00:00Z","maxExecutionsPerDay":10,"cooldownMinutes":5,"volumeWindow":7},"rationale":"Kaufe überverkaufte Rücksetzer oberhalb der EMA50 bei steigendem Volumen.","sourceRole":"RESEARCH","riskScore":0.42}}`;
/** `ruleSignature` dieser Regel im Stand v0.6.1 (das Fenster geht nicht ein). */
const GOLDEN_SIGNATURE = "14pm7dk";

test("STX-01 Golden: Sanitize-Ausgabe für 1m|5m|15m|30m|1h ist byte-identisch zum Stand vor der Angleichung", () => {
  for (const timeframe of ["1m", "5m", "15m", "30m", "1h"]) {
    const result = sanitizeRuleSpec(goldenInput(timeframe), "MANUAL");
    assert.equal(
      JSON.stringify(result),
      GOLDEN_SANITIZE_OUTPUT.replace("%TF%", timeframe),
      `${timeframe}: Sanitize-Ausgabe weicht vom Stand vor STX-01 ab`,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(ruleSignature(result.spec), GOLDEN_SIGNATURE, `${timeframe}: Regel-Signatur verändert`);
  }
});

test("STX-01: der Timeframe ist der einzige Unterschied — Ceilings, LONG-Zwang und Felder gelten auf allen zehn gleich", () => {
  const stripTimeframe = (spec: { window: object }) => ({ ...spec, window: { ...spec.window, timeframe: "*" } });
  const reference = sanitizeRuleSpec(goldenInput("15m"), "MANUAL");
  assert.equal(reference.ok, true);
  if (!reference.ok) return;
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const r = sanitizeRuleSpec(goldenInput(timeframe), "MANUAL");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(stripTimeframe(r.spec), stripTimeframe(reference.spec), `${timeframe}: weicht jenseits des Timeframes ab`);
  }
  // Shorts bleiben global gesperrt — auch auf den neuen Timeframes.
  for (const timeframe of ["4h", "1d"]) {
    const short = sanitizeRuleSpec(
      { ...withTimeframe(timeframe), action: { ...validInput.action, side: "SHORT" } },
      "RESEARCH",
    );
    assert.equal(short.ok, false, `SHORT auf ${timeframe} muss abgelehnt werden`);
  }
});

test("STX-01: RULE_ALLOWED_SIDE, RULE_CEILINGS und die bekannten RULE_FIELDS sind unverändert", () => {
  assert.equal(RULE_ALLOWED_SIDE, "LONG");
  assert.deepEqual(JSON.parse(JSON.stringify(RULE_CEILINGS)), {
    stopLossPct: [0.5, 20],
    takeProfitRR: [0.5, 5],
    riskBudgetPct: [0.002, 0.05],
    maxPositionPct: [0.01, 0.5],
    fixedNotional: [0, 1_000_000],
    maxExecutionsPerDay: [1, 10],
    cooldownMinutes: [0, 1440],
    volumeWindow: [5, 200],
    maxConditions: 12,
    maxConditionItems: 24,
  });
  // Additiv geprüft: Kein Feld darf verschwinden oder den Typ wechseln; neue
  // Felder (Phase 2 der Strategie-Roadmap) bleiben dadurch möglich.
  const known: Record<string, string> = {
    price: "number", rsi14: "number", ema9: "number", ema21: "number", ema50: "number",
    atrPct: "number", volume: "number", volumeMa20: "number", volumeRatio: "number",
    changePct24h: "number", priceVsEma21Pct: "number", priceVsEma50Pct: "number",
    trend: "trend", adx14: "number", bbwPct: "number", macd: "number", macdSignal: "number",
    macdHist: "number", vwapPct: "number", spreadPct: "number", bookDepthUsd: "number",
  };
  for (const [field, kind] of Object.entries(known)) {
    assert.equal((RULE_FIELDS as Record<string, string>)[field], kind, `RULE_FIELDS.${field}`);
  }
});

// ── vwapPct auf hohen Timeframes (fail-closed) ───────────────────────────────

test("STX-01: vwapPct === null auf 1d und 5d — eine Kerze je UTC-Tag ergibt keinen VWAP", () => {
  for (const stepMs of [DAY_MS, 5 * DAY_MS]) {
    const candles = seriesAt(60, stepMs, Date.UTC(2026, 0, 1));
    const snapshot = buildSnapshotFromCandles("BTC", candles, 20);
    assert.ok(snapshot, "der Snapshot selbst bleibt gültig");
    assert.equal(snapshot.vwapPct, null, "null — nie 0");
    assert.notEqual(snapshot.vwapPct, 0);
    assert.equal(sessionVwap(candles), null);
    assert.ok(Number.isFinite(snapshot.rsi14) && Number.isFinite(snapshot.volumeRatio), "übrige Felder unberührt");
  }
});

test("STX-01: vwapPct ist null, solange weniger als zwei Kerzen am UTC-Tag liegen — ab der zweiten gibt es einen Wert", () => {
  const steps: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": HOUR_MS, "2h": 2 * HOUR_MS, "4h": 4 * HOUR_MS };
  for (const [timeframe, stepMs] of Object.entries(steps)) {
    const firstBar = buildSnapshotFromCandles("BTC", seriesEndingOnBar(60, stepMs, 1), 20);
    assert.ok(firstBar, timeframe);
    assert.equal(firstBar.vwapPct, null, `${timeframe}: erste Kerze des UTC-Tages ⇒ kein VWAP`);

    const secondBar = buildSnapshotFromCandles("BTC", seriesEndingOnBar(60, stepMs, 2), 20);
    assert.ok(secondBar, timeframe);
    assert.equal(typeof secondBar.vwapPct, "number", `${timeframe}: ab der zweiten Kerze ein Messwert`);
  }
});

test("STX-01: eine vwapPct-Bedingung ist auf 1d fail-closed (null blockiert), auf Intraday-Daten erfüllbar", () => {
  const rule = sanitizeRuleSpec({
    ...withTimeframe("1d"),
    condition: { logic: "all", conditions: [{ field: "vwapPct", op: "lt", value: 50 }] },
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;
  const compiled = compileRuleSpec(rule.spec);

  const daily = buildSnapshotFromCandles("BTC", seriesAt(60, DAY_MS, Date.UTC(2026, 0, 1)), 20)!;
  assert.equal(compiled.evaluate(daily), false, "1d: kein VWAP ⇒ Bedingung bleibt false");

  const hourly = buildSnapshotFromCandles("BTC", seriesEndingOnBar(60, HOUR_MS, 12), 20)!;
  assert.equal(compiled.evaluate(hourly), true, "1h: VWAP vorhanden ⇒ Bedingung auswertbar");

  // Und im Backtest: dieselbe Regel auf Tageskerzen handelt nie, auf Stundenkerzen schon.
  const onDaily = backtestRule(rule.spec, seriesAt(200, DAY_MS, Date.UTC(2026, 0, 1)));
  assert.equal(onDaily.stats.trades, 0, "1d-Backtest läuft, aber vwapPct blockiert jede Bedingung");
  const onHourly = backtestRule(rule.spec, seriesAt(200, HOUR_MS, Date.UTC(2026, 0, 1)));
  assert.ok(onHourly.stats.trades > 0, "Kontrolle: auf Stundenkerzen handelt dieselbe Regel");
});

test("STX-01: der Engine-Pfad (snapshotFromCache) stimmt mit buildSnapshotFromCandles überein — 1d/5d beide null", () => {
  for (const [stepMs, expectNull] of [[DAY_MS, true], [5 * DAY_MS, true], [HOUR_MS, false]] as const) {
    const candles = seriesAt(120, stepMs, Date.UTC(2026, 0, 1));
    const cache = buildIndicatorCache(candles);
    for (const idx of [60, 100, 119]) {
      const viaCache = snapshotFromCache("BTC", candles, cache, idx, 20);
      const direct = buildSnapshotFromCandles("BTC", candles.slice(0, idx + 1), 20);
      assert.ok(viaCache && direct, `idx ${idx}`);
      if (expectNull) {
        assert.equal(viaCache.vwapPct, null);
        assert.equal(direct.vwapPct, null);
      } else {
        assert.ok(viaCache.vwapPct !== null && direct.vwapPct !== null);
        assert.ok(Math.abs(viaCache.vwapPct - direct.vwapPct) <= 1e-4, `idx ${idx}: VWAP-Parität`);
      }
    }
  }
});

test("STX-01: RULE_CEILINGS.volumeWindow (5…200) bleibt auf 1d sinnvoll — das Fenster zählt Kerzen, nicht Stunden", () => {
  assert.deepEqual([...RULE_CEILINGS.volumeWindow], [5, 200]);
  const daily = seriesAt(60, DAY_MS, Date.UTC(2026, 0, 1));
  for (const volumeWindow of [5, 20, 200]) {
    const snapshot = buildSnapshotFromCandles("BTC", daily, volumeWindow)!;
    const used = daily.slice(-Math.min(volumeWindow, daily.length));
    const mean = used.reduce((sum, c) => sum + c.volume, 0) / used.length;
    assert.ok(Math.abs(snapshot.volumeMa20 - mean) < 1e-9, `Fenster ${volumeWindow}`);
    assert.ok(Math.abs(snapshot.volumeRatio - daily[daily.length - 1].volume / mean) < 1e-9);
  }
  // Die Klemmung der Regel selbst ist timeframe-unabhängig: 5 Tageskerzen = eine Handelswoche.
  for (const [raw, expected] of [[1, 5], [1000, 200]] as const) {
    const r = sanitizeRuleSpec({ ...withTimeframe("1d"), window: { ...validInput.window, timeframe: "1d", volumeWindow: raw } });
    assert.equal(r.ok && r.spec.window.volumeWindow, expected);
  }
});

// ── Micro-Executor-Guard: längerer Timeframe als das Ausführungsintervall ───

/** Zeichnet Aufrufe auf — kein Broker, keine DB. */
class RecordingRuleAdapter implements RuleExecutionAdapter {
  readonly name = "recording";
  readonly calls: ExecuteContext[] = [];
  async execute(ctx: ExecuteContext): Promise<ExecutionOutcome> {
    this.calls.push(ctx);
    return { status: "TRIGGERED", ruleId: ctx.ruleId, symbol: ctx.snapshot.symbol, at: new Date().toISOString() };
  }
}

/** Regel, die auf jedem Snapshot greift (`price > 0`) — der Timeframe entscheidet allein. */
function alwaysMatchingRule(timeframe: string, id: string): CachedRule {
  const r = sanitizeRuleSpec({
    ...validInput,
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: 0 }] },
    window: { timeframe, maxExecutionsPerDay: 10, cooldownMinutes: 0, volumeWindow: 20 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  return {
    rowId: id,
    ruleKey: id,
    version: 1,
    symbol: r.spec.symbol,
    missionId: null,
    name: r.spec.name,
    spec: r.spec,
    compiled: compileRuleSpec(r.spec),
    executionsToday: 0,
    firedAt: 0,
    cooldownMs: 0,
  };
}

test("STX-01 Micro-Executor-Guard: 1d-Regel auf 1m-Ausführungsintervall → keine Order, genau ein Telemetrie-Counter", async () => {
  // Erst hier geladen: microExecutor zieht das DB-Modul (ohne Verbindungsaufbau) —
  // alle übrigen Tests dieser Datei bleiben im Import-Graph DB-frei.
  const { MicroExecutor, RuleCache, SequenceFeed } = await import("../src/lib/microExecutor");

  const minute = 60_000;
  const history = seriesAt(120, minute, 1_700_000_000_000);
  const firstTick = history[history.length - 1].time + minute;
  // Ein Minutenraster: pro Minute mehrere Trades (Preis fällt), 30 Minuten lang.
  const ticks = Array.from({ length: 30 * 4 }, (_, i) => ({
    kind: "trade" as const,
    symbol: "BTC",
    ts: firstTick + Math.floor(i / 4) * minute + (i % 4) * 1000,
    price: 100 - i * 0.01,
    qty: 10,
  }));

  async function run(timeframe: string) {
    const logs: StructuredLogEntry[] = [];
    setStructuredLogSinkForTests((entry) => logs.push(entry));
    telemetry.microExecutor.reset();
    try {
      const cache = new RuleCache();
      cache._seedForTest([alwaysMatchingRule(timeframe, `rule-${timeframe}`)]);
      const adapter = new RecordingRuleAdapter();
      const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false, executionInterval: "1m" } });
      executor.addSymbol("BTC", "1m", history); // das Intervall-Raster des Executors
      executor.registerFeed(new SequenceFeed(ticks));
      await executor.start();
      const status = executor.status();
      await executor.stop();
      return {
        orders: adapter.calls.length,
        counter: telemetry.microExecutor.ruleBlocked.total(),
        byLabel: telemetry.microExecutor.ruleBlocked.byLabel(),
        logs: logs.filter((entry) => entry.event === "micro_executor_rule_blocked"),
        status,
      };
    } finally {
      setStructuredLogSinkForTests(null);
    }
  }

  const blocked = await run("1d");
  assert.equal(blocked.orders, 0, "keine Position aus einer Regel, die länger als das Intervall ist");
  assert.equal(blocked.counter, 1, "genau ein Telemetrie-Counter — je Regel einmal, nicht je Tick");
  assert.deepEqual(blocked.byLabel, { "reason=timeframe_exceeds_interval,timeframe=1d": 1 });
  assert.equal(blocked.logs.length, 1, "genau ein strukturierter Log-Eintrag");
  assert.equal(blocked.logs[0].level, "warn");
  assert.deepEqual(blocked.logs[0].fields, {
    ruleId: "rule-1d",
    ruleKey: "rule-1d",
    version: 1,
    symbol: "BTC",
    timeframe: "1d",
    executionInterval: "1m",
    reason: "timeframe_exceeds_interval",
    effect: "Regel wird nicht ausgewertet; aus ihr wird keine Position eröffnet.",
  });
  assert.ok(blocked.status.ticksProcessed > 0, "der Feed lief — die Regel wurde bewusst nicht bewertet");
  assert.deepEqual(blocked.status.ruleGuard, {
    executionInterval: "1m",
    blocked: [{ ruleId: "rule-1d", symbol: "BTC", timeframe: "1d", reason: "timeframe_exceeds_interval" }],
  });

  // Kontrolle: dieselbe Regel auf dem Raster des Intervalls (1m) handelt auf demselben Feed —
  // das Ausbleiben der Order oben ist also der Guard, nicht ein toter Testaufbau.
  const control = await run("1m");
  assert.ok(control.orders > 0, "Kontrolle: die 1m-Regel löst auf demselben Feed aus");
  assert.equal(control.counter, 0, "kein Counter, wenn nichts abgewiesen wurde");
  assert.equal(control.logs.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// STX-02-02 — Bollinger-Regelfelder (bbZScore, priceVsUpperBbPct, priceVsLowerBbPct)
//
// Rein additiv: `bbwPct` und alle übrigen Felder bleiben unangetastet; die
// neuen Felder beschreiben die POSITION im Band statt der Breite. Die
// Parität Direktpfad ↔ Indikator-Cache prüft `tests/backtest.multiAsset.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

import { RULE_FIELD_LABELS, RULE_FIELD_SCHEMA_HINTS } from "../src/lib/ruleFieldCatalog";
import { bollingerBands, bollingerPosition } from "../src/lib/indicators";

/** Reihe mit ±1 % um 100 — Bandbreite und Lage sind dort beide nichttrivial. */
function bandCandles(n = 60): CandleLike[] {
  return makeCandles(n).map((c, i) => {
    const close = 100 + Math.sin(i / 2.5) * 1.2;
    return {
      ...c,
      open: close * 0.999,
      high: close * 1.005,
      low: close * 0.995,
      close,
    };
  });
}

/** Dieselbe Kerzenreihe, aber alle Schlusskurse identisch (σ == 0). */
function flatCandles(n = 60, price = 100): CandleLike[] {
  return makeCandles(n).map((c) => ({ ...c, open: price, high: price, low: price, close: price }));
}

test("STX-02-02: die drei Felder stehen in RULE_FIELDS, RULE_FIELD_LABELS und im LLM-Schema", () => {
  for (const field of ["bbZScore", "priceVsUpperBbPct", "priceVsLowerBbPct"] as const) {
    assert.equal(RULE_FIELDS[field], "number", `RULE_FIELDS.${field}`);
    assert.ok(RULE_FIELDS[field] === "number" && RULE_FIELD_SCHEMA_HINTS[field], `${field}: LLM-Hinweis`);
  }
  // Deutsche Labels mit Einheit im Text (Muster `vwapPct`), keine nackten Feldnamen.
  assert.match(RULE_FIELD_LABELS.bbZScore, /Standardabweichung/i);
  assert.match(RULE_FIELD_LABELS.priceVsUpperBbPct, /Prozent/);
  assert.match(RULE_FIELD_LABELS.priceVsLowerBbPct, /Prozent/);

  const schema = RULE_LLM_SCHEMA as {
    properties: {
      condition: {
        properties: { conditions: { items: { properties: { field: { enum: string[]; description: string } } } } };
      };
    };
  };
  const fieldProp = schema.properties.condition.properties.conditions.items.properties.field;
  for (const field of ["bbZScore", "priceVsUpperBbPct", "priceVsLowerBbPct"]) {
    assert.ok(fieldProp.enum.includes(field), `${field} fehlt im Schema-enum`);
    assert.ok(fieldProp.description.includes(field), `${field} fehlt in der Schema-Beschreibung`);
    assert.ok(fieldProp.description.includes(RULE_FIELD_SCHEMA_HINTS[field as "bbZScore"]!), `${field}: Beispielwerte/Einheit`);
  }
  // Bestehende Felder unverändert im enum — nichts entfernt, nichts umbenannt.
  for (const field of ["bbwPct", "rsi14", "vwapPct", "bookDepthUsd"]) {
    assert.ok(fieldProp.enum.includes(field));
  }
});

test("STX-02-02: sanitizeRuleSpec akzeptiert die drei Felder (auch case-insensitiv) und klemmt weiter", () => {
  const raw = {
    ...validInput,
    condition: {
      logic: "all",
      conditions: [
        { field: "BBZSCORE", op: "gt", value: 2 },
        { field: "priceVsUpperBbPct", op: "gte", value: 0 },
        { field: "priceVsLowerBbPct", op: "between", value: [-1, 1] },
      ],
    },
    // Ceilings: 999/99/0.99/0.99 sind außerhalb und werden geklemmt.
    action: { side: "long", stopLossPct: 999, takeProfitRR: 99, riskBudgetPct: 0.99, maxPositionPct: 0.99 },
  };
  const r = sanitizeRuleSpec(raw, "RESEARCH");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.spec.condition.conditions.map((c) => [c.field, c.op, c.value]),
    [
      ["bbZScore", "gt", 2],
      ["priceVsUpperBbPct", "gte", 0],
      ["priceVsLowerBbPct", "between", [-1, 1]],
    ],
  );
  assert.equal(r.spec.action.side, "LONG");
  assert.deepEqual(
    [r.spec.action.stopLossPct, r.spec.action.takeProfitRR, r.spec.action.riskBudgetPct, r.spec.action.maxPositionPct],
    [RULE_CEILINGS.stopLossPct[1], RULE_CEILINGS.takeProfitRR[1], RULE_CEILINGS.riskBudgetPct[1], RULE_CEILINGS.maxPositionPct[1]],
  );
});

test("STX-02-02: unbekannte Felder bleiben verworfen — auch die nahen Verwandten", () => {
  for (const field of ["bbUpper", "bollingerUpper", "bbMiddle", "bbSigma", "priceVsUpperBb"]) {
    const r = sanitizeRuleSpec({
      ...validInput,
      condition: { logic: "all", conditions: [{ field, op: "gt", value: 1 }] },
    });
    assert.equal(r.ok, false, `${field} darf nicht durchkommen`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("unbekanntes Feld")), field);
  }
});

test("STX-02-02: buildSnapshotFromCandles füllt die Lage im Band — auf 4 Dezimalstellen wie bbwPct", () => {
  const candles = bandCandles(60);
  const price = candles[candles.length - 1].close;
  const snapshot = buildSnapshotFromCandles("BTC", candles, 20)!;
  const reading = bollingerBands(candles.map((c) => c.close))!;
  const expected = bollingerPosition(price, reading)!;

  assert.equal(snapshot.bbZScore, Number(expected.zScore!.toFixed(4)));
  assert.equal(snapshot.priceVsUpperBbPct, Number(expected.priceVsUpperPct.toFixed(4)));
  assert.equal(snapshot.priceVsLowerBbPct, Number(expected.priceVsLowerPct.toFixed(4)));
  // bbwPct bleibt der Breitenwert (unveränderte Semantik) und ist mit dem Band konsistent.
  assert.ok(Math.abs(snapshot.bbwPct! - Number((reading.bandwidthPct * 100).toFixed(4))) < 1e-9);
  // Die Kantenabstände liegen typisch ≤ 0 bzw. ≥ 0 — hier nicht an der Kante.
  assert.ok(snapshot.priceVsUpperBbPct! <= 0 && snapshot.priceVsLowerBbPct! >= 0);
});

test("STX-02-02: Breakout über die obere Kante ist am Vorzeichen ablesbar", () => {
  const candles = bandCandles(59);
  // Ausbruchskerze: Schlusskurs deutlich über der oberen Kante der 20 Vorkerzen.
  const prior = bollingerBands(candles.map((c) => c.close))!;
  const breakout = prior.upper * 1.01;
  const last = candles[candles.length - 1];
  candles.push({ ...last, time: last.time + 60_000, open: last.close, high: breakout, low: last.close, close: breakout });
  const snapshot = buildSnapshotFromCandles("BTC", candles, 20)!;
  assert.equal(typeof snapshot.bbZScore, "number");
  assert.ok(snapshot.bbZScore! > 2, `zScore ${snapshot.bbZScore} muss über der oberen Kante liegen`);
  assert.ok(snapshot.priceVsUpperBbPct! > 0, "positiv = über der oberen Kante");
});

test("STX-02-02: σ == 0 ⇒ bbZScore null (nie 0), Kantenabstände bleiben gemessen", () => {
  const flat = flatCandles(60);
  const snapshot = buildSnapshotFromCandles("BTC", flat, 20)!;
  assert.equal(snapshot.bbZScore, null, "flache Reihe: keine Lage im Band");
  assert.notEqual(snapshot.bbZScore, 0);
  assert.equal(snapshot.bbwPct, 0, "die Breite bleibt eine echte 0");
  assert.equal(snapshot.priceVsUpperBbPct, 0);
  assert.equal(snapshot.priceVsLowerBbPct, 0);
});

test("STX-02-02: middle <= 0 ⇒ alle drei Felder null (kein Band, keine Division)", () => {
  const negative = makeCandles(60).map((c) => ({ ...c, open: -5, high: -4, low: -6, close: -5 }));
  const snapshot = buildSnapshotFromCandles("BTC", negative, 20)!;
  assert.equal(snapshot.bbwPct, null);
  assert.equal(snapshot.bbZScore, null);
  assert.equal(snapshot.priceVsUpperBbPct, null);
  assert.equal(snapshot.priceVsLowerBbPct, null);
});

test("STX-02-02: zu wenig Historie ⇒ kein Snapshot (und damit keine erfundenen Bandwerte)", () => {
  assert.equal(buildSnapshotFromCandles("BTC", bandCandles(24), 20), null);
  assert.equal(buildSnapshotFromCandles("BTC", bandCandles(19), 20), null, "unter der Bollinger-Periode");
  // Ab 25 Kerzen gibt es den Snapshot und damit auch die Bandlage.
  const from25 = buildSnapshotFromCandles("BTC", bandCandles(25), 20)!;
  assert.equal(typeof from25.bbZScore, "number");
  assert.equal(typeof from25.priceVsUpperBbPct, "number");
});

test("STX-02-02: null blockiert die Bedingung fail-closed — eine 0 wäre eine erfundene Lage", () => {
  for (const [field, op, value] of [
    ["bbZScore", "gt", 0],
    ["priceVsUpperBbPct", "gte", 0],
    ["priceVsLowerBbPct", "lte", 0],
  ] as const) {
    const rule = sanitizeRuleSpec({
      ...validInput,
      condition: { logic: "all", conditions: [{ field, op, value }] },
    });
    assert.equal(rule.ok, true, field);
    if (!rule.ok) return;
    const compiled = compileRuleSpec(rule.spec);
    // Flache Reihe: `bbZScore` ist null (blockiert), die Kantenabstände sind
    // echte 0-Messwerte (feuern) — genau die im Feldkatalog dokumentierte Grenze.
    const flat = buildSnapshotFromCandles("BTC", flatCandles(60), 20)!;
    assert.equal(compiled.evaluate(flat), field !== "bbZScore", `${field} auf flacher Reihe`);
  }
});

test("STX-02-02: Kompilierung liest die neuen Felder aus dem Snapshot (Accessor vorhanden)", () => {
  const rule = sanitizeRuleSpec({
    ...validInput,
    condition: {
      logic: "all",
      conditions: [
        { field: "bbZScore", op: "between", value: [-2, 0] },
        { field: "priceVsUpperBbPct", op: "lt", value: 0 },
        { field: "priceVsLowerBbPct", op: "gt", value: 0 },
      ],
    },
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;
  const compiled = compileRuleSpec(rule.spec);
  assert.equal(compiled.evaluate(snap), true, "snap-Fixture liegt innerhalb der Schwellen");
  assert.equal(compiled.evaluate({ ...snap, bbZScore: null }), false);
  assert.equal(compiled.evaluate({ ...snap, priceVsUpperBbPct: null }), false);
  assert.equal(compiled.evaluate({ ...snap, priceVsLowerBbPct: null }), false);
  assert.equal(compiled.evaluate({ ...snap, bbZScore: 0.5 }), false, "über der Obergrenze des between");
});

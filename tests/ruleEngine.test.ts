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
  macd: -0.4,
  macdSignal: -0.2,
  macdHist: -0.2,
  vwapPct: 1.25,
  spreadPct: 0.04,
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

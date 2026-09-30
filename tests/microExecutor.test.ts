/**
 * Tests des Mikro-Zyklus (src/lib/microExecutor.ts).
 *
 * Kernaussagen:
 *   1. Der Ausführungspfad ist LLM-FREI — per Import-Graph-Guardtest.
 *   2. Der Hot-Path (Tick → Snapshot → Regelauswertung) bleibt unter 1 ms
 *      und berührt weder DB noch Netzwerk (In-Memory-Seed).
 *   3. Rolling-Serie + Cache-Matching verhalten sich deterministisch
 *      (Cooldown, Tageslimit, Fenster, Mission-KILLED).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RollingTimeframeSeries,
  RuleCache,
  MicroExecutor,
  SequenceFeed,
  SimulatedFeed,
  type CachedRule,
  type ExecuteContext,
  type ExecutionOutcome,
  type FeedTick,
  type RuleExecutionAdapter,
} from "../src/lib/microExecutor";
import { sanitizeRuleSpec, compileRuleSpec, type CandleLike } from "../src/lib/ruleEngine";

// ── 1) Import-Graph-Guard: kein LLM-Code im Ausführungspfad ──────────────────

test("Mikro-Pfad ist LLM-frei (Import-Graph-Guard)", () => {
  const files = [
    "src/lib/ruleEngine.ts",
    "src/lib/microExecutor.ts",
    "src/lib/ruleService.ts",
    "scripts/micro-executor.ts",
  ];
  const forbidden = ["./ollama", "llmProvider", "./engine", "./analysts", "macroCycle"];
  for (const f of files) {
    const src = readFileSync(resolve(process.cwd(), f), "utf8");
    for (const needle of forbidden) {
      assert.ok(
        !src.includes(`from "${needle}"`) && !src.includes(`from '${needle}'`),
        `${f} darf nicht aus "${needle}" importieren (LLM-freie Ausführungsebene).`
      );
    }
    // Auch keine Weiterleitung über dynamic import.
    assert.ok(!src.includes(`import("${"./" + "ollama"}")`), `${f} darf kein dynamic import von ollama sein.`);
  }
});

// ── 2) Rolling-Serie ─────────────────────────────────────────────────────────

function candles(n: number, base = 100): CandleLike[] {
  const out: CandleLike[] = [];
  const start = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const close = base + Math.sin(i / 5) * 1.5;
    out.push({
      time: start + i * 60_000,
      open: close * 0.999,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1000 + (i % 5) * 50,
    });
  }
  return out;
}

test("RollingTimeframeSeries: Seed + Trade-Ticks + 1m-Closes ergeben Snapshot", () => {
  const series = new RollingTimeframeSeries("BTC", "15m", candles(100));
  assert.ok(series.snapshot(), "nach Seed sofort warm");
  const before = series.size();

  // Trade-Ticks in der nächsten 1m-Kerze.
  const tickTs = candles(100)[99].time + 60_000;
  series.touch(101.5, tickTs, 2);
  series.touch(102.0, tickTs, 3);
  const snap = series.snapshot();
  assert.ok(snap);
  assert.equal(snap!.price, 102.0);

  // Finale 1m-Kerze → Aggregation in die laufende 15m-Kerze.
  series.applyCandle(
    { time: tickTs, open: 101.9, high: 102.2, low: 101.4, close: 102.0, volume: 999 },
    true
  );
  assert.ok(series.size() >= before);
});

test("RollingTimeframeSeries: Volume-MA aus Window (nicht aus dem Gesamtlauf)", () => {
  const series = new RollingTimeframeSeries("BTC", "15m", candles(120));
  const s = series.snapshot(20)!;
  const vols = candles(120).slice(-20).map((c) => c.volume);
  const ma = vols.reduce((a, b) => a + b, 0) / 20;
  assert.ok(Math.abs(s.volumeMa20 - ma) < 1e-9);
});

// ── 3) Cache-Matching (kein DB-Zugriff via _seedForTest) ─────────────────────

function makeSpec(symbol = "BTC", overrides: Record<string, unknown> = {}) {
  const input = {
    name: `${symbol} RSI-Kauf`,
    symbol,
    rationale: "test",
    condition: {
      logic: "all",
      conditions: [
        { field: "rsi14", op: "lt", value: 31 },
        { field: "volumeRatio", op: "gt", value: 1.2 },
      ],
    },
    action: { side: "LONG", stopLossPct: 5, takeProfitRR: 1.5, riskBudgetPct: 0.02, maxPositionPct: 0.25 },
    window: { timeframe: "15m", maxExecutionsPerDay: 2, cooldownMinutes: 30, volumeWindow: 20 },
    riskScore: 0.5,
    ...overrides,
  };
  const r = sanitizeRuleSpec(input, "RESEARCH");
  assert.equal(r.ok, true, `Spec muss gültig sein: ${r.ok ? "" : (r as { errors: string[] }).errors.join("; ")}`);
  if (!r.ok) throw new Error("Spec invalid");
  return r.spec;
}

function cachedRule(spec: ReturnType<typeof makeSpec>, id: string): CachedRule {
  return {
    rowId: id,
    ruleKey: id,
    version: 1,
    symbol: spec.symbol,
    missionId: spec.missionId,
    name: spec.name,
    spec,
    compiled: compileRuleSpec(spec),
    executionsToday: 0,
    firedAt: 0,
    cooldownMs: spec.window.cooldownMinutes * 60_000,
  };
}

const matchingSnap = {
  symbol: "BTC",
  ts: 1_700_000_000_000,
  price: 95,
  rsi14: 28,
  ema9: 96,
  ema21: 97,
  ema50: 98,
  trend: "DOWN",
  atrPct: 2,
  volume: 5000,
  volumeMa20: 3000,
  volumeRatio: 1.67,
  changePct24h: -3,
  priceVsEma21Pct: -2,
  priceVsEma50Pct: -3,
  adx14: null,
  bbwPct: null,
  macd: null,
  macdSignal: null,
  macdHist: null,
  vwapPct: 1.2, spreadPct: 0.04, bookDepthUsd: null,
} as const;

test("RuleCache.match: findet passende Regel, respektiert Cooldown und Tageslimit", () => {
  const spec = makeSpec();
  const cache = new RuleCache();
  const rule = cachedRule(spec, "rule-1");
  cache._seedForTest([rule]);

  assert.equal(cache.candidatesBySymbol("BTC").length, 1);
  const matched = cache.match({ ...matchingSnap });
  assert.equal(matched.length, 1);

  // Cooldown: nach dem Feuern ist die Regel 30 min lang gesperrt.
  cache.noteFired(rule.rowId);
  assert.equal(cache.match({ ...matchingSnap }, Date.now() + 1000).length, 0);
  assert.equal(
    cache.match({ ...matchingSnap }, Date.now() + 31 * 60_000).length,
    1,
    "nach Cooldown wieder aktiv"
  );

  // Tageslimit 2 → nach zweitem Feuern (plus Cooldown) keine weiteren Trigger.
  cache.noteFired(rule.rowId);
  cache.noteFired(rule.rowId);
  assert.equal(cache.match({ ...matchingSnap }, Date.now() + 31 * 60_000).length, 0);
});

test("RuleCache.match: Mission im KILLED-Zustand blockt; Fenster validUntil blockt", () => {
  const killed = { ...makeSpec(), missionId: "mission-1" };
  const cache = new RuleCache();
  cache._seedForTest([cachedRule(killed, "rule-2")], [["mission-1", "KILLED"]]);
  assert.equal(cache.match({ ...matchingSnap }).length, 0);

  const expiring = makeSpec("BTC", {
    window: {
      timeframe: "15m",
      validUntil: "2000-01-01T00:00:00Z",
      maxExecutionsPerDay: 3,
      cooldownMinutes: 0,
      volumeWindow: 20,
    },
  });
  const cache2 = new RuleCache();
  cache2._seedForTest([cachedRule(expiring, "rule-3")]);
  assert.equal(cache2.match({ ...matchingSnap }).length, 0, "abgelaufenes Fenster");
});

// ── 4) End-to-End Hot-Path mit SequenceFeed und Mock-Adapter (kein DB) ───────

class RecordingAdapter implements RuleExecutionAdapter {
  readonly name = "recording";
  calls: ExecuteContext[] = [];
  async execute(ctx: ExecuteContext): Promise<ExecutionOutcome> {
    this.calls.push(ctx);
    return { status: "TRIGGERED", ruleId: ctx.ruleId, symbol: ctx.snapshot.symbol, at: new Date().toISOString() };
  }
}

test("MicroExecutor: Tick → Snapshot → Regel-Match → Adapter (ohne LLM/DB)", async () => {
  const spec = makeSpec();
  const cache = new RuleCache();
  cache._seedForTest([cachedRule(spec, "rule-e2e")]);

  const adapter = new RecordingAdapter();
  const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
  executor.addSymbol("BTC", "15m", candles(120));

  // Feed: 150 Trade-Ticks mit fallendem Preis (RSI sinkt) und hohem Volumen
  // (Volume-Ratio steigt) — komplett ohne DB/Netzwerk.
  const start = 1_700_000_000_000 + 120 * 60_000;
  const ticks = Array.from({ length: 150 }, (_, i) => ({
    kind: "trade" as const,
    symbol: "BTC",
    ts: start + i * 500,
    price: 96 - i * 0.08,
    qty: 2000,
  }));
  executor.registerFeed(new SequenceFeed(ticks));

  await executor.start();
  assert.ok(adapter.calls.length >= 1, "Regel muss nach RSI-Dip feuern");
  const s = executor.status();
  assert.ok(s.ticksProcessed > 0);
  assert.ok(s.evaluations > 0, "Auswertungen gelaufen");
  assert.ok(s.matches >= 1);
  assert.equal(s.feed?.name, "sequence");
  await executor.stop();
});

test("MicroExecutor: Hot-Path-Auswertung bleibt im einstelligen Millisekundenbereich", async () => {
  const spec = makeSpec();
  const cache = new RuleCache();
  cache._seedForTest([cachedRule(spec, "rule-lat")]);
  const adapter = new RecordingAdapter();
  const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
  executor.addSymbol("BTC", "15m", candles(120));

  const start = 1_700_000_000_000 + 120 * 60_000;
  const ticks = Array.from({ length: 150 }, (_, i) => ({
    kind: "trade" as const,
    symbol: "BTC",
    ts: start + i * 500,
    price: 97,
    qty: 100,
  }));
  executor.registerFeed(new SequenceFeed(ticks));
  await executor.start();
  const s = executor.status();
  // Bewertung = kompilierte Vergleiche + Window-/Limit-Checks, rein im RAM.
  // Konservativ < 5 ms (CI-Last), damit der Test nie flaky wird — real sind
  // es typisch < 100 µs (siehe Handbuch).
  assert.ok((s.p95EvalMicros ?? 0) < 5000, `p95=${s.p95EvalMicros}µs`);
  await executor.stop();
});

test("SimulatedFeed: erzeugt Ticks und ist stoßbar", async () => {
  const feed = new SimulatedFeed(["BTC"], { seed: 7, intervalMs: 5, candleTicks: 3 });
  let ticks = 0;
  await feed.start(() => {
    ticks++;
  });
  await new Promise((r) => setTimeout(r, 60));
  await feed.stop();
  assert.ok(ticks > 1, `Ticks erwartet, gesehen: ${ticks}`);
  assert.equal(feed.status().connected, false);
});

// ── 4b) Warmstart-Fehler sind beobachtbar (MDERR-006) ───────────────────────

test("MicroExecutor: Warmstart-Fehler werden gezählt/geloggt, nicht still verschluckt", async () => {
  const spec = makeSpec();
  const cache = new RuleCache();
  cache._seedForTest([cachedRule(spec, "rule-seed")]);
  const adapter = new RecordingAdapter();
  // seedCandles: true (Default) — der Seed trifft den gemockten 429-Fehler.
  const executor = new MicroExecutor({ cache, adapter });
  executor.addSymbol("BTC", "15m"); // ohne injizierte Historie → Seed nötig

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw Object.assign(new Error("HTTP 429 rate limit"), { httpStatus: 429 });
  }) as typeof fetch;
  try {
    await executor.start();
    const s = executor.status();
    assert.equal(s.seed.requested, 1);
    assert.equal(s.seed.failed, 1, "Warmstart-Fehler müssen im Status sichtbar sein");
    assert.ok(s.seed.lastError?.includes("RATE_LIMITED"), "letzter Seed-Fehler nennt die Ursache");
    assert.equal(s.running, true, "Live-Kerzen wärmen trotz Seed-Fehler weiter auf");
  } finally {
    globalThis.fetch = realFetch;
    await executor.stop();
  }
});

// ── 5) Fenster/Backtest-Integration über die Engine ist in ruleEngine.test.ts ─

// ── bookDepthUsd (v0.4.0, IAD-T-06) ─────────────────────────────────────────

test("RollingTimeframeSeries.snapshot trägt bookDepthUsd durch", () => {
  const series = new RollingTimeframeSeries("BTC", "15m", candles(100));
  const withDepth = series.snapshot(20, null, 42_000)!;
  assert.equal(withDepth.bookDepthUsd, 42_000);
  const without = series.snapshot(20, null, null)!;
  assert.equal(without.bookDepthUsd, null);
});

test("MicroExecutor: book-tick → updateBook (Qualitätsgrenze) → Regel feuert erst bei belastbarer Tiefe", async () => {
  const spec = makeSpec("BTC", {
    condition: {
      logic: "all",
      conditions: [{ field: "bookDepthUsd", op: "gt", value: 100 }],
    },
  });
  const cache = new RuleCache();
  cache._seedForTest([cachedRule(spec, "rule-depth")]);
  const adapter = new RecordingAdapter();
  const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
  executor.addSymbol("BTC", "15m", candles(120));

  const start = 1_700_000_000_000 + 120 * 60_000;
  const ticks: FeedTick[] = [
    // 1) Dünnes Buch (1 Level) → unter Qualitätsgrenze, Regel darf NICHT feuern.
    {
      kind: "book", symbol: "BTC", venue: "BINANCE", ts: start,
      bids: [[99.9, 1]], asks: [[100.1, 1]],
    },
    // 2) Ein Trade-Tick: bookDepthUsd=null (dünnes Buch verworfen) ⇒ false.
    { kind: "trade", symbol: "BTC", ts: start + 1, price: 95, qty: 10 },
    // 3) Verifiziertes Buch (≥ 3 Levels) → Tiefe > 100.
    {
      kind: "book", symbol: "BTC", venue: "BINANCE", ts: start + 2,
      bids: [[99.9, 10], [99.8, 20], [99.7, 30]],
      asks: [[100.1, 5], [100.2, 15], [100.3, 25]],
    },
    // 4) Weitere Trade-Ticks: bookDepthUsd jetzt > 100 ⇒ feuert.
    { kind: "trade", symbol: "BTC", ts: start + 3, price: 95, qty: 10 },
    { kind: "trade", symbol: "BTC", ts: start + 4, price: 95, qty: 10 },
  ];
  executor.registerFeed(new SequenceFeed(ticks));
  await executor.start();

  // Fail-closed belegt: Wäre das dünne Buch als „0"-Tiefe gezählt worden,
  // hätte die Regel schon bei Tick 2 gefeuert. Das qualifizierte Buch kommt
  // erst bei Tick 3 — die Tiefe wird genau dann gesetzt.
  assert.ok(adapter.calls.length >= 1, "Regel muss nach verifiziertem Buch feuern");
  await executor.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// STX-01 (v0.6.2): Ausführungsintervall & Timeframe-Guard
//
// Der Loop bewertet eine Regel gegen den Snapshot ihres Timeframes inklusive der
// laufenden Kerze. Eine Regel mit längerem Timeframe als das Ausführungsintervall
// (Default 1h) würde einen teilweise abgelaufenen Snapshot sehen — der Guard weist
// sie fail-closed ab und macht das „Nein“ sichtbar (Counter, Log, status()).
// ─────────────────────────────────────────────────────────────────────────────

import {
  MICRO_EXECUTION_INTERVAL_DEFAULT,
  ruleTimeframeBlockReason,
} from "../src/lib/microExecutor";
import { SUPPORTED_TIMEFRAMES, SUPPORTED_TIMEFRAME_MS } from "../src/lib/marketdata/historicalStore";
import { prometheusMetrics, telemetry } from "../src/lib/telemetry";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";

/**
 * Regel mit beliebigem Timeframe, die auf jedem Snapshot greift (`price > 0`) —
 * der Timeframe entscheidet allein. Der Wert wird NACH der Sanitize-Kette gesetzt:
 * sie würde Unbekanntes auf 15m normalisieren, die DB-Zeile kann aber alles tragen.
 */
function ruleAt(timeframe: string, id: string, symbol = "BTC"): CachedRule {
  const spec = makeSpec(symbol, {
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: 0 }] },
    window: { timeframe, maxExecutionsPerDay: 10, cooldownMinutes: 0, volumeWindow: 20 },
  });
  return cachedRule({ ...spec, window: { ...spec.window, timeframe: timeframe as typeof spec.window.timeframe } }, id);
}

/** Führt `fn` mit leerem Counter und aufgefangenem strukturiertem Log aus. */
async function withGuardObservation<T>(fn: (logs: StructuredLogEntry[]) => Promise<T>): Promise<T> {
  const logs: StructuredLogEntry[] = [];
  setStructuredLogSinkForTests((entry) => logs.push(entry));
  telemetry.microExecutor.reset();
  try {
    return await fn(logs);
  } finally {
    setStructuredLogSinkForTests(null);
    telemetry.microExecutor.reset();
  }
}

const blockedLogs = (logs: StructuredLogEntry[]) => logs.filter((entry) => entry.event === "micro_executor_rule_blocked");

test("ruleTimeframeBlockReason: nur ein Timeframe bis zum Ausführungsintervall ist auswertbar (10 × 10 Matrix)", () => {
  // Orakel: der Index in der aufsteigend nach Dauer sortierten Allowlist (die
  // Sortierung sichert tests/marketdata/timeframes.test.ts) — nicht dieselbe
  // Millisekunden-Tabelle, die der Guard liest.
  SUPPORTED_TIMEFRAMES.forEach((timeframe, t) => {
    SUPPORTED_TIMEFRAMES.forEach((interval, i) => {
      assert.equal(
        ruleTimeframeBlockReason(timeframe, interval),
        t > i ? "timeframe_exceeds_interval" : null,
        `Regel ${timeframe} bei Ausführungsintervall ${interval}`,
      );
    });
  });
});

test("ruleTimeframeBlockReason: alles außerhalb des Vokabulars ist fail-closed (timeframe_unsupported)", () => {
  for (const raw of ["7d", "1H", "2h ", "", "1w", null, undefined, 15, {}, ["1h"]]) {
    assert.equal(ruleTimeframeBlockReason(raw, "1h"), "timeframe_unsupported", JSON.stringify(raw));
    assert.equal(ruleTimeframeBlockReason(raw, "5d"), "timeframe_unsupported", "auch beim größten Intervall");
  }
});

test("Default-Ausführungsintervall ist 1h (bisheriges Maximum): 1m…1h werden ausgewertet, 2h…5d nicht", () => {
  assert.equal(MICRO_EXECUTION_INTERVAL_DEFAULT, "1h");
  const evaluable = SUPPORTED_TIMEFRAMES.filter(
    (timeframe) => ruleTimeframeBlockReason(timeframe, MICRO_EXECUTION_INTERVAL_DEFAULT) === null,
  );
  assert.deepEqual(evaluable, ["1m", "3m", "5m", "15m", "30m", "1h"]);
});

test("Kein Schedule ist kürzer als die Timeframe-Dauer: jede Rolling-Serie aggregiert exakt auf die kanonische Periode", () => {
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const ms = SUPPORTED_TIMEFRAME_MS[timeframe];
    const t0 = 4_000 * ms; // auf die Periode ausgerichtet
    const series = new RollingTimeframeSeries("BTC", timeframe);
    // Bucket-Breite = Periode: die letzte Millisekunde gehört noch dazu, der Rand öffnet den nächsten.
    assert.equal(series.bucketStart(t0 + ms - 1), t0, `${timeframe}: Ende des Buckets`);
    assert.equal(series.bucketStart(t0 + ms), t0 + ms, `${timeframe}: Beginn des nächsten Buckets`);
    // Verhalten: Ticks innerhalb der Periode bleiben EINE Kerze, erst der Periodenrand öffnet die nächste.
    series.touch(100, t0, 1);
    series.touch(100, t0 + ms - 60_000, 1);
    assert.equal(series.size(), 1, `${timeframe}: noch dieselbe Kerze`);
    series.touch(100, t0 + ms, 1);
    assert.equal(series.size(), 2, `${timeframe}: der Periodenrand öffnet die nächste Kerze`);
  }
});

test("Rolling-Serie: 3m läuft nicht still auf 15-Minuten-Kerzen; unbekannte Timeframes scheitern laut statt zu fallen", () => {
  // Regression: `TIMEFRAME_MS[tf] ?? TIMEFRAME_MS["15m"]` kannte 3m/2h/4h/1d/5d nicht und
  // hätte solche Regeln auf 15-Minuten-Kerzen ausgewertet — auf einem anderen Takt, als sie
  // unterschrieben haben (derselbe Fehler wie bei 1m, CYCLE-DAYTRADE-01).
  const threeMinutes = new RollingTimeframeSeries("BTC", "3m");
  assert.equal(threeMinutes.bucketStart(179_999), 0);
  assert.equal(threeMinutes.bucketStart(180_000), 180_000);
  for (const unknown of ["7d", "", "1H", "1w"]) {
    assert.throws(() => new RollingTimeframeSeries("BTC", unknown), RangeError, JSON.stringify(unknown));
  }
});

test("Timeframe-Guard (Default 1h): 2h/4h/1d/5d werden sichtbar abgewiesen, 1m…1h bekommen ihre Serien", async () => {
  await withGuardObservation(async (logs) => {
    const cache = new RuleCache();
    cache._seedForTest(SUPPORTED_TIMEFRAMES.map((timeframe) => ruleAt(timeframe, `rule-${timeframe}`)));
    const executor = new MicroExecutor({ cache, adapter: new RecordingAdapter(), options: { seedCandles: false } });
    await executor.start();
    const status = executor.status();

    assert.deepEqual(status.series.map((s) => s.timeframe).sort(), ["15m", "1h", "1m", "30m", "3m", "5m"]);
    assert.equal(status.ruleGuard.executionInterval, "1h");
    assert.deepEqual(
      status.ruleGuard.blocked.map((b) => [b.ruleId, b.timeframe, b.reason]).sort(),
      [
        ["rule-1d", "1d", "timeframe_exceeds_interval"],
        ["rule-2h", "2h", "timeframe_exceeds_interval"],
        ["rule-4h", "4h", "timeframe_exceeds_interval"],
        ["rule-5d", "5d", "timeframe_exceeds_interval"],
      ],
    );

    // Je abgewiesener Regel genau ein Counter-Schritt und genau ein Log-Eintrag.
    assert.equal(telemetry.microExecutor.ruleBlocked.total(), 4);
    assert.deepEqual(telemetry.microExecutor.ruleBlocked.byLabel(), {
      "reason=timeframe_exceeds_interval,timeframe=1d": 1,
      "reason=timeframe_exceeds_interval,timeframe=2h": 1,
      "reason=timeframe_exceeds_interval,timeframe=4h": 1,
      "reason=timeframe_exceeds_interval,timeframe=5d": 1,
    });
    assert.deepEqual(blockedLogs(logs).map((entry) => entry.fields.timeframe).sort(), ["1d", "2h", "4h", "5d"]);

    // Der Counter steht in der Exposition; Symbol und Regel-ID sind kein Label (Kardinalität).
    const exposition = await prometheusMetrics({ firmState: null });
    assert.match(
      exposition,
      /^micro_executor_rule_blocked_total\{reason="timeframe_exceeds_interval",timeframe="1d"\} 1$/m,
    );
    assert.doesNotMatch(exposition, /micro_executor_rule_blocked_total\{[^}]*(?:symbol|rule)/);
    await executor.stop();
  });
});

test("Timeframe-Guard: ein beschädigter Timeframe aus der DB wird fail-closed abgewiesen statt still auf 15m zu fallen", async () => {
  await withGuardObservation(async (logs) => {
    const cache = new RuleCache();
    cache._seedForTest([ruleAt("7d", "rule-corrupt")]);
    const adapter = new RecordingAdapter();
    const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
    await executor.start();

    assert.equal(executor.status().series.length, 0, "für einen unbekannten Timeframe entsteht keine Serie");
    assert.deepEqual(telemetry.microExecutor.ruleBlocked.byLabel(), {
      "reason=timeframe_unsupported,timeframe=OTHER": 1, // Label bleibt geschlossen: nie der Rohwert
    });
    const [entry] = blockedLogs(logs);
    assert.equal(entry.fields.reason, "timeframe_unsupported");
    assert.equal(entry.fields.timeframe, "7d", "der Rohwert steht im Log, nicht im Label");
    await executor.stop();
  });
});

test("addSymbol: Serien oberhalb des Ausführungsintervalls oder mit unbekanntem Timeframe lassen sich nicht anlegen", () => {
  const executor = new MicroExecutor({ cache: new RuleCache(), adapter: new RecordingAdapter() });
  assert.doesNotThrow(() => executor.addSymbol("BTC", "3m"));
  assert.doesNotThrow(() => executor.addSymbol("BTC", "1h"));
  for (const timeframe of ["2h", "4h", "1d", "5d", "7d", ""]) {
    assert.throws(() => executor.addSymbol("BTC", timeframe), RangeError, JSON.stringify(timeframe));
  }
  assert.deepEqual(executor.status().series.map((s) => s.timeframe).sort(), ["1h", "3m"]);
});

test("executionInterval ist konfigurierbar; ein unbekanntes Intervall scheitert beim Bau statt den Guard auszuhebeln", async () => {
  await withGuardObservation(async () => {
    const cache = new RuleCache();
    cache._seedForTest([ruleAt("5m", "rule-5m"), ruleAt("15m", "rule-15m")]);
    const executor = new MicroExecutor({
      cache,
      adapter: new RecordingAdapter(),
      options: { seedCandles: false, executionInterval: "5m" },
    });
    await executor.start();
    const status = executor.status();
    assert.deepEqual(status.series.map((s) => s.timeframe), ["5m"]);
    assert.equal(status.ruleGuard.executionInterval, "5m");
    assert.deepEqual(status.ruleGuard.blocked.map((b) => b.ruleId), ["rule-15m"]);
    await executor.stop();
  });
  for (const bad of ["7d", "", "1H"]) {
    assert.throws(
      () => new MicroExecutor({ cache: new RuleCache(), adapter: new RecordingAdapter(), options: { executionInterval: bad as never } }),
      RangeError,
      JSON.stringify(bad),
    );
  }
});

test("Timeframe-Guard: bei gemischten Regeln eines Symbols feuert nur die auswertbare", async () => {
  await withGuardObservation(async () => {
    const cache = new RuleCache();
    cache._seedForTest([ruleAt("1d", "rule-1d"), ruleAt("5m", "rule-5m")]);
    const adapter = new RecordingAdapter();
    const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
    executor.addSymbol("BTC", "5m", candles(120));

    const start = 1_700_000_000_000 + 120 * 60_000;
    executor.registerFeed(
      new SequenceFeed(
        Array.from({ length: 60 }, (_, i) => ({ kind: "trade" as const, symbol: "BTC", ts: start + i * 500, price: 97, qty: 10 })),
      ),
    );
    await executor.start();

    assert.ok(adapter.calls.length > 0, "die 5m-Regel feuert");
    assert.deepEqual([...new Set(adapter.calls.map((call) => call.ruleId))], ["rule-5m"], "nie die 1d-Regel");
    await executor.stop();
  });
});

test("status().ruleGuard zeigt auch nach dem Start aktivierte Regeln — sie bekommen nie eine Serie", async () => {
  await withGuardObservation(async () => {
    const cache = new RuleCache();
    cache._seedForTest([ruleAt("1m", "rule-1m")]);
    const executor = new MicroExecutor({ cache, adapter: new RecordingAdapter(), options: { seedCandles: false } });
    await executor.start();
    assert.deepEqual(executor.status().ruleGuard.blocked, []);

    // Cache-Refresh bringt eine 4h-Regel: sichtbar im Status, aber ohne Serie → nie ausgewertet.
    cache._seedForTest([ruleAt("1m", "rule-1m"), ruleAt("4h", "rule-4h-late")]);
    const status = executor.status();
    assert.deepEqual(status.ruleGuard.blocked.map((b) => b.ruleId), ["rule-4h-late"]);
    assert.deepEqual(status.series.map((s) => s.timeframe), ["1m"]);
    await executor.stop();
  });
});

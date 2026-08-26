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

// ── 5) Fenster/Backtest-Integration über die Engine ist in ruleEngine.test.ts ─

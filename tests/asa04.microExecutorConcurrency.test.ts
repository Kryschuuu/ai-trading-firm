import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BinanceTradeFeed, MicroExecutor, RuleCache, RollingTimeframeSeries, triggeredRuleAuditPayload,
  type ExecuteContext, type FeedStatus, type FeedTick, type MarketFeed, type RuleCacheSnapshot,
  type RuleExecutionAdapter,
} from "../src/lib/microExecutor";
import { sanitizeRuleSpec, type CandleLike } from "../src/lib/ruleEngine";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(5);
  }
}
function row(symbol = "BTC", timeframe = "15m", version = 7): RuleCacheSnapshot["rows"][number] {
  const result = sanitizeRuleSpec({
    name: `${symbol} test`, symbol, rationale: "test",
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: 0 }] },
    action: { side: "LONG", stopLossPct: 5, takeProfitRR: 1.5, riskBudgetPct: 0.02, maxPositionPct: 0.25 },
    window: { timeframe, maxExecutionsPerDay: 10, cooldownMinutes: 10, volumeWindow: 20 }, riskScore: 0.5,
  }, "MANUAL");
  assert.ok(result.ok);
  const spec = result.spec;
  return { id: symbol, ruleKey: symbol, version, status: "ACTIVE", name: spec.name,
    symbol, missionId: null, condition: spec.condition, action: spec.action, window: spec.window,
    rationale: spec.rationale, riskScore: "0.5", sourceRole: "MANUAL" } as RuleCacheSnapshot["rows"][number];
}
const candles = (): CandleLike[] => Array.from({ length: 100 }, (_, i) => ({
  time: Date.now() - (100 - i) * 900_000, open: 100, high: 101, low: 99, close: 100, volume: 100,
}));
const tick = (symbol = "BTC"): FeedTick => ({ kind: "trade", symbol, ts: Date.now(), price: 100, qty: 1 });
const snap = () => new RollingTimeframeSeries("BTC", "15m", candles()).snapshot()!;
class PushFeed implements MarketFeed {
  readonly name = "push"; readonly urlHint = null;
  callback: ((tick: FeedTick) => void) | undefined;
  symbols = new Set<string>();
  async start(cb: (tick: FeedTick) => void) { this.callback = cb; }
  async stop() { this.callback = undefined; }
  async updateSymbols(symbols: string[]) { symbols.forEach((s) => this.symbols.add(s)); }
  emit(t: FeedTick) { if (this.symbols.has(t.symbol)) this.callback?.(t); }
  status(): FeedStatus { return { name: this.name, url: null, connected: !!this.callback, lastTickAt: null, ticks: 0, errors: 0 }; }
}

test("cooldown survives repeated refresh, DB counts are not doubled, restart restores last fired", async () => {
  let count = 0;
  let lastFiredAt: Date | null = null;
  const cache = new RuleCache(60_000, async () => ({ rows: [row()], missionRows: [], countRows: [{ ruleId: "BTC", c: count, lastFiredAt }] }));
  await cache.start();
  try {
    assert.equal(cache.match(snap()).length, 1);
    cache.noteFired("BTC"); count = 1; lastFiredAt = new Date();
    for (let i = 0; i < 3; i++) {
      cache.invalidate(); await cache.load();
      assert.equal(cache.status().executionsToday.BTC, 1);
      assert.equal(cache.match(snap()).length, 0);
      assert.equal(cache.match(snap(), Date.now() + 601_000).length, 1);
    }
    const restarted = new RuleCache(60_000, async () => ({ rows: [row()], missionRows: [], countRows: [{ ruleId: "BTC", c: count, lastFiredAt }] }));
    await restarted.load();
    assert.equal(restarted.match(snap()).length, 0);
  } finally { await cache.stop(); }
});

test("five simultaneous ticks execute once; snapshot waits for execution commit and accounting", async () => {
  let count = 0, calls = 0, reads = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const cache = new RuleCache(60_000, async () => { reads++; return { rows: [row()], missionRows: [], countRows: [{ ruleId: "BTC", c: count }] }; });
  const adapter: RuleExecutionAdapter = { name: "slow", async execute(ctx) {
    calls++; await wait; count++; return { status: "TRIGGERED", ruleId: ctx.ruleId, symbol: "BTC", at: new Date().toISOString() };
  } };
  const feed = new PushFeed();
  const executor = new MicroExecutor({ cache, adapter, options: { seedCandles: false } });
  executor.addSymbol("BTC", "15m", candles()); executor.registerFeed(feed);
  await executor.start();
  try {
    for (let i = 0; i < 5; i++) feed.emit(tick());
    await until(() => calls === 1);
    cache.invalidate();
    const refresh = cache.load();
    await sleep(50);
    assert.equal(reads, 1, "read must not overlap pending order");
    release(); await refresh;
    assert.equal(calls, 1);
    assert.equal(cache.status().executionsToday.BTC, 1);
    assert.equal(cache.match(snap()).length, 0);
  } finally { release(); await executor.stop(); }
});

test("runtime rules warm new symbol and timeframe, update feed and pass real version", async () => {
  let rows = [row()];
  const cache = new RuleCache(60_000, async () => ({ rows, missionRows: [], countRows: [] }));
  const feed = new PushFeed(); const warmed: string[] = []; const calls: ExecuteContext[] = [];
  const executor = new MicroExecutor({ cache, adapter: { name: "record", async execute(ctx) {
    calls.push(ctx); return { status: "TRIGGERED", ruleId: ctx.ruleId, symbol: ctx.spec.symbol, at: new Date().toISOString() };
  } }, options: { candleLoader: async (symbol, timeframe) => { warmed.push(`${symbol}:${timeframe}`); return candles(); } } });
  executor.registerFeed(feed); await executor.start();
  try {
    rows = [row(), row("ETH", "5m", 9)]; cache.invalidate(); await cache.load();
    await until(() => feed.symbols.has("ETH"));
    assert.equal(warmed.filter((s) => s === "ETH:5m").length, 1);
    feed.emit(tick("ETH")); await until(() => calls.length === 1);
    assert.equal(calls[0].version, 9);
    assert.equal(triggeredRuleAuditPayload(calls[0], "ETH", "order", 2, 3).version, 9);
  } finally { await executor.stop(); }
});

test("Binance updates subscriptions on the existing websocket and retains them on reconnect", async () => {
  type Fake = { onopen: (() => void) | null; onclose: (() => void) | null; sent: string[]; url: string; close(): void; send(s: string): void };
  const sockets: Fake[] = [];
  const original = globalThis.WebSocket;
  class FakeSocket implements Fake {
    onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage = null; onerror = null; sent: string[] = [];
    constructor(public url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.onclose?.(); }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const feed = new BinanceTradeFeed(["BTC"]);
  try {
    await feed.start(() => undefined); await until(() => sockets.length === 1);
    sockets[0].onopen?.(); await feed.updateSymbols(["ETH"]);
    assert.deepEqual(JSON.parse(sockets[0].sent[0]).params, ["ethusdt@trade", "ethusdt@kline_1m", "ethusdt@depth5"]);
    await feed.updateSymbols(["ETH"]); assert.equal(sockets[0].sent.length, 1);
    sockets[0].onclose?.(); await until(() => sockets.length === 2);
    assert.match(sockets[1].url, /ethusdt@trade/);
  } finally { await feed.stop(); globalThis.WebSocket = original; }
});

test("lock is released after error; a DB read blocks new orders until it completes", async () => {
  let calls = 0, reads = 0, releaseRead!: () => void;
  const paused = new Promise<void>((resolve) => { releaseRead = resolve; });
  const cache = new RuleCache(60_000, async () => {
    if (++reads === 2) await paused;
    return { rows: [row()], missionRows: [], countRows: [] };
  });
  const feed = new PushFeed();
  const executor = new MicroExecutor({ cache, adapter: { name: "error", async execute(ctx) {
    calls++; if (calls === 1) throw new Error("expected");
    return { status: "BLOCKED", ruleId: ctx.ruleId, symbol: ctx.spec.symbol, at: new Date().toISOString() };
  } }, options: { seedCandles: false } });
  executor.addSymbol("BTC", "15m", candles()); executor.registerFeed(feed); await executor.start();
  try {
    feed.emit(tick()); await until(() => executor.status().errors === 1); await sleep(0);
    feed.emit(tick()); await until(() => calls === 2); await sleep(0);
    cache.invalidate(); const refresh = cache.load(); await until(() => reads === 2);
    feed.emit(tick()); await sleep(10); assert.equal(calls, 2);
    releaseRead(); await refresh;
    feed.emit(tick()); await until(() => calls === 3);
  } finally { releaseRead(); await executor.stop(); }
});

test("overlapping notifications deduplicate a new timeframe warmup", async () => {
  let rows = [row()]; let release!: () => void; let warms = 0;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const cache = new RuleCache(60_000, async () => ({ rows, missionRows: [], countRows: [] }));
  const executor = new MicroExecutor({ cache, adapter: { name: "unused", async execute(ctx) {
    return { status: "BLOCKED", ruleId: ctx.ruleId, symbol: ctx.spec.symbol, at: new Date().toISOString() };
  } }, options: { candleLoader: async (_symbol, timeframe) => {
    if (timeframe === "5m") { warms++; await paused; }
    return candles();
  } } });
  executor.registerFeed(new PushFeed()); await executor.start();
  try {
    rows = [row(), { ...row("BTC", "5m"), id: "new" }];
    cache.invalidate(); await cache.load(); await until(() => warms === 1);
    cache.invalidate(); await cache.load(); release();
    await until(() => executor.status().series.some((s) => s.timeframe === "5m"));
    await sleep(20); assert.equal(warms, 1);
  } finally { release(); await executor.stop(); }
});

/**
 * P1 Enrichment-Tests: ticker and orderbook enrichment for instrument discovery.
 *
 * Coverage:
 *  - enrichWithTickers(): bulk, Bulk-Lücke → Einzel-Ticker-Fallback (Symbol-
 *    Guard), offene Lücke → failure statt Exception, quoteVol
 *  - enrichWithOrderBooks(): depth limit=5, concurrency, empty/crossed/implausible → null
 *  - market sync enriches volume24h and spread
 *  - eligibility rejects unknown spread explicitly
 *  - rejection payload carries candles/volume24h/spread context
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateRelativeSpread } from "../../src/marketdata/spread";
import { enrichWithTickers, enrichWithOrderBooks } from "../../src/marketdata/enrichment";
import type { MarketDataAdapter } from "../../src/marketdata/sync";
import type { MarketInstrument, MarketOrderBook, MarketTicker } from "../../src/marketdata/types";
import { InstrumentRegistry } from "../../src/universe/registry";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { MarketDataSyncService } from "../../src/marketdata/sync";
import { checkEligibility } from "../../src/scanner/filters";
import { buildEligibilityDiagnostics } from "../../src/scanner/eligibilityDiagnostics";
import { loadScannerConfig } from "../../src/scanner/config";
import type { FilterRejection } from "../../src/scanner/filters";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function instrument(symbol: string, venue = "BITUNIX"): MarketInstrument {
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    assetClass: "crypto",
    marketType: "perpetual",
    status: "active",
    minQuantity: 0.001,
    priceStep: 0.1,
    quantityStep: 0.001,
    makerFee: 0.0002,
    takerFee: 0.0006,
    leverageAvailable: true,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: "2026-08-01T00:00:00.000Z",
  };
}

function ticker(symbol: string, quoteVol: number | null = 1_000_000, baseVol: number | null = null): MarketTicker {
  return {
    symbol,
    price: 100,
    source: "mock",
    ts: 1,
    quoteVol,
    baseVol,
  };
}

function book(symbol: string, bid: number, ask: number, empty = false): MarketOrderBook {
  if (empty) {
    return { symbol, bids: [], asks: [], ts: 1 };
  }
  return {
    symbol,
    bids: [{ price: bid, qty: 1 }],
    asks: [{ price: ask, qty: 1 }],
    ts: 1,
  };
}

function mockAdapter(opts: {
  instruments?: MarketInstrument[];
  tickers?: MarketTicker[];
  ticker?: (symbol: string) => Promise<MarketTicker>;
  book?: (symbol: string) => Promise<MarketOrderBook>;
  failDepthFor?: Set<string>;
}): { adapter: MarketDataAdapter; calls: { tickers: number; depth: string[]; ticker: string[] } } {
  const calls = { tickers: 0, depth: [] as string[], ticker: [] as string[] };
  const instruments = opts.instruments ?? [instrument("BTCUSDT")];
  const adapter: MarketDataAdapter = {
    async discoverInstruments() {
      return instruments;
    },
    async getTicker(symbol) {
      calls.ticker.push(symbol);
      if (opts.ticker) return opts.ticker(symbol);
      return ticker(symbol);
    },
    async getOrderBook(symbol) {
      calls.depth.push(symbol);
      if (opts.failDepthFor?.has(symbol)) throw new Error(`depth failed for ${symbol}`);
      if (opts.book) return opts.book(symbol);
      return book(symbol, 100, 100.02);
    },
    async getCandles() {
      return [];
    },
  };
  if (opts.tickers !== undefined) {
    adapter.getTickers = async (symbols) => {
      calls.tickers += 1;
      // Return only tickers for symbols that exist in opts.tickers, simulating missing entries
      if (symbols) {
        return opts.tickers!.filter((t) => symbols.includes(t.symbol));
      }
      return opts.tickers!;
    };
  } else {
    // default bulk returns all
    adapter.getTickers = async (symbols) => {
      calls.tickers += 1;
      const list = symbols ?? instruments.map((i) => i.symbol);
      return list.map((s) => ticker(s, 1_000_000));
    };
  }
  return { adapter, calls };
}

// ── 1. market sync enriches 24h volume ───────────────────────────────────────

test("market sync enriches 24h volume", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "enrich-"));
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const history = new HistoricalStore(path.join(dir, "history"));
  const instruments = [instrument("BTCUSDT")];
  const { adapter } = mockAdapter({
    instruments,
    tickers: [ticker("BTCUSDT", 2_500_000)],
  });
  const service = new MarketDataSyncService(registry, history, new Map([["BITUNIX", adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    requiredWarmupCandles: 61,
  });
  await service.syncVenue("BITUNIX");
  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.ok((btc!.volume24h ?? 0) > 0, `volume24h erwartet >0, war ${btc!.volume24h}`);
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. market sync calculates spread from best bid/ask ───────────────────────

test("market sync calculates spread from best bid/ask", () => {
  const spread = calculateRelativeSpread(100, 100.02);
  assert.ok(spread !== null);
  assert.ok(Math.abs(spread - 0.00019998) < 1e-8, `erwartet ≈0.00019998, war ${spread}`);
});

test("enrichWithOrderBooks calculates spread from best bid/ask", async () => {
  const instruments = [instrument("BTCUSDT")];
  const { adapter } = mockAdapter({
    instruments,
    book: async () => book("BTCUSDT", 100, 100.02),
  });
  const { spreadBySymbol } = await enrichWithOrderBooks(instruments, adapter, { depthLimit: 5, concurrency: 2 });
  const spread = spreadBySymbol.get("BTCUSDT");
  assert.ok(spread !== null);
  assert.ok(Math.abs(spread! - 0.00019998) < 1e-8);
});

// ── 3. missing ticker entry: Lücken-Fallback, sonst sichtbarer failure ───────

test("missing ticker entry yields null volume, not an exception", async () => {
  const instruments = [instrument("BTCUSDT"), instrument("ETHUSDT")];
  const { adapter, calls } = mockAdapter({
    instruments,
    tickers: [ticker("BTCUSDT", 1_000_000)], // ETH missing
  });
  const { volumeBySymbol, report } = await enrichWithTickers(instruments, adapter);
  assert.equal(volumeBySymbol.get("BTCUSDT"), 1_000_000);
  // Bulk-Lücke → genau EIN Einzel-Ticker-Versuch (Symbol-Guard) schließt sie.
  assert.deepEqual(calls.ticker, ["ETHUSDT"], "Lücken-Fallback per Einzel-Ticker");
  assert.equal(volumeBySymbol.get("ETHUSDT"), 1_000_000, "Fallback schließt die Bulk-Lücke");
  assert.equal(report.failures.length, 0);

  // Scheitert auch der Fallback, bleibt der Wert null und die Lücke wird als
  // failure sichtbar — weiterhin KEIN Throw (Sync läuft weiter).
  const failing = mockAdapter({
    instruments,
    tickers: [ticker("BTCUSDT", 1_000_000)],
    ticker: async () => {
      throw new Error("ticker down");
    },
  });
  const second = await enrichWithTickers(instruments, failing.adapter);
  assert.equal(second.volumeBySymbol.get("BTCUSDT"), 1_000_000);
  assert.equal(second.volumeBySymbol.get("ETHUSDT"), null);
  assert.ok(second.report.missing.includes("BITUNIX:ETHUSDT") || second.report.missing.includes("ETHUSDT"));
  assert.ok(
    second.report.failures.some((f) => f.symbol === "ETHUSDT"),
    "offene Lücke muss als failure sichtbar sein, nicht still als enriched zählen",
  );
});

// ── 4. depth failure for one symbol does not abort enrichment ────────────────

test("depth failure for one symbol does not abort enrichment", async () => {
  const instruments = [instrument("BTCUSDT"), instrument("ETHUSDT"), instrument("SOLUSDT")];
  const failSet = new Set(["ETHUSDT"]);
  const { adapter } = mockAdapter({
    instruments,
    failDepthFor: failSet,
    book: async (symbol) => {
      if (symbol === "ETHUSDT") throw new Error("depth down");
      return book(symbol, 99, 101);
    },
  });
  const { spreadBySymbol, report } = await enrichWithOrderBooks(instruments, adapter, {
    depthLimit: 5,
    concurrency: 2,
  });
  assert.ok(spreadBySymbol.get("BTCUSDT") !== null);
  assert.equal(spreadBySymbol.get("ETHUSDT"), null);
  assert.ok(spreadBySymbol.get("SOLUSDT") !== null);
  assert.equal(report.attempted, 3);
  assert.equal(report.succeeded, 2);
  assert.ok(report.failures.some((f) => f.symbol === "ETHUSDT"));
  assert.ok(report.missing.length >= 1);
});

// ── 5. empty order book yields spread=null ──────────────────────────────────

test("empty order book yields spread=null", async () => {
  const instruments = [instrument("BTCUSDT")];
  const { adapter } = mockAdapter({
    instruments,
    book: async () => book("BTCUSDT", 0, 0, true),
  });
  const { spreadBySymbol } = await enrichWithOrderBooks(instruments, adapter, { depthLimit: 5, concurrency: 1 });
  assert.equal(spreadBySymbol.get("BTCUSDT"), null);
});

// ── 6. crossed book (ask < bid) yields spread=null and a warning ────────────

test("crossed book (ask < bid) yields spread=null and a warning", async () => {
  const instruments = [instrument("BTCUSDT")];
  const warnings: string[] = [];
  const { adapter } = mockAdapter({
    instruments,
    book: async () => book("BTCUSDT", 102, 101), // crossed
  });
  const { spreadBySymbol } = await enrichWithOrderBooks(instruments, adapter, {
    depthLimit: 5,
    concurrency: 1,
    logger: (lvl, line) => {
      if (lvl === "warn") warnings.push(line);
    },
  });
  assert.equal(spreadBySymbol.get("BTCUSDT"), null);
  assert.ok(warnings.length > 0, "expected warning for crossed book");
  assert.ok(warnings[0].toLowerCase().includes("crossed") || warnings[0].includes("BTCUSDT"));
});

// ── 7. implausible spread > 50% is rejected as null ──────────────────────────

test("implausible spread > 50% is rejected as null", async () => {
  const instruments = [instrument("BTCUSDT")];
  const warnings: string[] = [];
  const { adapter } = mockAdapter({
    instruments,
    book: async () => book("BTCUSDT", 100, 200), // (200-100)/150 = 66% >50%
  });
  const { spreadBySymbol, report } = await enrichWithOrderBooks(instruments, adapter, {
    depthLimit: 5,
    concurrency: 1,
    logger: (lvl, line) => {
      if (lvl === "warn") warnings.push(line);
    },
  });
  assert.equal(spreadBySymbol.get("BTCUSDT"), null, "implausible spread must be null");
  assert.ok(warnings.length > 0, "expected warning for implausible spread");
  assert.ok(report.missing.length > 0);
});

// ── 8. tickers are fetched exactly once regardless of instrument count ───────

test("tickers are fetched exactly once regardless of instrument count", async () => {
  const instruments = Array.from({ length: 10 }, (_, i) => instrument(`SYM${i}USDT`));
  const { adapter, calls } = mockAdapter({ instruments });
  const { report } = await enrichWithTickers(instruments, adapter);
  assert.equal(calls.tickers, 1, "exactly one bulk call");
  assert.equal(report.attempted, 10);
  assert.equal(calls.ticker.length, 0, "no per-symbol fallback when bulk succeeds");
});

// ── 9. depth concurrency never exceeds configured limit ──────────────────────

test("depth concurrency never exceeds configured limit", async () => {
  const instruments = Array.from({ length: 20 }, (_, i) => instrument(`SYM${i}USDT`));
  let maxConcurrent = 0;
  let current = 0;
  const adapter: MarketDataAdapter = {
    async discoverInstruments() {
      return instruments;
    },
    async getTicker(symbol) {
      return ticker(symbol, 1_000_000);
    },
    async getOrderBook(symbol) {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      // simulate async work
      await new Promise((r) => setTimeout(r, 10));
      current -= 1;
      return book(symbol, 99, 101);
    },
    async getCandles() {
      return [];
    },
  };
  const limit = 3;
  const { report } = await enrichWithOrderBooks(instruments, adapter, { depthLimit: 5, concurrency: limit });
  assert.ok(maxConcurrent <= limit, `maxConcurrent ${maxConcurrent} > limit ${limit}`);
  assert.equal(report.attempted, 20);
  assert.equal(report.succeeded, 20);
});

// ── 10. unknown spread is rejected explicitly ────────────────────────────────

test("unknown spread is rejected explicitly", () => {
  const config = loadScannerConfig();
  const makeInstrument = (overrides: Partial<MarketInstrument> = {}): MarketInstrument => ({
    ...instrument("BTCUSDT"),
    volume24h: 2_000_000_000,
    spread: null,
    ...overrides,
  });
  const validFactors = () => ({
    liquidity: { id: "liquidity" as const, available: true, raw: 2_000_000_000, normalized: 0.8, reason: "ok", detail: {} },
    spread: { id: "spread" as const, available: false, raw: null, normalized: 0, reason: "kein Spread bekannt", detail: {} },
    executionCost: { id: "executionCost" as const, available: false, raw: null, normalized: 0, reason: "no spread", detail: {} },
    trend: { id: "trend" as const, available: true, raw: 0.5, normalized: 0.5, reason: "ok", detail: {} },
    momentum: { id: "momentum" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    volatility: { id: "volatility" as const, available: true, raw: 0.2, normalized: 0.5, reason: "ok", detail: {} },
    drawdown: { id: "drawdown" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    volumeRatio: { id: "volumeRatio" as const, available: true, raw: 1, normalized: 0.5, reason: "ok", detail: {} },
    correlation: { id: "correlation" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    funding: { id: "funding" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    openInterest: { id: "openInterest" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    newsRisk: { id: "newsRisk" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    technical: { id: "technical" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
  });

  const result = checkEligibility(
    {
      instrument: makeInstrument({ volume24h: 2_000_000_000, spread: null }),
      factors: validFactors() as any,
      candleCount: 100,
      regime: "NORMAL",
    },
    config
  );
  assert.ok(result);
  assert.equal(result!.ruleId, "max-spread");
});

// ── 11. rejection payload carries candles/volume24h/spread context ──────────

test("rejection payload carries candles/volume24h/spread context", () => {
  const rejections: FilterRejection[] = [
    {
      instrumentId: "BITUNIX:BTCUSDT",
      ruleId: "max-spread",
      message: "Spread wurde nicht geladen",
      dataQuality: true,
    },
  ];
  const resolve = (id: string) => {
    assert.equal(id, "BITUNIX:BTCUSDT");
    return { candles: 150, volume24h: 2_840_000_000, spread: null };
  };
  const summary = buildEligibilityDiagnostics(rejections, resolve);
  assert.equal(summary.total, 1);
  assert.equal(summary.items[0].instrument, "BITUNIX:BTCUSDT");
  assert.equal(summary.items[0].eligibility.rule, "max-spread");
  assert.equal(summary.items[0].eligibility.data.candles, 150);
  assert.equal(summary.items[0].eligibility.data.volume24h, 2_840_000_000);
  assert.equal(summary.items[0].eligibility.data.spread, null);
  // Check JSON shape matches task
  const json = JSON.parse(JSON.stringify(summary.items[0]));
  assert.equal(json.eligibility.status, "rejected");
  assert.ok("data" in json.eligibility);
});

// ── 12. volume24h uses quote volume, not base volume ────────────────────────

test("volume24h uses quote volume, not base volume", async () => {
  const instruments = [instrument("BTCUSDT")];
  // Fixture with stark unterschiedlichen base/quote
  const { adapter } = mockAdapter({
    instruments,
    tickers: [ticker("BTCUSDT", 5_000_000, 10)], // quote 5M, base 10
  });
  const { volumeBySymbol } = await enrichWithTickers(instruments, adapter);
  assert.equal(volumeBySymbol.get("BTCUSDT"), 5_000_000, "must use quoteVol, not baseVol");
  assert.notEqual(volumeBySymbol.get("BTCUSDT"), 10);
});

// ── Integration: Fake-Adapter mit 3 Instrumenten, davon 1 ohne Depth ────────

test("integration: 2 with spread, 1 without → scanner funnel", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "enrich-int-"));
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const history = new HistoricalStore(path.join(dir, "history"));
  const instruments = [instrument("BTCUSDT"), instrument("ETHUSDT"), instrument("SOLUSDT")];
  const adapter: MarketDataAdapter = {
    async discoverInstruments() {
      return instruments;
    },
    async getTicker(symbol) {
      return ticker(symbol, 2_000_000_000);
    },
    async getTickers(symbols) {
      const list = symbols ?? instruments.map((i) => i.symbol);
      return list.map((s) => ticker(s, 2_000_000_000));
    },
    async getOrderBook(symbol) {
      if (symbol === "SOLUSDT") throw new Error("no depth");
      return book(symbol, 99.9, 100);
    },
    async getCandles() {
      return [{ time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }];
    },
  };
  const service = new MarketDataSyncService(registry, history, new Map([["BITUNIX", adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    requiredWarmupCandles: 1,
  });
  const result = await service.syncVenue("BITUNIX");
  const btc = registry.get("BITUNIX:BTCUSDT");
  const eth = registry.get("BITUNIX:ETHUSDT");
  const sol = registry.get("BITUNIX:SOLUSDT");
  assert.ok(btc && btc.spread !== null, "BTC should have spread");
  assert.ok(eth && eth.spread !== null, "ETH should have spread");
  assert.ok(sol && sol.spread === null, "SOL should have null spread");

  // Scanner funnel: ≥1 eligible, third with max-spread
  const config = loadScannerConfig();
  const makeFactors = (inst: MarketInstrument) => ({
    liquidity: { id: "liquidity" as const, available: true, raw: inst.volume24h ?? 0, normalized: 0.8, reason: "ok", detail: {} },
    spread: inst.spread !== null
      ? { id: "spread" as const, available: true, raw: inst.spread, normalized: 0.8, reason: "ok", detail: {} }
      : { id: "spread" as const, available: false, raw: null, normalized: 0, reason: "kein Spread", detail: {} },
    executionCost: inst.spread !== null
      ? { id: "executionCost" as const, available: true, raw: inst.spread, normalized: 0.8, reason: "ok", detail: {} }
      : { id: "executionCost" as const, available: false, raw: null, normalized: 0, reason: "no spread", detail: {} },
    trend: { id: "trend" as const, available: true, raw: 0.5, normalized: 0.5, reason: "ok", detail: {} },
    momentum: { id: "momentum" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    volatility: { id: "volatility" as const, available: true, raw: 0.2, normalized: 0.5, reason: "ok", detail: {} },
    drawdown: { id: "drawdown" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    volumeRatio: { id: "volumeRatio" as const, available: true, raw: 1, normalized: 0.5, reason: "ok", detail: {} },
    correlation: { id: "correlation" as const, available: true, raw: 0.1, normalized: 0.5, reason: "ok", detail: {} },
    funding: { id: "funding" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    openInterest: { id: "openInterest" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    newsRisk: { id: "newsRisk" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
    technical: { id: "technical" as const, available: true, raw: 0, normalized: 0.5, reason: "ok", detail: {} },
  });

  const eligible: string[] = [];
  const rejections: FilterRejection[] = [];
  for (const inst of [btc!, eth!, sol!]) {
    const res = checkEligibility(
      { instrument: inst, factors: makeFactors(inst) as any, candleCount: 100, regime: "NORMAL" },
      config
    );
    if (!res) eligible.push(inst.id);
    else rejections.push(res);
  }
  assert.ok(eligible.length >= 1, `expected ≥1 eligible, got ${eligible.length}`);
  const solRej = rejections.find((r) => r.instrumentId === "BITUNIX:SOLUSDT");
  assert.ok(solRej);
  assert.equal(solRej!.ruleId, "max-spread");

  rmSync(dir, { recursive: true, force: true });
});

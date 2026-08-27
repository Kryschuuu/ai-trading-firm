/**
 * Test-Hilfen für die Market-Data-Schicht (Task 03).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrokerAdapter, MarketTicker } from "../../src/contracts/broker";
import { loadMarketDataConfig, type MarketDataConfig } from "../../src/lib/marketdata/config";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";

/** Baut eine Test-Konfiguration gegen die Fixture-URLs (kein echtes Netz). */
export function testConfig(
  binanceUrl: string,
  yahooUrl: string,
  overrides: Partial<Pick<MarketDataConfig, "paperMode" | "allowSyntheticFallback" | "staticFallbackEnabled">> & {
    seed?: number;
    historyDir?: string;
    staleAfterMs?: number;
  } = {}
): MarketDataConfig {
  const base = loadMarketDataConfig({});
  return {
    ...base,
    paperMode: overrides.paperMode ?? "broker-market-data",
    staticFallbackEnabled: overrides.staticFallbackEnabled ?? false,
    allowSyntheticFallback: overrides.allowSyntheticFallback ?? false,
    allowedHosts: ["127.0.0.1"],
    binanceBaseUrl: binanceUrl,
    yahooBaseUrl: yahooUrl,
    historyDir: overrides.historyDir ?? base.historyDir,
    staleAfterMs: overrides.staleAfterMs ?? 60_000,
    anomalyMaxJumpPct: 100,
    feedTimeoutMs: 1500,
    feedRetryMax: 1,
    simulator: { ...base.simulator, seed: overrides.seed ?? 42 },
  };
}

/** Temporäres Verzeichnis für den Historical Store je Test. */
export function tempStore(): HistoricalStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "md-store-"));
  return new HistoricalStore(dir);
}

/**
 * Ein kontrollierbarer Broker-Adapter-Stub für den Broker-Feed (Modus B).
 * `mode`: "ok" (liefert Kurs), "stale" (veralteter ts), "fail" (wirft).
 */
export class FixtureBrokerAdapter implements BrokerAdapter {
  readonly id = "PAPER" as const;
  readonly mode = "paper" as const;
  readonly capabilities = {
    discovery: true,
    marketData: true,
    trading: true,
    paper: true,
    testnet: false,
    live: false,
    instrumentTypes: { spot: true, perpetual: false, future: false, option: false },
    stopAtVenue: false,
  };
  private prices = new Map<string, number>();
  state: "ok" | "stale" | "fail" = "ok";
  private staleTs = Date.now() - 10 * 60_000;

  constructor(prices: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(prices)) this.prices.set(k.toUpperCase(), v);
  }

  async healthCheck(): Promise<{ status: "online"; latencyMs: number; details: Record<string, unknown> }> {
    return { status: "online", latencyMs: 0, details: {} };
  }

  async getTicker(symbol: string): Promise<MarketTicker> {
    if (this.state === "fail") throw new Error("fixture broker offline");
    const price = this.prices.get(symbol.toUpperCase());
    if (price === undefined) throw new Error(`fixture broker: kein Kurs für ${symbol}`);
    return {
      symbol: symbol.toUpperCase(),
      price,
      source: "broker-fixture",
      ts: this.state === "stale" ? this.staleTs : Date.now(),
    };
  }
}

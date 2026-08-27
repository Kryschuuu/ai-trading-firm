/**
 * Market-Data-Layer (Task 03) — öffentlicher Einstiegspunkt.
 *
 * Deterministische Schicht (kein LLM): Feeds → Normalisierung → Snapshot +
 * Historical Store → Screener/Agents → Paper Broker → simulated fill.
 *
 * Nutzung:
 * ```ts
 * import { getMarketDataManager } from "@/lib/marketdata";
 * const m = getMarketDataManager();
 * const snap = await m.getSnapshot("PAPER:BTC");
 * ```
 */
export * from "./types";
export * from "./config";
export * from "./normalization";
export * from "./historicalStore";
export * from "./failover";
export * from "./simulator";
export * from "./prng";
export { getMarketDataManager, resetMarketDataManagerForTests, MarketDataManager } from "./manager";
export * from "./feeds";
export { httpGetJson, DEFAULT_ALLOWED_FEED_HOSTS, FeedHttpError, assertHostAllowed } from "./http";

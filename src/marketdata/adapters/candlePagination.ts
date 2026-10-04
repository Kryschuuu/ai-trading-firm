/**
 * Venue pagination helpers for bounded OHLCV backfills.
 *
 * The aggregate target limit is deliberately separate from a venue's HTTP
 * page size. Every page is rate-limited by its client; these helpers only
 * sequence pages, filter the requested UTC range, deduplicate timestamps, and
 * stop on empty/non-progressing responses.
 */
import { MAX_CANDLE_PAGES_PER_SERIES, MAX_CANDLES_PER_SERIES } from "../../lib/marketdata/limits";
import { candleTimeMs, type CandleRange, type MarketCandle } from "../types";

export interface BackwardCandlePageOptions {
  /** Aggregate target (bounded to the repository's per-series maximum). */
  limit: number;
  /** Venue's documented maximum rows per HTTP response. */
  pageSize: number;
  /** Injectable upper time bound for deterministic tests. */
  nowMs: number;
  range?: CandleRange;
  /** `endTimeMs` is sent so the upper candle boundary is inclusive. */
  fetchPage: (pageLimit: number, endTimeMs: number) => Promise<readonly MarketCandle[]>;
}

/**
 * Pages backward from the newest requested candle (Binance/Bitunix style).
 * Responses are aggregated up to `limit`; `pageSize` remains an HTTP-page
 * bound and must never be mistaken for the total history limit.
 */
export async function fetchCandlesBackward(options: BackwardCandlePageOptions): Promise<MarketCandle[]> {
  const limit = boundedLimit(options.limit);
  const pageSize = positivePageSize(options.pageSize);
  if (limit === 0 || pageSize === 0) return [];

  const upper = Math.min(options.range?.to ?? options.nowMs, options.nowMs);
  const lower = options.range?.from;
  if (lower !== undefined && lower > upper) return [];

  const maxPages = Math.min(
    MAX_CANDLE_PAGES_PER_SERIES,
    Math.ceil(limit / pageSize) + 5,
  );
  const byTime = new Map<number, MarketCandle>();
  let endTimeMs = upper;

  for (let pageIndex = 0; pageIndex < maxPages && byTime.size < limit; pageIndex++) {
    const pageLimit = Math.min(pageSize, limit - byTime.size);
    // Venue endTime fields vary slightly in inclusivity. Adding 1 ms lets an
    // exact `--to` candle through; local filtering below keeps the contract
    // inclusive and prevents any row beyond the requested upper bound.
    const page = await options.fetchPage(pageLimit, endTimeMs + 1);
    if (!Array.isArray(page) || page.length === 0) break;

    let oldestInPage: number | null = null;
    for (const candle of page) {
      const ts = candleTimeMs(candle);
      if (ts === null || ts > endTimeMs || ts > upper) continue;
      oldestInPage = oldestInPage === null ? ts : Math.min(oldestInPage, ts);
      if (lower === undefined || ts >= lower) byTime.set(ts, candle);
    }

    // No valid bar at/before this cursor means the venue ignored endTime or
    // returned a repeated page. Stop instead of burning the page budget.
    if (oldestInPage === null) break;
    if (lower !== undefined && oldestInPage <= lower) break;
    if (byTime.size >= limit) break;

    // A short latest-history response means the venue has no older data.
    // For an explicit lower bound keep paging: a sparse page can still be a
    // valid middle page in a requested date range.
    if (lower === undefined && page.length < pageLimit) break;
    endTimeMs = oldestInPage - 1;
  }

  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-limit)
    .map(([, candle]) => candle);
}

export interface ForwardCandlePage {
  candles: readonly MarketCandle[];
  /** Kraken's `result.last`, in Unix seconds; used when it advances safely. */
  nextSinceSeconds?: number;
}

export interface ForwardCandlePageOptions {
  limit: number;
  pageSize: number;
  intervalMs: number;
  nowMs: number;
  range?: CandleRange;
  fetchPage: (sinceSeconds: number, pageSize: number) => Promise<ForwardCandlePage>;
}

/**
 * Pages forward with a `since` cursor (Kraken style). The start cursor is
 * moved forward when the requested date span is larger than `limit`, so the
 * returned series represents the newest capped portion of that range.
 */
export async function fetchCandlesForward(options: ForwardCandlePageOptions): Promise<MarketCandle[]> {
  const limit = boundedLimit(options.limit);
  const pageSize = positivePageSize(options.pageSize);
  const intervalMs = positivePageSize(options.intervalMs);
  if (limit === 0 || pageSize === 0 || intervalMs === 0) return [];

  const upper = Math.min(options.range?.to ?? options.nowMs, options.nowMs);
  const requestedLower = options.range?.from ?? 0;
  if (requestedLower > upper) return [];
  const lower = Math.max(requestedLower, upper - intervalMs * limit);
  let sinceSeconds = Math.floor(lower / 1000);
  const lowerBound = lower;

  const maxPages = Math.min(
    MAX_CANDLE_PAGES_PER_SERIES,
    Math.ceil(limit / pageSize) + 5,
  );
  const byTime = new Map<number, MarketCandle>();

  for (let pageIndex = 0; pageIndex < maxPages && byTime.size < limit; pageIndex++) {
    const pageLimit = Math.min(pageSize, limit - byTime.size);
    const page = await options.fetchPage(sinceSeconds, pageLimit);
    if (!page || !Array.isArray(page.candles) || page.candles.length === 0) break;

    let newestInPage: number | null = null;
    let added = 0;
    for (const candle of page.candles) {
      const ts = candleTimeMs(candle);
      if (ts === null || ts < lowerBound || ts > upper) continue;
      newestInPage = newestInPage === null ? ts : Math.max(newestInPage, ts);
      if (!byTime.has(ts)) added += 1;
      byTime.set(ts, candle);
    }
    if (byTime.size >= limit) break;
    if (newestInPage === null || added === 0) break;

    const fallbackNext = Math.floor((newestInPage + intervalMs) / 1000);
    const venueNext = page.nextSinceSeconds;
    // `last` is intended for incremental requests. A value beyond this
    // historical window is not a useful cursor, so advance from the latest
    // candle in the page instead.
    const candidate =
      typeof venueNext === "number" &&
      Number.isSafeInteger(venueNext) &&
      venueNext > sinceSeconds &&
      venueNext * 1000 <= upper
        ? venueNext
        : fallbackNext;
    if (candidate <= sinceSeconds || candidate * 1000 > upper) break;
    sinceSeconds = candidate;
  }

  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-limit)
    .map(([, candle]) => candle);
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_CANDLES_PER_SERIES, Math.max(0, Math.floor(value)));
}

function positivePageSize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

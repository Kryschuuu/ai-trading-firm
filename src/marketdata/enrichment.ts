/**
 * Enrichment-Stages für die Instrument-Discovery (P1).
 *
 * Zwei eigenständige, einzeln testbare Stages:
 *   - `enrichWithTickers()`  : 1× Bulk-Tickers → volume24h (Quote-Volumen)
 *   - `enrichWithOrderBooks()`: N× Depth (limit=5) → relativer Spread
 *
 * Designziele (aus Task):
 *   - Rate-Limit-schonend: ein Bulk-Call für alle Ticker, N Depth-Calls mit
 *     `limit=5` und Concurrency-Begrenzung.
 *   - Unbekannte Werte bleiben `null` und werden als Data-Quality-Zustand
 *     transportiert, nicht als fachliche Ablehnung kaschiert.
 *   - Plausibilitätsgrenzen: gekreuzte/leere Bücher und Spreads > 50 % → null.
 *   - Security: Arrays gekappt, numerische Felder per `Number.isFinite()`
 *     geprüft, Timeouts, keine unbegrenzte Fan-out, Symbol-Allowlist.
 *
 * Datenfluss (Produktionspfad):
 * ```
 * trading_pairs → registry instruments → tickers → volume24h
 *               → depth → bestBid/bestAsk/spread → kline → HistoricalStore → Scanner
 * ```
 */

import { calculateRelativeSpread } from "./spread";
import { SYNC_LIMITS, type MarketInstrument, type MarketOrderBookLevel } from "./types";
import { MAX_CONCURRENCY, MAX_INSTRUMENTS_CEILING, MIN_CONCURRENCY, type MarketDataAdapter } from "./sync";
import { normalizeSyncSymbol } from "./errors";

/** Ergebnis einer Enrichment-Stage — für Monitoring und Tests. */
export interface EnrichmentReport {
  /** Anzahl versuchter Instrumente (nach Kappung). */
  attempted: number;
  /** Anzahl erfolgreich angereicherter Instrumente (Wert !== null). */
  succeeded: number;
  /** Instrument-IDs/Symbole ohne Wert (Data-Quality). */
  missing: string[];
  /** Fehler je Symbol mit Begründung (Sync läuft weiter). */
  failures: Array<{ symbol: string; reason: string }>;
}

/** Optionen der Orderbook-Stage. */
export interface EnrichOrderBooksOptions {
  /** Buchtiefe (Default 5) — Top-of-Book reicht für Spread. */
  depthLimit: number;
  /** Parallelität (Default 4, hart ≤ 8). */
  concurrency: number;
  /** Timeout je Depth-Call in ms (Default 5000). */
  timeoutMs?: number;
  /** Logger für Warnungen (Default console.warn). */
  logger?: (level: "warn" | "info", line: string) => void;
}

/** Harte Kappen (Security: kein Massen-Fetching, kein self-DoS). */
const MAX_DEPTH_LIMIT = 50;
const MIN_DEPTH_LIMIT = 1;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 1;
const MAX_RESPONSE_ROWS = 10_000;

/**
 * Hilfsfunktion: endlicher Zahlenwert oder null.
 * `NaN`/`Infinity`/nicht-endlich → null (niemals in Risikoentscheidungen).
 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validiert und normalisiert ein Symbol für URL-Nutzung.
 * Gibt `null` zurück, wenn das Symbol die Allowlist verletzt.
 */
function safeSymbol(symbol: string): string | null {
  return normalizeSyncSymbol(symbol);
}

/**
 * Kappung und Validierung eines Orderbook-Levels.
 * Nur endliche, positive Preise und nicht-negative Mengen werden übernommen.
 */
function sanitizeLevels(levels: unknown, depthLimit: number): MarketOrderBookLevel[] {
  if (!Array.isArray(levels)) return [];
  const capped = levels.slice(0, Math.min(depthLimit, MAX_DEPTH_LIMIT));
  const out: MarketOrderBookLevel[] = [];
  for (const row of capped) {
    if (!row || typeof row !== "object") continue;
    const price = (row as { price?: unknown }).price;
    const qty = (row as { qty?: unknown }).qty ?? (row as { size?: unknown }).size;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) continue;
    out.push({ price, qty });
  }
  return out;
}

/**
 * Timeout-Wrapper für einen Promise.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, symbol: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms for ${symbol}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Einfacher Concurrency-Pool (p-limit-artig).
 */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Enrichment-Stage 1: 24h-Volumen aus Ticker-API.
 *
 * **Ein Bulk-Call** (`adapter.getTickers(symbols)`), wenn vorhanden.
 * Fehlt ein Symbol in der Response → `null` + Eintrag in `report.missing`
 * (kein Throw). Unbekannte Werte bleiben `null` (Data-Quality).
 *
 * `volume24h` ist explizit das **Quote-Volumen** (`ticker.quoteVol`) in
 * Quote-Währung (z. B. USDT). Eine Verwechslung mit Base-Volumen verfälscht
 * jeden `min-volume`-Filter um Größenordnungen. Dokumentiert im Registry-Typ
 * als JSDoc.
 *
 * Security:
 *   - `maxInstruments` hart auf 1000 gekappt (Schutz gegen self-DoS).
 *   - Symbol-Allowlist vor URL-Nutzung.
 *   - `quoteVol` per `Number.isFinite()` geprüft, `NaN`/`Infinity` → null.
 */
export async function enrichWithTickers(
  instruments: MarketInstrument[],
  adapter: MarketDataAdapter,
): Promise<{ volumeBySymbol: Map<string, number | null>; report: EnrichmentReport }> {
  const cappedInstruments = instruments.slice(0, MAX_INSTRUMENTS_CEILING);
  const attempted = cappedInstruments.length;
  const volumeBySymbol = new Map<string, number | null>();
  const missing: string[] = [];
  const failures: Array<{ symbol: string; reason: string }> = [];

  if (attempted === 0) {
    return {
      volumeBySymbol,
      report: { attempted: 0, succeeded: 0, missing: [], failures: [] },
    };
  }

  // Symbol-Validierung vor URL-Nutzung
  const validInstruments: MarketInstrument[] = [];
  for (const inst of cappedInstruments) {
    const safe = safeSymbol(inst.symbol);
    if (!safe) {
      volumeBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
      failures.push({ symbol: inst.symbol, reason: "INVALID_SYMBOL" });
      continue;
    }
    validInstruments.push(inst);
  }

  let tickerMap = new Map<string, { quoteVol?: number | null }>();

  try {
    if (adapter.getTickers) {
      const symbols = validInstruments.map((i) => i.symbol);
      const tickers = await adapter.getTickers(symbols);
      const rows = Array.isArray(tickers) ? tickers : [];
      // Security: Payload-Cap — 20k Ticker-Zeilen dürfen nicht OOMen
      if (rows.length > MAX_RESPONSE_ROWS) {
        failures.push({
          symbol: "BATCH",
          reason: `Ticker-Response gekappt: ${rows.length} > ${MAX_RESPONSE_ROWS} Zeilen (Payload-Schutz).`,
        });
      }
      if (rows.length > SYNC_LIMITS.maxTickerBatch) {
        failures.push({
          symbol: "BATCH",
          reason: `Ticker-Batch gekappt: ${rows.length} > ${SYNC_LIMITS.maxTickerBatch} (maxTickerBatch).`,
        });
      }
      const cappedRows = rows.slice(0, Math.min(MAX_RESPONSE_ROWS, SYNC_LIMITS.maxTickerBatch));
      for (const t of cappedRows) {
        const sym = safeSymbol((t as { symbol?: unknown })?.symbol as string);
        if (!sym) continue;
        if (!tickerMap.has(sym)) {
          tickerMap.set(sym, { quoteVol: (t as { quoteVol?: unknown })?.quoteVol as number | null });
        }
      }
    } else {
      // Fallback für Venues ohne Bulk-Endpoint: per-Symbol (dokumentiert im Sync-Ergebnis)
      for (const inst of validInstruments) {
        try {
          const t = await adapter.getTicker(inst.symbol);
          const sym = safeSymbol((t as { symbol?: unknown })?.symbol as string);
          // Symbol-Guard: nur exakte Übereinstimmung übernehmen, sonst null (kein Fremd-Volumen)
          if (sym && sym === inst.symbol) {
            tickerMap.set(sym, { quoteVol: (t as { quoteVol?: unknown })?.quoteVol as number | null });
          } else {
            // Fremdes Symbol → als missing behandeln, aber als Data-Quality sichtbar
            failures.push({
              symbol: inst.symbol,
              reason: sym ? `Ticker-Antwort enthält anderes Symbol ${sym} — volume24h bleibt unbekannt` : "Kein Ticker für das Symbol verfügbar — volume24h bleibt unbekannt",
            });
          }
        } catch (e) {
          failures.push({ symbol: inst.symbol, reason: e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80) });
        }
      }
    }
  } catch (e) {
    // Bulk-Call fehlgeschlagen → alle als missing, Fehler je Symbol
    const reason = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    for (const inst of validInstruments) {
      volumeBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
      failures.push({ symbol: inst.symbol, reason });
    }
    // Auch für bereits validierte, aber nicht in tickerMap enthaltene
    const succeeded = 0;
    return { volumeBySymbol, report: { attempted, succeeded, missing, failures } };
  }

  let succeeded = 0;
  for (const inst of validInstruments) {
    const entry = tickerMap.get(inst.symbol);
    const rawVol = entry?.quoteVol ?? null;
    const vol = finiteOrNull(rawVol);
    // Plausibilität: Volumen muss >0 und endlich sein, sonst null
    if (vol !== null && vol > 0) {
      volumeBySymbol.set(inst.symbol, vol);
      succeeded += 1;
    } else {
      volumeBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
    }
  }

  // Für Instrumente, die wegen INVALID_SYMBOL bereits behandelt wurden,
  // sind sie schon in missing/failures — succeeded bleibt korrekt.

  return {
    volumeBySymbol,
    report: { attempted, succeeded, missing, failures },
  };
}

/**
 * Enrichment-Stage 2: Spread aus Orderbook-Top-Level.
 *
 * Die Bitunix-Ticker-API liefert kein Bid/Ask. Der relative Spread wird
 * deshalb aus dem Orderbook-Top-Level (`/market/depth`, limit=5) berechnet.
 * Das kostet N zusätzliche Requests und ist der teuerste Teil des Syncs —
 * daher Concurrency-Begrenzung und Token-Bucket.
 *
 * Formel: `spread = (ask - bid) / mid` mit `mid = (ask + bid) / 2`.
 * `0.0004` = 4 bp. Ungültige/fehlende Book-Daten liefern `null` (unbekannt —
 * niemals 0, niemals NaN).
 *
 * Plausibilitätsprüfung: `spread > 0.5` (50 %) wird als `null` + Warnung
 * behandelt (defektes/leeres Buch), damit kein Müllwert in Risikoentscheidungen
 * fließt.
 *
 * Security:
 *   - `depthLimit` gekappt (max. 50), Arrays gekappt.
 *   - Numerische Felder per `Number.isFinite()` geprüft, `NaN`/`Infinity` → null.
 *   - Timeout pro Call (Default 5 s) + max. 1 Retry über bestehenden Backoff.
 *   - `maxInstruments` (1000) und `concurrency` (≤ 8) hart gekappt.
 *   - Symbol-Allowlist + Encoding vor URL-Nutzung.
 */
export async function enrichWithOrderBooks(
  instruments: MarketInstrument[],
  adapter: MarketDataAdapter,
  opts: EnrichOrderBooksOptions,
): Promise<{ spreadBySymbol: Map<string, number | null>; report: EnrichmentReport }> {
  const depthLimit = Math.max(MIN_DEPTH_LIMIT, Math.min(MAX_DEPTH_LIMIT, Math.floor(opts.depthLimit ?? 5) || 5));
  const concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(opts.concurrency ?? 4) || 4));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = opts.logger ?? ((level: "warn" | "info", line: string) => {
    if (level === "warn") console.warn(line);
  });

  const cappedInstruments = instruments.slice(0, MAX_INSTRUMENTS_CEILING);
  const attempted = cappedInstruments.length;
  const spreadBySymbol = new Map<string, number | null>();
  const missing: string[] = [];
  const failures: Array<{ symbol: string; reason: string }> = [];

  if (attempted === 0) {
    return {
      spreadBySymbol,
      report: { attempted: 0, succeeded: 0, missing: [], failures: [] },
    };
  }

  // Vorab Symbol-Validierung
  const validInstruments: MarketInstrument[] = [];
  for (const inst of cappedInstruments) {
    const safe = safeSymbol(inst.symbol);
    if (!safe) {
      spreadBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
      failures.push({ symbol: inst.symbol, reason: "INVALID_SYMBOL" });
      continue;
    }
    validInstruments.push(inst);
  }

  const results = await runPool(validInstruments, concurrency, async (instrument) => {
    const symbol = instrument.symbol;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const bookPromise = adapter.getOrderBook(symbol);
        const book = await withTimeout(bookPromise, timeoutMs, symbol);

        // Security: Arrays gekappt, numerische Felder geprüft
        const bids = sanitizeLevels((book as { bids?: unknown })?.bids, depthLimit);
        const asks = sanitizeLevels((book as { asks?: unknown })?.asks, depthLimit);

        const bestBid = bids[0]?.price;
        const bestAsk = asks[0]?.price;

        const spread = calculateRelativeSpread(bestBid, bestAsk);

        if (spread === null) {
          // Leeres Buch oder gekreuztes Buch (ask < bid) → null
          if (bids.length === 0 || asks.length === 0) {
            logger("warn", `[market-sync] empty order book for ${symbol} — spread=null`);
          } else if (bestBid !== undefined && bestAsk !== undefined && bestAsk < bestBid) {
            logger("warn", `[market-sync] crossed book for ${symbol} (bid=${bestBid} ask=${bestAsk}) — spread=null`);
          }
          return { symbol, spread: null as number | null, ok: true, reason: null };
        }

        // Plausibilitätsprüfung: >50 % → null + Warnung
        if (spread > 0.5) {
          logger("warn", `[market-sync] implausible spread ${(spread * 100).toFixed(1)}% for ${symbol} — treated as null`);
          return { symbol, spread: null as number | null, ok: true, reason: "IMPLAUSIBLE_SPREAD" };
        }

        return { symbol, spread, ok: true, reason: null };
      } catch (e) {
        lastError = e;
        if (attempt < MAX_RETRIES) {
          // Bestehender Backoff: kurzer Delay vor Retry
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        const reason = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
        return { symbol, spread: null as number | null, ok: false, reason };
      }
    }
    const reason = lastError instanceof Error ? lastError.message.slice(0, 120) : String(lastError ?? "unknown").slice(0, 120);
    return { symbol, spread: null as number | null, ok: false, reason };
  });

  let succeeded = 0;
  for (const res of results) {
    if (!res) continue;
    spreadBySymbol.set(res.symbol, res.spread);
    if (res.spread !== null) {
      succeeded += 1;
    } else {
      // Finde zugehörige ID für missing-Liste
      const inst = validInstruments.find((i) => i.symbol === res.symbol);
      missing.push(inst?.id ?? res.symbol);
      if (!res.ok && res.reason) {
        failures.push({ symbol: res.symbol, reason: res.reason });
      } else if (res.reason === "IMPLAUSIBLE_SPREAD") {
        failures.push({ symbol: res.symbol, reason: "IMPLAUSIBLE_SPREAD > 50%" });
      }
    }
  }

  // Für ungültige Symbole bereits in missing/failures — nichts weiter zu tun

  return {
    spreadBySymbol,
    report: { attempted, succeeded, missing, failures },
  };
}

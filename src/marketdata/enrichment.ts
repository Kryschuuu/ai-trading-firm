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

import { bookDepthVerdict } from "../lib/bookDepthProvenance";
import { computeBookDepth, type BookLevelInput } from "../lib/bookDepth";
import { calculateRelativeSpread } from "./spread";
import {
  SYNC_LIMITS,
  type MarketInstrument,
  type MarketOrderBookLevel,
} from "./types";
import {
  MAX_CONCURRENCY,
  MAX_INSTRUMENTS_CEILING,
  MIN_CONCURRENCY,
  type MarketDataAdapter,
} from "./sync";
import { normalizeSyncSymbol } from "./errors";

/** Ergebnis einer Enrichment-Stage — für Monitoring und Tests. */
export interface EnrichmentReport {
  /** Anzahl versuchter Instrumente (nach Kappung). */
  attempted: number;
  /** Anzahl erfolgreich angereicherter Instrumente (Wert !== null). */
  succeeded: number;
  /** Instrument-IDs/Symbole ohne Wert (Data-Quality). */
  missing: string[];
  /**
   * Fehler je Symbol mit Begründung (Sync läuft weiter). `cause` trägt das
   * ursprüngliche Fehlerobjekt (HTTP-Status/Code), damit der Sync die
   * Ursache ehrlich klassifizieren kann (NETWORK/UPSTREAM_5XX/…) statt
   * pauschal „SCHEMA_MISMATCH“ zu melden. Wo es kein Fehlerobjekt gibt
   * (Allowlist-Verletzung, Symbol-Guard, lokale Kappen), trägt `code` die
   * Taxonomie-Klasse direkt (`INVALID_SYMBOL`, `NOT_FOUND`,
   * `SCHEMA_MISMATCH`) — `cause` hat bei der Abbildung Vorrang vor `code`.
   */
  failures: Array<{ symbol: string; reason: string; cause?: unknown; code?: string }>;
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
 * Parallelität der Einzel-Ticker, wenn der Bulk Lücken lässt (oder die
 * Venue keinen Bulk unterstützt). Die Token-Bucket-Drossel des HTTP-Layers
 * (8 req/s bei Bitunix) bleibt auch damit autoritativ — die Parallelität
 * beseitigt nur das serielle Warten je Aufruf (vorher N × Roundtrip
 * hintereinander, bei 250 Instrumenten mehr als 30 s reiner Latenz).
 */
const TICKER_GAP_CONCURRENCY = 4;

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
function sanitizeLevels(
  levels: unknown,
  depthLimit: number,
): MarketOrderBookLevel[] {
  if (!Array.isArray(levels)) return [];
  const capped = levels.slice(0, Math.min(depthLimit, MAX_DEPTH_LIMIT));
  const out: MarketOrderBookLevel[] = [];
  for (const row of capped) {
    if (!row || typeof row !== "object") continue;
    const price = (row as { price?: unknown }).price;
    const qty =
      (row as { qty?: unknown }).qty ?? (row as { size?: unknown }).size;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
      continue;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) continue;
    out.push({ price, qty });
  }
  return out;
}

/**
 * Timeout-Wrapper für einen Promise.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  symbol: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms for ${symbol}`)),
      ms,
    );
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
 * Fehlt ein Symbol in der Bulk-Response → **ein** Einzel-Ticker-Versuch
 * (Lücken-Fallback mit Symbol-Guard). Scheitert auch der, wird die Lücke als
 * `failure` sichtbar (Stage `ticker`, Lauf degradiert) — sie zählt nie still
 * als „enriched". Unbekannte Werte bleiben `null` (Data-Quality).
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
): Promise<{
  volumeBySymbol: Map<string, number | null>;
  report: EnrichmentReport;
}> {
  const cappedInstruments = instruments.slice(0, MAX_INSTRUMENTS_CEILING);
  const attempted = cappedInstruments.length;
  const volumeBySymbol = new Map<string, number | null>();
  const missing: string[] = [];
  const failures: EnrichmentReport["failures"] = [];

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
      failures.push({ symbol: inst.symbol, reason: "INVALID_SYMBOL", code: "INVALID_SYMBOL" });
      continue;
    }
    validInstruments.push(inst);
  }

  let tickerMap = new Map<string, { quoteVol?: number | null }>();

  // Einzel-Ticker mit Symbol-Guard — genutzt vom No-Bulk-Pfad UND als
  // Lücken-Fallback für Symbole, die im Bulk-Response fehlen. Nur exakte
  // Symbol-Übereinstimmung wird übernommen (kein Fremd-Volumen); jede
  // Abweichung oder ein Fehlschlag wird als failure sichtbar — nie kaschiert.
  // Ergebnis statt Seiteneffekt: die Failures werden EINGANGSORDNUNG-stabil
  // zusammengefaltet (parallele Requests würden sonst die Reihenfolge und
  // damit die deterministischen Reports/Tests zerstören).
  const fetchSingleWithGuard = async (
    inst: MarketInstrument,
  ): Promise<{
    symbol: string;
    quoteVol?: number | null;
    failure?: string;
    cause?: unknown;
    code?: string;
  }> => {
    try {
      const t = await adapter.getTicker(inst.symbol);
      const sym = safeSymbol((t as { symbol?: unknown })?.symbol as string);
      if (sym && sym === inst.symbol) {
        return {
          symbol: inst.symbol,
          quoteVol: (t as { quoteVol?: unknown })?.quoteVol as number | null,
        };
      }
      // Symbol-Guard: eine fremde Zeile ist eine Schema-Abweichung der
      // Venue-Antwort, ein fehlender Ticker ein NOT_FOUND — beides ohne
      // Fehlerobjekt, daher als `code` markiert (kein pauschales
      // SCHEMA_MISMATCH im Sync mehr nötig).
      return {
        symbol: inst.symbol,
        failure: sym
          ? `Ticker-Antwort enthält anderes Symbol ${sym} — volume24h bleibt unbekannt`
          : "Kein Ticker für das Symbol verfügbar — volume24h bleibt unbekannt",
        code: sym ? "SCHEMA_MISMATCH" : "NOT_FOUND",
      };
    } catch (e) {
      return {
        symbol: inst.symbol,
        failure:
          e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80),
        cause: e,
      };
    }
  };

  /** Faltet gepoolte Einzelergebnisse deterministisch (Eingangsreihenfolge). */
  const foldSingleResults = (
    results: Array<{
      symbol: string;
      quoteVol?: number | null;
      failure?: string;
      cause?: unknown;
      code?: string;
    }>,
  ): void => {
    for (const result of results) {
      if (result.failure) {
        failures.push({
          symbol: result.symbol,
          reason: result.failure,
          ...(result.cause !== undefined ? { cause: result.cause } : {}),
          ...(result.code !== undefined ? { code: result.code } : {}),
        });
      } else if (!tickerMap.has(result.symbol)) {
        tickerMap.set(result.symbol, { quoteVol: result.quoteVol ?? null });
      }
    }
  };

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
          code: "SCHEMA_MISMATCH",
        });
      }
      // Die Batch-Kappe schützt vor UNANGEFORDERTEN Massen-Payloads. Zeilen,
      // die wir für die (bereits auf MAX_INSTRUMENTS_CEILING begrenzten)
      // Instrumente selbst angefragt haben, sind erwartet — sie zu verwerfen
      // erzeugte einen Schein-Fehler UND einen Selbst-DoS: ein 750er-Katalog
      // wurde auf 500 gekappt, die 250 fehlenden dann einzeln nachgeholt.
      const tickerBatchCap = Math.min(
        MAX_RESPONSE_ROWS,
        Math.max(SYNC_LIMITS.maxTickerBatch, symbols.length),
      );
      if (rows.length > tickerBatchCap) {
        failures.push({
          symbol: "BATCH",
          reason: `Ticker-Batch gekappt: ${rows.length} > ${tickerBatchCap} (maxTickerBatch).`,
          code: "SCHEMA_MISMATCH",
        });
      }
      const cappedRows = rows.slice(0, tickerBatchCap);
      for (const t of cappedRows) {
        const sym = safeSymbol((t as { symbol?: unknown })?.symbol as string);
        if (!sym) continue;
        if (!tickerMap.has(sym)) {
          tickerMap.set(sym, {
            quoteVol: (t as { quoteVol?: unknown })?.quoteVol as number | null,
          });
        }
      }
      // Lücken-Fallback: Symbole, die im Bulk fehlen, werden EINMAL per
      // Einzel-Ticker versucht (Symbol-Guard), gepoolt mit fester Parallelität.
      // Ein serieller N+1-Pfad kostete bei 250 Instrumenten mehr als 30 s
      // reine Roundtrip-Latenz; der Token-Bucket des HTTP-Layers drosselt die
      // tatsächliche Rate (8 req/s) auch bei Parallelität autoritativ.
      const bulkGaps = validInstruments.filter(
        (inst) => !tickerMap.has(inst.symbol),
      );
      const gapResults = await runPool(
        bulkGaps,
        TICKER_GAP_CONCURRENCY,
        async (inst) => fetchSingleWithGuard(inst),
      );
      foldSingleResults(gapResults);
    } else {
      // Fallback für Venues ohne Bulk-Endpoint: per-Symbol, ebenfalls gepoolt
      // (dokumentiert im Sync-Ergebnis als Lücken-Fallback).
      const singleResults = await runPool(
        validInstruments,
        TICKER_GAP_CONCURRENCY,
        async (inst) => fetchSingleWithGuard(inst),
      );
      foldSingleResults(singleResults);
    }
  } catch (e) {
    // Bulk-Call fehlgeschlagen → alle als missing, Fehler je Symbol
    const reason =
      e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    for (const inst of validInstruments) {
      volumeBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
      failures.push({ symbol: inst.symbol, reason, cause: e });
    }
    // Auch für bereits validierte, aber nicht in tickerMap enthaltene
    const succeeded = 0;
    return {
      volumeBySymbol,
      report: { attempted, succeeded, missing, failures },
    };
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
 * Enrichment-Stage 2: Spread **und Orderbuch-Tiefe** aus dem Depth-Endpoint.
 *
 * Die Bitunix-Ticker-API liefert kein Bid/Ask. Der relative Spread wird
 * deshalb aus dem Orderbook-Top-Level (`/market/depth`) berechnet. Seit
 * v0.4.0 (IAD-T-06) wird aus denselben Levels auch `bookDepthUsd` gemessen
 * (Summe über price × qty der abriegelnden Seite, Grenze je Venue in
 * `src/lib/bookDepthProvenance.ts`). Das kostet weiterhin N Requests und ist
 * der teuerste Teil des Syncs — daher Concurrency-Begrenzung und Token-Bucket.
 *
 * Formel: `spread = (ask - bid) / mid` mit `mid = (ask + bid) / 2`.
 * `0.0004` = 4 bp. Ungültige/fehlende Book-Daten liefern `null` (unbekannt —
 * niemals 0, niemals NaN).
 *
 * Plausibilitätsprüfung: `spread > 0.5` (50 %) wird als `null` + Warnung
 * behandelt (defektes/leeres Buch), damit kein Müllwert in Risikoentscheidungen
 * fließt. Die Tiefe greift die Venue-Qualitätsgrenze (Levels/Alter) — wer sie
 * nicht erfüllt, bekommt `bookDepthUsd: null` (fail-closed).
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
): Promise<{
  spreadBySymbol: Map<string, number | null>;
  /** `depthUsd` = min(Bid, Ask) in Quote-Währung; `null` = unter Qualitätsgrenze. */
  bookDepthBySymbol: Map<string, number | null>;
  report: EnrichmentReport;
}> {
  const depthLimit = Math.max(
    MIN_DEPTH_LIMIT,
    Math.min(MAX_DEPTH_LIMIT, Math.floor(opts.depthLimit ?? 5) || 5),
  );
  const concurrency = Math.max(
    MIN_CONCURRENCY,
    Math.min(MAX_CONCURRENCY, Math.floor(opts.concurrency ?? 4) || 4),
  );
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger =
    opts.logger ??
    ((level: "warn" | "info", line: string) => {
      if (level === "warn") console.warn(line);
    });

  const cappedInstruments = instruments.slice(0, MAX_INSTRUMENTS_CEILING);
  const attempted = cappedInstruments.length;
  const spreadBySymbol = new Map<string, number | null>();
  const bookDepthBySymbol = new Map<string, number | null>();
  const missing: string[] = [];
  const failures: EnrichmentReport["failures"] = [];

  if (attempted === 0) {
    return {
      spreadBySymbol,
      bookDepthBySymbol,
      report: { attempted: 0, succeeded: 0, missing: [], failures: [] },
    };
  }

  // Vorab Symbol-Validierung
  const validInstruments: MarketInstrument[] = [];
  for (const inst of cappedInstruments) {
    const safe = safeSymbol(inst.symbol);
    if (!safe) {
      spreadBySymbol.set(inst.symbol, null);
      bookDepthBySymbol.set(inst.symbol, null);
      missing.push(inst.id ?? inst.symbol);
      failures.push({ symbol: inst.symbol, reason: "INVALID_SYMBOL", code: "INVALID_SYMBOL" });
      continue;
    }
    validInstruments.push(inst);
  }

  const results = await runPool(
    validInstruments,
    concurrency,
    async (instrument) => {
      const symbol = instrument.symbol;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const bookPromise = adapter.getOrderBook(symbol);
          const book = await withTimeout(bookPromise, timeoutMs, symbol);

          // Security: Arrays gekappt, numerische Felder geprüft
          const bids = sanitizeLevels(
            (book as { bids?: unknown })?.bids,
            depthLimit,
          );
          const asks = sanitizeLevels(
            (book as { asks?: unknown })?.asks,
            depthLimit,
          );

          const bestBid = bids[0]?.price;
          const bestAsk = asks[0]?.price;

          const spread = calculateRelativeSpread(bestBid, bestAsk);

          // v0.4.0 (IAD-T-06): Orderbuch-Tiefe aus denselben Levels, nur
          // übernommen, wenn die Venue-Qualitätsgrenze greift (≥ N Levels
          // je Seite, kein überaltetes Buch). `null` = nicht belastbar.
          const rawBookTs = (book as { ts?: unknown })?.ts;
          const bookAgeMs =
            typeof rawBookTs === "number" && Number.isFinite(rawBookTs) && rawBookTs > 0
              ? Math.max(0, Date.now() - rawBookTs)
              : null;
          const depth = computeBookDepth(
            bids as BookLevelInput[],
            asks as BookLevelInput[],
            depthLimit,
          );

          if (spread === null) {
            // Leeres Buch oder gekreuztes Buch (ask < bid) → null
            if (bids.length === 0 || asks.length === 0) {
              logger(
                "warn",
                `[market-sync] empty order book for ${symbol} — spread=null`,
              );
            } else if (
              bestBid !== undefined &&
              bestAsk !== undefined &&
              bestAsk < bestBid
            ) {
              logger(
                "warn",
                `[market-sync] crossed book for ${symbol} (bid=${bestBid} ask=${bestAsk}) — spread=null`,
              );
            }
            return {
              symbol,
              spread: null as number | null,
              depth: null as number | null,
              ok: true,
              reason: null,
            };
          }

          // Plausibilitätsprüfung: >50 % → null + Warnung
          if (spread > 0.5) {
            logger(
              "warn",
              `[market-sync] implausible spread ${(spread * 100).toFixed(1)}% for ${symbol} — treated as null`,
            );
            return {
              symbol,
              spread: null as number | null,
              depth: null as number | null,
              ok: true,
              reason: "IMPLAUSIBLE_SPREAD",
            };
          }

          const depthUsd =
            depth.depthUsd !== null
              ? bookDepthVerdict(instrument.venue, {
                  levels: Math.min(depth.bidLevels, depth.askLevels),
                  maxAgeMs: bookAgeMs,
                }) === "VERIFIED"
                ? depth.depthUsd
                : null
              : null;

          return { symbol, spread, depth: depthUsd, ok: true, reason: null };
        } catch (e) {
          lastError = e;
          if (attempt < MAX_RETRIES) {
            // Bestehender Backoff: kurzer Delay vor Retry
            await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            continue;
          }
          const reason =
            e instanceof Error
              ? e.message.slice(0, 120)
              : String(e).slice(0, 120);
          // `cause` durchreichen: Der Sync klassifiziert daraus die echte
          // Ursache (NETWORK/UPSTREAM_5XX/RATE_LIMITED/…) statt pauschal
          // SCHEMA_MISMATCH zu melden (Fehlklassifikations-Fix).
          return { symbol, spread: null as number | null, depth: null as number | null, ok: false, reason, cause: e };
        }
      }
      const reason =
        lastError instanceof Error
          ? lastError.message.slice(0, 120)
          : String(lastError ?? "unknown").slice(0, 120);
      return { symbol, spread: null as number | null, depth: null as number | null, ok: false, reason, cause: lastError };
    },
  );

  let succeeded = 0;
  for (const res of results) {
    if (!res) continue;
    spreadBySymbol.set(res.symbol, res.spread);
    bookDepthBySymbol.set(res.symbol, res.depth);
    if (res.spread !== null) {
      succeeded += 1;
    } else {
      // Finde zugehörige ID für missing-Liste
      const inst = validInstruments.find((i) => i.symbol === res.symbol);
      missing.push(inst?.id ?? res.symbol);
      if (!res.ok && res.reason) {
        failures.push({
          symbol: res.symbol,
          reason: res.reason,
          ...("cause" in res && res.cause !== undefined && res.cause !== null ? { cause: res.cause } : {}),
        });
      } else if (res.reason === "IMPLAUSIBLE_SPREAD") {
        // Datenform-Befund (kein Abruf-Fehler): als SCHEMA_MISMATCH markiert,
        // nicht retryable — ein Retry lieferte dasselbe unplausible Buch.
        failures.push({
          symbol: res.symbol,
          reason: "IMPLAUSIBLE_SPREAD > 50%",
          code: "SCHEMA_MISMATCH",
        });
      }
    }
  }

  // Für ungültige Symbole bereits in missing/failures — nichts weiter zu tun

  return {
    spreadBySymbol,
    bookDepthBySymbol,
    report: { attempted, succeeded, missing, failures },
  };
}

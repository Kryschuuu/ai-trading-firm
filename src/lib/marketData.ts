/**
 * Multi-Market-Datenquelle mit Cache.
 *
 * Abgedeckte Märkte (alle ohne API-Key):
 *   - Krypto (24/7):  Binance Public REST  → BTC, ETH, SOL …
 *   - Aktien/ETF:     Yahoo Finance Chart  → AAPL, NVDA, SPY, QQQ …
 *   - Devisen:        Yahoo Finance Chart  → EURUSD=X, USDJPY=X …
 *
 * **Failure-Semantik (MDERR-006, P1):** `getCandles()` wirft bei echten
 * Fehlern einen typisierten `MarketDataFetchError` (Ursache + retryable +
 * httpStatus). Ein leeres Array bedeutet ausschließlich: „die Venue hat für
 * dieses Symbol/Timeframe nachweislich keine Bars geliefert“ — niemals
 * „Abruf fehlgeschlagen“. Wer bewusst degradiert (z. B. UI-Preview) nutzt
 * `getCandlesWithFallback()` mit expliziter Staleness-Information. Der
 * Scanner-/Executor-Pfad nutzt die Fallback-API **nicht**.
 *
 * Kurse (`getQuote`) behalten ihr Failover (Cache → Statisches Buch), da dort
 * der Betrieb nicht von Indikatorenhistorie abhängt; das ist dokumentiert und
 * durch `source` im Ergebnis sichtbar.
 */

import { WATCHLIST_DISPLAY_SYMBOLS } from "../universe/watchlist";
import {
  MarketDataFetchError,
  MarketDataHttpError,
  MarketDataSchemaError,
  MarketDataTimeoutError,
  classifyMarketDataError,
  type MarketDataErrorReason,
} from "./marketDataErrors";
import { structuredLog } from "./logger";
import { telemetry } from "./telemetry";

const GLOBAL = globalThis as typeof globalThis & {
  __mktQuoteCache?: Map<string, { price: number; ts: number; source: string }>;
  __mktCandleCache?: Map<string, { candles: Candle[]; ts: number }>;
};

const quoteCache = (GLOBAL.__mktQuoteCache ??= new Map());
const candleCache = (GLOBAL.__mktCandleCache ??= new Map());

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type Quote = { symbol: string; price: number; source: "binance" | "yahoo" | "static" | "cache"; ts: number };

/**
 * @deprecated seit Task 01 (Market Universe).
 *
 * Diese Liste war früher die faktische **Marktdefinition** der Plattform.
 * Seit der Einführung der Instrument-Registry (`src/universe/`) ist sie zur
 * reinen **UI-Präferenz** degradiert: Sie leitet sich aus
 * `UI_WATCHLIST_PREFERENCE` ab, deren Einträge auf Instrument-IDs
 * (`PAPER:BTC`, `PAPER:SPY`, …) verweisen.
 *
 * Neuer Code fragt das Universum:
 * ```ts
 * import { getRegistry } from "@/universe";
 * const active = getRegistry().query({ status: "active", paperAvailable: true });
 * ```
 * Für die Anzeigereihenfolge im Dashboard:
 * `import { UI_WATCHLIST_PREFERENCE } from "@/universe/watchlist";`
 *
 * Der Export bleibt aus Kompatibilitätsgründen erhalten (Monitor-Marktscan,
 * Kurs-Refresh) und wird in einem späteren Task entfernt.
 */
export const DEFAULT_WATCHLIST: string[] = [...WATCHLIST_DISPLAY_SYMBOLS];

/**
 * @deprecated Statisches Preisbuch (Task 03).
 *
 * Als Default DEAKTIVIERT — nur noch expliziter Offline-Fallback hinter
 * `PAPER_STATIC_FALLBACK=true` (Default false). Verwendung im Produktivpfad
 * erfolgt ausschließlich über den MarketDataManager; die rohe `PaperBroker`-
 * Instanz (Unit-Tests/Kompatibilität) nutzt sie weiterhin. Kein stiller
 * Kursquellwechsel — jeder Statik-Fallback wird auditiert.
 */
export const STATIC_PRICES: Record<string, number> = {
  BTC: 67000, ETH: 3200, SOL: 150,
  SPY: 510, QQQ: 440, NVDA: 125, AAPL: 185, MSFT: 415,
};

const QUOTE_TTL_MS = 30_000;
const CANDLE_TTL_MS = 120_000;

/** Whitelist für Kerzen-Intervalle (Binance + Yahoo). Verhindert URL-Injection. */
export const ALLOWED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w",
]);

export function sanitizeInterval(raw: string | null | undefined, fallback = "15m"): string {
  if (typeof raw !== "string") return fallback;
  return ALLOWED_INTERVALS.has(raw) ? raw : fallback;
}

/**
 * Erlaubtes Symbolformat: 1–12 Großbuchstaben/Ziffern, optional Suffix
 * `.XYZ` (z. B. BRK.B) oder `=X` (z. B. EURUSD=X). Verhindert, dass
 * Modell-Output (oder manipulierte DB-Zeilen) Sonderzeichen wie `&`, `?`, `#`
 * in externe URLs, SQL-Abfragen oder Prompts schmuggeln.
 */
const SYMBOL_RE = /^[A-Z0-9]{1,12}(?:[.=][A-Z0-9]{1,5})?$/;

/** Normalisiert ein Symbol oder liefert null, wenn es nicht erlaubt ist. */
export function sanitizeSymbol(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

/** true, wenn das Symbol dem erlaubten Format entspricht. */
export function isValidSymbol(raw: string | null | undefined): boolean {
  return sanitizeSymbol(raw) !== null;
}

function isCrypto(symbol: string): boolean {
  return /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE|AVAX|LINK|DOT)$/i.test(symbol);
}

function binancePair(symbol: string): string {
  return `${symbol.toUpperCase()}USDT`;
}

/**
 * Retry-Budget des Kerzen-Abrufs (MDERR-006, Security-Audit):
 * begrenzt und mit Backoff — niemals unbegrenzt. 1 Erstversuch + 1 Retry.
 * Nur `retryable`-Ursachen (429/5xx/Timeout/Network) werden wiederholt.
 */
export const MARKET_DATA_FETCH_ATTEMPTS = 2;
export const MARKET_DATA_RETRY_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nur der Host in Fehlermeldungen — nie die volle URL (Query-Strings). */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "venue";
  }
}

async function fetchJsonOnce<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    } catch (err) {
      if (timedOut) throw new MarketDataTimeoutError(`nach ${timeoutMs} ms`);
      throw err;
    }
    if (!res.ok) {
      // HTTP-Status bleibt maschinenlesbar (classifyMarketDataError).
      throw new MarketDataHttpError(res.status, safeHost(url));
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new MarketDataSchemaError(
        `Antwort ist kein gültiges JSON (${err instanceof Error ? err.message.slice(0, 80) : "unbekannt"})`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MARKET_DATA_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce<T>(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      const { reason, retryable, httpStatus } = classifyMarketDataError(err);
      if (!retryable || attempt >= MARKET_DATA_FETCH_ATTEMPTS) throw err;
      structuredLog("warn", "market_data_fetch_retry", {
        reason,
        httpStatus: httpStatus ?? null,
        attempt,
        maxAttempts: MARKET_DATA_FETCH_ATTEMPTS,
        venue: safeHost(url),
      });
      await sleep(MARKET_DATA_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr;
}

async function binancePrice(symbol: string): Promise<number> {
  const data = await fetchJson<{ price: string }>(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binancePair(symbol))}`
  );
  const p = Number(data.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Binance: ungültiger Preis");
  return p;
}

async function yahooPrice(symbol: string): Promise<number> {
  const data = await fetchJson<{
    chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
  }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const p = data.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!p || !Number.isFinite(p) || p <= 0) throw new Error("Yahoo: kein Kurs");
  return p;
}

async function binanceCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const raw = await fetchJson<unknown>(
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binancePair(symbol))}&interval=${interval}&limit=${limit}`
  );
  if (!Array.isArray(raw)) {
    throw new MarketDataSchemaError("Binance klines: Antwort ist kein Array");
  }
  const out: Candle[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) {
      throw new MarketDataSchemaError("Binance klines: Zeile unvollständig");
    }
    const values = (r as unknown[]).slice(0, 6);
    // Nur Zahl oder nicht-leerer String ist eine valide Binance-Zelle —
    // null/"" würden durch Number() zu 0 und damit still falsche Kerzen.
    if (values.some((v) => (typeof v !== "number" && typeof v !== "string") || (typeof v === "string" && v.trim() === ""))) {
      throw new MarketDataSchemaError("Binance klines: ungültige Zelle");
    }
    const [time, open, high, low, close, volume] = values.map(Number);
    if (![time, open, high, low, close, volume].every((v) => Number.isFinite(v))) {
      throw new MarketDataSchemaError("Binance klines: nicht-numerische Werte");
    }
    out.push({ time, open, high, low, close, volume });
  }
  return out;
}

interface YahooChart {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[];
  };
}

async function yahooCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  // Intraday → 5 Tage Historie reicht; 1d-Kerzen (Swing) → 6 Monate.
  const range = interval.endsWith("m") ? "5d" : interval === "1d" ? "6mo" : "1mo";
  const data = await fetchJson<YahooChart>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
  );
  // Yahoo liefert für unbekannte/delistete Symbole oft HTTP 200 mit
  // `chart.error` — das ist ein NOT_FOUND, kein Schema-Fehler.
  const chartError = (data as { chart?: { error?: { code?: string; description?: string } } }).chart?.error;
  if (data.chart && !data.chart.result) {
    if (/(not found|no data)/i.test(chartError?.code ?? "") || /no data found/i.test(chartError?.description ?? "")) {
      throw new MarketDataHttpError(404, symbol);
    }
    throw new MarketDataSchemaError("Yahoo: chart.result fehlt");
  }
  const r = data.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !Array.isArray(r.timestamp) || !q?.close || !Array.isArray(q.close)) {
    throw new MarketDataSchemaError("Yahoo: keine gültigen Kerzen in der Antwort");
  }
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c == null) continue;
    const t = Number(r.timestamp[i]) * 1000;
    if (!Number.isFinite(t)) throw new MarketDataSchemaError("Yahoo: ungültiger Timestamp");
    out.push({
      time: t,
      open: q.open?.[i] ?? c, high: q.high?.[i] ?? c, low: q.low?.[i] ?? c,
      close: c, volume: q.volume?.[i] ?? 0,
    });
  }
  return out.slice(-limit);
}

/**
 * Liefert den aktuellen Kurs. Nutzt den Cache wenn frisch genug, sonst die
 * passende Quelle; schlägt die fehl, fällt er auf Cache → statisches Buch zurück.
 */
export async function getQuote(symbolRaw: string): Promise<Quote> {
  const symbol = sanitizeSymbol(symbolRaw);
  if (!symbol) throw new Error(`Ungültiges Symbol: ${String(symbolRaw).slice(0, 40)}`);
  const cached = quoteCache.get(symbol);

  if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) {
    return { symbol, price: cached.price, source: "cache", ts: cached.ts };
  }

  try {
    const price = isCrypto(symbol)
      ? await binancePrice(symbol)
      : await yahooPrice(symbol);
    quoteCache.set(symbol, { price, ts: Date.now(), source: "live" });
    return { symbol, price, source: isCrypto(symbol) ? "binance" : "yahoo", ts: Date.now() };
  } catch {
    if (cached) {
      return { symbol, price: cached.price, source: "cache", ts: cached.ts };
    }
    const fallback = STATIC_PRICES[symbol];
    if (fallback != null) {
      return { symbol, price: fallback, source: "static", ts: Date.now() };
    }
    throw new Error(`Kein Kurs für ${symbol} verfügbar`);
  }
}

/** Synchroner Lesezugriff auf den Cache (für Broker-Hot-Path). */
export function getQuoteSync(symbolRaw: string): number | null {
  const symbol = sanitizeSymbol(symbolRaw);
  if (!symbol) return null;
  const cached = quoteCache.get(symbol);
  if (cached) return cached.price;
  return STATIC_PRICES[symbol] ?? null;
}

/** Holt Kurse für eine ganze Liste (sequenziell, Fehler pro Symbol isoliert). */
export async function refreshQuotes(symbols: string[]): Promise<Quote[]> {
  const out: Quote[] = [];
  for (const s of [...new Set(symbols.map((x) => x.toUpperCase()))]) {
    try {
      out.push(await getQuote(s));
    } catch {
      /* Symbol überspringen — Cache/Statisches bleibt gültig */
    }
  }
  return out;
}

/** Normalisiert das Kerzen-Limit (1…1000, Default 120). */
function resolveCandleLimit(limitRaw: number): number {
  return Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000)
    : 120;
}

/** Venue-Bezeichnung für Metrik/Fehler (Identisch zur Quellenwahl). */
function venueForSymbol(symbol: string | null): string {
  return symbol && isCrypto(symbol) ? "binance" : "yahoo";
}

/**
 * Kerzen für Indikatorenberechnung, mit Cache.
 *
 * **Failure-Semantik (MDERR-006):** Bei echten Fehlern (HTTP 429/5xx, DNS,
 * TLS, Schema-Abweichung, ungültiges Symbol) wird ein typisierter
 * `MarketDataFetchError` geworfen — nach Metrik-Inkrement und strukturiertem
 * Log. Ein leeres Array ist ausschließlich die nachweisliche Venue-Antwort
 * „keine Bars für dieses Symbol/Timeframe“ und wird **nicht** als Fehler
 * behandelt.
 */
export async function getCandles(
  symbolRaw: string,
  intervalRaw = "5m",
  limitRaw = 120
): Promise<Candle[]> {
  const symbol = sanitizeSymbol(symbolRaw);
  const interval = sanitizeInterval(intervalRaw, "5m");
  const limit = resolveCandleLimit(limitRaw);
  const venue = venueForSymbol(symbol);

  if (!symbol) {
    // Ungültiges Symbol = Konfigurations-/Input-Fehler, niemals []. Ohne
    // gültiges Symbol existiert kein Catchable-Fehler → direkt typisiert.
    const reason: MarketDataErrorReason = "INVALID_SYMBOL";
    telemetry.marketData.fetchFailures.inc({ venue: "unknown", timeframe: interval, reason });
    const logSymbol = sanitizeLogLabel(symbolRaw);
    structuredLog("error", "market_data_fetch_failed", {
      venue: "unknown",
      symbol: logSymbol,
      timeframe: interval,
      reason,
      httpStatus: null,
      retryable: false,
      message: fetchFailedLogMessage("unknown", logSymbol, interval, reason),
    });
    throw new MarketDataFetchError({
      venue: "unknown",
      symbol: sanitizeLogLabel(symbolRaw),
      timeframe: interval,
      reason,
      retryable: false,
      cause: new Error(`Ungültiges Symbol: ${sanitizeLogLabel(symbolRaw)}`),
    });
  }

  const key = `${symbol}:${interval}:${limit}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.ts < CANDLE_TTL_MS) return cached.candles;

  try {
    const candles = isCrypto(symbol)
      ? await binanceCandles(symbol, interval, limit)
      : await yahooCandles(symbol, interval, limit);
    // WICHTIG (MDERR-006): Ein leeres Array ist eine GÜLTIGE Antwort („die
    // Venue hat keine Bars geliefert“). Es wird bewusst gecacht und
    // zurückgegeben — ein Abruf-Fehler wird darunter NICHT versteckt.
    candleCache.set(key, { candles, ts: Date.now() });
    return candles;
  } catch (err) {
    // ─────────────────────────────────────────────────────────────────────
    // KEINE Degradation auf `cached?.candles ?? []`. Ein Netzwerk-/API-Fehler
    // ist von „0 Kerzen vorhanden“ nur unterscheidbar, wenn er geworfen wird.
    // Ein stilles [] würde im Scanner als `min-candles` erscheinen und
    // Faktoren neutralisieren, statt die Ausführung zu stoppen. Bewusste
    // Cache-Nutzung ist ausschließlich über getCandlesWithFallback() möglich.
    // ─────────────────────────────────────────────────────────────────────
    const { reason, retryable, httpStatus } = classifyMarketDataError(err);
    // Metrik OHNE symbol-Label (Kardinalität/Speicher-DoS, siehe Security).
    telemetry.marketData.fetchFailures.inc({ venue, timeframe: interval, reason });
    structuredLog("error", "market_data_fetch_failed", {
      venue,
      symbol,
      timeframe: interval,
      reason,
      httpStatus: httpStatus ?? null,
      retryable,
      message: fetchFailedLogMessage(venue, symbol, interval, reason),
    });
    if (reason === "UNAUTHORIZED") {
      // Public-Endpunkt darf nie 401/403 liefern → Konfigurationsfehler laut
      // alarmieren (versehentlicher Private-/Auth-Endpoint-Aufruf).
      structuredLog("critical", "market_data_unauthorized_public_endpoint", {
        venue,
        symbol,
        timeframe: interval,
        httpStatus: httpStatus ?? null,
        retryable,
      });
    }
    throw new MarketDataFetchError({
      venue,
      symbol,
      timeframe: interval,
      reason,
      retryable,
      httpStatus,
      cause: err,
    });
  }
}

/** Kürzt/redigiert ein Symbol nur für Log-Felder (nie für Metriken). */
function sanitizeLogLabel(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

/**
 * Menschlich lesbare, einzeilige Fehlerzeile im strukturierten Log. Sie macht
 * explizit, dass ein `MarketDataFetchError` ein Infrastruktur-/API-Fehler ist
 * — KEIN Hinweis auf fehlende Markthistorie. Siehe
 * docs/ERROR_HANDLING_MARKETDATA.md für den Entscheidungsbaum.
 */
function fetchFailedLogMessage(
  venue: string,
  symbol: string,
  timeframe: string,
  reason: string,
): string {
  return (
    `[market-data] FETCH FAILED venue=${venue} symbol=${symbol} timeframe=${timeframe} reason=${reason} ` +
    `— this is an infrastructure/API error, NOT an indication of missing market history. ` +
    `See docs/ERROR_HANDLING_MARKETDATA.md`
  );
}

/** Ergebnis des bewussten Cache-Fallbacks (MDERR-006). */
export interface CandleFallbackResult {
  candles: Candle[];
  /** `live` = frischer Abruf/frischer Cache (< TTL); `cache` = bewusster Stale-Fallback. */
  source: "live" | "cache";
  /** `true`, wenn der Fallback einen veralteten Cache-Eintrag verwendet. */
  stale: boolean;
  /** Alter des Cache-Eintrags in ms (nur bei stale). */
  ageMs: number | null;
  /** Ursprünglicher Fehler, der den Fallback ausgelöst hat. */
  error?: MarketDataFetchError;
}

/**
 * Liefert Kerzen und macht Staleness explizit sichtbar. Aufrufer, die einen
 * degradierten Betrieb erlauben duerfen (z. B. UI-Preview), nutzen diese
 * Funktion bewusst. Der Scanner-/Executor-Pfad nutzt sie NICHT.
 *
 * Ohne Cache-Eintrag wird der `MarketDataFetchError` weitergereicht — ein
 * leeres Array allein würde niemals „Abruf fehlgeschlagen“ verschleiern.
 */
export async function getCandlesWithFallback(
  symbolRaw: string,
  intervalRaw = "5m",
  limitRaw = 120
): Promise<CandleFallbackResult> {
  try {
    const candles = await getCandles(symbolRaw, intervalRaw, limitRaw);
    return { candles, source: "live", stale: false, ageMs: null };
  } catch (err) {
    if (!(err instanceof MarketDataFetchError)) throw err;
    const symbol = sanitizeSymbol(symbolRaw);
    if (!symbol) throw err;
    const key = `${symbol}:${sanitizeInterval(intervalRaw, "5m")}:${resolveCandleLimit(limitRaw)}`;
    const cached = candleCache.get(key);
    if (!cached) throw err;
    structuredLog("warn", "market_data_cache_fallback_used", {
      venue: venueForSymbol(symbol),
      symbol,
      timeframe: sanitizeInterval(intervalRaw, "5m"),
      ageMs: Math.max(0, Date.now() - cached.ts),
      reason: err.reason,
    });
    return {
      candles: cached.candles,
      source: "cache",
      stale: true,
      ageMs: Math.max(0, Date.now() - cached.ts),
      error: err,
    };
  }
}

/** Nur für Tests: Cache-Schicht zurücksetzen (isolierte Testläufe). */
export function resetMarketDataCachesForTests(): void {
  candleCache.clear();
  quoteCache.clear();
}

// ── Screener (Penny-Scout-Quelle) ────────────────────────────────────────────

export type ScreenerCandidate = {
  symbol: string;
  name?: string;
  price: number;
  changePct?: number;
  volume?: number;
};

const GLOBAL2 = globalThis as typeof globalThis & {
  __screenerCache?: Map<string, { at: number; items: ScreenerCandidate[] }>;
};
const screenerCache = (GLOBAL2.__screenerCache ??= new Map());
const SCREENER_TTL_MS = 30 * 60_000; // 30 Min — Screener-Daten sind nicht eilig

/**
 * Yahoo Predefined Screener (inoffiziell, kostenlos):
 *   day_gainers | day_losers | most_actives | undervalued_growth_stocks …
 * Für den Penny-Scout filtern wir anschließend auf Preis < maxPrice.
 */
export async function yahooScreener(
  scrIdRaw: string,
  maxPriceRaw = 5,
  countRaw = 25
): Promise<ScreenerCandidate[]> {
  if (typeof scrIdRaw !== "string" || !/^[a-z][a-z0-9_]{2,40}$/i.test(scrIdRaw)) {
    throw new Error("Ungültiger Screener-Identifier");
  }
  const scrId = scrIdRaw;
  const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : 5;
  const count = Number.isFinite(countRaw)
    ? Math.min(Math.max(Math.trunc(countRaw), 1), 50)
    : 25;
  const cacheKey = `${scrId}:${maxPrice}`;
  const cached = screenerCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SCREENER_TTL_MS) return cached.items;

  interface ScreenerQuote {
    symbol?: string;
    shortName?: string;
    regularMarketPrice?: number;
    regularMarketChangePercent?: number;
    regularMarketVolume?: number;
  }
  interface ScreenerResp {
    finance?: {
      result?: {
        quotes?: ScreenerQuote[];
      }[];
    };
  }
  const data = await fetchJson<ScreenerResp>(
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(scrId)}&count=${count}`,
    10_000
  );
  const quotes = data.finance?.result?.[0]?.quotes ?? [];
  const items: ScreenerCandidate[] = [];
  for (const q of quotes) {
    const price = Number(q.regularMarketPrice);
    if (!q.symbol || !Number.isFinite(price) || price <= 0 || price >= maxPrice) continue;
    items.push({
      symbol: q.symbol,
      name: q.shortName,
      price,
      changePct: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
    });
  }
  screenerCache.set(cacheKey, { at: Date.now(), items });
  return items;
}

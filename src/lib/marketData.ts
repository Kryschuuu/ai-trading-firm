/**
 * Multi-Market-Datenquelle mit Cache.
 *
 * Abgedeckte Märkte (alle ohne API-Key):
 *   - Krypto (24/7):  Binance Public REST  → BTC, ETH, SOL …
 *   - Aktien/ETF:     Yahoo Finance Chart  → AAPL, NVDA, SPY, QQQ …
 *   - Devisen:        Yahoo Finance Chart  → EURUSD=X, USDJPY=X …
 *
 * Fällt eine Quelle aus, wird der letzte gecachte Kurs genutzt; fehlt auch der,
 * greift das statische Paper-Buch. Der Betrieb bleibt also immer möglich —
 * die Kurse sind dann eben nur nicht live.
 */

import { WATCHLIST_DISPLAY_SYMBOLS } from "../universe/watchlist";

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

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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
  const raw = await fetchJson<unknown[][]>(
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binancePair(symbol))}&interval=${interval}&limit=${limit}`
  );
  return raw.map((r) => ({
    time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
    low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
  }));
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
  const r = data.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q?.close) throw new Error("Yahoo: keine Kerzen");
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c == null) continue;
    out.push({
      time: r.timestamp[i] * 1000,
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

/** Kerzen für Indikatorenberechnung, mit Cache. */
export async function getCandles(
  symbolRaw: string,
  intervalRaw = "5m",
  limitRaw = 120
): Promise<Candle[]> {
  const symbol = sanitizeSymbol(symbolRaw);
  if (!symbol) return [];
  const interval = sanitizeInterval(intervalRaw, "5m");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000)
    : 120;
  const key = `${symbol}:${interval}:${limit}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.ts < CANDLE_TTL_MS) return cached.candles;

  try {
    const candles = isCrypto(symbol)
      ? await binanceCandles(symbol, interval, limit)
      : await yahooCandles(symbol, interval, limit);
    if (candles.length < 2) throw new Error("zu wenige Kerzen");
    candleCache.set(key, { candles, ts: Date.now() });
    return candles;
  } catch {
    return cached?.candles ?? [];
  }
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

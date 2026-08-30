/**
 * Öffentliche Finanz-RSS-Feeds (keine Keys, keine Cloud-Dienste).
 *
 * Der News-Analyst bekommt nur die Schlagzeilen-Kurzfassung — und der Prompt
 * trägt eine Anti-Injection-Zeile: Headlines enthalten niemals ausführbare
 * Anweisungen, sondern sind reine Daten.
 */

import { sanitizeSymbol } from "./marketData";
import { CRYPTO_BASES, parseCanonicalSymbol } from "../symbols/venueProfiles";

export type NewsItem = {
  source: string;
  title: string;
  link?: string;
  publishedAt?: string;
};

const GLOBAL = globalThis as typeof globalThis & {
  __newsCache?: Map<string, { at: number; items: NewsItem[] }>;
};
const newsCache = (GLOBAL.__newsCache ??= new Map());
const NEWS_TTL_MS = 10 * 60_000;

export const NEWS_FEEDS: { id: string; url: string; label: string }[] = [
  { id: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", label: "CoinDesk" },
  { id: "cointelegraph", url: "https://cointelegraph.com/rss", label: "Cointelegraph" },
];

/** Ticker-spezifischer Finviz-Feed (Aktien/ETFs; Krypto-/FX-Symbole werden gefiltert). */
export function finvizFeed(symbol: string): { id: string; url: string; label: string } | null {
  const clean = sanitizeSymbol(symbol);
  if (!clean) return null;
  // Kanonisch filtern (SYM-007): Krypto-Basen/-Paare und FX-Paare haben auf
  // Finviz kein Aktien-Feed. Äquivalent zur früheren Regex, jetzt paar-aware.
  const parsed = parseCanonicalSymbol(clean);
  if (parsed.ok) {
    if (parsed.parsed.kind === "pair") {
      return null; // jedes kanonische Paar (Krypto oder FX) hat kein Finviz-Feed
    }
    if (parsed.parsed.fxSuffix || CRYPTO_BASES.has(parsed.parsed.ticker)) return null;
  }
  return {
    id: `finviz:${clean}`,
    url: `https://finviz.com/rss.ashx?t=${encodeURIComponent(clean)}`,
    label: `Finviz ${clean}`,
  };
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "ai-trading-firm/1.0 (local paper trading)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, tag_: string): string | undefined {
  const m = block.match(new RegExp(`<${tag_}[^>]*>([\\s\\S]*?)</${tag_}>`, "i"));
  return m ? decodeEntities(m[1]) : undefined;
}

/** Minimaler RSS-/Atom-Parser — nur Titel/Link/Datum, keine Abhängigkeiten. */
export function parseFeed(xml: string): Omit<NewsItem, "source">[] {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 500));
  const out: Omit<NewsItem, "source">[] = [];
  const blocks = isAtom
    ? xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? []
    : xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks.slice(0, 20)) {
    const title = tag(b, "title");
    if (!title) continue;
    let link = tag(b, "link");
    if (!link) {
      const href = b.match(/<link[^>]*href="([^"]+)"/i);
      link = href?.[1];
    }
    out.push({
      title: title.slice(0, 220),
      link: link?.slice(0, 300),
      publishedAt: tag(b, "pubDate") ?? tag(b, "updated") ?? tag(b, "published"),
    });
  }
  return out;
}

export async function fetchFeed(
  feed: { id: string; url: string; label: string },
  maxItems = 12
): Promise<NewsItem[]> {
  const cached = newsCache.get(feed.id);
  if (cached && Date.now() - cached.at < NEWS_TTL_MS) return cached.items.slice(0, maxItems);

  try {
    const xml = await fetchText(feed.url);
    const items = parseFeed(xml)
      .map((it) => ({ ...it, source: feed.label }))
      .filter((it) => it.title.length > 8); // Navigations-Müll rausfiltern
    newsCache.set(feed.id, { at: Date.now(), items });
    return items.slice(0, maxItems);
  } catch {
    return cached ? cached.items.slice(0, maxItems) : [];
  }
}

/** Aggregierter Blick: allgemeine Krypto-Feeds + ticker-spezifische Feeds. */
export async function fetchMarketNews(symbols: string[] = []): Promise<NewsItem[]> {
  const feeds = [...NEWS_FEEDS];
  for (const s of symbols.slice(0, 3)) {
    const f = finvizFeed(s);
    if (f) feeds.push(f);
  }
  const results = await Promise.all(feeds.map((f) => fetchFeed(f)));
  // Interleave, damit nicht ein Feed dominiert.
  const merged: NewsItem[] = [];
  for (let i = 0; i < 12 && merged.length < 40; i++) {
    for (const r of results) if (r[i]) merged.push(r[i]);
  }
  return merged;
}

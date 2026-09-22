/**
 * Deduplikation und Syndikationsschutz für Finanznachrichten (RMA-P2-05).
 *
 * Verhindert, dass dieselbe Meldung über mehrere Feeds (z. B. CoinDesk,
 * Cointelegraph, Finviz, Bloomberg) die Quellenanzahl oder die Konfidenz
 * künstlich in die Höhe treibt.
 *
 * Algorithmus:
 * 1. Bereinigung von Titeln (Entfernen von Feed-Tags, Ticker-Suffixen, Interpunktion).
 * 2. Deterministisches Content-Hashing über den normalisierten Titel.
 * 3. Near-Duplicate-Erkennung über Token-Jaccard-Ähnlichkeit innerhalb eines
 *    rollierenden Zeitfensters (Default 24h).
 * 4. Multi-Entity-Erkennung und -Zuordnung.
 */

import { createHash } from "node:crypto";
import {
  SENTIMENT_LIMITS,
  type DeduplicatedNewsSource,
  type SentimentNewsItem,
} from "./types";

/** Bekannte Ticker- und Namens-Synonyme für präzises Matching. */
const COMMON_ENTITY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  BTC: ["BTC", "BITCOIN", "XBT"],
  ETH: ["ETH", "ETHEREUM", "ETHER"],
  SOL: ["SOL", "SOLANA"],
  SPY: ["SPY", "S&P", "S&P500", "SP500"],
  QQQ: ["QQQ", "NASDAQ", "NDX"],
  NVDA: ["NVDA", "NVIDIA"],
  AAPL: ["AAPL", "APPLE"],
  MSFT: ["MSFT", "MICROSOFT"],
  AMD: ["AMD"],
  META: ["META", "FACEBOOK"],
  GOOGL: ["GOOGL", "GOOG", "ALPHABET", "GOOGLE"],
  AMZN: ["AMZN", "AMAZON"],
  TSLA: ["TSLA", "TESLA"],
};

/** Entfernt typische Feed- und Agentur-Zusätze aus Schlagzeilen. */
export function stripFeedArtifacts(headline: string): string {
  if (!headline || typeof headline !== "string") return "";
  return headline
    // Führende Tags: [CoinDesk], [Reuters], etc.
    .replace(/^\s*\[(?:CoinDesk|Cointelegraph|Reuters|Bloomberg|Finviz|Yahoo|Decrypt|The Block|CNBC|Forbes)\]\s*/i, "")
    // Nachgestellte Quellenmarken: - CoinDesk, | Cointelegraph, etc.
    .replace(/\s*(?:[-–—|]\s*(?:CoinDesk|Cointelegraph|Reuters|Bloomberg|Finviz|Yahoo(?:\s*Finance)?|Decrypt|The Block|CNBC|Forbes|WSJ|CoinMarketCap|MarketWatch).*)$/i, "")
    // Eingeklammerte Agenturvermerke: (Reuters), (Bloomberg), (AP)
    .replace(/\s*\((?:Reuters|Bloomberg|Dow Jones|AP|AFP|Finviz)\)/gi, "")
    .trim();
}

/**
 * Normalisiert einen Titel deterministisch:
 * - Kleinschreibung
 * - Entfernung von Interpunktion und Sonderzeichen
 * - Kollabieren von Whitespace
 */
export function normalizeHeadlineTitle(headline: string): string {
  const stripped = stripFeedArtifacts(headline);
  return stripped
    .toLowerCase()
    .normalize("NFKD")
    .replace(/,/g, "")
    .replace(/['"’`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Erzeugt einen deterministischen SHA-256-Hash des normalisierten Titels. */
export function headlineContentHash(normalizedTitle: string): string {
  return createHash("sha256").update(normalizedTitle, "utf8").digest("hex");
}

/** Zerlegt einen normalisierten Text in signifikante Token (Länge >= 3). */
export function titleTokens(normalizedTitle: string): Set<string> {
  const words = normalizedTitle.split(/\s+/);
  const set = new Set<string>();
  for (const w of words) {
    if (w.length >= 3) {
      set.add(w);
    }
  }
  return set;
}

/** Berechnet die Jaccard-Ähnlichkeit zweier Token-Mengen: |A ∩ B| / |A ∪ B|. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

/** Parst einen Zeitstempel robust und liefert `null` bei ungültigen Werten. */
export function parseNewsTimestamp(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * Extrahiert Entitäten / Ticker aus einer Schlagzeile.
 * Unterstützt explizite Zielentitäten sowie allgemeine Ticker-Synonyme.
 */
export function extractEntitiesFromHeadline(
  headline: string,
  targetEntities: readonly string[] = []
): string[] {
  const upper = headline.toUpperCase();
  const matched = new Set<string>();

  // 1. Prüfe gegen bereitgestellte Zielentitäten (z. B. Top-40-Symbole)
  for (const target of targetEntities) {
    const cleanTarget = target.replace(/^(?:BINANCE:|BITUNIX:|PAPER:|ALPACA:)/i, "").toUpperCase();
    const regex = new RegExp(`\\b${cleanTarget}\\b`, "i");
    if (regex.test(upper)) {
      matched.add(cleanTarget);
    }
  }

  // 2. Prüfe gegen das Standard-Synonym-Verzeichnis
  for (const [canonical, aliases] of Object.entries(COMMON_ENTITY_SYNONYMS)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias}\\b`, "i");
      if (regex.test(upper)) {
        matched.add(canonical);
        break;
      }
    }
  }

  return [...matched].sort();
}

export interface DeduplicateNewsOptions {
  /** Zeitfenster für Syndikations-Erkennung (Default 24h). */
  syndicationWindowMs?: number;
  /** Ähnlichkeitsschwelle für Paraphrasen (Default 0.80). */
  similarityThreshold?: number;
  /** Liste bekannter Ziel-Entitäten zur Zuordnung. */
  targetEntities?: readonly string[];
  /** As-of-Zeitpunkt (Schutz vor zukünftigen Daten / Look-ahead). */
  asOf?: Date;
}

/**
 * Dedupliziert eine Liste von Nachrichtenartikeln deterministisch.
 *
 * Fasst identische oder stark paraphrasierte Meldungen desselben Zeitfensters
 * zusammen, zählt Syndikationen und liefert strukturierte Quellenberichte.
 */
export function deduplicateNewsSources(
  items: readonly SentimentNewsItem[],
  options: DeduplicateNewsOptions = {}
): DeduplicatedNewsSource[] {
  const windowMs = options.syndicationWindowMs ?? SENTIMENT_LIMITS.syndicationWindowMs;
  const threshold = options.similarityThreshold ?? 0.80;
  const asOfMs = options.asOf?.getTime();
  const targetEntities = options.targetEntities ?? [];

  const deduplicated: DeduplicatedNewsSource[] = [];
  const tokenCache: Set<string>[] = [];

  for (const raw of items) {
    if (!raw || typeof raw.headline !== "string" || raw.headline.trim().length === 0) {
      continue;
    }

    const pubDate = parseNewsTimestamp(raw.publishedAt);
    // Point-in-Time-Guard: Quellen aus der Zukunft (nach asOf) ausschließen
    if (asOfMs !== undefined && pubDate !== null && pubDate.getTime() > asOfMs) {
      continue;
    }

    const norm = normalizeHeadlineTitle(raw.headline);
    if (norm.length === 0) continue;

    const hash = headlineContentHash(norm);
    const tokens = titleTokens(norm);
    const pubMs = pubDate ? pubDate.getTime() : null;
    const sourceLabel = raw.source ? raw.source.trim() : "unknown";

    // Ermittle Entitäten
    const entityMatches = extractEntitiesFromHeadline(raw.headline, targetEntities);
    if (raw.symbol && typeof raw.symbol === "string") {
      const cleanSym = raw.symbol.replace(/^(?:BINANCE:|BITUNIX:|PAPER:|ALPACA:)/i, "").toUpperCase();
      if (!entityMatches.includes(cleanSym)) {
        entityMatches.push(cleanSym);
      }
    }

    // Suche bestehenden Cluster
    let matchedCluster: DeduplicatedNewsSource | null = null;
    for (let i = 0; i < deduplicated.length; i++) {
      const existing = deduplicated[i];
      // 1. Exakter Hash-Match
      if (existing.contentHash === hash) {
        matchedCluster = existing;
        break;
      }

      // 2. Ähnlichkeits-Match innerhalb des Zeitfensters
      if (pubMs !== null && existing.earliestAt !== null) {
        const timeDiff = Math.abs(pubMs - existing.earliestAt.getTime());
        if (timeDiff <= windowMs) {
          const sim = jaccardSimilarity(tokens, tokenCache[i]);
          if (sim >= threshold) {
            matchedCluster = existing;
            break;
          }
        }
      }
    }

    if (matchedCluster) {
      // Syndikation registrieren
      matchedCluster.syndicationCount += 1;
      if (!matchedCluster.sources.includes(sourceLabel)) {
        matchedCluster.sources.push(sourceLabel);
      }
      if (pubDate !== null) {
        if (matchedCluster.earliestAt === null || pubDate < matchedCluster.earliestAt) {
          matchedCluster.earliestAt = pubDate;
        }
        if (matchedCluster.latestAt === null || pubDate > matchedCluster.latestAt) {
          matchedCluster.latestAt = pubDate;
        }
      }
      for (const ent of entityMatches) {
        if (!matchedCluster.entityMatches.includes(ent)) {
          matchedCluster.entityMatches.push(ent);
        }
      }
    } else {
      // Neuer Cluster
      const newSource: DeduplicatedNewsSource = {
        contentHash: hash,
        normalizedTitle: norm,
        primarySource: sourceLabel,
        sources: [sourceLabel],
        syndicationCount: 1,
        earliestAt: pubDate,
        latestAt: pubDate,
        entityMatches,
        rawHeadline: raw.headline.slice(0, SENTIMENT_LIMITS.maxHeadlineLength),
      };
      deduplicated.push(newSource);
      tokenCache.push(tokens);
    }
  }

  return deduplicated;
}

/**
 * Filtert deduplizierte Quellen nach Relevanz für ein bestimmtes Symbol
 * oder Instrument.
 *
 * Bevorzugt spezifische Treffer. Liegen keine spezifischen Treffer vor,
 * können allgemeine Marktnachrichten (ohne Ticker-Bindung) einbezogen werden.
 */
export function filterSourcesForEntity(
  sources: readonly DeduplicatedNewsSource[],
  entityOrSymbol: string,
  options: { includeGeneral?: boolean } = {}
): DeduplicatedNewsSource[] {
  if (!entityOrSymbol) return [];
  const clean = entityOrSymbol.replace(/^(?:BINANCE:|BITUNIX:|PAPER:|ALPACA:)/i, "").toUpperCase();
  const includeGeneral = options.includeGeneral ?? true;

  // 1. Spezifische Matches für dieses Instrument
  const specific = sources.filter((s) => {
    if (s.entityMatches.some((e) => e === clean)) return true;
    const regex = new RegExp(`\\b${clean}\\b`, "i");
    return regex.test(s.normalizedTitle);
  });

  if (specific.length > 0 || !includeGeneral) {
    return specific;
  }

  // 2. Allgemeine Marktnachrichten (ohne spezifische Entitätsbindung)
  return sources.filter((s) => s.entityMatches.length === 0);
}

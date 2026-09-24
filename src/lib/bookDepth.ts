/**
 * Orderbuch-Tiefe als USD-Notional (`bookDepthUsd`, v0.4.0, IAD-T-06).
 *
 * Die Fortsetzung von `spreadPct`: Der Top-Level-Spread beantwortet nur
 * „wie teuer ist der Touch?“, die Tiefe beantwortet „wie viel Quote liegt
 * wirklich im Buch, bevor ich den Kurs bewege?“. Beide zusammen sind die
 * Kosten-/Liquiditätsprüfung des Daytradings — Spread allein kann ein
 * dünnes Buch (ein Level, danach nichts) von einem tiefen Buch (viele
 * Levels) nicht unterscheiden.
 *
 * Berechnung (deterministisch, aus den Roh-Levels eines
 * {@link MarketOrderBook}-Snapshots):
 *
 * - Die Level werden je Seite über dem Mid gecleant:
 *     Bids  nur Preise ≤ mid,
 *     Asks  nur Preise ≥ mid.
 *   Ein gekreuztes oder einseitiges Buch liefert `null` (fail-closed,
 *   wie `spread`: eine erfundene Tiefe ist gefährlicher als keine).
 * - `bidDepthUsd`/`askDepthUsd` = Σ(price × qty) der gültigen Levels.
 * - `depthUsd` = min(bidDepthUsd, askDepthUsd) — die abriegelnde Seite ist
 *   die Engstelle. Eine Regel, die auf der schwachen Seite besteht, kann
 *   nicht davon träumen, die starke Seite „irgendwann“ zu erreichen.
 * - `mid`/`qty` aus `[price, qty]`-Tupeln (Venue-Rohform `[string, string]`),
 *   jedem Level-Objekt (`{ price, qty }`) oder `number`-Paaren. Es gilt der
 *   bestehende Repo-Vertrag: `Number()` konvertiert Venue-Strings, dann
 *   verwerfen `Number.isFinite`/Positivitäts-Guards kaputte Einträge.
 * - Die Roh-levels werden NIE über das Aufrufer-Limit hinaus gelesen
 *   (Security: fremdbestimmte Venue-Antworten). Übergebene Levels werden
 *   auf `maxLevels` gekappt, bevor irgendein Schritt sie liest.
 *
 * Konsumenten:
 * - `src/lib/microExecutor.updateBook` (live, WebSocket-Buch),
 * - `src/marketdata/enrichment.enrichWithOrderBooks` (sync),
 * - `src/cycle/trustedIndicators` (Messwert für den Analysten).
 *
 * WICHTIG: Reine arithmetische Funktion — importiert keine DB, kein ENV,
 * kein I/O, damit sie der Regelpfad und der Backtest deterministisch nutzen.
 */

/** Ein einzelnes Orderbuch-Level in einer der akzeptierten Rohformen. */
export type BookLevelInput =
  | readonly [unknown, unknown]
  | { readonly price?: unknown; readonly qty?: unknown }
  | { readonly price?: unknown; readonly size?: unknown };

/** Einseitige Tiefensumme einer Buchseite. */
export interface BookSideDepth {
  /** Summe über price × qty in Quote-Währung (z. B. USDT). */
  depthUsd: number;
  /** Anzahl gültiger Levels, die in die Summe eingingen. */
  levels: number;
}

/** Vollständiges Tiefen-Ergebnis für einen Buch-Snapshot. */
export interface BookDepth {
  /** Abriegelnde (schwächere) Seite: min(bid, ask). `null` ohne gültiges Buch. */
  depthUsd: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  /** Bestes gültiges Bid bzw. null. */
  bestBid: number | null;
  /** Bestes gültiges Ask bzw. null. */
  bestAsk: number | null;
  /** Anzahl gültiger Bid-/Ask-Levels (Diagnose). */
  bidLevels: number;
  askLevels: number;
}

/** `Number()` mit Endlichkeits-/Positivitätsprüfung; sonst null. */
function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  return n;
}

/** Nicht-negative Menge (0 ist gültig — Yahoo liefert qty 0 ohne Buchtiefe). */
function nonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Ein Roh-Level in `{ price, qty|size }`-Schreibweise oder ein
 * `[price, qty]`-Tupel. Gültig ist ein Level nur mit strikt positivem Preis
 * und nicht-negativer Menge — alles andere verfälscht die Summe.
 */
function levelToPair(level: BookLevelInput): { price: number; qty: number } | null {
  if (Array.isArray(level)) {
    if (level.length < 2) return null;
    const price = positiveNumber(level[0]);
    const qty = nonNegativeNumber(level[1]);
    if (price === null || qty === null) return null;
    return { price, qty };
  }
  if (level && typeof level === "object") {
    const obj = level as { price?: unknown; qty?: unknown; size?: unknown };
    const price = positiveNumber(obj.price);
    const qty =
      obj.qty !== undefined ? nonNegativeNumber(obj.qty) : nonNegativeNumber(obj.size);
    if (price === null || qty === null) return null;
    return { price, qty };
  }
  return null;
}

/**
 * Normalisiert eine beliebige Level-Liste zu geprüften `{price, qty}`-Paaren
 * und kappt sie hart auf `maxLevels` — bevor Summen gebildet werden.
 * Security: eine Venue-Antwort mit Millionen Levels darf weder die CPU noch
 * den Speicher übernehmen (Repo-Invariante aus `SYNC_LIMITS.maxBookLevels`).
 */
export function sanitizeBookLevels(
  levels: unknown,
  maxLevels: number,
): { price: number; qty: number }[] {
  const cap = Number.isFinite(maxLevels) && maxLevels > 0 ? Math.trunc(maxLevels) : 0;
  if (cap === 0 || !Array.isArray(levels)) return [];
  const out: { price: number; qty: number }[] = [];
  for (const raw of levels.slice(0, cap)) {
    const pair = levelToPair(raw as BookLevelInput);
    if (pair) out.push(pair);
  }
  return out;
}

/**
 * Berechnet die einseitige Tiefe: Σ(price × qty) über gültige Levels.
 * Ein Seitenfilter entfällt bewusst: `computeBookDepth` bestimmt `bestBid`
 * als Maximum und `bestAsk` als Minimum, der Mid liegt also per Konstruktion
 * zwischen den Top-Levels — jedes gültige Bid ist ≤ mid, jedes gültige Ask
 * ≥ mid. Kreuzseitige Müll-Levels erzeugen automatisch ein gekreuztes Top
 * (bestAsk < bestBid) und damit `depthUsd = null`.
 */
export function bookSideDepthUsd(
  levels: readonly { price: number; qty: number }[],
  mid: number | null,
): BookSideDepth {
  if (mid === null || !(mid > 0) || !Number.isFinite(mid)) {
    return { depthUsd: 0, levels: 0 };
  }
  let depthUsd = 0;
  let count = 0;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !(level.price > 0)) continue;
    if (!Number.isFinite(level.qty) || level.qty < 0) continue;
    depthUsd += level.price * level.qty;
    count += 1;
  }
  return { depthUsd, levels: count };
}

/**
 * Berechnet `bookDepthUsd` aus einem rohen Orderbuch-Snapshot.
 *
 * Best-Bid/Best-Ask sind ordnungsunabhängig bestimmt (maximaler Bid-Preis,
 * minimaler Ask-Preis) — die Rohlevel dürfen unsortiert oder venue-spezifisch
 * sortiert ankommen. Die Seitensummen werten anschließend nur Levels, die
 * auf der richtigen Seite des Mid liegen (Bids ≤ mid, Asks ≥ mid).
 *
 * @returns `depthUsd = null`, wenn das Buch ungültig ist: kein Bid/Ask,
 * gekreuztes Buch (bestAsk < bestBid) oder eine Seite ohne positive Nominale
 * (alle Mengen 0 — z. B. Yahoo mit unbekannter Lotgröße). `null` blockiert
 * Regelbedingungen (fail-closed); eine 0 wäre eine erfundene Tiefe.
 */
export function computeBookDepth(
  bids: unknown,
  asks: unknown,
  maxLevels = 10,
): BookDepth {
  const cleanBids = sanitizeBookLevels(bids, maxLevels);
  const cleanAsks = sanitizeBookLevels(asks, maxLevels);

  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const level of cleanBids) {
    if (bestBid === null || level.price > bestBid) bestBid = level.price;
  }
  for (const level of cleanAsks) {
    if (bestAsk === null || level.price < bestAsk) bestAsk = level.price;
  }

  const validMid =
    bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk >= bestBid
      ? (bestBid + bestAsk) / 2
      : null;

  const bidSide = bookSideDepthUsd(cleanBids, validMid);
  const askSide = bookSideDepthUsd(cleanAsks, validMid);

  // Bidirektional MIT positiver Nominale auf beiden Seiten. Eine Seite, deren
  // Summe 0 ist (nur qty=0-Levels), belegt keine Tiefe — unbekannt, nicht leer.
  const bidirectional =
    validMid !== null && bidSide.depthUsd > 0 && askSide.depthUsd > 0;

  return {
    depthUsd: bidirectional ? Math.min(bidSide.depthUsd, askSide.depthUsd) : null,
    bidDepthUsd: validMid !== null ? bidSide.depthUsd : null,
    askDepthUsd: validMid !== null ? askSide.depthUsd : null,
    bestBid,
    bestAsk,
    bidLevels: bidSide.levels,
    askLevels: askSide.levels,
  };
}

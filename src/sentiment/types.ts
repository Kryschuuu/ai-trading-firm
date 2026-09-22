/**
 * Kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05, v1.64.0).
 *
 * Erweitert unstrukturierte oder teil-strukturierte Sentiment-Daten
 * (View, Confidence, These) zu einem strikt validierten Forecast-Envelope
 * mit Entity-, Event-, Zeit-, Horizont-, Quellen-, Unsicherheits- und
 * Versionssemantik.
 *
 * ── Kernsemantik ────────────────────────────────────────────────────────────
 * 1. Trennung von Richtung und Unsicherheit:
 *    - `probability`: Direktionale Wahrscheinlichkeit des Ziel-Events UP
 *      im Intervall [0.01, 0.99] (Null bei ABSTAIN).
 *    - `coverage`: Quellenabdeckung / Datenqualität im Intervall [0, 1].
 *      Fehlende oder syndizierte Quellen senken die Coverage; sie dürfen
 *      niemals still als neutrales 0.5 getarnt werden.
 * 2. NEUTRAL vs. ABSTAIN:
 *    - `NEUTRAL`: Es liegen valide Quellen vor, die jedoch ein ausgeglichenes
 *      oder richtungsloses Bild ergeben (`status = ACTIVE`, `direction = NEUTRAL`,
 *      `probability = 0.50`, `abstain = false`, `coverage > 0`).
 *    - `ABSTAIN`: Keine Quellen vorhanden, Quellen unzureichend/stale oder
 *      unauflösbar widersprüchlich (`status = ABSTAIN`, `direction = null`,
 *      `probability = null`, `confidence = 0`, `abstain = true`,
 *      `abstainReason != null`, `coverage = 0`).
 * 3. Point-in-Time & No Look-ahead:
 *    - `sourceEventTime`: Veröffentlichungszeitpunkt der maßgeblichen Quelle.
 *    - `asOf`: Analyse-/Erfassungszeitpunkt (`generated_at`).
 *    - `validUntil`: Ende des Auswertungshorizonts (`resolves_at = asOf + horizon`).
 *    - Beim Erzeugen wird KEINE aktuelle Preis- oder Outcome-Information
 *      gespeichert.
 * 4. Deduplikation & Syndikationsschutz:
 *    - Syndizierte Meldungen (gleiche Meldung über mehrere Feeds) erhöhen die
 *      Quellenanzahl (`sourceCount`) und Coverage NICHT mehrfach.
 * 5. Idempotenz & P3.1-Kompatibilität:
 *    - Unveränderliche Forecast-ID: `sf1:<sha256>`.
 *    - Kompatibler Link zum P3.1 Forecast-Ledger (`ledgerForecastId`).
 * 6. Rückwärtskompatibilität:
 *    - Bestehende Konsumenten erhalten abgeleitete `sentiment`, `view`,
 *      `impactScore`, `riskFlags`, `summary` und `thesis`.
 *
 * @packageDocumentation
 */

/** Schema-Version des Sentiment-Forecast-Envelopes. */
export const SENTIMENT_SCHEMA_VERSION = "sentiment@1" as const;

/** Prompt-Version des Sentiment-Analysten. */
export const SENTIMENT_PROMPT_VERSION = 1 as const;

/** Zulässige direktionale Richtungen (geschlossenes Vokabular). */
export const SENTIMENT_DIRECTIONS = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
export type SentimentDirection = (typeof SENTIMENT_DIRECTIONS)[number];

export function isSentimentDirection(value: unknown): value is SentimentDirection {
  return typeof value === "string" && (SENTIMENT_DIRECTIONS as readonly string[]).includes(value as SentimentDirection);
}

/** Status des Sentiment-Forecasts. */
export const SENTIMENT_STATUSES = ["ACTIVE", "ABSTAIN"] as const;
export type SentimentStatus = (typeof SENTIMENT_STATUSES)[number];

export function isSentimentStatus(value: unknown): value is SentimentStatus {
  return typeof value === "string" && (SENTIMENT_STATUSES as readonly string[]).includes(value as SentimentStatus);
}

/** Unterstützte Zeithorizonte (geschlossen, kompatibel mit P3.1). */
export const SENTIMENT_HORIZONS = ["4h", "24h", "72h"] as const;
export type SentimentHorizon = (typeof SENTIMENT_HORIZONS)[number];

export function isSentimentHorizon(value: unknown): value is SentimentHorizon {
  return typeof value === "string" && (SENTIMENT_HORIZONS as readonly string[]).includes(value as SentimentHorizon);
}

/** Horizont-Dauer in Minuten. */
export const SENTIMENT_HORIZON_MINUTES: Readonly<Record<SentimentHorizon, number>> = {
  "4h": 240,
  "24h": 1440,
  "72h": 4320,
};

/** Geschlossene Liste fachlicher Event-Typen. */
export const SENTIMENT_EVENT_TYPES = [
  "MACRO",
  "EARNINGS",
  "REGULATORY",
  "PRODUCT",
  "SECURITY",
  "MARKET_STRUCTURE",
  "GENERAL",
] as const;
export type SentimentEventType = (typeof SENTIMENT_EVENT_TYPES)[number];

export function isSentimentEventType(value: unknown): value is SentimentEventType {
  return typeof value === "string" && (SENTIMENT_EVENT_TYPES as readonly string[]).includes(value as SentimentEventType);
}

/** Geschlossene Gründe für eine Enthaltung (ABSTAIN) — niemals Freitext. */
export const SENTIMENT_ABSTAIN_REASONS = [
  /** Keine Nachrichtenquellen für dieses Instrument vorhanden. */
  "NO_SOURCES",
  /** Vorhandene Quellen unterhalb des Mindestschwellenwerts. */
  "INSUFFICIENT_SOURCES",
  /** Extrem widersprüchliche Signale zwischen Quellen. */
  "CONFLICTING_SIGNALS",
  /** Vorhandene Quellen qualitativ unzureichend oder unlesbar. */
  "LOW_QUALITY",
  /** Alle Quellen älter als Schwellenwert (stale data). */
  "STALE_SOURCES",
  /** Manuell oder durch Filter ausgeschlossen. */
  "FILTERED",
] as const;
export type SentimentAbstainReason = (typeof SENTIMENT_ABSTAIN_REASONS)[number];

export function isSentimentAbstainReason(value: unknown): value is SentimentAbstainReason {
  return typeof value === "string" && (SENTIMENT_ABSTAIN_REASONS as readonly string[]).includes(value as SentimentAbstainReason);
}

/** Harte Grenzen (bounded by design). */
export const SENTIMENT_LIMITS = {
  /** Mindestanzahl eindeutiger Quellen für Status ACTIVE (Default). */
  minSourcesForActive: 1,
  /** Mindestabdeckung für Status ACTIVE. */
  minCoverageForActive: 0.1,
  /** Maximale Textlänge der Zusammenfassung / These. */
  maxSummaryLength: 500,
  /** Maximale Anzahl an Risikoflags. */
  maxRiskFlags: 5,
  /** Maximale Länge eines einzelnen Risikoflags. */
  maxRiskFlagLength: 32,
  /** Maximale Headline-Länge. */
  maxHeadlineLength: 300,
  /** Maximale Anzahl berücksichtigter Quellen je Forecast. */
  maxSourcesPerForecast: 50,
  /** Zeitfenster für Syndikations-Deduplikation in Millisekunden (24h). */
  syndicationWindowMs: 24 * 3_600_000,
  /** Maximaler Zeithorizont in Millisekunden (72h). */
  maxHorizonMs: 72 * 3_600_000,
  /** Schwellenwert für Veraltung von Nachrichtenquellen (48h). */
  staleSourceThresholdMs: 48 * 3_600_000,
  /** Untere/obere Schranke direktionaler Wahrscheinlichkeiten (Schutz vor unendlichem Log-Loss). */
  probabilityClipMin: 0.01,
  probabilityClipMax: 0.99,
  /** Maximale Einträge bei API-Listenabfragen. */
  maxListLimit: 200,
  defaultListLimit: 50,
} as const;

/** Roher oder vorverarbeiteter Nachrichtenartikel. */
export interface SentimentNewsItem {
  headline: string;
  source?: string;
  symbol?: string;
  publishedAt?: string | Date;
  link?: string;
}

/** Deduplizierte Quellenstory mit Syndikationsnachweis. */
export interface DeduplicatedNewsSource {
  /** SHA-256 des normalisierten Titels. */
  contentHash: string;
  /** Bereinigter und normalisierter Titel. */
  normalizedTitle: string;
  /** Primäre bzw. erste beobachtete Quelle (z. B. "CoinDesk"). */
  primarySource: string;
  /** Alle Quellen, die diese Meldung syndiziert haben (z. B. ["CoinDesk", "Finviz"]). */
  sources: string[];
  /** Anzahl der Syndikationen (mindestens 1). */
  syndicationCount: number;
  /** Frühester beobachteter Publikationszeitpunkt. */
  earliestAt: Date | null;
  /** Spätester beobachteter Publikationszeitpunkt. */
  latestAt: Date | null;
  /** Zugeordnete Instrumente / Entitäten. */
  entityMatches: string[];
  /** Unbereinigte Original-Headline zur Rückverfolgbarkeit. */
  rawHeadline: string;
}

/**
 * Der vollständige, kalibrierbare Sentiment-Forecast-Envelope.
 * Erfüllt alle Kriterien von RMA-P2-05 und bleibt gleichzeitig 100 % kompatibel
 * zu bestehenden Konsumenten (`InstrumentNewsAnalysis`).
 */
export interface StructuredSentimentForecast {
  /** `sf1:<sha256>` — Unveränderlicher, natürlicher Schlüssel (Idempotenz). */
  forecastId: string;
  /** Kanonische Entity-ID (z. B. `BINANCE:BTCUSDT` oder `PAPER:BTC`). */
  entityId: string;
  /** Ticker / Symbol wie vom Analysten referenziert (z. B. `BTC` oder `BTCUSDT`). */
  symbol: string;
  /** Direktionale Richtung: BULLISH | BEARISH | NEUTRAL (null bei ABSTAIN). */
  direction: SentimentDirection | null;
  /** Status: ACTIVE | ABSTAIN. */
  status: SentimentStatus;
  /** Direktionale Wahrscheinlichkeit UP ∈ [0.01, 0.99] (null bei ABSTAIN). */
  probability: number | null;
  /** Direktionale Konfidenz ∈ [0, 1] (0 bei ABSTAIN). */
  confidence: number;
  /** Explizites Enthaltungsflag. */
  abstain: boolean;
  /** Geschlossener Grund bei Enthaltung (null bei ACTIVE). */
  abstainReason: SentimentAbstainReason | null;
  /** Auswertungshorizont (`4h` | `24h` | `72h`). */
  horizon: SentimentHorizon;
  /** Horizont in Minuten (240 | 1440 | 4320). */
  horizonMinutes: number;
  /** Typ des relevanten Ereignisses. */
  eventType: SentimentEventType;
  /** Anzahl eindeutiger, deduplizierter Quellen. */
  sourceCount: number;
  /** Gesamtzahl der Rohquellen vor Deduplikation. */
  rawSourceCount: number;
  /** Quellenabdeckung / Datenqualität ∈ [0, 1]. */
  coverage: number;
  /** Maßgeblicher Veröffentlichungszeitpunkt der Quellen (null bei ABSTAIN ohne Quellen). */
  sourceEventTime: Date | null;
  /** Frühester Veröffentlichungszeitpunkt der Quellen. */
  sourceEarliestAt: Date | null;
  /** Spätester Veröffentlichungszeitpunkt der Quellen. */
  sourceLatestAt: Date | null;
  /** Entstehungs- / Erfassungszeitpunkt (`as_of` / `generated_at`). */
  asOf: Date;
  /** Ende des Gültigkeits- bzw. Auswertungsfensters (`valid_until` = asOf + horizon). */
  validUntil: Date;
  /** Prompt-Version des erzeugenden Agenten. */
  promptVersion: number;
  /** Modell-Tag des ausführenden LLMs. */
  model: string;
  /** Schema-Version (z. B. `sentiment@1`). */
  schemaVersion: string;
  /** Fingerprint der deduplizierten Quellen (`sd1:<sha256>`). */
  sourceDeduplicationHash: string;
  /** Fachlicher Content-Hash (`sc1:<sha256>`). */
  contentHash: string;
  /** Optionaler kompatibler Link zum P3.1 Forecast-Ledger (z. B. `fk1:<sha256>`). */
  ledgerForecastId: string | null;
  /** These / Zusammenfassung (maximal 500 Zeichen). */
  summary: string;
  /** Risikoflags (maximal 5 Einträge à maximal 32 Zeichen). */
  riskFlags: string[];
  /** Numerischer Impact-Score ∈ [0, 100]. */
  impactScore: number;
  /** Metadaten / Provenienz. */
  metadata?: Record<string, unknown>;

  // ── Rückwärtskompatible Felder (bestehende Konsumenten) ──
  /** Alias für `entityId`. */
  instrumentId: string;
  /** Altes Sentiment-Feld: `BULLISH` | `BEARISH` | `NEUTRAL`. */
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Altes Analysten-View-Feld. */
  view: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Altes Analysten-These-Feld. */
  thesis: string;
}

/** Fehlerklasse des Sentiment-Moduls mit maschinenlesbarem Fehlercode. */
export class SentimentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

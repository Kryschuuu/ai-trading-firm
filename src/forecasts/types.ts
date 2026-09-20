/**
 * Forecast-Ledger — Verträge und Grenzen (RMA-P3-01, v1.55.0).
 *
 * Dieser Baustein macht Agenten-Confidence **unabhängig von Trades**
 * auswertbar: Jede Analyse mit Ziel-Event, Horizont und Wahrscheinlichkeit
 * wird als unveränderlicher Forecast geschrieben, später aus ausschließlich
 * point-in-time erlaubten Marktdaten aufgelöst und mit Proper Scoring Rules
 * (Brier Score, Brier Skill Score, Log Loss, Reliability Bins) bewertet.
 *
 * ── Zeitsemantik (Kern des Fixes) ───────────────────────────────────────────
 *   as_of                  Entstehungszeit des Forecasts (Analysezeitpunkt).
 *   reference_time         Schlusszeit der letzten VOR `as_of` geschlossenen
 *                          Kerze des Auflösungs-Timeframes — der Referenzkurs
 *                          des Ziel-Events.
 *   resolves_at            Schlusszeit der Kerze, die über das Ziel-Event
 *                          entscheidet (`reference_time + horizon`).
 *   availability_deadline  `resolves_at + settle_grace`. Ausschließlich Kerzen
 *                          mit `fetchedAt <= deadline` dürfen in die
 *                          automatische Auflösung eingehen. Später eintreffende
 *                          oder korrigierte Daten sind für die Erstauflösung
 *                          unsichtbar (kein Look-ahead, keine stille Mutation);
 *                          Korrektionen laufen über versionierte
 *                          Re-Resolutionen (siehe `resolution_kind`).
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 *   * `null/unavailable` ist nie `0`: fehlt die Referenz- oder Outcome-Kerze
 *     bis zur Deadline, wird der Forecast VOID (Grund dokumentiert) — er wird
 *     niemals automatisch als „falsch“ oder „richtig“ gebucht.
 *   * Forecasts im Status PENDING (unreif) gehen weder als 0 noch als korrekt
 *     in Scores ein; sie zählen ausschließlich in die Coverage.
 *
 * ── Idempotenz ──────────────────────────────────────────────────────────────
 *   * Forecast: natürlicher Schlüssel `fk1:<sha256>` über Vertrags- und
 *     Inhaltsfelder — Retries schreiben keinen zweiten Forecast.
 *   * Resolution: `fo1:<sha256>` über das Outcome — dieselbe Auflösung wird
 *     nicht doppelt protokolliert; ein abweichendes Ergebnis (Datenkorrektur,
 *     Operator-Eingriff) erzeugt eine NEUE Resolution-Version, überschreibt
 *     aber nie die Historie.
 *
 * ── Keine High-Cardinality-Labels ───────────────────────────────────────────
 *   Entity-, Forecast- und Resolution-IDs erscheinen in Audit-Events und
 *   API-Antworten, aber niemals als Metrik-Labels (Kardinalitätsregel wie in
 *   `src/lib/telemetry.ts`).
 */

/** Vertragsversion des Forecasts (Schema/Semantik). Änderung ⇒ neue Version, nie Mutation. */
export const FORECAST_CONTRACT_VERSION = 1;

/**
 * Auflösungspolitik (Zeitsemantik, Wahrscheinlichkeitsabbildung, VOID-Regeln).
 * Jede Änderung an diesen Regeln erfordert eine neue Policyversion, damit
 * Scoreberichte stets benennen, unter welcher Regelversion aufgelöst wurde.
 */
export const FORECAST_RESOLUTION_POLICY_VERSION = "fp1";

/** Metrikversion der Scoreberechnung (Formeln, Bins, Unsicherheit). */
export const FORECAST_METRICS_VERSION = "fm1";

/** Auflösungs-Timeframe aller Ziel-Events (Kerzen-Schlusszeiten). */
export const FORECAST_TIMEFRAME = "1h" as const;
export const FORECAST_TIMEFRAME_MS = 3_600_000;

/**
 * Settling-Frist nach `resolves_at`: Kerzen dürfen bis hierhin eintreffen
 * (`fetchedAt <= resolves_at + Frist`), bevor aufgelöst wird. Danach fehlt
 * eine Kerze endgültig ⇒ VOID(MISSING_DATA).
 */
export const FORECAST_SETTLE_GRACE_MS = 2 * 3_600_000;

/** Auflösende Kategorien des Ziel-Events `CLOSE_DIRECTION`. */
export const FORECAST_CATEGORIES = ["DOWN", "UP"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

/** Die für Binär-Scores als „Ereignis eingetreten“ gezählte Kategorie. */
export const FORECAST_TARGET_CATEGORY: ForecastCategory = "UP";

/**
 * Ziel-Event `CLOSE_DIRECTION`:
 * „Schlusskurs des Instruments zur Auflösungsschlusszeit liegt **strikt über**
 * dem Referenzschlusskurs.“ Ein exakter Gleichstand zählt als DOWN (0); das
 * ist dokumentierte Policy (`fp1`), kein Zufall.
 */
export const FORECAST_TARGET_KIND = "CLOSE_DIRECTION" as const;
export type ForecastTargetKind = typeof FORECAST_TARGET_KIND;

/** Unterstützte Horizont-ID → Minuten. Abgeschlossen, keine Freitext-Horizonte. */
export const FORECAST_HORIZONS = {
  "4h": 240,
  "24h": 1440,
  "72h": 4320,
} as const;
export type ForecastHorizonId = keyof typeof FORECAST_HORIZONS;

export function isForecastHorizonId(value: unknown): value is ForecastHorizonId {
  return typeof value === "string" && Object.hasOwn(FORECAST_HORIZONS, value);
}

/** Wirksamer Status eines Forecasts (abgeleitet aus der jüngsten Resolution). */
export const FORECAST_STATUSES = ["PENDING", "RESOLVED", "VOID"] as const;
export type ForecastStatus = (typeof FORECAST_STATUSES)[number];

/** Geschlossene VOID-Gründe — niemals Freitext, niemals still. */
export const FORECAST_VOID_REASONS = [
  /** Referenz- oder Outcome-Kerze bis zur Deadline nicht verfügbar. */
  "MISSING_DATA",
  /** Verfügbare Kerze(n) strukturell unbrauchbar (nicht-positiver Kurs o. ä.). */
  "INVALID_DATA",
  /** Auflösungsfenster ohne jegliches Volumen (Handelsaussetzung). */
  "TRADING_HALT",
  /** Datenlieferung so verspätet, dass die Deadline-Regel sie ausschließt. */
  "STALE_DATA",
  /** Split/Delisting o. ä. — nur über den Operator-Pfad deklarierbar. */
  "CORPORATE_ACTION",
  /** Datenkorrektur macht das ursprüngliche Event unbrauchbar (Operator-Pfad). */
  "DATA_CORRECTION",
] as const;
export type ForecastVoidReason = (typeof FORECAST_VOID_REASONS)[number];

export function isForecastVoidReason(value: unknown): value is ForecastVoidReason {
  return typeof value === "string" && (FORECAST_VOID_REASONS as readonly string[]).includes(value);
}

/** Entstehungsart einer Resolution. */
export const FORECAST_RESOLUTION_KINDS = ["AUTOMATIC", "OPERATOR"] as const;
export type ForecastResolutionKind = (typeof FORECAST_RESOLUTION_KINDS)[number];

/** Rollen, deren Analysen per Policy (`fp1`) als Forecasts erfasst werden. */
export const FORECAST_CAPTURE_ROLES = [
  "TECHNICAL_ANALYST",
  "SWING_RESEARCHER",
  "SCOUT",
  "DILIGENCE",
] as const;
export type ForecastCaptureRole = (typeof FORECAST_CAPTURE_ROLES)[number];

/** Policy `fp1`: Rolle → Auflösungshorizont. */
export const FORECAST_ROLE_HORIZONS: Readonly<Record<ForecastCaptureRole, ForecastHorizonId>> = {
  TECHNICAL_ANALYST: "4h",
  SWING_RESEARCHER: "72h",
  SCOUT: "72h",
  DILIGENCE: "72h",
};

/**
 * Harte Grenzen (bounded by design). Alle Lesepfade und Jobs sind
 * mengenseitig begrenzt; Limits werden nie still überschritten.
 */
export const FORECAST_LIMITS = {
  /** Maximale Kategorien je Forecastvertrag. */
  maxCategories: 8,
  /** Toleranz für die Summe kategorialer Wahrscheinlichkeiten. */
  probabilitySumTolerance: 1e-6,
  /** Untere/obere Schranke der Wahrscheinlichkeitsabbildung (Policy `fp1`). */
  probabilityClipMin: 0.01,
  probabilityClipMax: 0.99,
  /** Scoring-Klemmung gegen log(0) (Defensive, zusätzlich zur Capture-Clip). */
  logLossEpsilon: 1e-6,
  /** Standardbreite der Reliability-Bins. */
  reliabilityBins: 10,
  /** Mindeststichprobe je Segment (Default; per Env überschreibbar). */
  minSampleDefault: 30,
  /** Maximalwerte der Query-Parameter (API). */
  maxScoreSegments: 500,
  maxScoreForecasts: 20_000,
  maxListLimit: 200,
  defaultListLimit: 50,
  /** Resolver: maximale Forecasts je Lauf. */
  resolverBatchLimit: 250,
  /** Operator-Eingaben. */
  maxOperatorNoteLength: 500,
} as const;

/** Fehler des Forecast-Moduls mit maschinenlesbarem Code. */
export class ForecastError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Ein unveränderlicher Forecast (Vertrags- und Inhaltsfelder). */
export interface ForecastContract {
  /** Rolle des erzeugenden Agenten (z. B. `TECHNICAL_ANALYST`). */
  agentRole: string;
  /** Prompt-Version (`agents.version`) zum Capture-Zeitpunkt. */
  promptVersion: number;
  /** Modelltag zum Capture-Zeitpunkt. */
  model: string;
  /** Entity-Typ — aktuell ausschließlich `instrument`. */
  entityType: "instrument";
  /** Kanonische Instrument-ID (z. B. `PAPER:BTC`). */
  entityId: string;
  /** Symbol, wie der Analyst es verwendet hat (Anzeige/Provenienz). */
  symbol: string;
  /** Ziel-Event-Typ (abgeschlossene Liste). */
  targetKind: ForecastTargetKind;
  /** Auflösungskategorien, z. B. `["DOWN","UP"]`. */
  categories: readonly ForecastCategory[];
  /** Wahrscheinlichkeitsvektor, Summe = 1 (validiert). */
  probabilities: readonly number[];
  /** Kategorie, deren Eintreten als binäres „1“ gezählt wird. */
  targetCategory: ForecastCategory;
  /** Horizont-ID (abgeschlossene Liste). */
  horizonId: ForecastHorizonId;
  /** Auflösungstimeframe (Kerzen-Schlusszeiten). */
  timeframe: typeof FORECAST_TIMEFRAME;
  /** Entstehungszeit (Analysezeitpunkt). */
  asOf: Date;
  /** Schlusszeit der Referenzkerze (letzte geschlossene Kerze vor `asOf`). */
  referenceTime: Date;
  /** Referenzschlusskurs zum Capture-Zeitpunkt (Provenienz, nicht autoritativ —
   * die Auflösung berechnet ihn erneut aus dem Kerzen-Store). */
  referenceClose: number;
  /** Schlusszeit der Outcome-Kerze. */
  resolvesAt: Date;
  /** `resolvesAt + Settling-Frist` — Verfügbarkeits-Deadline der Auflösung. */
  availabilityDeadline: Date;
  /** Adaptives Regime zum Capture-Zeitpunkt (`UNKNOWN` zulässig). */
  regime: string;
  /** Policyversion der Capture-/Auflösungsregeln. */
  policyVersion: string;
  /** Vertragsversion. */
  contractVersion: number;
}

/** Auflösungs-Outcome einer Kategoriezuordnung. */
export interface ForecastOutcome {
  /** Index der eingetretenen Kategorie in `categories`. */
  outcomeIndex: number;
  /** Label der eingetretenen Kategorie (z. B. `UP`). */
  outcomeLabel: ForecastCategory;
  /** Binäre Sicht: 1 = `targetCategory` eingetreten. */
  outcomeBinary: 0 | 1;
  /** Autoritativer Referenzschlusskurs (aus dem Kerzen-Store). */
  referenceClose: number;
  /** Autoritativer Outcome-Schlusskurs (aus dem Kerzen-Store). */
  outcomeClose: number;
}

/** Eine Resolution (RESOLVED oder VOID) — append-only, versioniert. */
export interface ForecastResolution {
  forecastId: string;
  /** 1-basiert, strikt monoton je Forecast. */
  resolutionVersion: number;
  status: "RESOLVED" | "VOID";
  /** Nur bei RESOLVED. */
  outcome: ForecastOutcome | null;
  /** Nur bei VOID. */
  voidReason: ForecastVoidReason | null;
  resolutionKind: ForecastResolutionKind;
  /** Zeitstempel der Auflösung (Berechnungszeit). */
  resolvedAt: Date;
  /** Policyversion der Auflösung. */
  policyVersion: string;
  /** Datenmanifest: welche Kerzen (ts/close/volume/fetchedAt), Dataset-Hash,
   * Qualitätszähler, Auflösungsweg. */
  outcomeManifest: Readonly<Record<string, unknown>>;
  /** `fo1:<sha256>` — Inhaltsfingerprint (Idempotenz-/Revisionskennung). */
  outcomeHash: string;
}

/** Sicht auf einen Forecast inkl. abgeleitetem Status (Lesepfad). */
export interface ForecastView extends ForecastContract {
  forecastId: string;
  idempotencyKey: string;
  status: ForecastStatus;
  /** Jüngste Resolution, falls vorhanden. */
  resolution: ForecastResolution | null;
  createdAt: Date;
}

/** Eine für das Scoring vorbereitete Zeile (Forecast + finale Auflösung). */
export interface ScoreRow {
  forecastId: string;
  agentRole: string;
  promptVersion: number;
  model: string;
  entityId: string;
  horizonId: ForecastHorizonId;
  regime: string;
  asOf: Date;
  resolvesAt: Date;
  status: ForecastStatus;
  /** Wahrscheinlichkeit der Target-Kategorie (binäre Sicht). */
  probability: number;
  /** Vollständiger Vektor (kategoriale Bewertung). */
  probabilities: readonly number[];
  categories: readonly ForecastCategory[];
  targetCategory: ForecastCategory;
  /** Nur bei RESOLVED definiert. */
  outcomeIndex: number | null;
  outcomeBinary: 0 | 1 | null;
  voidReason: ForecastVoidReason | null;
  resolutionVersion: number | null;
}

/**
 * Kanonische Serialisierung eines Forecast-Vertrags für den Idempotenzschlüssel.
 * Ausschließlich definierte Felder, feste Reihenfolge — deterministisch.
 */
export function forecastKeyPayload(contract: ForecastContract): Record<string, unknown> {
  return {
    contractVersion: contract.contractVersion,
    policyVersion: contract.policyVersion,
    agentRole: contract.agentRole,
    promptVersion: contract.promptVersion,
    model: contract.model,
    entityType: contract.entityType,
    entityId: contract.entityId,
    targetKind: contract.targetKind,
    categories: [...contract.categories],
    probabilities: contract.probabilities.map((p) => Number(p.toFixed(9))),
    targetCategory: contract.targetCategory,
    horizonId: contract.horizonId,
    timeframe: contract.timeframe,
    asOfMs: contract.asOf.getTime(),
  };
}

/** Zählwerk eines Resolver-Laufs (bounded, keine IDs). */
export interface ResolutionCounts {
  /** Als fällig geladene Forecasts. */
  dueConsidered: number;
  /** Erfolgreich aufgelöst (RESOLVED). */
  resolved: number;
  /** VOID geschrieben. */
  voided: number;
  /** Bereits aufgelöst vorgefunden (Idempotenz-Treffer). */
  duplicates: number;
  /** Fehler je Forecast (fail-closed übersprungen, laut gezählt). */
  failed: number;
}

export function emptyResolutionCounts(): ResolutionCounts {
  return { dueConsidered: 0, resolved: 0, voided: 0, duplicates: 0, failed: 0 };
}

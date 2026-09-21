/**
 * Trade-PnL-Attribution — Typen und Vertrag (RMA-P1-06, v1.57.0).
 *
 * Jeder GESCHLOSSENE Trade erhält eine versionierte, reproduzierbare
 * Netto-PnL-Attribution, deren Quellenbeiträge plus Kosten plus explizites
 * Residual EXAKT das realisierte Netto-PnL ergeben.
 *
 * ── Methodische Erklärung (Ehrlichkeitsvertrag) ────────────────────────────
 * Die Methode ist eine **DETERMINISTIC_ALLOCATION** (normierte Aufteilung des
 * realisierten Ergebnisses auf die im Entry-Snapshot dokumentierten
 * Entscheidungsquellen). Sie behauptet KEINE Kausalanalyse: Ein positiver
 * Beitrag eines Agenten belegt nicht, dass der Agent die Ursache des Gewinns
 * war — nur, dass er richtungsabhängig an dieser Entscheidung mitgewirkt hat
 * und der Trade so ausging. Kausale Verfahren (z. B. Shapley) sind bewusst
 * NICHT Teil dieser Methode (Roadmap-Entscheidung ausständig).
 */

// ── Methoden-Metadaten ──────────────────────────────────────────────────────

/** Aktuell implementierte Methode (Allowlist siehe config.ts). */
export const ATTRIBUTION_METHOD_VERSION = 1;

/** Methodenkennung der Version 1 (ta = trade attribution). */
export const ATTRIBUTION_METHOD_TAG = "ta1";

/**
 * Explizite Erklärung der Methode — jede API-Antwort und jedes persistente
 * Ergebnis trägt dieses Label, damit die Auswertung nie als Kausalanalyse
 * missverstanden werden kann.
 */
export const ATTRIBUTION_DECLARATION = "DETERMINISTIC_ALLOCATION" as const;

/**
 * Numerische Reconciliation-Toleranz: |Quellen + Kosten + Residual − Netto|
 * muss ≤ dieser Schranke sein (Rundungsreste durch 8 Nachkommastellen sind
 * erwartbar, aber < 1e-6). Größere Abweichungen sind ein Fehler — die
 * Berechnung wird VERWORFEN, nie still korrigiert.
 */
export const ATTRIBUTION_RECONCILIATION_TOLERANCE = 1e-6;

/** Nachkommastellen der gerundeten Beiträge (Residual schluckt Rundung). */
export const ATTRIBUTION_DECIMALS = 8;

/**
 * Default-Konfidenz für Stimmen ohne endliche Confidence: 0.5 — der
 * Beta(2,2)-Prior-Mittelwert des Journals (src/lib/journalAnalytics.ts).
 * Konsistent mit der bestehenden Auswertung; keine neue Magick-Zahl.
 */
export const ATTRIBUTION_DEFAULT_CONFIDENCE = 0.5;

// ── Quellen ─────────────────────────────────────────────────────────────────

/** Zulässige Quelltypen der Methode ta1. */
export type AttributionSourceType = "AGENT" | "RULE" | "COST";

/**
 * Quellen-IDs je Typ (bounded, KEINE Instrument-/Order-/Trade-IDs):
 *   AGENT → Agentenname (Stimme in der Entscheidungskette bzw. Proposer)
 *   RULE  → rule_key (stabile logische Regel-Identität über Versionen)
 *   COST  → "FEES" | "FUNDING"
 */
export type AttributionCostKind = "FEES" | "FUNDING";

/** Richtungsrelation einer Quelle zur Trade-Richtung. */
export type AttributionAlignment = -1 | 0 | 1;

/** Status einer Attribution. */
export type AttributionStatus = "ATTRIBUTED" | "UNATTRIBUTABLE";

/**
 * Geschlossene Gründe für UNATTRIBUTABLE (fail-closed, sichtbar — historische
 * Zeilen werden NIE mit geschätzten Quellen gefüllt):
 *
 *   SNAPSHOT_MISSING    keine Snapshot-Struktur an der Journal-Zeile
 *   SNAPSHOT_SCHEMA_V1  v1-Snapshot: Stimmen ohne Richtungsdaten, keine
 *                       Versionskette — die Methode ta1 lehnt ab statt zu raten
 *   SNAPSHOT_INVALID    Snapshot unlesbar/strukturell beschädigt
 *   NO_SOURCES          v2-Snapshot ohne auswertbare Quelle (kein Proposer,
 *                       keine Regel, keine richtungsbelegte Stimme)
 */
export type UnattributableReason =
  | "SNAPSHOT_MISSING"
  | "SNAPSHOT_SCHEMA_V1"
  | "SNAPSHOT_INVALID"
  | "NO_SOURCES";

/** Nicht quantifizierbare Kostenkomponenten (null = unbekannt, NICHT 0). */
export type UnknownCostComponent = AttributionCostKind;

// ── Ergebnis ────────────────────────────────────────────────────────────────

/** Einzelner Beitragsposten einer Attribution. */
export interface AttributionEntry {
  sourceType: AttributionSourceType;
  /** Bounded Quellen-ID (Agentenname | rule_key | FEES | FUNDING). */
  sourceId: string;
  /** Version der Quelle: Promptversion des Agenten | Regelversion | ta1. */
  sourceVersion: string;
  /** Agentenrolle (nur AGENT; sonst null) — lesbare Gruppierung. */
  role: string | null;
  alignment: AttributionAlignment;
  /** Normalisierter Anteil an der Teilnehmermasse [0,1]; null für COST. */
  weight: number | null;
  /** Signierter Beitrag in Kontowährung (8 Nachkommastellen). */
  contribution: number;
}

/** Vollständiges Attributionsergebnis (rein, deterministisch). */
export interface TradeAttribution {
  methodVersion: number;
  methodTag: string;
  declaration: typeof ATTRIBUTION_DECLARATION;
  status: AttributionStatus;
  unattributableReason: UnattributableReason | null;
  /** Fingerprint des Entry-Snapshots (Verweis auf die Entscheidungsgrundlage). */
  snapshotHash: string;
  snapshotSchemaVersion: number;
  symbol: string;
  side: "LONG" | "SHORT";
  /**
   * Realisiertes PnL der Buchungsquelle (Journal-Zeile `pnl` bzw. Backtest
   * `pnl_gross`): Kurs-PnL vor Gebühren; bereits vorzeichenrichtig (LONG und
   * SHORT gleichermaßen).
   */
  grossPnl: number;
  /** Gebühren in Kontowährung; null = unbekannt (kein stiller 0-Ersatz). */
  fees: number | null;
  /** Funding in Kontosicht (negativ = gezahlt); null = unbekannt. */
  funding: number | null;
  /**
   * Slippage-Memo: bereits in den Fill-Preisen enthalten (Paper-Simulator und
   * Backtest), daher bewusst KEIN reconciliation-relevanter Kostenposten —
   * ein separater Posten würde die Slippage doppelt zählen.
   */
  slippageMemo: number | null;
  /** Reconciliationsziel: grossPnl − (fees ?? 0) + (funding ?? 0). */
  netPnl: number;
  sourcesSum: number;
  costsSum: number;
  /** Explizites Residual: Netto − Quellen − Kosten (exakt, inkl. Konflikten). */
  residual: number;
  unknownCosts: readonly UnknownCostComponent[];
  /** Anzahl richtungsbelegter Quellen (aligned + opposing). */
  participants: number;
  /** Anzahl richtungsloser Stimmen (Enthaltungen, sichtbar mit Beitrag 0). */
  abstentions: number;
  entries: readonly AttributionEntry[];
}

/** Eingabe der reinen Berechnung (kein IO, keine Uhr). */
export interface TradeAttributionInput {
  methodVersion: number;
  symbol: string;
  side: "LONG" | "SHORT";
  /** Realisiertes PnL der Buchungsquelle (siehe TradeAttribution.grossPnl). */
  grossPnl: number;
  fees: number | null;
  funding: number | null;
  slippage?: number | null;
  /** Entry-Decision-Snapshot (v1 oder v2) oder null, wenn keiner existiert. */
  snapshot: unknown;
}

/** Fehler der reinen Berechnung (maschinenlesbarer Code). */
export class AttributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

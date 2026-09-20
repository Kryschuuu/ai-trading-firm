/**
 * Ports des Forecast-Moduls (RMA-P3-01, v1.55.0).
 *
 * Der Resolver und die Metrik sind gegen diese Schnittstellen programmiert;
 * die Postgres-Ablage (`ledger.ts`) und der Kerzen-Store-Zugang
 * (`outcomeSource.ts`) sind Implementierungen davon. Tests setzen
 * In-Memory-Implementierungen ein — dieselben Garantien (Idempotenz,
 * Versionierung) werden dort wie gegen die echte Datenbank geprüft.
 */

import type {
  ForecastContract,
  ForecastResolution,
  ForecastStatus,
  ForecastVoidReason,
  ResolutionCounts,
} from "./types";

/** Eine Kerze mit Schlusszeit und Verfügbarkeitszeit (Outcome-Daten). */
export interface OutcomeBar {
  /** Schlusszeit der Kerze (Epochen-ms, auf dem Timeframe-Raster). */
  closeTimeMs: number;
  /** Startzeit der Kerze (Epochen-ms). */
  openTimeMs: number;
  close: number;
  volume: number;
  /** Verfügbarkeit: wann die Kerze im Store geschrieben/ersetzt wurde. */
  fetchedAtMs: number;
}

/** Schreibzugriff auf die Outcome-Daten (Kerzen-Store). */
export interface OutcomeDataWritePort {
  /**
   * Schreibt Kerzen idempotent in den Store (identische Kerze ⇒ kein
   * zweiter Eintrag; abweichender Inhalt zum selben Schlüssel ⇒ jüngster
   * Abruf gewinnt, die Ersetzungszeit wird als `fetchedAt` sichtbar).
   */
  appendBars(
    entityId: string,
    timeframe: string,
    bars: readonly { time: number; open: number; high: number; low: number; close: number; volume: number }[],
    now: Date
  ): Promise<{ written: number; deduplicated: number; invalid: number }>;
}

/** Lesezugriff auf die Outcome-Daten (Kerzen-Store). */
export interface OutcomeDataReadPort {
  /**
   * Liefert Kerzen eines Instruments und Timeframes mit
   * `closeTimeMs` in `[fromMs, toMs]` (inklusive), aufsteigend.
   * Enthält auch nach der Deadline geschriebene Kerzen — die
   * Verfügbarkeitsprüfung (`fetchedAtMs <= deadline`) obliegt dem
   * Resolver, damit Korrekturen in der Re-Resolution sichtbar bleiben.
   */
  loadBars(entityId: string, timeframe: string, fromMs: number, toMs: number): Promise<OutcomeBar[]>;
}

/**
 * Ergebnis der Bewertung EINES fälligen Forecasts. Die Fälligkeit prüft der
 * Aufrufer (der Resolver lädt ausschließlich Forecasts mit erreichter
 * Deadline) — die Bewertung selbst ist total: RESOLVED oder VOID mit
 * geschlossenem Grund, niemals ein dritter Zustand.
 */
export type ResolutionEvaluation =
  | {
      kind: "RESOLVED";
      outcomeIndex: number;
      outcomeLabel: string;
      outcomeBinary: 0 | 1;
      referenceClose: number;
      outcomeClose: number;
      manifest: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "VOID";
      voidReason: ForecastVoidReason;
      manifest: Readonly<Record<string, unknown>>;
    };

/** Sicht auf einen Forecast für den Resolver. */
export interface DueForecast {
  forecastId: string;
  contract: ForecastContract;
  /** Jüngste Resolution, falls bereits vorhanden (Idempotenz-Prüfung). */
  latestResolution: ForecastResolution | null;
  /** Wirksstatus zum Ladezeitpunkt. */
  status: ForecastStatus;
}

/** Filter des bounded Score-/List-Lesepfads (alle Felder optional). */
export interface ForecastQueryFilter {
  agentRole?: string;
  entityId?: string;
  horizonId?: string;
  regime?: string;
  promptVersion?: number;
  fromAsOf?: Date;
  toAsOf?: Date;
}

/**
 * Persistenz-Port des Ledgers. Implementierungen müssen garantieren:
 *   * `recordForecast` ist idempotent über den Idempotenzschlüssel,
 *   * `appendResolution` ist idempotent über den Outcome-Hash und
 *     versioniert abweichende Ergebnisse (niemals Überschreiben),
 *   * `dueForecasts` liefert ausschließlich Forecasts OHNE Resolution.
 */
export interface ForecastLedgerPort {
  recordForecast(
    contract: ForecastContract,
    sourceManifest: Readonly<Record<string, unknown>>
  ): Promise<{ created: boolean; forecastId: string }>;

  appendResolution(draft: {
    forecastId: string;
    status: "RESOLVED" | "VOID";
    outcomeIndex: number | null;
    outcomeLabel: string | null;
    outcomeBinary: 0 | 1 | null;
    referenceClose: number | null;
    outcomeClose: number | null;
    voidReason: ForecastVoidReason | null;
    resolutionKind: "AUTOMATIC" | "OPERATOR";
    resolvedAt: Date;
    policyVersion: string;
    outcomeManifest: Readonly<Record<string, unknown>>;
  }): Promise<{ created: boolean; resolutionVersion: number; outcomeHash: string }>;

  /** Forecasts ohne Resolution mit `availabilityDeadline <= now`, aufsteigend. */
  dueForecasts(now: Date, limit: number): Promise<DueForecast[]>;

  /**
   * Forecasts ohne Resolution im Reifungsfenster
   * `resolvesAt <= now < availabilityDeadline` (Feed-Phase), aufsteigend
   * nach Auflösungszeit.
   */
  maturingForecasts(now: Date, limit: number): Promise<DueForecast[]>;

  /** Einen Forecast (mit jüngster Resolution) laden — `null` wenn unbekannt. */
  loadForecast(forecastId: string): Promise<DueForecast | null>;

  /**
   * Bounded-Lesepfad: Forecasts gemäß Filter, jüngste zuerst, mit jüngster
   * Resolution. `truncated` meldet laut, dass die Quelle das Limit erreichte.
   */
  queryForecasts(filter: ForecastQueryFilter, limit: number): Promise<{ rows: DueForecast[]; truncated: boolean }>;

  /** Wasserstand monoton vorwärts bewegen. */
  advanceCursor(deadline: Date, runId: string | null): Promise<Date>;

  readCursor(): Promise<{ watermarkDeadline: Date; lastRunId: string | null } | null>;

  recordRun(manifest: {
    idempotencyKey: string;
    mode: "AUTOMATIC" | "OPERATOR";
    status: "SUCCEEDED" | "FAILED";
    counts: ResolutionCounts;
    cursorBefore: { watermarkDeadline: Date | null };
    cursorAfter: { watermarkDeadline: Date | null };
    codeVersion: string;
    errorCode: string | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<{ created: boolean; runId: string }>;
}

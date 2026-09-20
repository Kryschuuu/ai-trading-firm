/**
 * Speicher-Ports des Feature Stores (RMA-P6-01, v1.53.0).
 *
 * Der Planer und die PIT-Abfrage kennen nur diese Schnittstellen — nicht
 * Drizzle, nicht Postgres. Das erlaubt (a) reine Tests ohne Datenbank, (b)
 * eine spätere zweite Ablage (z. B. Parquet/Objektspeicher) ohne Semantik-
 * änderung und (c) eine ehrliche Trennung zwischen „was berechnet wird“ und
 * „wie es gespeichert wird“.
 *
 * Alle Ports sind fail-closed spezifiziert: eine Implementierung darf fehlende
 * Zeilen niemals durch Ersatzwerte (`0`, `false`, `""`) ersetzen. Ist die
 * Ablage nicht erreichbar, muss die Methode **werfen** — nicht leer antworten.
 */
import type { SupportedTimeframe } from "../lib/marketdata/historicalStore";
import type {
  FeatureCursor,
  FeatureDataRevision,
  FeatureDefinition,
  FeatureMaterializationMode,
  FeatureMaterializationRun,
  FeatureMaterializationRunView,
  FeatureRef,
  FeatureValueDraft,
  FeatureValueRow,
} from "./types";

/** Existierende Wertezeile (Schlüssel + Fingerprints) für die Klassifikation. */
export interface FeatureValueKey {
  featureId: string;
  featureVersion: number;
  entityId: string;
  timeframe: SupportedTimeframe;
  eventTime: Date;
  valueHash: string;
  definitionHash: string;
}

/** Scope eines Materialisierungs- oder Lesevorgangs. */
export interface FeatureSeriesScope {
  entityIds: readonly string[];
  refs: readonly FeatureRef[];
  timeframe: SupportedTimeframe;
}

/**
 * Ein Materialisierungslauf (Manifest) — Erfolg wie Fehlschlag. Identisch zum
 * Vertrag aus `./types.ts` (`FeatureMaterializationRun`), damit es **eine**
 * Definition des Manifests gibt (kein Paralleltyp, der auseinanderdriften kann).
 */
export type MaterializationRunRecord = FeatureMaterializationRun;

/** Atomarer Schreibauftrag: Manifest + Werte + Revisionen + Cursor in EINER Transaktion. */
export interface MaterializationCommit {
  run: MaterializationRunRecord;
  /** Neue Wertzeilen (Drafts; `runId` setzt die Ablage selbst). */
  values: readonly FeatureValueDraft[];
  /** Protokollierte Revisionen (`runId` setzt die Ablage). */
  revisions: readonly FeatureDataRevision[];
}

/** Ergebnis eines atomaren Schreibauftrags. */
export interface MaterializationCommitResult {
  runId: string;
  /** `false` = Replay (identischer Idempotency-Key war schon vorhanden). */
  created: boolean;
  valuesInserted: number;
  duplicates: number;
  revisionsRecorded: number;
}

/** Abdeckung/Status einer Featurereihe (Operations-Sicht). */
export interface FeatureCoverage {
  featureId: string;
  featureVersion: number;
  timeframe: string;
  entityType: string;
  rows: number;
  entities: number;
  nullRows: number;
  unknownQualityRows: number;
  /** Älteste/jüngste Eventzeit der Reihe (ISO-8601-UTC). */
  minEventTime: string | null;
  maxEventTime: string | null;
  /** Jüngster Verfügbarkeitszeitpunkt (`available_at`) der Reihe. */
  maxAvailableAt: string | null;
  /** Jüngster Berechnungszeitpunkt (`computed_at`) der Reihe. */
  maxComputedAt: string | null;
  /** Entitys mit Cursor (materialisiert) und deren jüngster Wasserstand. */
  cursoredEntities: number;
  maxWatermark: string | null;
  /** Protokollierte Datenrevisionen dieser Reihe. */
  revisions: number;
}

/**
 * Ablage des Feature Stores. Implementiert in `./store.ts` (Postgres/Drizzle).
 *
 * Alle Methoden sind `async`, weil die Produktivablage eine Datenbank ist; die
 * reine Semantik (Planen, Joinen, Vergleichen) liegt in den anderen Modulen.
 */
export interface FeatureStorePort {
  /** Registriert Definitionen (idempotent, immutability-geprüft). */
  registerDefinitions(definitions: readonly FeatureDefinition[]): Promise<{ registered: number; existing: number }>;

  /** Wasserstände der angefragten Reihen. */
  readCursors(scope: FeatureSeriesScope): Promise<readonly FeatureCursor[]>;

  /**
   * Vorhandene Wertezeilen (nur Schlüssel + Fingerprints) für die
   * Duplikat-/Revisionsklassifikation. Der Aufrufer begrenzt das Fenster; die
   * Implementierung muss hart begrenzt lesen und bei Überschreitung werfen.
   */
  readKeys(scope: FeatureSeriesScope & { fromTs: Date; toTs: Date; limit: number }): Promise<readonly FeatureValueKey[]>;

  /**
   * Schreibt Manifest + Werte + Revisionen + Cursor atomar.
   *
   *   * Idempotency-Key bereits **erfolgreich** abgeschlossen ⇒ Replay
   *     (`created: false`, kein Write, keine Revision);
   *   * Idempotency-Key gehört zu einem **fehlgeschlagenen** Lauf ⇒ der neue
   *     Versuch ersetzt dessen Manifest (transiente Fehler bleiben
   *     wiederholbar; Revisionen sind über ihren Schlüssel idempotent);
   *   * sonst ⇒ neue Zeilen; Werte nur, wenn der Schlüssel noch nicht existiert.
   */
  commitRun(commit: MaterializationCommit): Promise<MaterializationCommitResult>;

  /**
   * Manifest eines fehlgeschlagenen (oder **verworfenen**) Laufs ohne Werte.
   * Bei einem verworfenen Lauf (Rohdatenrevision) bleibt `errorCode` gesetzt und
   * `cursorAfter` leer, damit der nächste Lauf denselben Cursor-Stand sieht.
   */
  recordFailedRun(run: MaterializationRunRecord): Promise<void>;

  /**
   * Zeilen für eine Point-in-Time-Abfrage, **bereits in SQL vorgefiltert** auf
   * `event_time <= targetTime AND available_at <= as_of` und begrenzt. Genau
   * diese Bedingung ist der Look-ahead-Schutz; die Reihenfolge ist für die
   * Auswahl nicht relevant (der Join wählt deterministisch aus).
   */
  readValues(query: {
    entities: readonly string[];
    refs: readonly FeatureRef[];
    timeframe: SupportedTimeframe;
    targetTime: Date;
    asOf: Date;
    limit: number;
  }): Promise<readonly FeatureValueRow[]>;

  /** Abdeckung je Featurereihe (bounded Aggregate, keine Entity-IDs als Label). */
  coverage(scope?: { refs?: readonly FeatureRef[]; timeframe?: SupportedTimeframe }): Promise<readonly FeatureCoverage[]>;

  /**
   * Jüngste Materialisierungsläufe, als **eine Sicht je (Entity × Feature)**:
   * die Betriebsfrage lautet „ist Reihe X für Entity Y aktuell?“ — genau eine
   * Zeile beantwortet sie. Ein Lauf über mehrere Features/Entities erscheint
   * deshalb mehrfach. `limit` begrenzt die gelesenen **Läufe**, nicht die
   * Sichten (ein Lauf kann also mehr Zeilen liefern als `limit`).
   */
  recentRuns(limit: number): Promise<readonly FeatureMaterializationRunView[]>;

  /** Jüngste protokollierte Datenrevisionen (beschränkt). */
  recentRevisions(limit: number): Promise<readonly FeatureDataRevision[]>;

  /**
   * Entfernt alte, **wertfreie** Manifeste (Retention der Betriebsmetadaten).
   * Wertezeilen und ihr Provenienz-Manifest werden nie gelöscht.
   */
  pruneRuns(keepLast: number): Promise<number>;
}

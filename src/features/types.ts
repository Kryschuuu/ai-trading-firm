/**
 * Verträge des **Point-in-Time Feature Store** (RMA-P6-01, v1.53.0).
 *
 * ── Warum das hier existiert ────────────────────────────────────────────────
 * Der Scanner berechnet Faktoren **im Moment des Aufrufs**. Für Forschung,
 * Backtest und Post-Mortem ist genau das zu wenig: derselbe Wert ist später
 * nicht mehr reproduzierbar, und ein Backtest, der einen Wert benutzt, der erst
 * Tage später eingetroffen ist, ist ein Look-ahead-Bias. Dieses Modul trennt
 * deshalb vier Dinge, die sonst stillschweigend verschmelzen:
 *
 * | Feld            | Bedeutung                                                     |
 * | --------------- | ------------------------------------------------------------- |
 * | `eventTime`     | Zeitpunkt des Ereignisses (Schlusszeit der Kerze).            |
 * | `availableAt`   | Zeitpunkt, ab dem der Wert **wahrheitsgemäß bekannt** war.     |
 * | `computedAt`    | Zeitpunkt der Berechnung (Materialisierungslauf).              |
 * | `dtype`/`null`  | Typ und **explizite** Nichtverfügbarkeit (`null` ≠ `0`).       |
 *
 * `availableAt` ist die Politik: `bar_close` (Kerze gilt mit Schluss als
 * bekannt — Forschungsannahme eines vollständigen, replay-sauberen Datensatzes)
 * oder `ingested` (Kerze gilt erst ab ihrem Ingestion-Zeitstempel als bekannt —
 * fail-closed, wenn Feed-Ausfälle/nachgelieferte Kerzen möglich sind).
 *
 * ── Harte Grenzen ───────────────────────────────────────────────────────────
 * Featurewerte sind **skalare, typisierte Werte** — kein beliebiges JSON-Objekt.
 * Damit bleibt eine PIT-Abfrage entscheidbar und ein Consumer kann nicht
 * versehentlich einen Blob als Zahl interpretieren.
 */
import type { SupportedTimeframe } from "../lib/marketdata/historicalStore";

// ── Werttypen ───────────────────────────────────────────────────────────────

/** Erlaubte Ausgabetypen eines Features (geschlossene Liste). */
export type FeatureDtype = "number" | "boolean" | "enum";
export const FEATURE_DTYPES: readonly FeatureDtype[] = ["number", "boolean", "enum"] as const;

/** Entity-Typ, gegen den ein Feature definiert ist. */
export type FeatureEntityType = "instrument";
export const FEATURE_ENTITY_TYPES: readonly FeatureEntityType[] = ["instrument"] as const;

/** Ein Featurewert — genau einer dieser Skalare (nie ein Objekt/Array). */
export type FeatureValue = number | boolean | string;

/** Warum ein Wert `null` ist (geschlossene Liste; `null` ist kein Messwert). */
export type FeatureNullReason =
  | "INSUFFICIENT_LOOKBACK"
  | "INVALID_INPUT"
  | "MISSING_BARS"
  | "NOT_COMPUTABLE"
  | "DEPENDENCY_NULL"
  | "DEPENDENCY_MISSING";
export const FEATURE_NULL_REASONS: readonly FeatureNullReason[] = [
  "INSUFFICIENT_LOOKBACK",
  "INVALID_INPUT",
  "MISSING_BARS",
  "NOT_COMPUTABLE",
  "DEPENDENCY_NULL",
  "DEPENDENCY_MISSING",
] as const;

/**
 * Qualitätsstatus eines Featurewerts.
 *
 * Die Werte `OK`/`GAP`/`OUTLIER`/`INVALID`/`DUPLICATE`/`CROSSCHECK` stammen
 * **unverändert** aus dem Marktdaten-Quality-Layer (`src/marketdata/quality.ts`)
 * — es gibt keine zweite Skala. `UNKNOWN` bedeutet „für diese Reihe/Bar liegt
 * kein Qualitätsbefund vor“ (z. B. kein Qualitätsreport geschrieben). `UNKNOWN`
 * ist **nicht** gleich „gut“: Konsumenten mit Qualitätsanforderung müssen
 * `UNKNOWN` fail-closed behandeln.
 */
export type FeatureQualityStatus =
  | "OK"
  | "GAP"
  | "OUTLIER"
  | "INVALID"
  | "DUPLICATE"
  | "CROSSCHECK"
  | "UNKNOWN";
export const FEATURE_QUALITY_STATUSES: readonly FeatureQualityStatus[] = [
  "OK",
  "GAP",
  "OUTLIER",
  "INVALID",
  "DUPLICATE",
  "CROSSCHECK",
  "UNKNOWN",
] as const;

/** Verfügbarkeitspolitik (siehe Modulkopf). */
export type FeatureAvailabilityPolicy = "bar_close" | "ingested";
export const FEATURE_AVAILABILITY_POLICIES: readonly FeatureAvailabilityPolicy[] = [
  "bar_close",
  "ingested",
] as const;

// ── Definitionen ────────────────────────────────────────────────────────────

/** Referenz auf eine Featureversion. */
export interface FeatureRef {
  featureId: string;
  version: number;
}

/**
 * Deklaration eines Features (Eingabe der Registry).
 *
 * Jede Änderung an einem dieser Felder ändert den `definitionHash` und ist damit
 * eine **neue Version** — die Registry lehnt eine Umdeutung derselben
 * `(featureId, version)`-Kombination ab. Einheiten (`unit`) sind Teil der
 * Semantik: ein Wechsel von Prozent auf Dezimalanteil ist eine neue Version,
 * nicht eine Doku-Korrektur.
 */
export interface FeatureDefinitionInput {
  /** Stabile, logische ID in Kleinschreibung/Punkten, z. B. `scanner.rsi`. */
  featureId: string;
  /** Semantikversion, beginnend bei 1 (bei jeder Semantikänderung erhöhen). */
  version: number;
  /** Kurzlabel für UI/Logs. */
  label: string;
  /** Fachliche Bedeutung (Pflicht: leere Doku ist ein Validierungsfehler). */
  description: string;
  /** Ausgabetyp. */
  dtype: FeatureDtype;
  /** Für `dtype = "enum"` die vollständige Werteliste (sonst `null`). */
  enumValues: readonly string[] | null;
  /**
   * Einheit des numerischen Werts (`null` bei booleschen/enum-Werten). Pflicht
   * für `number`: ohne Einheit ist ein Wert nicht interpretierbar
   * (z. B. `"fraction_of_close"`, `"index_0_100"`).
   */
  unit: string | null;
  /** Nachkommastellen der Rundung bei `number` (sonst `null`). */
  valueDecimals: number | null;
  /** Entity-Typ (deterministischer Typ, kein `any`). */
  entityType: FeatureEntityType;
  /** Zeitauflösung, in der das Feature definiert ist. */
  timeframe: SupportedTimeframe;
  /** Anzahl geschlossener Kerzen, die für einen Wert nötig sind (≥ 1). */
  lookbackBars: number;
  /** Direkte Abhängigkeiten (müssen mit exakter Version existieren). */
  dependencies: readonly FeatureRef[];
  /** Schlüssel in der Executor-Tabelle (`FEATURE_EXECUTORS`). */
  computeKey: string;
  /** Konfiguration der Berechnung (nur Skalare, kein Blob). */
  config: Readonly<Record<string, number | string | boolean | null>>;
  /** Verantwortliche Rolle (z. B. `"scanner"`). */
  owner: string;
}

/** Registrierte Definition inkl. deterministischer Hashes. */
export interface FeatureDefinition extends FeatureDefinitionInput {
  /** `fc1:<sha256>` — implementierungsrelevanter Fingerprint (Executor + Formelvertrag). */
  codeHash: string;
  /** `fg1:<sha256>` — Konfigurationsfingerprint. */
  configHash: string;
  /** `fd1:<sha256>` — Gesamtfingerprint (semantische Identität). */
  definitionHash: string;
}

// ── Werte & Manifest ────────────────────────────────────────────────────────

/**
 * Herkunftsnachweis eines Featurewerts: aus welchen Kerzen (Anzahl, Zeitspanne,
 * Ingestion) wurde er berechnet und welche Revision hatte die Rohserie?
 * Der `ds1:`-Hash deckt die Kerzen **inklusive** `fetchedAt` ab — eine
 * nachgelieferte/revidierte Rohkerze erzeugt also einen anderen Hash.
 */
export interface FeatureSourceManifest {
  /** Quelle der Rohdaten (`"historical-store"`). */
  source: string;
  /** Anzahl der in die Berechnung eingegangenen Kerzen. */
  candleCount: number;
  /** Früheste Eventzeit der eingegangenen Kerzen (ISO-8601-UTC). */
  firstEventTime: string;
  /** Späteste Eventzeit der eingegangenen Kerzen (ISO-8601-UTC). */
  lastEventTime: string;
  /** Jüngster Ingestion-Zeitstempel der eingegangenen Kerzen (ISO-8601-UTC). */
  maxIngestedAt: string;
  /** sha256 der eingegangenen Kerzendaten (`ds1:<hex>`). */
  datasetHash: string;
  /** Politik, unter der `availableAt` gebildet wurde. */
  availabilityPolicy: FeatureAvailabilityPolicy;
}

/** Ein zu schreibender Featurewert (vor der Persistenz). */
export interface FeatureValueDraft {
  featureId: string;
  featureVersion: number;
  entityType: FeatureEntityType;
  entityId: string;
  timeframe: SupportedTimeframe;
  dtype: FeatureDtype;
  /** Schlusszeit der Kerze, aus der der Wert stammt. */
  eventTime: Date;
  /** Zeitpunkt, ab dem der Wert glaubwürdig bekannt war (siehe Modulkopf). */
  availableAt: Date;
  /** Zeitpunkt der Berechnung (injizierte Uhr, nicht `Date.now()` im Kern). */
  computedAt: Date;
  /** `null` = explizit nicht verfügbar (siehe `nullReason`); **nie** ein Ersatzwert. */
  value: FeatureValue | null;
  nullReason: FeatureNullReason | null;
  qualityStatus: FeatureQualityStatus;
  /** Fingerprint der Definition, mit der gerechnet wurde. */
  definitionHash: string;
  /** `fv1:<sha256>` — Inhaltsfingerprint des Werts. */
  valueHash: string;
  sourceManifest: FeatureSourceManifest;
}

/** Persistierter Wert (Zeile in `feature_values`). */
export interface FeatureValueRow extends FeatureValueDraft {
  id: string;
  runId: string | null;
  createdAt?: Date;
}

// ── Materialisierung ────────────────────────────────────────────────────────

/** Modus eines Materialisierungslaufs. */
export type FeatureMaterializationMode = "INCREMENTAL" | "BACKFILL";
export const FEATURE_MATERIALIZATION_MODES: readonly FeatureMaterializationMode[] = [
  "INCREMENTAL",
  "BACKFILL",
] as const;

/** Zähler eines Materialisierungslaufs (Manifest, ohne freie Texte). */
export interface FeatureMaterializationCounts {
  /** Geschlossene Bars, die der Lauf bewertet hat. */
  barsConsidered: number;
  /** Bars, die der Cursor-Wasserstand bereits abdeckt (kein Draft erzeugt). */
  skippedBeforeCursor: number;
  /** Bars, die im Raster fehlen (Lücke) — es wird **kein** Wert erfunden. */
  gapBars: number;
  /** Neue Zeilen (ein Wert je Feature und Bar). */
  valuesWritten: number;
  /** Identische Werte zum selben Schlüssel — kein Write (Idempotenz). */
  duplicates: number;
  /** Abweichender Wert zum selben Schlüssel — nicht überschrieben (Revision). */
  revisions: number;
  /** Geschriebene Zeilen mit `value = null` (Teilmenge von `valuesWritten`). */
  nullValues: number;
}

/** Status eines Materialisierungslaufs. */
export type FeatureMaterializationStatus = "SUCCEEDED" | "FAILED";

/** Wasserstand (Cursor) einer Featurereihe: wie weit ist materialisiert? */
export interface FeatureCursor {
  featureId: string;
  featureVersion: number;
  entityId: string;
  timeframe: SupportedTimeframe;
  /** Letzte materialisierte Eventzeit (Schlusszeit der Kerze). */
  watermarkEventTime: Date;
  /** Zugehöriger Verfügbarkeitszeitpunkt (`availableAt` derselben Zeile). */
  watermarkAvailableAt: Date;
  lastRunId: string | null;
}

/** Manifest eines Laufs (Reproduzierbarkeit: Welche Definitionen, welche Daten?). */
export interface FeatureMaterializationRun {
  id: string;
  /** `fm1:<sha256>` — stabiler Schlüssel aus Definitionen, Entities, Datenständen. */
  idempotencyKey: string;
  mode: FeatureMaterializationMode;
  status: FeatureMaterializationStatus;
  timeframe: SupportedTimeframe;
  availabilityPolicy: FeatureAvailabilityPolicy;
  featureRefs: readonly FeatureRef[];
  entityIds: readonly string[];
  fromTs: Date | null;
  toTs: Date | null;
  counts: FeatureMaterializationCounts;
  /** Definitions-Fingerprints der beteiligten Features (`featureId@version`). */
  definitionHashes: Readonly<Record<string, string>>;
  /** Dataset-Hashes je Entity (`ds1:…`) — die Rohdatenbasis des Laufs. */
  sourceManifests: Readonly<Record<string, FeatureSourceManifest>>;
  /** Cursorstände vor/nach dem Lauf (Transparenz für Betrieb/Debugging). */
  cursorBefore: readonly FeatureCursor[];
  cursorAfter: readonly FeatureCursor[];
  /** Anwendungsversion (`APP_VERSION`, keine Duplikat-Konstante im Code). */
  codeVersion: string;
  /** Fehlercode bei `FAILED` (maschinenlesbar), sonst `null`. */
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date;
}

/** Kompakte Sicht auf einen Lauf für Read-APIs (ohne Manifest-Blobs). */
export interface FeatureMaterializationRunView {
  id: string;
  mode: FeatureMaterializationMode;
  status: FeatureMaterializationStatus;
  timeframe: SupportedTimeframe;
  availabilityPolicy: FeatureAvailabilityPolicy;
  featureRefs: readonly string[];
  entityCount: number;
  counts: FeatureMaterializationCounts;
  codeVersion: string;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string;
}

/**
 * Beobachtete Datenrevision: derselbe Schlüssel wurde mit **anderem** Inhalt neu
 * berechnet. Der gespeicherte Wert bleibt gültig (historische Reproduzierbarkeit);
 * der Befund wird protokolliert, damit Betrieb/Forschung die Revision sieht.
 */
export interface FeatureDataRevision {
  featureId: string;
  featureVersion: number;
  entityId: string;
  timeframe: SupportedTimeframe;
  eventTime: Date;
  /** Fingerprint des **gespeicherten** (weiterhin gültigen) Werts. */
  existingValueHash: string;
  /** Fingerprint des neu berechneten, **abgelehnten** Werts. */
  incomingValueHash: string;
  /** `computedAt` des Laufs, der die Revision bemerkt hat. */
  detectedAt: Date;
  runId: string | null;
}

// ── Point-in-Time-Abfrage ───────────────────────────────────────────────────

/** Eine Wunschangabe einer PIT-Abfrage. */
export interface FeatureQuerySpec {
  featureId: string;
  /** Ohne Angabe: neueste registrierte Version. */
  version?: number;
  /** Optionaler Zielzeitpunkt; sonst gilt `targetTime` der Abfrage. */
  targetTime?: Date;
}

/** Status einer PIT-Zeile — Missingness ist explizit, nie `0`. */
export type FeaturePitStatus = "OK" | "NULL_VALUE" | "MISSING";
export const FEATURE_PIT_STATUSES: readonly FeaturePitStatus[] = ["OK", "NULL_VALUE", "MISSING"] as const;

/** Eine Zeile der PIT-Antwort. */
export interface FeaturePitValue {
  entityId: string;
  featureId: string;
  version: number;
  dtype: FeatureDtype;
  unit: string | null;
  status: FeaturePitStatus;
  /** `null` bei `MISSING`/`NULL_VALUE` — niemals ein Ersatzwert. */
  value: FeatureValue | null;
  nullReason: FeatureNullReason | null;
  qualityStatus: FeatureQualityStatus | null;
  eventTime: string | null;
  availableAt: string | null;
  computedAt: string | null;
  /**
   * **Informationsalter** in ms: Abstand zwischen `asOf` und dem späteren der
   * beiden Zeitpunkte `eventTime`/`availableAt` (`null` bei `MISSING`). Bewusst
   * nicht `targetTime − eventTime`: ein Wert, der erst nach der Zielzeit bekannt
   * wurde, ist trotzdem frisch — und eine lange bekannte Reihe kann trotz
   * „aktueller“ Eventzeit veraltet sein.
   */
  lagMs: number | null;
  /** `lagMs > Zeitrahmen` (bzw. injiziertes `maxLagMs`): Information ist alt. */
  stale: boolean;
  definitionHash: string | null;
}

/** Antwort einer PIT-Abfrage inkl. der wirksamen Zeitgrenzen. */
export interface FeaturePitResult {
  asOf: string;
  timeframe: SupportedTimeframe;
  values: FeaturePitValue[];
  /**
   * Zähler über angeforderte (Entity × Feature)-Paare:
   *
   *   * `requested`  — angeforderte Paare (Entities × Features);
   *   * `matched`    — Paare mit einer zulässigen Zeile (auch wenn sie NULL ist);
   *   * `missing`    — Paare **ohne** zulässige Zeile (kein Ersatzwert!);
   *   * `nullValues` — davon Paare mit explizitem NULL (`nullReason` gesetzt);
   *   * `stale`      — davon Paare, deren Information älter als ein Bar ist.
   *
   * Invariante: `matched + missing = requested`, `nullValues ≤ matched`,
   * `stale ≤ matched`.
   */
  requested: number;
  matched: number;
  missing: number;
  nullValues: number;
  stale: number;
}

// ── Fehler ──────────────────────────────────────────────────────────────────

/**
 * Fehler des Feature Stores. `code` ist ein stabiler, maschinenlesbarer Code
 * (kein Freitext) — API-Antworten und Fail-closed-Entscheidungen hängen daran.
 */
export class FeatureStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Harte Grenzen (DoS-/Kardinalitätsschutz) — bewusst klein gehalten. */
export const FEATURE_LIMITS = {
  /** Maximale Entities je PIT-Abfrage. */
  pitEntities: 200,
  /** Maximale Features (Entity-unabhängige Wunschliste) je PIT-Abfrage. */
  pitFeatures: 25,
  /** Maximale Rückgabezeilen (Entities × Features) je PIT-Abfrage. */
  pitRows: 2000,
  /** Maximale Rohzeilen, die eine PIT-Abfrage aus der DB laden darf. */
  pitSourceRows: 20_000,
  /** Maximale Wertezeilen je Materialisierungs-Insert-Chunk (Parameterdeckel). */
  insertChunkRows: 250,
  /** Maximale Wertezeilen je Materialisierungsbatch (bounded Batch). */
  batchRows: 2000,
  /** Maximale Zahl Materialisierungsbatches je CLI-Lauf (Laufzeitdeckel). */
  maxBatches: 500,
  /** Maximale Zahl Entities je Materialisierungslauf. */
  materializeEntities: 500,
  /** Maximale Definitionszeilen der Registry-Read-API. */
  definitionsList: 100,
  /** Maximale Länge einer Entity-ID (Instrument-ID). */
  entityIdLength: 64,
  /** Maximale Länge einer Feature-ID. */
  featureIdLength: 64,
} as const;

/** Prüft einen Wert gegen die Dtype-Allowlist. */
export function isFeatureDtype(value: unknown): value is FeatureDtype {
  return typeof value === "string" && (FEATURE_DTYPES as readonly string[]).includes(value);
}

/** Prüft einen Wert gegen die Null-Grund-Allowlist. */
export function isFeatureNullReason(value: unknown): value is FeatureNullReason {
  return typeof value === "string" && (FEATURE_NULL_REASONS as readonly string[]).includes(value);
}

/** Prüft einen Wert gegen die Qualitäts-Allowlist. */
export function isFeatureQualityStatus(value: unknown): value is FeatureQualityStatus {
  return typeof value === "string" && (FEATURE_QUALITY_STATUSES as readonly string[]).includes(value);
}

/** Prüft einen Wert gegen die Verfügbarkeitspolitik-Allowlist. */
export function isFeatureAvailabilityPolicy(value: unknown): value is FeatureAvailabilityPolicy {
  return typeof value === "string" && (FEATURE_AVAILABILITY_POLICIES as readonly string[]).includes(value);
}

/** Prüft einen Wert gegen die Modus-Allowlist. */
export function isFeatureMaterializationMode(value: unknown): value is FeatureMaterializationMode {
  return typeof value === "string" && (FEATURE_MATERIALIZATION_MODES as readonly string[]).includes(value);
}

/** Prüft einen Wert gegen die Status-Allowlist der Läufe. */
export function isFeatureMaterializationStatus(value: unknown): value is FeatureMaterializationStatus {
  return value === "SUCCEEDED" || value === "FAILED";
}

/** Muster einer Feature-ID: `namespace.name` in Kleinbuchstaben/Punkten. */
export const FEATURE_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Muster eines Konfigurationsschlüssels (`period`, `lowThreshold`, …). */
export const FEATURE_CONFIG_KEY_PATTERN = /^[a-z][A-Za-z0-9_]{0,39}$/;

/** Muster eines Enum-Werts (Großbuchstaben/Ziffern/Unterstrich). */
export const FEATURE_ENUM_VALUE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/** Muster eines Fingerprints (`fc1:`/`fg1:`/`fd1:`/`fv1:`/`ds1:` + 64 Hex). */
export const FEATURE_HASH_PATTERN = /^(?:fc1|fg1|fd1|fv1|ds1):[0-9a-f]{64}$/;

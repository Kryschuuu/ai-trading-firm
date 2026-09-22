/**
 * Verträge des **Point-in-Time Cross-Sectional Momentum Ranking** (RMA-P2-04).
 *
 * ── Was das Modul leistet ────────────────────────────────────────────────────
 * Für ein explizites, liquiditätsgefiltertes Universum werden am EINEN
 * gemeinsamen As-of-Cutoff Momentum-Renditen über versionierten Horizonten
 * berechnet, universumsweit Querschnitts-normalisiert (Winsorize → z-Score →
 * Composite → Rang/Perzentil) und mit vollständiger Provenance
 * (Universe-/Data-/Config-Hash, Code-Version) persistiert.
 *
 * ── Zeitsemantik (Look-ahead-sicher) ────────────────────────────────────────
 * | Feld             | Bedeutung                                                    |
 * | ---------------- | ------------------------------------------------------------ |
 * | `asOf`           | Gemeinsamer As-of-Cutoff EINES Snapshots (Ereigniszeit).     |
 * | `availableAt`    | Ingestionszeit einer Kerze (`fetchedAt` im Historical Store) |
 * | `computedAt`     | Berechnungszeit des Materialisierungslaufs.                  |
 *
 * Eine Kerze darf in einen Snapshot mit Cutoff `asOf` nur einfließen, wenn
 *   - `barEnd = ts + timeframeMs ≤ asOf` (die Kerze war **geschlossen**),
 *   - UND (Policy `ingested`): `availableAt ≤ asOf` (sie war **bekannt**).
 *
 * Policy `bar_close` verzichtet auf die zweite Bedingung — sie ist eine
 * **Forschungsannahme** eines vollständigen, replay-sauberen Datensatzes
 * (später nachgelieferte Kerzen rückwirkend als „damals bekannt“ behandelt).
 * Produktionsdefault ist `ingested` (fail-closed). `computedAt` ist nie ein
 * Zulässigkeitskriterium (späte Neuberechnung erzeugt kein neues Wissen —
 * dieselbe Regel wie Feature Store und Regime-Snapshots).
 *
 * ── Fail-closed statt Nullwert ──────────────────────────────────────────────
 * Nicht berechenbare Werte sind `null` mit geschlossenen
 * Exclusions-/Horizon-Gründen — nie still `0`. Ein Ausschluss aus dem
 * Ranking ist eine Daten-/Eligibility-Faktenmeldung, kein Score-Wert.
 */

import type { SupportedTimeframe } from "../lib/marketdata/historicalStore";
import type { AssetClass } from "../universe/types";

/** Zeitachse eines Snapshots: Cutoff, Ingestion, Berechnung — getrennt. */
export interface SnapshotTimestamps {
  /** Gemeinsamer As-of-Cutoff (Ereigniszeit), Unix-Epoch ms. */
  asOf: number;
  /** Berechnungszeit des Laufs (Persistenzzeitpunkt), Unix-Epoch ms. */
  computedAt: number;
}

/**
 * Ein versionierter Momentum-Horizont.
 *
 * `lookback` zählt Kerzen rückwärts vom Cutoff; `skip` überspringt die
 * letzten `skip` Kerzen VOR der Basis-Preisnahme (Klassiker: „12-1
 * skip 1" analog auf Bar-Raster). Der Basispreis ist der Schluss der letzten
 * geschlossenen Kerze mit `barEnd ≤ asOf − (lookback + skip) × timeframeMs`.
 */
export interface MomentumHorizonConfig {
  /** Stabile Kennung des Horizonts (erscheint in allen Artefakten), z. B. `h72`. */
  id: string;
  /** Rückblick in Kerzen (≥ 1). */
  lookback: number;
  /** Überprung-Kerzen vor der Basis-Preisnahme (≥ 0), Default 0. */
  skip: number;
  /** Gewicht im Composite (≥ 0; die Summe muss > 0 über alle Horizonte). */
  weight: number;
}

/**
 * Eligibility des Universums (Snapshot-Membership).
 *
 * Reihenfolge der Prüfung pro Instrument ist Teil des Verhaltens
 * (erster Treffer gewinnt, genau EIN Grund je Instrument):
 *   `INACTIVE → NOT_IN_ASSET_CLASSES → NO_LIQUIDITY_DATA →
 *    BELOW_MIN_VOLUME → UNIVERSE_CAP → NO_BARS_AT_CUTOFF →
 *    STALE_DATA → INSUFFICIENT_HISTORY`
 * (`UNIVERSE_CAP` gilt nur unter den bis dahin Verbliebenen: die
 * `maxUniverseSize` Instrumente mit dem höchsten `volume24h` (Tie-Break:
 * ID aufsteigend) bleiben im Universum.)
 */
export interface EligibilityConfig {
  /** Mindest-24h-Handelsvolumen in Quote-Währung (> 0). */
  minVolume24h: number;
  /** Mindestanzahl geschlossener Kerzen im Max-Fenster (≥ 1). */
  minCandles: number;
  /**
   * Max. Kerzen, die die letzte geschlossene Kerze älter sein darf als der
   * Cutoff (Staleness-Guard, ≥ 1). Default 2.
   */
  maxStaleBars: number;
  /**
   * Optionaler Assetgruppen-Filter (geschlossen über {@link ASSET_CLASSES});
   * `null` = alle Anlageklassen.
   */
  assetClasses: readonly AssetClass[] | null;
  /** Harte Obergrenze der Universe-Größe (≥ 1, DoS-/Kosten-Guard). */
  maxUniverseSize: number;
}

/** Verfügbarkeitspolitik (siehe Modulkopf-Zeittabelle). */
export type AvailabilityPolicy = "ingested" | "bar_close";
export const AVAILABILITY_POLICIES: readonly AvailabilityPolicy[] = ["ingested", "bar_close"] as const;

/** Welcher Rohwert je Horizont in den Querschnitt eingeht (Composite). */
export type CrossSectionValueMode = "total" | "volAdjusted";
export const CROSS_SECTION_VALUE_MODES: readonly CrossSectionValueMode[] = ["total", "volAdjusted"] as const;

/**
 * Vollständige, versionierte Konfiguration des Cross-Sectional-Rankings.
 *
 * ÄNDERUNG DER KONFIGURATION ⇒ neues `configHash` ⇒ neue Snapshot-Identität.
 * Es werden nie bestehende Snapshots „neu interpretiert".
 */
export interface CrossSectionalConfig {
  /** Schema-/Konfigurationsversion (erscheint in jedem Snapshot). */
  version: number;
  /** Freitext-Beschreibung. */
  description: string;
  /** Kerzen-Periodizität der Momentum-Berechnung (erlaubt: `SUPPORTED_TIMEFRAMES`). */
  timeframe: SupportedTimeframe;
  /** Verfügbarkeitspolitik für Kerzen (Default `ingested`, fail-closed). */
  availabilityPolicy: AvailabilityPolicy;
  /** Versionierte Horizonte (mind. 1, Summe der Gewichte > 0). */
  horizons: MomentumHorizonConfig[];
  /** Rohwertmodus für das Composite (Default `total` — klassisch). */
  valueMode: CrossSectionValueMode;
  /** Unterer Winsorize-Quantil (0 ≤ lower < upper ≤ 1). */
  winsorLower: number;
  /** Oberer Winsorize-Quantil. */
  winsorUpper: number;
  /**
   * σ-Schwelle: Horizonte mit Querschnitts-σ unterhalb sind degenerated und
   * fallen aus dem Composite ( Coverage-Renormalisierung, nie `0`-Substitution).
   */
  minZStd: number;
  /**
   * Mindest-Coverage der Horizonte je Instrument (Anteil verfügbarer
   * Horizonte, ≥ minZStd-fähig): darunter → Ausschluss
   * `INSUFFICIENT_HORIZON_COVERAGE`.
   */
  minHorizonCoverage: number;
  /** Mindestanzahl Bar-Returns im Fenster für die Volatilität (≥ 2). */
  minVolReturns: number;
  /** Eligibility des Universums. */
  eligibility: EligibilityConfig;
  /**
   * Max. Alter eines Snapshots in ms, ab dem Scanner-Integration den Faktor
   * als unavailable meldet (Staleness-Guard des Konsumenten).
   */
  maxSnapshotAgeMs: number;
  /** Top-K für Turnover-/Stabilitätsmessung (≥ 2, ≤ 50). */
  stabilityTopK: number;
}

/** Geschlossene Liste der Ausschlussgründe (Snapshot-Membership). */
export type ExclusionReason =
  | "INACTIVE"
  | "NOT_IN_ASSET_CLASSES"
  | "NO_LIQUIDITY_DATA"
  | "BELOW_MIN_VOLUME"
  | "UNIVERSE_CAP"
  | "NO_BARS_AT_CUTOFF"
  | "STALE_DATA"
  | "INSUFFICIENT_HISTORY"
  | "INSUFFICIENT_HORIZON_COVERAGE"
  | "CROSS_SECTION_DEGENERATE"
  | "INVALID_INPUT";

/** Alle Ausschlussgründe (geschlossene Liste, Doku/Tests/DB-Constraint). */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "INACTIVE",
  "NOT_IN_ASSET_CLASSES",
  "NO_LIQUIDITY_DATA",
  "BELOW_MIN_VOLUME",
  "UNIVERSE_CAP",
  "NO_BARS_AT_CUTOFF",
  "STALE_DATA",
  "INSUFFICIENT_HISTORY",
  "INSUFFICIENT_HORIZON_COVERAGE",
  "CROSS_SECTION_DEGENERATE",
  "INVALID_INPUT",
] as const;

/** Status eines Universums-Mitglieds in einem Snapshot. */
export type MemberStatus = "RANKED" | "EXCLUDED";

/**
 * Momentum-Rendite eines Horizonts eines Instruments — `total` ist immer
 * berechnet, wenn `available` gilt; `volAdjusted` ist `null`, wenn die
 * Fenstervolatilität nicht berechenbar war (flache Reihe, zu wenig Returns)
 * — `null`, nie `0`.
 */
export interface HorizonReturn {
  /** Gesamtrendite (arithmetic) `c_end / c_base − 1` als Dezimalanteil. */
  total: number | null;
  /**
   * Volatilitätsadjustierte Rendite: `total / (σ_window × √span)`, d. h. die
   * Fenster-Rendite in Einheiten ihrer (nicht annualisierten) Fenster-
   * Volatilität (Sharpe-artig, dimensionslos). `null` = nicht berechenbar.
   */
  volAdjusted: number | null;
  /** Anzahl der genutzten Kerzen im Fenster (Basis..Ende inklusive). */
  barsUsed: number;
  /** `false` + Grund, wenn der Horizont nicht berechenbar war. */
  available: boolean;
  /** Geschlossener Nichtverfügbarkeits-Grund (nur bei `available === false`). */
  reason: string | null;
}

/**
 * Ein Universums-Mitglied eines Snapshots (Persistenz- und Artefakt-Form).
 *
 * Für `EXCLUDED`: `rank`/`percentile`/`composite` und alle Horizons sind
 * `null` + `exclusionReason` gesetzt. Für `RANKED`: exakt ein Mitglied je
 * (Snapshot, Instrument); `rank` ∈ [1, universeRankedCount].
 */
export interface UniverseMember {
  /** Kanonische Instrument-ID (`VENUE:SYMBOL`) — Teil des Tie-Breaks. */
  instrumentId: string;
  status: MemberStatus;
  /** Rangposition (1 = beste Composite), nur bei `RANKED`. */
  rank: number | null;
  /**
   * Perzentil: Anteil des gerankten Universums, der gleich oder schlechter
   * ist: `(n − rank + 1) / n` ∈ (0, 1]. Rang 1 ⇒ 1.0. Nur bei `RANKED`.
   */
  percentile: number | null;
  /** Gewichtetes Composite (z-Score-Summe), nur bei `RANKED`. */
  composite: number | null;
  /**
   * Rohrenditen je Horizont (IDs der Config); `null`-Werte sind explizit
   * nicht berechenbar (nie 0).
   */
  rawReturns: Readonly<Record<string, HorizonReturn | null>>;
  /** Winsorisierte Rohwerte je Horizont (Querschnitt), `null` = nicht berechenbar. */
  winsorized: Readonly<Record<string, number | null>>;
  /** z-Scores je Horizont (nach Winsorize), `null` = nicht berechenbar/degenerated. */
  zScores: Readonly<Record<string, number | null>>;
  /** Anteil verfügbarer Horizonte [0,1] (vor der Mindestcoverage-Prüfung). */
  horizonCoverage: number;
  /** Schlusszeit (barEnd, ms) der jüngsten im Snapshot genutzten Kerze. */
  lastBarTs: number | null;
  /** Ingestionszeit (availableAt, ms) dieser Kerze. */
  lastAvailableAt: number | null;
  /** Anzahl der im Max-Fenster genutzten Kerzen. */
  barsUsed: number;
  /** Ausschlussgrund, nur bei `EXCLUDED`. */
  exclusionReason: ExclusionReason | null;
}

/**
 * Turnover-/Stabilitäts-Messung gegen den unmittelbar vorherigen Snapshot
 * (gleicher Timeframe, beliebige Universe-Zusammensetzung; überlappt über
 * die gemeinsamen Instrumente). Alle Felder gebounded (Zähler/Quotienten).
 */
export interface SnapshotStability {
  /** ID des Vergleichs-Snapshots. */
  prevSnapshotId: string;
  /** K der Top-K-Vergleichsmenge. */
  topK: number;
  /**
   * Jaccard-Überschneidung der Top-K-Mengen beider Snapshots ∈ [0,1];
   * `null`, wenn eine der Mengen leer ist.
   */
  topKOverlap: number | null;
  /**
   * Mittelbetrag der Rangänderung `|rank_now − rank_prev|` über die
   * gemeinsamen gerankten Instrumente; `null` ohne Überlappung.
   */
  rankShiftMean: number | null;
  /** Anzahl gemeinsamer gerankter Instrumente. */
  commonCount: number;
}

/** Provenance-Hashes eines Snapshots (Prefixe `xs1:` / `xu1:` / `xd1:` / `xc1:`). */
export interface SnapshotProvenance {
  /**
   * `xs1:<sha256>` über Schema|Timeframe|AsOf|UniverseHash|DataHash|
   * ConfigHash|CodeVersion — die deterministische Snapshot-Identität
   * (gleichzeitig der Idempotenz-Key in hex-Form).
   */
  snapshotId: string;
  /** `xu1:<sha256>` über die kandiierende Instrumentenpopulation (ID-sorted). */
  universeHash: string;
  /** `xd1:<sha256>` über die tatsächlich konsumierten Kerzen (ID-sorted). */
  dataHash: string;
  /** `xc1:<sha256>` über die vollständige Konfiguration (stable JSON). */
  configHash: string;
  /** Code-Version des Berechnungsvertrags, z. B. `cross-sectional@1`. */
  codeVersion: string;
}

/**
 * Ein vollständiger Point-in-Time-Snapshot — die zentrale Domäne des Moduls.
 * Rein wertbasiert (keine Referenzen), serialisierungsfest, deterministisch.
 */
export interface CrossSectionalSnapshot {
  /** Schema-Version der Snapshot-Form. */
  schemaVersion: number;
  /** Gemeinsamer As-of-Cutoff (Ereigniszeit), Unix-Epoch ms. */
  asOf: number;
  /** Berechnungszeit (Persistenzzeit), Unix-Epoch ms. */
  computedAt: number;
  /** Kerzen-Periodizität der Berechnung. */
  timeframe: SupportedTimeframe;
  /** Verfügbarkeitspolitik des Laufs. */
  availabilityPolicy: AvailabilityPolicy;
  /** Versionierte Konfiguration (vollständig — Provenance im Artefakt). */
  config: CrossSectionalConfig;
  /** Provenance (Hashes + Code-Version + Snapshot-ID). */
  provenance: SnapshotProvenance;
  /**
   * Anzahl aller Kandidaten (aktive, im Scope) — Basis der Coverage.
   */
  universeSize: number;
  /** Anzahl gerankter Instrumente. */
  rankedCount: number;
  /** Anzahl ausgeschlossener Instrumente. */
  excludedCount: number;
  /** `rankedCount / universeSize` ∈ [0,1] (1 wenn leer, siehe Doku). */
  coverage: number;
  /** Ausschlusszähler je Grund (nur Gründe > 0). */
  exclusionCounts: Readonly<Record<ExclusionReason, number>>;
  /** Alle Mitglieder (gerankt + ausgeschlossen), ID-sorted. */
  members: UniverseMember[];
  /** Stabilität gegen den Vorgänger (Persistenz berechnet; Pure-Lauf: null). */
  stability: SnapshotStability | null;
  /**
   * Sichtbar dokumentierte Datenlage-Grenze (Survivorship-Note): die
   * Membership stammt aus der **aktuellen** Registry (Point-in-Time-Membership
   * historischer Delistings ist NICHT rekonstruierbar) — das Artefakt weist
   * die Lücke sichtbar aus, statt sie zu verdecken.
   */
  survivorshipNote: string;
}

/**
 * Kontext, den die Scanner-Integration je Instrument injiziert
 * (additiver Faktor; `null` = explicitly unavailable — nie 0-Momentum).
 */
export interface CrossSectionalRankContext {
  /** Kanonische Instrument-ID. */
  instrumentId: string;
  /** ID des Snapshots, aus dem der Rang stammt. */
  snapshotId: string;
  /** As-of des Snapshots (Unix-Epoch ms). */
  asOf: number;
  /** Rangposition (1 = beste). */
  rank: number;
  /** Perzentil ∈ (0,1] (Anteil des Universums ≤ diesem Mitglied). */
  percentile: number;
  /** Composite (gewichtete z-Score-Summe). */
  composite: number;
}

/**
 * Kerze im Eingabeformat des Moduls: ein geschlossener OHLCV-Punkt mit
 * Provenanz. `fetchedAtMs` = `availableAt` (Ingestionszeit, epoch ms).
 */
export interface MomentumCandle {
  /** Kerzen-Startzeit (ts), Unix-Epoch ms. */
  ts: number;
  /** Schlusskurs (> 0, endliche Zahl). */
  close: number;
  /** Ingestionszeit (availableAt), Unix-Epoch ms. */
  fetchedAtMs: number;
}

/** Eingabe eines Snapshots (alles injiziert, nichts implizit). */
export interface CrossSectionalInput {
  /** As-of-Cutoff (Ereigniszeit), Unix-Epoch ms. */
  asOf: number;
  /** Berechnungszeit (injizierte Uhr), Unix-Epoch ms. */
  computedAt: number;
  /**
   * Kandidatenpopulation (typischerweise alle Registry-Instrumente; die
   * Eligibility entscheidet über die Membership). Reihenfolge ist egal —
   * das Modul sortiert kanonisch nach ID.
   */
  instruments: readonly {
    id: string;
    status: string;
    assetClass: AssetClass;
    volume24h: number | null;
  }[];
  /**
   * Geschlossene Kerzen je Kandidat (aufsteigend nach `ts`), bereits auf
   * den konfigurierten Timeframe gefiltert. Fehlende Reihen = leer.
   * Kerzen NACH dem Cutoff oder (Policy `ingested`) nach Ingestion über
   * `asOf` dürfen nicht mitgereicht werden — sie würden die
   * Point-in-Time-Garantie brechen (der Modulkopf beschreibt die Regel;
   * Tests erzwingen sie).
   */
  candles: ReadonlyMap<string, readonly MomentumCandle[]>;
  /** Versionierte Konfiguration. */
  config: CrossSectionalConfig;
  /** Code-Version des Berechnungsvertrags (Default `cross-sectional@1`). */
  codeVersion?: string;
}

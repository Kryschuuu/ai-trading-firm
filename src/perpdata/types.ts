/**
 * Kanonische Verträge der **historischen Perpetual-Daten** (RMA-P2-02, v1.54.0).
 *
 * ── Warum das hier existiert ────────────────────────────────────────────────
 * Funding, Open Interest und Liquidationen gab es vor diesem Modul nur als
 * **Momentwert** (Ticker/Discovery) und als Buchungslogik im Paper-Ledger.
 * Für Backtest, Research und Post-Mortem fehlt damit eine Wahrheit mit Zeit:
 * welche Rate galt zu welchem Zeitpunkt, und **ab wann** wusste das System sie?
 * Genau diese Zeitpunkte werden hier getrennt modelliert:
 *
 * | Feld            | Bedeutung                                                     |
 * | --------------- | ------------------------------------------------------------- |
 * | `eventTime`     | Ereigniszeit (Funding-Settlement, OI-Messpunkt, Liquidation). |
 * | `availableAt`   | Zeitpunkt, ab dem der Satz **wahrheitsgemäß bekannt** war.     |
 * | `fetchedAt`     | Zeitpunkt des Abrufs beim Venue (Transport, nie Entscheidungsgrundlage). |
 *
 * `availableAt` ist die Politik (`PERP_AVAILABILITY_POLICY`):
 *
 *   * `ingested`   — `availableAt = max(eventTime, fetchedAt)` (Default,
 *     fail-closed: nachgelieferte Sätze sind erst ab ihrer Ankunft sichtbar).
 *   * `settlement` — `availableAt = eventTime` (Forschungsannahme eines
 *     vollständigen, replay-sauberen Datensatzes; dieselbe Semantik wie
 *     `bar_close` des Point-in-Time Feature Stores, RMA-P6-01).
 *
 * ── Einheiten (verbindlich, Teil des Inhaltshashes) ──────────────────────────
 * Eine Zahl ohne Einheit ist keine Zahl. Die Einheiten sind **fest** und werden
 * bei der Normalisierung erzwungen — liefert eine Venue Prozent, wird
 * umgerechnet, nicht unverändert übernommen:
 *
 * | Größe                     | Einheit (`unit`)          | Beispiel                     |
 * | ------------------------- | ------------------------- | ---------------------------- |
 * | Funding-Rate je Intervall | `fraction_per_interval`   | `0.0001` = 1 bp je Intervall |
 * | Funding-Intervall        | `hours`                   | `8`                          |
 * | OI in Kontrakten          | `contracts`               | `12500`                      |
 * | OI in Basiseinheit        | `base_units`              | `1250` BTC                   |
 * | OI in Quote-Währung       | `quote_units`             | `83400000` USDT              |
 * | Liquidationsmenge         | `base_units`              | `0.5` BTC                    |
 * | Liquidationspreis         | `quote_per_base`          | `66286.6`                    |
 * | Liquidations-Notional     | `quote_units`             | `33143` USDT                 |
 *
 * **Vorzeichenkonvention Funding** (identisch zu `src/lib/funding.ts`):
 * `fundingRate > 0` ⇒ **Longs zahlen** an Shorts; `< 0` ⇒ Longs erhalten.
 * Die Kontosicht einer Position ist das Negative
 * (`funding = −rate · |notional| · direction`, siehe docs/PAPER_TRADING.md).
 *
 * ── `null` ≠ `0` ─────────────────────────────────────────────────────────────
 * Eine unbekannte Größe ist `null` **mit** Grund (`missingReason`), nie `0`.
 * Die CHECK-Constraints der Tabellen erzwingen das bis in die Datenbank.
 */
import type { MarketInstrument } from "../universe/types";

/** Die drei Reihenarten, die dieses Modul kanonisch behandelt. */
export type PerpSeriesKind = "funding" | "openInterest" | "liquidations";

/** Geschlossene Liste aller Reihenarten (Validierung, Doku, Metrik-Labels). */
export const PERP_SERIES_KINDS: readonly PerpSeriesKind[] = [
  "funding",
  "openInterest",
  "liquidations",
] as const;

/** Prüft einen Wert gegen die Reihenarten-Aufzählung. */
export function isPerpSeriesKind(value: unknown): value is PerpSeriesKind {
  return (
    typeof value === "string" &&
    (PERP_SERIES_KINDS as readonly string[]).includes(value)
  );
}

/** Schema-Version der kanonischen Zeilenform (bei Semantikänderung erhöhen). */
export const PERP_SCHEMA_VERSION = 1;

/** Präfix des Inhaltshashes (`pv1:<sha256>`). */
export const PERP_HASH_PREFIX = "pv1";

/** Qualitätsstatus einer Zeile (geschlossene Liste). */
export type PerpQualityStatus =
  | "OK"
  | "GAP"
  | "OUTLIER"
  | "INVALID"
  | "DUPLICATE"
  | "CROSSCHECK"
  | "STALE"
  | "UNKNOWN";

export const PERP_QUALITY_STATUSES: readonly PerpQualityStatus[] = [
  "OK",
  "GAP",
  "OUTLIER",
  "INVALID",
  "DUPLICATE",
  "CROSSCHECK",
  "STALE",
  "UNKNOWN",
] as const;

/**
 * Reihenfolge der Qualitätsstatus (das strengste Ergebnis gewinnt), analog
 * `FEATURE_QUALITY_SEVERITY` des Feature Stores. `UNKNOWN` ist **nicht** „gut“,
 * sondern „kein Befund“ — Konsumenten mit Qualitätsanforderung behandeln es
 * fail-closed.
 */
export const PERP_QUALITY_SEVERITY: Record<PerpQualityStatus, number> = {
  OK: 0,
  DUPLICATE: 1,
  CROSSCHECK: 2,
  GAP: 3,
  STALE: 4,
  OUTLIER: 5,
  UNKNOWN: 6,
  INVALID: 7,
};

/**
 * Statuswerte, deren Messzahl einem Verbraucher **nicht** zugemutet wird.
 *
 * `INVALID`/`DUPLICATE`/`CROSSCHECK`/`UNKNOWN` sagen: diese Zeile ist als
 * Aussage nicht belegbar (unplausibler Wert, Doppelbuchung, Venue-Widerspruch,
 * kein Befund). `GAP`/`STALE`/`OUTLIER` betreffen Alter und Lücke, nicht die
 * Zahl selbst — die bleibt benutzbar, solange sie einen Wert trägt.
 * Konsumenten (Snapshot, Funding-Replay, Backtest-Provider) filtern damit
 * fail-closed, unabhängig von `log`/`strict`.
 */
export const PERP_UNATTESTABLE_QUALITY: readonly PerpQualityStatus[] = [
  "INVALID",
  "DUPLICATE",
  "CROSSCHECK",
  "UNKNOWN",
] as const;

/** `true` ⇒ der Wert der Zeile darf in ein Signal, einen Replay-Posten oder ein Artefakt. */
export function perpRowIsAttestable(row: { qualityStatus: PerpQualityStatus }): boolean {
  return !PERP_UNATTESTABLE_QUALITY.includes(row.qualityStatus);
}

/** Grund für einen `null`-Wert (geschlossene Liste; `null` ist kein Messwert). */
export type PerpMissingReason =
  | "NOT_REPORTED"
  | "OUT_OF_BOUNDS"
  | "SOURCE_ERROR"
  | "NOT_APPLICABLE";

export const PERP_MISSING_REASONS: readonly PerpMissingReason[] = [
  "NOT_REPORTED",
  "OUT_OF_BOUNDS",
  "SOURCE_ERROR",
  "NOT_APPLICABLE",
] as const;

/** Verfügbarkeitspolitik beim Schreiben (siehe Modulkopf). */
export type PerpAvailabilityPolicy = "ingested" | "settlement";
export const PERP_AVAILABILITY_POLICIES: readonly PerpAvailabilityPolicy[] = [
  "ingested",
  "settlement",
] as const;

/** Modus eines Sync-Laufs. */
export type PerpSyncMode = "INCREMENTAL" | "BACKFILL";
export const PERP_SYNC_MODES: readonly PerpSyncMode[] = [
  "INCREMENTAL",
  "BACKFILL",
] as const;

/** Zustand eines Sync-Laufs. `PARTIAL` = mindestens ein isolierter Fehler. */
export type PerpSyncStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";
export const PERP_SYNC_STATUSES: readonly PerpSyncStatus[] = [
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Provenanz und Zeilenformen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provenanz, die **jede** Perp-Zeile trägt.
 *
 * `instrumentId` ist die venue-native Speicherform (`BITUNIX:BTCUSDT`) —
 * identisch zur Registry- und Historical-Store-Keyung (docs/SYMBOLS.md §4),
 * damit Joins über Instrumente hinweg funktionieren. `symbol` ist das native
 * Venue-Symbol ohne Präfix. `sourceId` bezeichnet Endpunkt/Kanal und ist bei
 * Ereignisströmen (Liquidationen) Teil des natürlichen Schlüssels.
 */
export interface PerpProvenance {
  /** Venue-Key in Großbuchstaben (sanitisiert, nie ein Secret). */
  venue: string;
  /** Kanonische Instrument-ID `VENUE:SYMBOL` (Speicherform). */
  instrumentId: string;
  /** Venue-natives Symbol (`BTCUSDT`). */
  symbol: string;
  /** Quelle/Endpunkt-Kennung, z. B. `bitunix:funding_history`. */
  sourceId: string;
  /** Schema-Version der Zeile ({@link PERP_SCHEMA_VERSION}). */
  schemaVersion: number;
  /** Ereigniszeit. */
  eventTime: Date;
  /** Ab diesem Zeitpunkt war der Satz bekannt (politikabhängig). */
  availableAt: Date;
  /** Zeitpunkt des Abrufs beim Venue. */
  fetchedAt: Date;
}

/** Persistierbare Funding-Zeile. */
export interface PerpFundingRow extends PerpProvenance {
  kind: "funding";
  /** Rate je Intervall als Dezimalanteil, signiert (> 0 = Longs zahlen). */
  fundingRate: number | null;
  /** Länge des Funding-Intervalls in Stunden (`null` = nicht gemeldet). */
  intervalHours: number | null;
  /** Nächstes Settlement (nur Live-Snapshots melden das). */
  nextFundingTime: Date | null;
  /** Mark-Preis zum Settlement (`null` = nicht gemeldet). */
  markPrice: number | null;
  /** Einheit der Rate (fix, siehe Modulkopf). */
  unit: "fraction_per_interval";
  qualityStatus: PerpQualityStatus;
  /** Grund, wenn `fundingRate === null`. */
  missingReason: PerpMissingReason | null;
  /** Deterministischer Fingerprint `pv1:<sha256>` über den Satzinhalt. */
  contentHash: string;
}

/** Welche OI-Größe die Quelle **autoritativ** gemeldet hat. */
export type PerpOpenInterestBasis = "contracts" | "base_units" | "quote_units";
export const PERP_OI_BASES: readonly PerpOpenInterestBasis[] = [
  "contracts",
  "base_units",
  "quote_units",
] as const;

/** Persistierbare Open-Interest-Zeile. */
export interface PerpOpenInterestRow extends PerpProvenance {
  kind: "openInterest";
  /** Offene Kontrakte (Einheit `contracts`). */
  contracts: number | null;
  /** Offene Menge in Basiseinheit (Einheit `base_units`). */
  baseQuantity: number | null;
  /** Offener Wert in Quote-Währung (Einheit `quote_units`). */
  quoteValue: number | null;
  /**
   * Autoritative Größe der Quelle. Die übrigen Felder dürfen nur gesetzt sein,
   * wenn sie nach dokumentierter Formel abgeleitet wurden (`converted = true`)
   * — sonst `null`. Damit ist eine Vermischung von Contract-, Base- und
   * Quote-Einheiten strukturell ausgeschlossen.
   */
  basis: PerpOpenInterestBasis;
  /** Kontraktgröße in Basiseinheit (für Contracts ↔ Base), sonst `null`. */
  contractSize: number | null;
  /** Quote-Währung — Pflicht, sobald `quoteValue` gesetzt ist. */
  quoteCurrency: string | null;
  /** Referenzkurs der Ableitung (Mark-Price), sonst `null`. */
  markPrice: number | null;
  /** `true` = mindestens ein Feld wurde gerechnet, nicht gemeldet. */
  converted: boolean;
  /** Einheit des autoritativen Werts (identisch zu `basis`). */
  unit: PerpOpenInterestBasis;
  qualityStatus: PerpQualityStatus;
  missingReason: PerpMissingReason | null;
  contentHash: string;
}

/**
 * Seite der Liquidation — **kanonisiert nach betroffener Position**, nicht nach
 * Order-Richtung. `LONG_LIQUIDATED` bedeutet: eine Long-Position wurde
 * zwangsgeschlossen (venue-seitig meist als Sell-/Short-Order gemeldet).
 */
export type PerpLiquidationSide = "LONG_LIQUIDATED" | "SHORT_LIQUIDATED";
export const PERP_LIQUIDATION_SIDES: readonly PerpLiquidationSide[] = [
  "LONG_LIQUIDATED",
  "SHORT_LIQUIDATED",
] as const;

/** Persistierbare Liquidationszeile (Ereignis, keine Reihe im engeren Sinn). */
export interface PerpLiquidationRow extends PerpProvenance {
  kind: "liquidations";
  /** Betroffene Positionsseite. */
  side: PerpLiquidationSide;
  /** Zwangsgeschlossene Menge in Basiseinheit. */
  quantityBase: number | null;
  /** Ausführungs-/Liquidationspreis (`quote_per_base`). */
  price: number | null;
  /** Notional in Quote-Währung (`null` = nicht gemeldet, nicht 0). */
  notionalQuote: number | null;
  /** Quote-Währung bei gemeldetem Notional. */
  quoteCurrency: string | null;
  /** Venue-seitige Ereignis-ID (sonst deterministischer Payload-Hash). */
  sourceEventId: string;
  /** Aggregierte Einzelereignisse desselben Moments (Venue-Bündelung). */
  aggregateCount: number | null;
  unit: "base_units";
  qualityStatus: PerpQualityStatus;
  missingReason: PerpMissingReason | null;
  contentHash: string;
}

/** Jede kanonische Perp-Zeile. */
export type PerpRow =
  | PerpFundingRow
  | PerpOpenInterestRow
  | PerpLiquidationRow;

/** Zeilenform je Reihenart (für typisierte Reader/Writer). */
export interface PerpRowByKind {
  funding: PerpFundingRow;
  openInterest: PerpOpenInterestRow;
  liquidations: PerpLiquidationRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rohformen der Adapter (vor der Normalisierung)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rohe Funding-Zeile eines Adapters.
 *
 * Alle Felder sind `unknown`-tragend definiert: ein Venue liefert Zahlen als
 * String, Millisekunden teils als Zahl, teils als String, und alles, was
 * „vielleicht“ ist, ist optional. Die **Normalisierung** (`./normalize.ts`) ist
 * die einzige Stelle, die daraus kanonische Zeilen macht — nicht jeder Consumer.
 */
export interface RawFundingRow {
  /** Epoch-ms (number | numeric string). Pflicht. */
  eventTime: number | string | null;
  /** Rate je Intervall als Dezimalanteil (Vorzeichen wie oben). */
  fundingRate?: number | string | null;
  /** Rate in Prozent je Intervall (nur bei Venues, die Prozent melden). */
  fundingRatePct?: number | string | null;
  /** Intervall in Stunden. */
  intervalHours?: number | string | null;
  /** Nächstes Settlement (Epoch-ms). */
  nextFundingTime?: number | string | null;
  /** Mark-Preis. */
  markPrice?: number | string | null;
  /** Venue-seitige Obergrenze der Rate (für Bounds-Plausibilität). */
  maxFundingRate?: number | string | null;
  /** Venue-seitige Untergrenze der Rate. */
  minFundingRate?: number | string | null;
}

/** Rohe Open-Interest-Zeile eines Adapters. */
export interface RawOpenInterestRow {
  /** Epoch-ms (number | numeric string). Pflicht. */
  eventTime: number | string | null;
  contracts?: number | string | null;
  baseQuantity?: number | string | null;
  quoteValue?: number | string | null;
  /** Autoritative Größe der Quelle (Default: die einzige nicht-leere Angabe). */
  basis?: PerpOpenInterestBasis | null;
  /** Kontraktgröße in Basiseinheit. */
  contractSize?: number | string | null;
  /** Quote-Währung (Pflicht, wenn `quoteValue` gesetzt ist). */
  quoteCurrency?: string | null;
  markPrice?: number | string | null;
}

/** Rohe Liquidationszeile eines Adapters. */
export interface RawLiquidationRow {
  /** Epoch-ms (number | numeric string). Pflicht. */
  eventTime: number | string | null;
  /**
   * Betroffene Positionsseite ODER venue-seitige Order-Richtung. Der Adapter
   * gibt an, welche Semantik er liefert (`sideIsPosition`); die
   * Normalisierung kanonisiert.
   */
  side: PerpLiquidationSide | "BUY" | "SELL" | "LONG" | "SHORT" | string | null;
  /** `true` ⇒ `side` bezeichnet die betroffene Position (Default `false`). */
  sideIsPosition?: boolean;
  quantityBase?: number | string | null;
  price?: number | string | null;
  notionalQuote?: number | string | null;
  quoteCurrency?: string | null;
  sourceEventId?: string | number | null;
  aggregateCount?: number | string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Abruf- und Abfrageverträge
// ─────────────────────────────────────────────────────────────────────────────

/** Abrufbitte an einen Adapter (Zeitfenster in Epoch-ms, halboffen). */
export interface PerpSeriesRequest {
  /** Venue-natives Symbol (`BTCUSDT`). */
  symbol: string;
  /** Untere Fenstergrenze (inklusive). */
  fromMs: number;
  /** Obere Fenstergrenze (ausschließend, `>` `fromMs`). */
  toMs: number;
  /** Harte Zeilengrenze je Response (Adapter müssen kappen und melden). */
  limit: number;
}

/**
 * Antwort eines Adapters — **dreifach** differenziert.
 *
 * | `availability`  | Bedeutung                                          |
 * | --------------- | -------------------------------------------------- |
 * | `AVAILABLE`     | Serie vorhanden (`rows` darf leer sein: echtes „keine Daten im Fenster“) |
 * | `UNSUPPORTED`   | die Venue bietet diese Reihenart **grundsätzlich** nicht (kein Endpunkt) |
 * | `UNAVAILABLE`   | temporärer Providerfehler (Retry sinnvoll)         |
 *
 * `UNSUPPORTED` ist damit von `UNAVAILABLE` unterscheidbar — und beide sind
 * **nicht** `rows: []` mit Erfolg: ein Leeren-Liste-Erfolg würde bedeuten
 * „funding-frei“, wo doch nur „nicht messbar“ gemeint ist (fail-closed-Regel).
 */
/** Rohserie eines Adapters (Einheiten sind hier noch venue-nativ). */
export interface PerpRawSeries<T> {
  /** Endpunkt/Kanal-Kennung, z. B. `bitunix:funding_history`. */
  sourceId: string;
  rows: readonly T[];
  /** `true` = Antwort war länger als `limit` und wurde gekappt. */
  truncated: boolean;
  /** Abrufzeit (injizierte Uhr des Adapters). */
  fetchedAt: Date;
  /** Epoche der Rohwerte — Default `ms`; `s` muss der Adapter deklarieren. */
  epochUnit?: "ms" | "s";
}

export type PerpFetchResult<T> =
  | { availability: "AVAILABLE"; series: PerpRawSeries<T> }
  | {
      availability: "UNSUPPORTED";
      reason: PerpUnsupportedReason;
      /** Stabiler, leak-freier Hinweis (Betriebsmeldung, kein Payload). */
      note: string;
    }
  | {
      availability: "UNAVAILABLE";
      reason: PerpUnavailableReason;
      retryable: boolean;
      httpStatus?: number;
    };

/** Gründe für „Venue kann das nicht“ (typisiert, stabil). */
export type PerpUnsupportedReason =
  | "NO_PUBLIC_ENDPOINT"
  | "VENUE_NOT_PERP"
  | "DISABLED_BY_POLICY";

/** Gründe für „gerade nicht abrufbar“ (klassifiziert, wie MDERR-006). */
export type PerpUnavailableReason =
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "SCHEMA_MISMATCH"
  | "EMPTY_RESPONSE"
  | "LIMIT_EXCEEDED"
  | "STORE_UNAVAILABLE";

/** Capability-Matrix einer Venue für Perp-Reihen (typisiert, kein Ratespiel). */
export interface PerpVenueCapabilities {
  venue: string;
  funding: PerpKindCapability;
  openInterest: PerpKindCapability;
  liquidations: PerpKindCapability;
}

/** Capability je Reihenart: entweder unterstützt oder typisiert abgelehnt. */
export type PerpKindCapability =
  | { supported: true; sourceId: string; note?: string }
  | { supported: false; reason: PerpUnsupportedReason; note: string };

/** Zeitfenster + Grenzen einer Persistenzabfrage. */
export interface PerpSeriesQuery {
  /** Venue-Filter (optional, Großbuchstaben). */
  venue?: string | null;
  /** Instrument-IDs (1..`PERP_LIMITS.queryInstruments`). */
  instrumentIds: readonly string[];
  /** Reihenarten. */
  kinds: readonly PerpSeriesKind[];
  /** Untere/obere Grenze der **Ereigniszeit** (Epoch-ms, `null` = offen). */
  fromMs: number | null;
  toMs: number | null;
  /**
   * As-of-Zeitpunkt: nur Zeilen mit `event_time <= asOfMs` **und**
   * `available_at <= asOfMs` werden geliefert (Point-in-Time-Garantie).
   */
  asOfMs: number;
  /** Maximale Zeilen je (Instrument, Art). */
  limit: number;
  /** Qualitätsfilter: `strict` verwirft belastete Zeilen. */
  qualityMode: "log" | "strict";
}

/** Klassifizierte Antwort einer as-of-Abfrage je Instrument/Art. */
export interface PerpSeriesResult<K extends PerpSeriesKind = PerpSeriesKind> {
  kind: K;
  venue: string;
  instrumentId: string;
  /** `AVAILABLE` = mindestens eine zulässige Zeile, `MISSING` = keine. */
  availability: "AVAILABLE" | "MISSING" | "STALE" | "UNSUPPORTED" | "UNAVAILABLE";
  /** Stabiler Grund (`OK`, `NO_ROWS`, `STALE_BEYOND_MAX_AGE`, …). */
  reason: string;
  /** Jüngste zulässige Zeile (As-of-Semantik), `null` ohne Treffer. */
  rows: readonly PerpRowByKind[K][];
  /** Alter der jüngsten Zeile in ms, gemessen an `availableAt`/`asOfMs`. */
  ageMs: number | null;
  /** `true` = Ergebnis nach `limit` gekürzt (nie still). */
  truncated: boolean;
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync-Ergebnis und Zähler
// ─────────────────────────────────────────────────────────────────────────────

/** Zähler eines Sync-Laufs je Reihenart. */
export interface PerpKindSyncStats {
  /** Abgerufene Zeilen (vor Dedup/Validierung). */
  fetched: number;
  /** Neu geschriebene Zeilen. */
  written: number;
  /** Abweichende Wiederholungen desselben Schlüssels. */
  duplicates: number;
  /** Von der Validierung abgelehnte Zeilen (mit Befundklassen unten). */
  invalid: number;
  /** Instrumente, deren Abruf übersprungen wurde (Wasserstand bereits aktuell). */
  skippedFresh: number;
  /** Gefundene, aber nicht geschriebene Instrumente wegen `UNSUPPORTED`. */
  unsupported: number;
}

/** Isolierte, nicht-fatale Fehlmeldung eines Laufs (leak-frei). */
export interface PerpSyncFailure {
  stage: "capability" | "fetch" | "normalize" | "quality" | "persist" | "cursor";
  kind: PerpSeriesKind;
  instrumentId?: string;
  /** Klassifizierte Ursache (nie ein Rohtext des Vendors). */
  reason: PerpUnavailableReason | "QUALITY_INVALID" | "ROW_REJECTED" | "ADAPTER_MISSING";
  message: string;
  retryable: boolean;
  httpStatus?: number;
}

/** Ergebnis eines `PerpSyncService.syncVenue()`-Laufs (JSON-serialisierbar). */
export interface PerpSyncResult {
  venue: string;
  mode: PerpSyncMode;
  status: PerpSyncStatus;
  /** Verwendete Verfügbarkeitspolitik (Teil des Idempotenzschlüssels). */
  availabilityPolicy: PerpAvailabilityPolicy;
  startedAt: string;
  finishedAt: string;
  /** Instrumente im Scope (nach Allowlist/Kappung, nur Perpetuals). */
  instruments: number;
  /** Als Spot/Future verworfene Registry-Zeilen (kein Perp-Datenpfad). */
  notPerpetual: number;
  /** Vom Quality-Layer klassifizierte Befunde je Klasse. */
  qualityFindings: Record<"GAP" | "OUTLIER" | "INVALID" | "DUPLICATE" | "CROSSCHECK" | "STALE", number>;
  stats: Record<PerpSeriesKind, PerpKindSyncStats>;
  /** Capability-Antwort je Reihenart (Betriebsperspektive). */
  capabilities: Record<PerpSeriesKind, PerpKindCapability>;
  failures: PerpSyncFailure[];
  /** Requests, die dieser Lauf tatsächlich abgesetzt hat (Rate-Limit-Nachweis). */
  requests: number;
  /** Idempotenzschlüssel des Laufs (`prk1:<sha256>`). */
  idempotencyKey: string;
  /** `true` = Lauf war ein Replay (Schlüssel bereits vorhanden). */
  replayed: boolean;
  /** Manifest-ID des Laufs (`null` bei Dry-Run). */
  runId: string | null;
  /** Persistierte Wasserstände nach dem Lauf (je Instrument/Art). */
  watermarks: {
    instrumentId: string;
    kind: PerpSeriesKind;
    watermarkEventTime: string;
    watermarkAvailableAt: string;
  }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// harte Grenzen (DoS-/Kardinalitätsschutz)
// ─────────────────────────────────────────────────────────────────────────────

/** Bewusst klein gehalten; alle Werte sind Deckel, keine Zielgrößen. */
export const PERP_LIMITS = {
  /** Maximale Instrumente je Sync-Lauf (Vor dem ersten Request gekappt). */
  syncInstruments: 250,
  /** Maximale Instrumente je as-of-Abfrage. */
  queryInstruments: 200,
  /** Maximale Zeilen je Instrument/Art in einer Abfrage. */
  queryRowsPerSeries: 2000,
  /** Maximale Rohzeilen, die eine Abfrage laden darf (Vorfilter). */
  querySourceRows: 20_000,
  /** Maximale Zeilen je Venue-Request (Antwortkappung). */
  rowsPerRequest: 500,
  /** Maximale Requests je (Instrument, Art) und Lauf. */
  requestsPerSeries: 20,
  /** Maximale Zeilen je Persistenz-Chunk (Parameterdeckel). */
  insertChunkRows: 250,
  /** Maximale Zeilen je Sync-Batch. */
  batchRows: 2000,
  /** Maximale Längen (Instrument-ID, Venue, Symbol, Quelle). */
  instrumentIdLength: 64,
  venueLength: 32,
  symbolLength: 40,
  sourceIdLength: 64,
  /** Maximale Einträge im Qualitätsreport je Reihe. */
  findingsPerSeries: 200,
  /** Maximale Laufzeit-Deckel je CLI-Lauf (Batches). */
  maxBatches: 400,
} as const;

/** Formate (ReDoS-sicher, linear). */
export const PERP_VENUE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
export const PERP_INSTRUMENT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}:[A-Z0-9][A-Z0-9._/-]{0,31}$/;
export const PERP_HASH_PATTERN = /^pv1:[0-9a-f]{64}$/;
export const PERP_RUN_KEY_PATTERN = /^prk1:[0-9a-f]{64}$/;
export const PERP_CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{1,6}$/;

/** Prüft eine Venue-Kennung gegen das erlaubte Format. */
export function isPerpVenueKey(value: unknown): value is string {
  return typeof value === "string" && PERP_VENUE_PATTERN.test(value);
}

/** Prüft eine Instrument-ID gegen das erlaubte Format. */
export function isPerpInstrumentId(value: unknown): value is string {
  return typeof value === "string" && PERP_INSTRUMENT_ID_PATTERN.test(value);
}

/** Registry-Zeile, wie sie der Sync für die Instrumentenauflösung braucht. */
export type PerpInstrumentLike = Pick<
  MarketInstrument,
  "id" | "venue" | "symbol" | "marketType" | "quote"
>;

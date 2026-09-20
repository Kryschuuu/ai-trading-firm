/**
 * Normalisierung: Venue-Rohdaten → kanonische Perp-Zeilen (RMA-P2-02).
 *
 * Dies ist die **einzige** Stelle, die Fremdformen versteht. Danach kennen
 * Sync, Persistenz, Abfrage und Consumer nur noch {@link PerpRow} mit
 * deklarierten Einheiten. Regeln:
 *
 * 1. **Kein Raten von Einheiten.** Zahlen werden als exakte Dezimalanteile
 *    erwartet; eine Venue, die Prozent liefert, muss das im Adapter
 *    deklarieren (`fundingRatePct`) — dann rechnet dieser Layer um. Ein
 *    „vielleicht Prozent, vielleicht Anteil“-Heurismus gibt es bewusst nicht.
 * 2. **Kein Raten von Zeitformaten.** Epochen werden in Millisekunden
 *    erwartet; ein Adapter mit Sekunden deklariert `epochUnit: "s"`.
 *    Liegt der Wert außerhalb der plausibleiten Spanne, ist die Zeile
 *    `INVALID` und wird **nicht** geschrieben.
 * 3. **Vorzeichen bleiben erhalten.** Die Funding-Rate ist vorzeichenbehaftet
 *    (positiv = Longs zahlen); eine Umdeutung würde Haltekosten spiegeln.
 * 4. **Grenzen statt Gammeln.** Werte außerhalb der Bounds werden zu
 *    `null` **mit** Grund `OUT_OF_BOUNDS` und Status `INVALID` — die Zeile
 *    bleibt als Befund erhalten, entscheidet aber nichts.
 * 5. **Deterministischer Dedup.** Doppelschlüssel innerhalb eines Batches
 *    gewinnen nach `fetchedAt`, dann `contentHash` — nie nach Array-Reihenfolge
 *    oder Ankunftsrauschen (Restart-/Retry-Pfad muss stabil bleiben).
 * 6. **Inhalt ≠ Quelle.** Der `contentHash` (`pv1:…`) deckt nur die
 *    Fachfelder ab, nie `sourceId`/`fetchedAt`. Dieselbe Rate aus zwei
 *    Endpunkten ist dieselbe Wahrheit, kein Revisionsfall.
 */
import { createHash } from "node:crypto";

import {
  PERP_HASH_PREFIX,
  PERP_SCHEMA_VERSION,
  type PerpAvailabilityPolicy,
  type PerpFundingRow,
  type PerpLiquidationRow,
  type PerpLiquidationSide,
  type PerpMissingReason,
  type PerpOpenInterestBasis,
  type PerpOpenInterestRow,
  type PerpQualityStatus,
  type PerpSeriesKind,
  type RawFundingRow,
  type RawLiquidationRow,
  type RawOpenInterestRow,
} from "./types";

/** Rundung je Feldtyp (Dezimalstellen der `numeric`-Spalten). */
export const PERP_DECIMALS = {
  fundingRate: 10,
  hours: 4,
  price: 8,
  quantity: 8,
  notional: 4,
  contractSize: 12,
} as const;

/** Plausible Zeitfenster (Reject statt raten). */
export const PERP_TIME_BOUNDS = {
  /** 2000-01-01T00:00:00Z — darunter ist ein Millisekunden-Wert nicht plausibel. */
  minMs: Date.UTC(2000, 0, 1),
  /** 1 Tag Fortschritt über „jetzt“ toleriert (Venue-Uhrdrift). */
  maxSkewMs: 86_400_000,
} as const;

/** Kontext, den der Sync je Batch mitgibt (Injektion statt Globalzustand). */
export interface PerpNormalizeContext {
  venue: string;
  /** Kanonische Instrument-ID `VENUE:SYMBOL` (Speicherform). */
  instrumentId: string;
  symbol: string;
  sourceId: string;
  /** Abrufzeit dieses Batches (injizierte Uhr). */
  fetchedAt: Date;
  availabilityPolicy: PerpAvailabilityPolicy;
  /** Bounds aus der Konfiguration (Outlier → `null` mit Grund). */
  maxAbsFundingRate: number;
  /** Deklarierte Epoche der Rohwerte (Default Millisekunden, **kein** Raten). */
  epochUnit?: "ms" | "s";
  /** Harte Kappung der übernommenen Zeilen (Payload-Bombing). */
  limit?: number;
  /**
   * Von der Venue gemeldetes Funding-Intervall in Stunden, wenn der
   * History-Endpunkt es nicht je Satz mitschickt (Intervall-Metadaten des
   * Syncs). `null`/fehlend ⇒ die Zeile trägt kein Intervall (kein Raten).
   */
  defaultIntervalHours?: number | null;
  /** Quote-Währung des Instruments (Registry), wenn die Zeile sie nicht meldet. */
  quoteCurrency?: string | null;
  /** Kontraktgröße des Instruments (für Contracts ↔ Base), `null` = unbekannt. */
  contractSize?: number | null;
}

/** Abgelehnte Rohzeile (Index bleibt stabil für Diagnose und Tests). */
export interface PerpRejectedRow {
  index: number;
  reason:
    | "MISSING_EVENT_TIME"
    | "EVENT_TIME_OUT_OF_RANGE"
    | "NO_MEASURE"
    /** gemeldet, aber fachlich unmöglich (negatives Open Interest) */
    | "INVALID_MEASURE"
    | "TRUNCATED";
  detail?: string;
}

/** Ergebnis einer Normalisierungscharge. */
export interface PerpNormalizeResult<T> {
  rows: T[];
  rejected: PerpRejectedRow[];
  /** `true` = mehr Zeilen erhalten als `limit` (Payload-Kappung). */
  truncated: boolean;
  /** Doppelte Schlüssel innerhalb der Charge (dedupliziert, gezählt). */
  duplicates: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive Helfer (rein, keine Exceptions)
// ─────────────────────────────────────────────────────────────────────────────

/** Zahl aus Venue-Form (`number | numeric string`) — sonst `null`. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > 40) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Nicht-negative Zahl (OI, Mengen, Preise) — sonst `null`. */
function toNonNegative(value: unknown, { allowZero = true }: { allowZero?: boolean } = {}): number | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n < 0) return null;
  if (!allowZero && n === 0) return null;
  return n;
}

/** Epoche in ms, mit deklarierter Einheit. `null` = unbrauchbar. */
export function toEpochMs(
  value: unknown,
  unit: "ms" | "s" = "ms",
  nowMs: number = Date.now()
): number | null {
  const raw = toFiniteNumber(value);
  if (raw === null) return null;
  const ms = unit === "s" ? Math.round(raw * 1000) : Math.round(raw);
  if (!Number.isInteger(ms)) return null;
  if (ms < PERP_TIME_BOUNDS.minMs) return null;
  if (ms > nowMs + PERP_TIME_BOUNDS.maxSkewMs) return null;
  return ms;
}

/** Rundung auf feste Dezimalstellen (stabile Hashes, keine Float-Rests). */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** `availableAt` aus Politik (siehe Modulkopf von `./types.ts`). */
export function computeAvailableAt(
  eventTimeMs: number,
  fetchedAt: Date,
  policy: PerpAvailabilityPolicy
): Date {
  if (policy === "settlement") return new Date(eventTimeMs);
  return new Date(Math.max(eventTimeMs, fetchedAt.getTime()));
}

/** Kanonische Serialisierung für Hashes (sortierte Schlüssel, feste Rundung). */
function canonicalString(parts: Record<string, string | number | boolean | null>): string {
  return Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key] ?? ""}`)
    .join(";");
}

/** `pv1:<sha256>` über die Fachfelder einer Zeile. */
export function perpContentHash(parts: Record<string, string | number | boolean | null>): string {
  const digest = createHash("sha256").update(canonicalString(parts), "utf8").digest("hex");
  return `${PERP_HASH_PREFIX}:${digest}`;
}

/** Deterministischer Ereignis-Identifikator, wenn die Venue keinen mitschickt. */
export function deriveSourceEventId(parts: Record<string, string | number | boolean | null>): string {
  const digest = createHash("sha256").update(canonicalString(parts), "utf8").digest("hex");
  return `h1:${digest.slice(0, 32)}`;
}

/** Sanfte Bereinigung einer venue-seitigen ID (kein Rohtext in Pfad/Label). */
export function sanitizeEventId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return `v${Math.trunc(raw)}`;
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9:._-]/g, "")
    .slice(0, 64);
  return cleaned === "" ? null : cleaned;
}

/** Währungscodes strikt (kein Fremdtext in einer `text`-Spalte). */
function sanitizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{1,6}$/.test(value) ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rohe Funding-Zeile → kanonische Zeile.
 *
 * Die Rate kommt als Dezimalanteil (`fundingRate`) **oder** Prozent
 * (`fundingRatePct`, Umrechnung `/100`). Beides gleichzeitig ist ein
 * Adapterfehler (⇒ `null` mit `SOURCE_ERROR`), eines von beiden ist Pflicht.
 * Außerhalb der Bounds wird die Rate verworfen, die Zeile bleibt als Befund.
 */
export function normalizeFundingRow(
  raw: RawFundingRow,
  index: number,
  ctx: PerpNormalizeContext
): { row?: PerpFundingRow; rejected?: PerpRejectedRow } {
  // Zukunftsschranke gegen den Abrufzeitpunkt des Batches (injizierte Uhr),
  // nicht gegen die Wanduhr: eine replayte Historie mit `fetchedAt` in der
  // Vergangenheit darf keine Zeilen als „zu weit in der Zukunft“ verwerfen.
  const nowMs =
    ctx.fetchedAt instanceof Date && Number.isFinite(ctx.fetchedAt.getTime())
      ? ctx.fetchedAt.getTime()
      : Date.now();
  const eventMs = toEpochMs(raw?.eventTime ?? null, ctx.epochUnit ?? "ms", nowMs);
  if (eventMs === null) {
    return {
      rejected: {
        index,
        reason:
          raw?.eventTime === null || raw?.eventTime === undefined
            ? "MISSING_EVENT_TIME"
            : "EVENT_TIME_OUT_OF_RANGE",
      },
    };
  }

  let rate: number | null = null;
  let missingReason: PerpMissingReason | null = null;
  const hasFraction = raw.fundingRate !== null && raw.fundingRate !== undefined;
  const hasPercent = raw.fundingRatePct !== null && raw.fundingRatePct !== undefined;
  let quality: PerpQualityStatus = "OK";
  if (hasFraction && hasPercent) {
    // Zwei Einheiten für dieselbe Größe = unauflösbar; eher `null` als raten.
    missingReason = "SOURCE_ERROR";
    quality = "INVALID";
  } else if (hasFraction) {
    rate = toFiniteNumber(raw.fundingRate);
  } else if (hasPercent) {
    const pct = toFiniteNumber(raw.fundingRatePct);
    rate = pct === null ? null : pct / 100;
  } else {
    missingReason = "NOT_REPORTED";
    quality = "UNKNOWN";
  }
  if (rate !== null && Math.abs(rate) > ctx.maxAbsFundingRate) {
    rate = null;
    missingReason = "OUT_OF_BOUNDS";
    quality = "INVALID";
  }
  if (rate !== null) rate = roundTo(rate, PERP_DECIMALS.fundingRate);

  const intervalHoursRaw =
    toFiniteNumber(raw.intervalHours) ?? toFiniteNumber(ctx.defaultIntervalHours ?? null);
  const intervalHours =
    intervalHoursRaw !== null && intervalHoursRaw > 0 && intervalHoursRaw <= 24
      ? roundTo(intervalHoursRaw, PERP_DECIMALS.hours)
      : null;
  const markPrice = toNonNegative(raw.markPrice, { allowZero: false });
  const nextMs = toEpochMs(raw.nextFundingTime ?? null, ctx.epochUnit ?? "ms", nowMs);

  const contentHash = perpContentHash({
    kind: "funding",
    instrumentId: ctx.instrumentId,
    eventTime: new Date(eventMs).toISOString(),
    rate,
    intervalHours,
    markPrice: markPrice === null ? null : roundTo(markPrice, PERP_DECIMALS.price),
    schemaVersion: PERP_SCHEMA_VERSION,
  });

  return {
    row: {
      kind: "funding",
      venue: ctx.venue,
      instrumentId: ctx.instrumentId,
      symbol: ctx.symbol,
      sourceId: ctx.sourceId,
      schemaVersion: PERP_SCHEMA_VERSION,
      eventTime: new Date(eventMs),
      availableAt: computeAvailableAt(eventMs, ctx.fetchedAt, ctx.availabilityPolicy),
      fetchedAt: ctx.fetchedAt,
      fundingRate: rate,
      intervalHours,
      nextFundingTime: nextMs === null ? null : new Date(nextMs),
      markPrice: markPrice === null ? null : roundTo(markPrice, PERP_DECIMALS.price),
      unit: "fraction_per_interval",
      qualityStatus: quality,
      missingReason,
      contentHash,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Open Interest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rohe OI-Zeile → kanonische Zeile mit **expliziter** Einheit.
 *
 * Autoritativ ist `basis` (Angabe des Adapters, sonst die einzige gefüllte
 * Größe). Alle weiteren Felder werden nur abgeleitet, wenn die Umrechnung
 * vollständig bekannt ist (Contracts ↔ Base braucht `contractSize`, Base →
 * Quote braucht `markPrice`) — dann mit `converted: true`. Negative OI ist
 * fachlich unmöglich ⇒ `INVALID` mit Wert `null` (nie still auf 0 gesetzt).
 */
export function normalizeOpenInterestRow(
  raw: RawOpenInterestRow,
  index: number,
  ctx: PerpNormalizeContext
): { row?: PerpOpenInterestRow; rejected?: PerpRejectedRow } {
  // Zukunftsschranke gegen den Abrufzeitpunkt des Batches (injizierte Uhr),
  // nicht gegen die Wanduhr: eine replayte Historie mit `fetchedAt` in der
  // Vergangenheit darf keine Zeilen als „zu weit in der Zukunft“ verwerfen.
  const nowMs =
    ctx.fetchedAt instanceof Date && Number.isFinite(ctx.fetchedAt.getTime())
      ? ctx.fetchedAt.getTime()
      : Date.now();
  const eventMs = toEpochMs(raw?.eventTime ?? null, ctx.epochUnit ?? "ms", nowMs);
  if (eventMs === null) {
    return {
      rejected: {
        index,
        reason:
          raw?.eventTime === null || raw?.eventTime === undefined
            ? "MISSING_EVENT_TIME"
            : "EVENT_TIME_OUT_OF_RANGE",
      },
    };
  }

  const reported = {
    contracts: toFiniteNumber(raw.contracts ?? null),
    baseQuantity: toFiniteNumber(raw.baseQuantity ?? null),
    quoteValue: toFiniteNumber(raw.quoteValue ?? null),
  };
  const negative = Object.values(reported).some((v) => v !== null && v < 0);
  const filled = (["contracts", "baseQuantity", "quoteValue"] as const).filter(
    (key) => reported[key] !== null && reported[key]! > 0
  );
  if (filled.length === 0) {
    // Nur unplausible Werte gemeldet: keine Zeile (die Ablage verlangt den
    // Basismeßwert nicht-null), aber ein *qualifizierter* Abweis — „die Venue
    // hat Unsinn gemeldet“ ist ein anderer Zustand als „sie hat nichts
    // gemeldet“, und nur der erste darf in `strict` die Reihe blockieren.
    return {
      rejected: negative
        ? { index, reason: "INVALID_MEASURE", detail: "Open Interest negativ (fachlich unmöglich)" }
        : { index, reason: "NO_MEASURE" },
    };
  }

  let basis: PerpOpenInterestBasis;
  const declaredBasis = raw.basis ?? null;
  if (declaredBasis === null) {
    basis = filled.length === 1 ? fieldToBasis(filled[0]) : "contracts";
  } else if (!filled.includes(basisToField(declaredBasis))) {
    // Deklarierte Einheit fehlt/widerspricht ⇒ Autorität nicht bestimmbar.
    basis = filled.length === 1 ? fieldToBasis(filled[0]) : "contracts";
  } else {
    basis = declaredBasis;
  }

  const contractSizeRaw = toFiniteNumber(raw.contractSize ?? ctx.contractSize ?? null);
  const contractSize =
    contractSizeRaw !== null && contractSizeRaw > 0
      ? roundTo(contractSizeRaw, PERP_DECIMALS.contractSize)
      : null;
  const markPriceRaw = toNonNegative(raw.markPrice, { allowZero: false });
  const markPrice = markPriceRaw === null ? null : roundTo(markPriceRaw, PERP_DECIMALS.price);
  const quoteCurrency =
    sanitizeCurrency(raw.quoteCurrency ?? ctx.quoteCurrency ?? null) ?? null;

  // Nur der unplausible Wert verschwindet, die übrigen bleiben benutzbar —
  // sonst vernichtet ein einzelner Ausreißer eine sonst saubere Zeile.
  let contracts = reported.contracts !== null && reported.contracts < 0 ? null : reported.contracts;
  let baseQuantity = reported.baseQuantity !== null && reported.baseQuantity < 0 ? null : reported.baseQuantity;
  let quoteValue = reported.quoteValue !== null && reported.quoteValue < 0 ? null : reported.quoteValue;
  let converted = false;
  const baseFromContracts =
    baseQuantity === null && contracts !== null && contractSize !== null
      ? contracts * contractSize
      : null;
  const contractsFromBase =
    contracts === null && baseQuantity !== null && contractSize !== null
      ? baseQuantity / contractSize
      : null;
  const quoteFromBase =
    quoteValue === null && baseQuantity !== null && markPrice !== null
      ? baseQuantity * markPrice
      : baseQuantity === null && contracts !== null && contractSize !== null && markPrice !== null
        ? contracts * contractSize * markPrice
        : null;
  if (baseFromContracts !== null) {
    baseQuantity = roundTo(baseFromContracts, PERP_DECIMALS.quantity);
    converted = true;
  }
  if (contractsFromBase !== null) {
    contracts = roundTo(contractsFromBase, PERP_DECIMALS.quantity);
    converted = true;
  }
  if (quoteFromBase !== null && quoteValue === null) {
    quoteValue = roundTo(quoteFromBase, PERP_DECIMALS.notional);
    converted = true;
  }
  if (quoteValue !== null && quoteCurrency === null) {
    // Ein Quote-Wert ohne Währungscode ist nicht interpretierbar ⇒ raus.
    quoteValue = null;
  }
  if (contracts === null && baseQuantity === null && quoteValue === null) {
    // Nichts Zählbares übrig (negativ, oder — wie ein Quote-Wert ohne
    // Währungscode — nicht interpretierbar). Eine Open-Interest-Zeile ohne
    // Messwert kann die Ablage nicht erreichen: `basis` ist NOT NULL und per
    // CHECK an den zugehörigen Wert gebunden. Also qualifizierter Abweis hier,
    // nicht erst ein Store-Fehler — „kein Wert“, nie „0“.
    return {
      rejected: {
        index,
        reason: negative ? "INVALID_MEASURE" : "NO_MEASURE",
        detail: negative
          ? "Open Interest negativ (fachlich unmöglich)"
          : "kein interpretierbarer Messwert (Einheit/Währung fehlt)",
      },
    };
  }

  const contentHash = perpContentHash({
    kind: "openInterest",
    instrumentId: ctx.instrumentId,
    eventTime: new Date(eventMs).toISOString(),
    contracts,
    baseQuantity,
    quoteValue,
    basis,
    quoteCurrency,
    schemaVersion: PERP_SCHEMA_VERSION,
  });

  return {
    row: {
      kind: "openInterest",
      venue: ctx.venue,
      instrumentId: ctx.instrumentId,
      symbol: ctx.symbol,
      sourceId: ctx.sourceId,
      schemaVersion: PERP_SCHEMA_VERSION,
      eventTime: new Date(eventMs),
      availableAt: computeAvailableAt(eventMs, ctx.fetchedAt, ctx.availabilityPolicy),
      fetchedAt: ctx.fetchedAt,
      contracts,
      baseQuantity,
      quoteValue,
      basis,
      contractSize,
      quoteCurrency,
      markPrice,
      converted,
      unit: basis,
      // `INVALID` bei einem aktiv negativen Wert (Datenquality-Alarm), auch wenn
      // die übrigen Messgrößen erhalten bleiben — der Befund bleibt sichtbar,
      // die Zeile ist aber belegbar genug für die Ablage (`log`) und wird von
      // Konsumenten dank `perpRowIsAttestable` trotzdem nicht benutzt.
      qualityStatus: negative ? "INVALID" : "OK",
      missingReason: null,
      contentHash,
    },
  };
}

function fieldToBasis(field: "contracts" | "baseQuantity" | "quoteValue"): PerpOpenInterestBasis {
  if (field === "contracts") return "contracts";
  if (field === "baseQuantity") return "base_units";
  return "quote_units";
}

function basisToField(basis: PerpOpenInterestBasis): "contracts" | "baseQuantity" | "quoteValue" {
  if (basis === "contracts") return "contracts";
  if (basis === "base_units") return "baseQuantity";
  return "quoteValue";
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidationen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rohe Liquidationszeile → kanonisches Ereignis.
 *
 * Die Seite wird **auf die betroffene Position** umgebogen: `sideIsPosition`
 * `true` ⇒ Long/Short sind bereits Positionsseiten; sonst ist `side` die
 * Order-Richtung des Zwangsverkaufs (SELL ⇒ Long wurde liquidiert). Ohne eine
 * bestimmbare Richtung ist die Zeile `INVALID` (Richtung raten wäre eine
 * Fehlinformation über die Marktseite).
 */
export function normalizeLiquidationRow(
  raw: RawLiquidationRow,
  index: number,
  ctx: PerpNormalizeContext
): { row?: PerpLiquidationRow; rejected?: PerpRejectedRow } {
  // Zukunftsschranke gegen den Abrufzeitpunkt des Batches (injizierte Uhr),
  // nicht gegen die Wanduhr: eine replayte Historie mit `fetchedAt` in der
  // Vergangenheit darf keine Zeilen als „zu weit in der Zukunft“ verwerfen.
  const nowMs =
    ctx.fetchedAt instanceof Date && Number.isFinite(ctx.fetchedAt.getTime())
      ? ctx.fetchedAt.getTime()
      : Date.now();
  const eventMs = toEpochMs(raw?.eventTime ?? null, ctx.epochUnit ?? "ms", nowMs);
  if (eventMs === null) {
    return {
      rejected: {
        index,
        reason:
          raw?.eventTime === null || raw?.eventTime === undefined
            ? "MISSING_EVENT_TIME"
            : "EVENT_TIME_OUT_OF_RANGE",
      },
    };
  }

  let side: PerpLiquidationSide | null = null;
  const rawSide = typeof raw.side === "string" ? raw.side.trim().toUpperCase() : "";
  if (raw.side === "LONG_LIQUIDATED" || raw.side === "SHORT_LIQUIDATED") {
    side = raw.side;
  } else if (raw.sideIsPosition === true) {
    if (rawSide === "LONG" || rawSide === "BUY") side = "LONG_LIQUIDATED";
    else if (rawSide === "SHORT" || rawSide === "SELL") side = "SHORT_LIQUIDATED";
  } else if (rawSide === "SELL") {
    side = "LONG_LIQUIDATED";
  } else if (rawSide === "BUY") {
    side = "SHORT_LIQUIDATED";
  } else if (rawSide === "LONG") {
    side = "LONG_LIQUIDATED";
  } else if (rawSide === "SHORT") {
    side = "SHORT_LIQUIDATED";
  }

  const quantityBase = toNonNegative(raw.quantityBase ?? null);
  const price = toNonNegative(raw.price ?? null, { allowZero: false });
  const notionalRaw = toNonNegative(raw.notionalQuote ?? null);
  const quoteCurrency =
    sanitizeCurrency(raw.quoteCurrency ?? ctx.quoteCurrency ?? null) ?? null;
  const aggregateCountRaw = toFiniteNumber(raw.aggregateCount ?? null);
  const aggregateCount =
    aggregateCountRaw !== null && aggregateCountRaw >= 1
      ? Math.trunc(aggregateCountRaw)
      : null;
  if (side === null || (quantityBase === null && notionalRaw === null)) {
    return { rejected: { index, reason: "NO_MEASURE" } };
  }

  // Notional: gemellter Wert gewinnt; sonst Qty × Preis (dokumentierte
  // Ableitung). Ohne Preis **und** ohne Notional bleibt er `null` — 0 wäre
  // eine erfundene Größe.
  let notionalQuote: number | null = null;
  let derivedNotional = false;
  if (notionalRaw !== null && notionalRaw > 0) {
    notionalQuote = roundTo(notionalRaw, PERP_DECIMALS.notional);
  } else if (quantityBase !== null && price !== null) {
    notionalQuote = roundTo(quantityBase * price, PERP_DECIMALS.notional);
    derivedNotional = true;
  }

  const sourceEventId =
    sanitizeEventId(raw.sourceEventId ?? null) ??
    deriveSourceEventId({
      instrumentId: ctx.instrumentId,
      eventTime: new Date(eventMs).toISOString(),
      side,
      qty: quantityBase,
      price,
      notional: notionalQuote,
    });

  const contentHash = perpContentHash({
    kind: "liquidations",
    instrumentId: ctx.instrumentId,
    eventTime: new Date(eventMs).toISOString(),
    side,
    quantityBase: quantityBase === null ? null : roundTo(quantityBase, PERP_DECIMALS.quantity),
    price: price === null ? null : roundTo(price, PERP_DECIMALS.price),
    notionalQuote,
    aggregateCount,
    // Die Quell-ID gehört in den Inhalt: zwei Liquidationen derselben Sekunde
    // sind zwei Ereignisse (natürlicher Schlüssel enthält sie), keine Duplikate.
    sourceEventId: raw.sourceEventId === null || raw.sourceEventId === undefined ? null : String(raw.sourceEventId),
    schemaVersion: PERP_SCHEMA_VERSION,
  });

  return {
    row: {
      kind: "liquidations",
      venue: ctx.venue,
      instrumentId: ctx.instrumentId,
      symbol: ctx.symbol,
      sourceId: ctx.sourceId,
      schemaVersion: PERP_SCHEMA_VERSION,
      eventTime: new Date(eventMs),
      availableAt: computeAvailableAt(eventMs, ctx.fetchedAt, ctx.availabilityPolicy),
      fetchedAt: ctx.fetchedAt,
      side,
      quantityBase: quantityBase === null ? null : roundTo(quantityBase, PERP_DECIMALS.quantity),
      price: price === null ? null : roundTo(price, PERP_DECIMALS.price),
      notionalQuote,
      quoteCurrency: notionalQuote === null ? null : quoteCurrency,
      sourceEventId,
      aggregateCount,
      unit: "base_units",
      qualityStatus: "OK",
      missingReason: derivedNotional ? null : notionalQuote === null ? "NOT_REPORTED" : null,
      contentHash,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Charge (Batch) — Kappung, Dedup, Ablehnungsprotokoll
// ─────────────────────────────────────────────────────────────────────────────

/** Strukturminimum für den Schlüssel (identisch zu den UNIQUE-Indices). */
export interface PerpKeyParts {
  kind: PerpSeriesKind;
  venue: string;
  instrumentId: string;
  eventTime: Date;
  sourceEventId?: string;
}

/** Natürlicher Schlüssel einer Zeile. */
export function perpRowKey(row: PerpKeyParts): string {
  if (row.kind === "liquidations") {
    return `${row.venue}|${row.instrumentId}|${row.eventTime.toISOString()}|${row.sourceEventId}`;
  }
  return `${row.venue}|${row.instrumentId}|${row.eventTime.toISOString()}`;
}

/**
 * Wendet einen Normalisierer auf eine Charge an: Kappung auf `limit`, Dedup
 * über den natürlichen Schlüssel (jüngstes `fetchedAt`, dann größerer
 * `contentHash`), Ablehnungen mit Index.
 */
export function normalizeBatch<R, T extends { fetchedAt: Date; contentHash: string }>(
  rawRows: readonly R[],
  mapOne: (raw: R, index: number) => { row?: T; rejected?: PerpRejectedRow },
  options: { limit?: number } = {}
): PerpNormalizeResult<T> {
  const rejected: PerpRejectedRow[] = [];
  const clamped = clampBatch(rawRows, options.limit);
  const truncated = clamped.truncated;
  if (truncated) {
    for (let index = clamped.rows.length; index < rawRows.length; index += 1) {
      rejected.push({ index, reason: "TRUNCATED" });
    }
  }
  const byKey = new Map<string, T>();
  let duplicates = 0;
  clamped.rows.forEach((raw, index) => {
    const out = mapOne(raw as never, index);
    if (out.rejected) {
      rejected.push(out.rejected);
      return;
    }
    if (!out.row) return;
    const key = perpRowKey(out.row as unknown as PerpKeyParts);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, out.row);
      return;
    }
    duplicates += 1;
    const newer =
      out.row.fetchedAt.getTime() > existing.fetchedAt.getTime()
        ? out.row
        : out.row.fetchedAt.getTime() === existing.fetchedAt.getTime() &&
            out.row.contentHash > existing.contentHash
          ? out.row
          : existing;
    byKey.set(key, newer);
  });
  return { rows: [...byKey.values()], rejected, truncated, duplicates };
}

/** Kappt eine Charge hart und zählt die Verwerfungen (Payload-Bombing). */
export function clampBatch<T>(rows: readonly T[], limit: number | undefined): { rows: T[]; truncated: boolean } {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return { rows: [...rows], truncated: false };
  if (rows.length <= limit) return { rows: [...rows], truncated: false };
  return { rows: rows.slice(0, limit), truncated: true };
}

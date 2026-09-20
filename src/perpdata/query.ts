/**
 * as-of-Abfrage über die Perp-Reihen (RMA-P2-02) — der **einzige** Lesepfad.
 *
 * ── Point-in-Time-Garantie ─────────────────────────────────────────────────
 * Eine Zeile wird geliefert, wenn
 *
 *     event_time   <= as_of   AND
 *     available_at <= as_of
 *
 * gilt. Die Bedingung liegt in SQL (Store) **und** wird hier defensiv
 * nachgeprüft: eine Backtest-Abfrage auf `asOf = 2026-01-01T00:00Z` kann
 * keinen Satz sehen, den die Venue erst am 2026-01-03 veröffentlicht hat —
 * auch dann nicht, wenn die Zeile längst in der Tabelle steht. Look-ahead ist
 * damit keine Konvention, sondern nicht darstellbar.
 *
 * ── `MISSING` ist kein `0` ──────────────────────────────────────────────────
 * Jede Reihe endet in einer klassifizierten Verfügbarkeit:
 *
 *   AVAILABLE     zulässige Zeile(n) vorhanden
 *   MISSING       Bestand vorhanden, aber kein Satz im Fenster/as-of
 *   STALE         jüngster Satz älter als die Staleness-Grenze der Reihe
 *   UNSUPPORTED   die Venue liefert diese Reihe grundsätzlich nicht
 *   UNAVAILABLE   Ablage/Quelle nicht erreichbar (transient) — **kein** MISSING
 *
 * Ein Consumer, der `MISSING` mit `0` gleichsetzt, verliert diese
 * Unterscheidung; der Typ zwingt ihn, `availability` und `reason` zu lesen.
 *
 * ── Grenzen ────────────────────────────────────────────────────────────────
 * Instrumente ≤ `PERP_LIMITS.queryInstruments`, Zeilen je Reihe
 * ≤ `PERP_LIMITS.queryRowsPerSeries`; Überschuß wird gekürzt und **gemeldet**
 * (`truncated: true`), nie still.
 */
import { metricLabel, telemetry } from "../lib/telemetry";
import type { PerpConfig } from "./config";
import { perpRedactMessage, PerpQueryError } from "./errors";
import {
  PERP_INSTRUMENT_ID_PATTERN,
  PERP_LIMITS,
  type PerpKindCapability,
  type PerpRowByKind,
  type PerpSeriesKind,
  type PerpSeriesQuery,
  type PerpSeriesResult,
  type PerpVenueCapabilities,
} from "./types";
import type { PerpSeriesSource } from "./ports";

export const PERP_QUERY_DEFAULTS = {
  /** Zeilen je (Instrument, Reihe) in einer Antwort. */
  limit: 500,
} as const;

/** Gründe der Verfügbarkeit (stabil, API-vertraglich). */
export const PERP_QUERY_REASONS = {
  OK: "OK",
  NO_ROWS: "NO_ROWS",
  OUTSIDE_WINDOW: "OUTSIDE_REQUESTED_WINDOW",
  ALL_ROWS_INVALID: "ALL_ROWS_REJECTED_BY_QUALITY",
  STALE_BEYOND_MAX_AGE: "STALE_BEYOND_MAX_AGE",
  UNSUPPORTED: "VENUE_DOES_NOT_PUBLISH_SERIES",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
  TRUNCATED_BY_LIMIT: "TRUNCATED_BY_LIMIT",
} as const;

/** Anfrage an die as-of-Abfrage (roh, vom Caller/API/CLI). */
export interface PerpAsOfRequest {
  /** Venue-Filter (optional). */
  venue?: string | null;
  /** Instrument-IDs in kanonischer Speicherform (`BITUNIX:BTCUSDT`). */
  instruments: readonly string[];
  /** Reihenarten (Default: alle drei). */
  kinds?: readonly PerpSeriesKind[];
  /** Fenster über die **Ereigniszeit** (Epoch-ms, `null` = offen). */
  fromMs?: number | null;
  toMs?: number | null;
  /** As-of-Zeitpunkt (Epoch-ms); Default `nowMs`. */
  asOfMs?: number | null;
  /** Zeilen je Reihe (Default 500, hart bei `PERP_LIMITS.queryRowsPerSeries`). */
  limit?: number | null;
}

/** Antwort der as-of-Abfrage. */
export interface PerpAsOfResponse {
  /** Verwendeter As-of-Zeitpunkt (ISO). */
  asOf: string;
  /** Verwendete Verfügbarkeitsregel je Reihe (für UI/Debug). */
  maxStaleMs: Record<PerpSeriesKind, number>;
  qualityMode: "log" | "strict";
  series: PerpSeriesResult[];
  /** Kurz-Zähler je Verfügbarkeit (begrenzte Labels). */
  counts: Record<string, number>;
}

/** Nur-Zeilenfilter (nachträglich, defensive Tiefe zum SQL-Filter). */
export function filterRowsAsOf<T extends { eventTime: Date; availableAt: Date }>(
  rows: readonly T[],
  asOfMs: number
): T[] {
  return rows.filter((row) => row.eventTime.getTime() <= asOfMs && row.availableAt.getTime() <= asOfMs);
}

/**
 * Validierung und Normalisierung der Anfrage (harte Grenzen statt
 * Still-Kappung, wo die Anfrage selbst schon fehlerhaft ist).
 */
export function validateAsOfRequest(
  request: PerpAsOfRequest,
  config: PerpConfig,
  nowMs: number
): PerpSeriesQuery {
  const instruments = [...new Set(request.instruments.map((value) => value.trim().toUpperCase()))].filter(Boolean);
  if (instruments.length === 0) {
    throw new PerpQueryError("query:instruments_required", "mindestens eine Instrument-ID (VENUE:SYMBOL) erforderlich.");
  }
  if (instruments.length > PERP_LIMITS.queryInstruments) {
    throw new PerpQueryError(
      "query:too_many_instruments",
      `maximal ${PERP_LIMITS.queryInstruments} Instrumente je Abfrage (erhalten: ${instruments.length}).`,
      { instruments: instruments.length }
    );
  }
  for (const id of instruments) {
    if (!PERP_INSTRUMENT_ID_PATTERN.test(id)) {
      // `VENUE:SYMBOL` ist Speicherform und Log-Schlüssel zugleich: ein Wert
      // wie `SIM/../etc/passwd` würde in Manifesten und Artefakten mitlaufen.
      // Hier wird er verworfen, nicht maskiert.
      // Der Echo-Wert geht in Log und API-Body — deshalb redigiert
      // (Steuerzeichen/Umbrüche raus, Länge hart), nie die rohe Eingabe.
      const echo = perpRedactMessage(id, 48);
      throw new PerpQueryError("query:invalid_instrument", `Instrument-ID "${echo}" verletzt das Format VENUE:SYMBOL.`, {
        instrumentId: echo,
      });
    }
    if (id.length > PERP_LIMITS.instrumentIdLength) {
      throw new PerpQueryError("query:instrument_too_long", `Instrument-ID zu lang (${id.length}).`, {
        length: id.length,
      });
    }
  }
  const kinds = (request.kinds && request.kinds.length > 0 ? request.kinds : PERP_SERIES_KINDS_ALL).filter((kind) =>
    PERP_SERIES_KINDS_ALL.includes(kind)
  ) as PerpSeriesKind[];
  if (kinds.length === 0) {
    throw new PerpQueryError("query:kinds_required", "keine gültige Reihenart angegeben.");
  }
  const asOfMs = Number.isFinite(request.asOfMs ?? NaN) ? Math.floor(request.asOfMs as number) : Math.floor(nowMs);
  const fromMs = Number.isFinite(request.fromMs ?? NaN) ? Math.floor(request.fromMs as number) : null;
  const toMs = Number.isFinite(request.toMs ?? NaN) ? Math.floor(request.toMs as number) : null;
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new PerpQueryError("query:window_inverted", "from liegt nach to.", { fromMs, toMs });
  }
  if (asOfMs > nowMs + 60_000) {
    throw new PerpQueryError("query:asof_in_future", "as_of darf nicht in der Zukunft liegen.", {
      asOfMs,
      nowMs: Math.floor(nowMs),
    });
  }
  const requestedLimit = Number.isFinite(request.limit ?? NaN) ? Math.floor(request.limit as number) : PERP_QUERY_DEFAULTS.limit;
  if (requestedLimit < 1) {
    throw new PerpQueryError("query:limit_invalid", "limit muss >= 1 sein.", { limit: request.limit ?? null });
  }
  return {
    venue: request.venue ? request.venue.trim().toUpperCase() : null,
    instrumentIds: instruments,
    kinds,
    fromMs,
    toMs,
    asOfMs,
    limit: Math.min(requestedLimit, PERP_LIMITS.queryRowsPerSeries),
    qualityMode: config.qualityMode,
  };
}

const PERP_SERIES_KINDS_ALL: readonly PerpSeriesKind[] = ["funding", "openInterest", "liquidations"];

/** Jüngste Zeile einer Reihe (as-of-sortiert). */
function newest<T extends { eventTime: Date }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || row.eventTime.getTime() > best.eventTime.getTime()) best = row;
  }
  return best;
}

/** Capability-Zustand einer (Venue, Reihe) — `null` = unbekannt ⇒ nicht unsupported. */
function capabilityOf(
  capabilities: PerpVenueCapabilities | null,
  venue: string,
  kind: PerpSeriesKind
): PerpKindCapability | null {
  if (capabilities === null || capabilities.venue !== venue) return null;
  return capabilities[kind] ?? null;
}

/**
 * Liest die Reihen und klassifiziert sie. `source` ist der Store oder — in
 * Tests und Dry-Runs — eine Speicher-Ablage mit identischem Vertrag.
 */
export async function queryPerpSeries(
  source: PerpSeriesSource,
  request: PerpAsOfRequest,
  options: {
    config: PerpConfig;
    nowMs: number;
    /** Capability-Antwort der Venue (für `UNSUPPORTED`-Treffer), optional. */
    capabilitiesFor?: (venue: string) => PerpVenueCapabilities | null;
  }
): Promise<PerpAsOfResponse> {
  const query = validateAsOfRequest(request, options.config, options.nowMs);
  const read = async (kind: PerpSeriesKind) => {
    if (kind === "funding") return source.readFunding(query);
    if (kind === "openInterest") return source.readOpenInterest(query);
    return source.readLiquidations(query);
  };

  type StoredRow = PerpRowByKind[PerpSeriesKind];
  const rowsByKind = new Map<PerpSeriesKind, readonly StoredRow[]>();
  try {
    const [funding, openInterest, liquidations] = await Promise.all([
      query.kinds.includes("funding") ? read("funding") : Promise.resolve([]),
      query.kinds.includes("openInterest") ? read("openInterest") : Promise.resolve([]),
      query.kinds.includes("liquidations") ? read("liquidations") : Promise.resolve([]),
    ]);
    rowsByKind.set("funding", funding as readonly StoredRow[]);
    rowsByKind.set("openInterest", openInterest as readonly StoredRow[]);
    rowsByKind.set("liquidations", liquidations as readonly StoredRow[]);
  } catch (error) {
    if (error instanceof PerpQueryError) throw error;
    const code = (error as { code?: unknown }).code;
    telemetry.perp.asOfQueries.inc({ result: "unavailable", kind: "total" });
    throw new PerpQueryError(
      "query:store_unavailable",
      `Ablage nicht erreichbar — die Antwort ist UNAVAILABLE, nicht leer. ${(String((error as Error).message ?? error)).slice(0, 160)}`,
      { code: typeof code === "string" ? code : "UNKNOWN" }
    );
  }

  const series: PerpSeriesResult[] = [];
  const counts: Record<string, number> = {};
  for (const instrumentId of query.instrumentIds) {
    const venue = instrumentId.includes(":") ? instrumentId.slice(0, instrumentId.indexOf(":")) : (query.venue ?? "");
    for (const kind of query.kinds) {
      const capability = capabilityOf(options.capabilitiesFor?.(venue) ?? null, venue, kind);
      const all: readonly StoredRow[] = rowsByKind.get(kind) ?? [];
      const scoped = all.filter((row) => row.instrumentId === instrumentId);
      const inWindow =
        query.fromMs === null && query.toMs === null
          ? scoped
          : scoped.filter((row) => {
              const ms = row.eventTime.getTime();
              if (query.fromMs !== null && ms < query.fromMs) return false;
              if (query.toMs !== null && ms > query.toMs) return false;
              return true;
            });
      // Defensive Tiefe: der Store filtert bereits in SQL.
      const asOfSafe = filterRowsAsOf(inWindow, query.asOfMs);
      const usable =
        query.qualityMode === "strict"
          ? asOfSafe.filter((row) => row.qualityStatus === "OK")
          : asOfSafe;
      const truncated = usable.length > query.limit;
      const ordered = usable
        .slice()
        .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
        .slice(Math.max(0, usable.length - query.limit));

      let availability: PerpSeriesResult["availability"];
      let reason: string;
      const latest = newest(ordered);
      // Frische = Alter des jüngsten Ereignisses (Verfügbarkeit ist die as-of-
      // Grenze, nicht das Alter: unter `ingested` wäre alles „gerade frisch“).
      const ageMs = latest === null ? null : Math.max(0, query.asOfMs - latest.eventTime.getTime());
      const maxStale = options.config.maxStaleMs[kind];
      if (capability && !capability.supported) {
        availability = "UNSUPPORTED";
        reason = PERP_QUERY_REASONS.UNSUPPORTED;
      } else if (ordered.length === 0) {
        availability = "MISSING";
        reason =
          asOfSafe.length > 0
            ? PERP_QUERY_REASONS.ALL_ROWS_INVALID
            : inWindow.length > 0
              ? PERP_QUERY_REASONS.OUTSIDE_WINDOW
              : PERP_QUERY_REASONS.NO_ROWS;
      } else if (ageMs !== null && ageMs > maxStale) {
        availability = "STALE";
        reason = PERP_QUERY_REASONS.STALE_BEYOND_MAX_AGE;
      } else {
        availability = "AVAILABLE";
        reason = truncated ? PERP_QUERY_REASONS.TRUNCATED_BY_LIMIT : PERP_QUERY_REASONS.OK;
      }
      telemetry.perp.asOfQueries.inc({ result: metricLabel(availability), kind: metricLabel(kind) });
      counts[availability] = (counts[availability] ?? 0) + 1;
      series.push({
        kind,
        venue,
        instrumentId,
        availability,
        reason,
        rows: ordered as readonly PerpRowByKind[PerpSeriesKind][],
        ageMs,
        truncated,
        asOf: new Date(query.asOfMs).toISOString(),
      });
    }
  }

  return {
    asOf: new Date(query.asOfMs).toISOString(),
    maxStaleMs: {
      funding: options.config.maxStaleMs.funding,
      openInterest: options.config.maxStaleMs.openInterest,
      // Serialisierbar gemacht: `Infinity` existiert in JSON nicht.
      liquidations: Number.isFinite(options.config.maxStaleMs.liquidations)
        ? options.config.maxStaleMs.liquidations
        : -1,
    },
    qualityMode: options.config.qualityMode,
    series,
    counts,
  };
}

/** Kurzpfad: jüngste verfügbare Zeile je (Instrument, Reihe) für Consumer. */
export async function latestPerpRows(
  source: PerpSeriesSource,
  request: {
    venue?: string | null;
    instruments: readonly string[];
    kinds?: readonly PerpSeriesKind[];
    asOfMs: number;
  },
  options: {
    config: PerpConfig;
    nowMs: number;
    capabilitiesFor?: (venue: string) => PerpVenueCapabilities | null;
  }
): Promise<readonly PerpSeriesResult[]> {
  const response = await queryPerpSeries(
    source,
    { ...request, limit: 1, kinds: request.kinds },
    { config: options.config, nowMs: options.nowMs, capabilitiesFor: options.capabilitiesFor }
  );
  return response.series;
}

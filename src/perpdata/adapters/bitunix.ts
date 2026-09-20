/**
 * Bitunix-Wrapper für historische Perpetual-Daten (RMA-P2-02, v1.54.0).
 *
 * DOMÄNENTRENNUNG (identisch zu `src/marketdata/adapters/bitunix.ts`):
 * Diese Datei ist die einzige Kopplung zwischen der Perp-Daten-Domäne und der
 * Bitunix-Broker-Domäne, und sie zeigt in genau eine Richtung:
 *
 *   src/perpdata/adapters/bitunix.ts  ──importiert──▶  BitunixPublicClient
 *
 * Verwendet wird **ausschließlich** der credential-freie Public-Client. Es wird
 * kein `BitunixPrivateClient` konstruiert, keine Signatur erzeugt und kein
 * Secret gelesen (statisch erzwungen in
 * `tests/perpPipeline.security.test.ts`). Funding-/OI-/Liquidations-*Daten*
 * sind öffentliche Marktdaten; Handel bleibt bei Broker-Factory und Live-Gate.
 *
 * Was Bitunix tatsächlich liefert (Stand der offiziellen Futures-Doku):
 *
 * | Reihe          | Endpunkt                                  | Reality              |
 * | -------------- | ----------------------------------------- | -------------------- |
 * | Funding-Historie | `GET /market/get_funding_rate_history`  | ✓ (limit ≤ 200)      |
 * | Funding-Snapshot | `GET /market/funding_rate`              | ✓ (Intervall, Bounds, nächstes Settlement) |
 * | Open Interest    | —                                         | ✗ kein öffentlicher Endpunkt |
 * | Liquidationen    | —                                         | ✗ kein öffentlicher Endpunkt |
 *
 * Die beiden letzten Zeilen sind **Capability-Antworten**, keine leeren
 * Ergebnislisten: `perpCapabilitiesFor("BITUNIX")` liefert dafür typisiert
 * `UNSUPPORTED / NO_PUBLIC_ENDPOINT`, und die Methoden hier fragen in diesem
 * Fall nicht einmal das Netz an.
 *
 * Zeitparameter: die Doku nennt das Startfeld der History an einer Stelle
 * `starTime` (Tippfehler der Venue), `/market/kline` nutzt `startTime`.
 * Gesendet wird `startTime`/`endTime`; **zusätzlich** filtert dieser Adapter
 * client-seitig auf das angefragte Fenster. Verlässt die Antwort das Fenster,
 * meldet er `WINDOW_LIMITED` statt blind zu blättern — ein falsch geblätterter
 * Backfill würde Lücken als „vollständig“ aussehen lassen.
 */
import { BITUNIX_FUNDING_HISTORY_MAX_LIMIT } from "../../brokers/bitunix/config";
import type { BitunixPublicClient } from "../../brokers/bitunix/publicClient";
import type {
  BitunixFundingRateHistoryRaw,
  BitunixFundingRateRaw,
} from "../../brokers/bitunix/types";
import { PerpDataError } from "../errors";
import { toEpochMs, toFiniteNumber } from "../normalize";
import { perpCapabilitiesFor } from "../capabilities";
import type { PerpFundingIntervalInfo, PerpDataAdapter } from "../port";
import {
  PERP_LIMITS,
  type PerpFetchResult,
  type PerpSeriesRequest,
  type PerpVenueCapabilities,
  type RawFundingRow,
  type RawLiquidationRow,
  type RawOpenInterestRow,
} from "../types";

/** Venue-Key des Wrappers. */
export const BITUNIX_PERP_VENUE = "BITUNIX" as const;

/** Quelle der Historie (Teil jeder Zeile, nie ein Secret). */
export const BITUNIX_FUNDING_HISTORY_SOURCE = "bitunix:funding_history" as const;
/** Quelle des aktuellen Funding-Snapshots (Intervall-Metadaten). */
export const BITUNIX_FUNDING_CURRENT_SOURCE = "bitunix:funding_current" as const;

/** Erlaubtes Symbolformat (dasselbe Gate wie im Public-Client). */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

/** Injizierbare Abhängigkeiten (Tests ersetzen nur diese beiden Methoden). */
export interface BitunixPerpAdapterDeps {
  /** Credential-freier Public-Client (History + Snapshot). */
  publicClient: Pick<BitunixPublicClient, "fetchFundingRateHistory" | "fetchFundingRates">;
  /** Injizierbare Uhr (Determinismus in Tests). */
  now?: () => Date;
}

/** Number-Wert eines Venue-Strings mit `null`-Toleranz. */
function field(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") return value;
  return null;
}

/** Rohzeile der Funding-History → {@link RawFundingRow} (keine Umrechnung). */
export function mapFundingHistoryRow(row: BitunixFundingRateHistoryRaw): RawFundingRow {
  return {
    eventTime: row?.fundingTime ?? null,
    fundingRate: field(row?.fundingRate),
    markPrice: field(row?.markPrice),
  };
}

/** Rohzeile des aktuellen Snapshots → Intervall-Metadaten je Symbol. */
export function mapFundingIntervalInfo(
  row: BitunixFundingRateRaw,
  fetchedAt: Date
): { symbol: string; info: PerpFundingIntervalInfo } | null {
  const symbol = typeof row?.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
  if (!symbol) return null;
  const maxAbs = [Math.abs(toFiniteNumber(row.maxFundingRate) ?? NaN), Math.abs(toFiniteNumber(row.minFundingRate) ?? NaN)].filter(
    (v) => Number.isFinite(v)
  );
  return {
    symbol,
    info: {
      intervalHours: toFiniteNumber(row.fundingInterval),
      nextFundingTime: (() => {
        const ms = toEpochMs(row.nextFundingTime ?? null, "ms", fetchedAt.getTime() + 86_400_000);
        return ms === null ? null : new Date(ms);
      })(),
      maxAbsFundingRate: maxAbs.length > 0 ? Math.min(...maxAbs) : null,
      sourceId: BITUNIX_FUNDING_CURRENT_SOURCE,
      fetchedAt,
    },
  };
}

/**
 * Adapter für die Bitunix-Futures-Venue.
 *
 * `fetchOpenInterest`/`fetchLiquidations` fragen **nie** das Netz an: die
 * Capability-Antwort der Venue entscheidet vor dem Request (kein Request,
 * keine leere Liste, keine 0).
 */
export class BitunixPerpAdapter implements PerpDataAdapter {
  readonly venue = BITUNIX_PERP_VENUE;
  readonly capabilities: PerpVenueCapabilities = perpCapabilitiesFor(BITUNIX_PERP_VENUE);

  private readonly publicClient: BitunixPerpAdapterDeps["publicClient"];
  private readonly now: () => Date;

  constructor(deps: BitunixPerpAdapterDeps) {
    this.publicClient = deps.publicClient;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Historie der Funding-Sätze im Fenster `[fromMs, toMs)`.
   *
   * `limit` wird auf das Venue-Maximum (200) und die Sync-Obergrenze
   * ({@link PERP_LIMITS.rowsPerRequest}) geklemmt. Die Antwort wird
   * client-seitig auf das Fenster gefiltert; Zeilen außerhalb verwandern
   * nicht still, sondern setzen `truncated` (der Sync meldet `WINDOW_LIMITED`).
   */
  async fetchFunding(request: PerpSeriesRequest): Promise<PerpFetchResult<RawFundingRow>> {
    if (!this.capabilities.funding.supported) {
      const cap = this.capabilities.funding;
      return {
        availability: "UNSUPPORTED",
        reason: cap.reason,
        note: cap.note,
      };
    }
    const symbol = assertSymbol(request.symbol);
    const fetchedAt = this.now();
    const limit = Math.min(
      BITUNIX_FUNDING_HISTORY_MAX_LIMIT,
      Math.max(1, Math.trunc(request.limit) || BITUNIX_FUNDING_HISTORY_MAX_LIMIT),
      PERP_LIMITS.rowsPerRequest
    );
    try {
      const rows = await this.publicClient.fetchFundingRateHistory({
        symbol,
        startTime: Math.trunc(request.fromMs),
        endTime: Math.trunc(request.toMs),
        limit,
      });
      const mapped = rows.map(mapFundingHistoryRow);
      const inWindow = mapped.filter((row) => {
        const ms = toEpochMs(row.eventTime, "ms", fetchedAt.getTime() + 86_400_000);
        return ms !== null && ms >= request.fromMs && ms < request.toMs;
      });
      return {
        availability: "AVAILABLE",
        series: {
          sourceId: BITUNIX_FUNDING_HISTORY_SOURCE,
          rows: inWindow,
          truncated: inWindow.length < mapped.length,
          fetchedAt,
          epochUnit: "ms",
        },
      };
    } catch (e) {
      return unavailableFromError(e);
    }
  }

  /** Immer `UNSUPPORTED` bei Bitunix — dokumentiert, kein Request. */
  async fetchOpenInterest(): Promise<PerpFetchResult<RawOpenInterestRow>> {
    const cap = this.capabilities.openInterest;
    if (cap.supported) {
      // Von der Capability-Matrix nicht vorgesehen; explizit statt still.
      return { availability: "UNAVAILABLE", reason: "SCHEMA_MISMATCH", retryable: false };
    }
    return { availability: "UNSUPPORTED", reason: cap.reason, note: cap.note };
  }

  /** Immer `UNSUPPORTED` bei Bitunix — dokumentiert, kein Request. */
  async fetchLiquidations(): Promise<PerpFetchResult<RawLiquidationRow>> {
    const cap = this.capabilities.liquidations;
    if (cap.supported) {
      return { availability: "UNAVAILABLE", reason: "SCHEMA_MISMATCH", retryable: false };
    }
    return { availability: "UNSUPPORTED", reason: cap.reason, note: cap.note };
  }

  /**
   * Intervall-Metadaten je Symbol aus **einem** Bulk-Request
   * (`GET /market/funding_rate`, Antwort ohne `symbol`-Filter = alle Symbole).
   *
   * Liefert nur Symbole, die im angefragten Set liegen. Schlägt der Request
   * fehl, ist das Ergebnis eine leere Map — die Historie wird dadurch nicht
   * wertloser, die Zeilen tragen lediglich kein Intervall (`NOT_REPORTED`).
   */
  async readFundingIntervals(
    symbols: readonly string[]
  ): Promise<ReadonlyMap<string, PerpFundingIntervalInfo>> {
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));
    const out = new Map<string, PerpFundingIntervalInfo>();
    if (wanted.size === 0 || !this.capabilities.funding.supported) return out;
    try {
      const rows = await this.publicClient.fetchFundingRates();
      const fetchedAt = this.now();
      for (const row of rows.slice(0, PERP_LIMITS.rowsPerRequest)) {
        const hit = mapFundingIntervalInfo(row, fetchedAt);
        if (hit && wanted.has(hit.symbol)) out.set(hit.symbol, hit.info);
      }
    } catch {
      return out;
    }
    return out;
  }
}

/** Factory (Registerung in `./registry.ts` — einzige Instanzierungsstelle). */
export function createBitunixPerpAdapter(deps: BitunixPerpAdapterDeps): BitunixPerpAdapter {
  return new BitunixPerpAdapter(deps);
}

function assertSymbol(symbol: string): string {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(value)) {
    throw new PerpDataError("perp:invalid_symbol", `Symbol „${value.slice(0, 32)}“ ist kein zulässiges Venue-Symbol.`);
  }
  return value;
}

/**
 * Fehler → typisierte `UNAVAILABLE`-Antwort.
 *
 * Die Venue-Meldung wird **nicht** übernommen (kein Fremdtext in Log/DB); nur
 * Klasse, HTTP-Status und Retry-Hinweis wandern in die Sync-Befunde.
 */
export function unavailableFromError(error: unknown): PerpFetchResult<never> {
  const kind = (error as { kind?: string } | null)?.kind ?? "";
  const httpStatus = (error as { httpStatus?: number } | null)?.httpStatus ?? undefined;
  if (kind === "rate-limit") {
    return { availability: "UNAVAILABLE", reason: "RATE_LIMITED", retryable: true, ...(httpStatus ? { httpStatus } : {}) };
  }
  if (kind === "maintenance") {
    return { availability: "UNAVAILABLE", reason: "HTTP_ERROR", retryable: true, ...(httpStatus ? { httpStatus } : {}) };
  }
  if (kind === "payload") {
    return { availability: "UNAVAILABLE", reason: "LIMIT_EXCEEDED", retryable: false, ...(httpStatus ? { httpStatus } : {}) };
  }
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "AbortError") {
    return { availability: "UNAVAILABLE", reason: "TIMEOUT", retryable: true };
  }
  if (typeof fetch === "function" && error instanceof Error && /fetch failed|network|enotfound|econnreset|eai_again/i.test(error.message)) {
    return { availability: "UNAVAILABLE", reason: "NETWORK", retryable: true };
  }
  if (error instanceof PerpDataError) {
    return { availability: "UNAVAILABLE", reason: "SCHEMA_MISMATCH", retryable: false };
  }
  return {
    availability: "UNAVAILABLE",
    reason: httpStatus !== undefined ? "HTTP_ERROR" : "SCHEMA_MISMATCH",
    retryable: httpStatus !== undefined && httpStatus >= 500,
    ...(httpStatus ? { httpStatus } : {}),
  };
}

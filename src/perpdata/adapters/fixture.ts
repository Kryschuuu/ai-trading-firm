/**
 * Deterministischer Fixture-Adapter für Perpetual-Daten (RMA-P2-02).
 *
 * Zweck — und was er **nicht** ist:
 *
 *   * Er ist der zweite, im Prompt geforderte Adapter („plus Fixture-Adapter“):
 *     er macht Sync, Qualität, Persistenz und die as-of-Abfrage **ohne
 *     Netzwerk** prüfbar — in Tests, im `--fixture`-Betrieb des CLIs und in
 *     Umgebungen ohne Venue-Anbindung.
 *   * Er ist **keine** Produktionsquelle: die Zahlen sind erzeugt
 *     (`sourceId = sim:fixture_*`), die Venue heißt `SIM`. Ein Betrieb, der
 *     Perp-Daten für Entscheidungen nutzt, registriert echte Venues.
 *
 * Alles ist eine reine Funktion aus `(Seed, Zeitfenster, Profil)` — gleiche
 * Eingabe ⇒ gleiche Zeilen (Golden-/Determinismustest in
 * `tests/perpPipeline.test.ts`). Zufallsquellen des Prozesses
 * (`Math.random`, Wanduhr) werden nicht berührt.
 *
 * Die Profile dienen der Negativprüfung: `epochUnit`, `fundingRateFormat`
 * (Prozent vs. Anteil), `gaps`, `negativeOpenInterest`, `duplicateEvery`,
 * `failuresBeforeSuccess` und `drop*` erzwingen genau die Befunde, die der
 * Qualitäts- und der Fail-closed-Pfad melden muss.
 */
import {
  BITUNIX_FUNDING_HISTORY_MAX_LIMIT,
} from "../../brokers/bitunix/config";
import { perpCapabilitiesFor } from "../capabilities";
import type { PerpDataAdapter, PerpFundingIntervalInfo } from "../port";
import {
  PERP_LIMITS,
  type PerpFetchResult,
  type PerpSeriesRequest,
  type PerpVenueCapabilities,
  type RawFundingRow,
  type RawLiquidationRow,
  type RawOpenInterestRow,
} from "../types";

/** Venue-Key des Fixture-Adapters (nie eine echte Venue). */
export const SIM_PERP_VENUE = "SIM" as const;

/** Konfigurierbares Verhalten des Fixture-Adapters. */
export interface FixturePerpProfile {
  /** Epoche der Rohwerte (Default ms; `s` prüft die Deklarationsregel). */
  epochUnit?: "ms" | "s";
  /** Funding als Prozentwert (`percent`) statt Dezimalanteil (`fraction`). */
  fundingRateFormat?: "fraction" | "percent";
  /** Funding-Raster in Stunden (Default 8). */
  fundingIntervalHours?: number;
  /** OI-Raster in Minuten (Default 60). */
  oiIntervalMinutes?: number;
  /** Jedes n-te Settlement auslassen (Löcher für den Gap-Befund, 0 = keins). */
  gapEvery?: number;
  /** Jedes n-te OI-Ereignis duplizieren (mit anderem Wert: Revision/Duplikat). */
  duplicateEvery?: number;
  /** OI-Wert des n-ten Punktes negativ (INVALID statt still 0). */
  negativeOpenInterestAt?: number;
  /** Erste n Anfragen schlagen fehl (Retry-Pfad, danach Erfolg). */
  failuresBeforeSuccess?: number;
  /** Open Interest gar nicht liefern (UNAVAILABLE, nicht UNSUPPORTED). */
  dropOpenInterest?: boolean;
  /** Liquidationen gar nicht liefern. */
  dropLiquidations?: boolean;
  /** Antwort enthält Zeilen außerhalb des Fensters (Kappungs-/Filtertest). */
  emitOutOfRange?: boolean;
  /** Zeilen über `limit` hinaus senden (Payload-Kappung). */
  emitOverLimit?: boolean;
  /** Liquidationsseiten als Order-Richtung (`SELL`/`BUY`) statt Positionsseite. */
  sideAsOrderDirection?: boolean;
  /** Basis des Seeds (stable, deterministisch je Symbol). */
  seed?: number;
}

export interface FixturePerpAdapterDeps {
  profile?: FixturePerpProfile;
  /** Injizierte Uhr (Default: `profile`-stabil, keine Wanduhr in Tests). */
  now?: () => Date;
  /**
   * Obere Grenze je Response (Default
   * {@link BITUNIX_FUNDING_HISTORY_MAX_LIMIT}) — spiegelt das Venue-Limit.
   */
  maxRowsPerResponse?: number;
}

/** Kleine, deterministische Hashfunktion (Symbol → Seed). */
function seedOf(symbol: string, base: number): number {
  let h = base >>> 0;
  const value = symbol.toUpperCase();
  for (let i = 0; i < value.length; i += 1) {
    h = (Math.imul(h, 31) + value.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** Deterministischer Pseudo-Zufall (LCG) im Bereich `[-1, 1]`. */
function wobble(seed: number, step: number): number {
  let x = (Math.imul(seed ^ step, 1_103_515_245) + 12_345) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return ((x % 2_000) / 1_000) - 1;
}

/** Fixture-Adapter (Profil + Uhr injiziert, keine globalen Seiteneffekte). */
export class FixturePerpAdapter implements PerpDataAdapter {
  readonly venue = SIM_PERP_VENUE;
  readonly capabilities: PerpVenueCapabilities = perpCapabilitiesFor(SIM_PERP_VENUE);

  private readonly profile: Required<Pick<FixturePerpProfile, "epochUnit" | "fundingRateFormat" | "fundingIntervalHours" | "oiIntervalMinutes">> &
    FixturePerpProfile;
  private readonly now: () => Date;
  private readonly maxRows: number;
  private readonly attempts = new Map<string, number>();

  constructor(deps: FixturePerpAdapterDeps = {}) {
    const profile = deps.profile ?? {};
    this.profile = {
      ...profile,
      epochUnit: profile.epochUnit ?? "ms",
      fundingRateFormat: profile.fundingRateFormat ?? "fraction",
      fundingIntervalHours: profile.fundingIntervalHours ?? 8,
      oiIntervalMinutes: profile.oiIntervalMinutes ?? 60,
    };
    this.now = deps.now ?? (() => new Date());
    this.maxRows = deps.maxRowsPerResponse ?? BITUNIX_FUNDING_HISTORY_MAX_LIMIT;
  }

  /** Zählt Anfragen je (Methode, Symbol) — Tests beweisen damit Request-Budgets. */
  requestCount(method: string, symbol: string): number {
    return this.attempts.get(`${method}:${symbol}`) ?? 0;
  }

  private noteFailure(method: string, symbol: string): boolean {
    const key = `${method}:${symbol}`;
    const seen = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, seen);
    const fails = this.profile.failuresBeforeSuccess ?? 0;
    return fails > 0 && seen <= fails;
  }

  /** Funding-Historie auf dem konfigurierten Raster. */
  async fetchFunding(request: PerpSeriesRequest): Promise<PerpFetchResult<RawFundingRow>> {
    if (!this.capabilities.funding.supported) {
      const cap = this.capabilities.funding;
      return { availability: "UNSUPPORTED", reason: cap.reason, note: cap.note };
    }
    if (this.noteFailure("funding", request.symbol)) {
      return { availability: "UNAVAILABLE", reason: "RATE_LIMITED", retryable: true, httpStatus: 429 };
    }
    const rows = this.fundingRows(request);
    const capped = this.profile.emitOverLimit
      ? [...rows, ...rows.slice(0, Math.max(request.limit, 1))]
      : rows;
    return {
      availability: "AVAILABLE",
      series: {
        sourceId: "sim:fixture_funding",
        rows: capped.slice(0, this.maxRows),
        truncated: capped.length > this.maxRows,
        fetchedAt: this.now(),
        epochUnit: this.profile.epochUnit,
      },
    };
  }

  /** OI-Reihe; mit `negativeOpenInterestAt` als INVALID-Zeile (fail-closed-Test). */
  async fetchOpenInterest(request: PerpSeriesRequest): Promise<PerpFetchResult<RawOpenInterestRow>> {
    const cap = this.capabilities.openInterest;
    if (!cap.supported) {
      return { availability: "UNSUPPORTED", reason: cap.reason, note: cap.note };
    }
    if (this.profile.dropOpenInterest) {
      return { availability: "UNAVAILABLE", reason: "HTTP_ERROR", retryable: true, httpStatus: 503 };
    }
    if (this.noteFailure("openInterest", request.symbol)) {
      return { availability: "UNAVAILABLE", reason: "TIMEOUT", retryable: true };
    }
    return {
      availability: "AVAILABLE",
      series: {
        sourceId: "sim:fixture_open_interest",
        rows: this.openInterestRows(request),
        truncated: false,
        fetchedAt: this.now(),
        epochUnit: this.profile.epochUnit,
      },
    };
  }

  /** Liquidationsereignisse (sparse, Seitensemantik konfigurierbar). */
  async fetchLiquidations(request: PerpSeriesRequest): Promise<PerpFetchResult<RawLiquidationRow>> {
    const cap = this.capabilities.liquidations;
    if (!cap.supported) {
      return { availability: "UNSUPPORTED", reason: cap.reason, note: cap.note };
    }
    if (this.profile.dropLiquidations) {
      return { availability: "UNAVAILABLE", reason: "NETWORK", retryable: true };
    }
    if (this.noteFailure("liquidations", request.symbol)) {
      return { availability: "UNAVAILABLE", reason: "NETWORK", retryable: true };
    }
    return {
      availability: "AVAILABLE",
      series: {
        sourceId: "sim:fixture_liquidations",
        rows: this.liquidationRows(request),
        truncated: false,
        fetchedAt: this.now(),
        epochUnit: this.profile.epochUnit,
      },
    };
  }

  /** Intervall-Metadaten (analog zum Bitunix-Snapshot-Endpunkt). */
  async readFundingIntervals(
    symbols: readonly string[]
  ): Promise<ReadonlyMap<string, PerpFundingIntervalInfo>> {
    const out = new Map<string, PerpFundingIntervalInfo>();
    const fetchedAt = this.now();
    for (const symbol of symbols) {
      out.set(symbol.toUpperCase(), {
        intervalHours: this.profile.fundingIntervalHours,
        nextFundingTime: null,
        maxAbsFundingRate: 0.3,
        sourceId: "sim:fixture_funding",
        fetchedAt,
      });
    }
    return out;
  }

  // ── Erzeugung (rein, deterministisch) ─────────────────────────────────────

  private fundingRows(request: PerpSeriesRequest): RawFundingRow[] {
    const intervalMs = this.profile.fundingIntervalHours * 3_600_000;
    const first = Math.ceil(request.fromMs / intervalMs) * intervalMs;
    const seed = seedOf(request.symbol, this.profile.seed ?? 7);
    const rows: RawFundingRow[] = [];
    let index = 0;
    for (let ts = first; ts < request.toMs; ts += intervalMs, index += 1) {
      if ((this.profile.gapEvery ?? 0) > 0 && index % (this.profile.gapEvery as number) === (this.profile.gapEvery as number) - 1) {
        continue;
      }
      const rate = round(wobble(seed, index) * 0.0004, 10);
      const extra: RawFundingRow = {
        eventTime: this.profile.epochUnit === "s" ? Math.round(ts / 1000) : ts,
        fundingRate: this.profile.fundingRateFormat === "fraction" ? rate : null,
        fundingRatePct: this.profile.fundingRateFormat === "percent" ? round(rate * 100, 8) : null,
        intervalHours: this.profile.fundingIntervalHours,
        markPrice: round(60_000 + wobble(seed, index + 991) * 250, 4),
      };
      rows.push(extra);
      if ((this.profile.duplicateEvery ?? 0) > 0 && index % (this.profile.duplicateEvery as number) === 0) {
        // Duplikat desselben Schlüssels, gleicher Inhalt (Idempotenzbeweis).
        rows.push({ ...extra });
      }
    }
    if (this.profile.emitOutOfRange && rows.length > 0) {
      rows.push({ eventTime: request.fromMs - 10 * intervalMs, fundingRate: 0.0001 });
    }
    return rows.slice(0, PERP_LIMITS.rowsPerRequest);
  }

  private openInterestRows(request: PerpSeriesRequest): RawOpenInterestRow[] {
    const stepMs = this.profile.oiIntervalMinutes * 60_000;
    const first = Math.ceil(request.fromMs / stepMs) * stepMs;
    const seed = seedOf(request.symbol, this.profile.seed ?? 11);
    const rows: RawOpenInterestRow[] = [];
    let index = 0;
    for (let ts = first; ts < request.toMs; ts += stepMs, index += 1) {
      const contracts = Math.round(120_000 + index * 35 + wobble(seed, index) * 900);
      const value: RawOpenInterestRow = {
        eventTime: this.profile.epochUnit === "s" ? Math.round(ts / 1000) : ts,
        contracts,
        basis: "contracts",
        contractSize: 0.001,
        markPrice: round(60_000 + wobble(seed, index + 991) * 250, 4),
        quoteCurrency: "USDT",
      };
      if ((this.profile.negativeOpenInterestAt ?? -1) === index) {
        rows.push({ ...value, contracts: -Math.abs(contracts) });
        continue;
      }
      rows.push(value);
    }
    return rows;
  }

  private liquidationRows(request: PerpSeriesRequest): RawLiquidationRow[] {
    const seed = seedOf(request.symbol, this.profile.seed ?? 13);
    const rows: RawLiquidationRow[] = [];
    const span = Math.max(1, request.toMs - request.fromMs);
    const count = Math.min(PERP_LIMITS.rowsPerRequest, Math.max(0, Math.floor(span / (3_600_000 * 4))));
    for (let index = 0; index < count; index += 1) {
      const ts = request.fromMs + index * (span / Math.max(1, count));
      const long = wobble(seed, index) >= 0;
      const qty = round(0.05 + Math.abs(wobble(seed, index + 5)) * 2.5, 6);
      const price = round(60_000 + wobble(seed, index + 9) * 400, 2);
      rows.push({
        eventTime: this.profile.epochUnit === "s" ? Math.round(ts / 1000) : Math.round(ts),
        side: this.profile.sideAsOrderDirection ? (long ? "SELL" : "BUY") : long ? "LONG" : "SHORT",
        sideIsPosition: !this.profile.sideAsOrderDirection,
        quantityBase: qty,
        price,
        notionalQuote: round(qty * price, 4),
        quoteCurrency: "USDT",
        sourceEventId: `sim-${seed.toString(16)}-${index}`,
      });
    }
    return rows;
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Fabric für den Sync-Registry-Pfad (analog `createBitunixPerpAdapter`). */
export function createFixturePerpAdapter(deps: FixturePerpAdapterDeps = {}): FixturePerpAdapter {
  return new FixturePerpAdapter(deps);
}

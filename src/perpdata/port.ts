/**
 * Adapter-Port der Perpetual-Daten (RMA-P2-02) — venue-agnostische Grenze.
 *
 * ```text
 *   Venue-Rest (public)  →  PerpDataAdapter  →  normalize  →  quality  →  store
 *                                                                  ↓
 *                                            Scanner / Backtest / Analyst (as-of)
 * ```
 *
 * Regeln des Contracts (alle statisch prüfbar, in
 * `tests/perpPipeline.security.test.ts` erzwungen):
 *
 * 1. **Nur öffentliche Endpunkte.** Ein Adapter darf keine Credentials,
 *    keine Signatur und keinen Order-Pfad berühren — Perp-*Daten* sind
 *    Marktdaten, Handel bleibt bei Broker-Factory und Live-Gate.
 * 2. **Nie ein Leck in eine leere Liste.** Kann die Venue eine Reihenart
 *    nicht, ist die Antwort `{ availability: "UNSUPPORTED" }`; ist sie heute
 *    gestört, `{ availability: "UNAVAILABLE", retryable }`. Eine leere
 *    `rows`-Liste bedeutet ausschließlich „im Fenster kein Satz“ — nie
 *    „gibt es nicht“ und nie „Rate = 0“.
 * 3. **Rohformen enden am Adapter.** Der Adapter normalisiert **nicht**;
 *    er liefert deklarierte Rohzeilen plus Einheiten-Angabe. Zentrale
 *    Normalisierung (`./normalize.ts`) ist die einzige Stelle, die
 *    Fremdformen versteht — sonst entstehen pro Venue eigene Regeln.
 * 4. **Limits sind hart.** `request.limit` ist die Obergrenze; eine längere
 *    Antwort wird gekappt und mit `truncated: true` gemeldet.
 */
import type {
  PerpFetchResult,
  PerpSeriesKind,
  PerpSeriesRequest,
  PerpVenueCapabilities,
  RawFundingRow,
  RawLiquidationRow,
  RawOpenInterestRow,
} from "./types";

/** Ein Perpetual-Datenadapter (eine Venue). */
export interface PerpDataAdapter {
  /** Venue-Key in Großbuchstaben. */
  readonly venue: string;
  /** Capability-Bild dieser Venue je Reihenart (typisiert, nicht geraten). */
  readonly capabilities: PerpVenueCapabilities;
  /** Abruf der Funding-Historie (Settlement-Sätze). */
  fetchFunding(request: PerpSeriesRequest): Promise<PerpFetchResult<RawFundingRow>>;
  /** Abruf der Open-Interest-Reihe. */
  fetchOpenInterest(request: PerpSeriesRequest): Promise<PerpFetchResult<RawOpenInterestRow>>;
  /** Abruf von Liquidationsereignissen. */
  fetchLiquidations(request: PerpSeriesRequest): Promise<PerpFetchResult<RawLiquidationRow>>;
}

/** Methode je Reihenart (Dispatch ohne `switch`-Duplikate im Sync). */
export function perpFetchMethod<K extends PerpSeriesKind>(
  adapter: PerpDataAdapter,
  kind: K
): (request: PerpSeriesRequest) => Promise<
  PerpFetchResult<
    K extends "funding"
      ? RawFundingRow
      : K extends "openInterest"
        ? RawOpenInterestRow
        : RawLiquidationRow
  >
> {
  if (kind === "funding") {
    return adapter.fetchFunding.bind(adapter) as never;
  }
  if (kind === "openInterest") {
    return adapter.fetchOpenInterest.bind(adapter) as never;
  }
  return adapter.fetchLiquidations.bind(adapter) as never;
}

/**
 * Rate-Limiter (identische Semantik zum `RateLimiter` des Market-Data-Syncs):
 * eine Anfrage vor dem Request nehmen. Der Bitunix-Transport nutzt seinen
 * eigenen Token-Bucket; dieser Hook erlaubt es Tests, Requests **zu zählen**,
 * ohne das Limit zu umgehen.
 */
export type PerpRateLimiter = () => Promise<void>;

/** Minimales Logger-Contract: eine fertig formatierte, leakfreie Zeile. */
export type PerpSyncLogger = (level: "info" | "warn" | "error", line: string) => void;

/**
 * Optionale Erweiterung: **Intervall-Metadaten** je Symbol.
 *
 * Manche Venues melden das Funding-Intervall (`intervalHours`) und das nächste
 * Settlement nur im aktuellen Snapshot-Endpunkt, aber nicht in der Historie.
 * Ein Adapter mit dieser Fähigkeit erlaubt es dem Sync, die Historie damit
 * anzureichern, statt das Intervall zu raten. Der Wert bleibt eine
 * venue-gemeldete Größe — er wird **nicht** als eigener Satz persistiert
 * (ein Predicted-Rate-Satz wäre sonst ein Blick in die Zukunft).
 */
export interface PerpFundingIntervalInfo {
  /** Funding-Intervall in Stunden (`null` = Venue meldet keins). */
  intervalHours: number | null;
  /** Nächstes Settlement (nur Metadaten, nie ein Zeilen-Ereignis). */
  nextFundingTime: Date | null;
  /** Betrag der venue-seitigen Ratenkappe (Plausibilität, `|rate| ≤`). */
  maxAbsFundingRate: number | null;
  /** Quelle der Metadaten (`bitunix:funding_current`). */
  sourceId: string;
  fetchedAt: Date;
}

/** Adapter, die Intervall-Metadaten in einem Bulk-Request liefern. */
export interface PerpFundingIntervalSource {
  readFundingIntervals(
    symbols: readonly string[]
  ): Promise<ReadonlyMap<string, PerpFundingIntervalInfo>>;
}

/** Type-Guard: Adapter kann Intervall-Metadaten (Bulk) liefern? */
export function supportsFundingIntervals(
  adapter: PerpDataAdapter
): adapter is PerpDataAdapter & PerpFundingIntervalSource {
  return typeof (adapter as Partial<PerpFundingIntervalSource>).readFundingIntervals === "function";
}

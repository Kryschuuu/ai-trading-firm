/**
 * Normalisierung & Anomalie-Erkennung (Task 03).
 *
 * Ziel: Es wird nur gehandelt, was validiert ist. Anomale Kurse (NaN/≤0,
 * Sprung > konfigurierbarer Schwellwert, staler Timestamp, kaputter Spread)
 * werden verworfen und geloggt — sie erreichen nie den Broker.
 *
 * Rein deterministisch (Decoupling-Regel 1), kein IO.
 */
import { AnomalousSnapshotError, type MarketDataSource, type MarketSnapshot } from "./types";

/** Roh-Eingabe eines Feeds vor der Normalisierung. */
export interface RawSnapshotInput {
  instrumentId: string;
  symbol: string;
  base: string | null;
  quote: string;
  bid: number;
  ask: number;
  last: number;
  /** Beobachtungszeitpunkt in Unix-Epoch (ms). */
  ts: number;
  source: MarketDataSource;
  venue: string;
  feed: string;
  volume24h?: number | null;
}

/** Normalisierungs-Optionen (Default = strikt, für Realtime). */
export interface NormalizeOptions {
  /** Max. Alter in ms; `Infinity` deaktiviert den Stale-Check (Replay). */
  maxAgeMs: number;
  /** Max. prozentualer Sprung gegenüber `prev` (0 = kein Check). */
  maxJumpPct: number;
  /** Max. relativer Spread (0..1), Standard 0.2 (20 %). */
  maxSpread: number;
  /** Referenz-Snapshot (vorheriger Kurs) für den Sprung-Check. */
  prev?: MarketSnapshot;
  /** Jetzt-Zeitpunkt für den Stale-Check (Test-Injektion; Standard Date.now). */
  now?: number;
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  maxAgeMs: 30_000,
  maxJumpPct: 50,
  maxSpread: 0.2,
};

function isFinitePositive(x: number, label: string): void {
  if (!Number.isFinite(x) || x <= 0) {
    throw new AnomalousSnapshotError("", `${label} nicht endlich/positiv (${String(x)})`);
  }
}

/**
 * Normalisiert einen Roh-Snapshot. Wirft `AnomalousSnapshotError` bei Anomalie.
 */
export function normalizeSnapshot(
  input: RawSnapshotInput,
  opts: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS
): MarketSnapshot {
  try {
    isFinitePositive(input.bid, "bid");
    isFinitePositive(input.ask, "ask");
    isFinitePositive(input.last, "last");

    if (input.ask < input.bid) {
      throw new AnomalousSnapshotError(input.instrumentId, `ask < bid (${input.ask} < ${input.bid})`);
    }

    const mid = (input.bid + input.ask) / 2;
    const spread = (input.ask - input.bid) / mid;
    if (spread < 0 || spread > opts.maxSpread) {
      throw new AnomalousSnapshotError(
        input.instrumentId,
        `Spread ${(spread * 100).toFixed(2)}% > Limit ${(opts.maxSpread * 100).toFixed(1)}%`
      );
    }

    // Stale-Check (Replay kann ihn deaktivieren).
    if (Number.isFinite(opts.maxAgeMs)) {
      const now = opts.now ?? Date.now();
      if (now - input.ts > opts.maxAgeMs) {
        throw new AnomalousSnapshotError(
          input.instrumentId,
          `Kurs ist stale (Alter ${Math.round((now - input.ts) / 1000)} s > ${Math.round(opts.maxAgeMs / 1000)} s)`
        );
      }
    }

    // Sprung-Check gegen den vorherigen Kurs.
    if (opts.maxJumpPct > 0 && opts.prev && opts.prev.last > 0) {
      const jump = Math.abs(input.last - opts.prev.last) / opts.prev.last;
      if (jump > opts.maxJumpPct / 100) {
        throw new AnomalousSnapshotError(
          input.instrumentId,
          `Kurssprung ${(jump * 100).toFixed(1)}% > Limit ${opts.maxJumpPct}%`
        );
      }
    }

    return {
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      base: input.base,
      quote: input.quote,
      bid: input.bid,
      ask: input.ask,
      last: input.last,
      ts: input.ts,
      source: input.source,
      venue: input.venue,
      feed: input.feed,
      spread,
      volume24h: input.volume24h ?? null,
    };
  } catch (e) {
    // AnomalousSnapshotError mit leerem instrumentId füllen.
    if (e instanceof AnomalousSnapshotError) {
      throw new AnomalousSnapshotError(input.instrumentId, e.message);
    }
    throw e;
  }
}

/** Mid-Preis eines Snapshots. */
export function mid(snapshot: MarketSnapshot): number {
  return (snapshot.bid + snapshot.ask) / 2;
}

/** Kompakte Log-Zeile für einen verworfenen Kurs (leak-frei). */
export function anomalyLogLine(snapshot: MarketSnapshot | RawSnapshotInput, reason: string): string {
  return `[marketdata] Kurs verworfen ${snapshot.instrumentId} (${reason})`;
}

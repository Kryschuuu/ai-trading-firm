/**
 * Replay-Feed (Task 03) — spielt den Historical Store ab.
 *
 * Backtest-Modus speist Kurse AUSSCHLIESSLICH aus dem Historical Store
 * (Regel / Architektur: kein Live-Kurs im Backtest). Der Feed liest die
 * append-only-Kerzen eines Instruments in stabiler ts-Reihenfolge und liefert
 * deterministische Snapshots (last = close, Bid/Ask aus Registry-/Default-Spread).
 *
 * Gleicher Store-Stand → identische Kursfolge → identische Fills (Golden-Test).
 */
import type { MarketInstrument } from "../../../universe/types";
import {
  DEFAULT_ANALYSIS_TIMEFRAME,
  type HistoricalCandleEntry,
  type HistoricalStore,
  type SupportedTimeframe,
} from "../historicalStore";
import { FeedNotSupportedError, type MarketCandle, type MarketDataSource, type MarketFeed, type MarketSnapshot } from "../types";
import { normalizeSnapshot, type RawSnapshotInput } from "../normalization";

export interface ReplayFeedOptions {
  /** Relativer Default-Spread für Bid/Ask-Ableitung. */
  defaultSpread?: number;
  /**
   * Abzuspielende Periodizität (Pflicht-Query gegen den Store). Default: der
   * Analyse-Timeframe (`1h`), damit Replay/Backtest niemals Timeframes
   * mischen.
   */
  timeframe?: SupportedTimeframe;
}

export class ReplayFeed implements MarketFeed {
  readonly id = "replay";
  readonly source: MarketDataSource = "replay";
  private readonly defaultSpread: number;
  private readonly timeframe: SupportedTimeframe;
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly store: HistoricalStore,
    opts: ReplayFeedOptions = {}
  ) {
    this.defaultSpread = opts.defaultSpread ?? 0.0004;
    this.timeframe = opts.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
  }

  private entriesFor(instrument: MarketInstrument): HistoricalCandleEntry[] {
    return this.store.query({ instrumentId: instrument.id, timeframe: this.timeframe });
  }

  /**
   * Liefert den nächsten Replay-Snapshot und schaltet den Cursor weiter.
   * Wirft `FeedNotSupportedError` am Ende des Streams (kein stilles Replay vom
   * Ende → Aufrufer führt Failover/Backtest-Ende aus).
   */
  getTicker(instrument: MarketInstrument): Promise<MarketSnapshot> {
    const entries = this.entriesFor(instrument);
    if (!entries.length) {
      return Promise.reject(
        new FeedNotSupportedError(this.id, instrument.id, "keine historischen Daten im Store")
      );
    }
    const cur = this.cursors.get(instrument.id) ?? 0;
    if (cur >= entries.length) {
      return Promise.reject(
        new FeedNotSupportedError(this.id, instrument.id, "Replay-Stream erschöpft")
      );
    }
    const entry = entries[cur];
    this.cursors.set(instrument.id, cur + 1);

    const spread = Number.isFinite(instrument.spread) && (instrument.spread as number) > 0
      ? (instrument.spread as number)
      : this.defaultSpread;
    const half = spread / 2;
    const input: RawSnapshotInput = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      base: instrument.base,
      quote: instrument.quote,
      bid: entry.close * (1 - half),
      ask: entry.close * (1 + half),
      last: entry.close,
      ts: entry.ts,
      source: this.source,
      venue: entry.venue,
      feed: `${this.id}:${entry.feed}`,
      volume24h: null,
    };
    return Promise.resolve(
      normalizeSnapshot(input, { maxAgeMs: Infinity, maxJumpPct: 0, maxSpread: 1 })
    );
  }

  /** Replay-Kerzen direkt aus dem Store (OHLCV). */
  async getCandles(instrument: MarketInstrument, _interval: string, _limit: number): Promise<MarketCandle[]> {
    return this.entriesFor(instrument).map((e) => ({
      time: e.ts,
      open: e.open,
      high: e.high,
      low: e.low,
      close: e.close,
      volume: e.volume,
    }));
  }
}

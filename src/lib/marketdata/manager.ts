/**
 * MarketDataManager (Task 03) — zentrale Steuerung der Market-Data-Schicht.
 *
 *   - Löst das Instrument auf (Registry), baut die Failover-Kette je Paper-Mode,
 *     holt den Snapshot über die Kette, normalisiert (inkl. Sprung-Check gegen
 *     den vorherigen Kurs), schreibt append-only in den Historical Store und
 *     cacht den Snapshot für den synchronen Broker-Hot-Path.
 *   - Modus B (Default, `broker-market-data`): echte Kurse über Broker-Feed →
 *     unabhängiger Feed → (nur explizit) Synthetic.
 *   - Modus A (`synthetic`): nur Synthetic. Backtest nutzt den Replay-Feed.
 *   - Statisches Preisbuch nur hinter `PAPER_STATIC_FALLBACK=true` (Default aus).
 *
 * Rein deterministisch (kein LLM), read-only, Failover wird auditiert.
 */
import type { MarketInstrument } from "../../universe/types";
import type { BrokerAdapter } from "../../contracts/broker";
import { VENUE_CAPABILITIES } from "../../brokers/capabilities";
import { getRegistry, type InstrumentRegistry } from "../../universe";
import {
  MarketDataError,
  PaperConfigError,
  type MarketCandle,
  type MarketFeed,
  type MarketSnapshot,
} from "./types";
import { loadMarketDataConfig, type MarketDataConfig } from "./config";
import { buildFeeds, type FeedSet } from "./feeds";
import { failoverGetTicker, readFailoverAudit, type FailoverAuditEntry } from "./failover";
import { HistoricalStore } from "./historicalStore";
import { normalizeSnapshot, type RawSnapshotInput } from "./normalization";

const G = globalThis as typeof globalThis & { __marketDataManager?: MarketDataManager };

export interface MarketDataManagerOptions {
  config?: MarketDataConfig;
  registry?: InstrumentRegistry;
  store?: HistoricalStore;
  /** Für Broker-Feed; Default: PAPER-Adapter über die Factory. */
  brokerAdapter?: BrokerAdapter;
}

/** Ein aus dem Registry aufgelöstes Instrument + kurzer Symbol-Name. */
interface Resolved {
  instrument: MarketInstrument;
}

function candleFromSnapshot(s: MarketSnapshot): MarketCandle {
  return { time: s.ts, open: s.last, high: s.last, low: s.last, close: s.last, volume: 0 };
}

function toRaw(s: MarketSnapshot): RawSnapshotInput {
  return {
    instrumentId: s.instrumentId,
    symbol: s.symbol,
    base: s.base,
    quote: s.quote,
    bid: s.bid,
    ask: s.ask,
    last: s.last,
    ts: s.ts,
    source: s.source,
    venue: s.venue,
    feed: s.feed,
    volume24h: s.volume24h,
  };
}

export class MarketDataManager {
  readonly config: MarketDataConfig;
  readonly store: HistoricalStore;
  private readonly registry: InstrumentRegistry;
  private readonly feeds: FeedSet;
  private readonly brokerAdapter?: BrokerAdapter;
  private readonly cache = new Map<string, MarketSnapshot>();
  private activeSource: string = "none";

  constructor(opts: MarketDataManagerOptions = {}) {
    this.config = opts.config ?? loadMarketDataConfig();
    this.registry = opts.registry ?? getRegistry();
    this.store = opts.store ?? new HistoricalStore(this.config.historyDir);
    // BrokerFeed-Adapter wird injiziert (Produktion: PAPER-Adapter über
    // `production.ts`; Tests: Fixture-Adapter). Kein Import der Factory hier,
    // um Import-Zyklen (factory → paper → marketdata) zu vermeiden.
    this.brokerAdapter = opts.brokerAdapter;

    if (this.config.paperMode === "broker-paper-api") {
      this.validateModeC();
    }

    this.feeds = buildFeeds(this.config, { brokerAdapter: this.brokerAdapter, store: this.store });
  }

  /** Prüft, ob Modus C überhaupt wählbar ist (Venue-Capability + Flag). */
  private validateModeC(): void {
    const venue = this.config.brokerApiVenue;
    if (!venue) {
      throw new PaperConfigError("paperMode \"broker-paper-api\" erfordert PAPER_BROKER_API_VENUE.");
    }
    const caps = VENUE_CAPABILITIES[venue as keyof typeof VENUE_CAPABILITIES];
    if (!caps) {
      throw new PaperConfigError(
        `paperMode "broker-paper-api": unbekanntes Venue "${venue}". Erlaubt: ${Object.keys(VENUE_CAPABILITIES).join(", ")}.`
      );
    }
    if (!caps.testnet && !(caps.paper && venue !== "PAPER")) {
      throw new PaperConfigError(
        `paperMode "broker-paper-api" für Venue "${venue}" nicht verfügbar: ` +
          `der Adapter deklariert weder eine testnet- noch eine broker-Paper-API-Capability. ` +
          `(Heute: kein Venue unterstützt Modus C.)`
      );
    }
  }

  /** Löst eine Query (Instrument-ID oder Symbol) zu einem Instrument auf. */
  resolveInstrument(query: string): MarketInstrument | null {
    const q = query.trim().toUpperCase();
    const all = this.registry.query({ pageSize: 500 }).items;

    if (q.includes(":")) {
      const exact = all.find((i) => i.id === q);
      if (exact) return exact;
    }
    const bySymbol = all.filter((i) => i.symbol.toUpperCase() === q);
    if (bySymbol.length) {
      return bySymbol.find((i) => i.venue === "PAPER") ?? bySymbol[0];
    }
    return null;
  }

  /** Baut die Failover-Kette für ein Instrument je Paper-Mode. */
  chainFor(instrument: MarketInstrument): MarketFeed[] {
    const mode = this.config.paperMode;
    if (mode === "synthetic") return [this.feeds.synthetic];
    if (mode === "broker-paper-api") return this.feeds.broker ? [this.feeds.broker] : [];

    // broker-market-data (Default)
    const chain: MarketFeed[] = [];
    if (this.feeds.broker) chain.push(this.feeds.broker);
    const independent = instrument.assetClass === "crypto" ? this.feeds.binance : this.feeds.yahoo;
    chain.push(independent);
    if (this.config.allowSyntheticFallback) chain.push(this.feeds.synthetic);
    return chain;
  }

  /** Aktuellen Snapshot holen (async, über Failover-Kette + Store). */
  async getSnapshot(query: string): Promise<MarketSnapshot> {
    const instrument = this.resolveInstrument(query);
    if (!instrument) {
      throw new MarketDataError("UNKNOWN_INSTRUMENT", `Instrument "${query.slice(0, 40)}" nicht im Universum.`);
    }
    const cached = this.cache.get(instrument.id);
    if (cached && Date.now() - cached.ts < this.config.staleAfterMs) {
      return cached;
    }

    const chain = this.chainFor(instrument);
    if (chain.length === 0) {
      throw new MarketDataError("NO_FEED", `Kein Feed für Instrument "${instrument.id}" (paperMode=${this.config.paperMode}).`);
    }

    const result = await failoverGetTicker(chain, instrument, {
      validate: (snap) => {
        const prev = this.cache.get(instrument.id);
        normalizeSnapshot(toRaw(snap), {
          maxAgeMs: Infinity,
          maxJumpPct: this.config.anomalyMaxJumpPct,
          maxSpread: 0.2,
          prev,
        });
      },
      onActive: (feedId) => {
        this.activeSource = feedId;
      },
    });

    this.activeSource = result.activeFeed;
    this.cache.set(instrument.id, result.snapshot);
    // Append-only in den Historical Store (Provenienz = Feed). Snapshot-Kerzen
    // sind Einzel-Ticks (keine Aggregationsstufe) → als "1m" markiert; die
    // timeframe ist Teil des logischen Schlüssels und Pflicht-Parameter.
    this.store.append(
      [candleFromSnapshot(result.snapshot)],
      instrument.id,
      { venue: result.snapshot.venue, feed: result.snapshot.feed },
      "1m",
      new Date(result.snapshot.ts),
    );
    return result.snapshot;
  }

  /** Synchroner Lesezugriff auf den Snapshot-Cache (Broker-Hot-Path). */
  getSnapshotSync(query: string): MarketSnapshot | null {
    const instrument = this.resolveInstrument(query);
    if (!instrument) return null;
    return this.cache.get(instrument.id) ?? null;
  }

  /** Kerzen über den primären Feed (Backtest nutzt Replay separat). */
  async getCandles(query: string, interval: string, limit: number): Promise<MarketCandle[]> {
    const instrument = this.resolveInstrument(query);
    if (!instrument) throw new MarketDataError("UNKNOWN_INSTRUMENT", `Instrument "${query.slice(0, 40)}" nicht im Universum.`);
    const chain = this.chainFor(instrument);
    for (const feed of chain) {
      try {
        return await feed.getCandles(instrument, interval, limit);
      } catch {
        /* nächster Feed */
      }
    }
    throw new MarketDataError("NO_CANDLES", `Keine Kerzen für "${instrument.id}".`);
  }

  /** Status (aktive Quelle, Cache-TTL, letzter Failover) — read-only. */
  status() {
    const lastFailover: FailoverAuditEntry | null =
      readFailoverAudit(1)[0] ?? null;
    return {
      paperMode: this.config.paperMode,
      activeSource: this.activeSource,
      cacheTtlMs: this.config.staleAfterMs,
      lastFailover,
      staticFallbackEnabled: this.config.staticFallbackEnabled,
      allowSyntheticFallback: this.config.allowSyntheticFallback,
      anomalyMaxJumpPct: this.config.anomalyMaxJumpPct,
      staleAfterMs: this.config.staleAfterMs,
      brokerApiVenue: this.config.brokerApiVenue,
      failoverAuditCount: readFailoverAudit(1000).length,
    };
  }
}

/** Prozessweiter Singleton (Produktion). */
export function getMarketDataManager(opts?: MarketDataManagerOptions): MarketDataManager {
  if (!G.__marketDataManager || opts) {
    G.__marketDataManager = new MarketDataManager(opts ?? {});
  }
  return G.__marketDataManager;
}

/** Nur für Tests: Singleton verwerfen. */
export function resetMarketDataManagerForTests(): void {
  delete G.__marketDataManager;
}

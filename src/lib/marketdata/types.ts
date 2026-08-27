/**
 * Geteilte Typen der Market-Data-Schicht (Task 03).
 *
 * Diese Schicht ist rein deterministisch (Decoupling-Regel 1): kein LLM-Zugriff,
 * kein geheimes State. Venue-Details (REST-Formate, Symbol-Mapping) leben
 * ausschließlich in den Feed-Implementierungen (`src/lib/marketdata/feeds/`).
 *
 * `MarketFeed` ist die Abstraktion, über die der Kern Kurse/Kerzen/Orderbücher
 * erhält — venue-unabhängig, so wie `BrokerAdapter` die Order-Ausführung kapselt.
 */
import type { MarketInstrument } from "../../universe/types";

/** Die drei Paper-Modi der Plattform (siehe docs/PAPER_TRADING.md). */
export type PaperMode = "synthetic" | "broker-market-data" | "broker-paper-api";

/** Herkunft eines Snapshots (Feed-Quelle, nicht Cache). */
export type MarketDataSource =
  | "binance"
  | "yahoo"
  | "broker"
  | "synthetic"
  | "replay"
  | "cache";

/**
 * Ein normalisierter Markt-Snapshot.
 *
 * bid/ask/last sind geprüfte, endliche Preise > 0 (siehe `normalization.ts`).
 * Anomale Kurse werden in der Normalisierung verworfen und geloggt — sie
 * gelangen niemals in diesen Contract und werden nie gehandelt.
 */
export interface MarketSnapshot {
  /** Kanonische Instrument-ID `"<VENUE>:<SYMBOL>"`. */
  instrumentId: string;
  /** Venue-natives Symbol, z. B. `"BTCUSDT"` oder `"SPY"`. */
  symbol: string;
  /** Basis-Asset (null bei Aktien/ETFs/FX). */
  base: string | null;
  /** Quote-/Abrechnungswährung. */
  quote: string;
  /** Bester Bid-Preis (> 0). */
  bid: number;
  /** Bester Ask-Preis (> 0, >= bid). */
  ask: number;
  /** Zuletzt gehandelter Preis (> 0). */
  last: number;
  /** Unix-Epoch (ms), zu der der Kurs beobachtet wurde. */
  ts: number;
  /** Quelle des Kurses (feed id / data source). */
  source: MarketDataSource;
  /** Venue, an der der Kurs beobachtet wurde. */
  venue: string;
  /** Feed-Instanz, die den Snapshot lieferte (Provenienz). */
  feed: string;
  /** Relativer Spread `(ask-bid)/mid` in Dezimalanteil (0.0004 = 4 bp). */
  spread: number;
  /** 24-h-Volumen in Quote-Währung (null falls unbekannt). */
  volume24h: number | null;
}

/** Eine OHLCV-Kerze, Zeit in Unix-Epoch (ms). */
export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Eine Ebene eines Orderbuchs. */
export interface OrderBookLevel {
  price: number;
  qty: number;
}

/** Ein Snapshot des Orderbuchs (Level 1–N). */
export interface MarketOrderBook {
  instrumentId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;
}

/** Callback für `subscribe`. Gibt `() => void` (Unsubscribe) zurück. */
export type SnapshotSubscriber = (snapshot: MarketSnapshot) => void;

/**
 * Die Feed-Abstraktion (Task 03).
 *
 * `getTicker`/`getCandles` sind Pflicht für alle Feeds, `getOrderBook` und
 * `subscribe` optional. Aufrufer müssen mit "nicht unterstützt" umgehen
 * (der Feed wirft `FeedNotSupportedError`).
 */
export interface MarketFeed {
  /** Eindeutige Feed-Instanz-ID (Provenienz/Audit), z. B. `"binance"`. */
  readonly id: string;
  /** Datenquelle, die dieser Feed bedient. */
  readonly source: MarketDataSource;
  /** Aktuellen normalisierten Snapshot für ein Instrument liefern. */
  getTicker(instrument: MarketInstrument): Promise<MarketSnapshot>;
  /** OHLCV-Kerzen für ein Instrument liefern. */
  getCandles(
    instrument: MarketInstrument,
    interval: string,
    limit: number
  ): Promise<MarketCandle[]>;
  /** (Optional) Orderbuch-Level für ein Instrument. */
  getOrderBook?(instrument: MarketInstrument): Promise<MarketOrderBook>;
  /** (Optional) Push-Subscription. Gibt Unsubscribe zurück. */
  subscribe?(instrument: MarketInstrument, cb: SnapshotSubscriber): () => void;
}

/** Basis-Fehler der Market-Data-Schicht (maschinenlesbarer Code). */
export class MarketDataError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Feed kennt das Instrument nicht / kann es nicht bedienen. */
export class FeedNotSupportedError extends MarketDataError {
  constructor(feedId: string, instrumentId: string, reason: string) {
    super(
      "FEED_NOT_SUPPORTED",
      `Feed "${feedId}" kann Instrument "${instrumentId}" nicht bedienen: ${reason}`
    );
  }
}

/** Ein Kurs wurde in der Normalisierung verworfen (Anomalie). */
export class AnomalousSnapshotError extends MarketDataError {
  constructor(instrumentId: string, reason: string) {
    super("ANOMALOUS_SNAPSHOT", `Kurs für "${instrumentId}" verworfen: ${reason}`);
  }
}

/** Konfigurationsfehler der Paper-Modi (z. B. Modus C ohne Capability). */
export class PaperConfigError extends MarketDataError {
  constructor(message: string) {
    super("PAPER_CONFIG_ERROR", message);
  }
}

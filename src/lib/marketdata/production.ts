/**
 * Produktions-Verdrahtung der Market-Data-Schicht (Task 03).
 *
 * Baut den `MarketDataManager` mit dem echten PAPER-Broker-Adapter als
 * Broker-Feed (Modus B) und injiziert den Ausführungs-Adapter in den
 * `PaperBroker`-Ledger (deterministischer Fill-Simulator).
 *
 * Diese Datei ist der EINZIGE Ort, der Factory + Manager verbindet — sie hält
 * Import-Zyklen aus dem Rest der Market-Data-Schicht heraus.
 */
import { createAdapter } from "../../brokers/factory";
import { PaperBroker, type ExecutedFill, type LiveQuote, type Order, type PaperExecutionAdapter } from "../broker";
import { FillSimulator } from "./simulator";
import { MarketDataManager, type MarketDataManagerOptions } from "./manager";
import type { MarketSnapshot } from "./types";

const G = globalThis as typeof globalThis & {
  __prodMarketDataManager?: MarketDataManager;
};

/** Baut den Produktions-Manager (Modus B, PAPER-Adapter als Broker-Feed). */
export function getProductionMarketDataManager(
  opts?: MarketDataManagerOptions
): MarketDataManager {
  if (!G.__prodMarketDataManager || opts) {
    const manager = new MarketDataManager({
      ...opts,
      brokerAdapter: opts?.brokerAdapter ?? createAdapter("PAPER", "paper"),
    });
    G.__prodMarketDataManager = manager;
  }
  return G.__prodMarketDataManager;
}

/** Setzt den Produktions-Manager (nur Tests). */
export function setProductionMarketDataManagerForTests(manager: MarketDataManager): void {
  G.__prodMarketDataManager = manager;
}

/** In-Memory-Ausführungs-Adapter über den Manager (Modus B). */
export function createPaperExecution(manager: MarketDataManager): PaperExecutionAdapter {
  const simulator = new FillSimulator(manager.config.simulator);
  return {
    quoteProvider(symbol: string): LiveQuote | null {
      const snap = manager.getSnapshotSync(symbol);
      if (!snap) return null;
      return {
        bid: snap.bid,
        ask: snap.ask,
        last: snap.last,
        spread: snap.spread,
        volume24h: snap.volume24h,
      };
    },
    execute(order: Order, quote: LiveQuote): ExecutedFill {
      const instrument = manager.resolveInstrument(order.symbol);
      if (!instrument) {
        return { filledQty: 0, fillPrice: 0, fees: 0, status: "REJECTED", reason: "UNKNOWN_INSTRUMENT" };
      }
      const snap: MarketSnapshot = {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        base: instrument.base,
        quote: instrument.quote,
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        ts: Date.now(),
        source: "cache",
        venue: instrument.venue,
        feed: "broker",
        spread: quote.spread,
        volume24h: quote.volume24h,
      };
      const f = simulator.simulate(
        { symbol: order.symbol, side: order.side, qty: order.qty },
        snap,
        instrument
      );
      return {
        filledQty: f.filledQty,
        fillPrice: f.fillPrice,
        fees: f.fees,
        status: f.status,
        reason: f.reason,
      };
    },
  };
}

/**
 * Injiziert den Modus-B-Ausführungs-Adapter in den Ledger (idempotent).
 * Wird einmal vom Engine-Einstiegspunkt aufgerufen.
 */
export function wirePaperExecution(broker: PaperBroker): void {
  if (broker.hasExecution()) return;
  const manager = getProductionMarketDataManager();
  broker.setExecution(createPaperExecution(manager));
}

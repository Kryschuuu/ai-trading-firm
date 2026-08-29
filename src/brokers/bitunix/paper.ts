/**
 * Lokales Paper-Ledger für den Bitunix-Adapter (Modus B).
 *
 * Echte Bitunix-Kurse, simulierte Fills, keine Private-API.
 * SL/TP werden am Fill vermerkt (Venue-Semantik vorbereitet), die
 * Ausführung selbst bleibt lokal.
 *
 * VEREINHEITLICHTE AUSFÜHRUNG (v1.21.0): Dieses Ledger verwendet NICHT mehr
 * eine eigene, vereinfachte Fill-Logik (früher: LONG → price·1.0001,
 * SHORT → price·0.9999). Stattdessen läuft JEDER Fill durch denselben
 * zentralen `FillSimulator` (`src/lib/marketdata/simulator.ts`) wie die
 * generische Paper-Execution — inklusive Spread, Slippage, Gebühren, Latenz und
 * Partial Fills. Der Bitunix-Ticker (nur Last-Preis) wird dazu über
 * `snapshotFromLastPrice` in einen normalisierten `MarketSnapshot` überführt.
 *
 * Ergebnis: Generic Paper === Bitunix Paper (dieselbe Ausführungs-Engine,
 * keine zweite Simulationslogik mehr).
 */
import { killSwitch, validateOrder } from "../../lib/riskGuard";
import { FillSimulator } from "../../lib/marketdata/simulator";
import { loadSimulatorConfig, type FillSimulatorConfig } from "../../lib/marketdata/config";
import { snapshotFromLastPrice, fallbackInstrument } from "../../lib/marketdata/snapshot";
import type { InstrumentRegistry } from "../../universe";
import type { MarketInstrument } from "../../universe/types";
import type {
  BrokerAccount,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  MarketTicker,
} from "../../contracts/broker";

interface Pos {
  qty: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** Konstruktions-Abhängigkeiten (injizierbar für deterministische Tests). */
export interface BitunixPaperLedgerDeps {
  /** Zentrale Simulator-Konfiguration (Default: aus Env). */
  simulatorConfig?: FillSimulatorConfig;
  /** Vorgefertigter Simulator (Vorrang vor `simulatorConfig`). */
  simulator?: FillSimulator;
  /** Registry zur Instrument-Auflösung (Gebühren-Felder); optional. */
  registry?: InstrumentRegistry;
}

export class BitunixPaperLedger {
  private cash: number;
  private readonly start: number;
  private readonly positions = new Map<string, Pos>();
  private seq = 0;
  private readonly config: FillSimulatorConfig;
  private readonly simulator: FillSimulator;
  private readonly registry?: InstrumentRegistry;

  constructor(startEquity = 10_000, deps: BitunixPaperLedgerDeps = {}) {
    this.cash = startEquity;
    this.start = startEquity;
    this.config = deps.simulatorConfig ?? loadSimulatorConfig();
    this.simulator = deps.simulator ?? new FillSimulator(this.config);
    this.registry = deps.registry;
  }

  getAccount(mark?: (symbol: string) => number | null): BrokerAccount {
    let mv = 0;
    for (const [sym, p] of this.positions) {
      const px = mark?.(sym) ?? p.entryPrice;
      mv += p.qty * px;
    }
    const equity = this.cash + mv;
    return {
      equity,
      cash: this.cash,
      openPositions: this.positions.size,
      startingEquity: this.start,
      drawdownPct: this.start > 0 ? Math.max(0, (this.start - equity) / this.start) : 0,
    };
  }

  listPositions(mark?: (symbol: string) => number | null): BrokerPosition[] {
    return [...this.positions.entries()].map(([symbol, p]) => {
      const last = mark?.(symbol) ?? p.entryPrice;
      return {
        symbol,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        lastPrice: last,
        unrealizedPnl: (p.side === "LONG" ? 1 : -1) * p.qty * (last - p.entryPrice),
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      };
    });
  }

  /**
   * Löst das Instrument (für die Gebühren-Felder des Simulators) aus der
   * Registry auf; fällt auf ein neutrales Fallback-Instrument zurück
   * (Gebühren dann aus der Simulator-Fallback-Konfiguration).
   */
  private resolveInstrument(symbol: string): MarketInstrument {
    const found = this.registry?.find("BITUNIX", symbol) ?? null;
    return found ?? fallbackInstrument("BITUNIX", symbol);
  }

  submit(req: BrokerOrderRequest, ticker: MarketTicker): BrokerOrderResult {
    const symbol = req.symbol.toUpperCase();
    const reject = (reason: string): BrokerOrderResult => ({
      orderId: `REJ-BX-${this.seq++}`,
      symbol,
      side: req.side,
      qty: req.qty,
      fillPrice: 0,
      status: "REJECTED",
      reason,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    });

    if (killSwitch.isArmed()) return reject("KILL_SWITCH_ARMED");
    if (!Number.isFinite(req.qty) || req.qty <= 0) return reject("INVALID_QTY");
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) return reject(`NO_QUOTE:${symbol}`);
    if (this.positions.has(symbol)) return reject(`POSITION_ALREADY_OPEN:${symbol}`);

    const hasStopLoss = req.stopLoss !== undefined && req.stopLoss !== null;
    if (hasStopLoss && (!Number.isFinite(req.stopLoss as number) || (req.stopLoss as number) <= 0)) {
      return reject("INVALID_STOP_LOSS");
    }

    const equity = this.getAccount(() => ticker.price).equity;
    const guard = validateOrder({
      notional: req.riskNotional,
      equity,
      openPositions: this.positions.size,
      side: req.side,
      leverage: 1,
      hasStopLoss,
      symbol,
    });
    if (!guard.allowed) return reject(guard.reason);

    // Vereinheitlichte Ausführung: Ticker → normalisierter Snapshot → zentraler
    // Fill-Simulator (Spread, Slippage, Gebühren, Latenz, Partial Fills).
    const instrument = this.resolveInstrument(symbol);
    const snapshot = snapshotFromLastPrice({
      symbol,
      last: ticker.price,
      spread: this.config.syntheticSpreadBps / 10_000,
      volume24h: ticker.quoteVol ?? instrument.volume24h ?? null,
      venue: "BITUNIX",
      base: instrument.base,
      quote: instrument.quote,
      instrumentId: instrument.id,
      ts: ticker.ts,
      source: "broker",
      feed: "bitunix",
    });
    const sim = this.simulator.simulate(
      { symbol, side: req.side, qty: req.qty },
      snapshot,
      instrument
    );
    if (sim.status === "REJECTED" || sim.filledQty <= 0) {
      return reject(sim.reason ?? "SIM_REJECTED");
    }

    const filledQty = sim.filledQty;
    const fillPrice = sim.fillPrice;
    const cost = filledQty * fillPrice + sim.fees;
    if (cost > this.cash + 1e-9) return reject("INSUFFICIENT_CASH");

    this.positions.set(symbol, {
      qty: filledQty,
      side: req.side,
      entryPrice: fillPrice,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    });
    this.cash -= cost;
    return {
      orderId: `PAP-BX-${Date.now().toString(36).toUpperCase()}-${this.seq++}`,
      symbol,
      side: req.side,
      qty: filledQty,
      fillPrice,
      status: "FILLED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }
}

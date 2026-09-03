/**
 * Lokales Paper-Ledger für den Alpaca-Adapter (Modus B).
 *
 * Echte Alpaca-Kurse (über den Public-Client), simulierte Fills, keine
 * Private-API. SL/TP werden am Fill vermerkt, die Ausführung bleibt lokal.
 *
 * VEREINHEITLICHTE AUSFÜHRUNG: Dieses Ledger verwendet — analog zum Bitunix-
 * Paper-Ledger — den zentralen `FillSimulator`
 * (`src/lib/marketdata/simulator.ts`) für die Fill-Berechnung. Damit sind
 * Alpaca Paper und Generic Paper (soweit Daten vorhanden) verhaltensgleich.
 */
import { killSwitch, validateOrder, riskValidationReason } from "../../lib/riskGuard";
import { FillSimulator } from "../../lib/marketdata/simulator";
import { loadSimulatorConfig, type FillSimulatorConfig } from "../../lib/marketdata/config";
import { snapshotFromLastPrice, fallbackInstrument } from "../../lib/marketdata/snapshot";
import type { InstrumentRegistry } from "../../universe";
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

export interface AlpacaPaperLedgerDeps {
  simulatorConfig?: FillSimulatorConfig;
  simulator?: FillSimulator;
  registry?: InstrumentRegistry;
}

/**
 * Lokales Paper-Ledger für Alpaca — verarbeitet Orders, verwaltet Cash +
 * Positionen, berechnet Fills mit dem zentralen Simulator.
 */
export class AlpacaPaperLedger {
  private cash: number;
  private readonly start: number;
  private readonly positions = new Map<string, Pos>();
  private seq = 0;
  private readonly config: FillSimulatorConfig;
  private readonly simulator: FillSimulator;
  private readonly registry?: InstrumentRegistry;

  constructor(startEquity = 10_000, deps: AlpacaPaperLedgerDeps = {}) {
    this.cash = startEquity;
    this.start = startEquity;
    this.config = deps.simulatorConfig ?? loadSimulatorConfig();
    this.simulator = deps.simulator ?? new FillSimulator(this.config);
    this.registry = deps.registry;
  }

  getAccount(mark?: (symbol: string) => number | null): BrokerAccount {
    let mv = 0;
    let unrealizedPnl = 0;
    for (const [sym, p] of this.positions) {
      const px = mark?.(sym) ?? p.entryPrice;
      mv += p.qty * px;
      unrealizedPnl += (p.side === "LONG" ? 1 : -1) * p.qty * (px - p.entryPrice);
    }
    const equity = this.cash + mv;
    return {
      equity,
      cash: this.cash,
      // H8: Kanonische Zerlegung — Paper-Ledger ist ein voll besichertes
      // Cash-Konto (kein Margin): walletBalance = Cash + Einstandswerte
      // (= equity − unrealizedPnl; realisiertes PnL liegt im Cash), freie
      // Cash = cash, gebundene Margin = 0.
      walletBalance: equity - unrealizedPnl,
      availableCash: this.cash,
      usedMargin: 0,
      maintenanceMargin: 0,
      unrealizedPnl,
      openPositions: this.positions.size,
      startingEquity: this.start,
      drawdownPct: this.start > 0 ? Math.max(0, (this.start - equity) / this.start) : 0,
    };
  }

  listPositions(mark?: (symbol: string) => number | null): BrokerPosition[] {
    const out: BrokerPosition[] = [];
    for (const [sym, p] of this.positions) {
      const px = mark?.(sym) ?? p.entryPrice;
      out.push({
        symbol: sym,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        lastPrice: px,
        unrealizedPnl: p.side === "LONG" ? (px - p.entryPrice) * p.qty : (p.entryPrice - px) * p.qty,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      });
    }
    return out;
  }

  /**
   * Verarbeitet eine Order. Reihenfolge:
   *   Kill-Switch → Input-Validierung → Guardrails (validateOrder) →
   *   Fill-Simulation → Cash-Check → Position-Update.
   */
  submit(req: BrokerOrderRequest, ticker: MarketTicker): BrokerOrderResult {
    const symbol = req.symbol.toUpperCase();
    const reject = (reason: string): BrokerOrderResult => ({
      orderId: this.makeOrderId(),
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
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) return reject(`NO_QUOTE:${ticker.symbol}`);
    // H1 FIX: riskNotional wird validiert, aber nicht vertraut — server-seitig aus qty*Preis berechnen
    if (!Number.isFinite(req.riskNotional) || req.riskNotional <= 0) return reject("INVALID_NOTIONAL");
    const hasStopLoss = req.stopLoss !== undefined && req.stopLoss !== null;
    if (hasStopLoss && (!Number.isFinite(req.stopLoss as number) || (req.stopLoss as number) <= 0)) {
      return reject("INVALID_STOP_LOSS");
    }

    // H1: Server-seitige Notional-Berechnung (qty * Preis)
    const estimatedNotional = req.qty * ticker.price;
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) return reject("INVALID_ESTIMATED_NOTIONAL");

    const equity = this.getAccount(() => ticker.price).equity;
    // H9: Ungültige Zahlen (NaN/Infinity/≤0) lassen validateOrder fail-closed
    // werfen — übersetzen in einen REJECTED-Fill (INVALID_EQUITY etc.).
    let guard;
    try {
      guard = validateOrder({
        notional: estimatedNotional,
        equity,
        openPositions: this.positions.size,
        side: req.side,
        leverage: 1,
        hasStopLoss,
        symbol,
      });
    } catch (e) {
      return reject(riskValidationReason(e));
    }
    if (!guard.allowed) return reject(guard.reason);
    // Vorab-Cash-Guard mit konservativer Schätzung (0.1% Slippage-Puffer)
    const estimatedSlippage = estimatedNotional * 0.001;
    const requiredCashEstimate = estimatedNotional + estimatedSlippage;
    if (requiredCashEstimate > this.cash + 1e-9) return reject("INSUFFICIENT_CASH");

    // Zentrale Fill-Berechnung
    const inst = this.registry?.get(`ALPACA:${symbol}`) ?? fallbackInstrument("ALPACA", symbol);
    const snap = snapshotFromLastPrice({
      symbol: ticker.symbol,
      last: ticker.price,
      spread: this.config.syntheticSpreadBps / 10_000,
      volume24h: ticker.quoteVol ?? inst.volume24h ?? null,
      venue: "ALPACA",
      base: inst.base ?? symbol,
      quote: inst.quote ?? "USD",
      instrumentId: inst.id,
      ts: ticker.ts,
      source: "broker",
      feed: "alpaca",
    });
    const simulated = this.simulator.simulate(
      { symbol, side: req.side, qty: req.qty },
      snap,
      inst
    );
    if (simulated.status === "REJECTED" || simulated.fillPrice <= 0 || simulated.filledQty <= 0) {
      return reject(simulated.reason ?? "SIM_REJECTED");
    }

    // Cash-Check (vereinfacht: Marktwert = Notional + Fees)
    const cost = simulated.fillPrice * simulated.filledQty + simulated.fees;
    if (cost > this.cash + 1e-9) return reject("INSUFFICIENT_CASH");

    // Position aktualisieren (vereinfacht: schließen oder eröffnen)
    const existing = this.positions.get(symbol);
    if (existing && existing.side === req.side) {
      // Nachkauf in gleicher Richtung
      const totalQty = existing.qty + simulated.filledQty;
      const blended = (existing.entryPrice * existing.qty + simulated.fillPrice * simulated.filledQty) / totalQty;
      this.positions.set(symbol, {
        qty: totalQty,
        side: req.side,
        entryPrice: blended,
        stopLoss: req.stopLoss ?? existing.stopLoss,
        takeProfit: req.takeProfit ?? existing.takeProfit,
      });
    } else if (existing && existing.side !== req.side) {
      // Reverse → Position schließen (vereinfacht: nur exakte qty)
      if (Math.abs(existing.qty - simulated.filledQty) < 1e-9) {
        const pnl = existing.side === "LONG"
          ? (simulated.fillPrice - existing.entryPrice) * existing.qty
          : (existing.entryPrice - simulated.fillPrice) * existing.qty;
        this.cash += pnl;
        this.positions.delete(symbol);
      } else {
        return reject("POSITION_REVERSE_QTY_MISMATCH");
      }
    } else {
      // Neue Position
      this.positions.set(symbol, {
        qty: simulated.filledQty,
        side: req.side,
        entryPrice: simulated.fillPrice,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      });
    }
    this.cash -= cost;

    return {
      orderId: this.makeOrderId(),
      symbol,
      side: req.side,
      qty: simulated.filledQty,
      fillPrice: simulated.fillPrice,
      status: simulated.status === "PARTIALLY_FILLED" ? "FILLED" : "FILLED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }

  private makeOrderId(): string {
    this.seq += 1;
    return `PAP-ALP-${Date.now().toString(36)}-${this.seq}`;
  }
}

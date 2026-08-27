/**
 * Lokales Paper-Ledger für den Bitunix-Adapter (Modus B).
 *
 * Echte Bitunix-Kurse, simulierte Fills, keine Private-API.
 * SL/TP werden am Fill vermerkt (Venue-Semantik vorbereitet), die
 * Ausführung selbst bleibt lokal.
 */
import { killSwitch, validateOrder } from "../../lib/riskGuard";
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

export class BitunixPaperLedger {
  private cash: number;
  private readonly start: number;
  private readonly positions = new Map<string, Pos>();
  private seq = 0;

  constructor(startEquity = 10_000) {
    this.cash = startEquity;
    this.start = startEquity;
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

    const fillPrice = req.side === "LONG" ? ticker.price * 1.0001 : ticker.price * 0.9999;
    const cost = req.qty * fillPrice;
    if (cost > this.cash + 1e-9) return reject("INSUFFICIENT_CASH");

    this.positions.set(symbol, {
      qty: req.qty,
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
      qty: req.qty,
      fillPrice,
      status: "FILLED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }
}

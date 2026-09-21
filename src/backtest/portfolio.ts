/**
 * Multi-Asset Backtest — Portfolio-Manager (Task 02).
 *
 * Verwaltet den dynamischen Kontozustand über den Zeitverlauf:
 *   - Cash, offene Positionen und Mark-to-Market-Eigenkapital
 *   - Einhaltung von Guardrails: maxOpenPositions, maxPositionPct, maxRiskPerTrade
 *   - Aufzeichnung der kontinuierlichen Equity-Kurve
 */

import type {
  BacktestEngineConfig,
  BacktestEquityPoint,
  BacktestOpenPosition,
  BacktestTradeLog,
  TradeExitReason,
} from "./types";
import type { CandleLike } from "../lib/ruleEngine";
import type { SimulatedFill, ExitEvaluation } from "./simulator";

export class BacktestPortfolio {
  private cash: number;
  private readonly initialCapital: number;
  private readonly config: BacktestEngineConfig;
  private readonly positions = new Map<string, BacktestOpenPosition>();
  private readonly closedTrades: BacktestTradeLog[] = [];
  private readonly equityHistory: BacktestEquityPoint[] = [];

  private peakEquity: number;
  private realizedPnl = 0;
  private totalFees = 0;
  private totalSlippage = 0;
  /** Kumuliertes Funding (nur „paper“-Pfad; Kontosicht: negativ = gezahlt). */
  private totalFunding = 0;
  private posSeq = 1;

  constructor(config: BacktestEngineConfig) {
    this.config = config;
    this.initialCapital = config.initialCapital;
    this.cash = config.initialCapital;
    this.peakEquity = config.initialCapital;
  }

  get currentCash(): number {
    return this.cash;
  }

  get openPositionsCount(): number {
    return this.positions.size;
  }

  get openPositionsList(): BacktestOpenPosition[] {
    return Array.from(this.positions.values());
  }

  /** Offene Position eines Symbols (RMA-P1-01: Order-Lifecycle-Zugriff). */
  getOpenPosition(symbol: string): BacktestOpenPosition | null {
    return this.positions.get(symbol) ?? null;
  }

  get trades(): BacktestTradeLog[] {
    return this.closedTrades;
  }

  get equityCurve(): BacktestEquityPoint[] {
    return this.equityHistory;
  }

  get feesPaid(): number {
    return this.totalFees;
  }

  get slippagePaid(): number {
    return this.totalSlippage;
  }

  get fundingPaidTotal(): number {
    return this.totalFunding;
  }

  /**
   * Berechnet das aktuelle Mark-to-Market-Eigenkapital anhand aktueller Kurse.
   */
  computeCurrentEquity(currentPrices: Map<string, number>): number {
    let openNotional = 0;
    let unrealized = 0;

    for (const pos of this.positions.values()) {
      const price = currentPrices.get(pos.symbol) ?? pos.entryPrice;
      const posPnl =
        pos.side === "LONG"
          ? pos.qty * (price - pos.entryPrice)
          : pos.qty * (pos.entryPrice - price);

      pos.unrealizedPnl = Number(posPnl.toFixed(4));
      unrealized += pos.unrealizedPnl;
      openNotional += pos.qty * price;
    }

    const equity = this.cash + openNotional;
    return Number(equity.toFixed(4));
  }

  /**
   * Prüft, ob ein neues Signal das Portfolio-Risiko und die Limits einhält.
   */
  canOpenPosition(
    symbol: string,
    currentEquity: number
  ): { allowed: boolean; reason?: string } {
    if (this.positions.has(symbol)) {
      return { allowed: false, reason: `POSITION_ALREADY_OPEN:${symbol}` };
    }

    if (this.positions.size >= this.config.maxOpenPositions) {
      return { allowed: false, reason: "MAX_OPEN_POSITIONS_REACHED" };
    }

    if (this.cash <= currentEquity * 0.05) {
      return { allowed: false, reason: "INSUFFICIENT_CASH_BUFFER" };
    }

    return { allowed: true };
  }

  /**
   * Errechnet die allokierbare Positionsgröße basierend auf Stop-Loss und Risikobudget.
   */
  calculatePositionSize(
    currentEquity: number,
    entryPrice: number,
    stopLossPrice: number | null,
    riskBudgetPct?: number,
    maxPosPctOverride?: number
  ): number {
    const riskPct = riskBudgetPct ?? this.config.maxRiskPerTrade;
    const maxPosPct = maxPosPctOverride ?? this.config.maxPositionPct;

    // Maximales Notional nach Portfoliogröße
    const maxNotionalCap = currentEquity * maxPosPct;

    if (stopLossPrice !== null && stopLossPrice > 0) {
      const stopDistancePct = Math.abs(entryPrice - stopLossPrice) / entryPrice;
      if (stopDistancePct > 0.0001) {
        // Notional = Risikobetrag / Stop-Distanz
        const riskAmount = currentEquity * riskPct;
        const riskBasedNotional = riskAmount / stopDistancePct;
        const desiredNotional = Math.min(riskBasedNotional, maxNotionalCap);
        return Math.min(desiredNotional, this.cash * 0.95);
      }
    }

    // Fallback ohne Stop-Loss: direkt auf maxNotionalCap / Cash
    return Math.min(maxNotionalCap, this.cash * 0.95);
  }

  /**
   * Bucht eine neu eröffnete Position ein.
   */
  openPosition(
    strategyId: string,
    symbol: string,
    side: "LONG" | "SHORT",
    fill: SimulatedFill,
    candle: CandleLike,
    barIndex: number,
    stopLoss: number | null,
    takeProfit: number | null
  ): BacktestOpenPosition {
    const id = `POS-${this.posSeq++}`;
    const notional = fill.qty * fill.fillPrice;

    // Cash abziehen (Kaufpreis + Gebühren)
    this.cash -= notional + fill.fees;
    this.totalFees += fill.fees;
    this.totalSlippage += fill.slippage;

    const position: BacktestOpenPosition = {
      id,
      strategyId,
      symbol,
      side,
      entryTime: candle.time,
      entryBarIndex: barIndex,
      entryPrice: fill.fillPrice,
      qty: fill.qty,
      notional: Number(notional.toFixed(4)),
      stopLoss,
      takeProfit,
      unrealizedPnl: 0,
      highestPrice: fill.fillPrice,
      lowestPrice: fill.fillPrice,
      feesPaid: fill.fees,
      slippagePaid: fill.slippage,
      fundingPaid: 0,
    };

    this.positions.set(symbol, position);
    return position;
  }

  /**
   * Erhöht eine bestehende Position um einen weiteren Entry-Fill
   * (RMA-P1-01, v1.58.0; nur `"event_replay"`-Pfad: eine Entry-Order füllt
   * über mehrere Kerzen). Entry-Preis wird mengen­gewichtet gemittelt;
   * Cash/Fees/Slippage werden wie bei `openPosition` gebucht. Fail-closed:
   * unbekanntes Symbol oder nicht endliche Werte ⇒ `false`, keine Buchung.
   */
  increasePosition(
    symbol: string,
    fill: SimulatedFill
  ): boolean {
    const pos = this.positions.get(symbol);
    if (!pos) return false;
    if (
      !Number.isFinite(fill.qty) || fill.qty <= 0 ||
      !Number.isFinite(fill.fillPrice) || fill.fillPrice <= 0 ||
      !Number.isFinite(fill.fees) || fill.fees < 0 ||
      !Number.isFinite(fill.slippage) || fill.slippage < 0
    ) {
      return false;
    }
    const addNotional = fill.qty * fill.fillPrice;
    this.cash -= addNotional + fill.fees;
    this.totalFees += fill.fees;
    this.totalSlippage += fill.slippage;

    const newQty = pos.qty + fill.qty;
    pos.entryPrice = (pos.entryPrice * pos.qty + fill.fillPrice * fill.qty) / newQty;
    pos.qty = newQty;
    pos.notional = Number((pos.notional + addNotional).toFixed(4));
    pos.feesPaid += fill.fees;
    pos.slippagePaid += fill.slippage;
    pos.highestPrice = Math.max(pos.highestPrice, fill.fillPrice);
    pos.lowestPrice = Math.min(pos.lowestPrice, fill.fillPrice);
    return true;
  }

  /**
   * Bucht einen PARTIELLEN Exit-Fill (RMA-P1-01, v1.58.0; nur
   * `"event_replay"`-Pfad). Die Position bleibt mit Restmenge OFFEN —
   * der Trade wird erst in `finalizeReplayPosition` geschlossen, wenn die
   * Restmenge 0 ist. Cash erhält den Erlös minus Gebühren sofort; der
   * realisierte Brutto-PnL der geschlossenen Menge wird gegen den
   * (mengengewichteten) Entry-Preis kumuliert. Fail-closed: unbekanntes
   * Symbol, `qty ≤ 0`, `qty > pos.qty` (über Toleranz) oder nicht endliche
   * Werte ⇒ `false`, keine Buchung — ein Fill kann nie mehr schließen, als
   * offen ist.
   */
  applyPartialExit(
    symbol: string,
    fill: { qty: number; price: number; fees: number; slippage: number }
  ): boolean {
    const pos = this.positions.get(symbol);
    if (!pos) return false;
    if (
      !Number.isFinite(fill.qty) || fill.qty <= 0 ||
      !Number.isFinite(fill.price) || fill.price <= 0 ||
      !Number.isFinite(fill.fees) || fill.fees < 0 ||
      !Number.isFinite(fill.slippage) || fill.slippage < 0
    ) {
      return false;
    }
    // Mengen-Guard: nie mehr schließen, als offen ist (kleine Float-Toleranz).
    if (fill.qty > pos.qty * (1 + 1e-9)) return false;
    const qty = Math.min(fill.qty, pos.qty);

    const proceeds = qty * fill.price;
    const grossPartial =
      pos.side === "LONG" ? qty * (fill.price - pos.entryPrice) : qty * (pos.entryPrice - fill.price);

    this.cash += proceeds - fill.fees;
    this.totalFees += fill.fees;
    this.totalSlippage += fill.slippage;

    pos.qty = Math.max(0, pos.qty - qty);
    pos.closedQty = (pos.closedQty ?? 0) + qty;
    pos.exitNotional = (pos.exitNotional ?? 0) + proceeds;
    pos.realizedGrossPnl = (pos.realizedGrossPnl ?? 0) + grossPartial;
    pos.exitFees = (pos.exitFees ?? 0) + fill.fees;
    pos.exitSlippage = (pos.exitSlippage ?? 0) + fill.slippage;
    return true;
  }

  /**
   * Schließt eine per Partial Exits vollständig abgebaute Position als EINEN
   * Trade-Log-Eintrag (RMA-P1-01, v1.58.0; nur `"event_replay"`-Pfad).
   * Voraussetzung: `pos.qty ≈ 0` und `closedQty > 0` — sonst `null` (die
   * Position bleibt unangetastet offen, nie ein halbfertiger Trade).
   *
   * Exit-Preis = mengengewichteter Fill-VWAP (`exitNotional / closedQty`);
   * damit gilt exakt `pnlGross = closedQty × (VWAP − entry)` (LONG) — die
   * Trade-Ledger-Identität (`tradeLedger.ts`) bleibt reproduzierbar.
   */
  finalizeReplayPosition(
    symbol: string,
    exitTime: number,
    currentBarIndex: number,
    reason: TradeExitReason
  ): BacktestTradeLog | null {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    const closedQty = pos.closedQty ?? 0;
    if (pos.qty > closedQty * 1e-9 + 1e-12 || closedQty <= 0) return null;

    const exitNotional = pos.exitNotional ?? 0;
    const exitPrice = exitNotional / closedQty;
    const grossPnl = pos.realizedGrossPnl ?? 0;
    const totalTradeFees = pos.feesPaid + (pos.exitFees ?? 0);
    const tradeFunding = pos.fundingPaid ?? 0;
    const netPnl = grossPnl - totalTradeFees + tradeFunding;
    this.realizedPnl += netPnl;

    const durationBars = Math.max(1, currentBarIndex - pos.entryBarIndex);
    const durationMs = Math.max(0, exitTime - pos.entryTime);

    const tradeLog: BacktestTradeLog = {
      id: pos.id,
      strategyId: pos.strategyId,
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: closedQty,
      notional: pos.notional,
      pnl: Number(netPnl.toFixed(4)),
      pnlPct: Number(((netPnl / pos.notional) * 100).toFixed(4)),
      fees: Number(totalTradeFees.toFixed(4)),
      slippage: Number((pos.slippagePaid + (pos.exitSlippage ?? 0)).toFixed(4)),
      funding: Number(tradeFunding.toFixed(8)),
      exitReason: reason,
      durationBars,
      durationMs,
    };

    this.closedTrades.push(tradeLog);
    this.positions.delete(symbol);
    return tradeLog;
  }

  /**
   * Schließt eine bestehende Position und verbucht den realisierten PnL.
   */
  closePosition(
    symbol: string,
    exitEval: ExitEvaluation,
    exitTime: number,
    currentBarIndex: number
  ): BacktestTradeLog | null {
    const pos = this.positions.get(symbol);
    if (!pos) return null;

    const exitNotional = pos.qty * exitEval.exitPrice;
    const grossPnl =
      pos.side === "LONG"
        ? pos.qty * (exitEval.exitPrice - pos.entryPrice)
        : pos.qty * (pos.entryPrice - exitEval.exitPrice);

    const totalTradeFees = pos.feesPaid + exitEval.fees;
    // Funding wurde laufend auf Cash gebucht (applyFunding) ⇒ schmälert den
    // Trade-PnL exakt einmal (Kontosicht: gezahlt = negativ = Abzug).
    const tradeFunding = pos.fundingPaid ?? 0;
    const netPnl = grossPnl - totalTradeFees + tradeFunding;

    // Cash gutschreiben (Verkaufserlös minus Ausstiegsgebühren)
    this.cash += exitNotional - exitEval.fees;
    this.realizedPnl += netPnl;
    this.totalFees += exitEval.fees;
    this.totalSlippage += exitEval.slippage;

    const durationBars = Math.max(1, currentBarIndex - pos.entryBarIndex);
    const durationMs = Math.max(0, exitTime - pos.entryTime);

    const tradeLog: BacktestTradeLog = {
      id: pos.id,
      strategyId: pos.strategyId,
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice: exitEval.exitPrice,
      qty: pos.qty,
      notional: pos.notional,
      pnl: Number(netPnl.toFixed(4)),
      pnlPct: Number(((netPnl / pos.notional) * 100).toFixed(4)),
      fees: Number(totalTradeFees.toFixed(4)),
      slippage: Number((pos.slippagePaid + exitEval.slippage).toFixed(4)),
      funding: Number(tradeFunding.toFixed(8)),
      exitReason: exitEval.reason,
      durationBars,
      durationMs,
    };

    this.closedTrades.push(tradeLog);
    this.positions.delete(symbol);
    return tradeLog;
  }

  /**
   * Schreibt einen Snapshot der aktuellen Equity-Kurve.
   */
  recordSnapshot(timestamp: number, currentPrices: Map<string, number>): BacktestEquityPoint {
    const equity = this.computeCurrentEquity(currentPrices);
    this.peakEquity = Math.max(this.peakEquity, equity);

    const drawdownPct =
      this.peakEquity > 0
        ? Number((((this.peakEquity - equity) / this.peakEquity) * 100).toFixed(4))
        : 0;

    let openNotional = 0;
    let unrealized = 0;
    for (const pos of this.positions.values()) {
      const p = currentPrices.get(pos.symbol) ?? pos.entryPrice;
      const posPnl =
        pos.side === "LONG"
          ? pos.qty * (p - pos.entryPrice)
          : pos.qty * (pos.entryPrice - p);
      unrealized += posPnl;
      openNotional += pos.qty * p;
    }

    const exposurePct =
      equity > 0 ? Number(((openNotional / equity) * 100).toFixed(2)) : 0;

    const point: BacktestEquityPoint = {
      timestamp,
      equity,
      cash: Number(this.cash.toFixed(4)),
      openPositions: this.positions.size,
      exposurePct,
      unrealizedPnl: Number(unrealized.toFixed(4)),
      realizedPnl: Number(this.realizedPnl.toFixed(4)),
      drawdownPct,
    };

    this.equityHistory.push(point);
    return point;
  }

  /**
   * Bucht einen Funding-Accrual auf eine offene Position (nur „paper“-Pfad).
   *
   * Wie `PaperBroker.accrueFunding`: sofortiger Cashflow (Kontosicht —
   * negativ = gezahlt ⇒ Cash sinkt) + kumulierter Positions-Saldo. Der
   * Trade-PnL beim Close enthält das Funding exakt einmal (siehe
   * `closePosition`); `totalFunding` speist `metrics.totalFundingPaid`.
   * Nicht-endliche Beträge und unbekannte Symbole werden fail-closed
   * abgewiesen (keine NaN-Buchung ins Ledger).
   */
  applyFunding(symbol: string, funding: number): boolean {
    if (!Number.isFinite(funding)) return false;
    const pos = this.positions.get(symbol);
    if (!pos) return false;
    pos.fundingPaid = Number(((pos.fundingPaid ?? 0) + funding).toFixed(8));
    this.cash = Number((this.cash + funding).toFixed(8));
    this.totalFunding = Number((this.totalFunding + funding).toFixed(8));
    return true;
  }

  /**
   * Schließt alle noch offenen Positionen am Ende des Backtests.
   *
   * `exitFill` (nur „paper“-Pfad): löst den Ausstiegs-Fill je Position
   * durch den Paper-Simulator auf; fehlt er, gilt die Legacy-Rechnung
   * (Close-Kurs + Taker-Fee, Slippage 0).
   */
  closeAllAtEnd(
    currentPrices: Map<string, number>,
    finalTimestamp: number,
    finalBarIndex: number,
    exitFill?: (pos: BacktestOpenPosition, price: number) => ExitEvaluation | null
  ): void {
    for (const pos of Array.from(this.positions.values())) {
      const price = currentPrices.get(pos.symbol) ?? pos.entryPrice;
      const paperEval = exitFill ? exitFill(pos, price) : null;
      if (paperEval) {
        this.closePosition(pos.symbol, paperEval, finalTimestamp, finalBarIndex);
        continue;
      }
      const fees = pos.qty * price * this.config.feeModel.takerFee;

      const exitEval: ExitEvaluation = {
        triggered: true,
        exitPrice: price,
        reason: "END_OF_DATA",
        fees,
        slippage: 0,
      };

      this.closePosition(pos.symbol, exitEval, finalTimestamp, finalBarIndex);
    }
  }
}

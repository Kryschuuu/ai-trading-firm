/**
 * ExecutionPort — die Trennung von Paper- und Broker-Ausführung (Task 12).
 *
 * Analog zum Bitunix-Pattern: der Alpaca-Adapter delegiert ALLE ausführenden
 * Operationen an eine `ExecutionPort`-Implementierung. Paper-Ledger und
 * echter Broker-Executor sind ZWEI verschiedene Implementierungen desselben
 * Ports — sie sind austauschbar und niemals vermischt.
 *
 *   ExecutionMode
 *    ├── paper / backtest ─► PaperExecutionEngine  (lokales Ledger, 0 Private-Calls)
 *    └── testnet / live   ─► BrokerExecutionEngine (echte Venue-API, Basic-Auth)
 *                             └── live: LiveGate vor jedem Call (adapter.ts)
 */
import type {
  BrokerAccount,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  MarketTicker,
} from "../../contracts/broker";
import type { ExecutionMode } from "../../contracts/broker";
import { killSwitch, validateOrder, riskValidationReason } from "../../lib/riskGuard";
import { serializePlaceOrder, clientOrderIdFor } from "./orders";
import { mapAccount, mapOrderResult, mapPosition } from "./mapping";
import { AlpacaPaperLedger } from "./paper";
import type { AlpacaPrivateClient } from "./privateClient";
import { recordAlpacaPrivateCall } from "./audit";

/** Optionaler Mark-Preis-Lookup (Symbol → Preis) für das Paper-Ledger. */
export type MarkPriceFn = (symbol: string) => number | null;

/** Der Ausführungs-Port. Jeder Execution-Modus wird über eine Implementierung bedient. */
export interface ExecutionPort {
  readonly mode: ExecutionMode;
  submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult>;
  getAccount(mark?: MarkPriceFn): Promise<BrokerAccount>;
  listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]>;
}

/** PAPER-/BACKTEST-Engine — umhüllt das lokale `AlpacaPaperLedger`. */
export class PaperExecutionEngine implements ExecutionPort {
  readonly mode: ExecutionMode = "paper";
  constructor(private readonly ledger: AlpacaPaperLedger) {}

  async submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult> {
    return this.ledger.submit(req, ticker);
  }

  async getAccount(mark?: MarkPriceFn): Promise<BrokerAccount> {
    return this.ledger.getAccount(mark);
  }

  async listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]> {
    return this.ledger.listPositions(mark);
  }
}

/** BROKER-Engine — umhüllt den signierten `AlpacaPrivateClient`. */
export class BrokerExecutionEngine implements ExecutionPort {
  readonly mode: ExecutionMode = "live";
  private readonly ledger: AlpacaPaperLedger;

  constructor(
    private readonly client: AlpacaPrivateClient,
    ledger?: AlpacaPaperLedger
  ) {
    // Lokales Read-Only-Ledger für mark-Preise (nicht fürs Trading im Live-Modus).
    this.ledger = ledger ?? new AlpacaPaperLedger(0);
  }

  async submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult> {
    // H1 FIX: riskNotional nie vertrauen — server-seitig aus qty*Preis neu berechnen.
    if (!Number.isFinite(req.qty) || req.qty <= 0) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: "INVALID_QTY",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "INVALID_QTY" });
      return out;
    }
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: `NO_QUOTE:${req.symbol.toUpperCase()}`,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "NO_QUOTE" });
      return out;
    }
    if (!Number.isFinite(req.riskNotional) || req.riskNotional <= 0) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: "INVALID_NOTIONAL",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "INVALID_NOTIONAL" });
      return out;
    }
    const estimatedNotional = req.qty * ticker.price;
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: "INVALID_ESTIMATED_NOTIONAL",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "INVALID_ESTIMATED_NOTIONAL" });
      return out;
    }
    // Guardrails gegen echte Konto-Equity (vorher fehlte diese Prüfung komplett — H1)
    let account: import("../../contracts/broker").BrokerAccount;
    try {
      account = await this.getAccount();
    } catch (e) {
      const code = e instanceof Error ? e.message.slice(0, 40) : "ACCOUNT_FETCH_FAILED";
      const out: BrokerOrderResult = {
        orderId: "ERROR",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: code,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "ERROR", errorCode: code });
      return out;
    }
    const hasStopLoss = req.stopLoss !== undefined && req.stopLoss !== null;
    // H9: validateOrder wirft bei NaN/Infinity/≤0 fail-closed (RiskValidationError)
    // — eine kaputte Venue-Equity darf eine echte Order niemals zulassen.
    let guard;
    try {
      guard = validateOrder({
        notional: estimatedNotional,
        equity: account.equity,
        openPositions: account.openPositions,
        side: req.side,
        leverage: 1,
        hasStopLoss,
        symbol: req.symbol.toUpperCase(),
      });
    } catch (e) {
      const reason = riskValidationReason(e);
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: reason.slice(0, 40) });
      return out;
    }
    if (!guard.allowed) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: guard.reason,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: guard.reason.slice(0, 40) });
      return out;
    }
    const requiredCashEstimate = estimatedNotional * 1.002;
    if (requiredCashEstimate > account.cash + 1e-9) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: "INSUFFICIENT_CASH",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "INSUFFICIENT_CASH" });
      return out;
    }
    if (killSwitch.isArmed()) {
      const out: BrokerOrderResult = {
        orderId: "KILLED",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: "KILL_SWITCH_ARMED",
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "DENIED", errorCode: "KILL_SWITCH_ARMED" });
      return out;
    }

    const alpacaReq = serializePlaceOrder(req);
    const idem = clientOrderIdFor(req);
    let rawOrder;
    try {
      rawOrder = await this.client.placeOrder(alpacaReq, idem);
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "OK", errorCode: null });
    } catch (e) {
      const code = e instanceof Error ? e.message.slice(0, 40) : "ALPACA_ERROR";
      await recordAlpacaPrivateCall({ method: "POST", path: "/v2/orders", outcome: "ERROR", errorCode: code });
      return {
        orderId: "ERROR",
        symbol: req.symbol,
        side: req.side,
        qty: 0,
        fillPrice: 0,
        status: "REJECTED",
        reason: code,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
      };
    }

    return mapOrderResult(rawOrder, req.qty);
  }

  async getAccount(mark?: MarkPriceFn): Promise<BrokerAccount> {
    try {
      const acc = await this.client.getAccount();
      await recordAlpacaPrivateCall({ method: "GET", path: "/v2/account", outcome: "OK", errorCode: null });
      // openPositions wird aus den Positionen gezogen
      const positions = await this.safeGetPositions();
      return { ...mapAccount(acc, this.ledgerStartEquity()), openPositions: positions.length };
    } catch (e) {
      const code = e instanceof Error ? e.message.slice(0, 40) : "ALPACA_ERROR";
      await recordAlpacaPrivateCall({ method: "GET", path: "/v2/account", outcome: "ERROR", errorCode: code });
      throw e;
    }
  }

  async listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]> {
    const positions = await this.safeGetPositions();
    return positions
      .map(mapPosition)
      .filter((p): p is BrokerPosition => p !== null);
  }

  private async safeGetPositions(): Promise<import("./types").AlpacaPosition[]> {
    try {
      const pos = await this.client.getPositions();
      await recordAlpacaPrivateCall({ method: "GET", path: "/v2/positions", outcome: "OK", errorCode: null });
      return pos;
    } catch (e) {
      const code = e instanceof Error ? e.message.slice(0, 40) : "ALPACA_ERROR";
      await recordAlpacaPrivateCall({ method: "GET", path: "/v2/positions", outcome: "ERROR", errorCode: code });
      return [];
    }
  }

  private ledgerStartEquity(): number {
    // Für mapAccount als Fallback; im Live-Modus wird der Wert aus dem Broker
    // überschrieben. Hier nur, damit der Drawdown berechenbar bleibt.
    return 100000;
  }
}

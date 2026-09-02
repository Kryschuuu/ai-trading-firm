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
import { killSwitch } from "../../lib/riskGuard";
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
    // Defense in Depth: Kill-Switch unmittelbar vor der echten Order.
    // (Order-Validierung entfällt hier, weil das lokale Read-Only-Ledger
    // equity=0 hat — die Live-Broker-Engine validiert über das echte
    // Broker-Konto, und für Paper/Backtest läuft die Engine NICHT hier.)
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

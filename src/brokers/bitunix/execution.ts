/**
 * ExecutionPort — die Trennung von Paper- und Broker-Ausführung (Task 07/11-Refactor).
 *
 * Architekturziel: Der Bitunix-Adapter delegiert ALLE ausführenden Operationen an
 * eine `ExecutionPort`-Implementierung. Paper-Ledger und echter Broker-Executor
 * sind ZWEI verschiedene Implementierungen desselben Ports — sie sind austauschbar
 * und niemals vermischt.
 *
 *   ExecutionMode
 *    ├── paper / backtest ─► PaperExecutionEngine  (lokales Ledger, 0 Private-Calls)
 *    └── testnet / live   ─► BrokerExecutionEngine (echte Venue-API, signiert)
 *                             └── live: LiveGate vor jedem Call (adapter.ts)
 *
 * Diese Trennung macht es unmöglich, dass ein freigeschalteter Live-Pfad versehentlich
 * gegen das lokale Paper-Ledger handelt (Regression aus der ersten Task-07-Fassung):
 * der Live-Pfad greift ausschließlich auf `BrokerExecutionEngine` zu.
 */
import type {
  BrokerAccount,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  MarketTicker,
} from "../../contracts/broker";
import type { ExecutionMode } from "../../contracts/broker";
import { killSwitch, validateOrder } from "../../lib/riskGuard";
import { serializePlaceOrder } from "./orders";
import type { BitunixPaperLedger } from "./paper";
import type { BitunixPrivateClient } from "./privateClient";

/** Optionaler Mark-Preis-Lookup (Symbol → Preis) für das Paper-Ledger. */
export type MarkPriceFn = (symbol: string) => number | null;

/**
 * Der Ausführungs-Port. Jeder Execution-Modus des Bitunix-Adapters wird über
 * genau eine Implementierung dieses Ports bedient. Der Adapter kennt NUR dieses
 * Interface — nie direkt `BitunixPaperLedger` oder `BitunixPrivateClient`.
 */
export interface ExecutionPort {
  /** Für welche Modi diese Engine zuständig ist (paper/testnet/live). */
  readonly mode: ExecutionMode;
  /**
   * Führt eine Order aus. `ticker` ist der aktuelle Kurs (Paper: Fill-Referenz;
   * live: wird nicht für Fills, sondern nur als Kontext übergeben).
   */
  submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult>;
  /** Liefert den Kontozustand dieser Engine (paper: lokal, live: Venue). */
  getAccount(mark?: MarkPriceFn): Promise<BrokerAccount>;
  /** Liefert die offenen Positionen dieser Engine (paper: lokal, live: Venue). */
  listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]>;
}

/**
 * PAPER-/BACKTEST-Engine — umhüllt das lokale `BitunixPaperLedger`.
 *
 * Echte Public-Kurse, simulierte Fills, KEIN signierter Request. Wird ausschließlich
 * im Modus `paper`/`backtest` verwendet. Der Live-Pfad darf diese Engine NIE erreichen.
 */
export class PaperExecutionEngine implements ExecutionPort {
  readonly mode: ExecutionMode = "paper";
  constructor(private readonly ledger: BitunixPaperLedger) {}

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

/**
 * BROKER-Engine — umhüllt den signierten `BitunixPrivateClient`.
 *
 * Echte Venue-Daten: Account/Positions kommen von der Private-API, Orders werden
 * über `placeSerializedOrder` gesendet. Im Modus `live` prüft der Adapter VOR jedem
 * Call das Live-Gate; diese Engine prüft zusätzlich UNMITTELBAR vor dem Senden den
 * prozessweiten Kill-Switch und die Code-Guardrails (riskGuard) gegen die echte
 * Konto-Equity — Defense in Depth am Engpass, fail-closed.
 */
export class BrokerExecutionEngine implements ExecutionPort {
  readonly mode: ExecutionMode = "live";
  private rejSeq = 1;
  constructor(private readonly privateClient: BitunixPrivateClient) {}

  private reject(req: BrokerOrderRequest, reason: string): BrokerOrderResult {
    return {
      orderId: `REJ-BX-LIVE-${this.rejSeq++}`,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      qty: req.qty,
      fillPrice: 0,
      status: "REJECTED",
      reason,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }

  async submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult> {
    // HARTE SCHUTZKETTE VOR JEDER ECHTEN ORDER (Parität zum Paper-Ledger):
    // 1. Prozessweiter Not-Halt (riskGuard.killSwitch, /api/firm/kill) — der
    //    Live-Pfad darf NIE weniger geschützt sein als der Paper-Pfad.
    if (killSwitch.isArmed()) {
      return this.reject(req, "KILL_SWITCH_ARMED");
    }
    // 2. Guardrails gegen die ECHTE Konto-Equity und die ECHTEN offenen
    //    Positionen der Venue. Fail-closed: scheitert der Abruf, wird die
    //    Order NICHT gesendet (der Fehler propagiert laut nach oben).
    const account = await this.getAccount();
    const hasStopLoss = req.stopLoss !== undefined && req.stopLoss !== null;
    const guard = validateOrder({
      notional: req.riskNotional,
      equity: account.equity,
      openPositions: account.openPositions,
      side: req.side,
      leverage: 1,
      hasStopLoss,
      symbol: req.symbol.toUpperCase(),
    });
    if (!guard.allowed) {
      return this.reject(req, guard.reason);
    }
    const body = serializePlaceOrder(req);
    const { orderId } = await this.privateClient.placeSerializedOrder(body);
    return {
      orderId,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      qty: req.qty,
      // Live-Fills werden asynchron (Positionen/Status) abgeglichen; der
      // synchrone Rückgabe-Fill ist hier nicht verfügbar → 0, Status FILLED
      // (Venue hat die Order akzeptiert). Kein Paper-Kurs wird als Fill gemeldet.
      fillPrice: 0,
      status: "FILLED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }

  async getAccount(): Promise<BrokerAccount> {
    const account = await this.privateClient.getAccount();
    const positions = await this.privateClient.getPositions();
    // openPositions aus der echten Venue-Positionen ableiten — niemals 0 raten.
    return { ...account, openPositions: positions.length };
  }

  async listPositions(): Promise<BrokerPosition[]> {
    return this.privateClient.getPositions();
  }
}

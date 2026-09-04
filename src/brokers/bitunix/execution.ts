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
  BrokerOrderStatus,
  BrokerPosition,
  EmergencyCancelResult,
  EmergencyCloseFill,
  MarketTicker,
} from "../../contracts/broker";
import type { ExecutionMode } from "../../contracts/broker";
import { isBookableFill } from "../../contracts/broker";
import { killSwitch, validateOrder, riskValidationReason } from "../../lib/riskGuard";
import { serializePlaceOrder } from "./orders";
import type { BitunixPaperLedger } from "./paper";
import { mapBitunixOrderStatus, type BitunixPrivateClient } from "./privateClient";

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
  /**
   * H3: Fill-Reconciliation für Live-Orders. `submit` liefert live nur die
   * AKZEPTANZ (Status NEW); hier wird danach der echte Venue-Status/Fill
   * abgefragt. Liefert null, wenn die Engine keine Reconciliation kennt
   * (Paper: synchroner Fill, nichts abzugleichen).
   */
  reconcile?(orderId: string): Promise<BrokerOrderResult | null>;
  /** Liefert den Kontozustand dieser Engine (paper: lokal, live: Venue). */
  getAccount(mark?: MarkPriceFn): Promise<BrokerAccount>;
  /** Liefert die offenen Positionen dieser Engine (paper: lokal, live: Venue). */
  listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]>;
  /**
   * H7 (v1.36.20): Notfall-Pfad des Kill-Switch. Optional, weil die
   * Paper-Engine keinen echten Venue-Notfall kennt (synchroner Fill, keine
   * offenen Orders). Live-Engines implementieren cancel → close → verify.
   */
  cancelAllOpenOrders?(): Promise<EmergencyCancelResult>;
  closeAllPositions?(reason: string): Promise<EmergencyCloseFill[]>;
  verifyFlat?(): Promise<boolean>;
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
  /**
   * H3: Kontext versendeter Orders (orderId → Anfrage), damit `reconcile`
   * einen vollständigen BrokerOrderResult bauen kann. Das Venue-Detail trägt
   * nicht alle Felder (SL/TP), und die Reconciliation darf raten nichts.
   */
  private readonly openOrders = new Map<
    string,
    { symbol: string; side: "LONG" | "SHORT"; qty: number; stopLoss: number | null; takeProfit: number | null }
  >();

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
    // H1 FIX: riskNotional nicht vertrauen — server-seitig aus qty*Preis berechnen
    if (!Number.isFinite(req.qty) || req.qty <= 0) return this.reject(req, "INVALID_QTY");
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) return this.reject(req, `NO_QUOTE:${req.symbol.toUpperCase()}`);
    if (!Number.isFinite(req.riskNotional) || req.riskNotional <= 0) return this.reject(req, "INVALID_NOTIONAL");
    const estimatedNotional = req.qty * ticker.price;
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
      return this.reject(req, "INVALID_ESTIMATED_NOTIONAL");
    }
    // 2. Guardrails gegen die ECHTE Konto-Equity und die ECHTEN offenen
    //    Positionen der Venue. Fail-closed: scheitert der Abruf, wird die
    //    Order NICHT gesendet (der Fehler propagiert laut nach oben).
    const account = await this.getAccount();
    const hasStopLoss = req.stopLoss !== undefined && req.stopLoss !== null;
    // H9: validateOrder wirft bei NaN/Infinity/≤0 fail-closed (RiskValidationError)
    // — eine kaputte Venue-Equity darf eine echte Live-Order niemals zulassen.
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
      return this.reject(req, riskValidationReason(e));
    }
    if (!guard.allowed) {
      return this.reject(req, guard.reason);
    }
    // Cash-Guard gegen tatsächliche Kosten (inkl. Gebühren/Slippage-Puffer 0.2%)
    const requiredCashEstimate = estimatedNotional * 1.002;
    if (requiredCashEstimate > account.cash + 1e-9) {
      return this.reject(req, "INSUFFICIENT_CASH");
    }
    const body = serializePlaceOrder(req);
    const { orderId } = await this.privateClient.placeSerializedOrder(body);
    // H3 FIX: Die Venue-Annahme ist KEIN Fill. Wir melden ausschließlich die
    // AKZEPTANZ (Status NEW, fillPrice 0). Der echte Fill wird asynchron über
    // reconcile() (getOrder + getExecutions) ermittelt — eine Position wird
    // erst mit einem echten avgPrice (>0) eingebucht, nie mit Entry 0.
    this.openOrders.set(orderId, {
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      qty: req.qty,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    });
    return {
      orderId,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      qty: req.qty,
      filledQty: 0,
      fillPrice: 0,
      status: "NEW",
      reason: "ORDER_ACCEPTED",
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
    };
  }

  /**
   * H3: Fill-Reconciliation. Fragt Order-Detail UND Ausführungen (Trades) von
   * der Venue ab und baut aus den ECHTEN Fills den BrokerOrderResult:
   *
   *   NEW              → keine Trades, fillPrice 0 (darf nichts einbuchen)
   *   PARTIALLY_FILLED → Teilmenge gefüllt; avgPrice = mengen-gewichteter
   *                      Mittelwert der Trades (>0)
   *   FILLED           → vollständig gefüllt; avgPrice > 0
   *   CANCELED         → storniert (ggf. Teilfills)
   *   UNKNOWN          → Order nicht auffindbar oder Füllpreis nicht belegbar
   *
   * Fail-safe: ist kein echter avgPrice belegbar (keine Trades, Preis 0),
   * wird nie FILLED mit fillPrice 0 gemeldet — dann UNKNOWN (kein Fill).
   */
  async reconcile(orderId: string): Promise<BrokerOrderResult | null> {
    const ctx = this.openOrders.get(orderId);
    const order = await this.privateClient.getOrder(orderId).catch(() => null);
    // Order weder lokal noch beim Venue bekannt → nichts zu sagen.
    if (!order && !ctx) return null;

    const symbol = order?.symbol || ctx?.symbol || "";
    const side: "LONG" | "SHORT" = order?.side ?? ctx?.side ?? "LONG";
    const qty = order?.qty || ctx?.qty || 0;
    const stopLoss = ctx?.stopLoss ?? null;
    const takeProfit = ctx?.takeProfit ?? null;

    const base: BrokerOrderResult = {
      orderId,
      symbol,
      side,
      qty,
      filledQty: 0,
      fillPrice: 0,
      status: "UNKNOWN",
      stopLoss,
      takeProfit,
    };

    if (!order) {
      // Order-ID versandt, aber beim Venue nicht (mehr) auffindbar (Timeout/
      // Netz nach place_order). Status NICHT raten → UNKNOWN (fail-safe).
      return { ...base, reason: "ORDER_NOT_FOUND" };
    }

    // Echte Trades holen (gefiltert auf Order). avgPrice wird IMMER aus den
    // Trades belegt — niemals aus einem geratenen Limit-/Marktpreis.
    const trades = await this.privateClient
      .getExecutions(symbol || undefined, orderId)
      .then((all) => all.filter((t) => t.orderId === orderId))
      .catch(() => []);
    const filledQty = trades.reduce((sum, t) => sum + t.qty, 0);
    const notional = trades.reduce((sum, t) => sum + t.qty * t.price, 0);
    const avgPrice = filledQty > 0 && notional > 0 ? notional / filledQty : order.avgPrice;

    const status: BrokerOrderStatus = mapBitunixOrderStatus(order.status);

    switch (status) {
      case "NEW":
        // Akzeptiert, noch keine Fills — nichts einbuchen.
        return { ...base, filledQty: 0, fillPrice: 0, status: "NEW", reason: "ORDER_ACCEPTED" };
      case "PARTIALLY_FILLED":
      case "FILLED": {
        // Ein Füllstatus OHNE belegbaren avgPrice ist unglaubwürdig → UNKNOWN.
        if (!Number.isFinite(avgPrice) || avgPrice <= 0 || filledQty <= 0) {
          return {
            ...base,
            filledQty: order.filledQty > 0 ? order.filledQty : filledQty,
            status: "UNKNOWN",
            reason: "FILL_PRICE_UNKNOWN",
          };
        }
        return {
          ...base,
          // filledQty bevorzugt aus den Trades, sonst die Venue-Angabe.
          filledQty: filledQty > 0 ? filledQty : order.filledQty,
          fillPrice: avgPrice,
          status,
        };
      }
      case "CANCELED":
        return {
          ...base,
          filledQty: filledQty > 0 ? filledQty : order.filledQty,
          fillPrice: Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : 0,
          status: "CANCELED",
          reason: "ORDER_CANCELED",
        };
      default:
        return { ...base, status: "UNKNOWN", reason: `VENUE_STATUS:${order.status}` };
    }
  }

  async getAccount(): Promise<BrokerAccount> {
    const account = await this.privateClient.getAccount();
    // openPositions aus den übernehmbaren Venue-Positionen ableiten — über
    // dieselbe H3-Filterung wie listPositions (keine 0-Entry-Scheinpositionen).
    const positions = await this.listPositions();
    return { ...account, openPositions: positions.length };
  }

  async listPositions(): Promise<BrokerPosition[]> {
    // H3: Positionen werden vom Venue übernommen — ABER nur mit einem echten
    // Entry-Preis. Ein 0-Entry (Fill noch nicht gespiegelt) darf nie als
    // Position eingebucht werden; solche Zeilen werden verworfen.
    const positions = await this.privateClient.getPositions();
    return positions.filter(
      (p) => Number.isFinite(p.entryPrice) && p.entryPrice > 0 && Number.isFinite(p.qty) && p.qty > 0
    );
  }

  // ── H7 (v1.36.20): Kill-Switch-Notfall auf Venue-Ebene ─────────────────────
  // cancel → close → verify. Diese Methoden sind der LIVE-Gegenpart zum
  // EmergencyBroker des Paper-Ledgers — ein Not-Halt schließt hier die ECHTEN
  // Venue-Positionen, nicht die Simulation.

  /** H7: Storniert alle offenen Venue-Orders (cancel_all_orders). */
  async cancelAllOpenOrders(): Promise<EmergencyCancelResult> {
    const res = await this.privateClient.cancelAllOrders();
    return { canceled: res.successList.length };
  }

  /**
   * H7: Schließt alle offenen Venue-Positionen (close_all_position).
   * Die Engines „rät“ NIE Fill-Preise/PnL — `close_all_position` liefert
   * keine Fills; die Belegung der Glattheit übernimmt `verifyFlat()`. Als
   * Fills werden die zuletzt bekannten Positionen (Letztkurs) gemeldet,
   * damit der Audit die betroffenen Symbole nennen kann.
   */
  async closeAllPositions(reason: string): Promise<EmergencyCloseFill[]> {
    const known = await this.listPositions();
    if (known.length === 0) return [];
    await this.privateClient.closeAllPositions();
    return known.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      fillPrice: Number.isFinite(p.lastPrice) && p.lastPrice > 0 ? p.lastPrice : 0,
      realizedPnl: 0,
    }));
  }

  /** H7: 0 offene Venue-Positionen? (Quelle der Wahrheit nach dem Close). */
  async verifyFlat(): Promise<boolean> {
    const positions = await this.listPositions();
    return positions.length === 0;
  }
}

/**
 * H3: Entscheidungs-Hilfe für Caller: Darf dieses Ergebnis eine Position
 * einbuchen? Nur ein vollständig gefüllter Fill mit belegtem avgPrice > 0.
 * (Dünne Kapselung des Contract-Helfers für die Broker-Schicht.)
 */
export function resultIsBookable(result: BrokerOrderResult): boolean {
  return isBookableFill(result);
}

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
import { BrokerError } from "../../contracts/broker";
import type {
  BrokerAccount,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  EmergencyCancelResult,
  EmergencyCloseFill,
  MarketTicker,
} from "../../contracts/broker";
import type { ExecutionMode } from "../../contracts/broker";
import { killSwitch, validateOrder, riskValidationReason } from "../../lib/riskGuard";
import { serializePlaceOrder, clientOrderIdFor } from "./orders";
import { buildClientOrderId } from "../reconciliation";
import { mapAccount, mapOrderResult, mapPosition } from "./mapping";
import { AlpacaPaperLedger } from "./paper";
import type { AlpacaPrivateClient } from "./privateClient";
import type { AlpacaPosition } from "./types";
import { AlpacaApiError } from "./errors";
import { ALPACA_TRADE_PATHS } from "./config";
import { recordAlpacaPrivateCall } from "./audit";

function parsePositionNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

/** Nur ein vollständiger, erkennbarer offener Datensatz darf als Position zählen. */
function isValidAlpacaPosition(value: unknown): value is AlpacaPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return (
    typeof position.symbol === "string" &&
    position.symbol.trim().length > 0 &&
    (position.side === "long" || position.side === "short") &&
    Math.abs(parsePositionNumber(position.qty)) > 0 &&
    parsePositionNumber(position.avg_entry_price) > 0
  );
}

function auditErrorCode(error: unknown): string {
  if (error instanceof BrokerError) return error.code.slice(0, 40);
  if (error instanceof Error) return error.name.slice(0, 40) || "ALPACA_ERROR";
  return "ALPACA_ERROR";
}

/** Optionaler Mark-Preis-Lookup (Symbol → Preis) für das Paper-Ledger. */
export type MarkPriceFn = (symbol: string) => number | null;

/** Der Ausführungs-Port. Jeder Execution-Modus wird über eine Implementierung bedient. */
export interface ExecutionPort {
  readonly mode: ExecutionMode;
  submit(req: BrokerOrderRequest, ticker: MarketTicker): Promise<BrokerOrderResult>;
  getAccount(mark?: MarkPriceFn): Promise<BrokerAccount>;
  listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]>;
  /**
   * H7 (v1.36.20): Notfall-Pfad des Kill-Switch (nur Live-Engines).
   */
  cancelAllOpenOrders?(): Promise<EmergencyCancelResult>;
  closeAllPositions?(reason: string): Promise<EmergencyCloseFill[]>;
  verifyFlat?(): Promise<boolean>;
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
    // GAP-09: deterministische clientOrderId aus req oder orderIntentId
    const idem =
      req.clientOrderId ??
      (req.orderIntentId ? buildClientOrderId(req.orderIntentId) : clientOrderIdFor(req));
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
      // openPositions aus einer strikten Venue-Abfrage ableiten; API-Ausfälle
      // dürfen keine scheinbar leere Exposure-/Risiko-Sicht erzeugen.
      const positions = await this.fetchPositionsStrict();
      return { ...mapAccount(acc, this.ledgerStartEquity()), openPositions: positions.length };
    } catch (e) {
      await recordAlpacaPrivateCall({
        method: "GET",
        path: ALPACA_TRADE_PATHS.account,
        outcome: "ERROR",
        errorCode: auditErrorCode(e),
      }).catch(() => undefined);
      throw e;
    }
  }

  async listPositions(mark?: MarkPriceFn): Promise<BrokerPosition[]> {
    const positions = await this.fetchPositionsStrict();
    const mapped = positions.map(mapPosition);
    if (mapped.some((position) => position === null)) {
      throw new AlpacaApiError("unknown", "Alpaca /v2/positions enthält einen ungültigen Positionsdatensatz.");
    }
    return mapped as BrokerPosition[];
  }

  /**
   * Fail-closed Venue-Snapshot. HTTP- und Validierungsfehler werden nicht
   * absorbiert; ein fehlerhafter Datensatz darf niemals als „flat“ gelten.
   */
  private async fetchPositionsStrict(): Promise<AlpacaPosition[]> {
    let positions: AlpacaPosition[];
    try {
      const raw: unknown = await this.client.getPositions();
      if (!Array.isArray(raw) || !raw.every(isValidAlpacaPosition)) {
        throw new AlpacaApiError("unknown", "Alpaca /v2/positions lieferte eine ungültige Positionsliste.");
      }
      positions = raw;
    } catch (e) {
      await recordAlpacaPrivateCall({
        method: "GET",
        path: ALPACA_TRADE_PATHS.positions,
        outcome: "ERROR",
        errorCode: auditErrorCode(e),
      }).catch(() => undefined);
      throw e;
    }
    await recordAlpacaPrivateCall({
      method: "GET",
      path: ALPACA_TRADE_PATHS.positions,
      outcome: "OK",
      errorCode: null,
    });
    return positions;
  }

  private ledgerStartEquity(): number {
    // Für mapAccount als Fallback; im Live-Modus wird der Wert aus dem Broker
    // überschrieben. Hier nur, damit der Drawdown berechenbar bleibt.
    return 100000;
  }

  // ── H7 (v1.36.20): Kill-Switch-Notfall auf Venue-Ebene ─────────────────────
  // cancel → close → verify über die echte Alpaca-Trade-API. Die Glattheit
  // wird mit `verifyFlat()` (getPositions == 0) belegt, nie geraten.

  /** H7: Storniert alle offenen Alpaca-Orders (`DELETE /v2/orders`). */
  async cancelAllOpenOrders(): Promise<EmergencyCancelResult> {
    const canceled = await this.client.cancelAllOrders();
    return { canceled: canceled.length };
  }

  /** H7: Schließt alle offenen Alpaca-Positionen (`DELETE /v2/positions`). */
  async closeAllPositions(_reason: string): Promise<EmergencyCloseFill[]> {
    // 1) Cancel ist best-effort: ein Audit-Eintrag darf den Close-Pfad nicht blockieren.
    try {
      await this.client.cancelAllOrders();
    } catch (e) {
      await recordAlpacaPrivateCall({
        method: "DELETE",
        path: ALPACA_TRADE_PATHS.orders,
        outcome: "ERROR",
        errorCode: auditErrorCode(e),
      }).catch(() => undefined);
    }

    // 2) Nur Statistik/Fill-Kontext. Bei Ausfall trotzdem zwingend liquidieren.
    const before = await this.fetchPositionsStrict().catch(() => null);

    // 3) Unbedingt DELETE senden, auch bei leerer oder unbekannter Vorab-Liste.
    // 4) Danach immer den Venue-Zustand nachlesen; HTTP 207 ist kein Flat-Beweis.
    let closeFailed = false;
    let closeError: unknown;
    try {
      await this.client.closeAllPositions();
    } catch (e) {
      closeFailed = true;
      closeError = e;
      await recordAlpacaPrivateCall({
        method: "DELETE",
        path: ALPACA_TRADE_PATHS.positions,
        outcome: "ERROR",
        errorCode: auditErrorCode(e),
      }).catch(() => undefined);
    }
    const after = await this.fetchPositionsStrict();
    if (closeFailed) throw closeError;

    // Nur Positionen, die der strikte Nach-Snapshot nicht mehr enthält, werden
    // als geschlossen gemeldet. Unbekannte/übrige Positionen bleiben offen.
    const stillOpen = new Set(after.map((position) => `${position.symbol.toUpperCase()}:${position.side}`));
    const confirmedClosed = (before ?? []).filter(
      (position) => !stillOpen.has(`${position.symbol.toUpperCase()}:${position.side}`)
    );
    const fills: EmergencyCloseFill[] = [];
    for (const raw of confirmedClosed) {
      const position = mapPosition(raw);
      if (!position) {
        throw new AlpacaApiError("unknown", "Alpaca /v2/positions enthält einen ungültigen Positionsdatensatz.");
      }
      fills.push({
        symbol: position.symbol,
        side: position.side,
        qty: position.qty,
        fillPrice: Number.isFinite(position.lastPrice) && position.lastPrice > 0 ? position.lastPrice : 0,
        realizedPnl: position.unrealizedPnl,
      });
    }
    return fills;
  }

  /** H7: 0 offene Alpaca-Positionen? API-Fehler werden fail-closed geworfen. */
  async verifyFlat(): Promise<boolean> {
    const positions = await this.fetchPositionsStrict();
    return positions.length === 0;
  }
}

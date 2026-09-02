/**
 * Order-Validierung und -Serialisierung (Task 12).
 *
 * Brücke zwischen dem broker-unabhängigen `BrokerOrderRequest` und dem
 * Alpaca-OrderRequest-Schema. Hält Alpaca-Constraints (Market = day, Limit =
 * day/gtc, etc.) und die Idempotenz-Key-Bildung zentral.
 *
 * Idempotenz: Alpaca empfiehlt `client_order_id` (max 48 Zeichen,
 * alphanumerisch) als Idempotenz-Key auf Broker-Seite. Wir bauen ihn aus
 * Symbol + Side + Qty + timestamp-Derivat — verhindert Doppel-Orders auch
 * wenn der Adapter einen Retry versucht (was er bei POST NICHT tut — aber
 * Defense in Depth).
 */
import { AlpacaApiError, safeSnippet } from "./errors";
import type { AlpacaOrderRequest } from "./types";
import type { BrokerOrderRequest } from "../../contracts/broker";

const SYMBOL_RE = /^[A-Z0-9/.\-]{1,24}$/;

export class OrderSerializationError extends AlpacaApiError {
  constructor(message: string) {
    super("validation", `Alpaca-Order ungültig: ${message}`);
  }
}

/** Erzeugt einen alpaca-konformen client_order_id (max 48 alphanumerisch, uppercase). */
export function makeClientOrderId(prefix: string, ts: number = Date.now()): string {
  // Beispiel: "ALP-BTCUSD-LONG-000100-1700000000000-A3C9"
  const tsPart = String(ts);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const raw = `${prefix}-${tsPart}-${rand}`;
  return raw.replace(/[^A-Z0-9]/g, "").slice(0, 48);
}

/**
 * Brücke BrokerOrderRequest → AlpacaOrderRequest.
 *
 * Wichtig:
 *   - LONG → side=buy, SHORT → side=sell
 *   - limitPrice definiert order_type (LIMIT vs MARKET)
 *   - stopLoss/takeProfit werden als Bracket-Legs serialisiert
 *     (nur sinnvoll bei Market-Orders auf Alpaca)
 */
export function serializePlaceOrder(req: BrokerOrderRequest, ts: number = Date.now()): AlpacaOrderRequest {
  if (!req.symbol || typeof req.symbol !== "string") {
    throw new OrderSerializationError("Symbol fehlt.");
  }
  const symbol = req.symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    throw new OrderSerializationError(`Symbol ungültig: ${safeSnippet(req.symbol)}`);
  }
  if (!Number.isFinite(req.qty) || req.qty <= 0) {
    throw new OrderSerializationError(`qty muss > 0 sein (got ${safeSnippet(req.qty)}).`);
  }
  if (req.side !== "LONG" && req.side !== "SHORT") {
    throw new OrderSerializationError(`side muss LONG/SHORT sein (got ${safeSnippet(req.side)}).`);
  }

  const side: "buy" | "sell" = req.side === "LONG" ? "buy" : "sell";
  const hasLimit = req.limitPrice != null && Number.isFinite(req.limitPrice);
  const hasSL = req.stopLoss != null && Number.isFinite(req.stopLoss) && req.stopLoss > 0;
  const hasTP = req.takeProfit != null && Number.isFinite(req.takeProfit) && req.takeProfit > 0;

  const out: AlpacaOrderRequest = {
    symbol,
    side,
    qty: req.qty,
    type: hasLimit ? "limit" : "market",
    time_in_force: "day",
  };
  if (hasLimit && req.limitPrice != null) out.limit_price = req.limitPrice;
  if (hasSL || hasTP) {
    out.order_class = "bracket";
    if (hasTP && req.takeProfit != null) {
      out.take_profit = { limit_price: req.takeProfit };
    }
    if (hasSL && req.stopLoss != null) {
      out.stop_loss = { stop_price: req.stopLoss };
    }
  }

  return out;
}

/** JSON-Form der Alpaca-Order (für Tests / Logging). */
export function serializePlaceOrderJson(req: BrokerOrderRequest, ts: number = Date.now()): string {
  return JSON.stringify(serializePlaceOrder(req, ts));
}

/** Idempotenz-Key-Helper. */
export function clientOrderIdFor(req: BrokerOrderRequest, ts: number = Date.now()): string {
  return makeClientOrderId(`${req.symbol.replace(/[^A-Z0-9]/gi, "")}-${req.side}-${req.qty.toFixed(6)}`, ts);
}

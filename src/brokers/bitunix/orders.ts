/**
 * Order-Serialisierung für Bitunix Place-Order (Task 07).
 *
 * SL/TP gehören an die Venue-Schicht (`stopAtVenue=true`): Die Parameter
 * `slPrice`/`tpPrice` (plus Stop-Typ und Order-Typ) gehen in denselben
 * `POST /api/v1/futures/trade/place_order`-Aufruf. Ein nur lokaler Monitor
 * würde bei Netzausfall/Liquidation nicht greifen.
 *
 * Dieses Modul sendet NICHTS — es serialisiert nur. Der Live-Pfad darf
 * das Ergebnis nicht absetzen (Gate).
 */
import type { BrokerOrderRequest } from "../../contracts/broker";
import type { BitunixPlaceOrderBody } from "./types";

const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export class OrderSerializationError extends Error {
  readonly code = "BITUNIX_ORDER_SERIALIZE";
  constructor(message: string) {
    super(message);
    this.name = "OrderSerializationError";
  }
}

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Mappt den broker-unabhängigen Order-Request auf den Bitunix-Body.
 *
 * Stop-Typ laut Parameter-Tabelle: `LAST_PRICE` (Beispiele der Doku nutzen
 * gelegentlich `"MARK"` — wir folgen der Tabelle, dokumentiert in BITUNIX.md).
 */
export function serializePlaceOrder(req: BrokerOrderRequest): BitunixPlaceOrderBody {
  const symbol = typeof req.symbol === "string" ? req.symbol.trim().toUpperCase() : "";
  if (!SYMBOL_RE.test(symbol)) {
    throw new OrderSerializationError(`Ungültiges Symbol (${String(req.symbol).slice(0, 24)})`);
  }
  if (!finitePositive(req.qty)) {
    throw new OrderSerializationError("qty muss eine endliche Zahl > 0 sein");
  }
  if (req.side !== "LONG" && req.side !== "SHORT") {
    throw new OrderSerializationError("side muss LONG oder SHORT sein");
  }

  const body: BitunixPlaceOrderBody = {
    symbol,
    qty: String(req.qty),
    side: req.side === "LONG" ? "BUY" : "SELL",
    tradeSide: "OPEN",
    orderType: finitePositive(req.limitPrice) ? "LIMIT" : "MARKET",
  };
  if (finitePositive(req.limitPrice)) {
    body.price = String(req.limitPrice);
    body.effect = "GTC";
  }
  if (finitePositive(req.takeProfit)) {
    body.tpPrice = String(req.takeProfit);
    body.tpStopType = "LAST_PRICE";
    body.tpOrderType = "MARKET";
  }
  if (finitePositive(req.stopLoss)) {
    body.slPrice = String(req.stopLoss);
    body.slStopType = "LAST_PRICE";
    body.slOrderType = "MARKET";
  }
  return body;
}

/** Kompakter JSON-Body (Signatur-identisch). */
export function serializePlaceOrderJson(req: BrokerOrderRequest): string {
  return JSON.stringify(serializePlaceOrder(req));
}

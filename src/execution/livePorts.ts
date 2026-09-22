/**
 * Live-Venue-Ports des Execution-Policy-Controllers (RMA-P4-02).
 *
 * Dünne Adapter von `VenueExecutionPort` auf die bestehenden signierten
 * Private-Clients (`BitunixPrivateClient`, `AlpacaPrivateClient`). Sie senden
 * NUR, wenn der Aufrufer (Controller + Gates + Live-Gate) sie aufruft — sie
 * enthalten selbst keine Trading-Entscheidung, kein Retry und kein
 * Quote-Raten. Alle Venue-Fehlertexte werden auf geschlossene Codes abgebildet
 * (`classifyPlaceReject`, `CancelReasonCode`); Rohtexte erreichen weder Audit-
 * Detail noch Metriken als Freitext.
 *
 * Cancel-Semantik je Venue:
 *   - Bitunix: `cancel_orders` + Verify via `get_order_detail`. Die
 *     Annahme-Antwort beweist NICHTS (Venue-Doku) — erst Status CANCELED ist
 *     CONFIRMED; alles andere bleibt UNKNOWN und blockiert den Fallback.
 *   - Alpaca: `DELETE /v2/orders/{id}` + Verify via GET. `pending_cancel` ist
 *     ein Übergangszustand (UNKNOWN), kein Beweis.
 */
import type { BrokerOrderRequest } from "../contracts/broker";
import { executionCapabilitiesFor, type VenueExecutionCapabilities } from "./capabilities";
import {
  classifyPlaceReject,
  type CancelOutcome,
  type OrderView,
  type PlaceMarketArgs,
  type PlaceOrderArgs,
  type PlaceOutcome,
  type PortFill,
  type VenueExecutionPort,
  type VenueOrderStatus,
} from "./ports";
import { serializePlaceOrder as serializeBitunixOrder } from "../brokers/bitunix/orders";
import {
  mapBitunixOrderStatus,
  type BitunixPrivateClient,
} from "../brokers/bitunix/privateClient";
import { serializePlaceOrder as serializeAlpacaOrder } from "../brokers/alpaca/orders";
import type { AlpacaPrivateClient } from "../brokers/alpaca/privateClient";

function baseRequest(symbol: string, side: "LONG" | "SHORT", qty: number, price: number): BrokerOrderRequest {
  return { symbol, side, qty, riskNotional: qty * price };
}

// ── Bitunix ──────────────────────────────────────────────────────────────────

export class BitunixVenuePort implements VenueExecutionPort {
  readonly venue = "BITUNIX" as const;
  private readonly now: () => number;

  constructor(
    private readonly client: BitunixPrivateClient,
    deps: { now?: () => number } = {}
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  getCapabilities(): VenueExecutionCapabilities {
    return executionCapabilitiesFor(this.venue);
  }

  async placeLimitOrder(args: PlaceOrderArgs): Promise<PlaceOutcome> {
    const req: BrokerOrderRequest = {
      ...baseRequest(args.symbol, args.side, args.qty, args.limitPrice),
      limitPrice: args.limitPrice,
      postOnly: args.postOnly,
      clientOrderId: args.clientOrderId,
    };
    let body;
    try {
      body = serializeBitunixOrder(req);
    } catch (e) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "serialize"),
        filledQty: 0,
        fills: [],
      };
    }
    try {
      const { orderId } = await this.client.placeSerializedOrder(body, { clientOrderId: args.clientOrderId });
      return { orderId, clientOrderId: args.clientOrderId, status: "ACK", rejectCode: null, filledQty: 0, fills: [] };
    } catch (e) {
      if (isAmbiguous(e)) throw e; // Timeout nach POST — Controller löst per Client-Key auf.
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "venue"),
        filledQty: 0,
        fills: [],
      };
    }
  }

  async placeMarketOrder(args: PlaceMarketArgs): Promise<PlaceOutcome> {
    const req: BrokerOrderRequest = {
      ...baseRequest(args.symbol, args.side, args.qty, 1),
      riskNotional: Math.max(args.qty, 1e-9),
      clientOrderId: args.clientOrderId,
    };
    let body;
    try {
      body = serializeBitunixOrder(req);
    } catch (e) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "serialize"),
        filledQty: 0,
        fills: [],
      };
    }
    try {
      const { orderId } = await this.client.placeSerializedOrder(body, { clientOrderId: args.clientOrderId });
      return { orderId, clientOrderId: args.clientOrderId, status: "ACK", rejectCode: null, filledQty: 0, fills: [] };
    } catch (e) {
      if (isAmbiguous(e)) throw e;
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "venue"),
        filledQty: 0,
        fills: [],
      };
    }
  }

  async cancelOrder(args: { symbol: string; orderId: string; clientOrderId: string }): Promise<CancelOutcome> {
    const now = this.now();
    let cancel;
    try {
      cancel = await this.client.cancelOrder({ symbol: args.symbol, orderId: args.orderId, clientId: args.clientOrderId });
    } catch (e) {
      if (isAmbiguous(e)) return { status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills: [] };
      throw e;
    }
    // Verify ist die einzige Wahrheit — die Cancel-Antwort allein beweist nichts.
    const detail = await this.client.getOrder(args.orderId).catch(() => null);
    if (!detail) {
      return { status: "UNKNOWN", reasonCode: "ORDER_NOT_FOUND", fills: [] };
    }
    const status = mapBitunixOrderStatus(detail.status);
    const fills = await this.getFills({ symbol: args.symbol, orderId: args.orderId });
    void now;
    if (status === "CANCELED") return { status: "CONFIRMED", reasonCode: "CANCEL_CONFIRMED", fills };
    if (status === "FILLED") return { status: "FAILED", reasonCode: "ALREADY_FILLED", fills };
    if (cancel.outcome === "rejected") return { status: "FAILED", reasonCode: "VENUE_ERROR", fills };
    return { status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills };
  }

  async getOrder(args: { symbol: string; orderId: string }): Promise<OrderView | null> {
    const detail = await this.client.getOrder(args.orderId).catch(() => null);
    if (!detail) return null;
    const status = mapBitunixOrderStatus(detail.status);
    const mapped: VenueOrderStatus =
      status === "NEW"
        ? "OPEN"
        : status === "PARTIALLY_FILLED"
          ? "PARTIALLY_FILLED"
          : status === "FILLED"
            ? "FILLED"
            : status === "CANCELED"
              ? "CANCELED"
              : status === "REJECTED"
                ? "REJECTED"
                : "UNKNOWN";
    return { orderId: detail.orderId, status: mapped, filledQty: detail.filledQty };
  }

  async getFills(args: { symbol: string; orderId: string }): Promise<PortFill[]> {
    const now = this.now();
    const trades = await this.client.getExecutions(args.symbol, args.orderId).catch(() => []);
    return trades
      .filter((t) => t.orderId === args.orderId)
      .map((t) => ({
        fillId: t.tradeId || `${t.orderId}@${t.ts}@${t.qty}`,
        orderId: t.orderId,
        qty: t.qty,
        price: t.price,
        feeQuote: t.feeKnown === true ? t.fee : null,
        eventTime: t.ts > 0 ? t.ts : now,
        availableAt: now,
      }));
  }

  async findOrderByClientId(args: { symbol: string; clientOrderId: string }): Promise<{ orderId: string } | null> {
    const found = await this.client.getOrderByClientId(args.clientOrderId).catch(() => null);
    return found ? { orderId: found.orderId } : null;
  }
}

// ── Alpaca ───────────────────────────────────────────────────────────────────

export class AlpacaVenuePort implements VenueExecutionPort {
  readonly venue = "ALPACA" as const;
  private readonly now: () => number;
  private readonly submitAt = new Map<string, number>();

  constructor(
    private readonly client: AlpacaPrivateClient,
    deps: { now?: () => number } = {}
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  getCapabilities(): VenueExecutionCapabilities {
    return executionCapabilitiesFor(this.venue);
  }

  async placeLimitOrder(args: PlaceOrderArgs): Promise<PlaceOutcome> {
    // Defense in Depth: der Controller fragt bei postOnly=false nie mit
    // postOnly=true an — falls doch, explizit ablehnen (nie still senden).
    if (args.postOnly) {
      return { orderId: "", clientOrderId: args.clientOrderId, status: "REJECTED", rejectCode: "POST_ONLY_UNSUPPORTED", filledQty: 0, fills: [] };
    }
    const req: BrokerOrderRequest = {
      ...baseRequest(args.symbol, args.side, args.qty, args.limitPrice),
      limitPrice: args.limitPrice,
      clientOrderId: args.clientOrderId,
    };
    let wire;
    try {
      wire = serializeAlpacaOrder(req);
    } catch (e) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "serialize"),
        filledQty: 0,
        fills: [],
      };
    }
    try {
      const raw = await this.client.placeOrder(wire, args.clientOrderId);
      this.submitAt.set(raw.id, this.now());
      return { orderId: raw.id, clientOrderId: args.clientOrderId, status: "ACK", rejectCode: null, filledQty: Number(raw.filled_qty ?? 0) || 0, fills: [] };
    } catch (e) {
      if (isAmbiguous(e)) throw e;
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "venue"),
        filledQty: 0,
        fills: [],
      };
    }
  }

  async placeMarketOrder(args: PlaceMarketArgs): Promise<PlaceOutcome> {
    const req: BrokerOrderRequest = {
      ...baseRequest(args.symbol, args.side, args.qty, 1),
      riskNotional: Math.max(args.qty, 1e-9),
      clientOrderId: args.clientOrderId,
    };
    let wire;
    try {
      wire = serializeAlpacaOrder(req);
    } catch (e) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "serialize"),
        filledQty: 0,
        fills: [],
      };
    }
    try {
      const raw = await this.client.placeOrder(wire, args.clientOrderId);
      this.submitAt.set(raw.id, this.now());
      return { orderId: raw.id, clientOrderId: args.clientOrderId, status: "ACK", rejectCode: null, filledQty: Number(raw.filled_qty ?? 0) || 0, fills: [] };
    } catch (e) {
      if (isAmbiguous(e)) throw e;
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "venue"),
        filledQty: 0,
        fills: [],
      };
    }
  }

  async cancelOrder(args: { symbol: string; orderId: string; clientOrderId: string }): Promise<CancelOutcome> {
    const canceled = await this.client.cancelOrder(args.orderId).catch(() => null);
    if (!canceled) return { status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills: [] };
    if (!canceled.found) {
      const recovered = await this.findOrderByClientId({ symbol: args.symbol, clientOrderId: args.clientOrderId }).catch(() => null);
      if (!recovered) return { status: "UNKNOWN", reasonCode: "ORDER_NOT_FOUND", fills: [] };
    }
    const view = await this.getOrder({ symbol: args.symbol, orderId: args.orderId });
    const fills = await this.getFills({ symbol: args.symbol, orderId: args.orderId });
    if (!view) return { status: "UNKNOWN", reasonCode: "ORDER_NOT_FOUND", fills };
    if (view.status === "CANCELED") return { status: "CONFIRMED", reasonCode: "CANCEL_CONFIRMED", fills };
    if (view.status === "FILLED") return { status: "FAILED", reasonCode: "ALREADY_FILLED", fills };
    return { status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills };
  }

  async replaceOrder(args: {
    symbol: string;
    orderId: string;
    clientOrderId: string;
    qty: number;
    limitPrice: number;
  }): Promise<PlaceOutcome> {
    try {
      const raw = await this.client.replaceOrder(args.orderId, {
        qty: args.qty,
        limitPrice: args.limitPrice,
        clientOrderId: args.clientOrderId,
      });
      return { orderId: raw.id, clientOrderId: args.clientOrderId, status: "ACK", rejectCode: null, filledQty: Number(raw.filled_qty ?? 0) || 0, fills: [] };
    } catch (e) {
      if (isAmbiguous(e)) throw e;
      return {
        orderId: args.orderId,
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: classifyPlaceReject(e instanceof Error ? e.message : "venue"),
        filledQty: 0,
        fills: [],
      };
    }
  }

  async getOrder(args: { symbol: string; orderId: string }): Promise<OrderView | null> {
    const raw = await this.client.getOrder(args.orderId).catch(() => null);
    if (!raw) return null;
    const s = String(raw.status ?? "").toLowerCase();
    let status: VenueOrderStatus = "UNKNOWN";
    if (["new", "accepted", "pending_new", "held", "accepted_for_bidding"].includes(s)) status = "OPEN";
    else if (s === "partially_filled") status = "PARTIALLY_FILLED";
    else if (s === "filled") status = "FILLED";
    else if (["canceled", "cancelled", "expired", "replaced"].includes(s)) status = "CANCELED";
    else if (["rejected", "stopped", "suspended"].includes(s)) status = "REJECTED";
    return { orderId: raw.id, status, filledQty: Number(raw.filled_qty ?? 0) || 0 };
  }

  async getFills(args: { symbol: string; orderId: string }): Promise<PortFill[]> {
    const since = (this.submitAt.get(args.orderId) ?? this.now()) - 60_000;
    const activities = await this.client.getFillActivities(args.orderId, Math.max(0, since)).catch(() => []);
    const now = this.now();
    return activities.map((a) => ({
      fillId: a.id,
      orderId: args.orderId,
      qty: a.quantity,
      price: a.price,
      // FILL-Aktivitäten belegen keine Quote-Gebühr — unbekannt ≠ 0.
      feeQuote: null,
      eventTime: Number.isFinite(a.at) && a.at > 0 ? a.at : now,
      availableAt: now,
    }));
  }

  async findOrderByClientId(args: { symbol: string; clientOrderId: string }): Promise<{ orderId: string } | null> {
    const raw = await this.client.getOrderByClientId(args.clientOrderId).catch(() => null);
    return raw ? { orderId: raw.id } : null;
  }
}

/** Transport-mehrdeutig (Timeout/429/5xx nach POST) — Retry nur per Client-Key-Recovery. */
function isAmbiguous(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const kind = (e as { kind?: unknown }).kind;
  if (kind === "ambiguous") return true;
  const msg = e instanceof Error ? e.message.toLowerCase() : "";
  return msg.includes("timeout") || msg.includes("ambiguous") || msg.includes("econnreset") || msg.includes("socket hang up");
}

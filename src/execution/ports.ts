/**
 * Venue-Ports des Execution-Policy-Controllers (RMA-P4-02).
 *
 * Der Controller spricht AUSSCHLIESSLICH dieses Interface — nie direkt einen
 * Private-Client. Jede Venue-Implementierung kapselt Wire-Format, Signing und
 * Status-Mapping; der Controller besitzt die Policy, die State-Machine und die
 * Gates.
 *
 * Implementierungen:
 *   - `PaperVenuePort` — deterministische In-Memory-Simulation derselben
 *     State-Machine (Post-Only-Reject, Partial Fills, Cancel-Bestätigung).
 *     Fills entstehen NUR über explizite `applyTrade`-Aufrufe des Tests bzw.
 *     des Paper-Treibers — kein Zufall, kein Zeit-Rauschen.
 *   - `BitunixVenuePort` — echte Venue via `BitunixPrivateClient`
 *     (POST_ONLY-Effect, cancel_orders + Verify via get_order_detail).
 *   - `AlpacaVenuePort` — echte Venue via `AlpacaPrivateClient`
 *     (kein Post-Only; atomares Replace via PATCH).
 *
 * Bounded Reason-Codes: alle `rejectCode`/`reasonCode`-Werte stammen aus den
 * geschlossenen Listen unten und sind damit metrikfähig. Venue-Rohtexte werden
 * klassifiziert, nie durchgereicht (keine Prompt-Instruktion aus Fremdtext,
 * keine High-Cardinality-Labels).
 */
import type { BrokerVenueId } from "../contracts/broker";
import {
  executionCapabilitiesFor,
  type VenueExecutionCapabilities,
} from "./capabilities";

export type PlaceRejectCode =
  | "POST_ONLY_WOULD_TAKE"
  | "POST_ONLY_UNSUPPORTED"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_QTY"
  | "INVALID_PRICE"
  | "VENUE_REJECT"
  | "VENUE_ERROR"
  | "RATE_LIMITED";

export type CancelStatus = "CONFIRMED" | "UNKNOWN" | "FAILED";

export type CancelReasonCode =
  | "CANCEL_CONFIRMED"
  | "ORDER_NOT_FOUND"
  | "ALREADY_FILLED"
  | "ALREADY_CANCELED"
  | "VENUE_AMBIGUOUS"
  | "VERIFY_TIMEOUT"
  | "VENUE_ERROR";

export type VenueOrderStatus =
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "UNKNOWN";

export interface PlaceOrderArgs {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  limitPrice: number;
  postOnly: boolean;
  clientOrderId: string;
}

export interface PlaceMarketArgs {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  clientOrderId: string;
}

export interface PlaceOutcome {
  orderId: string;
  clientOrderId: string;
  /** ACK = am Markt (ggf. mit sofortigen Fills); REJECTED = nichts am Markt. */
  status: "ACK" | "REJECTED";
  rejectCode: PlaceRejectCode | null;
  filledQty: number;
  fills: PortFill[];
}

export interface CancelOutcome {
  status: CancelStatus;
  reasonCode: CancelReasonCode;
  /** Bestätigte Fills der gecancelten Order (für die Restmengen-Wahrheit). */
  fills: PortFill[];
}

export interface OrderView {
  orderId: string;
  status: VenueOrderStatus;
  filledQty: number;
}

export interface PortFill {
  fillId: string;
  orderId: string;
  qty: number;
  price: number;
  feeQuote: number | null;
  eventTime: number;
  availableAt: number;
}

export interface VenueExecutionPort {
  readonly venue: BrokerVenueId;
  getCapabilities(): VenueExecutionCapabilities;
  placeLimitOrder(args: PlaceOrderArgs): Promise<PlaceOutcome>;
  placeMarketOrder(args: PlaceMarketArgs): Promise<PlaceOutcome>;
  cancelOrder(args: { symbol: string; orderId: string; clientOrderId: string }): Promise<CancelOutcome>;
  /** Atomares Replace (nur wenn `cancelReplaceAtomic=true`), sonst nie aufgerufen. */
  replaceOrder?(args: {
    symbol: string;
    orderId: string;
    clientOrderId: string;
    qty: number;
    limitPrice: number;
  }): Promise<PlaceOutcome>;
  getOrder(args: { symbol: string; orderId: string }): Promise<OrderView | null>;
  getFills(args: { symbol: string; orderId: string }): Promise<PortFill[]>;
  /**
   * Recovery per Client-Key nach mehrdeutigem Submit (Timeout nach POST).
   * Liefert die Venue-Order-ID oder null (unbekannt ⇒ kein Doppel-Submit).
   */
  findOrderByClientId?(args: { symbol: string; clientOrderId: string }): Promise<{ orderId: string } | null>;
}

/** Klassifiziert einen Venue-/Transport-Fehlertext auf einen bounded Code. */
export function classifyPlaceReject(message: string): PlaceRejectCode {
  const m = message.toLowerCase();
  if (m.includes("post") && (m.includes("only") || m.includes("maker") || m.includes("would take") || m.includes("taker"))) {
    return "POST_ONLY_WOULD_TAKE";
  }
  if (m.includes("insufficient") || m.includes("balance") || m.includes("margin")) return "INSUFFICIENT_FUNDS";
  if (m.includes("qty") || m.includes("quantity") || m.includes("volume") || m.includes("size")) return "INVALID_QTY";
  if (m.includes("price") || m.includes("tick")) return "INVALID_PRICE";
  if (m.includes("rate") || m.includes("429") || m.includes("limit")) return "RATE_LIMITED";
  if (m.includes("reject")) return "VENUE_REJECT";
  return "VENUE_ERROR";
}

// ── Paper-Port: deterministische Simulation ──────────────────────────────────

export interface PaperQuote {
  bid: number;
  ask: number;
  mid: number;
  ts: number;
}

interface PaperOpenOrder {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  limitPrice: number;
  postOnly: boolean;
  clientOrderId: string;
  orderId: string;
  status: "OPEN" | "PARTIALLY_FILLED" | "CANCELED" | "FILLED";
  fills: PortFill[];
  createdAt: number;
}

export interface PaperVenuePortDeps {
  venue?: BrokerVenueId;
  /** Taker-/Maker-Gebühr als Anteil (0 = keine Gebühr, Test-Default). */
  feeRate?: number;
  now?: () => number;
}

/**
 * Deterministische Paper-Simulation. Alle Zeitstempel stammen aus `now()`
 * (injizierbar); alle Fills aus expliziten `applyTrade`-Aufrufen oder sofortigen
 * Market-Fills. Derselbe Aufrufverlauf ergibt dieselben Fill-IDs, Mengen und
 * Preise — byte-identisch über Prozesse.
 */
export class PaperVenuePort implements VenueExecutionPort {
  readonly venue: BrokerVenueId;
  private readonly feeRate: number;
  private readonly now: () => number;
  private readonly quotes = new Map<string, PaperQuote>();
  private readonly byClientId = new Map<string, PaperOpenOrder>();
  private readonly byOrderId = new Map<string, PaperOpenOrder>();
  private seq = 1;

  constructor(deps: PaperVenuePortDeps = {}) {
    this.venue = deps.venue ?? "PAPER";
    this.feeRate = deps.feeRate ?? 0;
    this.now = deps.now ?? (() => Date.now());
  }

  getCapabilities(): VenueExecutionCapabilities {
    return executionCapabilitiesFor(this.venue);
  }

  setQuote(symbol: string, quote: PaperQuote): void {
    this.quotes.set(symbol.toUpperCase(), quote);
  }

  getQuote(symbol: string): PaperQuote | null {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }

  /** Offene Paper-Orders (Test-/Treiber-Introspektion, kein Produktionspfad). */
  openOrderCount(): number {
    let n = 0;
    for (const o of this.byOrderId.values()) {
      if (o.status === "OPEN" || o.status === "PARTIALLY_FILLED") n++;
    }
    return n;
  }

  async placeLimitOrder(args: PlaceOrderArgs): Promise<PlaceOutcome> {
    const existing = this.byClientId.get(args.clientOrderId);
    if (existing) {
      // Idempotent: derselbe Client-Key liefert dieselbe Order (kein Duplikat).
      return this.outcomeOf(existing);
    }
    const symbol = args.symbol.toUpperCase();
    const quote = this.quotes.get(symbol);
    if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: "VENUE_ERROR",
        filledQty: 0,
        fills: [],
      };
    }
    if (args.postOnly) {
      // Maker-or-Reject: ein Limit, das sofort nehmen würde, wird EXPLIZIT
      // als POST_ONLY_WOULD_TAKE abgelehnt (nicht still in einen Taker verwandelt).
      const wouldTake = args.side === "LONG" ? args.limitPrice >= quote.ask : args.limitPrice <= quote.bid;
      if (wouldTake) {
        return {
          orderId: "",
          clientOrderId: args.clientOrderId,
          status: "REJECTED",
          rejectCode: "POST_ONLY_WOULD_TAKE",
          filledQty: 0,
          fills: [],
        };
      }
    }
    const orderId = `paper-${args.clientOrderId}`;
    const order: PaperOpenOrder = {
      symbol,
      side: args.side,
      qty: args.qty,
      limitPrice: args.limitPrice,
      postOnly: args.postOnly,
      clientOrderId: args.clientOrderId,
      orderId,
      status: "OPEN",
      fills: [],
      createdAt: this.seq++,
    };
    this.byClientId.set(args.clientOrderId, order);
    this.byOrderId.set(orderId, order);
    return this.outcomeOf(order);
  }

  async placeMarketOrder(args: PlaceMarketArgs): Promise<PlaceOutcome> {
    const existing = this.byClientId.get(args.clientOrderId);
    if (existing) return this.outcomeOf(existing);
    const symbol = args.symbol.toUpperCase();
    const quote = this.quotes.get(symbol);
    if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
      return {
        orderId: "",
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: "VENUE_ERROR",
        filledQty: 0,
        fills: [],
      };
    }
    const orderId = `paper-${args.clientOrderId}`;
    const price = args.side === "LONG" ? quote.ask : quote.bid;
    const now = this.now();
    const order: PaperOpenOrder = {
      symbol,
      side: args.side,
      qty: args.qty,
      limitPrice: price,
      postOnly: false,
      clientOrderId: args.clientOrderId,
      orderId,
      status: "FILLED",
      fills: [
        {
          fillId: `${orderId}-f1`,
          orderId,
          qty: args.qty,
          price,
          feeQuote: this.feeRate > 0 ? args.qty * price * this.feeRate : 0,
          eventTime: now,
          availableAt: now,
        },
      ],
      createdAt: this.seq++,
    };
    this.byClientId.set(args.clientOrderId, order);
    this.byOrderId.set(orderId, order);
    return this.outcomeOf(order);
  }

  async cancelOrder(args: { symbol: string; orderId: string; clientOrderId: string }): Promise<CancelOutcome> {
    const order = this.byOrderId.get(args.orderId) ?? this.byClientId.get(args.clientOrderId);
    if (!order) {
      // Unbekannte Order: Fail-closed UNKNOWN — der Controller darf dann NICHT
      // fallbacken, bis `getOrder`/`getFills` die Lage klären.
      return { status: "UNKNOWN", reasonCode: "ORDER_NOT_FOUND", fills: [] };
    }
    if (order.status === "FILLED") {
      return { status: "FAILED", reasonCode: "ALREADY_FILLED", fills: [...order.fills] };
    }
    if (order.status === "CANCELED") {
      return { status: "CONFIRMED", reasonCode: "ALREADY_CANCELED", fills: [...order.fills] };
    }
    order.status = "CANCELED";
    return { status: "CONFIRMED", reasonCode: "CANCEL_CONFIRMED", fills: [...order.fills] };
  }

  async replaceOrder(args: {
    symbol: string;
    orderId: string;
    clientOrderId: string;
    qty: number;
    limitPrice: number;
  }): Promise<PlaceOutcome> {
    const order = this.byOrderId.get(args.orderId);
    if (!order || order.status === "CANCELED" || order.status === "FILLED") {
      return {
        orderId: args.orderId,
        clientOrderId: args.clientOrderId,
        status: "REJECTED",
        rejectCode: "VENUE_REJECT",
        filledQty: order ? filledOf(order) : 0,
        fills: order ? [...order.fills] : [],
      };
    }
    // Atomar im Speicher: kein offenes Fenster zwischen Cancel und Re-Submit.
    order.limitPrice = args.limitPrice;
    order.qty = filledOf(order) + args.qty;
    return this.outcomeOf(order);
  }

  async getOrder(args: { symbol: string; orderId: string }): Promise<OrderView | null> {
    const order = this.byOrderId.get(args.orderId);
    if (!order) return null;
    const filledQty = filledOf(order);
    const status: VenueOrderStatus =
      order.status === "CANCELED"
        ? "CANCELED"
        : order.status === "FILLED"
          ? "FILLED"
          : filledQty > 0
            ? "PARTIALLY_FILLED"
            : "OPEN";
    return { orderId: order.orderId, status, filledQty };
  }

  async getFills(args: { symbol: string; orderId: string }): Promise<PortFill[]> {
    const order = this.byOrderId.get(args.orderId);
    return order ? order.fills.map((f) => ({ ...f })) : [];
  }

  async findOrderByClientId(args: { symbol: string; clientOrderId: string }): Promise<{ orderId: string } | null> {
    const order = this.byClientId.get(args.clientOrderId);
    return order ? { orderId: order.orderId } : null;
  }

  /**
   * Wendet einen Trade auf alle ruhenden Maker-Orders an (deterministisch,
   * Preis-Zeit-Priorität nach Einreihung). LONG-Limits füllen, wenn der Trade
   * auf/unter ihrem Limit handelt; SHORT-Limits auf/über ihrem Limit.
   * `availableQty` begrenzt das Gesamtvolumen dieses Trades (Partial Fills).
   */
  applyTrade(symbol: string, price: number, availableQty: number, at?: number): PortFill[] {
    const sym = symbol.toUpperCase();
    const now = at ?? this.now();
    const produced: PortFill[] = [];
    let remaining = availableQty;
    const resting = [...this.byOrderId.values()]
      .filter((o) => o.symbol === sym && (o.status === "OPEN" || o.status === "PARTIALLY_FILLED"))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const order of resting) {
      if (!(remaining > 0)) break;
      const match = order.side === "LONG" ? price <= order.limitPrice : price >= order.limitPrice;
      if (!match) continue;
      const open = order.qty - filledOf(order);
      if (!(open > 0)) continue;
      const qty = Math.min(open, remaining);
      remaining -= qty;
      const fill: PortFill = {
        fillId: `${order.orderId}-f${order.fills.length + 1}`,
        orderId: order.orderId,
        qty,
        price: order.limitPrice,
        feeQuote: this.feeRate > 0 ? qty * order.limitPrice * this.feeRate : 0,
        eventTime: now,
        availableAt: now,
      };
      order.fills.push(fill);
      produced.push({ ...fill });
      if (filledOf(order) >= order.qty - 1e-12) order.status = "FILLED";
      else order.status = "PARTIALLY_FILLED";
    }
    return produced;
  }

  private outcomeOf(order: PaperOpenOrder): PlaceOutcome {
    return {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      status: "ACK",
      rejectCode: null,
      filledQty: filledOf(order),
      fills: order.fills.map((f) => ({ ...f })),
    };
  }
}

function filledOf(order: PaperOpenOrder): number {
  return order.fills.reduce((s, f) => s + f.qty, 0);
}

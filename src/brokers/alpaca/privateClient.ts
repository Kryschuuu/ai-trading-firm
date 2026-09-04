/**
 * Alpaca Private-Client (Task 12) — Trade-API (signiert per Basic-Auth).
 *
 * Endpunkte (Doku: https://alpaca.markets/docs/api-references/trading-api/):
 *   GET  /v2/account                       — Account-Details
 *   GET  /v2/positions                     — offene Positionen
 *   POST /v2/orders                        — Order platzieren (nicht-idempotent!)
 *   GET  /v2/orders/{id}                   — Order-Status
 *   GET  /v2/assets                        — Asset-Liste (Discovery)
 *
 * Auth: Basic-Auth (apiKey:apiSecret als base64).
 *
 * Wichtig: POST /v2/orders ist NICHT idempotent. Der HTTP-Transport
 * (`AlpacaHttp.request`) verweigert Retry für POSTs — kein Doppel-Order-
 * Risiko bei Timeout/5xx (Alpaca nutzt `client_order_id` als Idempotenz-Key,
 * der Adapter setzt diesen aus dem BrokerOrderRequest-Symbol + timestamp).
 */
import { ALPACA_TRADE_PATHS } from "./config";
import type { AlpacaRuntimeConfig } from "./config";
import { AlpacaApiError, safeSnippet } from "./errors";
import { AlpacaHttp, basicAuthHeader } from "./http";
import type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaOrder,
  AlpacaOrderRequest,
  AlpacaPosition,
} from "./types";
import type { AlpacaCredentials } from "./secrets";
import { recordAlpacaPrivateCall } from "./audit";

export interface AlpacaPrivateClientDeps {
  config: AlpacaRuntimeConfig;
  credentials: AlpacaCredentials;
  http: AlpacaHttp;
}

export class AlpacaPrivateClient {
  private readonly config: AlpacaRuntimeConfig;
  private readonly credentials: AlpacaCredentials;
  private readonly http: AlpacaHttp;

  constructor(deps: AlpacaPrivateClientDeps) {
    this.config = deps.config;
    this.credentials = deps.credentials;
    this.http = deps.http;
  }

  /** Liefert die Account-Übersicht (Equity, Cash, Buying-Power, Status). */
  async getAccount(): Promise<AlpacaAccount> {
    try {
      const res = await this.authedRequest({
        method: "GET",
        path: ALPACA_TRADE_PATHS.account,
        idempotent: true,
      });
      await recordAlpacaPrivateCall({ method: "GET", path: ALPACA_TRADE_PATHS.account, outcome: "OK", errorCode: null });
      if (!res.json || typeof res.json !== "object") {
        throw new AlpacaApiError("unknown", "Alpaca /v2/account lieferte kein JSON.");
      }
      return res.json as AlpacaAccount;
    } catch (e) {
      if (!(e instanceof AlpacaApiError)) {
        await recordAlpacaPrivateCall({
          method: "GET",
          path: ALPACA_TRADE_PATHS.account,
          outcome: "ERROR",
          errorCode: safeSnippet(e instanceof Error ? e.message : "error", 40),
        });
      }
      throw e;
    }
  }

  /** Liefert alle offenen Positionen. */
  async getPositions(): Promise<AlpacaPosition[]> {
    try {
      const res = await this.authedRequest({
        method: "GET",
        path: ALPACA_TRADE_PATHS.positions,
        idempotent: true,
      });
      await recordAlpacaPrivateCall({ method: "GET", path: ALPACA_TRADE_PATHS.positions, outcome: "OK", errorCode: null });
      if (!Array.isArray(res.json)) return [];
      return res.json as AlpacaPosition[];
    } catch (e) {
      if (!(e instanceof AlpacaApiError)) {
        await recordAlpacaPrivateCall({
          method: "GET",
          path: ALPACA_TRADE_PATHS.positions,
          outcome: "ERROR",
          errorCode: safeSnippet(e instanceof Error ? e.message : "error", 40),
        });
      }
      throw e;
    }
  }

  /** Asset-Liste (Discovery). */
  async getAssets(opts: { status?: "active" | "inactive" | "delisted"; assetClass?: "us_equity" | "crypto" } = {}): Promise<AlpacaAsset[]> {
    try {
      const res = await this.authedRequest({
        method: "GET",
        path: ALPACA_TRADE_PATHS.assets,
        query: { status: opts.status ?? "active", asset_class: opts.assetClass },
        idempotent: true,
      });
      await recordAlpacaPrivateCall({ method: "GET", path: ALPACA_TRADE_PATHS.assets, outcome: "OK", errorCode: null });
      if (!Array.isArray(res.json)) return [];
      return res.json as AlpacaAsset[];
    } catch (e) {
      if (!(e instanceof AlpacaApiError)) {
        await recordAlpacaPrivateCall({
          method: "GET",
          path: ALPACA_TRADE_PATHS.assets,
          outcome: "ERROR",
          errorCode: safeSnippet(e instanceof Error ? e.message : "error", 40),
        });
      }
      throw e;
    }
  }

  /** Order platzieren. Idempotenz-Key wird intern aus Symbol+Qty+Side+Timestamp gebildet. */
  async placeOrder(req: AlpacaOrderRequest, clientOrderId?: string): Promise<AlpacaOrder> {
    if (!req.symbol) throw new AlpacaApiError("validation", "Alpaca-Order ohne Symbol.");
    if (!req.side || (req.side !== "buy" && req.side !== "sell")) {
      throw new AlpacaApiError("validation", `Alpaca-Order side ungültig: ${safeSnippet(req.side)}`);
    }
    if (!req.type) throw new AlpacaApiError("validation", "Alpaca-Order type fehlt.");
    if (!req.time_in_force) throw new AlpacaApiError("validation", "Alpaca-Order time_in_force fehlt.");
    if (req.qty == null && req.notional == null) {
      throw new AlpacaApiError("validation", "Alpaca-Order braucht qty oder notional.");
    }
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      time_in_force: req.time_in_force,
    };
    if (req.qty != null) body.qty = String(req.qty);
    if (req.notional != null) body.notional = String(req.notional);
    if (req.limit_price != null) body.limit_price = String(req.limit_price);
    if (req.stop_price != null) body.stop_price = String(req.stop_price);
    if (req.extended_hours != null) body.extended_hours = req.extended_hours;
    if (req.order_class) body.order_class = req.order_class;
    if (req.take_profit) body.take_profit = { limit_price: String(req.take_profit.limit_price) };
    if (req.stop_loss) {
      body.stop_loss = { stop_price: String(req.stop_loss.stop_price) };
      if (req.stop_loss.limit_price != null) {
        (body.stop_loss as Record<string, string>).limit_price = String(req.stop_loss.limit_price);
      }
    }
    const res = await this.authedRequest({
      method: "POST",
      path: ALPACA_TRADE_PATHS.orders,
      body: JSON.stringify(body),
      headers: clientOrderId ? { "Idempotency-Key": clientOrderId } : undefined,
    });
    if (!res.json || typeof res.json !== "object") {
      throw new AlpacaApiError("unknown", "Alpaca POST /v2/orders lieferte kein JSON.");
    }
    return res.json as AlpacaOrder;
  }

  /** Order-Status abfragen. */
  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const res = await this.authedRequest({
      method: "GET",
      path: `${ALPACA_TRADE_PATHS.orders}/${encodeURIComponent(orderId)}`,
      idempotent: true,
    });
    if (!res.json || typeof res.json !== "object") {
      throw new AlpacaApiError("unknown", "Alpaca GET /v2/orders/{id} lieferte kein JSON.");
    }
    return res.json as AlpacaOrder;
  }

  /**
   * H7 (v1.36.20): Storniert alle offenen Orders (`DELETE /v2/orders`) —
   * Notfall-Schritt 1 des Kill-Flatten. Im Effekt idempotent (stornieren
   * bereits stornierter Orders ist ein No-Op).
   */
  async cancelAllOrders(): Promise<string[]> {
    const res = await this.authedRequest({
      method: "DELETE",
      path: ALPACA_TRADE_PATHS.orders,
      idempotent: true,
    });
    await recordAlpacaPrivateCall({ method: "DELETE", path: ALPACA_TRADE_PATHS.orders, outcome: "OK", errorCode: null });
    if (!Array.isArray(res.json)) return [];
    return res.json
      .map((o) => String((o as { id?: unknown })?.id ?? ""))
      .filter(Boolean);
  }

  /**
   * H7 (v1.36.20): Schließt alle offenen Positionen (`DELETE /v2/positions`) —
   * Notfall-Schritt 2 des Kill-Flatten. Die tatsächliche Glattheit wird über
   * `verifyFlat()` (getPositions == 0) belegt, nicht über den Close-Report.
   */
  async closeAllPositions(): Promise<void> {
    const res = await this.authedRequest({
      method: "DELETE",
      path: ALPACA_TRADE_PATHS.positions,
      idempotent: true,
    });
    await recordAlpacaPrivateCall({ method: "DELETE", path: ALPACA_TRADE_PATHS.positions, outcome: "OK", errorCode: null });
    void res;
  }

  /** Zentrale Auth-Wrapper-Methode: setzt Basic-Auth + optionale Header. */
  private async authedRequest(req: { method: "GET" | "POST" | "DELETE" | "PATCH"; path: string; query?: Record<string, string | number | boolean | undefined>; body?: string; headers?: Record<string, string>; idempotent?: boolean }) {
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(this.credentials.apiKey, this.credentials.apiSecret),
      ...(req.headers ?? {}),
    };
    return this.http.request({
      method: req.method,
      base: this.config.tradeBaseUrl,
      path: req.path,
      query: req.query,
      body: req.body,
      headers,
      idempotent: req.idempotent,
    });
  }
}

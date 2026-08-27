/**
 * Privater REST-Client (signiert). Bereitet Account/Positions/Place-Order vor.
 *
 * Wird vom Live-Pfad NICHT ausgeführt — `placeOrder` am Adapter wirft
 * immer LiveTradingGateError. Die Methoden existieren für Serialisierung,
 * Mock-Verifikation und den späteren Gate-Task.
 */
import type { BrokerAccount, BrokerPosition } from "../../contracts/broker";
import { BITUNIX_PATHS } from "./config";
import { BitunixApiError, classifyBitunixFailure } from "./errors";
import { BitunixHttp, TokenBucket, type BitunixHttpOptions } from "./http";
import {
  encodeQueryParams,
  signBitunixRequest,
  type MonotonicTimestamp,
  type NonceFactory,
  defaultNonceFactory,
  defaultTimestamp,
} from "./signing";
import { recordBitunixPrivateCall } from "./audit";
import type { BitunixCredentials } from "./secrets";
import type { BitunixAccountRaw, BitunixEnvelope, BitunixPlaceOrderBody, BitunixPositionRaw } from "./types";

function envelopeData<T>(json: unknown): T {
  if (!json || typeof json !== "object") {
    throw new BitunixApiError("unknown", "Bitunix: leere Antwort.");
  }
  const env = json as BitunixEnvelope<T>;
  if (typeof env.code === "number" && env.code !== 0) {
    const c = classifyBitunixFailure({ venueCode: env.code, venueMsg: env.msg });
    throw new BitunixApiError(c.kind, c.message, { venueCode: env.code });
  }
  return env.data;
}

export interface BitunixPrivateClientOptions extends BitunixHttpOptions {
  credentials: BitunixCredentials;
  nonceFactory?: NonceFactory;
  timestamp?: MonotonicTimestamp;
}

export class BitunixPrivateClient {
  private readonly http: BitunixHttp;
  private readonly creds: BitunixCredentials;
  private readonly nonces: NonceFactory;
  private readonly clock: MonotonicTimestamp;

  constructor(opts: BitunixPrivateClientOptions) {
    this.http = new BitunixHttp({
      ...opts,
      bucket: opts.bucket ?? new TokenBucket(opts.config.privateRatePerSec, opts.config.privateRatePerSec),
      secrets: () => [opts.credentials.apiKey, opts.credentials.apiSecret],
    });
    this.creds = opts.credentials;
    this.nonces = opts.nonceFactory ?? defaultNonceFactory;
    this.clock = opts.timestamp ?? defaultTimestamp;
  }

  private async signed(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    body: string
  ) {
    const nonce = this.nonces.next();
    const timestamp = this.clock.next();
    const queryParams = encodeQueryParams(query ?? {});
    const { sign } = signBitunixRequest({
      nonce,
      timestamp,
      apiKey: this.creds.apiKey,
      secret: this.creds.apiSecret,
      queryParams,
      body,
    });
    const headers = {
      "api-key": this.creds.apiKey,
      nonce,
      timestamp,
      sign,
      language: "en-US",
    };
    try {
      const res = await this.http.request({ method, path, query, body: method === "POST" ? body : undefined, headers, signed: true });
      await recordBitunixPrivateCall({ method, path, outcome: "OK", errorCode: null });
      return res;
    } catch (e) {
      const code = e instanceof BitunixApiError ? e.code : "BITUNIX_UNKNOWN";
      await recordBitunixPrivateCall({
        method,
        path,
        outcome: e instanceof BitunixApiError && e.kind === "auth" ? "DENIED" : "ERROR",
        errorCode: code,
      });
      throw e;
    }
  }

  async getAccount(marginCoin = "USDT"): Promise<BrokerAccount> {
    const res = await this.signed("GET", BITUNIX_PATHS.account, { marginCoin }, "");
    const data = envelopeData<BitunixAccountRaw[] | BitunixAccountRaw>(res.json);
    const row = Array.isArray(data) ? data[0] : data;
    const available = Number(row?.available ?? 0);
    const upnl =
      Number(row?.crossUnrealizedPNL ?? 0) + Number(row?.isolationUnrealizedPNL ?? 0);
    const equity = (Number.isFinite(available) ? available : 0) + (Number.isFinite(upnl) ? upnl : 0);
    return {
      equity,
      cash: Number.isFinite(available) ? available : 0,
      openPositions: 0,
      startingEquity: equity,
      drawdownPct: 0,
    };
  }

  async getPositions(symbol?: string): Promise<BrokerPosition[]> {
    const res = await this.signed(
      "GET",
      BITUNIX_PATHS.positions,
      symbol ? { symbol } : undefined,
      ""
    );
    const data = envelopeData<BitunixPositionRaw[]>(res.json);
    const rows = Array.isArray(data) ? data : [];
    return rows
      .map((r): BrokerPosition | null => {
        const qty = Number(r.qty);
        const entry = Number(r.avgOpenPrice);
        if (!Number.isFinite(qty) || qty <= 0) return null;
        const side = String(r.side ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
        return {
          symbol: String(r.symbol ?? "").toUpperCase(),
          side,
          qty,
          entryPrice: Number.isFinite(entry) ? entry : 0,
          lastPrice: Number.isFinite(entry) ? entry : 0,
          unrealizedPnl: Number(r.unrealizedPNL ?? 0) || 0,
          stopLoss: null,
          takeProfit: null,
        };
      })
      .filter((p): p is BrokerPosition => p !== null);
  }

  /**
   * Sendet eine bereits serialisierte Order. Vom Adapter-Live-Pfad
   * NICHT aufgerufen.
   */
  async placeSerializedOrder(body: BitunixPlaceOrderBody): Promise<{ orderId: string; clientId?: string }> {
    const json = JSON.stringify(body);
    const res = await this.signed("POST", BITUNIX_PATHS.placeOrder, undefined, json);
    const data = envelopeData<{ orderId?: string; clientId?: string }>(res.json);
    return { orderId: String(data?.orderId ?? ""), clientId: data?.clientId };
  }
}

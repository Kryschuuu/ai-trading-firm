/**
 * Lokaler Bitunix-REST-Fixture-Server (Task 07).
 *
 * Bindet ausschließlich 127.0.0.1. Private Endpunkte zählen Calls und
 * prüfen die Signatur — Paper-Tests dürfen sie nie treffen.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BITUNIX_PATHS } from "../../src/brokers/bitunix/config";
import { encodeQueryParams, verifyBitunixSign } from "../../src/brokers/bitunix/signing";

export class BitunixFixtureServer {
  apiKey = "fixture-api-key";
  apiSecret = "fixture-api-secret";
  privateCalls = 0;
  publicCalls = 0;
  /**
   * `credentialHeaders` listet die am Request beobachteten Auth-Header
   * (`sign`, `api-key`, `nonce`, `timestamp`, `authorization`). Public-Calls
   * (Discovery/Ticker/Depth/Kline) müssen hier **leer** sein — der Sync-Pfad
   * darf keine Credentials exponieren.
   */
  requests: { method: string; path: string; signed: boolean; credentialHeaders: string[] }[] = [];
  failPublic = false;
  httpStatus?: number;
  /** Optionaler HTTP-Status nur für `/api/v1/kline` (z. B. 429 Rate-Limit-Test). */
  klineStatus?: number;
  /**
   * H8: Optionaler Account-Row (GET /futures/account). Ist er gesetzt, wird er
   * als `data: [accountRow]` ausgeliefert; sonst die Default-Zeile (nur
   * `available`, ohne gebundene Margin/Positionen).
   */
  accountRow: Record<string, string> | null = null;
  /**
   * B2: Optionale Positions-Zeilen (GET /futures/position/get_pending_positions).
   * Ist das Array gesetzt (auch leer), wird es 1:1 als `data` ausgeliefert —
   * damit lassen sich korrumpierte Antworten simulieren (`side: ""`, `side:
   * "WEIRD"`, fehlende Seite bei 0-qty). Sonst die Default-Zeile (LONG BTCUSDT).
   */
  positionRows: Record<string, unknown>[] | null = null;
  /**
   * H4: Am Fixture platzierte Orders, nach `clientId` (Wire-Feld des
   * clientOrderId) registriert — damit `get_order_detail?clientId=...`
   * (getOrderByClientId) eine bestehende Order findet (Idempotenz-Tests).
   */
  private ordersByClientId = new Map<string, { orderId: string; status: string }>();
  private server: http.Server | null = null;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const signed = Boolean(req.headers.sign);
    const credentialHeaders = ["sign", "api-key", "nonce", "timestamp", "authorization"].filter(
      (h) => req.headers[h] !== undefined,
    );
    this.requests.push({ method: req.method ?? "GET", path, signed, credentialHeaders });

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        this.route(req, res, path, url, body, signed);
      } catch {
        json(res, 500, { code: 1, msg: "fixture error", data: null });
      }
    });
  }

  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    url: URL,
    body: string,
    signed: boolean
  ): void {
    if (this.httpStatus) {
      json(res, this.httpStatus, { code: this.httpStatus, msg: "forced", data: null });
      return;
    }
    const isPrivate =
      path === BITUNIX_PATHS.account ||
      path === BITUNIX_PATHS.positions ||
      path === BITUNIX_PATHS.placeOrder ||
      path === BITUNIX_PATHS.orderDetail ||
      path === BITUNIX_PATHS.historyTrades;
    if (isPrivate) {
      this.privateCalls += 1;
      if (!this.validSign(req, url, body)) {
        json(res, 401, { code: 10007, msg: "Signature Error", data: null });
        return;
      }
      // H3: Order-Detail (Reconciliation). orderId=BX-1 liefert einen
      // vollständigen Fill mit tradeQty; unbekannte Order → leere Antwort.
      // H4: auch per clientId abfragbar (clientOrderId-Idempotenz-Query).
      if (path === BITUNIX_PATHS.orderDetail) {
        const orderId = url.searchParams.get("orderId");
        const clientId = url.searchParams.get("clientId");
        const detail =
          orderId === "BX-1" || orderId === "BX-LIVE-1"
            ? {
                orderId,
                symbol: "BTCUSDT",
                qty: "0.01",
                tradeQty: "0.01",
                side: "BUY",
                orderType: "MARKET",
                status: "FILLED",
                ctime: 1700000000000,
                mtime: 1700000001000,
              }
            : clientId
              ? (() => {
                  const found = this.ordersByClientId.get(clientId);
                  return found
                    ? {
                        orderId: found.orderId,
                        clientId,
                        symbol: "BTCUSDT",
                        qty: "0.01",
                        tradeQty: "0",
                        side: "BUY",
                        orderType: "MARKET",
                        status: found.status,
                        ctime: 1700000000000,
                        mtime: 1700000001000,
                      }
                    : null;
                })()
              : null;
        json(res, 200, { code: 0, data: detail });
        return;
      }
      // H3: Ausführungen (Trades) — die echte Fill-Quelle (avgPrice).
      if (path === BITUNIX_PATHS.historyTrades) {
        json(res, 200, {
          code: 0,
          data: {
            tradeList: [
              {
                tradeId: "T-FIX-1",
                orderId: url.searchParams.get("orderId") ?? "BX-1",
                symbol: "BTCUSDT",
                qty: "0.01",
                price: "65000",
                side: "BUY",
                fee: "0.39",
                roleType: "TAKER",
                ctime: 1700000001000,
              },
            ],
            total: 1,
          },
        });
        return;
      }
      if (path === BITUNIX_PATHS.account) {
        json(res, 200, {
          code: 0,
          data: [
            this.accountRow ?? {
              marginCoin: "USDT",
              available: "10000",
              crossUnrealizedPNL: "0",
              isolationUnrealizedPNL: "0",
            },
          ],
        });
        return;
      }
      if (path === BITUNIX_PATHS.positions) {
        json(res, 200, {
          code: 0,
          data:
            this.positionRows ?? [
              { symbol: "BTCUSDT", qty: "0.01", side: "LONG", avgOpenPrice: "65000", unrealizedPNL: "12.5" },
            ],
        });
        return;
      }
      // H4: clientOrderId (Wire-Feld clientId) registrieren, damit
      // get_order_detail?clientId=... die soeben platzierte Order findet.
      let clientId: string | null = null;
      try {
        clientId = body ? String(JSON.parse(body)?.clientId ?? "") || null : null;
      } catch {
        clientId = null;
      }
      if (clientId) this.ordersByClientId.set(clientId, { orderId: "BX-1", status: "NEW" });
      json(res, 200, { code: 0, data: { orderId: "BX-1", clientId: clientId ?? "c1" } });
      return;
    }

    this.publicCalls += 1;
    if (this.failPublic) {
      json(res, 503, { code: 1, msg: "maintenance", data: null });
      return;
    }
    if (path === BITUNIX_PATHS.tradingPairs) {
      json(res, 200, {
        code: 0,
        data: [
          {
            symbol: "BTCUSDT",
            base: "BTC",
            quote: "USDT",
            minTradeVolume: "0.001",
            basePrecision: 3,
            quotePrecision: 1,
            maxLeverage: 125,
            symbolStatus: "OPEN",
            mysteryField: "ignore-me",
          },
          {
            symbol: "ETHUSDT",
            base: "ETH",
            quote: "USDT",
            minTradeVolume: "0.01",
            basePrecision: 2,
            quotePrecision: 2,
            maxLeverage: 50,
            symbolStatus: "CANCEL_ONLY",
          },
          { symbol: "??", base: "X", quote: "Y" },
        ],
      });
      return;
    }
    if (path === BITUNIX_PATHS.tickers) {
      json(res, 200, {
        code: 0,
        data: [
          {
            symbol: "BTCUSDT",
            lastPrice: "65000.5",
            markPrice: "65001",
            quoteVol: "120000000",
            baseVol: "1846",
            high: "66100",
            low: "64000",
          },
        ],
      });
      return;
    }
    if (path === BITUNIX_PATHS.kline && this.klineStatus) {
      json(res, this.klineStatus, { code: this.klineStatus, msg: "rate limited", data: null });
      return;
    }
    if (path === BITUNIX_PATHS.kline) {
      json(res, 200, {
        code: 0,
        data: [
          { time: 1_700_000_000_000, open: "64000", high: "66100", low: "63900", close: "65000", baseVol: "10" },
          { time: 1_700_000_060_000, open: "65000", high: "65200", low: "64900", close: "65100", baseVol: "8" },
        ],
      });
      return;
    }
    if (path === BITUNIX_PATHS.depth) {
      json(res, 200, {
        code: 0,
        data: {
          bids: [["64999", "1.2"], ["64998", "0.5"]],
          asks: [["65001", "0.8"], ["65002", "2"]],
        },
      });
      return;
    }
    void signed;
    json(res, 404, { code: 1, msg: "not found", data: null });
  }

  private validSign(req: http.IncomingMessage, url: URL, body: string): boolean {
    const nonce = String(req.headers.nonce ?? "");
    const timestamp = String(req.headers.timestamp ?? "");
    const apiKey = String(req.headers["api-key"] ?? "");
    const sign = String(req.headers.sign ?? "");
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return verifyBitunixSign(
      {
        nonce,
        timestamp,
        apiKey,
        secret: this.apiSecret,
        queryParams: encodeQueryParams(query),
        body: req.method === "POST" ? body : "",
      },
      sign
    ) && apiKey === this.apiKey;
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Lokaler Alpaca-REST-Fixture-Server (Task 12).
 *
 * Bindet ausschließlich 127.0.0.1. Der Server bedient die Trade- und
 * Market-Data-Endpoints mit deterministischen Antworten, damit der
 * Adapter hermetisch getestet werden kann.
 *
 * WICHTIG: Credentials werden mit Basic-Auth geprüft — der Adapter
 * muss also die echten `ALPACA_API_KEY`/`ALPACA_API_SECRET` schicken.
 * Default-Credentials in Tests: `fixture-alpaca-key` / `fixture-alpaca-secret`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALPACA_TRADE_PATHS } from "../../src/brokers/alpaca/config";

export class AlpacaFixtureServer {
  apiKey = "fixture-alpaca-key";
  apiSecret = "fixture-alpaca-secret";
  baseUrl = "";
  privateCalls = 0;
  publicCalls = 0;
  /**
   * `credentialHeaders` listet die am Request beobachteten Auth-Header
   * (Authorization, APCA-API-KEY-ID, APCA-API-SECRET-KEY). Public-Calls
   * (Snapshot, Bars, Ticker) müssen hier **leer** sein — der Sync-Pfad
   * darf keine Credentials exponieren.
   */
  requests: {
    method: string;
    path: string;
    authed: boolean;
    credentialHeaders: string[];
  }[] = [];
  failPublic = false;
  failOrder = false;
  httpStatus?: number;
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
    const authed = Boolean(req.headers.authorization);
    const credentialHeaders = ["authorization", "apca-api-key-id", "apca-api-secret-key"].filter(
      (h) => req.headers[h] !== undefined
    );
    this.requests.push({
      method: req.method ?? "GET",
      path,
      authed,
      credentialHeaders,
    });

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        this.route(req, res, path, url, body, authed);
      } catch {
        json(res, 500, { code: 50000000, message: "fixture error" });
      }
    });
  }

  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    url: URL,
    body: string,
    authed: boolean
  ): void {
    if (this.httpStatus) {
      json(res, this.httpStatus, { code: this.httpStatus, message: "forced" });
      return;
    }

    // Public-Endpunkte (Market-Data) — keine Auth erforderlich
    if (path.match(/^\/v2\/stocks\/[A-Z0-9/.]+\/snapshot$/)) {
      this.publicCalls++;
      if (this.failPublic) {
        json(res, 503, { code: 50300000, message: "fixture forced fail" });
        return;
      }
      const sym = path.split("/")[3];
      json(res, 200, {
        symbol: sym,
        latestTrade: { t: new Date().toISOString(), p: 195.5, s: 100 },
        latestQuote: { t: new Date().toISOString(), bp: 195.4, bs: 50, ap: 195.6, as: 50 },
        dailyBar: { t: new Date().toISOString(), o: 194, h: 196, l: 193, c: 195.5, v: 1_000_000 },
      });
      return;
    }
    if (path.match(/^\/v2\/stocks\/[A-Z0-9/.]+\/trades\/latest$/)) {
      this.publicCalls++;
      const sym = path.split("/")[3];
      json(res, 200, { trade: { t: new Date().toISOString(), p: 195.5, s: 100, sym } });
      return;
    }
    if (path.match(/^\/v2\/stocks\/[A-Z0-9/.]+\/bars$/)) {
      this.publicCalls++;
      const sym = path.split("/")[3];
      json(res, 200, {
        bars: {
          [sym]: [
            { t: "2026-08-31T00:00:00Z", o: 194, h: 196, l: 193, c: 195, v: 500_000 },
            { t: "2026-09-01T00:00:00Z", o: 195, h: 197, l: 194, c: 196, v: 600_000 },
          ],
        },
      });
      return;
    }

    // Private-Endpunkte — erfordern Auth
    if (!authed) {
      json(res, 401, { code: 40110000, message: "authentication required" });
      return;
    }
    if (path === ALPACA_TRADE_PATHS.account) {
      this.privateCalls++;
      json(res, 200, {
        id: "fixture-account-id",
        account_number: "PA12345678",
        status: "ACTIVE",
        currency: "USD",
        cash: "50000",
        portfolio_value: "100000",
        buying_power: "100000",
        equity: "100000",
        pattern_day_trader: false,
        trading_blocked: false,
        account_blocked: false,
      });
      return;
    }
    if (path === ALPACA_TRADE_PATHS.positions) {
      this.privateCalls++;
      json(res, 200, [
        {
          asset_id: "fb1e4e8e-1f6f-4dca-8b1c-1234567890ab",
          symbol: "AAPL",
          exchange: "NASDAQ",
          asset_class: "us_equity",
          qty: "10",
          avg_entry_price: "190",
          side: "long",
          market_value: "1955",
          cost_basis: "1900",
          unrealized_pl: "55",
          unrealized_plpc: "0.0289",
          current_price: "195.5",
          lastday_price: "194",
          change_today: "0.0077",
        },
      ]);
      return;
    }
    if (path === ALPACA_TRADE_PATHS.assets) {
      this.privateCalls++;
      json(res, 200, [
        {
          id: "aapl-id",
          class: "us_equity",
          exchange: "NASDAQ",
          symbol: "AAPL",
          name: "Apple Inc.",
          status: "active",
          tradable: true,
          marginable: true,
          shortable: true,
          easy_to_borrow: true,
          fractionable: true,
        },
        {
          id: "msft-id",
          class: "us_equity",
          exchange: "NASDAQ",
          symbol: "MSFT",
          name: "Microsoft Corp.",
          status: "active",
          tradable: true,
          marginable: true,
          shortable: true,
          easy_to_borrow: true,
          fractionable: true,
        },
      ]);
      return;
    }
    if (path === ALPACA_TRADE_PATHS.orders && req.method === "POST") {
      this.privateCalls++;
      if (this.failOrder) {
        json(res, 422, { code: 42210000, message: "insufficient buying power" });
        return;
      }
      const reqBody = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      json(res, 200, {
        id: "fixture-order-1",
        client_order_id: (reqBody.client_order_id as string) ?? "PAP-default",
        created_at: new Date().toISOString(),
        submitted_at: new Date().toISOString(),
        filled_at: new Date().toISOString(),
        asset_id: "aapl-id",
        symbol: reqBody.symbol,
        asset_class: "us_equity",
        qty: reqBody.qty,
        filled_qty: reqBody.qty,
        filled_avg_price: "195.5",
        order_class: reqBody.order_class ?? "simple",
        type: reqBody.type,
        side: reqBody.side,
        time_in_force: reqBody.time_in_force,
        status: "filled",
        limit_price: reqBody.limit_price,
        stop_price: reqBody.stop_price,
      });
      return;
    }
    if (path.startsWith(ALPACA_TRADE_PATHS.orders + "/")) {
      this.privateCalls++;
      json(res, 200, {
        id: path.split("/").pop() ?? "order-1",
        client_order_id: "PAP",
        created_at: new Date().toISOString(),
        symbol: "AAPL",
        qty: "1",
        filled_qty: "1",
        filled_avg_price: "195",
        type: "market",
        side: "buy",
        time_in_force: "day",
        status: "filled",
      });
      return;
    }
    // Fallback
    json(res, 404, { code: 40410000, message: "not found" });
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

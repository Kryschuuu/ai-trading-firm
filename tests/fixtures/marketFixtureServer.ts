/**
 * Lokaler Fixture-HTTP-Server für Market-Data-Tests (Task 03).
 *
 * Simuliert Binance- und Yahoo-REST-Endpunkte — NUR lokal (127.0.0.1),
 * kein echtes Netz. Feeds werden per `PAPER_BINANCE_BASE_URL` /
 * `PAPER_YAHOO_BASE_URL` + `PAPER_FEED_ALLOWED_HOSTS=127.0.0.1` auf diesen
 * Server gerichtet.
 *
 * Jeder Endpunkt kann gezielt in einen Fehlerzustand versetzt werden
 * (`failPath`/`setFail`), um Failover-Ketten zu testen.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixturePrice {
  bid: number;
  ask: number;
  last: number;
  volume24h?: number;
}

export class MarketFixtureServer {
  private server: http.Server | null = null;
  private failed = new Set<string>();
  /** symbol (upper) → Preis; Endpunkt antwortet 404, wenn unbekannt. */
  prices = new Map<string, FixturePrice>();
  requests: { path: string; at: number }[] = [];

  /** Lege Preis für ein Symbol an (z. B. "BTCUSDT" → Binance, "SPY" → Yahoo). */
  setPrice(symbol: string, p: FixturePrice): void {
    this.prices.set(symbol.toUpperCase(), p);
  }

  /** Markiere einen Pfad als ausgefallen (HTTP 503). */
  setFail(pathPart: string, fail = true): void {
    if (fail) this.failed.add(pathPart);
    else this.failed.delete(pathPart);
  }

  failCount(pathPart: string): number {
    return this.requests.filter((r) => r.path.includes(pathPart)).length;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      this.requests.push({ path, at: Date.now() });
      const isBinance = path.includes("/api/v3/");
      const isYahooChart = path.includes("/v8/finance/chart/");
      const isYahooScreener = path.includes("/v1/finance/screener");

      if (this.isFailed(path)) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: -1003, msg: "fixture: Outage" }));
        return;
      }

      if (isBinance) {
        this.handleBinance(path, res);
        return;
      }
      if (isYahooScreener) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ finance: { result: [{ quotes: [] }] } }));
        return;
      }
      if (isYahooChart) {
        this.handleYahooChart(path, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private isFailed(path: string): boolean {
    for (const f of this.failed) if (path.includes(f)) return true;
    return false;
  }

  private symbolFromPath(path: string): string | null {
    const m = path.match(/symbol=([^&]+)/);
    if (m) return decodeURIComponent(m[1]).toUpperCase();
    // Yahoo: /v8/finance/chart/{SYM}?...
    const ym = path.match(/\/v8\/finance\/chart\/([^?]+)/);
    if (ym) return decodeURIComponent(ym[1]).toUpperCase();
    return null;
  }

  private priceOr404(symbol: string | null, res: http.ServerResponse): boolean {
    if (!symbol || !this.prices.has(symbol)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown symbol" }));
      return false;
    }
    return true;
  }

  private handleBinance(path: string, res: http.ServerResponse): void {
    const symbol = this.symbolFromPath(path);
    if (!this.priceOr404(symbol, res)) return;
    const p = this.prices.get(symbol!)!;
    if (path.includes("/bookTicker")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ symbol, bidPrice: String(p.bid), askPrice: String(p.ask) }));
      return;
    }
    if (path.includes("/24hr")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ symbol, lastPrice: String(p.last), quoteVolume: String(p.volume24h ?? 0) }));
      return;
    }
    if (path.includes("/klines")) {
      const t = Date.now();
      const kline = [t, String(p.last), String(p.last), String(p.last), String(p.last), "100", t, "0", "0", "0", "0", "0"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([kline]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private handleYahooChart(path: string, res: http.ServerResponse): void {
    const symbol = this.symbolFromPath(path);
    if (!this.priceOr404(symbol, res)) return;
    const p = this.prices.get(symbol!)!;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: p.last, symbol },
              timestamp: [Date.now() / 1000],
              indicators: { quote: [{ open: [p.last], high: [p.last], low: [p.last], close: [p.last], volume: [0] }] },
            },
          ],
        },
      })
    );
  }
}

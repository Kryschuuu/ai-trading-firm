/**
 * Public WebSocket: Ticker- und Kline-Channels mit Reconnect/Backoff/Resubscribe.
 *
 * Offiziell: wss://fapi.bitunix.com/public/
 * Subscribe: { op: "subscribe", args: [{ symbol, ch }] }
 * Channels:  ticker | market_kline_{1min|5min|…}
 *
 * Snapshot-Delta: Ticker = Full-Replace; Kline = Update gleicher `time`,
 * sonst Append (neue Kerze).
 */
import { BitunixApiError, safeSnippet } from "./errors";
import type { BitunixRuntimeConfig } from "./config";
import type { BitunixLogger } from "./redactor";
import { createBitunixLogger } from "./redactor";
import type { MarketCandle, MarketTicker } from "../../contracts/broker";
import { mapInterval } from "./publicClient";

export interface BitunixWsHandlers {
  onTicker?: (t: MarketTicker) => void;
  onKline?: (symbol: string, candle: MarketCandle) => void;
  onError?: (err: Error) => void;
  onReconnect?: (attempt: number) => void;
}

export interface BitunixWsSubscription {
  symbol: string;
  ch: string;
}

export interface BitunixWsOptions {
  config: BitunixRuntimeConfig;
  logger?: BitunixLogger;
  handlers?: BitunixWsHandlers;
  /** Injizierbar für Tests (ws-Client). */
  open?: (url: string) => WsLike;
  now?: () => number;
  /** Injizierbar für Tests (Reconnect-Wartezeit). */
  backoff?: (attempt: number) => number;
}

/** Minimales WS-Interface (Browser/ws-kompatibel). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  readyState?: number;
}

const KLINE_CH: Record<string, string> = {
  "1m": "market_kline_1min",
  "5m": "market_kline_5min",
  "15m": "market_kline_15min",
  "30m": "market_kline_30min",
  "1h": "market_kline_60min",
  "4h": "market_kline_4hour",
  "1d": "market_kline_1day",
};

export function klineChannel(interval: string): string {
  const mapped = mapInterval(interval);
  return KLINE_CH[mapped] ?? `market_kline_${mapped}`;
}

export function backoffMs(attempt: number): number {
  return Math.min(8000, 250 * 2 ** Math.min(attempt, 6));
}

function assertWsUrl(raw: string, cfg: BitunixRuntimeConfig): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BitunixApiError("ssrf", "Bitunix-WS-URL ungültig (SSRF-Schutz).");
  }
  if (url.username || url.password) {
    throw new BitunixApiError("ssrf", "Bitunix-WS-URL mit Userinfo abgelehnt (SSRF-Schutz).");
  }
  const host = url.hostname.toLowerCase();
  if (!cfg.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new BitunixApiError(
      "ssrf",
      `WS-Host "${safeSnippet(host, 40)}" nicht auf der Allowlist (SSRF-Schutz).`
    );
  }
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (url.protocol === "wss:") return url.toString();
  if (url.protocol === "ws:" && cfg.allowInsecureHttp && loopback) return url.toString();
  throw new BitunixApiError("ssrf", "WS-Schema nicht erlaubt (wss erzwungen).");
}

export class BitunixPublicWs {
  private readonly cfg: BitunixRuntimeConfig;
  private readonly logger: BitunixLogger;
  private readonly handlers: BitunixWsHandlers;
  private readonly openFn: (url: string) => WsLike;
  private readonly now: () => number;
  private readonly backoffFn: (attempt: number) => number;
  private socket: WsLike | null = null;
  private subs: BitunixWsSubscription[] = [];
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Letzter Ticker je Symbol (Snapshot). */
  readonly tickers = new Map<string, MarketTicker>();
  /** Letzte Kerze je symbol+channel (Delta: gleiche time → replace). */
  readonly klines = new Map<string, MarketCandle>();

  constructor(opts: BitunixWsOptions) {
    this.cfg = opts.config;
    this.logger = opts.logger ?? createBitunixLogger();
    this.handlers = opts.handlers ?? {};
    this.openFn = opts.open ?? defaultOpen;
    this.now = opts.now ?? (() => Date.now());
    this.backoffFn = opts.backoff ?? backoffMs;
  }

  subscribeTicker(symbol: string): void {
    this.addSub({ symbol: symbol.toUpperCase(), ch: "ticker" });
  }

  subscribeKline(symbol: string, interval: string): void {
    this.addSub({ symbol: symbol.toUpperCase(), ch: klineChannel(interval) });
  }

  async start(): Promise<void> {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  /** Für Tests: eine Push-Nachricht einspielen. */
  ingest(raw: unknown): void {
    this.handleMessage(raw);
  }

  private addSub(sub: BitunixWsSubscription): void {
    if (this.subs.some((s) => s.symbol === sub.symbol && s.ch === sub.ch)) return;
    this.subs.push(sub);
    this.sendSubscribe([sub]);
  }

  private connect(): void {
    if (this.closed) return;
    const url = assertWsUrl(this.cfg.wsUrl, this.cfg);
    try {
      this.socket = this.openFn(url);
    } catch (e) {
      this.fail(e);
      this.scheduleReconnect();
      return;
    }
    const onOpen = () => {
      this.attempts = 0;
      this.sendSubscribe(this.subs);
    };
    const onMessage = (data: unknown) => this.handleMessage(data);
    const onClose = () => {
      if (!this.closed) this.scheduleReconnect();
    };
    const onError = (err: unknown) => {
      this.fail(err);
    };
    bind(this.socket, { open: onOpen, message: onMessage, close: onClose, error: onError });
  }

  private sendSubscribe(args: BitunixWsSubscription[]): void {
    if (!this.socket || args.length === 0) return;
    try {
      this.socket.send(JSON.stringify({ op: "subscribe", args }));
    } catch (e) {
      this.fail(e);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.attempts += 1;
    const wait = this.backoffFn(this.attempts);
    this.handlers.onReconnect?.(this.attempts);
    this.logger.warn(`WS reconnect in ${wait} ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.handlers.onError?.(e);
  }

  private handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    if (typeof raw === "string") {
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
    } else if (raw && typeof raw === "object") {
      msg = raw as Record<string, unknown>;
    } else {
      return;
    }
    const ch = String(msg.ch ?? "");
    const symbol = String(msg.symbol ?? "").toUpperCase();
    const data = msg.data;
    if (ch === "ticker" || ch === "tickers") {
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      const last = Number(r.la ?? r.lastPrice ?? r.last);
      if (!Number.isFinite(last) || last <= 0) return;
      const t: MarketTicker = {
        symbol: String(r.s ?? symbol).toUpperCase(),
        price: last,
        source: "bitunix",
        ts: Number(msg.ts) || this.now(),
        markPrice: num(r.markPrice),
        quoteVol: num(r.q),
        baseVol: num(r.b),
        high: num(r.h),
        low: num(r.l),
      };
      this.tickers.set(t.symbol, t);
      this.handlers.onTicker?.(t);
      return;
    }
    if (ch.startsWith("market_kline") || ch.startsWith("mark_kline")) {
      const row = (data && typeof data === "object" ? data : null) as Record<string, unknown> | null;
      if (!row) return;
      const candle: MarketCandle = {
        time: Number(row.t ?? row.time ?? msg.ts ?? this.now()),
        open: Number(row.o),
        high: Number(row.h),
        low: Number(row.l),
        close: Number(row.c),
        volume: Number(row.b ?? row.q ?? 0),
      };
      if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;
      const key = `${symbol}:${ch}`;
      const prev = this.klines.get(key);
      if (prev && prev.time === candle.time) {
        this.klines.set(key, candle); // delta: replace same bucket
      } else {
        this.klines.set(key, candle);
      }
      this.handlers.onKline?.(symbol, candle);
    }
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bind(
  ws: WsLike,
  ev: { open: () => void; message: (d: unknown) => void; close: () => void; error: (e: unknown) => void }
): void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("open", () => ev.open());
    ws.addEventListener("message", (e) => ev.message(e.data));
    ws.addEventListener("close", () => ev.close());
    ws.addEventListener("error", (e) => ev.error(e));
    return;
  }
  ws.on?.("open", ev.open);
  ws.on?.("message", (data: unknown) => {
    const payload = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    ev.message(payload);
  });
  ws.on?.("close", ev.close);
  ws.on?.("error", ev.error);
}

function defaultOpen(url: string): WsLike {
  // `ws` ist Dependency; Tests injizieren `open` und berühren diesen Pfad nicht.
  const { WebSocket: NodeWebSocket } = require("ws") as typeof import("ws");
  return new NodeWebSocket(url) as unknown as WsLike;
}

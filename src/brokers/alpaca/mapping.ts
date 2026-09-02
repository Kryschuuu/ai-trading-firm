/**
 * Mapping Alpaca-Asset → MarketInstrument (Task 12).
 *
 * Alpaca-Asset-Klassen:
 *   - "us_equity"  → spot/equity
 *   - "crypto"     → spot/crypto
 *
 * Fees: Alpaca veröffentlicht keine pauschalen Default-Fees im Asset-Endpoint;
 * für US-Aktien typically 0 (Free-Tier Free), Crypto gebührenfrei. Wir setzen
 * 0 als Default (konservativ, deckt das Free-Tier ab).
 *
 * Symbole: Alpaca-Format ist kanonisch (z. B. "AAPL", "BTC/USD"). Für Crypto
 * verwenden wir "BTC/USD" als kanonisches Symbol — die Universe-Registry
 * speichert es in dieser Form.
 */
import type { MarketInstrument } from "../../universe/types";
import { applyAvailabilityProjection } from "../../universe/capabilityProjection";
import { isValidVenueNativeSymbol } from "../../symbols/normalize";
import type { AlpacaAccount, AlpacaAsset, AlpacaPosition } from "./types";

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function mapStatus(raw: unknown): MarketInstrument["status"] {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "active") return "active";
  return "halted";
}

function mapAssetClass(raw: unknown): MarketInstrument["assetClass"] {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "us_equity") return "equity";
  if (s === "crypto") return "crypto";
  return "other";
}

function splitCryptoSymbol(symbol: string): { base: string; quote: string } | null {
  if (!symbol.includes("/")) return null;
  const [base, ...rest] = symbol.split("/");
  const quote = rest.join("/");
  if (!base || !quote) return null;
  return { base, quote };
}

function mapMarketType(raw: unknown): MarketInstrument["marketType"] {
  // Alpaca unterstützt nur Spot (Aktien + Crypto). Keine Futures/Options/Perps
  // im Standard-Asset-Set.
  return "spot";
}

/**
 * Mappt ein Alpaca-Asset auf den Universe-Contract. Liefert `null`, wenn das
 * Symbol nicht akzeptabel ist (falsche Form, leer, delisted).
 */
export function mapAsset(raw: AlpacaAsset, now: Date = new Date()): MarketInstrument | null {
  if (!raw || typeof raw !== "object") return null;
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  if (!symbol || !isValidVenueNativeSymbol("ALPACA", symbol)) return null;
  if (raw.tradable === false || raw.status !== "active") return null;

  const assetClass = mapAssetClass(raw.class);
  const marketType = mapMarketType(raw.class);
  const status = mapStatus(raw.status);

  const shortAvailable = raw.shortable === true && raw.easy_to_borrow === true;
  const marginable = raw.marginable === true;
  // Crypto-Symbole in Alpaca-Form: "BTC/USD" → base=BTC, quote=USD.
  // Equities: "AAPL" → base=AAPL, quote=USD.
  const cryptoSplit = assetClass === "crypto" ? splitCryptoSymbol(symbol) : null;
  const base = cryptoSplit ? cryptoSplit.base : symbol;
  const quote = cryptoSplit ? cryptoSplit.quote : "USD";
  const inst: MarketInstrument = {
    id: `ALPACA:${symbol}`,
    venue: "ALPACA",
    symbol,
    base,
    quote,
    assetClass,
    marketType,
    status,
    minQuantity: 0,
    priceStep: 0.01,
    quantityStep: assetClass === "crypto" ? 1e-8 : 1e-6,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable: marginable,
    shortAvailable,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: false, // bleibt systemseitig false bis Live-Gate öffnet
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
  // Spiegelung der systemweiten Live-Availability (SSoT).
  return applyAvailabilityProjection(inst);
}

/**
 * Mappt eine Liste von Assets. Defekte Zeilen werden übersprungen.
 */
export function mapAssets(rows: readonly AlpacaAsset[] | null | undefined, now: Date = new Date()): MarketInstrument[] {
  if (!Array.isArray(rows)) return [];
  const out: MarketInstrument[] = [];
  for (const r of rows) {
    const mapped = mapAsset(r, now);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Mappt einen Alpaca-Bar auf den MarketCandle-Contract (epoch-ms).
 */
export function mapBar(raw: { t?: string; o?: number; h?: number; l?: number; c?: number; v?: number } | null | undefined): import("../../contracts/broker").MarketCandle | null {
  if (!raw || typeof raw !== "object") return null;
  const t = typeof raw.t === "string" ? Date.parse(raw.t) : NaN;
  if (!Number.isFinite(t)) return null;
  const open = asNumber(raw.o, NaN);
  const high = asNumber(raw.h, NaN);
  const low = asNumber(raw.l, NaN);
  const close = asNumber(raw.c, NaN);
  const volume = asNumber(raw.v, 0);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  return { time: t, open, high, low, close, volume };
}

export function mapBars(
  bars: readonly { t?: string; o?: number; h?: number; l?: number; c?: number; v?: number }[] | null | undefined
): import("../../contracts/broker").MarketCandle[] {
  if (!Array.isArray(bars)) return [];
  const out: import("../../contracts/broker").MarketCandle[] = [];
  for (const b of bars) {
    const c = mapBar(b);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Mappt eine Alpaca-Order auf BrokerOrderResult. Setzt fillPrice=0 bei
 * nicht-FILLED-Status. SL/TP werden aus den Legs gezogen (Bracket).
 */
export function mapOrderResult(
  raw: { id: string; symbol: string; side: string; qty?: string; filled_qty?: string; filled_avg_price?: string; status: string },
  reqQty: number
): import("../../contracts/broker").BrokerOrderResult {
  const filledQty = asNumber(raw.filled_qty, 0);
  const fillPrice = asNumber(raw.filled_avg_price, 0);
  const isFilled = raw.status === "filled";
  return {
    orderId: raw.id,
    symbol: raw.symbol,
    side: raw.side === "buy" ? "LONG" : "SHORT",
    qty: filledQty > 0 ? filledQty : reqQty,
    fillPrice: isFilled ? fillPrice : 0,
    status: isFilled ? "FILLED" : "REJECTED",
    reason: isFilled ? undefined : raw.status,
    stopLoss: null,
    takeProfit: null,
  };
}

/**
 * Mappt eine Alpaca-Position auf BrokerPosition.
 */
export function mapPosition(raw: AlpacaPosition): import("../../contracts/broker").BrokerPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const qty = asNumber(raw.qty, 0);
  const entry = asNumber(raw.avg_entry_price, 0);
  const last = asNumber(raw.current_price, 0);
  const pnl = asNumber(raw.unrealized_pl, 0);
  if (qty === 0 || entry === 0) return null;
  return {
    symbol: raw.symbol,
    side: raw.side === "long" ? "LONG" : "SHORT",
    qty,
    entryPrice: entry,
    lastPrice: last,
    unrealizedPnl: pnl,
    stopLoss: null,
    takeProfit: null,
  };
}

/**
 * Mappt ein Alpaca-Account auf BrokerAccount.
 */
export function mapAccount(raw: AlpacaAccount, startingEquity: number): import("../../contracts/broker").BrokerAccount {
  const equity = asNumber(raw.portfolio_value, 0);
  const cash = asNumber(raw.cash, 0);
  return {
    equity,
    cash,
    openPositions: 0, // wird vom Adapter aus positions gesetzt
    startingEquity,
    drawdownPct: startingEquity > 0 ? Math.max(0, (startingEquity - equity) / startingEquity) : 0,
  };
}

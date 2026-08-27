/**
 * Bitunix-interne Typen (Task 07).
 *
 * Venue-Details bleiben hinter dem Adapter. Der Kern kennt nur
 * `BrokerAdapter` / `MarketInstrument` (vgl. task-01/02).
 */

/** Envelope der Bitunix-REST-API. */
export interface BitunixEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

/** Roh-Zeile von GET /api/v1/futures/market/trading_pairs. */
export interface BitunixTradingPair {
  symbol: string;
  base?: string;
  quote?: string;
  minTradeVolume?: string | number;
  maxLimitOrderVolume?: string | number;
  maxMarketOrderVolume?: string | number;
  basePrecision?: number;
  quotePrecision?: number;
  minLeverage?: number;
  maxLeverage?: number;
  defaultLeverage?: number;
  symbolStatus?: string;
  isApiSupported?: boolean;
  /** Unbekannte Felder werden toleriert (Index-Signatur). */
  [extra: string]: unknown;
}

/** Roh-Ticker von GET /api/v1/futures/market/tickers. */
export interface BitunixTickerRaw {
  symbol: string;
  lastPrice?: string | number;
  markPrice?: string | number;
  last?: string | number;
  quoteVol?: string | number;
  baseVol?: string | number;
  high?: string | number;
  low?: string | number;
  open?: string | number;
  [extra: string]: unknown;
}

/** Roh-Kerze von GET /api/v1/futures/market/kline. */
export interface BitunixKlineRaw {
  time?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  quoteVol?: number | string;
  baseVol?: number | string;
  type?: string;
  [extra: string]: unknown;
}

/** Orderbuch von GET /api/v1/futures/market/depth. */
export interface BitunixDepthRaw {
  asks?: Array<[number | string, number | string]>;
  bids?: Array<[number | string, number | string]>;
  [extra: string]: unknown;
}

/** Place-Order-Body (Venue-Level inkl. SL/TP). */
export interface BitunixPlaceOrderBody {
  symbol: string;
  qty: string;
  side: "BUY" | "SELL";
  tradeSide: "OPEN" | "CLOSE";
  orderType: "LIMIT" | "MARKET";
  price?: string;
  effect?: "IOC" | "FOK" | "GTC" | "POST_ONLY";
  clientId?: string;
  reduceOnly?: boolean;
  tpPrice?: string;
  tpStopType?: "MARK_PRICE" | "LAST_PRICE" | "MARK";
  tpOrderType?: "LIMIT" | "MARKET";
  tpOrderPrice?: string;
  slPrice?: string;
  slStopType?: "MARK_PRICE" | "LAST_PRICE" | "MARK";
  slOrderType?: "LIMIT" | "MARKET";
  slOrderPrice?: string;
}

/** Account-Zeile GET /api/v1/futures/account. */
export interface BitunixAccountRaw {
  marginCoin?: string;
  available?: string;
  frozen?: string;
  margin?: string;
  transfer?: string;
  positionMode?: string;
  crossUnrealizedPNL?: string;
  isolationUnrealizedPNL?: string;
  bonus?: string;
  [extra: string]: unknown;
}

/** Position GET /api/v1/futures/position/get_pending_positions. */
export interface BitunixPositionRaw {
  positionId?: string;
  symbol?: string;
  qty?: string;
  side?: string;
  avgOpenPrice?: string;
  unrealizedPNL?: string;
  liqPrice?: string;
  [extra: string]: unknown;
}

/** Frontend-sichere Credential-Projektion — niemals Secrets. */
export interface BitunixCredentialStatus {
  connected: boolean;
  permissions: Array<"READ" | "TRADE">;
  liveEnabled: false;
  bitunixEnabled: boolean;
}

/** Signierte Request-Teile (ohne Secret). */
export interface SignedRequestParts {
  nonce: string;
  timestamp: string;
  sign: string;
  query: string;
  body: string;
}

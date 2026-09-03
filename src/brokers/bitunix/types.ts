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

/**
 * Order-Detail GET /api/v1/futures/trade/get_order_detail (H3-Reconciliation).
 * Venue-Status: INIT (prepare) | NEW (pending) | PART_FILLED (teilgefüllt) |
 * CANCELED | FILLED (vollständig). `tradeQty` ist die gefüllte Menge; das
 * Venue liefert KEINEN avgPrice — der wird aus den Trades (Fill[]) berechnet.
 */
export interface BitunixOrderRaw {
  orderId?: string;
  clientId?: string;
  symbol?: string;
  qty?: string | number;
  tradeQty?: string | number;
  side?: string;
  orderType?: string;
  status?: string;
  price?: string | number;
  reduceOnly?: boolean;
  ctime?: number;
  mtime?: number;
  [extra: string]: unknown;
}

/** Trade/Ausführung GET /api/v1/futures/trade/get_history_trades. */
export interface BitunixTradeRaw {
  tradeId?: string;
  orderId?: string;
  symbol?: string;
  qty?: string | number;
  price?: string | number;
  side?: string;
  fee?: string | number;
  roleType?: string;
  ctime?: number;
  [extra: string]: unknown;
}

/**
 * Ein gebuchter Fill (broker-unabhängig), wie er von
 * `BitunixPrivateClient.getExecutions` geliefert wird — die Quelle für den
 * echten avgPrice bei der Reconciliation (H3).
 */
export interface BitunixFill {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  price: number;
  fee: number;
  /** Unix-Epoch (ms) der Ausführung. */
  ts: number;
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
  /** Credentials sind hinterlegt (Env/Control-Plane) UND der Adapter ist aktiviert — KEINE Aussage über Gültigkeit. */
  configured: boolean;
  /** Ein echter (read-only) Konto-Abruf ist gelungen — nur nach `verify: true`, sonst false. */
  connected: boolean;
  /**
   * Nur durch einen echten API-Call belegte Rechte — nie angenommen.
   * Ohne `verify` immer leer. Bitunix' Account-Antwort weist keine
   * Handelsberechtigung aus, daher wird maximal READ gemeldet (TRADE ließe
   * sich nur durch eine echte Order beweisen).
   */
  permissions: Array<"READ" | "TRADE">;
  /** true = `permissions` wurden verifiziert statt aus der bloßen Existenz von Credentials gefolgert. */
  permissionsVerified: boolean;
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

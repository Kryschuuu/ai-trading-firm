/**
 * Alpaca-Typdefinitionen (Task 12).
 *
 * Nur die Felder, die wir tatsächlich verarbeiten. Alpaca-API-Doku:
 *   Trade v2:    https://alpaca.markets/docs/api-references/trading-api/
 *   Data v2:     https://alpaca.markets/docs/api-references/market-data-api/
 *
 * Bewusst minimal und tolerant: unbekannte Felder werden ignoriert, Strings
 * werden defensiv geparst. Niemand soll die Venue-Doku 1:1 nachbauen müssen.
 */

export interface AlpacaAsset {
  id: string;
  /** "us_equity" | "crypto" | ... */
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: "active" | "inactive" | "delisted";
  tradable: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easy_to_borrow?: boolean;
  fractionable?: boolean;
}

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power?: string;
  equity?: string;
  last_equity?: string;
  pattern_day_trader?: boolean;
  trading_blocked?: boolean;
  transfers_blocked?: boolean;
  account_blocked?: boolean;
  created_at?: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  side: "long" | "short";
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export interface AlpacaOrderRequest {
  symbol: string;
  qty?: string | number;
  notional?: string | number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  time_in_force: "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
  limit_price?: string | number;
  stop_price?: string | number;
  client_order_id?: string;
  extended_hours?: boolean;
  /** Alpaca unterstützt keine nativen SL/TP im Order-Body, aber Take-Profit/Stop-Loss als separate leg-orders (v2). */
  order_class?: "simple" | "bracket" | "oco" | "oto";
  take_profit?: { limit_price: string | number };
  stop_loss?: { stop_price: string | number; limit_price?: string | number };
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at?: string;
  submitted_at?: string;
  filled_at?: string;
  expired_at?: string;
  canceled_at?: string;
  failed_at?: string;
  asset_id?: string;
  symbol: string;
  asset_class?: string;
  qty?: string;
  filled_qty?: string;
  filled_avg_price?: string;
  order_class?: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price?: string;
  stop_price?: string;
  status:
    | "new"
    | "partially_filled"
    | "filled"
    | "done_for_day"
    | "canceled"
    | "expired"
    | "rejected"
    | "pending_cancel"
    | "pending_replace"
    | "accepted"
    | "pending_new"
    | "accepted_for_bidding"
    | "stopped"
    | "suspended"
    | "calculated";
  legs?: AlpacaOrder[];
  trail_percent?: string;
  trail_price?: string;
  hwm?: string;
}

export interface AlpacaBar {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]>;
  next_page_token?: string;
}

export interface AlpacaSnapshot {
  symbol: string;
  latestTrade?: { t: string; p: number; s: number; c?: string[] };
  latestQuote?: { t: string; bp: number; bs: number; ap: number; as: number };
  minuteBar?: AlpacaBar;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

export interface AlpacaCredentialStatus {
  configured: boolean;
  connected: boolean;
  permissions: string[];
  permissionsVerified: boolean;
  liveEnabled: boolean;
  alpacaEnabled: boolean;
  paper: boolean;
}

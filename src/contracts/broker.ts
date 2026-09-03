/**
 * Broker-Contracts (Task 02 — Broker-Capability-Modell).
 *
 * Gemeinsame, venue-unabhängige Schicht zwischen Kern (engine, risk, agents,
 * API) und den Broker-Adaptern. Der Kern kennt NUR diese Interfaces —
 * broker-spezifische Details (REST-Formate, Auth, Symbole) existieren
 * ausschließlich im jeweiligen Adapter (Decoupling-Regel 1).
 *
 * Execution-Modi (erstklassiges Konzept, Regel 2):
 *   backtest  = historischer Kurs, simulierte Order
 *   paper     = realer Kurs,        simulierte Order
 *   testnet   = realer (Testnet-)Kurs, Broker-Order
 *   live      = realer Kurs,        reale Order
 *
 * Fail-Safe (Regel 3): Der Live-Pfad wird in diesem Stadium durch
 * `LiveTradingGateError` hart gesperrt. Es gibt bewusst KEINEN stillschweigenden
 * Fallback auf Paper — jede Abweisung ist ein lauter, auditierter Fehler.
 */

// shared contract, vgl. task-01 — Task 01 (Market Universe) ist gemerged;
// `MarketInstrument` wird hier NICHT dupliziert, sondern aus dem
// Universum-Contract wiederverwendet (Single Source of Truth).
export type { MarketInstrument } from "../universe/types";

/** Die vier Ausführungsmodi mit fester Semantik (siehe Header). */
export type ExecutionMode = "backtest" | "paper" | "testnet" | "live";

/** Alle gültigen Execution-Modi (Validierung, Doku, Tests). */
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "backtest",
  "paper",
  "testnet",
  "live",
];

/**
 * Venue-IDs, für die diese Plattform Adapter kennt. `PAPER` ist der interne
 * Simulator; ALPACA/IBKR/BINANCE/KRAKEN/DYDX sind Stubs; `BITUNIX` ist der
 * siebte Adapter (Task 07, Live hart gesperrt).
 */
export type BrokerVenueId =
  | "PAPER"
  | "ALPACA"
  | "IBKR"
  | "BINANCE"
  | "KRAKEN"
  | "DYDX"
  | "BITUNIX";

/** Alle Adapter-Venues (Single Source of Truth: Capability-Table). */
export const BROKER_VENUE_IDS: readonly BrokerVenueId[] = [
  "PAPER",
  "ALPACA",
  "IBKR",
  "BINANCE",
  "KRAKEN",
  "DYDX",
  "BITUNIX",
];

/**
 * Was ein Broker-Adapter KANN.
 *
 * WICHTIG: Die Flags beschreiben, was der **Adapter-Code dieses Repos** aktuell
 * ausführen kann (ehrliche Ist-Lage), nicht, was der Broker-Anbieter als
 * Angebot bewirbt. Das Venue-Angebot (z. B. „Alpaca bietet Paper-API“) bleibt
 * als Doku-Feld in `BROKER_REGISTRY` (label/note/paperApi).
 *
 * `paper`   = der Adapter betreibt ein simuliertes Depot (simulierte Orders).
 *             Dient zugleich als Gate für `backtest` (simulierte Orders gegen
 *             historische Kurse).
 * `live`    = der Adapter KANN reale Orders senden. Selbst wenn `live` einmal
 *             true wird, öffnet das NICHTS: Die Factory wirft bis zum
 *             Live-Trading-Gate-Task immer `LiveTradingGateError`.
 */
export interface BrokerCapabilities {
  /** Instrumente vom Venue (oder einer lokalen Quelle) entdecken. */
  discovery: boolean;
  /** Kurse/Kerzen liefern. */
  marketData: boolean;
  /** Orders ausführen (simuliert oder real, je nach Modus). */
  trading: boolean;
  /** Simuliertes Depot betreiben (Gate für backtest + paper). */
  paper: boolean;
  /** Broker-Testnet als Ausführungsziel betreiben. */
  testnet: boolean;
  /** Reale Order-Ausführung technisch möglich (Gate-Task schließt weiter auf). */
  live: boolean;
  /** Welche Markttypen der Adapter abdeckt. */
  instrumentTypes: {
    spot: boolean;
    perpetual: boolean;
    future: boolean;
    option: boolean;
  };
  /**
   * SL/TP kann direkt am Order-Aufruf beim Venue platziert werden
   * (Bracket/Stop-Orders). Wichtig für den späteren Bitunix-Adapter; der
   * interne Paper-Broker verwaltet SL/TP intern (Monitor), daher `false`.
   */
  stopAtVenue: boolean;
}

/** Health-Status eines Brokers. */
export type BrokerHealthStatus = "online" | "degraded" | "offline";

export interface BrokerHealth {
  status: BrokerHealthStatus;
  /** Antwortzeit des Checks in ms (lokale Checks ≈ 0). */
  latencyMs: number;
  /**
   * Freies Detail-Objekt. Enthielt **nie** Credentials, Connection-Strings oder
   * interne Infrastruktur-Details (Security-Regel).
   */
  details: Record<string, unknown>;
}

/** Ein aktueller Kurs. */
export interface MarketTicker {
  symbol: string;
  price: number;
  /** "binance" | "yahoo" | "cache" | "static" | "bitunix" | … (je Quelle). */
  source: string;
  /** Unix-Epoch (ms) des Kurs-Zeitpunkts. */
  ts: number;
  /** Mark-Preis (Futures); optional, venue-spezifisch. */
  markPrice?: number;
  /** 24h-Volumen in Quote. */
  quoteVol?: number;
  /** 24h-Volumen in Base. */
  baseVol?: number;
  /** 24h-Hoch. */
  high?: number;
  /** 24h-Tief. */
  low?: number;
}

/** Eine Ebene eines Orderbuchs (Preis, Menge). */
export interface MarketOrderBookLevel {
  price: number;
  qty: number;
}

/** Orderbuch-Snapshot (optional auf Adaptern mit marketData). */
export interface MarketOrderBook {
  symbol: string;
  bids: MarketOrderBookLevel[];
  asks: MarketOrderBookLevel[];
  ts: number;
}

/** Eine Kerze (OHLCV), epoch-ms. */
export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Kontozustand eines Brokers (simuliert oder real). */
export interface BrokerAccount {
  /** Mark-to-Market-Equity in Kontowährung. */
  equity: number;
  /** Freies Cash in Kontowährung. */
  cash: number;
  /** Anzahl offener Positionen. */
  openPositions: number;
  /** Startkapital (Basis für Drawdown). */
  startingEquity: number;
  /** Drawdown vs. Startkapital (0.12 = 12 % im Minus). */
  drawdownPct: number;
}

/** Order-Request im broker-unabhängigen Format. */
export interface BrokerOrderRequest {
  /**
   * Sanitisiertes Venue-Symbol. PAPER-Orders tragen kanonische Symbole
   * (`marketData.sanitizeSymbol` → `src/symbols`-SSoT, SYM-007); Live-Adapter
   * verlangen die venue-native Form (`isValidVenueNativeSymbol`).
   */
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  limitPrice?: number;
  /** Absoluter Stop-Loss-Preis. */
  stopLoss?: number;
  /** Absoluter Take-Profit-Preis. */
  takeProfit?: number;
  /** Notional (qty × Preis) in Kontowährung — Basis der Guardrail-Prüfung. */
  riskNotional: number;
}

/**
 * Order-Status (H3-FIX): Die reine AKZEPTANZ einer Live-Order durch das Venue
 * ist KEIN Fill. Deshalb gibt es jetzt eine explizite Lifecycle-Kette:
 *
 *   NEW               = Order wurde vom Venue angenommen (ack), noch kein Fill.
 *                       fillPrice ist 0 — es darf NICHTS eingebucht werden.
 *   PARTIALLY_FILLED  = Teilfill; filledQty < qty, fillPrice = echter avgPrice.
 *   FILLED            = vollständig gefüllt; fillPrice = echter avgPrice (>0).
 *   CANCELED          = Gestrichen (ggf. mit Teilfills, siehe filledQty).
 *   REJECTED          = Abgelehnt (Guardrails/Gate/Venue) — nie versendet.
 *   UNKNOWN           = Status nicht zweifelsfrei ermittelbar (z. B.
 *                       Timeout nach place_order, Order nicht auffindbar,
 *                       Fill-Preis nicht belegbar). Fail-safe: wie kein Fill.
 *
 * Paper-/Backtest-Engines füllen synchron und liefern weiterhin "FILLED".
 */
export type BrokerOrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "UNKNOWN";

/** Status, die einen (ggf. teilweisen) echten Fill bedeuten. */
export const FILLED_ORDER_STATUSES: readonly BrokerOrderStatus[] = [
  "PARTIALLY_FILLED",
  "FILLED",
];

/** true, wenn der Status einen echten Fill (mit avgPrice) bedeutet. */
export function isFillStatus(status: BrokerOrderStatus): boolean {
  return FILLED_ORDER_STATUSES.includes(status);
}

/**
 * true, wenn ein Ergebnis mit diesem Status eine Position EINBUCHEN darf.
 * Nur ein vollständig belegter Fill zählt — NEW/CANCELED/REJECTED/UNKNOWN und
 * jeder Status mit fillPrice ≤ 0 bleiben draußen (H3: nie Entry-Preis 0).
 */
export function isBookableFill(result: {
  status: BrokerOrderStatus;
  fillPrice: number;
}): boolean {
  return result.status === "FILLED" && Number.isFinite(result.fillPrice) && result.fillPrice > 0;
}

/** Order-Ergebnis (simuliert oder real). */
export interface BrokerOrderResult {
  orderId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  /**
   * Tatsächlich gefüllte Menge. Bei synchronen Paper-Fills = qty; bei
   * Live-Reconciliation die vom Venue gemeldete Trade-Menge (0 bei NEW).
   */
  filledQty?: number;
  /**
   * Durchschnittlicher Fill-Preis. 0 bedeutet „kein Fill“ (NEW/REJECTED/
   * UNKNOWN) — eine Position darf NUR mit fillPrice > 0 eingebucht werden.
   */
  fillPrice: number;
  status: BrokerOrderStatus;
  /** Maschinenlesbarer Grund (Ablehnung z. B. KILL_SWITCH_ARMED oder Hinweis wie ORDER_ACCEPTED). */
  reason?: string;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** Offene Position aus Sicht des Brokers. */
export interface BrokerPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * Das Broker-Interface — die EINE GRENZE, über die der Kern mit dem Markt
 * spricht. Alle Methoden außer `healthCheck` sind optional; Aufrufer müssen
 * die Capability prüfen und auf `NotSupportedCapabilityError` reagieren
 * (die Adapter werfen selbst, wenn capability=false — defensive Tiefe).
 */
export interface BrokerAdapter {
  /** Venue-ID dieses Adapters. */
  readonly id: BrokerVenueId;
  /** Execution-Modus, in dem die Factory-Instanz erzeugt wurde. */
  readonly mode: ExecutionMode;
  /** Fähigkeitsdeklaration (Single Source of Truth für Gating/Projektion). */
  readonly capabilities: BrokerCapabilities;
  /**
   * Read-only Health-Check. `opts.remote=true` erlaubt einen echten
   * read-only Remote-Check — nur wenn der Adapter das kann UND der
   * Betreiber `BROKER_HEALTHCHECK_REMOTE=true` gesetzt hat (Default OFF).
   */
  healthCheck(opts?: { remote?: boolean }): Promise<BrokerHealth>;
  discoverInstruments?(): Promise<import("../universe/types").MarketInstrument[]>;
  getTicker?(symbol: string): Promise<MarketTicker>;
  getCandles?(symbol: string, timeframe: string): Promise<MarketCandle[]>;
  getOrderBook?(symbol: string): Promise<MarketOrderBook>;
  getAccount?(): Promise<BrokerAccount>;
  placeOrder?(req: BrokerOrderRequest): Promise<BrokerOrderResult>;
  /**
   * H3: Fill-Reconciliation für Live-Orders. Nach `placeOrder` (das bei
   * Live-Adaptern nur die AKZEPTANZ — Status NEW — zurückgibt) wird hier der
   * echte Venue-Status abgefragt (Order-Detail + Ausführungen). Liefert einen
   * BrokerOrderResult mit dem ECHTEN avgPrice/gefüllter Menge
   * (NEW → PARTIALLY_FILLED → FILLED). Positionen werden erst gebucht, wenn
   * das Ergebnis FILLED mit fillPrice > 0 ist — nie mit 0.
   * Fehlt die Methode (Paper: synchroner Fill), ist keine Reconciliation nötig.
   */
  reconcileOrder?(orderId: string): Promise<BrokerOrderResult | null>;
  getPositions?(): Promise<BrokerPosition[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fehlerklassen — laut, explizit, auditierbar. Niemals stiller Fallback.
// ─────────────────────────────────────────────────────────────────────────────

/** Basis aller Broker-Fehler mit maschinenlesbarem Code. */
export class BrokerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * LIVE-Trading ist gesperrt. `getBroker(venue, "live")` wirft diesen Fehler
 * **immer** — standardmäßig, unabhängig von Capability-Flags oder Env-Variablen.
 * Der Live-Pfad wird erst durch den Live-Trading-Gate-Task (State-Machine +
 * Hard-Gates) geöffnet. Es gibt keinen impliziten Fallback auf Paper.
 */
export class LiveTradingGateError extends BrokerError {
  constructor(venue: string, extra?: string) {
    super(
      "LIVE_TRADING_GATE",
      `LIVE-Trading für "${venue}" ist gesperrt: Der Live-Pfad wird erst durch ` +
        `den Live-Trading-Gate-Task (State-Machine + Hard-Gates) geöffnet. ` +
        `Es gibt keinen impliziten Fallback auf Paper — bitte moduskonform ` +
        `backtest | paper | testnet verwenden. Details: docs/BROKER_ARCHITECTURE.md` +
        (extra ? ` ${extra}` : "")
    );
  }
}

/**
 * Der Adapter unterstützt die geforderte Capability nicht. Entsteht bei
 * fehlendem Capability-Flag (Factory-Gating) und bei Aufrufen capability-
 * geprüfter Adapter-Methoden ohne Capability.
 */
export class NotSupportedCapabilityError extends BrokerError {
  constructor(
    readonly venue: string,
    readonly capability: string,
    method: string,
    hint?: string
  ) {
    super(
      "NOT_SUPPORTED_CAPABILITY",
      `${venue}: Methode "${method}" nicht verfügbar — Capability "${capability}" ` +
        `ist in diesem Stadium nicht vorhanden${hint ? ` (${hint})` : ""}.`
    );
  }
}

/** Unbekannte Venue — Input-Validierung vor jeder Capability-Prüfung. */
export class UnknownVenueError extends BrokerError {
  constructor(venue: string) {
    super(
      "UNKNOWN_VENUE",
      `Unbekanntes Venue: "${venue}". Erlaubt: ${BROKER_VENUE_IDS.join(", ")}.`
    );
  }
}

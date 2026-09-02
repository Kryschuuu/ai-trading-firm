/**
 * Broker-Abstraktionsschicht.
 *
 * Die Trading-Firma spricht NUR über dieses Interface mit dem Markt. Standard ist
 * PAPER-Modus (simulierte Fills mit konservativem Slippage). Echte Broker-Adapter
 * (Alpaca, IBKR, Binance, Kraken, dYdX) lassen sich hinter demselben Interface
 * einhängen, damit die Agenten-Schicht venue-unabhängig bleibt.
 */
import { killSwitch, validateOrder, RISK_LIMITS } from "./riskGuard";
import { STATIC_PRICES, getQuoteSync, sanitizeSymbol } from "./marketData";
import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import type { BrokerCapabilities, BrokerVenueId } from "../contracts/broker";
import type { MarketInstrument } from "../universe/types";

/** Broker-Name = Adapter-Venue-ID (Task 02: dieselbe Whitelist, kein zweites Set). */
export type BrokerName = BrokerVenueId;

export type OrderSide = "LONG" | "SHORT";

export type Order = {
  symbol: string;
  side: OrderSide;
  /** Stückzahl / Kontraktgröße. */
  qty: number;
  limitPrice?: number;
  /** Stop-Loss als absoluter Preis. Pflicht (RISK_LIMITS.requireStopLoss). */
  stopLoss?: number;
  /** Take-Profit als absoluter Preis (optional, wird vom Monitor überwacht). */
  takeProfit?: number;
  /** Notional (qty * Preis) in Kontowährung — Basis der Guardrail-Prüfung. */
  riskNotional: number;
};

export type Fill = {
  orderId: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  fillPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  status: "FILLED" | "REJECTED";
  reason?: string;
  /** Abgezogene Gebühren in Kontowährung (Task 03, Fill-Simulator). */
  fees?: number;
  /** true, wenn der Fill nur teilweise ausgeführt wurde (Task 03). */
  partial?: boolean;
};

/** Ein Level-1-Quote (Bid/Ask) für die Ausführungs-Simulation. */
export interface LiveQuote {
  bid: number;
  ask: number;
  last: number;
  /** Relativer Spread (0.0004 = 4 bp). */
  spread: number;
  volume24h: number | null;
}

/** Ergebnis der Ausführungs-Simulation. */
export interface ExecutedFill {
  filledQty: number;
  fillPrice: number;
  fees: number;
  status: "FILLED" | "PARTIALLY_FILLED" | "REJECTED";
  reason?: string;
}

/**
 * Ausführungs-Adapter (Task 03). Wird vom Produktivpfad injiziert, damit
 * Fills aus echten Kursen (Modus B) durch den deterministischen Simulator
 * gehen (Gebühren, Spread, Slippage, Latenz, Partial Fills).
 */
export interface PaperExecutionAdapter {
  quoteProvider(symbol: string): LiveQuote | null;
  execute(order: Order, quote: LiveQuote): ExecutedFill;
}

export type HydratePosition = {
  symbol: string;
  side: OrderSide;
  qty: number;
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

/**
 * Kursquelle: live (Binance/Yahoo, siehe marketData.ts) mit Cache und
 * statischem Fallback-Buch. Für den Hot-Path synchron lesbar.
 */
const paperPrices: Record<string, number> = STATIC_PRICES;

export function paperQuote(symbol: string): number | null {
  return getQuoteSync(symbol) ?? paperPrices[symbol.toUpperCase()] ?? null;
}

/**
 * Schutzebene (SL/TP) aus einer DB-Zeile sanitizen: null/NaN/≤0 → null.
 * Eine kaputte Schutzebene darf niemals still in den Broker-Zustand wandern.
 */
function sanitizeLevel(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class PaperBroker {
  readonly name: BrokerName = "PAPER";
  private cash: number;
  private readonly startEquity: number;
  private positions = new Map<
    string,
    { qty: number; side: OrderSide; entryPrice: number; stopLoss: number | null; takeProfit: number | null }
  >();
  private execution?: PaperExecutionAdapter;

  constructor(startEquity = 10000, execution?: PaperExecutionAdapter) {
    this.cash = startEquity;
    this.startEquity = startEquity;
    this.execution = execution;
  }

  /** Injiziert den Ausführungs-Adapter (Task 03) — idempotent. */
  setExecution(execution?: PaperExecutionAdapter): void {
    this.execution = execution;
  }

  /** true, wenn ein Ausführungs-Adapter gesetzt ist. */
  hasExecution(): boolean {
    return this.execution !== undefined;
  }

  get openPositions(): number {
    return this.positions.size;
  }

  get startingEquity(): number {
    return this.startEquity;
  }

  get freeCash(): number {
    return this.cash;
  }

  /** Equity = Cash + Marktwert aller offenen Positionen (Mark-to-Market). */
  get accountEquity(): number {
    let marketValue = 0;
    for (const [symbol, p] of this.positions) {
      marketValue += p.qty * (paperQuote(symbol) ?? p.entryPrice);
    }
    return this.cash + marketValue;
  }

  /** Aktueller Drawdown gegenüber dem Startkapital (0.12 = 12 % im Minus). */
  get drawdownPct(): number {
    if (this.startEquity <= 0) return 0;
    return Math.max(0, (this.startEquity - this.accountEquity) / this.startEquity);
  }

  quote(symbol: string): number | null {
    return paperQuote(symbol);
  }

  getPosition(symbol: string) {
    const pos = this.positions.get(symbol.toUpperCase());
    if (!pos) return null;
    return { ...pos, symbol: symbol.toUpperCase() };
  }

  listPositions() {
    return [...this.positions.entries()].map(([symbol, p]) => ({
      symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      lastPrice: paperQuote(symbol) ?? p.entryPrice,
      unrealizedPnl:
        (p.side === "LONG" ? 1 : -1) * p.qty * ((paperQuote(symbol) ?? p.entryPrice) - p.entryPrice),
    }));
  }

  /**
   * Zustand aus der Datenbank wiederherstellen. Nötig, weil der Prozess (systemd
   * Restart, Deploy) neu startet, die Positionen aber in PostgreSQL persistent sind.
   *
   * KORRIGIERT (v1.1.0): Ohne `cashHint` wurde `this.cash = startEquity` gesetzt und
   * nur das Einstiegs-Notional offener Positionen abgezogen. Realisierte P&L aus
   * bereits GESCHLOSSENEN Trades (die in der DB stehen) ging dabei verloren — nach
   * einem Neustart zeigte das Depot wieder 10.000 € statt 10.200 €.
   *
   * Lösung: Der Aufrufer (engine.getBroker) übergibt den zuletzt persistenten
   * Cash-Stand aus equity_snapshots als `cashHint`. Fehlt er (frische DB, keine
   * Snapshots), wird auf die alte Berechnung zurückgefallen — konservativ, aber
   * korrekt für den Erststart.
   */
  hydrate(rows: HydratePosition[], opts?: { cashHint?: number }): void {
    // Nur plausible Zeilen übernehmen (defensive DB-Validierung).
    const valid = rows.filter(
      (r) =>
        sanitizeSymbol(r.symbol) !== null &&
        Number.isFinite(r.qty) && r.qty > 0 &&
        Number.isFinite(r.entryPrice) && r.entryPrice > 0 &&
        (r.side === "LONG" || r.side === "SHORT")
    );

    this.positions.clear();
    const hasCashHint =
      typeof opts?.cashHint === "number" &&
      Number.isFinite(opts.cashHint) &&
      opts.cashHint >= 0;
    if (hasCashHint) {
      this.cash = opts?.cashHint as number;
    } else {
      this.cash = this.startEquity;
      for (const r of valid) this.cash -= r.qty * r.entryPrice;
    }
    for (const r of valid) {
      const symbol = sanitizeSymbol(r.symbol);
      if (!symbol) continue;
      this.positions.set(symbol, {
        qty: r.qty,
        side: r.side,
        entryPrice: r.entryPrice,
        // KORRIGIERT (v1.5.2): SL/TP werden gesanitized übernommen (null/NaN/
        // ≤0 → null), damit der Broker-Zustand nach einem Neustart dieselbe
        // Wahrheit zeigt wie die Datenbank und keine kaputten Schutzebenen
        // still weitergereicht werden.
        stopLoss: sanitizeLevel(r.stopLoss),
        takeProfit: sanitizeLevel(r.takeProfit),
      });
    }
  }

  /**
   * DIE Ausführungsschleuse. JEDE Order läuft durch Kill-Switch und die harten
   * Guardrails. Kein Agent, kein Prompt und kein Modell-Output kann das umgehen.
   */
  submit(order: Order): Fill {
    // 0) Input-Validierung: kein Modell-Output und keine DB-Zeile darf hier
    //    ungültige Zahlen oder Symbole durchreichen.
    const symbol = sanitizeSymbol(order.symbol);
    if (!symbol) {
      return reject(order, `INVALID_SYMBOL:${String(order.symbol).slice(0, 40)}`);
    }
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      return reject(order, `INVALID_QTY:${String(order.qty)}`);
    }
    if (!Number.isFinite(order.riskNotional) || order.riskNotional <= 0) {
      return reject(order, `INVALID_NOTIONAL:${String(order.riskNotional)}`);
    }
    // Stop-Loss muss, wenn angegeben, ein positiver endlicher Kurs sein —
    // negative/NaN-Stops würden die SL-Überwachung des Monitors entwerten.
    const hasStopLoss =
      order.stopLoss !== undefined && order.stopLoss !== null;
    if (hasStopLoss && (!Number.isFinite(order.stopLoss as number) || (order.stopLoss as number) <= 0)) {
      return reject(order, `INVALID_STOP_LOSS:${String(order.stopLoss)}`);
    }

    // 1) Globale Notbremse.
    if (killSwitch.isArmed()) {
      return reject(order, "KILL_SWITCH_ARMED");
    }

    // 2) Kurs vorhanden?
    const price = paperQuote(symbol);
    if (price === null) {
      return reject(order, `NO_QUOTE:${symbol}`);
    }

    // H1 FIX (CRITICAL 2026-09-02): Server-seitige Notional-/Cash-Berechnung.
    // `order.riskNotional` wird validiert, aber NICHT für Sicherheitsentscheidungen vertraut.
    // Ein manipulierter Client könnte `riskNotional=1` bei `qty=1000` senden und so
    // den Cash-Guard umgehen; die tatsächlichen Kosten (qty*Fillpreis+Gebühren) wären
    // dann um Größenordnungen höher. Wir berechnen daher einheitlich:
    //   estimatedNotional = qty * price
    //   requiredCash     = estimatedNotional + geschätzte Slippage + geschätzte Gebühren
    // und prüfen Guardrails + Cash gegen diese server-seitige Größe.
    const estimatedNotional = order.qty * price;
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
      return reject(order, `INVALID_ESTIMATED_NOTIONAL:${String(estimatedNotional)}`);
    }

    // 3) Harte, im Code verankerte Guardrails — mit server-seitig berechnetem Notional.
    const guard = validateOrder({
      notional: estimatedNotional,
      equity: this.accountEquity,
      openPositions: this.positions.size,
      side: order.side,
      leverage: 1,
      hasStopLoss,
      symbol,
    });
    if (!guard.allowed) {
      return reject(order, guard.reason);
    }

    // 4) Kein Nachkauf: für ein Symbol darf nur eine Position offen sein.
    //    Verhindert, dass wiederholte Agenten-Turns dieselbe Position immer weiter
    //    aufstocken und dabei unbemerkt das gesamte Kapital binden.
    if (this.positions.has(symbol)) {
      return reject(order, `POSITION_ALREADY_OPEN:${symbol} (kein Nachkauf erlaubt)`);
    }

    // 5) Vorab-Cash-Guard mit konservativer Schätzung (Slippage + Gebühren).
    //    Der exakte, verbindliche Check erfolgt nach der Fill-Simulation (tatsächliche Kosten).
    //    Hier wird bereits grob sichergestellt, dass selbst der Idealpreis ohne Slippage nicht
    //    das verfügbare Cash übersteigt — fail-fast ohne Simulation.
    //    Für die Schätzung: 0.1 % Slippage (Legacy) + 0 Gebühren; Simulator-Pfad prüft exakt nach.
    const estimatedSlippage = estimatedNotional * 0.001;
    const estimatedFees = 0;
    const requiredCashEstimate = estimatedNotional + estimatedSlippage + estimatedFees;
    if (requiredCashEstimate > this.cash * RISK_LIMITS.maxLeverage + 1e-9) {
      return reject(
        order,
        `INSUFFICIENT_CASH: benötigt ${requiredCashEstimate.toFixed(2)} (inkl. Slippage/Gebühren, Notional ${estimatedNotional.toFixed(2)}), verfügbar ${this.cash.toFixed(2)}`
      );
    }

    // 6) Fill.
    // 6a) Modus B/Simulator: echte Kurse über den Ausführungs-Adapter
    //     (Gebühren, Spread, Slippage, Latenz, Partial Fills).
    if (this.execution) {
      const quote = this.execution.quoteProvider(symbol);
      if (!quote) {
        return reject(order, `NO_QUOTE:${symbol}`);
      }
      // Re-Berechnung mit Quote-Last für höchste Präzision (Spread-bereinigt).
      const quoteEstimatedNotional = order.qty * quote.last;
      if (!Number.isFinite(quoteEstimatedNotional) || quoteEstimatedNotional <= 0) {
        return reject(order, `INVALID_ESTIMATED_NOTIONAL:${String(quoteEstimatedNotional)}`);
      }
      const executed = this.execution.execute(order, quote);
      if (executed.status === "REJECTED" || executed.filledQty <= 0) {
        return reject(order, executed.reason ?? "SIM_REJECTED");
      }
      const filledQty = executed.filledQty;
      const fillPrice = executed.fillPrice;
      const cost = filledQty * fillPrice + executed.fees;
      if (!Number.isFinite(cost) || cost <= 0) {
        return reject(order, `INVALID_COST:${String(cost)}`);
      }
      // Verbindlicher Cash-Check gegen tatsächliche Ausführungskosten (H1).
      if (cost > this.cash * RISK_LIMITS.maxLeverage + 1e-9) {
        return reject(
          order,
          `INSUFFICIENT_CASH: benötigt ${cost.toFixed(2)} (Fill ${filledQty}×${fillPrice.toFixed(2)} + Gebühren ${executed.fees.toFixed(2)}), verfügbar ${this.cash.toFixed(2)}`
        );
      }
      this.positions.set(symbol, {
        qty: filledQty,
        side: order.side,
        entryPrice: fillPrice,
        stopLoss: order.stopLoss ?? null,
        takeProfit: order.takeProfit ?? null,
      });
      this.cash -= cost;

      return {
        orderId: `PAP-${Date.now().toString(36).toUpperCase()}`,
        symbol,
        side: order.side,
        qty: filledQty,
        fillPrice,
        stopLoss: order.stopLoss ?? null,
        takeProfit: order.takeProfit ?? null,
        status: "FILLED",
        fees: executed.fees,
        partial: executed.status === "PARTIALLY_FILLED",
      };
    }

    // 6b) Legacy-Paper-Fill mit moderatem Slippage (rohe PaperBroker-Instanz).
    const fillPrice = order.side === "LONG" ? price * 1.001 : price * 0.999;
    const cost = order.qty * fillPrice;
    if (!Number.isFinite(cost) || cost <= 0) {
      return reject(order, `INVALID_COST:${String(cost)}`);
    }
    // Verbindlicher Cash-Check gegen tatsächliche Kosten inkl. Slippage (H1).
    if (cost > this.cash * RISK_LIMITS.maxLeverage + 1e-9) {
      return reject(
        order,
        `INSUFFICIENT_CASH: benötigt ${cost.toFixed(2)} (inkl. 0.1% Slippage), verfügbar ${this.cash.toFixed(2)}`
      );
    }

    this.positions.set(symbol, {
      qty: order.qty,
      side: order.side,
      entryPrice: fillPrice,
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
    });
    this.cash -= cost;

    return {
      orderId: `PAP-${Date.now().toString(36).toUpperCase()}`,
      symbol,
      side: order.side,
      qty: order.qty,
      fillPrice,
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
      status: "FILLED",
    };
  }

  /**
   * Position glattstellen. `reason` dokumentiert WARUß geschlossen wurde
   * (STOP_LOSS, TAKE_PROFIT, MANUAL_FLATTEN, AGENT_CLOSE).
   */
  close(symbol: string, reason = "AGENT_CLOSE"): (Fill & { realizedPnl: number }) | null {
    const key = symbol.toUpperCase();
    const pos = this.positions.get(key);
    if (!pos) return null;
    const price = paperQuote(key) ?? pos.entryPrice;
    this.cash += pos.qty * price;
    this.positions.delete(key);
    const pnl =
      (pos.side === "LONG" ? 1 : -1) * pos.qty * (price - pos.entryPrice);
    return {
      orderId: `CLS-${Date.now().toString(36).toUpperCase()}`,
      symbol: key,
      side: pos.side,
      qty: pos.qty,
      fillPrice: price,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      status: "FILLED",
      realizedPnl: Number(pnl.toFixed(2)),
      reason,
    };
  }

  closeAll(reason = "MANUAL_FLATTEN"): (Fill & { realizedPnl: number })[] {
    const fills: (Fill & { realizedPnl: number })[] = [];
    for (const symbol of [...this.positions.keys()]) {
      const f = this.close(symbol, reason);
      if (f) fills.push(f);
    }
    return fills;
  }
}

function reject(order: Order, reason: string): Fill {
  const symbol =
    typeof order.symbol === "string" ? order.symbol.toUpperCase().slice(0, 40) : "INVALID";
  return {
    orderId: `REJ-${Date.now().toString(36).toUpperCase()}`,
    symbol,
    side: order.side,
    qty: order.qty,
    fillPrice: 0,
    stopLoss: order.stopLoss ?? null,
    takeProfit: order.takeProfit ?? null,
    status: "REJECTED",
    reason,
  };
}

/**
 * Broker-Registry (Task 02: Capability-Projektion).
 *
 * WICHTIG — Zwei Arten von „Paper/Live-Flags“:
 *   `paperApi`        = VENUE-ANGEBOT (Vendor-Fakt, Doku): Der Broker-Anbieter
 *                       betreibt eine Paper-/Testumgebung.
 *   `paperAvailable`  = PROJEKTION der Adapter-Capabilities: Der Adapter in
 *                       diesem Repo kann Paper-Ausführung tatsächlich betreiben.
 *   `liveAvailable`   = PROJEKTION der Adapter-Capabilities: Der Adapter kann
 *                       technisch Live-Ausführung betreiben. (Selbst wenn
 *                       einmal true: Die Factory sperrt `live` bis zur
 *                       bestandenen Live-Gate-Prüfung — Capability ≠ Freigabe.)
 *
 *   Vier getrennte Live-Konzepte (v1.20.0, docs/BROKER_ARCHITECTURE.md §3.1):
 *     - adapterCapabilities.live       (dieses Feld: Adapter kann Live senden)
 *     - MarketInstrument.liveTradable  (Instrument beim Broker live-handelbar)
 *     - venueControl.liveEnabled       (Venue aktuell aktiv)
 *     - liveGate.state                 (öffnet erst die Live-Ausführung)
 *
 * Single Source of Truth = Adapter-Capabilities (src/brokers/capabilities.ts);
 * die Registry ist nur eine Projektion davon. Der Test in
 * `tests/brokerFactory.test.ts` („Registry-Projektion“) belegt die Spiegelung.
 *
 * Für echtes Paper-/Live-Trading hier Adapter ergänzen (Alpaca für Aktien,
 * ccxt für Krypto) — gated über Env-Secrets. Details und Vergleich:
 * docs/HANDBUCH.md Kapitel 8, docs/BROKER_ARCHITECTURE.md.
 */

/**
 * Projektion: Registry-Flags aus Adapter-Capabilities ableiten.
 * SOLL (Task 02): die Registry ist keine zweite Wahrheit mehr.
 */
export function projectCapabilityFlags(caps: BrokerCapabilities): {
  paperAvailable: boolean;
  liveAvailable: boolean;
} {
  return { paperAvailable: caps.paper, liveAvailable: caps.live };
}

export type BrokerRegistryEntry = {
  label: string;
  assets: string;
  /** Venue-Angebot (Vendor-Fakt, Doku — keine Ausführungsversprechen). */
  paperApi: boolean;
  openSource: boolean;
  note: string;
  /** PROJEKTION aus Adapter-Capabilities (SSoT = Adapter). */
  paperAvailable: boolean;
  liveAvailable: boolean;
};

const REGISTRY_BASE: Record<
  BrokerName,
  Omit<BrokerRegistryEntry, "paperAvailable" | "liveAvailable">
> = {
  PAPER: {
    label: "Interner Paper-Broker",
    assets: "alles (simuliert)",
    paperApi: true,
    openSource: true,
    note: "Standard. Keine Keys, keine Netzwerkabhängigkeit, deterministisch.",
  },
  ALPACA: {
    label: "Alpaca",
    assets: "US-Aktien, ETFs, Krypto",
    paperApi: true,
    openSource: false,
    note: "Beste Paper-Trading-API zum Einstieg: kostenloses Paper-Konto, sauberes REST, Market Data inklusive.",
  },
  IBKR: {
    label: "Interactive Brokers",
    assets: "global: Aktien, Optionen, Futures, FX",
    paperApi: true,
    openSource: false,
    note: "Vollbroker mit Paper-Konto, aber TWS/IB-Gateway muss dauerhaft laufen — auf dem N150 spürbar schwerer.",
  },
  BINANCE: {
    label: "Binance",
    assets: "Krypto Spot & Futures",
    paperApi: true,
    openSource: false,
    note: "Testnet vorhanden, Anbindung via ccxt. In DE/EU Regulierung prüfen.",
  },
  KRAKEN: {
    label: "Kraken",
    assets: "Krypto Spot & Futures",
    paperApi: true,
    openSource: false,
    note: "EU-freundlich, Futures-Demo-Umgebung, ccxt-Support.",
  },
  DYDX: {
    label: "dYdX v4",
    assets: "dezentrale Perpetuals",
    paperApi: false,
    openSource: true,
    note: "Voll open source und self-custody, aber Perps = Hebel. Passt zur Philosophie, nicht zum Risikoprofil eines Einstiegs.",
  },
  BITUNIX: {
    label: "Bitunix Futures",
    assets: "Krypto-Perpetuals (USDT-M)",
    paperApi: false,
    openSource: false,
    note: "Task 07: Public REST/WS + Paper gegen echte Kurse. Kein dokumentiertes Testnet. Live-Capability ja, Ausführung bis task-11 immer LiveTradingGateError. SL/TP am Venue (stopAtVenue).",
  },
};

/**
 * Die Registry — Basisdaten + Capability-Projektion. Für JEDES Venue
 * `paperAvailable === VENUE_CAPABILITIES[v].paper` (Test belegt es).
 */
export const BROKER_REGISTRY: Record<BrokerName, BrokerRegistryEntry> = {
  PAPER: { ...REGISTRY_BASE.PAPER, ...projectCapabilityFlags(VENUE_CAPABILITIES.PAPER) },
  ALPACA: { ...REGISTRY_BASE.ALPACA, ...projectCapabilityFlags(VENUE_CAPABILITIES.ALPACA) },
  IBKR: { ...REGISTRY_BASE.IBKR, ...projectCapabilityFlags(VENUE_CAPABILITIES.IBKR) },
  BINANCE: { ...REGISTRY_BASE.BINANCE, ...projectCapabilityFlags(VENUE_CAPABILITIES.BINANCE) },
  KRAKEN: { ...REGISTRY_BASE.KRAKEN, ...projectCapabilityFlags(VENUE_CAPABILITIES.KRAKEN) },
  DYDX: { ...REGISTRY_BASE.DYDX, ...projectCapabilityFlags(VENUE_CAPABILITIES.DYDX) },
  BITUNIX: { ...REGISTRY_BASE.BITUNIX, ...projectCapabilityFlags(VENUE_CAPABILITIES.BITUNIX) },
};

/**
 * Broker-Abstraktionsschicht.
 *
 * Die Trading-Firma spricht NUR über dieses Interface mit dem Markt. Standard ist
 * PAPER-Modus (simulierte Fills mit konservativem Slippage). Echte Broker-Adapter
 * (Alpaca, IBKR, Binance, Kraken, dYdX) lassen sich hinter demselben Interface
 * einhängen, damit die Agenten-Schicht venue-unabhängig bleibt.
 */
import { killSwitch, validateOrder, RISK_LIMITS } from "./riskGuard";
import { STATIC_PRICES, getQuoteSync } from "./marketData";

export type BrokerName = "PAPER" | "ALPACA" | "IBKR" | "BINANCE" | "KRAKEN" | "DYDX";

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
};

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

export class PaperBroker {
  readonly name: BrokerName = "PAPER";
  private cash: number;
  private readonly startEquity: number;
  private positions = new Map<
    string,
    { qty: number; side: OrderSide; entryPrice: number; stopLoss: number | null; takeProfit: number | null }
  >();

  constructor(startEquity = 10000) {
    this.cash = startEquity;
    this.startEquity = startEquity;
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
   */
  hydrate(rows: HydratePosition[]) {
    this.positions.clear();
    this.cash = this.startEquity;
    for (const r of rows) {
      this.positions.set(r.symbol.toUpperCase(), {
        qty: r.qty,
        side: r.side,
        entryPrice: r.entryPrice,
        stopLoss: r.stopLoss ?? null,
        takeProfit: r.takeProfit ?? null,
      });
      this.cash -= r.qty * r.entryPrice;
    }
  }

  /**
   * DIE Ausführungsschleuse. JEDE Order läuft durch Kill-Switch und die harten
   * Guardrails. Kein Agent, kein Prompt und kein Modell-Output kann das umgehen.
   */
  submit(order: Order): Fill {
    // 1) Globale Notbremse.
    if (killSwitch.isArmed()) {
      return reject(order, "KILL_SWITCH_ARMED");
    }

    // 2) Kurs vorhanden?
    const price = paperQuote(order.symbol);
    if (price === null) {
      return reject(order, `NO_QUOTE:${order.symbol}`);
    }

    // 3) Harte, im Code verankerte Guardrails.
    const guard = validateOrder({
      notional: order.riskNotional,
      equity: this.accountEquity,
      openPositions: this.positions.size,
      side: order.side,
      leverage: 1,
      hasStopLoss: order.stopLoss !== undefined && order.stopLoss !== null,
      symbol: order.symbol,
    });
    if (!guard.allowed) {
      return reject(order, guard.reason);
    }

    // 4) Kein Nachkauf: für ein Symbol darf nur eine Position offen sein.
    //    Verhindert, dass wiederholte Agenten-Turns dieselbe Position immer weiter
    //    aufstocken und dabei unbemerkt das gesamte Kapital binden.
    if (this.positions.has(order.symbol.toUpperCase())) {
      return reject(order, `POSITION_ALREADY_OPEN:${order.symbol.toUpperCase()} (kein Nachkauf erlaubt)`);
    }

    // 5) Genug Cash? (Kein Leverage erlaubt.)
    if (order.riskNotional > this.cash * RISK_LIMITS.maxLeverage + 1e-9) {
      return reject(order, `INSUFFICIENT_CASH: benötigt ${order.riskNotional.toFixed(2)}, verfügbar ${this.cash.toFixed(2)}`);
    }

    // 6) Paper-Fill mit moderatem Slippage.
    const fillPrice = order.side === "LONG" ? price * 1.001 : price * 0.999;
    const symbol = order.symbol.toUpperCase();

    this.positions.set(symbol, {
      qty: order.qty,
      side: order.side,
      entryPrice: fillPrice,
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
    });
    this.cash -= order.qty * fillPrice;

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
  return {
    orderId: `REJ-${Date.now().toString(36).toUpperCase()}`,
    symbol: order.symbol.toUpperCase(),
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
 * Broker-Registry. Für echtes Paper-/Live-Trading hier Adapter ergänzen
 * (Alpaca für Aktien, ccxt für Krypto) — gated über Env-Secrets.
 * Details und Vergleich: docs/HANDBUCH.md, Kapitel 8.
 */
export const BROKER_REGISTRY: Record<
  BrokerName,
  { label: string; assets: string; paperApi: boolean; openSource: boolean; note: string }
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
};

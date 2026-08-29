/**
 * PAPER-Adapter (Task 02) — der EINZIG vollständig ausführbare Broker.
 *
 * Delegiert auf den Bestand, statt ihn zu duplizieren:
 *   Orders/Guardrails/Kill-Switch → `PaperBroker` (src/lib/broker.ts)
 *   Kurse/Kerzen                  → marketData.ts (Kurse: Cache + Statik;
 *                                    Kerzen: explizite Stale-Fallback-API,
 *                                    Fehler werfen — MDERR-006)
 *   Instrument-Discovery          → lokale Universe-Registry (src/universe,
 *                                    deterministisch, kein Netzwerk)
 *
 * Der Ledger (`PaperBroker`) ist ein Prozess-Singleton der Factory
 * (`paperBrokerLedger()`); die Engine hydratiert ihn aus PostgreSQL.
 * Alle Execution-Modi (backtest/paper) teilen sich diesen EINEN Ledger —
 * es entsteht nie eine zweite, unhydratierte Buchhaltung.
 */
import { PaperBroker, type Fill, type Order } from "../lib/broker";
import { getCandlesWithFallback, getQuote } from "../lib/marketData";
import { getRegistry } from "../universe";
import type { MarketInstrument } from "../universe/types";
import { VENUE_CAPABILITIES } from "./capabilities";
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerHealth,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
  ExecutionMode,
  MarketCandle,
  MarketTicker,
} from "../contracts/broker";

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly id = "PAPER" as const;
  readonly mode: ExecutionMode;
  readonly capabilities = VENUE_CAPABILITIES.PAPER;

  /** Der zugrunde liegende Ledger (Singleton der Factory, von der Engine hydratiert). */
  readonly paperBroker: PaperBroker;

  constructor(paperBroker: PaperBroker, mode: ExecutionMode = "paper") {
    this.paperBroker = paperBroker;
    this.mode = mode;
  }

  /**
   * Lokaler Check (in-process): der Paper-Broker ist immer online, solange
   * der Prozess läuft. Kein Netzwerk — der Health-Endpunkt bleibt damit
   * deterministisch und dependency-frei.
   */
  async healthCheck(): Promise<BrokerHealth> {
    const t0 = process.hrtime.bigint();
    void this.paperBroker.openPositions; // Lesezugriff als Liveness-Proof
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    return {
      status: "online",
      latencyMs,
      details: {
        simulated: true,
        engine: "PaperBroker (in-process)",
        openPositions: this.paperBroker.openPositions,
        remoteCheck: "nicht anwendbar (lokale Simulation)",
      },
    };
  }

  /**
   * Discovery aus der lokalen Universe-Registry (Task 01) — PAPER-Spiegel der
   * Instrumente. Deterministisch, offline-fähig, ohne Netzwerk.
   */
  async discoverInstruments(): Promise<MarketInstrument[]> {
    const registry = getRegistry();
    const result = registry.query({ venue: "PAPER", pageSize: 500 });
    return result.items;
  }

  /** Aktueller Kurs (live mit Cache; Fallback statisches Buch — offline-sicher). */
  async getTicker(symbol: string): Promise<MarketTicker> {
    const q = await getQuote(symbol);
    return { symbol: q.symbol, price: q.price, source: q.source, ts: q.ts };
  }

  /**
   * Kerzen für Indikatoren/Backtests (max. 120).
   *
   * MDERR-006: bewusst die **explizite** Fallback-API — der Paper-Betrieb
   * erlaubt degradierte (stale) Daten. Der Fehler bleibt trotzdem sichtbar
   * (Metrik + Log + `result.error`); ohne Cache-Eintrag wird geworfen —
   * niemals ein stilles leeres Array.
   */
  async getCandles(symbol: string, timeframe: string): Promise<MarketCandle[]> {
    const result = await getCandlesWithFallback(symbol, timeframe, 120);
    return result.candles;
  }

  async getAccount(): Promise<BrokerAccount> {
    const b = this.paperBroker;
    return {
      equity: b.accountEquity,
      cash: b.freeCash,
      openPositions: b.openPositions,
      startingEquity: b.startingEquity,
      drawdownPct: b.drawdownPct,
    };
  }

  /**
   * Simulierte Order — läuft wie jede andere Order durch die komplette
   * Schutzkette (Input-Validierung → Kill-Switch → Guardrails → Cash-Check)
   * innerhalb des `PaperBroker.submit()`.
   */
  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const order: Order = {
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      riskNotional: req.riskNotional,
    };
    if (req.limitPrice !== undefined) order.limitPrice = req.limitPrice;
    if (req.stopLoss !== undefined) order.stopLoss = req.stopLoss;
    if (req.takeProfit !== undefined) order.takeProfit = req.takeProfit;

    const fill: Fill = this.paperBroker.submit(order);
    return {
      orderId: fill.orderId,
      symbol: fill.symbol,
      side: fill.side,
      qty: fill.qty,
      fillPrice: fill.fillPrice,
      status: fill.status,
      reason: fill.reason,
      stopLoss: fill.stopLoss,
      takeProfit: fill.takeProfit,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.paperBroker.listPositions().map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      lastPrice: p.lastPrice,
      unrealizedPnl: p.unrealizedPnl,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    }));
  }
}

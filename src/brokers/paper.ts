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
 *
 * ADR-003 (v0.17.0): JEDE Order-Eröffnung läuft über
 * `PaperBroker.submitAtomic()` mit `withAccountLock` (Kontoserialisierung
 * via `pg_advisory_xact_lock`), DB-Wahrheits-Prüfung gegen `positions`
 * (status='OPEN') und `order_intents`-Reservierung mit partiellem
 * UNIQUE-Index. Ein reiner `submit()`-Aufruf ist auf dem Singleton-Ledger
 * unzulässig — er würde den Mehrprozess-Schutz (Next.js-Worker + Mikro-
 * Executor) umgehen (Befund H2). `submit()` bleibt zulässig auf lokal
 * erzeugten `new PaperBroker(…)`-Instanzen (Unit-Tests, Backtest-Ports).
 */
import { executionCapabilitiesFor } from "../execution/capabilities";
import { captureOrder } from "../executionQuality/runtime";
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
  OrderExecutionCapabilities,
} from "../contracts/broker";

/**
 * PAPER-Broker-Adapter — der deterministische Simulations-Broker.
 *
 * Implementiert den `BrokerAdapter`-Vertrag (`src/contracts/broker.ts`) über
 * den lokalen `PaperBroker`-Ledger: Fill-Simulation (Gebühren, Spread,
 * Slippage, Partial Fills), Positionen, Equity, Funding-Accrual. Kein
 * Netzwerk, keine Credentials — der Health-Status ist "online", solange der
 * Prozess läuft.
 *
 * **Rolle:** Default-Broker der Firma (`getBroker()` ohne Live-Freigabe),
 * Referenz-Basis für Backtests (die `FillSimulator`-Klasse wird geteilt) und
 * Gegenstück der Live-Adapter (Bitunix/Alpaca) — dieselben Contracts,
 * dieselben Capability-Flags (siehe `capabilities`).
 *
 * **Post-Only (RMA-P4-02):** PAPER simuliert Post-Only, Einzel-Cancel und
 * atomares Replace deterministisch (deterministisches `PaperVenuePort` in
 * `src/execution/ports.ts`) — Golden-Tests sichern byte-identische
 * Event-/Fill-Sequenzen.
 */
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
   * RMA-P4-02: PAPER simuliert Post-Only, Einzel-Cancel und atomares Replace
   * deterministisch (siehe `PaperVenuePort` in `src/execution/ports.ts`).
   */
  getExecutionCapabilities(): OrderExecutionCapabilities {
    return executionCapabilitiesFor(this.id);
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
    const equity = b.accountEquity;
    // H8: Kanonische Zerlegung — PAPER ist ein voll besichertes Cash-Konto
    // (kein Margin): unrealizedPnl aus den offenen Positionen (gleiche
    // Preisquelle wie accountEquity), walletBalance = equity − unrealizedPnl
    // (= Cash + Einstandswerte), freies Cash = cash, gebundene Margin = 0.
    const unrealizedPnl = b
      .listPositions()
      .reduce((sum, p) => sum + (Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0), 0);
    return {
      equity,
      cash: b.freeCash,
      walletBalance: equity - unrealizedPnl,
      availableCash: b.freeCash,
      usedMargin: 0,
      maintenanceMargin: 0,
      unrealizedPnl,
      openPositions: b.openPositions,
      startingEquity: b.startingEquity,
      drawdownPct: b.drawdownPct,
    };
  }

  /**
   * Simulierte Order — läuft wie jede andere Order durch die komplette
   * atomare Mehrprozess-Schleuse (`PaperBroker.submitAtomic()`):
   *   Input-Validierung → Kill-Switch → Guardrails → Cash-Check →
   *   `pg_advisory_xact_lock` (Konto) → DB-Wahrheit (`positions` OPEN) →
   *   In-Memory-Fill → `order_intents`-Reservierung (partieller UNIQUE).
   *
   * ADR-003: Über den Adapter führt KEIN Weg mehr an der DB-Serialisierung
   * vorbei — reiner `submit()` auf dem Singleton-Ledger würde Race H2
   * (parallele Worker/Executor-Prozesse) wieder öffnen.
   */
  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    return captureOrder({venue:this.id,mode:this.mode,request:req,execute:async request => this.executeOrder(request)});
  }

  private async executeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const order: Order = {
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      riskNotional: req.riskNotional,
    };
    if (req.limitPrice !== undefined) order.limitPrice = req.limitPrice;
    if (req.stopLoss !== undefined) order.stopLoss = req.stopLoss;
    if (req.takeProfit !== undefined) order.takeProfit = req.takeProfit;

    // ADR-003: submitAtomic statt submit() — exklusive Kontosperre,
    // DB-Wahrheits-Check und order_intents-Reservierung. Persistenz läuft
    // für den manuellen API-Pfad analog zu engine/microExecutor: Position
    // wird innerhalb der Transaktion geschrieben, damit Guard, Fill und
    // Positions-Insert eine atomare Einheit bilden.
    const fill: Fill = await this.paperBroker.submitAtomic(order, {
      account: "PAPER",
      persistPosition: async (tx, f) => {
        // Dynamischer Import, um Zirkularität zu vermeiden (Adapter →
        // Broker → DB-Schema — Schema importiert bereits Broker-Typen
        // nur als Typ, Runtime-Import ist aber spät sicher).
        const { positions: positionsTable } = await import("../db/schema");
        await tx.insert(positionsTable).values({
          symbol: f.symbol,
          side: f.side,
          qty: String(f.qty),
          entryPrice: String(f.fillPrice),
          currentPrice: String(f.fillPrice),
          stopLoss: f.stopLoss === null ? null : String(f.stopLoss),
          takeProfit: f.takeProfit === null ? null : String(f.takeProfit),
          broker: this.paperBroker.name,
          status: "OPEN",
        });
      },
    });
    return {
      orderId: fill.orderId,
      feesQuote: fill.fees ?? null,
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
      // GAP-02: kumuliertes Funding je Position (Kontosicht: negativ = gezahlt).
      fundingPaid: p.fundingPaid,
    }));
  }
}

/**
 * Fill-Simulator (Task 03) — lokale, deterministische Ausführungs-Simulation.
 *
 * Modelliert (alle Parameter dokumentiert in docs/PAPER_TRADING.md):
 *   - Gebühren      aus den Registry-Feldern maker_fee/taker_fee (vgl. task-01),
 *                    Fallback auf konfigurierte Werte.
 *   - Spread        aus dem Snapshot-Bid/Ask.
 *   - Slippage      linear wachsend mit Ordergröße relativ zum 24h-Volumen,
 *                    plus optionaler deterministischer Streuung (Seed).
 *   - Latenz        konfigurierbar (ms).
 *   - Partial Fills konfigurierbar (Anteil, determinstisch via Seed).
 *
 * Determinismus: Gleiche (Seed, Order, Snapshot, Instrument) → identisches
 * Ergebnis. Rein synchron & ohne IO — perfekt für Unit-/Golden-Tests.
 */
import type { MarketInstrument } from "../../universe/types";
import type { MarketSnapshot } from "./types";
import type { FillSimulatorConfig } from "./config";
import { createRng } from "./prng";

export interface SimulateOrder {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
}

export type SimulatedFillStatus = "FILLED" | "PARTIALLY_FILLED" | "REJECTED";

export interface SimulatedFill {
  orderId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  requestedQty: number;
  filledQty: number;
  fillPrice: number;
  fees: number;
  status: SimulatedFillStatus;
  reason?: string;
  latencyMs: number;
  slippageBps: number;
  spreadBps: number;
}

/** Gebühren aus den Registry-Feldern (vgl. task-01), mit Fallback. */
export function effectiveFees(
  instrument: MarketInstrument,
  config: Pick<FillSimulatorConfig, "makerFeeFallback" | "takerFeeFallback">
): { maker: number; taker: number } {
  const maker = Number.isFinite(instrument.makerFee) && instrument.makerFee > 0
    ? instrument.makerFee
    : config.makerFeeFallback;
  const taker = Number.isFinite(instrument.takerFee) && instrument.takerFee > 0
    ? instrument.takerFee
    : config.takerFeeFallback;
  return { maker, taker };
}

function symbolSeed(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (Math.imul(h, 31) + symbol.charCodeAt(i)) | 0;
  return h >>> 0;
}

export class FillSimulator {
  private seq = 0;

  constructor(private readonly config: FillSimulatorConfig) {}

  get configRef(): FillSimulatorConfig {
    return this.config;
  }

  /**
   * Simuliert einen Fill gegen einen Snapshot. Rein synchron & deterministisch.
   * Gebühren = takerFee für Market-Fill (dokumentiert).
   */
  simulate(
    order: SimulateOrder,
    snapshot: MarketSnapshot,
    instrument: MarketInstrument
  ): SimulatedFill {
    const orderId = `SIM-${(this.config.seed >>> 0).toString(36)}-${this.seq++}`;
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      return this.rejected(orderId, order, "INVALID_QTY");
    }

    const { taker } = effectiveFees(instrument, this.config);
    const volume24h =
      Number.isFinite(snapshot.volume24h) && (snapshot.volume24h as number) > 0
        ? (snapshot.volume24h as number)
        : this.config.volume24hFallback;

    // Slippage: linear mit Teilnahme am 24h-Volumen + deterministische Streuung.
    const participation = (order.qty * snapshot.last) / Math.max(volume24h, 1e-9);
    let slippageBps =
      this.config.slippageBpsBase + participation * this.config.slippageBpsPerParticipation;
    if (this.config.slippageJitterBps > 0) {
      const rng = createRng((this.config.seed ^ symbolSeed(order.symbol) ^ this.seq) >>> 0);
      slippageBps += (rng() - 0.5) * 2 * this.config.slippageJitterBps;
    }
    slippageBps = Math.max(0, slippageBps);
    const slippagePct = slippageBps / 10_000;

    // Partial Fills.
    let filledFraction = 1;
    if (this.config.partialFillEnabled) {
      const cap = Math.min(1, Math.max(0, this.config.partialFillMaxFraction));
      const rng = createRng((this.config.seed ^ symbolSeed(order.symbol) ^ 0xa1b2 ^ this.seq) >>> 0);
      // Deterministischer Liquiditätsfaktor ∈ (0,1].
      const liqFactor = 0.6 + 0.4 * rng();
      filledFraction = cap * liqFactor;
    }
    filledFraction = Math.min(1, Math.max(0, filledFraction));
    const filledQty = order.qty * filledFraction;

    if (filledQty <= 1e-12) {
      return this.rejected(orderId, order, "NO_LIQUIDITY");
    }

    // Fill-Preis: LONG am Ask, SHORT am Bid (+/− Slippage).
    const fillPrice =
      order.side === "LONG"
        ? snapshot.ask * (1 + slippagePct)
        : snapshot.bid * (1 - slippagePct);

    const fees = fillPrice * filledQty * taker;
    const status: SimulatedFillStatus =
      filledQty >= order.qty - 1e-12 ? "FILLED" : "PARTIALLY_FILLED";

    return {
      orderId,
      symbol: order.symbol,
      side: order.side,
      requestedQty: order.qty,
      filledQty,
      fillPrice,
      fees,
      status,
      latencyMs: this.config.latencyMs,
      slippageBps: Number(slippageBps.toFixed(4)),
      spreadBps: Number((snapshot.spread * 10_000).toFixed(4)),
    };
  }

  private rejected(orderId: string, order: SimulateOrder, reason: string): SimulatedFill {
    return {
      orderId,
      symbol: order.symbol,
      side: order.side,
      requestedQty: order.qty,
      filledQty: 0,
      fillPrice: 0,
      fees: 0,
      status: "REJECTED",
      reason,
      latencyMs: this.config.latencyMs,
      slippageBps: 0,
      spreadBps: 0,
    };
  }
}

/** Bequemer Factory-Helper. */
export function createFillSimulator(config: FillSimulatorConfig): FillSimulator {
  return new FillSimulator(config);
}

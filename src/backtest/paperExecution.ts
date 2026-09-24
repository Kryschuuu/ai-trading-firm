/**
 * Backtest-Ausführung über den Paper-Fill-Simulator (GAP-01, v1.51.0).
 *
 * DIESE Datei ist der einzige Kosten-Code-Pfad der Walk-Forward-Engine:
 * Einstiegs- und Ausstiegs-Fills laufen durch DIESELBE deterministische
 * `FillSimulator`-Klasse (`src/lib/marketdata/simulator.ts`), die
 * `createPaperExecution` (`src/lib/marketdata/production.ts`) in den
 * PaperBroker injiziert — kein zweiter Kosten-Code-Pfad, keine abweichende
 * Gebühren-/Slippage-Logik.
 *
 * Bausteine (alle wiederverwendet, nicht dupliziert):
 *   - `FillSimulator.simulate` — Fill-Preis (LONG am Ask, SHORT am Bid),
 *     Taker-Gebühr, Slippage (Basis + Partizipation + Seed-Jitter), Partial
 *     Fills. Deterministisch bei festem Seed + jitter 0 (Defaults).
 *   - `snapshotFromLastPrice` — Kerzen-Schlusskurs → `MarketSnapshot`
 *     (Bid/Ask symmetrisch aus dem Spread-Modell, wie die Bitunix-/Alpaca-
 *     Paper-Pfade). Spread-Quelle gestuft: Registry-`instrument.spread`
 *     (via `calculateRelativeSpread` angereichert) → kalibrierter Fallback
 *     `syntheticSpreadBps` (= `PAPER_SPREAD_FALLBACK_BPS`-Overlay).
 *   - `FundingAccrualEngine` / `computeFunding` (`src/lib/funding.ts`) —
 *     dieselbe Funding-Formel + Periodenlogik wie der Paper-Monitor-Tick.
 *     Nur eindeutig als Perpetual erkannte Instrumente werden belastet
 *     (fail-safe: unbekannt ⇒ kein Funding, nie erfundene Kosten).
 *
 * Bewusst NICHT Teil des Simulators (Marktstruktur, kein Execution):
 * die SL/TP-Trigger-Erkennung je Kerze (`detectExitTrigger`, Stop-Vorrang
 * bei Kollision — konservativ wie der Legacy-Pfad).
 *
 * Der Legacy-Simulator (`./simulator.ts`) bleibt aus Kompatibilitätsgründen
 * bestehen (`executionModel: "legacy"`, Default) und ist EINGEFROREN —
 * neue Läufe (Walk-Forward, CLI) nutzen `"paper"`. Siehe docs/BACKTESTING.md.
 */

import { simulatedBatch } from "../executionQuality/backtest";
import { qualityEnabled } from "../executionQuality/capture";
import { digest, type Batch } from "../executionQuality/model";
import { FillSimulator, type SimulatedFill as PaperSimulatedFill } from "../lib/marketdata/simulator";
import {
  calibrateSimulatorConfig,
  loadSimulatorConfig,
  type FillSimulatorConfig,
} from "../lib/marketdata/config";
import { fallbackInstrument, snapshotFromLastPrice } from "../lib/marketdata/snapshot";
import {
  computeFunding,
  FundingAccrualEngine,
  loadFundingConfig,
  type FundingRateProvider,
  type FundingAccrual,
} from "../lib/funding";
import type { MarketInstrument } from "../universe/types";
import type { MarketSnapshot } from "../lib/marketdata/types";
import type { CandleLike } from "../lib/ruleEngine";
import type { BacktestOpenPosition, TradeExitReason } from "./types";

/** Timeframe → Spread-Fallback in Basispunkten (feiner Takt = höhere Kosten). */
export function timeframeToSpreadFallbackBps(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 15; // 0,15 % — 1m hat das höchste Rauschen, engste Edge
    case "5m":
      return 10;
    case "15m":
      return 8;
    case "30m":
      return 6;
    case "1h":
      return 4;
    case "4h":
      return 3;
    case "1d":
      return 2;
    case "1w":
    case "1mo":
      return 2;
    default:
      return 4;
  }
}

/** Timeframe → Slippage-Basis in Basispunkten (feiner Takt = mehr Slippage). */
export function timeframeToSlippageBaseBps(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 3;
    case "5m":
      return 2;
    case "15m":
      return 1.5;
    case "30m":
      return 1;
    case "1h":
      return 1;
    case "4h":
      return 0.5;
    case "1d":
      return 0.5;
    default:
      return 1;
  }
}

/** Kostenprofil des Paper-Ausführungspfads (D1 „Kostenprofil“). */
export interface PaperBacktestOptions {
  /**
   * Timeframe des Laufs (z. B. "1m", "1h"). Wenn gesetzt, wird der
   * Spread-/Slippage-Fallback timeframe-abhängig skaliert (feiner Takt =
   * höhere Kosten, weil die Edge pro Bar kleiner ist). Default: "1h".
   */
  timeframe?: string;
  /**
   * Simulator-Konfiguration. Default: `calibrateSimulatorConfig(
   * loadSimulatorConfig())` — exakt dieselbe Quelle wie der PaperBroker
   * (Legacy-`PAPER_SIM_*` + GAP-02-Kalibrierungs-Overlay). Für
   * deterministische Tests explizit übergeben.
   */
  simulator?: FillSimulatorConfig;
  /**
   * Instrumente je Engine-Symbol (Fees, Spread, marketType). Fehlt ein
   * Symbol, wird ein neutrales Default-Instrument gebaut (Spot — kein
   * Funding — mit den Gebühren aus `feeModel`, Spread-Fallback unten).
   * Die CLI löst hier die Universe-Registry auf (`getRegistry().get(id)`).
   */
  instruments?: Record<string, MarketInstrument>;
  /** Gebühren-Override für Default-Instrumente (Default: Engine-`feeModel`). */
  makerFee?: number;
  takerFee?: number;
  /**
   * Spread-Fallback in Basispunkten, wenn `instrument.spread` fehlt.
   * Default: `simulator.syntheticSpreadBps` (kalibriert, Paper-identisch).
   */
  spreadBpsFallback?: number;
  /**
   * Statische Funding-Rate in PROZENT je 8h (0.01 = 0,01 %/8h).
   * Default: `loadFundingConfig()` — wie der Paper-Monitor (Default 0 =
   * neutral, kein Accrual).
   */
  fundingRatePctPer8h?: number;
  /**
   * Historischer Funding-Provider (RMA-P2-02, v1.54.0). Wenn gesetzt, schlägt
   * die Engine den Satz **pro 8h** dort nach (as-of des Bar-Zeitstempels) und
   * fällt nur zurück, wenn der Provider `null` liefert — dann greift
   * `fundingRatePctPer8h`/`loadFundingConfig()` wie bisher.
   *
   * Build: `createPerpFundingRateProvider()` aus `src/perpdata` (liest die
   * kanonische `perp_funding_rates`-Historie, nie einen Live-Ticker).
   */
  fundingRateProvider?: FundingRateProvider;
  /** Funding-Intervall in Stunden (Default: `loadFundingConfig()` = 8). */
  fundingIntervalHours?: number;
}

/** Ergebnis eines Paper-Fills im Backtest (Währung: Kontowährung). */
export interface PaperBacktestFill {
  fillPrice: number;
  filledQty: number;
  fees: number;
  /**
   * Slippage-Kosten in Kontowährung vs. Referenzkurs (|Fill − Ref| × Menge,
   * inkl. Half-Spread-Anteil) — ehrlicher „Kosten vs. Mid“-Ausweis für
   * `totalSlippagePaid`.
   */
  slippageCost: number;
  slippageBps: number;
  spreadBps: number;
  status: PaperSimulatedFill["status"];
}

/** SL/TP-Trigger je Kerze (reine Marktstruktur, noch kein Fill). */
export interface ExitTrigger {
  price: number;
  reason: Extract<TradeExitReason, "STOP_LOSS" | "TAKE_PROFIT">;
}

/** Laufzeit-Kontext EINES Backtest-Laufs (pro Lauf frisch erzeugen). */
export interface PaperExecutionRuntime {
  readonly qualityBatches: Batch[];
  /** Simulator-Instanz dieses Laufs (seq ab 0 ⇒ deterministische Order-IDs). */
  readonly simulator: FillSimulator;
  /** Effektives Instrument je Engine-Symbol (übergeben oder Default). */
  instrumentOf(symbol: string): MarketInstrument;
  /** Snapshot aus Referenzkurs (Kerzen-Close bzw. Trigger-Preis). */
  snapshotOf(symbol: string, refPrice: number, ts: number): MarketSnapshot | null;
  /** Einstiegs-Fill für ein Notional (qty = Notional / Touch-Preis). */
  fillEntry(
    symbol: string,
    side: "LONG" | "SHORT",
    notional: number,
    refPrice: number,
    ts: number,
    strategy?: string
  ): PaperBacktestFill | null;
  /** Ausstiegs-Fill (Seite = Closing-Seite) zum Trigger-/Referenzpreis. */
  fillExit(
    symbol: string,
    closingSide: "LONG" | "SHORT",
    qty: number,
    refPrice: number,
    ts: number,
    strategy?: string
  ): PaperBacktestFill | null;
  /**
   * Funding-Accruals offener Positionen zur Kerzenzeit (reine Weitergabe an
   * die Paper-`FundingAccrualEngine`; Buchung macht der Aufrufer).
   */
  accrueFunding(
    open: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; price: number }>,
    ts: number
  ): FundingAccrual[];
}

/** Zerlegt „VENUE:SYMBOL“ (Fallback-Venue PAPER für nackte Symbole). */
function splitInstrumentId(symbol: string): { venue: string; native: string } {
  const idx = symbol.indexOf(":");
  if (idx > 0 && idx < symbol.length - 1) {
    return { venue: symbol.slice(0, idx).toUpperCase(), native: symbol.slice(idx + 1).toUpperCase() };
  }
  return { venue: "PAPER", native: symbol.toUpperCase() };
}

/**
 * Neutrales Default-Instrument für Symbole ohne Registry-Eintrag.
 *
 * Fail-safe: `marketType: "spot"` (kein Funding — nur eindeutig erkannte
 * Perpetuals werden belastet, Muster `funding.ts`), Gebühren aus dem
 * Engine-`feeModel`, Spread `null` (⇒ konfigurierter Fallback).
 */
export function defaultBacktestInstrument(
  symbol: string,
  fees: { makerFee: number; takerFee: number }
): MarketInstrument {
  const { venue, native } = splitInstrumentId(symbol);
  return fallbackInstrument(venue, native, {
    id: symbol.toUpperCase(),
    marketType: "spot", // fail-safe: kein Funding ohne Registry-Perpetual
    makerFee: fees.makerFee,
    takerFee: fees.takerFee,
    spread: null,
    volume24h: null,
  });
}

/**
 * Wirksamer relativer Spread (Dezimalanteil): Registry-Wert, wenn plausibel
 * (0 < s ≤ 0.5 — darüber defektes Buch, Muster `MarketInstrument.spread`),
 * sonst der konfigurierte Fallback.
 */
export function effectiveSpreadDecimal(instrument: MarketInstrument, fallbackBps: number): number {
  const s = instrument.spread;
  if (typeof s === "number" && Number.isFinite(s) && s > 0 && s <= 0.5) return s;
  const bps = Number.isFinite(fallbackBps) && fallbackBps > 0 ? fallbackBps : 0;
  return bps / 10_000;
}

/**
 * Reine SL/TP-Trigger-Erkennung je Kerze (Marktstruktur, kein Pricing).
 *
 * ARCHITEKTUR-GARANTIE (wie der Legacy-Pfad): Trifft eine Kerze Stop UND
 * Target (Kollision), gewinnt IMMER der Stop-Loss (konservativ).
 */
export function detectExitTrigger(
  pos: Pick<BacktestOpenPosition, "side" | "stopLoss" | "takeProfit">,
  candle: CandleLike
): ExitTrigger | null {
  if (pos.side === "LONG") {
    if (pos.stopLoss !== null && pos.stopLoss !== undefined && candle.low <= pos.stopLoss) {
      return { price: pos.stopLoss, reason: "STOP_LOSS" };
    }
    if (pos.takeProfit !== null && pos.takeProfit !== undefined && candle.high >= pos.takeProfit) {
      return { price: pos.takeProfit, reason: "TAKE_PROFIT" };
    }
    return null;
  }
  if (pos.stopLoss !== null && pos.stopLoss !== undefined && candle.high >= pos.stopLoss) {
    return { price: pos.stopLoss, reason: "STOP_LOSS" };
  }
  if (pos.takeProfit !== null && pos.takeProfit !== undefined && candle.low <= pos.takeProfit) {
    return { price: pos.takeProfit, reason: "TAKE_PROFIT" };
  }
  return null;
}

/**
 * Erzeugt den Laufzeit-Kontext EINES Backtest-Laufs (pro Lauf frisch —
 * sonst läuft der Simulator-`seq`-Zähler weiter und Order-IDs driften).
 */
export function createPaperExecutionRuntime(
  opts: PaperBacktestOptions = {},
  engineFeeModel: { makerFee: number; takerFee: number } = { makerFee: 0.0002, takerFee: 0.0006 },
  completedBarOffsetMs = 0
): PaperExecutionRuntime {
  const qualityBatches: Batch[] = [];
  const captureQuality = qualityEnabled();
  // DIESELBE Quelle wie der PaperBroker: Legacy-PAPER_SIM_* + GAP-02-Overlay.
  // Timeframe-abhängige Skalierung (v0.3.0): feiner Takt = höhere Kosten.
  const baseSimulatorConfig = opts.simulator ?? calibrateSimulatorConfig(loadSimulatorConfig());
  const tf = opts.timeframe ?? "1h";
  const tfSpread = timeframeToSpreadFallbackBps(tf);
  const tfSlippage = timeframeToSlippageBaseBps(tf);
  const simulatorConfig: FillSimulatorConfig = {
    ...baseSimulatorConfig,
    // Wenn kein expliziter Simulator übergeben wurde, skalieren wir Basis-Slippage
    // und synthetischen Spread nach Timeframe — feiner Takt frisst mehr Edge.
    slippageBpsBase: opts.simulator ? baseSimulatorConfig.slippageBpsBase : Math.max(baseSimulatorConfig.slippageBpsBase, tfSlippage),
    syntheticSpreadBps: opts.simulator ? baseSimulatorConfig.syntheticSpreadBps : Math.max(baseSimulatorConfig.syntheticSpreadBps, tfSpread),
  };
  const simulator = new FillSimulator(simulatorConfig);
  const spreadFallbackBps = opts.spreadBpsFallback ?? simulatorConfig.syntheticSpreadBps;

  const fundingDefaults = loadFundingConfig();
  const fundingEngine = new FundingAccrualEngine(
    {
      intervalHours: opts.fundingIntervalHours ?? fundingDefaults.intervalHours,
      ratePctPer8h: opts.fundingRatePctPer8h ?? fundingDefaults.ratePctPer8h,
    },
    // RMA-P2-02: optionaler historischer Provider (Default: keiner ⇒ Verhalten
    // wie vor v1.54.0 — bitstabile Backtests, solange PERP_DATA_ENABLED=false).
    opts.fundingRateProvider ? { rateProvider: opts.fundingRateProvider } : {}
  );

  const provided = opts.instruments ?? {};
  const cache = new Map<string, MarketInstrument>();
  const makerFee = opts.makerFee ?? engineFeeModel.makerFee;
  const takerFee = opts.takerFee ?? engineFeeModel.takerFee;

  function instrumentOf(symbol: string): MarketInstrument {
    const hit = cache.get(symbol);
    if (hit) return hit;
    const inst = provided[symbol] ?? defaultBacktestInstrument(symbol, { makerFee, takerFee });
    cache.set(symbol, inst);
    return inst;
  }

  function snapshotOf(symbol: string, refPrice: number, ts: number): MarketSnapshot | null {
    if (!Number.isFinite(refPrice) || refPrice <= 0 || !Number.isFinite(ts)) return null;
    const { venue, native } = splitInstrumentId(symbol);
    const instrument = instrumentOf(symbol);
    // DERSELBE Snapshot-Builder wie die Bitunix-/Alpaca-Paper-Pfade.
    return snapshotFromLastPrice({
      symbol: native,
      last: refPrice,
      spread: effectiveSpreadDecimal(instrument, spreadFallbackBps),
      volume24h: null, // Kerzen-Volumen ≠ 24h-Volumen ⇒ Simulator-Fallback (ehrlich).
      venue,
      base: instrument.base ?? null,
      quote: instrument.quote ?? "USDT",
      instrumentId: symbol.toUpperCase(),
      ts,
      source: "replay",
      feed: "backtest",
    });
  }

  function toFill(
    fill: PaperSimulatedFill,
    refPrice: number
  ): PaperBacktestFill | null {
    if (fill.status === "REJECTED" || !(fill.filledQty > 0) || !(fill.fillPrice > 0)) return null;
    return {
      fillPrice: fill.fillPrice,
      filledQty: fill.filledQty,
      fees: fill.fees,
      slippageCost: Math.abs(fill.fillPrice - refPrice) * fill.filledQty,
      slippageBps: fill.slippageBps,
      spreadBps: fill.spreadBps,
      status: fill.status,
    };
  }

  function fillEntry(
    symbol: string,
    side: "LONG" | "SHORT",
    notional: number,
    refPrice: number,
    ts: number,
    strategy = "UNATTRIBUTED"
  ): PaperBacktestFill | null {
    if (!Number.isFinite(notional) || notional <= 0) return null;
    const snap = snapshotOf(symbol, refPrice, ts);
    if (!snap) return null;
    const touch = side === "LONG" ? snap.ask : snap.bid;
    if (!(touch > 0)) return null;
    const qty = notional / touch;
    if (!Number.isFinite(qty) || qty <= 0) return null;
    // DERSELBE Simulator wie der PaperBroker (kein zweiter Kosten-Code-Pfad).
    const fill = simulator.simulate({ symbol: snap.symbol, side, qty }, snap, instrumentOf(symbol));
    if (captureQuality) {
      const instrument = instrumentOf(symbol);
      qualityBatches.push(simulatedBatch({symbol,venue:instrument.venue,quote:instrument.quote,strategy,at:ts+completedBarOffsetMs,reference:refPrice,fill,inputHash:digest({snapshot:snap,instrument,fill,simulator:opts.simulator ?? null,fees:engineFeeModel})}));
    }
    return toFill(fill, refPrice);
  }

  function fillExit(
    symbol: string,
    closingSide: "LONG" | "SHORT",
    qty: number,
    refPrice: number,
    ts: number,
    strategy = "UNATTRIBUTED"
  ): PaperBacktestFill | null {
    if (!Number.isFinite(qty) || qty <= 0) return null;
    const snap = snapshotOf(symbol, refPrice, ts);
    if (!snap) return null;
    const fill = simulator.simulate({ symbol: snap.symbol, side: closingSide, qty }, snap, instrumentOf(symbol));
    if (captureQuality) {
      const instrument = instrumentOf(symbol);
      qualityBatches.push(simulatedBatch({symbol,venue:instrument.venue,quote:instrument.quote,strategy,at:ts+completedBarOffsetMs,reference:refPrice,fill,inputHash:digest({snapshot:snap,instrument,fill,simulator:opts.simulator ?? null,fees:engineFeeModel})}));
    }
    return toFill(fill, refPrice);
  }

  function accrueFunding(
    open: Array<{ symbol: string; side: "LONG" | "SHORT"; qty: number; price: number }>,
    ts: number
  ): FundingAccrual[] {
    // DIESELBE Engine + Formel wie der Paper-Monitor-Tick (funding.ts).
    return fundingEngine.dueAccruals(
      open.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        price: p.price,
        isPerpetual: instrumentOf(p.symbol).marketType === "perpetual",
      })),
      ts
    );
  }

  return { qualityBatches, simulator, instrumentOf, snapshotOf, fillEntry, fillExit, accrueFunding };
}

/** Re-Export der Paper-Funding-Formel für Tests (Import-Nachweis, kein Duplikat). */
export { computeFunding };

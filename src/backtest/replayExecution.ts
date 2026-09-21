/**
 * Event-Replay-Ausführungspfad (RMA-P1-01, v1.58.0).
 *
 * Deterministischer Replayer für Markt-, Funding- und Order-Lifecycle-
 * Ereignisse in EREIGNISZEIT — der dritte `executionModel`-Pfad neben
 * `"legacy"` (eingefroren) und `"paper"` (Fill-Simulator des PaperBrokers).
 * Er modelliert, was der Paper-Pfad nicht kann:
 *
 *   1. Order-Lifecycle mit Restmenge: `ORDER_SUBMITTED → ORDER_ACK →
 *      ORDER_PARTIAL_FILL* → ORDER_FILL | ORDER_CANCEL`. Ein PARTIAL-Exit
 *      lässt die Position mit Restmenge OFFEN (die bestehende Engine
 *      behandelte jeden Exit als Vollschluss — der Kern des Findings).
 *   2. Latenz als Zeitverschiebung: `decisionTime → submitTime →
 *      arrivalTime → fillTime(s)`. Eine Order füllt frühestens auf der
 *      ersten Kerze mit `time ≥ arrivalTime` — Latenz 0 = Paper-Konvention
 *      (Fill auf der Entscheidungskerze).
 *   3. Size-abhängiger Impact aus historischer Depth: `impactBps =
 *      impactBpsPerParticipation × (fillQty / verfügbareMenge)`. Die
 *      verfügbare Menge kommt aus dem jüngsten sichtbaren, frischen
 *      `MARKET_DEPTH`-Ereignis; fehlt oder veraltet es, greift der
 *      dokumentierte konservative Fallback `bar.volume ×
 *      maxBarVolumeParticipation`. Fehlt auch das Kerzenvolumen, findet
 *      KEIN Fill statt (fail-closed — nie erfundene Liquidität).
 *   4. Punktgenaues Funding: `FUNDING_DUE`-Ereignisse (Venue/Instrument/
 *      Rate/Intervall) werden ausschließlich für zum Ereigniszeitpunkt
 *      offene, eindeutig als Perpetual erkannte Positionen gebucht —
 *      DIESELBE Formel wie der Paper-Betrieb (`computeFunding`,
 *      src/lib/funding.ts; Kontosicht: negativ = gezahlt). Kein Ereignis,
 *      kein Funding (kein stiller statischer Satz in diesem Modus).
 *
 * ── Preisbildung eines Fills (Formel, dokumentiert) ─────────────────────────
 *
 *   base   = refPrice der Entscheidung/des Triggers, wenn der Fill auf der
 *            Entscheidungskerze stattfindet, sonst der Close der Fill-Kerze
 *            (die Latenz verschiebt die Ausführung ehrlich auf spätere Kurse).
 *   spread = (ask − bid) / mid der jüngsten frischen MARKET_QUOTE, sonst
 *            `spreadBpsFallback` (degradiert sichtbar).
 *   touch  = base × (1 ± spread/2)          (BUY: +, SELL: −)
 *   price  = touch × (1 ± impactBps/10⁴)    (BUY: +, SELL: −)
 *   fees   = price × fillQty × takerFee     (nur auf tatsächlich gefüllte Menge)
 *
 * ── Look-ahead-Garantie ─────────────────────────────────────────────────────
 *
 * Sichtbar ist ein Ereignis erst ab `availableAt ≤ Simulationszeit`; die
 * Sichtbarkeitszeiger laufen monoton mit der Zeitachse. Ein Depth-/Quote-/
 * Funding-Ereignis mit `availableAt` in der Zukunft existiert für den
 * Replayer nicht — auch nicht für Kostenannahmen.
 *
 * Determinismus: kein RNG, keine Wanduhr — gleiche (Kerzen, Events, Config,
 * Seed) ⇒ identisches Event-, Trade- und Metrik-Ergebnis (Golden-Tests).
 */

import { createHash } from "node:crypto";
import { computeFunding } from "../lib/funding";
import { stableStringify } from "../lib/ruleEngine";
import type { CandleLike } from "../lib/ruleEngine";
import type { MarketInstrument } from "../universe/types";
import { defaultBacktestInstrument, detectExitTrigger } from "./paperExecution";
import type { BacktestPortfolio } from "./portfolio";
import type { TradeExitReason } from "./types";
import {
  REPLAY_TRADE_MAX_FILLS,
  emptyReplayCoverage,
  resolveEventReplayConfig,
  sortReplayEvents,
  validateReplayInputEvent,
  type EventReplayCoverage,
  type EventReplayDataManifest,
  type EventReplayOptions,
  type EventReplayRunSummary,
  type FundingDueEvent,
  type MarketDepthEvent,
  type MarketQuoteEvent,
  type ReplayDegradedReason,
  type ReplayExecSide,
  type ReplayFillDetail,
  type ReplayInputEvent,
  type ReplayLiquiditySource,
  type ReplayOrderEvent,
  type ReplayOrderPurpose,
  type ResolvedEventReplayConfig,
  type TradeReplayDetail,
} from "./replayEvents";

/** Numerische Toleranz für Mengenvergleiche (Float-Drift, keine Rundung). */
const QTY_EPS = 1e-9;

/** Kerze + Index, wie die Engine sie je Zeitschritt liefert. */
export interface ReplayBarInfo {
  candle: CandleLike;
  index: number;
}

interface ReplayOrderState {
  orderId: string;
  symbol: string;
  purpose: ReplayOrderPurpose;
  execSide: ReplayExecSide;
  posSide: "LONG" | "SHORT";
  strategyId: string;
  requestedQty: number;
  remainingQty: number;
  decisionTime: number;
  submitTime: number;
  arrivalTime: number;
  /** Referenzpreis der Entscheidung (Entry: Close) bzw. des Triggers (Exit). */
  refPrice: number;
  /** Exit-Grund, mit dem der Trade beim Vollschluss ausgewiesen wird. */
  exitReason: TradeExitReason | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Kerzen des eigenen Symbols seit Ankunft (TTL-Zähler). */
  barsOnBook: number;
  acked: boolean;
  cancelled: boolean;
}

interface SymbolEventStreams {
  quotes: MarketQuoteEvent[];
  depth: MarketDepthEvent[];
  funding: FundingDueEvent[];
  quotePtr: number;
  depthPtr: number;
  fundingPtr: number;
  /** Jüngstes SICHTBARES Ereignis (max. eventTime unter availableAt ≤ now). */
  lastQuote: MarketQuoteEvent | null;
  lastDepth: MarketDepthEvent | null;
}

/** Laufzeit-Kontext EINES Event-Replay-Laufs (pro Lauf frisch erzeugen). */
export interface EventReplayRuntime {
  readonly config: ResolvedEventReplayConfig;
  /** true, wenn für das Symbol eine offene (Entry- oder Exit-)Order liegt. */
  hasPendingOrder(symbol: string): boolean;
  /** Ereignisse eines Zeitschritts: Funding → Order-Fills → Exit-Trigger. */
  beginBar(
    now: number,
    barStep: number,
    bars: ReadonlyMap<string, ReplayBarInfo>,
    currentPrices: ReadonlyMap<string, number>,
    portfolio: BacktestPortfolio
  ): void;
  /** Entry-Order aus einem Engine-Signal (füllt bei Latenz 0 sofort). */
  submitEntry(args: {
    strategyId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    notional: number;
    candle: CandleLike;
    now: number;
    barStep: number;
    stopLoss: number | null;
    takeProfit: number | null;
    portfolio: BacktestPortfolio;
  }): void;
  /** Laufende Orders canceln + offene Positionen zwangsglattstellen. */
  finish(
    lastTime: number,
    barStep: number,
    currentPrices: ReadonlyMap<string, number>,
    portfolio: BacktestPortfolio
  ): void;
  /** Reproduzierbarkeits-Evidenz des Laufs (Manifest, Coverage, Eventlog). */
  summary(): EventReplayRunSummary;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Erzeugt den Laufzeit-Kontext EINES Event-Replay-Laufs. Validiert alle
 * Input-Ereignisse fail-closed (ein invalides Ereignis bricht den Lauf ab,
 * bevor irgendetwas simuliert wird) und friert Manifest + Config ein.
 */
export function createEventReplayRuntime(args: {
  options: EventReplayOptions;
  engineFeeModel: { makerFee: number; takerFee: number };
  barMs: number;
  /** Kerzenmap der Engine (bereits je Symbol nach Zeit sortiert). */
  candlesBySymbol: ReadonlyMap<string, CandleLike[]>;
}): EventReplayRuntime {
  const config = resolveEventReplayConfig(args.options, args.barMs);
  const takerFee =
    Number.isFinite(args.options.takerFee) && (args.options.takerFee as number) > 0
      ? (args.options.takerFee as number)
      : args.engineFeeModel.takerFee;
  const makerFee =
    Number.isFinite(args.options.makerFee) && (args.options.makerFee as number) > 0
      ? (args.options.makerFee as number)
      : args.engineFeeModel.makerFee;

  // ── Input-Ereignisse validieren, kanonisch sortieren, indizieren ──────────
  const validated: ReplayInputEvent[] = (args.options.events ?? []).map((e, i) =>
    validateReplayInputEvent(e, i)
  );
  const canonical = sortReplayEvents(validated);
  const streams = new Map<string, SymbolEventStreams>();
  const streamOf = (symbol: string): SymbolEventStreams => {
    const key = symbol.toUpperCase();
    let s = streams.get(key);
    if (!s) {
      s = { quotes: [], depth: [], funding: [], quotePtr: 0, depthPtr: 0, fundingPtr: 0, lastQuote: null, lastDepth: null };
      streams.set(key, s);
    }
    return s;
  };
  let quoteCount = 0;
  let depthCount = 0;
  let fundingCount = 0;
  for (const event of canonical) {
    const s = streamOf(event.symbol);
    if (event.type === "MARKET_QUOTE") {
      s.quotes.push(event);
      quoteCount++;
    } else if (event.type === "MARKET_DEPTH") {
      s.depth.push(event);
      depthCount++;
    } else if (event.type === "FUNDING_DUE") {
      s.funding.push(event);
      fundingCount++;
    }
    // MARKET_BAR-Ereignisse liefert die Engine über ihre Zeitachse; sie sind
    // im Vertrag enthalten (externe Feeds), werden hier aber nicht doppelt
    // konsumiert — die Kerzenmap ist die kanonische Bar-Quelle.
  }
  // Sichtbarkeits-Scan braucht availableAt-Ordnung (kanonisch ist eventTime).
  for (const s of streams.values()) {
    s.quotes.sort((a, b) => a.availableAt - b.availableAt || a.eventTime - b.eventTime);
    s.depth.sort((a, b) => a.availableAt - b.availableAt || a.eventTime - b.eventTime);
    s.funding.sort((a, b) => a.availableAt - b.availableAt || a.eventTime - b.eventTime);
  }

  // ── Manifest (Reproduzierbarkeit): Hashes der versionierten Inputs ────────
  const sortedSymbols = Array.from(args.candlesBySymbol.keys()).sort();
  let candleCount = 0;
  for (const sym of sortedSymbols) candleCount += (args.candlesBySymbol.get(sym) ?? []).length;
  const manifest: EventReplayDataManifest = {
    frictionModelVersion: config.frictionModelVersion,
    candlesHash: sha256(
      stableStringify(sortedSymbols.map((sym) => [sym, args.candlesBySymbol.get(sym) ?? []]))
    ),
    eventsHash: sha256(stableStringify(canonical)),
    candleCount,
    eventCounts: { quotes: quoteCount, depth: depthCount, funding: fundingCount },
    symbols: sortedSymbols,
  };

  // ── Laufzeitzustand ───────────────────────────────────────────────────────
  const coverage: EventReplayCoverage = emptyReplayCoverage();
  coverage.quoteEvents = quoteCount;
  coverage.depthEvents = depthCount;
  coverage.fundingEvents = fundingCount;
  const degraded = new Set<ReplayDegradedReason>();
  const orderEvents: ReplayOrderEvent[] = [];
  let orderEventsTruncated = false;
  let eventSeq = 0;
  let orderSeq = 0;
  const orders: ReplayOrderState[] = [];
  const tradeDetails: Record<string, TradeReplayDetail> = {};
  /** Offene Detailblöcke je Positions-ID (bis zum Finalisieren des Trades). */
  const openDetails = new Map<string, TradeReplayDetail>();

  const providedInstruments = args.options.instruments ?? {};
  const instrumentCache = new Map<string, MarketInstrument>();
  const instrumentOf = (symbol: string): MarketInstrument => {
    const hit = instrumentCache.get(symbol);
    if (hit) return hit;
    const inst = providedInstruments[symbol] ?? defaultBacktestInstrument(symbol, { makerFee, takerFee });
    instrumentCache.set(symbol, inst);
    return inst;
  };

  const emit = (event: ReplayOrderEvent): void => {
    if (orderEvents.length >= config.maxEventLog) {
      if (!orderEventsTruncated) {
        orderEventsTruncated = true;
        degraded.add("EVENT_LOG_TRUNCATED");
      }
      return;
    }
    orderEvents.push(event);
  };

  const nextOrderId = (): string => `ER-${(config.seed >>> 0).toString(36)}-${orderSeq++}`;

  const advanceVisibility = (symbol: string, now: number): SymbolEventStreams => {
    const s = streamOf(symbol);
    while (s.quotePtr < s.quotes.length && s.quotes[s.quotePtr].availableAt <= now) {
      const q = s.quotes[s.quotePtr++];
      if (s.lastQuote === null || q.eventTime >= s.lastQuote.eventTime) s.lastQuote = q;
    }
    while (s.depthPtr < s.depth.length && s.depth[s.depthPtr].availableAt <= now) {
      const d = s.depth[s.depthPtr++];
      if (s.lastDepth === null || d.eventTime >= s.lastDepth.eventTime) s.lastDepth = d;
    }
    return s;
  };

  const detailOf = (positionId: string): TradeReplayDetail => {
    let d = openDetails.get(positionId);
    if (!d) {
      d = { frictionModelVersion: config.frictionModelVersion, fills: [], funding: [], truncated: false };
      openDetails.set(positionId, d);
    }
    return d;
  };

  const pushFill = (positionId: string, fill: ReplayFillDetail): void => {
    const d = detailOf(positionId);
    if (d.fills.length >= REPLAY_TRADE_MAX_FILLS) {
      d.truncated = true;
      return;
    }
    d.fills.push(fill);
  };

  const cancelOrder = (order: ReplayOrderState, now: number, reason: string): void => {
    if (order.cancelled) return;
    order.cancelled = true;
    coverage.ordersCancelled++;
    emit({
      type: "ORDER_CANCEL",
      orderId: order.orderId,
      symbol: order.symbol,
      eventTime: now,
      seq: eventSeq++,
      reason,
      remainingQty: order.remainingQty,
    });
  };

  /**
   * Verfügbare Menge einer Fill-Kerze: frische Depth → Depth-Menge; sonst
   * konservativer Kerzenvolumen-Fallback; ohne beides KEIN Fill.
   */
  const availableLiquidity = (
    order: ReplayOrderState,
    candle: CandleLike,
    now: number,
    s: SymbolEventStreams
  ): { qty: number; source: ReplayLiquiditySource } | null => {
    const d = s.lastDepth;
    if (d !== null && now - d.eventTime <= config.maxDepthAgeMs) {
      return { qty: order.execSide === "BUY" ? d.askQty : d.bidQty, source: "DEPTH" };
    }
    degraded.add(d === null ? "DEPTH_MISSING_BAR_VOLUME_FALLBACK" : "DEPTH_STALE_BAR_VOLUME_FALLBACK");
    const volume = candle.volume;
    if (!Number.isFinite(volume) || volume <= 0) {
      degraded.add("NO_LIQUIDITY_DATA_NO_FILL");
      return null;
    }
    return { qty: volume * config.maxBarVolumeParticipation, source: "BAR_VOLUME" };
  };

  /** Relativer Spread der Fill-Kerze: frische Quote → echt, sonst Fallback. */
  const spreadRelOf = (now: number, s: SymbolEventStreams): { rel: number; bps: number } => {
    const q = s.lastQuote;
    if (q !== null && now - q.eventTime <= config.maxDepthAgeMs) {
      const mid = (q.ask + q.bid) / 2;
      const rel = mid > 0 ? (q.ask - q.bid) / mid : 0;
      return { rel, bps: Number((rel * 10_000).toFixed(4)) };
    }
    degraded.add("QUOTE_MISSING_SPREAD_FALLBACK");
    return { rel: config.spreadBpsFallback / 10_000, bps: config.spreadBpsFallback };
  };

  /** TTL-Tick nach einem Fill-Versuch; cancelt abgelaufene Restmengen. */
  const tickTtl = (order: ReplayOrderState, now: number): void => {
    order.barsOnBook++;
    if (order.remainingQty > QTY_EPS && order.barsOnBook >= config.orderTtlBars) {
      degraded.add("ORDER_TTL_CANCELLED");
      cancelOrder(order, now, "ORDER_TTL_EXPIRED");
    }
  };

  /** Verarbeitet EINE offene Order gegen die aktuelle Kerze ihres Symbols. */
  const processOrder = (
    order: ReplayOrderState,
    candle: CandleLike,
    now: number,
    barStep: number,
    portfolio: BacktestPortfolio
  ): void => {
    if (order.cancelled || order.remainingQty <= QTY_EPS) return;
    if (order.arrivalTime > now) return; // Latenz: noch nicht an der Venue.
    if (!order.acked) {
      order.acked = true;
      emit({ type: "ORDER_ACK", orderId: order.orderId, symbol: order.symbol, eventTime: Math.max(order.arrivalTime, now), seq: eventSeq++ });
    }

    const s = advanceVisibility(order.symbol, now);
    const liquidity = availableLiquidity(order, candle, now, s);
    if (liquidity === null || liquidity.qty <= QTY_EPS) {
      tickTtl(order, now);
      return;
    }

    let fillQty = Math.min(order.remainingQty, liquidity.qty);
    // Exits füllen nie mehr als die offene Positions-Restmenge.
    if (order.purpose === "EXIT") {
      const pos = portfolio.getOpenPosition(order.symbol);
      if (!pos || pos.qty <= QTY_EPS) {
        cancelOrder(order, now, "POSITION_ALREADY_CLOSED");
        return;
      }
      fillQty = Math.min(fillQty, pos.qty);
    }

    // Preisbildung (Formel im Dateikopf).
    const base = now === order.decisionTime ? order.refPrice : candle.close;
    const spread = spreadRelOf(now, s);
    const buy = order.execSide === "BUY";
    const touch = buy ? base * (1 + spread.rel / 2) : base * (1 - spread.rel / 2);
    const participation = Math.min(1, fillQty / liquidity.qty);
    const impactBps = config.impactBpsPerParticipation * participation;
    let price = buy ? touch * (1 + impactBps / 10_000) : touch * (1 - impactBps / 10_000);
    if (!Number.isFinite(price) || price <= 0) {
      cancelOrder(order, now, "INVALID_PRICE");
      return;
    }

    // Entry-Cash-Guard: nie mehr kaufen, als Cash deckt (fail-closed).
    if (order.purpose === "ENTRY") {
      const affordable = (portfolio.currentCash * 0.99) / (price * (1 + takerFee));
      if (affordable < fillQty) {
        if (affordable <= QTY_EPS) {
          degraded.add("ENTRY_CANCELLED_INSUFFICIENT_CASH");
          cancelOrder(order, now, "INSUFFICIENT_CASH");
          return;
        }
        fillQty = affordable;
      }
    }

    const fees = price * fillQty * takerFee;
    const slippageCost = Math.abs(price - base) * fillQty;
    if (liquidity.source === "DEPTH") coverage.fillsFromDepth++;
    else coverage.fillsFromBarVolumeFallback++;

    let positionId: string;
    if (order.purpose === "ENTRY") {
      const existing = portfolio.getOpenPosition(order.symbol);
      if (existing) {
        // Sobald ein Exit begonnen hat (Teilmenge geschlossen), darf kein
        // Entry-Rest mehr nachkaufen — der gemittelte Entry-Preis würde die
        // bereits realisierte PnL-Identität des Trades verfälschen.
        if ((existing.closedQty ?? 0) > 0) {
          cancelOrder(order, now, "EXIT_ALREADY_STARTED");
          return;
        }
        if (!portfolio.increasePosition(order.symbol, { fillPrice: price, qty: fillQty, fees, slippage: slippageCost })) {
          cancelOrder(order, now, "POSITION_INCREASE_REJECTED");
          return;
        }
        positionId = existing.id;
      } else {
        const pos = portfolio.openPosition(
          order.strategyId,
          order.symbol,
          order.posSide,
          { fillPrice: price, qty: fillQty, fees, slippage: slippageCost },
          candle,
          barStep,
          order.stopLoss,
          order.takeProfit
        );
        positionId = pos.id;
      }
    } else {
      const pos = portfolio.getOpenPosition(order.symbol);
      if (!pos) {
        cancelOrder(order, now, "POSITION_ALREADY_CLOSED");
        return;
      }
      positionId = pos.id;
      const applied = portfolio.applyPartialExit(order.symbol, { qty: fillQty, price, fees, slippage: slippageCost });
      if (!applied) {
        cancelOrder(order, now, "EXIT_REJECTED");
        return;
      }
    }

    order.remainingQty = Math.max(0, order.remainingQty - fillQty);
    if (order.purpose === "EXIT") {
      // Position vollständig abgebaut ⇒ Order ist fertig, auch wenn die
      // ursprünglich angeforderte Menge (z. B. nach Cash-Kappung des Entrys)
      // größer war — es gibt nichts mehr zu schließen.
      const posAfter = portfolio.getOpenPosition(order.symbol);
      if (!posAfter || posAfter.qty <= QTY_EPS) order.remainingQty = 0;
    }
    const done = order.remainingQty <= QTY_EPS;
    pushFill(positionId, {
      orderId: order.orderId,
      purpose: order.purpose,
      execSide: order.execSide,
      decisionTime: order.decisionTime,
      submitTime: order.submitTime,
      arrivalTime: order.arrivalTime,
      fillTime: now,
      qty: fillQty,
      price,
      refPrice: base,
      fees,
      impactBps: Number(impactBps.toFixed(4)),
      spreadBps: spread.bps,
      participation: Number(participation.toFixed(8)),
      liquiditySource: liquidity.source,
    });
    if (done) {
      coverage.ordersFilled++;
      emit({
        type: "ORDER_FILL",
        orderId: order.orderId,
        symbol: order.symbol,
        eventTime: now,
        seq: eventSeq++,
        qty: fillQty,
        price,
        fees,
        impactBps: Number(impactBps.toFixed(4)),
        spreadBps: spread.bps,
        liquiditySource: liquidity.source,
        remainingQty: 0,
      });
    } else {
      coverage.ordersPartiallyFilled++;
      emit({
        type: "ORDER_PARTIAL_FILL",
        orderId: order.orderId,
        symbol: order.symbol,
        eventTime: now,
        seq: eventSeq++,
        qty: fillQty,
        price,
        fees,
        impactBps: Number(impactBps.toFixed(4)),
        spreadBps: spread.bps,
        liquiditySource: liquidity.source,
        remainingQty: order.remainingQty,
      });
    }

    // Exit vollständig? Trade finalisieren (Restmenge 0 ⇒ Positionsschluss).
    if (order.purpose === "EXIT") {
      const pos = portfolio.getOpenPosition(order.symbol);
      if (!pos || pos.qty <= QTY_EPS) {
        order.remainingQty = 0;
        const trade = portfolio.finalizeReplayPosition(order.symbol, now, barStep, order.exitReason ?? "SIGNAL_EXIT");
        if (trade) {
          const detail = openDetails.get(positionId);
          if (detail) {
            tradeDetails[trade.id] = detail;
            openDetails.delete(positionId);
          }
        }
      }
    }
    if (!done && !order.cancelled) tickTtl(order, now);
  };

  const submitOrder = (args2: {
    symbol: string;
    purpose: ReplayOrderPurpose;
    execSide: ReplayExecSide;
    posSide: "LONG" | "SHORT";
    strategyId: string;
    qty: number;
    decisionTime: number;
    refPrice: number;
    exitReason: TradeExitReason | null;
    stopLoss: number | null;
    takeProfit: number | null;
  }): ReplayOrderState => {
    const submitTime = args2.decisionTime + config.latency.decisionToSubmitMs;
    const arrivalTime = submitTime + config.latency.submitToArrivalMs;
    const order: ReplayOrderState = {
      orderId: nextOrderId(),
      symbol: args2.symbol,
      purpose: args2.purpose,
      execSide: args2.execSide,
      posSide: args2.posSide,
      strategyId: args2.strategyId,
      requestedQty: args2.qty,
      remainingQty: args2.qty,
      decisionTime: args2.decisionTime,
      submitTime,
      arrivalTime,
      refPrice: args2.refPrice,
      exitReason: args2.exitReason,
      stopLoss: args2.stopLoss,
      takeProfit: args2.takeProfit,
      barsOnBook: 0,
      acked: false,
      cancelled: false,
    };
    orders.push(order);
    coverage.ordersSubmitted++;
    emit({
      type: "ORDER_SUBMITTED",
      orderId: order.orderId,
      symbol: order.symbol,
      eventTime: args2.decisionTime,
      seq: eventSeq++,
      purpose: order.purpose,
      execSide: order.execSide,
      requestedQty: order.requestedQty,
      decisionTime: order.decisionTime,
      submitTime,
      arrivalTime,
      strategyId: order.strategyId,
    });
    return order;
  };

  const openOrdersOf = (symbol: string): ReplayOrderState[] =>
    orders.filter((o) => !o.cancelled && o.remainingQty > QTY_EPS && o.symbol === symbol);

  /** Funding-Ereignisse buchen, deren `availableAt` erreicht ist. */
  const processFunding = (
    now: number,
    currentPrices: ReadonlyMap<string, number>,
    portfolio: BacktestPortfolio
  ): void => {
    for (const [symbol, s] of streams) {
      while (s.fundingPtr < s.funding.length && s.funding[s.fundingPtr].availableAt <= now) {
        const event = s.funding[s.fundingPtr++];
        const pos = portfolio.getOpenPosition(symbol);
        const instrument = instrumentOf(symbol);
        // Nur offene Perp-Positionen, deren Entry STRIKT vor dem Funding-
        // Zeitpunkt lag — Funding vor Entry oder nach Exit wird nie gebucht.
        // Kein Degraded-Reason: ein Funding-Zeitpunkt ohne offene Position
        // ist Normalfall (Ereignisreihe existiert unabhängig vom Portfolio).
        if (!pos || pos.qty <= QTY_EPS || instrument.marketType !== "perpetual" || pos.entryTime >= event.eventTime) {
          coverage.fundingSkipped++;
          continue;
        }
        const mark = currentPrices.get(symbol) ?? pos.entryPrice;
        const computed = computeFunding(
          { side: pos.side, qty: pos.qty, price: mark },
          { intervalHours: event.intervalHours },
          event.ratePer8h
        );
        if (!computed) {
          coverage.fundingSkipped++;
          continue;
        }
        const funding = Number(computed.funding.toFixed(8));
        if (portfolio.applyFunding(symbol, funding)) {
          coverage.fundingApplied++;
          detailOf(pos.id).funding.push({
            eventTime: event.eventTime,
            bookedAt: now,
            ratePer8h: event.ratePer8h,
            intervalHours: event.intervalHours,
            markPrice: mark,
            notional: computed.notional,
            funding,
          });
        } else {
          coverage.fundingSkipped++;
        }
      }
    }
  };

  const beginBar = (
    now: number,
    barStep: number,
    bars: ReadonlyMap<string, ReplayBarInfo>,
    currentPrices: ReadonlyMap<string, number>,
    portfolio: BacktestPortfolio
  ): void => {
    coverage.bars++;
    for (const symbol of bars.keys()) advanceVisibility(symbol, now);

    // 1) Funding (Ereigniszeit ≤ Kerzenzeit — vor Exits desselben Schritts).
    processFunding(now, currentPrices, portfolio);

    // 2) Offene Orders gegen die aktuellen Kerzen (deterministisch: Order-Seq).
    for (const order of orders) {
      const bar = bars.get(order.symbol);
      if (!bar) continue;
      processOrder(order, bar.candle, now, barStep, portfolio);
    }
    // Abgearbeitete Orders entfernen (Performance: der Scan pro Kerze bleibt
    // proportional zu den OFFENEN Orders, nicht zur Gesamtzahl des Laufs).
    for (let i = orders.length - 1; i >= 0; i--) {
      const o = orders[i];
      if (o.cancelled || o.remainingQty <= QTY_EPS) orders.splice(i, 1);
    }

    // 3) Exit-Trigger (Stop-Vorrang) → Exit-Order für die Restmenge.
    for (const pos of portfolio.openPositionsList) {
      const bar = bars.get(pos.symbol);
      if (!bar || pos.qty <= QTY_EPS) continue;
      const pending = openOrdersOf(pos.symbol);
      if (pending.some((o) => o.purpose === "EXIT")) continue; // Rest wird bereits abgearbeitet.
      const trigger = detectExitTrigger(pos, bar.candle);
      if (!trigger) continue;
      // Laufende Entry-Restmenge canceln — kein Nachkauf in einen Ausstieg.
      for (const o of pending) {
        if (o.purpose === "ENTRY") cancelOrder(o, now, "EXIT_TRIGGERED");
      }
      const order = submitOrder({
        symbol: pos.symbol,
        purpose: "EXIT",
        execSide: pos.side === "LONG" ? "SELL" : "BUY",
        posSide: pos.side,
        strategyId: pos.strategyId,
        qty: pos.qty,
        decisionTime: now,
        refPrice: trigger.price,
        exitReason: trigger.reason,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
      });
      processOrder(order, bar.candle, now, barStep, portfolio);
    }
  };

  const submitEntry: EventReplayRuntime["submitEntry"] = (a) => {
    if (!Number.isFinite(a.notional) || a.notional <= 0) return;
    if (openOrdersOf(a.symbol).length > 0) return; // Engine prüft das vorab — defensiv.
    const refPrice = a.candle.close;
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      coverage.ordersRejected++;
      emit({
        type: "ORDER_REJECT",
        orderId: nextOrderId(),
        symbol: a.symbol,
        eventTime: a.now,
        seq: eventSeq++,
        reason: "INVALID_REFERENCE_PRICE",
      });
      return;
    }
    const qty = a.notional / refPrice;
    if (!Number.isFinite(qty) || qty <= 0) return;
    const order = submitOrder({
      symbol: a.symbol,
      purpose: "ENTRY",
      execSide: a.side === "LONG" ? "BUY" : "SELL",
      posSide: a.side,
      strategyId: a.strategyId,
      qty,
      decisionTime: a.now,
      refPrice,
      exitReason: null,
      stopLoss: a.stopLoss,
      takeProfit: a.takeProfit,
    });
    processOrder(order, a.candle, a.now, a.barStep, a.portfolio);
  };

  const finish: EventReplayRuntime["finish"] = (lastTime, barStep, currentPrices, portfolio) => {
    for (const order of orders) {
      if (!order.cancelled && order.remainingQty > QTY_EPS) cancelOrder(order, lastTime, "END_OF_DATA");
    }
    // Zwangsglattstellung offener Positionen zum letzten bekannten Kurs
    // (FORCED_FINAL: Spread-Fallback + Taker-Fee, kein Impact — dokumentiert;
    // identische Semantik wie closeAllAtEnd des Paper-Pfads).
    for (const pos of [...portfolio.openPositionsList]) {
      if (pos.qty <= QTY_EPS) continue;
      const base = currentPrices.get(pos.symbol) ?? pos.entryPrice;
      const spreadRel = config.spreadBpsFallback / 10_000;
      const sell = pos.side === "LONG";
      const price = sell ? base * (1 - spreadRel / 2) : base * (1 + spreadRel / 2);
      const qty = pos.qty;
      const fees = price * qty * takerFee;
      const slippage = Math.abs(price - base) * qty;
      const applied = portfolio.applyPartialExit(pos.symbol, { qty, price, fees, slippage });
      if (!applied) continue;
      pushFill(pos.id, {
        orderId: nextOrderId(),
        purpose: "EXIT",
        execSide: sell ? "SELL" : "BUY",
        decisionTime: lastTime,
        submitTime: lastTime,
        arrivalTime: lastTime,
        fillTime: lastTime,
        qty,
        price,
        refPrice: base,
        fees,
        impactBps: 0,
        spreadBps: config.spreadBpsFallback,
        participation: 1,
        liquiditySource: "FORCED_FINAL",
      });
      const trade = portfolio.finalizeReplayPosition(pos.symbol, lastTime, barStep, "END_OF_DATA");
      if (trade) {
        const detail = openDetails.get(pos.id);
        if (detail) {
          tradeDetails[trade.id] = detail;
          openDetails.delete(pos.id);
        }
      }
    }
  };

  return {
    config,
    hasPendingOrder: (symbol) => openOrdersOf(symbol).length > 0,
    beginBar,
    submitEntry,
    finish,
    summary: (): EventReplayRunSummary => ({
      config,
      manifest,
      coverage: { ...coverage },
      degradedReasons: Array.from(degraded).sort(),
      orderEvents: [...orderEvents],
      orderEventsTruncated,
      tradeDetails: { ...tradeDetails },
    }),
  };
}

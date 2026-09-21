/**
 * Event-Replay — kanonischer Eventvertrag + Friktionskonfiguration
 * (RMA-P1-01, v1.58.0).
 *
 * Diskriminierte Union aller Replay-Ereignisse:
 *   - INPUT-Ereignisse (versionierte, historische Daten):
 *     `MARKET_BAR`, `MARKET_QUOTE`, `MARKET_DEPTH`, `FUNDING_DUE`.
 *   - OUTPUT-Ereignisse (deterministisch vom Replayer erzeugt, Audit-Trail
 *     des Laufs): `ORDER_SUBMITTED`, `ORDER_ACK`, `ORDER_REJECT`,
 *     `ORDER_PARTIAL_FILL`, `ORDER_FILL`, `ORDER_CANCEL`.
 *
 * ── Zeitsemantik (verbindlich) ───────────────────────────────────────────────
 *
 *   - `eventTime`    Ereigniszeit (Epoch-ms) — wann das Ereignis am Markt
 *                    stattfand.
 *   - `availableAt`  Verfügbarkeitszeit — frühester Zeitpunkt, zu dem der
 *                    Replayer das Ereignis SEHEN darf (`availableAt ≥
 *                    eventTime`, sonst `replay:invalid-event`). Ein Ereignis
 *                    mit `availableAt` nach der Simulationszeit ist
 *                    unsichtbar — kein Look-ahead, auch nicht für Kosten.
 *   - Kerzenkonvention (identisch zur bestehenden Engine): `candle.time` ist
 *     der Event-Zeitstempel der ABGESCHLOSSENEN Kerze; Entscheidungen und
 *     Fills desselben Zeitschritts finden zur Kerzenzeit statt.
 *   - Order-Lebenszyklus trennt vier Zeiten: `decisionTime` (Signal auf der
 *     abgeschlossenen Kerze) → `submitTime` (= decision +
 *     `decisionToSubmitMs`) → `arrivalTime` (= submit + `submitToArrivalMs`)
 *     → `fillTime(s)` (erste Kerze mit `time ≥ arrivalTime`, danach
 *     Folgekerzen für die Restmenge). Latenz 0 ⇒ Fill auf derselben Kerze
 *     wie die Entscheidung (Paper-Konvention).
 *
 * ── Kanonische Sortierung ────────────────────────────────────────────────────
 *
 * `sortReplayEvents` sortiert stabil nach
 *   (1) `eventTime` aufsteigend,
 *   (2) Typ-Priorität (`REPLAY_EVENT_PRIORITY`: Marktdaten vor Funding vor
 *       Order-Lifecycle — Daten sind da, bevor auf ihnen gehandelt wird),
 *   (3) `symbol` lexikografisch,
 *   (4) `seq` (Einfügereihenfolge) als letzter Tie-Break.
 * Gleiche Inputs ⇒ identische Reihenfolge ⇒ identisches Ergebnis.
 *
 * ── Einheiten & Vorzeichen ──────────────────────────────────────────────────
 *
 *   - Preise in Kontowährung je Basiseinheit, Mengen in Basiseinheiten.
 *   - `MARKET_DEPTH.bidQty/askQty`: verfügbare Basismenge nahe Touch
 *     (Bid-Seite = Verkaufs-, Ask-Seite = Kaufliquidität).
 *   - `FUNDING_DUE.ratePer8h`: signierte Rate je 8h als DEZIMALANTEIL
 *     (0.0001 = 0,01 %/8h; positiv = Longs zahlen — identisch zu
 *     `src/lib/funding.ts`). Buchung in KONTOSICHT: negativ = gezahlt.
 */

import type { MarketInstrument } from "../universe/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fehler
// ─────────────────────────────────────────────────────────────────────────────

export type EventReplayErrorCode =
  | "replay:invalid-config"
  | "replay:invalid-event";

export class EventReplayError extends Error {
  constructor(
    public readonly code: EventReplayErrorCode,
    message: string,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "EventReplayError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input-Ereignisse (historische Daten)
// ─────────────────────────────────────────────────────────────────────────────

interface ReplayInputEventBase {
  /** Ereigniszeit (Epoch-ms, ganzzahlig, > 0). */
  eventTime: number;
  /** Verfügbarkeitszeit (Epoch-ms, ≥ eventTime) — as-of-Grenze des Replays. */
  availableAt: number;
  /** Engine-Symbol (wie in `candlesBySymbol`), Groß-/Kleinschreibung egal. */
  symbol: string;
}

/** Abgeschlossene Kerze als Ereignis (Engine liefert sie via Zeitachse). */
export interface MarketBarEvent extends ReplayInputEventBase {
  type: "MARKET_BAR";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Top-of-Book-Quote: Spread-Quelle punktgenau statt statischer Annahme. */
export interface MarketQuoteEvent extends ReplayInputEventBase {
  type: "MARKET_QUOTE";
  bid: number;
  ask: number;
}

/** Verfügbare Menge nahe Touch (Basis für size-abhängigen Impact). */
export interface MarketDepthEvent extends ReplayInputEventBase {
  type: "MARKET_DEPTH";
  /** Kaufbare Menge (Ask-Seite) in Basiseinheiten (≥ 0; 0 = leeres Buch). */
  askQty: number;
  /** Verkaufbare Menge (Bid-Seite) in Basiseinheiten (≥ 0). */
  bidQty: number;
}

/** Punktgenaues Funding-Ereignis (Venue/Instrument/Rate/Intervall). */
export interface FundingDueEvent extends ReplayInputEventBase {
  type: "FUNDING_DUE";
  venue: string;
  /** Signierte Rate je 8h (Dezimalanteil; positiv = Longs zahlen). */
  ratePer8h: number;
  /** Funding-Intervall in Stunden (1..24) — skaliert die 8h-Rate. */
  intervalHours: number;
}

export type ReplayInputEvent =
  | MarketBarEvent
  | MarketQuoteEvent
  | MarketDepthEvent
  | FundingDueEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Output-Ereignisse (Order-Lifecycle, deterministisch erzeugt)
// ─────────────────────────────────────────────────────────────────────────────

/** Ausführungsrichtung (BUY = Long-Entry/Short-Exit, SELL = Gegenteil). */
export type ReplayExecSide = "BUY" | "SELL";

export type ReplayOrderPurpose = "ENTRY" | "EXIT";

/** Liquiditätsquelle eines Fills (dokumentierter Fallback-Pfad). */
export type ReplayLiquiditySource =
  | "DEPTH"
  | "BAR_VOLUME"
  | "FORCED_FINAL";

interface ReplayOrderEventBase {
  orderId: string;
  symbol: string;
  /** Ereigniszeit des Lifecycle-Schritts (Epoch-ms). */
  eventTime: number;
  /** Laufende Nummer im Eventlog (deterministisch). */
  seq: number;
}

export interface OrderSubmittedEvent extends ReplayOrderEventBase {
  type: "ORDER_SUBMITTED";
  purpose: ReplayOrderPurpose;
  execSide: ReplayExecSide;
  requestedQty: number;
  decisionTime: number;
  submitTime: number;
  arrivalTime: number;
  strategyId: string;
}

export interface OrderAckEvent extends ReplayOrderEventBase {
  type: "ORDER_ACK";
}

export interface OrderRejectEvent extends ReplayOrderEventBase {
  type: "ORDER_REJECT";
  reason: string;
}

export interface OrderPartialFillEvent extends ReplayOrderEventBase {
  type: "ORDER_PARTIAL_FILL";
  qty: number;
  price: number;
  fees: number;
  impactBps: number;
  spreadBps: number;
  liquiditySource: ReplayLiquiditySource;
  remainingQty: number;
}

export interface OrderFillEvent extends ReplayOrderEventBase {
  type: "ORDER_FILL";
  qty: number;
  price: number;
  fees: number;
  impactBps: number;
  spreadBps: number;
  liquiditySource: ReplayLiquiditySource;
  /** Immer 0 — der Typ markiert den letzten Fill der Order. */
  remainingQty: 0;
}

export interface OrderCancelEvent extends ReplayOrderEventBase {
  type: "ORDER_CANCEL";
  reason: string;
  remainingQty: number;
}

export type ReplayOrderEvent =
  | OrderSubmittedEvent
  | OrderAckEvent
  | OrderRejectEvent
  | OrderPartialFillEvent
  | OrderFillEvent
  | OrderCancelEvent;

export type ReplayEvent = ReplayInputEvent | ReplayOrderEvent;

/** Typ-Priorität des kanonischen Tie-Breaks (kleiner = früher). */
export const REPLAY_EVENT_PRIORITY: Record<ReplayEvent["type"], number> = {
  MARKET_DEPTH: 0,
  MARKET_QUOTE: 1,
  MARKET_BAR: 2,
  FUNDING_DUE: 3,
  ORDER_SUBMITTED: 4,
  ORDER_ACK: 5,
  ORDER_REJECT: 6,
  ORDER_PARTIAL_FILL: 7,
  ORDER_FILL: 8,
  ORDER_CANCEL: 9,
};

/**
 * Kanonische, stabile Sortierung (Dokumentation im Dateikopf). Mutiert die
 * Eingabe nicht.
 */
export function sortReplayEvents<T extends ReplayEvent>(events: readonly T[]): T[] {
  return events
    .map((event, seq) => ({ event, seq }))
    .sort((a, b) => {
      if (a.event.eventTime !== b.event.eventTime) return a.event.eventTime - b.event.eventTime;
      const pa = REPLAY_EVENT_PRIORITY[a.event.type];
      const pb = REPLAY_EVENT_PRIORITY[b.event.type];
      if (pa !== pb) return pa - pb;
      if (a.event.symbol !== b.event.symbol) return a.event.symbol < b.event.symbol ? -1 : 1;
      return a.seq - b.seq;
    })
    .map((x) => x.event);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validierung der Input-Ereignisse (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

/** Bounds der Funding-Ereignisse (identisch zu `FUNDING_BOUNDS`, dezimal). */
export const REPLAY_FUNDING_BOUNDS = {
  intervalHours: { min: 1, max: 24 },
  /** ±1 %/8h als Dezimalanteil — darüber ist es ein Datenfehler. */
  ratePer8h: { min: -0.01, max: 0.01 },
} as const;

function requireEventNumber(value: unknown, field: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EventReplayError(
      "replay:invalid-event",
      `Event #${index}: Feld ${field} ist nicht endlich (${String(value)})`,
      { index, field }
    );
  }
  return value;
}

/**
 * Validiert EIN Input-Ereignis (fail-closed): endliche Zahlen, ganzzahlige
 * positive Zeiten, `availableAt ≥ eventTime` (keine rückwärts laufende
 * Zeit), Preise > 0, Mengen ≥ 0, Funding-Bounds. Gibt das (unveränderte)
 * Ereignis mit normalisiertem Symbol (Großschreibung) zurück.
 */
export function validateReplayInputEvent(event: ReplayInputEvent, index: number): ReplayInputEvent {
  const eventTime = requireEventNumber(event.eventTime, "eventTime", index);
  const availableAt = requireEventNumber(event.availableAt, "availableAt", index);
  if (!Number.isInteger(eventTime) || eventTime <= 0 || !Number.isInteger(availableAt)) {
    throw new EventReplayError(
      "replay:invalid-event",
      `Event #${index}: Zeiten müssen positive ganze Millisekunden sein`,
      { index }
    );
  }
  if (availableAt < eventTime) {
    throw new EventReplayError(
      "replay:invalid-event",
      `Event #${index}: availableAt (${availableAt}) < eventTime (${eventTime}) — rückwärts laufende Zeit`,
      { index }
    );
  }
  if (typeof event.symbol !== "string" || event.symbol.trim() === "" || event.symbol.length > 64) {
    throw new EventReplayError("replay:invalid-event", `Event #${index}: ungültiges Symbol`, { index });
  }
  const symbol = event.symbol.toUpperCase();

  switch (event.type) {
    case "MARKET_BAR": {
      for (const f of ["open", "high", "low", "close"] as const) {
        const v = requireEventNumber(event[f], f, index);
        if (v <= 0) {
          throw new EventReplayError("replay:invalid-event", `Event #${index}: ${f} ≤ 0`, { index, field: f });
        }
      }
      const volume = requireEventNumber(event.volume, "volume", index);
      if (volume < 0) {
        throw new EventReplayError("replay:invalid-event", `Event #${index}: volume < 0`, { index });
      }
      return { ...event, symbol };
    }
    case "MARKET_QUOTE": {
      const bid = requireEventNumber(event.bid, "bid", index);
      const ask = requireEventNumber(event.ask, "ask", index);
      if (!(bid > 0) || !(ask > 0) || ask < bid) {
        throw new EventReplayError(
          "replay:invalid-event",
          `Event #${index}: Quote braucht 0 < bid ≤ ask (bid=${bid}, ask=${ask})`,
          { index }
        );
      }
      return { ...event, symbol };
    }
    case "MARKET_DEPTH": {
      const askQty = requireEventNumber(event.askQty, "askQty", index);
      const bidQty = requireEventNumber(event.bidQty, "bidQty", index);
      if (askQty < 0 || bidQty < 0) {
        throw new EventReplayError("replay:invalid-event", `Event #${index}: Depth-Mengen < 0`, { index });
      }
      return { ...event, symbol };
    }
    case "FUNDING_DUE": {
      const rate = requireEventNumber(event.ratePer8h, "ratePer8h", index);
      const interval = requireEventNumber(event.intervalHours, "intervalHours", index);
      if (rate < REPLAY_FUNDING_BOUNDS.ratePer8h.min || rate > REPLAY_FUNDING_BOUNDS.ratePer8h.max) {
        throw new EventReplayError(
          "replay:invalid-event",
          `Event #${index}: ratePer8h ${rate} außerhalb [${REPLAY_FUNDING_BOUNDS.ratePer8h.min}, ${REPLAY_FUNDING_BOUNDS.ratePer8h.max}]`,
          { index }
        );
      }
      if (
        interval < REPLAY_FUNDING_BOUNDS.intervalHours.min ||
        interval > REPLAY_FUNDING_BOUNDS.intervalHours.max
      ) {
        throw new EventReplayError(
          "replay:invalid-event",
          `Event #${index}: intervalHours ${interval} außerhalb [${REPLAY_FUNDING_BOUNDS.intervalHours.min}, ${REPLAY_FUNDING_BOUNDS.intervalHours.max}]`,
          { index }
        );
      }
      if (typeof event.venue !== "string" || event.venue.trim() === "" || event.venue.length > 32) {
        throw new EventReplayError("replay:invalid-event", `Event #${index}: ungültige Venue`, { index });
      }
      return { ...event, symbol };
    }
    default: {
      const exhaustive: never = event;
      throw new EventReplayError("replay:invalid-event", `Event #${index}: unbekannter Typ`, {
        index,
        type: (exhaustive as { type?: unknown }).type,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Friktionskonfiguration (versioniert)
// ─────────────────────────────────────────────────────────────────────────────

/** Version des Friktionsmodells — steht in Manifest, Report und Provenance. */
export const REPLAY_FRICTION_MODEL_VERSION = "er1" as const;

export interface EventReplayLatencyConfig {
  /** Entscheidungs- → Übermittlungszeit in ms (≥ 0). */
  decisionToSubmitMs: number;
  /** Übermittlungs- → Ankunftszeit an der Venue in ms (≥ 0). */
  submitToArrivalMs: number;
}

/** Optionen des Event-Replay-Ausführungspfads (alle Defaults dokumentiert). */
export interface EventReplayOptions {
  /** Latenzmodell (Default: 0/0 — Fill auf der Entscheidungskerze). */
  latency?: Partial<EventReplayLatencyConfig>;
  /**
   * Seed des Laufs — salzt Order-IDs und steht im Manifest. KEIN RNG:
   * das Modell ist vollständig deterministisch (Default: 1).
   */
  seed?: number;
  /**
   * Linearer Impact in Basispunkten bei 100 % Partizipation an der
   * verfügbaren Menge einer Kerze (Default: 25 bp). `impactBps =
   * impactBpsPerParticipation × (fillQty / availableQty)`.
   */
  impactBpsPerParticipation?: number;
  /**
   * Konservativer Fallback OHNE Depth-Ereignis: verfügbare Menge je Kerze =
   * `bar.volume × maxBarVolumeParticipation` (Default: 0.1 = 10 %).
   * Fehlt auch das Kerzenvolumen (≤ 0/NaN), findet KEIN Fill statt
   * (fail-closed, Grund `NO_LIQUIDITY_DATA`).
   */
  maxBarVolumeParticipation?: number;
  /**
   * Maximales Alter eines Depth-/Quote-Ereignisses in ms, bevor es als
   * stale gilt und der konservative Fallback greift (Default: 2 × Bar-Dauer).
   */
  maxDepthAgeMs?: number;
  /** Lebensdauer offener Orders in Kerzen ab Ankunft (Default: 3, ≥ 1). */
  orderTtlBars?: number;
  /** Spread-Fallback in bp, wenn keine Quote sichtbar ist (Default: 4). */
  spreadBpsFallback?: number;
  /** Instrumente je Engine-Symbol (Fees, marketType) — wie der Paper-Pfad. */
  instruments?: Record<string, MarketInstrument>;
  /** Gebühren-Override für Default-Instrumente (Default: Engine-`feeModel`). */
  makerFee?: number;
  takerFee?: number;
  /** Historische Input-Ereignisse (QUOTE/DEPTH/FUNDING_DUE). */
  events?: ReplayInputEvent[];
  /** Deckel des Order-Eventlogs im Resultat (Default: 10 000). */
  maxEventLog?: number;
}

/** Vollständig aufgelöste Konfiguration (steht im Run-Manifest). */
export interface ResolvedEventReplayConfig {
  frictionModelVersion: typeof REPLAY_FRICTION_MODEL_VERSION;
  latency: EventReplayLatencyConfig;
  seed: number;
  impactBpsPerParticipation: number;
  maxBarVolumeParticipation: number;
  maxDepthAgeMs: number;
  orderTtlBars: number;
  spreadBpsFallback: number;
  maxEventLog: number;
}

function requireConfigNumber(
  value: number,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean }
): number {
  if (!Number.isFinite(value)) {
    throw new EventReplayError("replay:invalid-config", `Replay-Konfiguration: ${field} ist nicht endlich`, { field });
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new EventReplayError("replay:invalid-config", `Replay-Konfiguration: ${field} muss ganzzahlig sein`, { field });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new EventReplayError("replay:invalid-config", `Replay-Konfiguration: ${field} < ${opts.min}`, { field, value });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new EventReplayError("replay:invalid-config", `Replay-Konfiguration: ${field} > ${opts.max}`, { field, value });
  }
  return value;
}

/**
 * Löst Optionen fail-closed in eine vollständige Konfiguration auf.
 * Negative Latenz, nicht endliche Werte oder unsinnige Bounds werfen
 * `replay:invalid-config` — es entsteht kein Lauf mit stiller Annahme.
 */
export function resolveEventReplayConfig(opts: EventReplayOptions, barMs: number): ResolvedEventReplayConfig {
  if (!Number.isFinite(barMs) || barMs <= 0) {
    throw new EventReplayError("replay:invalid-config", `Replay-Konfiguration: barMs ${barMs} ungültig`, { barMs });
  }
  return {
    frictionModelVersion: REPLAY_FRICTION_MODEL_VERSION,
    latency: {
      decisionToSubmitMs: requireConfigNumber(opts.latency?.decisionToSubmitMs ?? 0, "latency.decisionToSubmitMs", { min: 0 }),
      submitToArrivalMs: requireConfigNumber(opts.latency?.submitToArrivalMs ?? 0, "latency.submitToArrivalMs", { min: 0 }),
    },
    seed: requireConfigNumber(opts.seed ?? 1, "seed", { min: 0, integer: true }),
    impactBpsPerParticipation: requireConfigNumber(opts.impactBpsPerParticipation ?? 25, "impactBpsPerParticipation", { min: 0, max: 10_000 }),
    maxBarVolumeParticipation: requireConfigNumber(opts.maxBarVolumeParticipation ?? 0.1, "maxBarVolumeParticipation", { min: 1e-6, max: 1 }),
    maxDepthAgeMs: requireConfigNumber(opts.maxDepthAgeMs ?? 2 * barMs, "maxDepthAgeMs", { min: 1 }),
    orderTtlBars: requireConfigNumber(opts.orderTtlBars ?? 3, "orderTtlBars", { min: 1, max: 10_000, integer: true }),
    spreadBpsFallback: requireConfigNumber(opts.spreadBpsFallback ?? 4, "spreadBpsFallback", { min: 0, max: 5_000 }),
    maxEventLog: requireConfigNumber(opts.maxEventLog ?? 10_000, "maxEventLog", { min: 100, max: 1_000_000, integer: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage & Degraded Reasons (bounded Vokabular)
// ─────────────────────────────────────────────────────────────────────────────

/** Geschlossenes Vokabular degradierter Annahmen (nie Freitext/IDs). */
export type ReplayDegradedReason =
  | "DEPTH_MISSING_BAR_VOLUME_FALLBACK"
  | "DEPTH_STALE_BAR_VOLUME_FALLBACK"
  | "NO_LIQUIDITY_DATA_NO_FILL"
  | "QUOTE_MISSING_SPREAD_FALLBACK"
  | "ENTRY_CANCELLED_INSUFFICIENT_CASH"
  | "ORDER_TTL_CANCELLED"
  | "EVENT_LOG_TRUNCATED";

/** Event-Coverage eines Laufs (bounded Zähler, keine IDs). */
export interface EventReplayCoverage {
  bars: number;
  quoteEvents: number;
  depthEvents: number;
  fundingEvents: number;
  fillsFromDepth: number;
  fillsFromBarVolumeFallback: number;
  fundingApplied: number;
  fundingSkipped: number;
  ordersSubmitted: number;
  ordersFilled: number;
  ordersPartiallyFilled: number;
  ordersCancelled: number;
  ordersRejected: number;
}

export function emptyReplayCoverage(): EventReplayCoverage {
  return {
    bars: 0,
    quoteEvents: 0,
    depthEvents: 0,
    fundingEvents: 0,
    fillsFromDepth: 0,
    fillsFromBarVolumeFallback: 0,
    fundingApplied: 0,
    fundingSkipped: 0,
    ordersSubmitted: 0,
    ordersFilled: 0,
    ordersPartiallyFilled: 0,
    ordersCancelled: 0,
    ordersRejected: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade-Detail (erweitert die Trade-Logs um Fill-/Funding-/Impact-Details)
// ─────────────────────────────────────────────────────────────────────────────

/** EIN ausgeführter Fill mit vollständiger Zeit-/Kostenherkunft. */
export interface ReplayFillDetail {
  orderId: string;
  purpose: ReplayOrderPurpose;
  execSide: ReplayExecSide;
  decisionTime: number;
  submitTime: number;
  arrivalTime: number;
  fillTime: number;
  qty: number;
  price: number;
  /** Referenzpreis der Entscheidung/des Triggers (Slippage-Basis). */
  refPrice: number;
  fees: number;
  impactBps: number;
  spreadBps: number;
  /** Anteil an der verfügbaren Menge der Kerze (0..1]. */
  participation: number;
  liquiditySource: ReplayLiquiditySource;
}

/** EIN gebuchtes Funding-Ereignis einer Position (Kontosicht). */
export interface ReplayFundingDetail {
  eventTime: number;
  bookedAt: number;
  ratePer8h: number;
  intervalHours: number;
  markPrice: number;
  notional: number;
  /** Kontosicht: negativ = gezahlt, positiv = erhalten. */
  funding: number;
}

/** Maximal persistierte Fills je Trade (Bounded Provenance). */
export const REPLAY_TRADE_MAX_FILLS = 64;

/** Replay-Detailblock eines Trades (additiv auf `BacktestTradeLog`). */
export interface TradeReplayDetail {
  frictionModelVersion: typeof REPLAY_FRICTION_MODEL_VERSION;
  fills: ReplayFillDetail[];
  funding: ReplayFundingDetail[];
  /** true, wenn `fills`/`funding` am `REPLAY_TRADE_MAX_FILLS`-Deckel gekappt wurde. */
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-Manifest & Zusammenfassung (Reproduzierbarkeit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Datenmanifest eines Replay-Laufs: Fingerprints der VERSIONierten Inputs.
 * Gleiche Hashes + gleiche Config + gleicher Seed ⇒ identisches Ergebnis
 * (Golden-/Determinismus-Tests). Keine Rohdaten, keine Secrets — nur Hashes
 * und bounded Zähler.
 */
export interface EventReplayDataManifest {
  frictionModelVersion: typeof REPLAY_FRICTION_MODEL_VERSION;
  /** sha256 über die kanonisch sortierten Kerzenreihen (Symbol ↑). */
  candlesHash: string;
  /** sha256 über die kanonisch sortierten Input-Ereignisse. */
  eventsHash: string;
  candleCount: number;
  eventCounts: { quotes: number; depth: number; funding: number };
  symbols: string[];
}

/** Vollständige Replay-Evidenz eines Engine-Laufs (additiv am Resultat). */
export interface EventReplayRunSummary {
  config: ResolvedEventReplayConfig;
  manifest: EventReplayDataManifest;
  coverage: EventReplayCoverage;
  /** Sortierte, deduplizierte degradierte Annahmen (geschlossenes Vokabular). */
  degradedReasons: ReplayDegradedReason[];
  /** Order-Lifecycle-Eventlog (gedeckelt via `maxEventLog`). */
  orderEvents: ReplayOrderEvent[];
  orderEventsTruncated: boolean;
  /** Fill-/Funding-/Impact-Details je Engine-Trade-ID (`POS-n`). */
  tradeDetails: Record<string, TradeReplayDetail>;
}

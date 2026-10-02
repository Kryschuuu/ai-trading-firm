/**
 * Copy-Trading — Domänenmodell (Phase 7 · Paket 00-02 · STX-07-01).
 *
 * Dieses Modul ist **rein**: keine IO, keine DB, kein Netz, keine Uhr.
 * Es beschreibt ausschließlich die fachliche Form des Copy-Tradings:
 *
 *   - den {@link CopyMode} (STX-16: exakt ein Wert — Paper/SIMULATE_ONLY),
 *   - den {@link NormalizedLeaderTrade} (die normalisierte Handlungsabsicht),
 *   - die drei {@link SizingMode} und die {@link LeveragePolicy},
 *   - den {@link FollowerOrderIntent} (die daraus berechnete Follower-Order).
 *
 * Wichtig (Analyse-Kernpunkt): Copy Trading kopiert **nicht** die Order 1:1.
 * Es kopiert eine **Handlungsabsicht** (`action: OPEN | INCREASE | DECREASE |
 * CLOSE`) und berechnet daraus eine neue Follower-Order. Deshalb normalisieren
 * wir auf `action`, nicht auf eine Order-Übertragung.
 *
 * Alle weiteren Bestandteile (Policy-Engine, Tabellen, Leader-Adapter) sind
 * ausdrücklich gesperrt (07-02, 07-03).
 */

import type { BrokerVenueId } from "@/contracts/broker";

/**
 * Ausführungsmodus des Copy-Layers.
 *
 * **STX-16 (organisatorisch, hoch):** Das README positioniert die Firma als
 * Paper-Trading — „nicht produktionsreif, educational purposes only". Deshalb
 * ist `SIMULATE_ONLY` ein **Enum mit genau einem Wert**: kein Env-Flag, kein
 * Schalter, kein Live-Pfad in dieser Roadmap. Jeder spätere Modus (testnet,
 * live) wäre ein eigener, laut Roadmap gesperrter Ticket-Schritt — nicht hier.
 */
export type CopyMode = "SIMULATE_ONLY";

/**
 * Runtime-SSoT der erlaubten Copy-Modi (STX-16). Dient als Arity-Prüfung:
 * es gibt genau einen Wert. Jeder Versuch, weitere Modi hinzuzufügen, bricht
 * an dieser einen Stelle und in den Tests.
 */
export const COPY_MODES: readonly CopyMode[] = ["SIMULATE_ONLY"];

/** Die vier Handlungsabsichten, auf die wir normalisieren (nicht auf Orders). */
export type TradeAction = "OPEN" | "INCREASE" | "DECREASE" | "CLOSE";

/** Long/Short-Seite der Position. */
export type PositionSide = "LONG" | "SHORT";

/**
 * Normalisierter Leader-Trade — die **Handlungsabsicht**, nicht die rohe
 * Order. Wird vom Leader-Adapter (07-02) erzeugt; hier nur typisiert.
 *
 * Das `symbol` ist **venue-übergreifend normalisiert** (SSoT, siehe
 * `src/copy/mapping.ts`): `BTC/USD`, `BTC/USDT`, `BTC-PERP` zeigen auf
 * dieselbe ID, unabhängig davon, auf welcher Venue der Leader handelte.
 */
export interface NormalizedLeaderTrade {
  /** Stabiler, vom Leader-Adapter vergebener Event-Schlüssel (Idempotenz). */
  eventId: string;
  /** Venue des Leaders (wo die Order tatsächlich platziert wurde). */
  leaderVenue: BrokerVenueId;
  /** Konto-/Subaccount-Kennung des Leaders (Audit). */
  leaderAccount: string;
  /** **Normalisiert**, venue-übergreifend (SSoT). NIEMALS die Roh-Schreibweise. */
  symbol: string;
  side: PositionSide;
  /** Handlungsabsicht — nicht die Order-Übertragung. */
  action: TradeAction;
  /** Leader-Basiseinheiten (Menge der Original-Position). */
  quantity: number;
  /** Leader-Notional in der Quote-Währung des Leaders. */
  notional: number;
  /** Einstiegspreis; `null` = unbekannt. Nie 0 als „unbekannt". */
  entryPrice: number | null;
  /** Hebel des Leaders; `null` = unbekannt/nicht relevant. */
  leverage: number | null;
  /** Stop-Loss; `null` = keiner. */
  stopLoss: number | null;
  /** Take-Profit; `null` = keiner. */
  takeProfit: number | null;
  /** Eventzeit des Leaders in ms — **NICHT** die Empfangszeit. */
  occurredAt: number;
  /** Partial-Fill-Anteil [0,1] dieses Ereignisses. */
  fillRatio: number;
}

/** Sizing-Modi für die Follower-Größenberechnung. */
export type SizingMode = "FIXED_AMOUNT" | "FIXED_RATIO" | "EQUITY_RATIO";

/** Hebel-Politik beim Kopieren. */
export type LeveragePolicy = "FOLLOW_LEADER" | "CAP" | "IGNORE" | "RISK_NORMALIZED";

/**
 * Die berechnete Follower-Order — die Ableitung der Leader-Handlungsabsicht.
 * `sizing` dokumentiert die Herleitung (Modus + Inputs) für Audit/UI.
 */
export interface FollowerOrderIntent {
  /** Referenz auf das Ursprungs-Event des Leaders. */
  sourceEventId: string;
  /** Venue-übergreifend normalisiertes Symbol (SSoT). */
  symbol: string;
  side: PositionSide;
  /** Übernommene Handlungsabsicht des Leaders. */
  action: TradeAction;
  /** Berechnete Follower-Menge (Basiseinheiten). */
  quantity: number;
  /** Berechnetes Follower-Notional (Quote-Währung). */
  notional: number;
  /** Herleitung für Audit/UI: `sizingMode` + Input-Felder. */
  sizing: {
    mode: SizingMode;
    leaderNotional: number | null;
    leaderEquity: number | null;
    followerEquity: number | null;
    multiplier: number;
    leverageApplied: number | null;
  };
  /** Erzeugungszeitpunkt (ms). */
  createdAt: number;
}

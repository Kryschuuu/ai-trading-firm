/**
 * STX-05-01 — Typen des Strategie×Markt-Screenings.
 *
 * Reine Verträge: Es gibt hier keine Scanner-, Registry-, Store- oder
 * Persistenzimporte zur Laufzeit. Metriken bleiben `null`, solange sie nicht
 * belastbar gemessen wurden — unbekannt ist kein Score von null.
 */

import type { BrokerVenueId } from "@/contracts/broker";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { StrategyClassKey } from "@/lib/signalDecay";
import type { StrategyTemplateId } from "@/strategies/catalog";

/** Status einer Strategie×Markt-Zelle (Backtest-/Validierungsschritte in 05-02). */
export type CandidateStatus =
  | "DISCOVERED"
  | "READY"
  | "BACKTEST"
  | "VALIDATED"
  | "PAPER"
  | "BLOCKED";

/**
 * Eine Zelle der Strategie×Markt-Matrix.
 *
 * `instrumentId` folgt dem kanonischen `MarketInstrument.id`-Contract aus
 * `@/universe` (`VENUE:SYMBOL`); ein eigener Instrument-ID-Typ wird nicht
 * eingeführt.
 */
export interface StrategyMarketCandidate {
  templateId: StrategyTemplateId;
  templateVersion: number;
  strategyClass: StrategyClassKey;

  /** Kanonische Instrument-ID aus `@/universe` (`VENUE:SYMBOL`). */
  instrumentId: string;
  venue: BrokerVenueId;
  timeframe: SupportedTimeframe;

  /** Datenqualität [0,1]; null = unbekannt (nie 0!). */
  dataQuality: number | null;
  /** Liquidität [0,1]; null = unbekannt. */
  liquidity: number | null;
  /** Frische [0,1]; null = unbekannt. */
  freshness: number | null;
  /** Passung Strategie↔Marktsegment [0,1]; null = unbekannt. */
  strategyFit: number | null;
  /** Volatilitäts-Chancenklasse [0,1]; null = unbekannt. */
  volatilityOpportunity: number | null;
  /** Cluster-/Korrelationzuschlag [0,1]; 0 = kein Zuschlag. */
  correlationPenalty: number | null;

  /** Ergebnis von `scoreCandidate()`; null, wenn der Score nicht belegbar ist. */
  priority: number | null;
  status: CandidateStatus;
  /** Gründe für die Klassifikation bzw. einen späteren Verarbeitungsschritt. */
  reasons: readonly string[];

  /**
   * ID der von 04-02 persistierten Strategieversion. Sie ist das explizite
   * Signal, mit dem die reine Statusklassifikation `DISCOVERED` (noch keine
   * Persistenz) von `READY` unterscheiden kann. Fehlend/null/leer bedeutet
   * „Persistenz nicht nachgewiesen“ — nicht, dass eine Version erfunden wird.
   * Optional gehalten, damit reine Discovery-Fixtures noch keine DB-ID
   * vortäuschen müssen.
   */
  strategyVersionId?: string | null;
}

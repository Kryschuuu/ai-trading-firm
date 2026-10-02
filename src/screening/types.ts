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

/** Laufarten und Laufstatus der Screening-Persistenz (STX-05-03). */
export const SCREENING_RUN_KINDS = ["DISCOVERY", "MATRIX", "BACKTEST_BATCH"] as const;
export type ScreeningRunKind = (typeof SCREENING_RUN_KINDS)[number];

export const SCREENING_RUN_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED", "ABORTED"] as const;
export type ScreeningRunStatus = (typeof SCREENING_RUN_STATUSES)[number];

/** Status einer Strategie×Markt-Zelle (Backtest-/Validierungsschritte in 05-02). */
export type CandidateStatus =
  | "DISCOVERED"
  | "READY"
  | "BACKTEST"
  | "VALIDATED"
  | "PAPER"
  | "BLOCKED";

/**
 * Geschlossenes Vokabular des Zell-Ergebnisses eines Screening-Laufs
 * (STX-05-04). Es ist die **einzige** erlaubte Label-Dimension der Metrik
 * `screening_cells_total{result}` — bewusst code-konstant und kurz:
 *
 * | Wert | Bedeutung |
 * |---|---|
 * | `discovered` | Zelle ohne Backtest persistiert (Matrix-/Discovery-Lauf) |
 * | `backtested` | Zelle mit persistiertem Backtest + vergleichbaren Metriken |
 * | `blocked` | Zelle war bereits durch die Matrix-Gates gesperrt |
 * | `capped` | Zelle gesperrt, weil der Lauf die harten Caps überschritten hat |
 * | `failed` | Zelle nicht verarbeitbar (z. B. keine Strategieversion) |
 * | `skipped` | Zelle bereits in einem früheren Lauf erledigt (Fortsetzung) |
 *
 * Keine Instrument-IDs, Template-IDs, Prioritäten oder Fehlermeldungen als
 * Label (Kardinalitätsregel des Repos, siehe `src/lib/telemetry.ts`) — die
 * stehen im Zell-`reasons`-Array bzw. im strukturierten Log.
 */
export const SCREENING_CELL_RESULTS = [
  "discovered",
  "backtested",
  "blocked",
  "capped",
  "failed",
  "skipped",
] as const;
export type ScreeningCellResult = (typeof SCREENING_CELL_RESULTS)[number];

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

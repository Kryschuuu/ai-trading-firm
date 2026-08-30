/**
 * Eligibility-Diagnose (OPS-010 / Review Punkt 22) — vollständiger
 * Ablehnungs-Kontext pro Instrument für Monitoring und Root-Cause-Analyse.
 */
// Diese Diagnose dient AUSSCHLIESSLICH Monitoring-/Debugging-Zwecken.
// Das eigentliche "erste Regel gewinnt"-Routing im Eligibility-Filter
// bleibt für deterministisches, reproduzierbares Verhalten unverändert.
//
// Hintergrund: `checkEligibility()` meldet bewusst nur die **erste**
// zutreffende Regel (stabile Routing-Reihenfolge). Dieses Modul reichert
// diese Ablehnungen mit dem **vollständigen Datenzustand** des Instruments
// an (`candles`, `volume24h`, `spread`), damit ein Betreiber sofort sieht,
// ob eine Ablehnung eine **Data-Quality-Sache** („Spread wurde nicht
// geladen“ → Warmup/Sync) oder eine **fachliche** Aussage („Spread zu
// breit“ → Markt ungeeignet) ist.
//
// Eigenschaften:
//   - rein: kein I/O, keine Uhr, keine Netzwerk-Aufrufe, keine Mutation;
//   - deterministisch: Reihenfolge = Reihenfolge der Ablehnungen des Scans;
//   - begrenzt: Ausgabe ist gedeckelt ({@link MAX_ELIGIBILITY_DIAGNOSTICS}),
//     `total` nennt immer die ungekürzte Gesamtzahl (DoS-Schutz bei sehr
//     großen Universen — die API bleibt klein und schnell).

import type { FilterRejection, FilterRuleId } from "./filters";

/**
 * DoS-Deckel: maximale Anzahl ausgelieferter Diagnose-Einträge.
 * `total` bleibt unabhängig davon die volle Ablehnungszahl.
 */
export const MAX_ELIGIBILITY_DIAGNOSTICS = 50;

/** Vollständiger Datenzustand eines Instruments zum Ablehnungszeitpunkt. */
export interface InstrumentDataState {
  /** Geladene Kerzen im Scanner-Timeframe (Auswahl wie im Scan). */
  candles: number;
  /** 24h-Volumen aus der Registry; `null` = Ticker-Enrichment fehlt. */
  volume24h: number | null;
  /** Relativer Spread aus der Registry; `null` = Orderbook-Enrichment fehlt. */
  spread: number | null;
}

/**
 * Diagnose einer einzelnen Ablehnung — bewusst genau das Format aus dem
 * Review, damit Monitoring-Queries darauf stabil matchen:
 *
 * ```json
 * {
 *   "instrument": "BITUNIX:BTCUSDT",
 *   "eligibility": {
 *     "status": "rejected",
 *     "rule": "max-spread",
 *     "data": { "candles": 150, "volume24h": 2840000000, "spread": null }
 *   }
 * }
 * ```
 */
export interface EligibilityDiagnostic {
  /** Instrument-ID (`VENUE:SYMBOL`). */
  instrument: string;
  eligibility: {
    status: "rejected";
    /**
     * Erste zutreffende Regel — identisch mit `FilterRejection.ruleId`
     * (Routing-Verhalten unverändert, siehe Dateikopf).
     */
    rule: FilterRuleId;
    /**
     * `true` = Data-Quality-Ablehnung (Metrik nicht geladen; per
     * `npm run market-sync` behebbar), `false` = fachliche Ablehnung.
     */
    dataQuality: boolean;
    /** Vollständiger Datenzustand — macht „nicht geladen“ von „zu schlecht“ unterscheidbar. */
    data: InstrumentDataState;
  };
}

/** Gedeckelte Diagnose-Ausgabe samt Gesamtzahl. */
export interface EligibilityDiagnosticsSummary {
  /** Gesamtzahl der Ablehnungen des Scans (ungekürzt). */
  total: number;
  /** `true`, wenn `items` auf das Limit gekürzt wurde. */
  truncated: boolean;
  /** Diagnosen in der deterministischen Reihenfolge des Scans. */
  items: EligibilityDiagnostic[];
}

/**
 * Löst den Datenzustand einer Instrument-ID auf. Fehlende Instrumente
 * müssen `null`/`0`-Werte liefern dürfen — die Diagnose bricht nie.
 */
export type InstrumentDataResolver = (instrumentId: string) => InstrumentDataState;

/**
 * Baut die Ablehnungs-Diagnose aus den `FilterRejection`s eines Scans.
 *
 * @param rejections Ablehnungen des Scans (`ScanResult.rejections`,
 *   deterministische Reihenfolge = Scan-Instruments-Reihenfolge).
 * @param resolve Datenzustand je Instrument-ID (Registry-Felder +
 *   Kerzenzahl im Scanner-Timeframe).
 * @param limit Obergrenze der ausgelieferten Einträge
 *   (Default {@link MAX_ELIGIBILITY_DIAGNOSTICS}); `total` bleibt vollzählig.
 */
export function buildEligibilityDiagnostics(
  rejections: readonly FilterRejection[],
  resolve: InstrumentDataResolver,
  limit: number = MAX_ELIGIBILITY_DIAGNOSTICS,
): EligibilityDiagnosticsSummary {
  const cap = Math.max(0, Math.floor(limit));
  const items: EligibilityDiagnostic[] = [];
  for (const rejection of rejections) {
    if (items.length >= cap) break;
    const state = resolve(rejection.instrumentId);
    items.push({
      instrument: rejection.instrumentId,
      eligibility: {
        status: "rejected",
        rule: rejection.ruleId,
        dataQuality: rejection.dataQuality,
        data: {
          candles: Math.max(0, Math.floor(state.candles)),
          volume24h: typeof state.volume24h === "number" && Number.isFinite(state.volume24h) ? state.volume24h : null,
          spread: typeof state.spread === "number" && Number.isFinite(state.spread) ? state.spread : null,
        },
      },
    });
  }
  return { total: rejections.length, truncated: rejections.length > items.length, items };
}

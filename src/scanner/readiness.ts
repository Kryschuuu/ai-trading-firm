/**
 * Readiness-Modell des Markt-Scanners (OPS-009).
 *
 * Trennt **Infrastruktur** von **Fachlogik**: „keine Historie geladen“ ist ein
 * behebbarer Datenverfügbarkeits-Zustand (`WARMING`) bzw. ein echter Fetch-Fehler
 * (`ERROR`) — **nicht** dasselbe wie „Markt fachlich ungeeignet“. Der Zustand
 * wird deterministisch **vor** der Funnel-Auswertung berechnet und getrennt
 * ausgewiesen, damit ein Betreiber die beiden Fälle unterscheiden kann.
 *
 * Die Typen leben bewusst in einer eigenen, abhängigkeitsarmen Datei; die
 * reine Berechnung ({@link assessDataReadiness}) steht in `./warmup`.
 */

/** Ein Instrument, dessen geladene Kerzenzahl unter dem Warmup-Bedarf liegt. */
export interface ReadinessOffender {
  /** Instrument-ID (`VENUE:SYMBOL`). */
  instrumentId: string;
  /** Anzahl aktuell geladener Kerzen. */
  candles: number;
}

/** Ein echter Fetch-/Infrastruktur-Fehler (aus MDERR-006). */
export interface ReadinessFailure {
  /** Instrument-ID (`VENUE:SYMBOL`). */
  instrumentId: string;
  /** Sanitisierte Fehlerbegründung (keine Pfade/Hostnamen/Secrets). */
  reason: string;
}

/**
 * Expliziter, deterministischer Readiness-Zustand des Scanners.
 *
 * - `READY`   — alle Instrumente haben ≥ `requiredCandles` Kerzen.
 * - `WARMING` — Historie fehlt (behebbar per `npm run market-sync`), aber es
 *   liegt kein echter Fetch-Fehler vor.
 * - `ERROR`   — mindestens ein echter Datenfehler (Infrastruktur schlägt
 *   Fachlogik: ein Fetch-Fehler dominiert einen bloßen Warmup-Rückstand).
 */
export type ScannerReadiness =
  | { status: "READY"; instruments: number; warmed: number; missing: number; requiredCandles: number }
  | {
      status: "WARMING";
      instruments: number;
      warmed: number;
      missing: number;
      requiredCandles: number;
      /** Deterministisch sortiert (candles asc, dann instrumentId asc), max. 10. */
      worstOffenders: ReadinessOffender[];
    }
  | { status: "ERROR"; error: string; failures: ReadinessFailure[] };

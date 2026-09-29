/**
 * Timeframe-Vokabular des Systems — Allowlist und Periodenlängen (reine Daten).
 *
 * Es gibt genau EIN Vokabular. Der Historical Store, die Regel-Engine
 * (`RULE_ALLOWED_TIMEFRAMES`), der Mikro-Executor (Periodenlängen der Serien,
 * Timeframe-Guard), die Backtest-Engine und die Workshop-Oberfläche lesen alle
 * diese Liste; kein Konsument pflegt eine eigene.
 *
 * Warum eine eigene Datei: Die Liste muss in Import-Graphen liegen dürfen, die
 * kein `node:fs` vertragen — die Workshop-Komponenten landen im Client-Bundle,
 * die Regel-Engine ist bewusst importarm. Der Store (`historicalStore.ts`)
 * re-exportiert alles unverändert; bestehende Importe von dort bleiben gültig.
 */

/**
 * Alle im System zulässigen Kerzen-Periodizitäten (Allowlist), aufsteigend
 * nach Dauer sortiert.
 * Wird gegen externe/geparste Werte validiert — freie Strings werden
 * abgewiesen, damit ein Tippfehler (`"1H"` vs. `"1h"`) keine still
 * gemischte Reihe erzeugt.
 */
export const SUPPORTED_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
  "5d",
] as const;

export type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

/**
 * Periodenlänge je erlaubtem Timeframe in Millisekunden — die kanonische,
 * einzige solche Tabelle. Dient u. a. dem inkrementellen Sync (Vergleich der
 * jüngsten gespeicherten Kerze mit dem laufenden Periodenrand, siehe
 * `MarketDataSyncService`), Alignment-Prüfungen, den Rolling-Serien des
 * Mikro-Executors und dessen Timeframe-Guard (`ruleTimeframeBlockReason`).
 */
export const SUPPORTED_TIMEFRAME_MS: Record<SupportedTimeframe, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "5d": 5 * 24 * 60 * 60_000,
};

/** Prüft einen Wert gegen die Timeframe-Allowlist. */
export function isSupportedTimeframe(value: unknown): value is SupportedTimeframe {
  return typeof value === "string" && (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Benchmark-Katalog für die Equity-Kurve (Referenzlinie).
 *
 * Diese Datei enthält **nur** die Katalogdaten (IDs, Anzeigenamen, Kandidaten-
 * Reihen, Timeframes) und die Normalisierung des `?compare=`-Parameters. Sie
 * ist bewusst frei von Node-Imports, weil das Panel (`EquityPanel.tsx`) sie
 * als Client-Komponente lädt — das Lesen der Historie (`readBenchmarkSeries`,
 * `node:fs` über den `HistoricalStore`) liegt in `equityBenchmark.ts` und
 * bleibt serverseitig.
 *
 * Eine Referenz ist immer eine **echte** Kursreihe: Fehlt sie im
 * HistoricalStore, liefert die API `benchmark: null` und die UI zeichnet
 * nichts (docs/EQUITY_CURVE.md §5.3, §7).
 */
import type { SupportedTimeframe } from "@/lib/marketdata/timeframes";
import type { BenchmarkSeriesPoint } from "./equityAnalytics";

/** Zulässige Referenzen (ID → Anzeigename, Kandidaten-Reihen, Timeframes). */
export const BENCHMARKS = {
  BTC: {
    label: "Bitcoin (BTC/USDT)",
    instrumentIds: ["BINANCE:BTCUSDT", "BITUNIX:BTCUSDT", "PAPER:BTC", "KRAKEN:XBT/USD"],
    timeframes: ["1d", "4h", "1h"] as SupportedTimeframe[],
  },
  ETH: {
    label: "Ethereum (ETH/USDT)",
    instrumentIds: ["BINANCE:ETHUSDT", "BITUNIX:ETHUSDT", "PAPER:ETH", "KRAKEN:ETH/USD"],
    timeframes: ["1d", "4h", "1h"] as SupportedTimeframe[],
  },
  SPY: {
    label: "S&P 500 (SPY)",
    instrumentIds: ["ALPACA:SPY", "YAHOO:SPY", "PAPER:SPY"],
    timeframes: ["1d", "1h"] as SupportedTimeframe[],
  },
  QQQ: {
    label: "Nasdaq 100 (QQQ)",
    instrumentIds: ["ALPACA:QQQ", "YAHOO:QQQ", "PAPER:QQQ"],
    timeframes: ["1d", "1h"] as SupportedTimeframe[],
  },
} as const;

export type BenchmarkId = keyof typeof BENCHMARKS;

/** Reihenfolge für die UI (Dropdown). */
export const BENCHMARK_IDS: readonly BenchmarkId[] = ["BTC", "ETH", "SPY", "QQQ"];

export function isBenchmarkId(value: string): value is BenchmarkId {
  return (BENCHMARK_IDS as readonly string[]).includes(value);
}

/** Normalisiert den Parameter; unbekannte/fehlende Werte ⇒ keine Referenz. */
export function normalizeBenchmarkId(value: string | null | undefined): BenchmarkId | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw || raw === "none" || raw === "off" || raw === "keine") return null;
  const upper = raw.toUpperCase();
  return isBenchmarkId(upper) ? upper : null;
}

export type BenchmarkSeries = {
  id: BenchmarkId;
  label: string;
  /** Instrument-Reihe, aus der gelesen wurde (`VENUE:SYMBOL`). */
  source: string;
  timeframe: SupportedTimeframe;
  points: BenchmarkSeriesPoint[];
  /** Rendite der Referenz im Fenster (Prozent) — für Vergleichs-Kennzahl. */
  returnPct: number | null;
  /** Erster/letzter Kurszeitpunkt (ISO) für die Fußnote. */
  firstTs: string | null;
  lastTs: string | null;
};

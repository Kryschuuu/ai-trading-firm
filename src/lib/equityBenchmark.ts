/**
 * Benchmark-Referenzlinie für die Equity-Kurve — **Lese-Schicht** (Server).
 *
 * Warum eine eigene Schicht: Die Kurve zeigt den Kontostand, aber ohne Bezug
 * weiß der Betrachter nicht, ob +4 % gut oder schlecht waren. Die Referenz
 * beantwortet die Frage „Was hätte derselbe Betrag in einem simplen
 * Buy-and-Hold des Vergleichswerts ergeben?“.
 *
 * Datenquelle ist **ausschließlich die echte Kerzen-Historie** im
 * HistoricalStore (`PAPER_HISTORY_DIR`, Default `data/history/candles.ndjson`)
 * — dieselbe Datei, die `npm run market-sync` und der Paper-Market-Data-Pfad
 * füllen. Ist dort nichts vorhanden, liefert diese Schicht `null` und die UI
 * zeigt **keine** Linie. Eine erfundene oder synthetische Referenz wäre
 * schlimmer als keine (docs/EQUITY_CURVE.md §5.3, §7).
 *
 * Kein Netzwerkzugriff: es wird nie nachgeladen, nur gelesen. Damit bleibt die
 * Read-API schnell und offline-fähig; wer eine Referenz sehen will, füllt die
 * Historie per `npm run market-sync`.
 *
 * Der Katalog (IDs, Namen, Kandidaten-Reihen) liegt in
 * `equityBenchmarkCatalog.ts` und ist damit auch aus Client-Komponenten
 * importierbar, ohne `node:fs` ins Browser-Bundle zu ziehen.
 */
import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import {
  benchmarkReturnPct,
  scaleBenchmarkSeries,
} from "./equityAnalytics";
import {
  BENCHMARKS,
  BENCHMARK_IDS,
  isBenchmarkId,
  normalizeBenchmarkId,
  type BenchmarkId,
  type BenchmarkSeries,
} from "./equityBenchmarkCatalog";

export {
  BENCHMARKS,
  BENCHMARK_IDS,
  isBenchmarkId,
  normalizeBenchmarkId,
  type BenchmarkId,
  type BenchmarkSeries,
};

/**
 * Liest die Referenzreihe aus dem HistoricalStore und skaliert sie auf
 * `equityAtStart` (Buy-and-Hold mit dem Kontostand des Fensterstarts).
 *
 * `store` ist injizierbar (Tests/Skripte); Default ist der konfigurierte
 * History-Ordner. Fehler beim Lesen (fehlende Datei, Pfadprobleme) führen zu
 * `null` — Beobachtung darf die Kurve nie brechen.
 */
export function readBenchmarkSeries(
  id: BenchmarkId,
  opts: {
    since: Date;
    until: Date;
    equityAtStart: number;
    store?: HistoricalStore;
  }
): BenchmarkSeries | null {
  const spec = BENCHMARKS[id];
  let store: HistoricalStore;
  try {
    store = opts.store ?? new HistoricalStore(historyDir());
  } catch {
    return null;
  }

  for (const instrumentId of spec.instrumentIds) {
    for (const timeframe of spec.timeframes) {
      let entries: Array<{ ts: number; close: number }>;
      try {
        entries = store.query({
          instrumentId,
          timeframe,
          from: opts.since.getTime(),
          to: opts.until.getTime(),
        });
      } catch {
        continue; // unbekannter Timeframe o. Ä. — nächste Kandidaten-Reihe
      }
      // Zwei Punkte sind das Minimum für eine Linie (und für eine Rendite).
      if (entries.length < 2) continue;
      const points = scaleBenchmarkSeries(entries, opts.equityAtStart, {
        since: opts.since.getTime(),
        until: opts.until.getTime(),
      });
      if (points.length < 2) continue;
      return {
        id,
        label: spec.label,
        source: instrumentId,
        timeframe,
        points,
        returnPct: benchmarkReturnPct(points),
        firstTs: points[0].ts,
        lastTs: points[points.length - 1].ts,
      };
    }
  }
  // Keine Reihe mit Daten: bewusst `null` statt einer gestrichelten Null-Linie.
  return null;
}

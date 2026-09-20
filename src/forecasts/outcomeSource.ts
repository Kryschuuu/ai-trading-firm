/**
 * Outcome-Datenquelle des Resolvers (RMA-P3-01, v1.55.0).
 *
 * Produktionsbindung an den kanonischen Kerzen-Store
 * (`src/lib/marketdata/historicalStore.ts`, `data/history/candles.ndjson`):
 * Jede Kerze trägt dort eine Provenienz (`fetchedAt`) — damit ist die
 * Verfügbarkeitsprüfung des Resolvers (`fetchedAt <= availability_deadline`)
 * eine Eigenschaft der Daten, nicht der Aufrufdisziplin.
 *
 * Die Feed-Phase schreibt dieselben Kerzen, die auch der Analystenpfad sieht
 * (`getCandles`), mit `fetchedAt = now` in den Store. Der Kerzen-Store ist
 * append-only mit Determinismus-Garantie: identische Kerzen werden
 * dedupliziert; bei Korrekturen gewinnt der jüngste Abruf und die
 * Ersetzungszeit wird als neue Verfügbarkeit sichtbar — genau die Semantik,
 * die versionierte Re-Resolutionen von stiller Mutation unterscheidet.
 */

import {
  HistoricalStore,
  isSupportedTimeframe,
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import type { OutcomeBar, OutcomeDataReadPort, OutcomeDataWritePort } from "./ports";
import type { LiveBar } from "./resolver";

/** Feed-/Venue-Kennung der Ledger-Schreibzugriffe (Provenienz, kein Secret). */
export const FORECAST_STORE_FEED = "forecast-ledger";

export interface OutcomeSourceDeps {
  store?: HistoricalStore;
  now?: () => Date;
}

/** Parst eine Entity-ID (`VENUE:SYMBOL`) in ihre Provenanz-Bestandteile. */
export function provenanceOfEntity(entityId: string): { venue: string; symbol: string } {
  const idx = entityId.indexOf(":");
  if (idx <= 0 || idx === entityId.length - 1) {
    return { venue: "PAPER", symbol: entityId };
  }
  return { venue: entityId.slice(0, idx), symbol: entityId.slice(idx + 1) };
}

export class HistoricalStoreOutcomeSource implements OutcomeDataReadPort, OutcomeDataWritePort {
  private readonly store: HistoricalStore;
  private readonly now: () => Date;

  constructor(deps: OutcomeSourceDeps = {}) {
    this.store = deps.store ?? new HistoricalStore();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Kerzen mit Schlusszeit in `[fromMs, toMs]` (inklusive). Der Store
   * indexiert über die START-Zeit; die Schlusszeit ist `ts + timeframe`.
   */
  loadBars(entityId: string, timeframe: string, fromMs: number, toMs: number): Promise<OutcomeBar[]> {
    if (!isSupportedTimeframe(timeframe)) {
      throw new Error(`outcomeSource: Timeframe "${timeframe}" ist nicht unterstützt.`);
    }
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new Error(`outcomeSource: ungültiges Zeitfenster [${fromMs}, ${toMs}].`);
    }
    const tfMs = timeframeMsOf(timeframe);
    // ts (Startzeit) liegt in [fromMs − tf, toMs − tf].
    const entries = this.store.query({
      instrumentId: entityId,
      timeframe,
      from: fromMs - tfMs,
      to: toMs - tfMs,
    });
    const bars: OutcomeBar[] = [];
    for (const entry of entries) {
      const closeTimeMs = entry.ts + tfMs;
      if (closeTimeMs < fromMs || closeTimeMs > toMs) continue;
      const fetchedAtMs = Date.parse(entry.fetchedAt);
      bars.push({
        closeTimeMs,
        openTimeMs: entry.ts,
        close: entry.close,
        volume: entry.volume,
        fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : Number.MAX_SAFE_INTEGER,
      });
    }
    bars.sort((a, b) => a.closeTimeMs - b.closeTimeMs);
    return Promise.resolve(bars);
  }

  appendBars(
    entityId: string,
    timeframe: string,
    bars: readonly LiveBar[],
    now: Date
  ): Promise<{ written: number; deduplicated: number; invalid: number }> {
    if (!isSupportedTimeframe(timeframe)) {
      throw new Error(`outcomeSource: Timeframe "${timeframe}" ist nicht unterstützt.`);
    }
    const provenance = provenanceOfEntity(entityId);
    const result = this.store.append(
      bars.map((bar) => ({ ...bar })),
      entityId,
      { venue: provenance.venue, feed: FORECAST_STORE_FEED },
      timeframe as SupportedTimeframe,
      now
    );
    return Promise.resolve(result);
  }
}

function timeframeMsOf(timeframe: SupportedTimeframe): number {
  return SUPPORTED_TIMEFRAME_MS[timeframe];
}

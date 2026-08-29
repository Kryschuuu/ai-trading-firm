/**
 * Telemetrie / Metriken des Marktdaten-Pfads (MDERR-006).
 *
 * Es gibt keine externe Metrics-Infrastruktur (kein prom-client) — der
 * Betrieb läuft lokal-first. Deshalb: kleiner, prozessweiter In-Memory-Counter
 * mit stabilen Label-Namen plus optionaler Prometheus-Text-Exposition, damit
 * ein späterer Scraper die Werte ohne Code-Änderung abgreifen kann.
 *
 * Kardinalitäts-Regel (Security): `symbol` ist **kein** Label. Ein
 * symbol-labelser Counter würde bei 50 000 Instrumenten × Timeframes ins
 * Unendliche wachsen (Speicher-DoS). Labels sind `venue`, `timeframe`,
 * `reason`; das Symbol steht nur im strukturierten Log.
 *
 * Der Counter ist prozesslokal (Next.js-App bzw. MicroExecutor-Prozess).
 * Für Sync-Fehler aus separaten Prozessen existiert zusätzlich das
 * persistente Datenfehler-Manifest (`src/marketdata/dataErrors.ts`),
 * das das Operations Center mit einbezieht.
 */
import type { MarketDataErrorReason } from "./marketDataErrors";

/** Labels des Counters `market_data_fetch_failures_total` (bewusst ohne symbol). */
export interface FetchFailureLabels {
  venue: string;
  timeframe: string;
  reason: MarketDataErrorReason;
}

/** Momentaufnahme eines Label-Counters. */
export interface CounterSnapshot {
  name: string;
  total: number;
  byLabel: Record<string, number>;
}

export interface FetchFailuresSnapshot {
  total: number;
  byReason: Record<string, number>;
  byVenue: Record<string, number>;
  byTimeframe: Record<string, number>;
  byLabel: Record<string, number>;
}

/** Kleiner Label-Counter (kein Map-Leak: nur statische Label-Kombinationen). */
export class LabelCounter {
  private values = new Map<string, number>();

  constructor(readonly name: string) {}

  inc(labels: Record<string, string>, by = 1): void {
    const key = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${String(labels[k])}`)
      .join(",");
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  total(): number {
    let sum = 0;
    for (const v of this.values.values()) sum += v;
    return sum;
  }

  byDimension(dimension: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of this.values) {
      const part = key
        .split(",")
        .map((p) => p.split("="))
        .find(([k]) => k === dimension);
      if (part) out[part[1]] = (out[part[1]] ?? 0) + value;
    }
    return out;
  }

  byLabel(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  snapshot(): CounterSnapshot {
    return { name: this.name, total: this.total(), byLabel: this.byLabel() };
  }

  reset(): void {
    this.values.clear();
  }

  /** Prometheus-Textformat: `name{label="…",…} value`. */
  exposition(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.values.entries()].sort()) {
      const labels = key
        .split(",")
        .map((p) => {
          const [k, v] = p.split("=");
          return `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        })
        .join(",");
      lines.push(`${this.name}{${labels}} ${value}`);
    }
    if (lines.length === 0) lines.push(`${this.name} 0`);
    return lines.join("\n");
  }
}

/** Zentrales Telemetrie-Objekt. */
export const telemetry = {
  marketData: {
    /** Fehlgeschlagene Kerzenabrufe nach Ursache (MDERR-006). */
    fetchFailures: new LabelCounter("market_data_fetch_failures_total"),
  },
};

/** Snapshot für Ops/UI (inkl. Aufschlüsselung nach venue/timeframe/reason). */
export function marketDataFailureSnapshot(): FetchFailuresSnapshot {
  const c = telemetry.marketData.fetchFailures;
  return {
    total: c.total(),
    byReason: c.byDimension("reason"),
    byVenue: c.byDimension("venue"),
    byTimeframe: c.byDimension("timeframe"),
    byLabel: c.byLabel(),
  };
}

/** Prometheus-Text-Exposition (für spieteres Scraping). */
export function prometheusMetrics(): string {
  return telemetry.marketData.fetchFailures.exposition();
}

/** Nur für Tests: alle Counter zurücksetzen. */
export function resetTelemetryForTests(): void {
  telemetry.marketData.fetchFailures.reset();
}

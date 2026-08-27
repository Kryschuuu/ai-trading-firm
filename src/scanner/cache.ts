/**
 * Faktor-Cache (Skalierungsregel 4).
 *
 * Zwischenergebnisse werden pro **Instrument × Datenstand** gehalten: Ein
 * zweiter Scan mit unveränderten Kerzen rechnet die 14 Faktoren nicht erneut.
 * Der Schlüssel enthält die Konfigurationsversion und eine Datenversion
 * (Kerzenzahl + erster/letzter Zeitstempel + letzter Close + `asOf`), damit
 * neue Daten **nie** einen alten Wert treffen.
 *
 * Bewusst prozesslokal und ohne TTL: der Scanner ist deterministisch, ein
 * Treffer ist per Definition identisch mit einer Neuberechnung.
 */

import type { FactorId, FactorInput, FactorValue } from "./types";

/** Bildet die Datenversion einer Scan-Eingabe (kollisionsarm, deterministisch). */
export function dataVersionOf(input: FactorInput): string {
  const c = input.candles;
  const first = c.length ? c[0].time : 0;
  const lastCandle = c.length ? c[c.length - 1] : null;
  const benchmark = input.benchmarkCandles?.length ?? 0;
  const news = input.news ? `${input.news.events24h}/${input.news.events7d}/${input.news.highImpact24h}/${input.news.scheduledEventInHours ?? "-"}` : "-";
  const derivatives = input.derivatives
    ? `${input.derivatives.fundingRate ?? "-"}/${input.derivatives.openInterest ?? "-"}`
    : "-";
  return [
    input.config.version,
    input.asOf,
    c.length,
    first,
    lastCandle?.time ?? 0,
    lastCandle?.close ?? 0,
    benchmark,
    news,
    derivatives,
    input.instrument.lastSeen,
    input.instrument.volume24h ?? "-",
    input.instrument.spread ?? "-",
  ].join("|");
}

/** Statistik eines Cache-Laufs (Benchmark/Diagnose). */
export interface CacheStats {
  /** Treffer. */
  hits: number;
  /** Fehlschläge (Neuberechnung). */
  misses: number;
  /** Verdrängte Einträge (LRU). */
  evictions: number;
}

/**
 * LRU-Cache für Faktorwerte eines Instruments.
 *
 * @example
 * ```ts
 * const cache = new FactorCache(5000);
 * const factors = cache.getOrCompute(input, computeAllFactors);
 * ```
 */
export class FactorCache {
  private readonly map = new Map<string, Record<FactorId, FactorValue>>();
  private readonly stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  /** @param maxEntries harte Obergrenze (Speicherschutz, Default 20 000). */
  constructor(readonly maxEntries = 20_000) {}

  /** Anzahl gehaltener Einträge. */
  get size(): number {
    return this.map.size;
  }

  /** Kopie der Trefferstatistik. */
  get statistics(): CacheStats {
    return { ...this.stats };
  }

  /** Cache-Schlüssel einer Eingabe. */
  keyOf(input: FactorInput): string {
    return `${input.instrument.id}#${dataVersionOf(input)}`;
  }

  /** Liefert den gecachten Wert oder berechnet ihn über `compute`. */
  getOrCompute(
    input: FactorInput,
    compute: (input: FactorInput) => Record<FactorId, FactorValue>
  ): Record<FactorId, FactorValue> {
    const key = this.keyOf(input);
    const hit = this.map.get(key);
    if (hit) {
      this.stats.hits += 1;
      // LRU-Auffrischung: erneut einfügen ⇒ jüngster Eintrag.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    this.stats.misses += 1;
    const value = compute(input);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
        this.stats.evictions += 1;
      }
    }
    return value;
  }

  /** Leert den Cache (Tests, Konfigurationswechsel). */
  clear(): void {
    this.map.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
  }
}

/**
 * Scanner-Service — die Brücke zwischen Pipeline und den read-only API-Routen.
 *
 * Der Service hält **ein** Scan-Ergebnis prozessweit (auch über Next.js-HMR
 * stabil) und liefert daraus Trichter-Ebenen, Weekly-Klassifikation und
 * Einzel-Breakdowns. Er ist bewusst faul: gerechnet wird erst beim ersten
 * Zugriff, danach aus dem Speicher.
 *
 * Datenquellen im Produktivbetrieb (alle lokal, kein Netzwerk):
 *   - Instrumente: `InstrumentRegistry` (Task 01)
 *   - Kerzen: `HistoricalStore` (Task 03, append-only NDJSON)
 *
 * Tests injizieren stattdessen eigene Instrumente/Serien oder setzen direkt
 * ein Ergebnis über {@link setScannerResultForTests}.
 */

import {
  DEFAULT_ANALYSIS_TIMEFRAME,
  HistoricalStore,
  LEGACY_UNKNOWN,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import type { MarketCandle } from "@/lib/marketdata/types";
import { getRegistry } from "@/universe";
import type { MarketInstrument } from "@/universe/types";
import { loadScannerConfig, type ScannerConfig } from "./config";
import { scanUniverse, type ScanDataProvider, type ScanResult } from "./pipeline";
import { classifyWeekly, type WeeklyReview } from "./weekly";

/** Harte Obergrenze der Instrumente, die der Service aus der Registry zieht. */
export const MAX_SERVICE_INSTRUMENTS = 50_000;

/** Liest alle Instrumente der Registry seitenweise (stabile Reihenfolge nach `id`). */
export function loadAllInstruments(limit = MAX_SERVICE_INSTRUMENTS): MarketInstrument[] {
  const registry = getRegistry();
  const pageSize = 500;
  const out: MarketInstrument[] = [];
  for (let page = 1; out.length < limit; page++) {
    const result = registry.query({ page, pageSize });
    out.push(...result.items);
    if (!result.hasMore) break;
  }
  return out.slice(0, limit);
}

/**
 * Timeframe the scanner prefers after a market-data warmup.
 * Shorter intervals stay in the store for other consumers; mixing them here
 * would corrupt lookbacks (trend/drawdown periods assume a single interval).
 */
export const SCANNER_CANDLE_TIMEFRAME: SupportedTimeframe = DEFAULT_ANALYSIS_TIMEFRAME;

const TIMEFRAME_PREFERENCE: readonly SupportedTimeframe[] = ["1h", "4h", "30m", "15m", "5m"];

/**
 * Datenanbindung auf Basis des Historical Store: die NDJSON-Datei wird
 * **einmal** gelesen und nach Instrument gruppiert (O(n) statt O(n²)).
 *
 * Der Scanner ruft niemals den Sync-Service auf — er liest
 * ausschließlich die (ggf. zuvor vom Sync-Job befüllte) lokale Datei.
 * Kein Netzwerk, keine DB, kein LLM.
 *
 * Über `readAll()` (Wartungs-/Scanner-Zugriff) werden ALLE Timeframes
 * geladen; je Instrument wird deterministisch eine Reihe ausgewählt
 * (längste bevorzugte Periodizität, danach Legacy-Fallback). Bereits im
 * Store deduplizierte Einträge sind hier eindeutig.
 */
export function historicalStoreProvider(store: HistoricalStore, benchmarkInstrumentId: string): ScanDataProvider {
  const raw = new Map<string, { timeframe: SupportedTimeframe | typeof LEGACY_UNKNOWN; candle: MarketCandle }[]>();
  for (const e of store.readAll()) {
    const list = raw.get(e.instrumentId) ?? [];
    list.push({
      timeframe: e.timeframe,
      candle: { time: e.ts, open: e.open, high: e.high, low: e.low, close: e.close, volume: e.volume },
    });
    raw.set(e.instrumentId, list);
  }
  const byInstrument = new Map<string, MarketCandle[]>();
  for (const [id, rows] of raw) {
    const candles = pickTimeframe(rows);
    candles.sort((a, b) => a.time - b.time);
    byInstrument.set(id, candles);
  }
  const benchmark = byInstrument.get(benchmarkInstrumentId) ?? null;
  return {
    candles: (instrument) => byInstrument.get(instrument.id) ?? [],
    benchmarkCandles: (instrument) => (instrument.id === benchmarkInstrumentId ? null : benchmark),
  };
}

function pickTimeframe(
  rows: { timeframe: SupportedTimeframe | typeof LEGACY_UNKNOWN; candle: MarketCandle }[],
): MarketCandle[] {
  for (const tf of TIMEFRAME_PREFERENCE) {
    const subset = rows.filter((r) => r.timeframe === tf).map((r) => r.candle);
    if (subset.length) return subset;
  }
  // Letzter Ausweg: gemischte andere Timeframes nach Präferenz, dann Legacy.
  const tagged = rows.filter((r) => r.timeframe !== LEGACY_UNKNOWN);
  if (tagged.length) {
    for (const r of tagged) {
      const subset = rows.filter((x) => x.timeframe === r.timeframe).map((x) => x.candle);
      if (subset.length) return subset;
    }
  }
  return rows.filter((r) => r.timeframe === LEGACY_UNKNOWN).map((r) => r.candle);
}

/** Optionen einer Service-Instanz (alles injizierbar ⇒ testbar). */
export interface ScannerServiceOptions {
  /** Uhr; Default `() => new Date()`. */
  now?: () => Date;
  /** Konfiguration; Default {@link loadScannerConfig}. */
  config?: ScannerConfig;
  /** Instrumentenquelle; Default: Registry. */
  instruments?: () => MarketInstrument[];
  /** Datenanbindung; Default: Historical Store. */
  data?: ScanDataProvider;
  /** Instrumentenstand der Vorwoche (Weekly-Änderungssignale). */
  previousInstruments?: () => MarketInstrument[] | null;
  /** Vorheriger Weekly-Review. */
  previousReview?: () => WeeklyReview | null;
}

/** Hält Scan-Ergebnis und Weekly-Review für die API bereit. */
export class ScannerService {
  private scan: ScanResult | null = null;
  private weekly: WeeklyReview | null = null;
  private readonly options: ScannerServiceOptions;

  constructor(options: ScannerServiceOptions = {}) {
    this.options = options;
  }

  /** Aktuelles Scan-Ergebnis (rechnet beim ersten Zugriff). */
  getScan(): ScanResult {
    if (!this.scan) this.refresh();
    return this.scan as ScanResult;
  }

  /** Weekly-Klassifikation zum aktuellen Scan. */
  getWeekly(): WeeklyReview {
    if (!this.weekly) {
      const scan = this.getScan();
      this.weekly = classifyWeekly({
        scan,
        instruments: this.currentInstruments(),
        previous: this.options.previousReview?.() ?? null,
        previousInstruments: this.options.previousInstruments?.() ?? null,
      });
    }
    return this.weekly;
  }

  /** Score-Breakdown eines Instruments (`null`, wenn unbekannt). */
  scoreFor(instrumentId: string) {
    return this.getScan().byId.get(instrumentId) ?? null;
  }

  /** Rechnet neu (z. B. nach einem Discovery-Lauf) und liefert das Ergebnis. */
  refresh(): ScanResult {
    const config = this.options.config ?? loadScannerConfig();
    const instruments = this.currentInstruments();
    const data =
      this.options.data ?? historicalStoreProvider(new HistoricalStore(), config.factors.correlation.benchmarkInstrumentId);
    const now = this.options.now ?? (() => new Date());
    this.scan = scanUniverse({ instruments, data, asOf: now(), config });
    this.weekly = null;
    return this.scan;
  }

  private currentInstruments(): MarketInstrument[] {
    return this.options.instruments ? this.options.instruments() : loadAllInstruments();
  }
}

const GLOBAL = globalThis as typeof globalThis & { __scannerService?: ScannerService };

/** Prozessweite Service-Instanz (HMR-stabil). */
export function getScannerService(): ScannerService {
  if (!GLOBAL.__scannerService) GLOBAL.__scannerService = new ScannerService();
  return GLOBAL.__scannerService;
}

/** Nur für Tests: Service ersetzen oder verwerfen. */
export function setScannerServiceForTests(service: ScannerService | null): void {
  if (service) GLOBAL.__scannerService = service;
  else delete GLOBAL.__scannerService;
}

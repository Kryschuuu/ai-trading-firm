/**
 * Market-Data-Readiness-Report (OPS-010 / Review Sections 14 & 26).
 *
 * Das Operations Center zeigte bislang ausschließlich den **Endzustand** des
 * Scanner-Funnels („Gescannt 26, Eligible 0, …“). Dieses Modul macht stattdessen
 * den Pipeline-Zustand **entlang der Datenstufen** sichtbar:
 *
 * ```text
 *   Registry → Discovered → Data-ready/Warming → Candles → Ticker/Spread → Scanner-ready
 *   (Discovery)  (Enrichment: tickers/depth)      (Backfill: kline)        (Scanner)
 * ```
 *
 * Der Report ist eine **reine Aggregation** vorhandener Zustände:
 * Instrument-Registry (Metriken/`lastSeen`) + Historical Store (Kerzenzahlen)
 * + Scanner-Konfiguration (`requiredWarmupCandles`). **Kein Netzwerk-I/O** —
 * ein Sync wird hier weder angestoßen noch bewertet; der Report liest nur,
 * was Discovery/Enrichment/Backfill zuvor persistiert haben.
 *
 * Semantik je Feld: siehe `docs/MARKET_DATA_PIPELINE.md` §6 und den
 * Diagnose-Walkthrough in `docs/OPERATIONS_CENTER.md`.
 */

import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import type { ScannerConfig } from "@/scanner/config";
import { historicalStoreProvider } from "@/scanner/service";
import { requiredWarmupCandles } from "@/scanner/warmup";
import type { MarketInstrument } from "@/universe/types";

/**
 * „Frisch“-Zeitfenster der Discovery: Ein Instrument gilt als **discovered**,
 * wenn sein `lastSeen` höchstens so alt ist. Deckt sich mit dem
 * Betriebsrhythmus des Syncs (`npm run market-sync` je Tag).
 */
export const DISCOVERY_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Venue-Label, wenn der Report mehrere (oder keine) Venues aggregiert. */
export const MULTI_VENUE_LABEL = "ALL";

/**
 * Strukturierter Readiness-Report für das Operations Center.
 * Nur aggregierte Zähler — keine Secrets, keine Adapter-Konfiguration,
 * keine kursbezogenen Rohdaten (Security-Audit, `docs/OPERATIONS_CENTER.md` §5).
 */
export interface MarketDataReadinessReport {
  /** Aggregierte Venue — exakt eine Venue im Bestand, sonst `"ALL"`. */
  venue: string;
  /** Instrumente in der Registry (`registry.size`). */
  registryCount: number;
  /** Instrumente mit `lastSeen` innerhalb {@link DISCOVERY_FRESHNESS_WINDOW_MS}. */
  discoveredCount: number;
  /**
   * Vollständig daten-bereit: `candleCount >= requiredWarmupCandles(config)`
   * UND `volume24h !== null` UND `spread !== null` (Grenzwert gilt als ready).
   */
  dataReadyCount: number;
  /** `registryCount - dataReadyCount` — noch im Warmup begriffene Instrumente. */
  warmingCount: number;
  /**
   * Summe der geladenen Kerzen über alle Registry-Instrumente
   * (Scanner-Timeframe, dieselbe Zeitreihen-Auswahl wie der Scan).
   * Ein Wert von `0` bedeutet: es wurde noch kein Market-Data-Sync
   * durchgeführt oder er ist fehlgeschlagen.
   */
  candlesLoaded: number;
  /**
   * Mindest-Kerzenzahl **je Instrument**, dynamisch aus dem Faktorsatz
   * abgeleitet (`requiredWarmupCandles(config)`, EMA/Momentum/… — Default 61).
   */
  candlesRequired: number;
  /** Instrumente mit bekanntem 24h-Volumen (Ticker-Enrichment gelaufen). */
  tickerReadyCount: number;
  /** Instrumente mit bekanntem Spread (Orderbook-Enrichment gelaufen). */
  spreadReadyCount: number;
  /** `dataReadyCount > 0` — Mindestvoraussetzung für einen nutzbaren Scan. */
  scannerReady: boolean;
}

/** Eingabe der reinen Report-Aggregation (alles injizierbar ⇒ testbar). */
export interface MarketDataReadinessInput {
  /** Betrachtete Instrumente (Registry-Inhalt, seitenweise geladen). */
  instruments: readonly MarketInstrument[];
  /** Geladene Kerzen je Instrument-ID (Scanner-Timeframe, siehe {@link scannerCandleCounts}). */
  candleCounts: ReadonlyMap<string, number>;
  /** Scanner-Konfiguration (Quelle von `requiredWarmupCandles`). */
  config: ScannerConfig;
  /**
   * Tatsächliche Registry-Größe (`registry.size`), falls die Instrumentenliste
   * aus Schutzgründen gekappt geladen wurde. Default: `instruments.length`.
   */
  registrySize?: number;
  /** Referenzzeitpunkt (ms) für das „frisch“-Fenster; Default `Date.now()`. */
  now?: number;
  /** „Frisch“-Fenster für `discoveredCount`; Default 24h. */
  freshnessWindowMs?: number;
}

/**
 * Aggregiert den Readiness-Report. Reine Funktion: kein I/O, keine Uhr
 * (außer der injizierbaren `now`), keine Mutation der Eingaben.
 *
 * Zählregeln (exakt wie in `docs/MARKET_DATA_PIPELINE.md` §6 dokumentiert):
 *   - `discoveredCount`: `lastSeen` innerhalb des Fensters (Zukunft zählt als
 *     frisch — Clock-Skew-tolerant); ungültige Zeitstempel zählen nicht.
 *   - `dataReadyCount`: Kerzen **≥** Bedarf (Grenzwert = ready) UND Ticker UND
 *     Spread bekannt. `null` heißt „unbekannt“, nicht „gut“ (Task 01).
 *   - `warmingCount`: `registryCount − dataReadyCount` (nie negativ).
 *   - `scannerReady`: `dataReadyCount > 0`.
 */
export function collectMarketDataReadiness(input: MarketDataReadinessInput): MarketDataReadinessReport {
  const { instruments, candleCounts, config } = input;
  const now = input.now ?? Date.now();
  const windowMs = Math.max(0, input.freshnessWindowMs ?? DISCOVERY_FRESHNESS_WINDOW_MS);
  const requiredCandles = requiredWarmupCandles(config);
  const registryCount = Math.max(0, Math.floor(input.registrySize ?? instruments.length));

  let discovered = 0;
  let dataReady = 0;
  let tickerReady = 0;
  let spreadReady = 0;
  let candlesLoaded = 0;
  const venues = new Set<string>();

  for (const instrument of instruments) {
    venues.add(instrument.venue);
    const seenMs = Date.parse(instrument.lastSeen);
    if (Number.isFinite(seenMs) && seenMs >= now - windowMs) discovered += 1;

    const candles = Math.max(0, candleCounts.get(instrument.id) ?? 0);
    candlesLoaded += candles;

    const hasTicker = instrument.volume24h !== null;
    const hasSpread = instrument.spread !== null;
    if (hasTicker) tickerReady += 1;
    if (hasSpread) spreadReady += 1;
    if (candles >= requiredCandles && hasTicker && hasSpread) dataReady += 1;
  }

  return {
    venue: venues.size === 1 ? [...venues][0] : MULTI_VENUE_LABEL,
    registryCount,
    discoveredCount: discovered,
    dataReadyCount: dataReady,
    warmingCount: Math.max(registryCount - dataReady, 0),
    candlesLoaded,
    candlesRequired: requiredCandles,
    tickerReadyCount: tickerReady,
    spreadReadyCount: spreadReady,
    scannerReady: dataReady > 0,
  };
}

/**
 * Kerzenzahlen je Instrument **exakt in der Zeitreihen-Auswahl des Scanners**
 * (Timeframe-Präferenz `1h → 4h → 30m → 15m → 5m`, danach Legacy-Fallback):
 * Der Report darf keine andere Meinung über „geladene Historie“ haben als der
 * Scan selbst — darum wird derselbe Provider-Pfad wiederverwendet statt einer
 * zweiten Auswahllogik. Lokaler Dateizugriff, kein Netzwerk.
 */
export function scannerCandleCounts(
  store: HistoricalStore,
  instruments: readonly MarketInstrument[],
  benchmarkInstrumentId: string,
): Map<string, number> {
  const provider = historicalStoreProvider(store, benchmarkInstrumentId);
  const counts = new Map<string, number>();
  for (const instrument of instruments) {
    counts.set(instrument.id, provider.candles(instrument).length);
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store-Zugriff des Kollektors (mit Test-Hook, Muster wie setScannerServiceForTests)
// ─────────────────────────────────────────────────────────────────────────────

let storeOverride: HistoricalStore | null = null;

/** Historical Store am Standard-Pfad — oder der per Test-Hook injizierte. */
export function marketDataReadinessStore(): HistoricalStore {
  return storeOverride ?? new HistoricalStore();
}

/**
 * Nur für Tests: Store injizieren (`null` = zurück zum Standard-Pfad).
 * Ermöglicht hermetische Integrationstests ohne Schreibzugriff auf
 * `data/history` (Spiegelbild zu `setScannerServiceForTests`).
 */
export function setMarketDataReadinessStoreForTests(store: HistoricalStore | null): void {
  storeOverride = store;
}

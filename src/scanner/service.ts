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
import { loadMarketDataErrors } from "@/marketdata/dataErrors";
import { loadPerpConfig } from "@/perpdata/config";
import { perpDerivativeContextsFromCache } from "@/perpdata/derivativeCache";
import { qualityStrictDataErrorsForScan } from "@/marketdata/quality";
import { resolveRuntimePath } from "@/lib/appPaths";
import { getRegistry } from "@/universe";
import type { MarketInstrument } from "@/universe/types";
import { loadCrossSectionalConfig, isCrossSectionalEnabled } from "@/crossSectional/config";
import {
  loadLatestCrossSectionalArtifact,
  rankContextOf,
} from "@/crossSectional/artifact";
import type { CrossSectionalRankContext } from "@/crossSectional/types";
import { loadScannerConfig, type ScannerConfig } from "./config";
import {
  scanUniverse,
  type ScanDataProvider,
  type ScanResult,
} from "./pipeline";
import { classifyWeekly, type WeeklyReview } from "./weekly";
import type { DerivativeContext } from "./types";

/** Harte Obergrenze der Instrumente, die der Service aus der Registry zieht. */
export const MAX_SERVICE_INSTRUMENTS = 50_000;

/**
 * Default-Cache-Alter des prozessweiten Scan-Ergebnisses (5 Minuten).
 *
 * Der Scan ist rein lokal und deterministisch; ohne TTL würde ein einmal
 * berechnetes Ergebnis aber den ganzen Prozesslauf lang festgehalten — nach
 * einem `market:sync` in einem separaten CLI-Prozess zeigte die UI dann
 * weiter den alten (leeren) Trichter. Die TTL ist eine reine Konstruktor-
 * Option (`cacheTtlMs`, Default diese Konstante; `0` = jede Abfrage rechnet
 * neu). Der Scanner liest KEINE Umgebungsvariablen (Architekturtest).
 */
export const DEFAULT_SCAN_CACHE_TTL_MS = 5 * 60_000;

/** Intern: mtime einer Runtime-Datei (best-effort, fehlende Datei → 0). */
function fileMtimeMs(file: string): number {
  try {
    // `resolveRuntimePath` löst `data/...` relativ zur Runtime (Berücksichtigt
    // `DATA_DIR`/`HISTORY_DIR` und den Next.js-cwd, identisch zu
    // `HistoricalStore`/`InstrumentRegistry`).
    const resolved = resolveRuntimePath(file);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(resolved)) return 0;
    return statSync(resolved).mtimeMs;
  } catch {
    return 0;
  }
}


/**
 * Löst die konfigurierte Benchmark-ID gegen das tatsächlich vorhandene
 * Universum auf.
 *
 * Die Konfiguration nannte historisch `BINANCE:BTCUSDT`, obwohl nur die
 * BITUNIX-Venue angebunden ist — der Korrelationsfaktor (5 % des Scores) war
 * damit auf jedem Lauf „unbekannt“ und die Cluster-Erkennung des Weekly-Reviews
 * schlug nie an. Auflösungsreihenfolge, deterministisch:
 *
 *   1. exakte ID;
 *   2. gleiches venue-natives Symbol auf einer anderen Venue (`*:BTCUSDT`);
 *   3. gleiche Basis- und Quote-Währung (`BITUNIX:BTC/USDT`);
 *   4. `null` (Faktor fällt dokumentiert auf seinen Neutralwert zurück).
 */
export function resolveBenchmarkId(
  configuredId: string,
  instruments: readonly MarketInstrument[],
): string | null {
  if (!configuredId) return null;
  const byId = new Map(
    instruments.map((instrument) => [instrument.id, instrument]),
  );
  if (byId.has(configuredId)) return configuredId;

  const colon = configuredId.indexOf(":");
  const configuredSymbol =
    colon >= 0 ? configuredId.slice(colon + 1) : configuredId;
  const configured = byId.get(configuredId) ?? null;

  const sameSymbol = instruments
    .filter(
      (instrument) =>
        colon >= 0 &&
        instrument.symbol === configuredSymbol &&
        instrument.id !== configuredId,
    )
    .map((instrument) => instrument.id)
    .sort();
  if (sameSymbol.length > 0) return sameSymbol[0];

  const wantedBase =
    configured?.base ??
    configuredSymbol.replace(/(USDT|USD|USDC|BUSD|EUR|GBP)$/, "");
  const wantedQuote =
    configured?.quote ??
    (configuredSymbol.endsWith("USDT")
      ? "USDT"
      : configuredSymbol.endsWith("USDC")
        ? "USDC"
        : "USD");
  const samePair = instruments
    .filter(
      (instrument) =>
        instrument.base === wantedBase && instrument.quote === wantedQuote,
    )
    .map((instrument) => instrument.id)
    .sort();
  if (samePair.length > 0) return samePair[0];

  return null;
}

/** Liest alle Instrumente der Registry seitenweise (stabile Reihenfolge nach `id`). */
export function loadAllInstruments(
  limit = MAX_SERVICE_INSTRUMENTS,
): MarketInstrument[] {
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
export const SCANNER_CANDLE_TIMEFRAME: SupportedTimeframe =
  DEFAULT_ANALYSIS_TIMEFRAME;

const TIMEFRAME_PREFERENCE: readonly SupportedTimeframe[] = [
  "1h",
  "4h",
  "30m",
  "15m",
  "5m",
];

/**
 * Datenanbindung auf Basis des Historical Store: die NDJSON-Datei wird
 * **einmal** gelesen und nach Instrument + Timeframe gruppiert (O(n)).
 *
 * Der Scanner ruft niemals den Sync-Service auf — er liest
 * ausschließlich die (ggf. zuvor vom Sync-Job befüllte) lokale Datei.
 * Kein Netzwerk, keine DB, kein LLM.
 *
 * Über `readAll()` (Wartungs-/Scanner-Zugriff) werden ALLE Timeframes
 * geladen; je Instrument wird deterministisch eine Reihe ausgewählt
 * (längste bevorzugte Periodizität, danach Legacy-Fallback). Bereits im
 * Store deduplizierte Einträge sind hier eindeutig.
 *
 * `instruments` (empfohlen) löst die konfigurierte Benchmark-ID
 * venue-agnostisch auf ({@link resolveBenchmarkId}) — ist der konfigurierte
 * Benchmark auf dieser Venue nicht vorhanden, wird dieselbe Basis/Quote
 * bzw. dasselbe venue-native Symbol einer angebundenen Venue genutzt.
 */
export function historicalStoreProvider(
  store: HistoricalStore,
  benchmarkInstrumentId: string,
  instruments?: readonly MarketInstrument[],
  /**
   * Derivate-Kontext je Instrument-ID (RMA-P2-02, v1.54.0). Optional und
   * **sync**: die Karte wird as-of vorgebaut (Cache-Artefakt oder
   * `buildPerpDerivativeSnapshots`). Fehlt ein Eintrag, liefert der Provider
   * `null` — die Funding-/OI-Faktoren bleiben bei ihrem Neutralwert.
   */
  derivatives?: ReadonlyMap<string, DerivativeContext> | null
): ScanDataProvider {
  const raw = new Map<
    string,
    {
      timeframe: SupportedTimeframe | typeof LEGACY_UNKNOWN;
      candle: MarketCandle;
    }[]
  >();
  for (const e of store.readAll()) {
    const list = raw.get(e.instrumentId) ?? [];
    list.push({
      timeframe: e.timeframe,
      candle: {
        time: e.ts,
        open: e.open,
        high: e.high,
        low: e.low,
        close: e.close,
        volume: e.volume,
      },
    });
    raw.set(e.instrumentId, list);
  }
  const byInstrument = new Map<string, MarketCandle[]>();
  for (const [id, rows] of raw) {
    const candles = pickTimeframe(rows);
    candles.sort((a, b) => a.time - b.time);
    byInstrument.set(id, candles);
  }
  // Benchmark-Auflösung: konfigurierte ID, dann venue-agnostisches Fallback.
  const resolvedBenchmarkId = instruments
    ? (resolveBenchmarkId(benchmarkInstrumentId, instruments) ??
      benchmarkInstrumentId)
    : benchmarkInstrumentId;
  const benchmark = byInstrument.get(resolvedBenchmarkId) ?? null;
  return {
    candles: (instrument) => byInstrument.get(instrument.id) ?? [],
    // Das Benchmark-Instrument selbst erhält keine Benchmark-Reihe (sonst
    // wäre seine Korrelation 0 und der Diversifikations-Score fälschlich 1).
    benchmarkCandles: (instrument) =>
      instrument.id === resolvedBenchmarkId ? null : benchmark,
    // RMA-P2-02: Funding/Open Interest aus der kanonischen Quelle (bzw. deren
    // Artefakt). Ohne Karte ⇒ `undefined` ⇒ exakt das Verhalten vor v1.54.0.
    ...(derivatives ? { derivatives: (instrument) => derivatives.get(instrument.id) ?? null } : {}),
  };
}

/**
 * Wählt EINE Zeitreihe je Instrument (Timeframe-Präferenz
 * `1h → 4h → 30m → 15m → 5m`, dann andere bekannte Timeframes in
 * Store-Reihenfolge, zuletzt Legacy). O(n) über eine einzige Gruppierung.
 */
function pickTimeframe(
  rows: {
    timeframe: SupportedTimeframe | typeof LEGACY_UNKNOWN;
    candle: MarketCandle;
  }[],
): MarketCandle[] {
  const byTimeframe = new Map<
    SupportedTimeframe | typeof LEGACY_UNKNOWN,
    MarketCandle[]
  >();
  for (const row of rows) {
    const list = byTimeframe.get(row.timeframe) ?? [];
    list.push(row.candle);
    byTimeframe.set(row.timeframe, list);
  }
  for (const tf of TIMEFRAME_PREFERENCE) {
    const subset = byTimeframe.get(tf);
    if (subset && subset.length) return subset;
  }
  for (const [tf, subset] of byTimeframe) {
    if (tf !== LEGACY_UNKNOWN && subset.length) return subset;
  }
  return byTimeframe.get(LEGACY_UNKNOWN) ?? [];
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
  /**
   * Echte Fetch-/Infrastruktur-Fehler (MDERR-006). Default: das persistente
   * Manifest `data/market-data-errors.json` (vom Sync-Job geschrieben), damit
   * auch über Prozessgrenzen die Readiness `ERROR` wird.
   */
  dataErrors?: () => ReadonlyMap<string, string> | null;
  /** Instrumentenstand der Vorwoche (Weekly-Änderungssignale). */
  previousInstruments?: () => MarketInstrument[] | null;
  /** Vorheriger Weekly-Review. */
  previousReview?: () => WeeklyReview | null;
  /**
   * Derivate-Kontext je Instrument (RMA-P2-02): Funding-Rate/Raster und Open
   * Interest für die Derivate-Faktoren. Default: das Artefakt der Perp-Syncs
   * (`data/perpdata/derivatives.json`), gelesen nur bei `PERP_DATA_ENABLED`
   * und nur innerhalb der Staleness-Grenze — sonst `null`, und die Faktoren
   * bleiben bei ihrem Neutralwert. Ein injizierter `data`-Provider trägt den
   * Kontext selbst; diese Quelle gilt dann nicht zusätzlich.
   */
  derivatives?: () => ReadonlyMap<string, DerivativeContext> | null;
  /**
   * Maximales Cache-Alter des Scan-Ergebnisses in ms (Default
   * {@link DEFAULT_SCAN_CACHE_TTL_MS} = 5 Minuten; `0` = keine Cache-Wieder-
   * verwendung, jede Abfrage rechnet neu). Die Uhr stammt aus `now`
   * (injizierbar) — der Service greift nie auf die statische Wanduhr zu.
   */
  cacheTtlMs?: number;
  /**
   * Cross-Sectional-Momentum-Kontext je Instrument (RMA-P2-04, v1.63.0).
   * Default: das jüngste Cross-Sectional-Artefakt (Staleness-begrenzt).
   * `() => null` deaktiviert den Faktor explizit (Tests/Rollback).
   */
  crossSectional?: () => ReadonlyMap<string, CrossSectionalRankContext> | null;
}

/** Hält Scan-Ergebnis und Weekly-Review für die API bereit. */
export class ScannerService {
  private scan: ScanResult | null = null;
  private scannedAt = 0;
  private weekly: WeeklyReview | null = null;
  /** Letzte bekannte mtimes der Runtime-Dateien — erkennt Cross-Prozess-Writes
   *  (CLI `market:sync` schreibt, Next.js liest) ohne auf die 5-Minuten-TTL
   *  warten zu müssen. Vorher zeigte die UI nach einem erfolgreichen Sync
   *  weiter den alten WARMING-Zustand.
   */
  private lastRegistryMtime = 0;
  private lastHistoryMtime = 0;
  private readonly options: ScannerServiceOptions;

  constructor(options: ScannerServiceOptions = {}) {
    this.options = options;
  }

  /**
   * Aktuelles Scan-Ergebnis. Rechnet beim ersten Zugriff und erneut, sobald
   * das zwischengespeicherte Ergebnis älter als `SCANNER_CACHE_TTL_MS` ist
   * (Default 5 Minuten) — so spiegelt die API nach einem CLI-/Job-Sync ohne
   * Prozessneustart den neuen Datenstand wider. Ein laufender Scan im
   * langlebigen Web-Prozess darf nicht ewig den alten (leeren) Trichter
   * zeigen.
   */
  getScan(): ScanResult {
    const ttl = this.options.cacheTtlMs ?? DEFAULT_SCAN_CACHE_TTL_MS;
    // `ttl === 0` schaltet den Cache komplett aus (jede Abfrage rechnet neu);
    // sonst gilt das eingestellte Höchstalter an der injizierten Uhr.
    const cacheDisabled = ttl === 0;
    const staleByInjectedClock =
      ttl > 0 && this.clockNow() - this.scannedAt >= ttl;
    // Cross-Prozess-Invalidierung: Hat ein paralleler `market:sync`-Lauf die
    // Registry- oder History-Datei seit dem letzten Scan verändert, ist der
    // Cache sofort veraltet — nicht erst nach 5 Minuten. Beide Dateien werden
    // über `resolveRuntimePath` aufgelöst (identisch zu ihren Stores).
    let staleByFileChange = false;
    if (this.scan) {
      const regMtime = fileMtimeMs("data/instruments.ndjson");
      const histMtime = fileMtimeMs("data/history/candles.ndjson");
      if (regMtime !== this.lastRegistryMtime || histMtime !== this.lastHistoryMtime) {
        staleByFileChange = true;
      }
    }
    if (!this.scan || cacheDisabled || staleByInjectedClock || staleByFileChange) {
      this.refresh();
    }
    return this.scan as ScanResult;
  }

  /**
   * Zeitbasis des Services aus der injizierbaren Uhr (Default `new Date()`,
   * nie die statische Wanduhr — der Architekturtest erzwingt injizierten Zeitbezug).
   */
  private clockNow(): number {
    return (this.options.now ?? (() => new Date()))().getTime();
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

  /**
   * Cross-Sectional-Momentum-Kontext für den aktuellen Lauf (RMA-P2-04,
   * v1.63.0): injizierte Quelle, sonst das **Artefakt** des
   * Cross-Sectional-Laufs (`artifacts/cross-sectional/...`, as-of-gelesen,
   * Staleness-begrenzt über `maxSnapshotAgeMs` der Cross-Sectional-Config).
   *
   * Fail-closed und fail-soft zugleich: Feature-Flag aus, kein Artefakt oder
   * stale Artefakt ⇒ `null` ⇒ der Faktor meldet explizit `unavailable`
   * (Neutralwert 0.5 — ein fehlender Rang geht nie still als 0-Momentum ein).
   * Der Scan bricht daran NIEMALS ab (reiner Zusatz-Lesepfad).
   */
  private crossSectionalForScan(): ReadonlyMap<string, CrossSectionalRankContext> | null {
    if (this.options.crossSectional) {
      return this.options.crossSectional() ?? null;
    }
    if (!isCrossSectionalEnabled()) return null;
    let snapshot;
    try {
      const cfg = loadCrossSectionalConfig();
      snapshot = loadLatestCrossSectionalArtifact({
        nowMs: this.clockNow(),
        maxAgeMs: cfg.maxSnapshotAgeMs,
      });
    } catch {
      return null; // Lese-/Validierungsfehler ⇒ Faktor unavailable (nie Score-0)
    }
    if (!snapshot) return null;
    const map = new Map<string, CrossSectionalRankContext>();
    for (const member of snapshot.members) {
      if (member.status !== "RANKED") continue;
      const ctx = rankContextOf(snapshot, member.instrumentId);
      if (ctx) map.set(member.instrumentId, ctx);
    }
    return map.size > 0 ? map : null;
  }

  /**
   * Derivate-Kontext für den aktuellen Lauf: injizierte Quelle, sonst das
   * Sync-Artefakt (as-of-gelesen, Staleness-begrenzt). `null` ⇒ Provider kennt
   * keinen Derivatetzweig ⇒ Factor-Neutralität (kein `0`).
   */
  private derivativesForScan(): ReadonlyMap<string, DerivativeContext> | null {
    if (this.options.derivatives) return this.options.derivatives() ?? null;
    const perpConfig = loadPerpConfig();
    const loaded = perpDerivativeContextsFromCache({
      nowMs: this.clockNow(),
      maxAgeMs: perpConfig.maxStaleMs.funding,
    });
    return loaded.map;
  }

  /** Score-Breakdown eines Instruments (`null`, wenn unbekannt). */
  scoreFor(instrumentId: string) {
    return this.getScan().byId.get(instrumentId) ?? null;
  }

  /**
   * Rechnet neu (z. B. nach einem Discovery-/Sync-Lauf) und liefert das
   * Ergebnis.
   *
   * @param asOf Optionaler, expliziter Auswertungszeitpunkt (injizierte Uhr
   *   der Tageszyklen). Ohne Angabe gilt die konfigurierte Service-Uhr.
   */
  refresh(asOf?: number | Date | string): ScanResult {
    const config = this.options.config ?? loadScannerConfig();
    const instruments = this.currentInstruments();
    const crossSectional = this.crossSectionalForScan();
    const data =
      this.options.data ??
      // Instrumente werden für die venue-agnostische Benchmark-Auflösung
      // mitgereicht (sonst bleibt der Korrelationsfaktor bei Venue-Umstellungen
      // dauerhaft „unbekannt“).
      {
        ...historicalStoreProvider(
          new HistoricalStore(),
          config.factors.correlation.benchmarkInstrumentId,
          instruments,
          this.derivativesForScan()
        ),
        // v1.63.0 (RMA-P2-04): Cross-Sectional-Rang (additiv; ohne Karte ⇒
        // Faktor meldet `unavailable` — exakt das Verhalten vor v1.63.0).
        ...(crossSectional ? { crossSectional: (instrument: MarketInstrument) => crossSectional.get(instrument.id) ?? null } : {}),
      };
    const now = this.options.now ?? (() => new Date());
    const effectiveNow = asOf ?? now();
    // MDERR-006: Datenfehler-Manifest (Sync-Prozess) → Readiness ERROR statt
    // stiller min-candles-Aussortierung. (Eigene Kopie: die injizierte
    // `dataErrors`-Funktion darf den aufrufenden Zustand nicht mutieren.)
    const dataErrors = new Map(
      this.options.dataErrors?.() ?? loadMarketDataErrors(),
    );
    // GAP-07 (strict-Modus): Instrumente mit INVALID-Befunden im
    // Qualitäts-Report zählen wie DATA_UNAVAILABLE (existierende
    // Stale-Fallback-Kette). `log` (Default) liefert leer.
    for (const [id, reason] of qualityStrictDataErrorsForScan()) {
      if (!dataErrors.has(id)) dataErrors.set(id, reason);
    }
    this.scan = scanUniverse({
      instruments,
      data,
      asOf: effectiveNow,
      config,
      // Daten-Scope: Seed-Instrumente auf Venues ohne laufenden Sync
      // (Presets ALPACA/IBKR/BINANCE) blockieren den READY-Zustand der
      // tatsächlich versorgten Venue nicht.
      readinessScopeVenues: "data",
      ...(dataErrors.size > 0 ? { dataErrors } : {}),
    });
    // Cache-Alter wird an der Service-Uhr gemessen (Wandzeit der Berechnung),
    // NICHT am fachlichen `asOf` — ein nachdatierter Zyklus-Schritt darf den
    // Cache nicht als „abgelaufen“ markieren.
    this.scannedAt = this.clockNow();
    this.weekly = null;
    // Merke die mtimes der Runtime-Dateien zum Zeitpunkt des frischen Scans,
    // damit der nächste `getScan()`-Aufruf eine Cross-Prozess-Änderung erkennt.
    this.lastRegistryMtime = fileMtimeMs("data/instruments.ndjson");
    this.lastHistoryMtime = fileMtimeMs("data/history/candles.ndjson");
    return this.scan;
  }

  private currentInstruments(): MarketInstrument[] {
    return this.options.instruments
      ? this.options.instruments()
      : loadAllInstruments();
  }
}

const GLOBAL = globalThis as typeof globalThis & {
  __scannerService?: ScannerService;
};

/** Prozessweite Service-Instanz (HMR-stabil). */
export function getScannerService(): ScannerService {
  if (!GLOBAL.__scannerService) GLOBAL.__scannerService = new ScannerService();
  return GLOBAL.__scannerService;
}

/** Nur für Tests: Service ersetzen oder verwerfen. */
export function setScannerServiceForTests(
  service: ScannerService | null,
): void {
  if (service) GLOBAL.__scannerService = service;
  else delete GLOBAL.__scannerService;
}

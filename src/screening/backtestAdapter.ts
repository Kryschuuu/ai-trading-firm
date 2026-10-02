/**
 * STX-05-04 — Backtest-Job-Adapter: Engine-Pfad für eine Screening-Zelle.
 *
 * ── Warum dieses Modul existiert ──────────────────────────────────────────
 * `runScreening()` (Runner) kennt keine Engine. Dieser Adapter ist die
 * **Produktiv-Verdrahtung** des injizierten `ScreeningBacktestPort` — und
 * deshalb auch die Stelle, an der die Pfad-Entscheidung aus 00-01 physisch
 * sichtbar wird: {@link SCREENING_BACKTEST_PATH} = `multiAsset`.
 *
 * Die Entscheidung ist **nicht** neu zu treffen. Gemessen in
 * [`BENCH-BASELINE.md`](../../docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
 * §6 (Prompt 00-01, Finding STX-12) an 17 520 echten Stundenkerzen:
 *
 * | Pfad | Exponent | je Zelle | 7 500 Zellen seriell |
 * |---|---:|---:|---:|
 * | `backtestRule()` | 1,99 (O(n²)) | 25 986 ms | 54,14 Kernstunden |
 * | `runMultiAssetBacktest()` | 1,01 (O(n)) | 213,5 ms | **0,44 Kernstunden** |
 *
 * Der Engine-Pfad ist **121,7×** schneller und linear. Der Adapter ruft
 * deshalb ausschließlich `runMultiAssetBacktest()`; `backtestRule()` wird
 * **nicht** angefasst (STX-12 ist ein eigener Prompt mit Paritätstest).
 *
 * ── Was der Adapter tut ───────────────────────────────────────────────────
 * 1. **PIT-Kerzen lesen:** genau eine Reihe (Instrument × Timeframe), nur
 *    Kerzen mit `ts ≤ asOf` (Lookahead-Verbot), hart begrenzt auf
 *    {@link SCREENING_MAX_CANDLES_PER_CELL} Bars (Kostenbremse). Die Kerzen
 *    werden je Reihe **einmal** gelesen und im Prozess gecacht: der
 *    HistoricalStore liest pro `query()` die ganze Datei neu, 50 Zellen
 *    dürfen nicht 50 Dateilese kosten.
 * 2. **Regel kompilieren:** über `compileTemplate()` — den einzigen Pfad, der
 *    `buildRule()` aufruft und das Ergebnis durch `sanitizeRuleSpec()` zwingt
 *    (STX-05/03-09). Kein zweiter Sanitize-Aufrufer.
 * 3. **Engine laufen lassen:** `executionModel: "legacy"` — derselbe
 *    byte-kompatible Pfad, auf dem die Baseline gemessen wurde. Ein anderer
 *    Modus wäre ein anderer Vergleichsmaßstab.
 * 4. **Metriken berichten:** eine **geschlossene** Kennzahlenmenge plus
 *    Provenienz (Pfad, Caps, Fenster). Keine Trade-Liste, keine Equity-Kurve
 *    in der Zelle — beides wäre ein ungebundenes JSONB-Wachstum in
 *    `strategy_market_results.metrics`.
 * 5. **Größe melden:** `counts` (Bars/Trades/Equity-Punkte) ist die Wahrheit
 *    für die Caps-Prüfung des Runners. Der Adapter kappt nichts.
 *
 * ── Persistenz nach `backtest_runs` ───────────────────────────────────────
 * Bewusst **nicht** Teil von 05-04: `persistBacktestRun()` erwartet einen
 * `WalkForwardReport` (Fenster, Selektion, Ledger-Abgleich). Einen solchen
 * Report aus einem Einzelzellen-Engine-Lauf zu bauen, wäre eine zweite
 * Wahrheit über Läufe — und Veränderungen an `runMultiAssetBacktest`/`backtestRule`
 * sind für diesen Prompt gesperrt. `backtest_run_id` bleibt deshalb `null`,
 * bis ein eigener Prompt den Persistenzpfad des Engine-Pfads liefert; die
 * Naht ist als optionaler `persist`-Hook injizierbar. Die Zelle bleibt ohne
 * Link gültig (der FK ist nullable, 05-03).
 */

import { runMultiAssetBacktest } from "@/backtest/engine";
import type { BacktestEngineOptions, BacktestMetrics } from "@/backtest/types";
import { HistoricalStore, type SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { CandleLike } from "@/lib/ruleEngine";
import { RULE_BACKTEST_EQUITY_CAP, RULE_BACKTEST_MIN_BARS, RULE_BACKTEST_TRADE_CAP } from "@/lib/ruleBacktest";
import { compileTemplate } from "@/strategies/compiler";
import { getTemplate } from "@/strategies/catalog";
import {
  SCREENING_BACKTEST_PATH,
  type ScreeningBacktestCounts,
  type ScreeningBacktestOutcome,
  type ScreeningBacktestPort,
  type ScreeningBacktestRequest,
} from "./runner";
import type { StrategyMarketCandidate } from "./types";

/**
 * Harte Obergrenze der Kerzen je Zelle. Sie ist eine **Kostenbremse**, kein
 * Fachparameter: 20 000 Stundenkerzen sind ≈ 2,3 Jahre und kosten nach der
 * Baseline ≈ 245 ms Engine-Zeit. Wer mehr braucht, braucht einen eigenen
 * Auftrag — nicht eine größere Zelle.
 */
export const SCREENING_MAX_CANDLES_PER_CELL = 20_000;

/**
 * Geschlossene Kennzahlenmenge einer Zelle. Alles, was hier **nicht** steht,
 * wird nicht persistiert: `metrics` ist JSONB in einer Zeile, die zu jeder
 * Zelle der Matrix gehört — eine Trade-Liste je Zelle wäre ungebundenes
 * Wachstum. `null` bedeutet „unbekannt“ (nie 0).
 */
export const SCREENING_CELL_METRIC_KEYS = [
  "totalReturnPct",
  "sharpeRatio",
  "sortinoRatio",
  "calmarRatio",
  "maxDrawdownPct",
  "winRate",
  "profitFactor",
  "expectancy",
  "exposureTimePct",
  "totalTrades",
  "winningTrades",
  "losingTrades",
  "averageHoldingBars",
  "totalFeesPaid",
  "endingEquity",
] as const;

/** Venue-natives Symbol einer kanonischen Instrument-ID (`VENUE:SYMBOL`). */
export function nativeSymbolOfInstrument(instrumentId: string): string {
  const at = instrumentId.indexOf(":");
  return at >= 0 ? instrumentId.slice(at + 1) : instrumentId;
}

/** Nur endliche Zahlen sind persistierbar; `NaN`/`∞` ⇒ `null` (nie still 0). */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Optionen des Adapters. */
export interface MultiAssetBacktestPortOptions {
  /** Kerzenquelle (Default: `new HistoricalStore()`). */
  store?: Pick<HistoricalStore, "query">;
  /** Engine-Overrides je Zelle (Default: keine). */
  engineConfig?: (cell: StrategyMarketCandidate) => BacktestEngineOptions | undefined;
  /** Harte Kerzenobergrenze je Zelle (Default {@link SCREENING_MAX_CANDLES_PER_CELL}). */
  maxCandlesPerCell?: number;
  /** Code-Version im Regel-Fingerprint (Default `APP_VERSION`). */
  codeVersion?: string;
  /**
   * Optionaler Persistenz-Hook nach `backtest_runs`. Default: keiner — siehe
   * Modulkopf. Die Naht ist injizierbar, damit ein späterer Prompt den
   * Engine-Pfad persistieren kann, ohne diesen Adapter zu ändern.
   */
  persist?: (args: {
    cell: StrategyMarketCandidate;
    spec: import("@/lib/ruleEngine").RuleSpec;
    candles: readonly CandleLike[];
    metrics: BacktestMetrics;
  }) => Promise<string | null>;
}

/**
 * Erzeugt den Produktiv-Backtest-Port für {@link runScreening}.
 *
 * Rein injizierbar: `store` ist ein `Pick<HistoricalStore, "query">`, damit
 * Tests eine Kerzen-Fixture liefern können, ohne eine Datei zu schreiben.
 */
export function createMultiAssetBacktestPort(
  options: MultiAssetBacktestPortOptions = {},
): ScreeningBacktestPort {
  const store = options.store ?? new HistoricalStore();
  const maxCandles = Math.max(
    RULE_BACKTEST_MIN_BARS,
    Math.floor(options.maxCandlesPerCell ?? SCREENING_MAX_CANDLES_PER_CELL),
  );
  const codeVersion = options.codeVersion;
  // Kerzen-Cache je Reihe: EIN Dateilesen je (Instrument, Timeframe) statt
  // eines je Zelle. Der Store liest pro query() die ganze Datei neu.
  const candleCache = new Map<string, CandleLike[]>();

  return {
    async run(request: ScreeningBacktestRequest): Promise<ScreeningBacktestOutcome> {
      const { cell, asOf } = request;
      const asOfMs = Date.parse(asOf);
      const timeframe: SupportedTimeframe = cell.timeframe;

      // 1) PIT-Kerzen: nur Kerzen mit ts ≤ Cutoff, letzte `maxCandles`.
      const cacheKey = `${cell.instrumentId}|${timeframe}|${asOfMs}|${maxCandles}`;
      let candles: CandleLike[] | undefined = candleCache.get(cacheKey);
      if (candles === undefined) {
        const entries = store.query({
          instrumentId: cell.instrumentId,
          timeframe,
          ...(Number.isFinite(asOfMs) ? { to: asOfMs } : {}),
          limit: maxCandles,
        });
        candles = entries.map((e) => ({
          time: e.ts,
          open: e.open,
          high: e.high,
          low: e.low,
          close: e.close,
          volume: e.volume,
        }));
        candleCache.set(cacheKey, candles);
      }

      if (candles.length < RULE_BACKTEST_MIN_BARS) {
        // fail-closed: der Lauf hat nicht stattgefunden. Der Runner macht
        // daraus eine an `min_bars` gescheiterte Zelle — kein gekapptes
        // Ergebnis, keine erfundene Metrik.
        return {
          backtestRunId: null,
          metrics: null,
          counts: { bars: candles.length, trades: null, equityPoints: null },
          error: "candles:too-few",
        };
      }

      // 2) Regel kompilieren — über den einzigen Sanitize-Pfad des Repos.
      const template = getTemplate(cell.templateId);
      if (!template) {
        return {
          backtestRunId: null,
          metrics: null,
          counts: { bars: candles.length, trades: null, equityPoints: null },
          error: "template:unknown",
        };
      }
      const compiled = compileTemplate({
        templateId: cell.templateId,
        symbol: nativeSymbolOfInstrument(cell.instrumentId),
        timeframe,
        ...(codeVersion ? { codeVersion } : {}),
      });
      if (!compiled.ok) {
        return {
          backtestRunId: null,
          metrics: null,
          counts: { bars: candles.length, trades: null, equityPoints: null },
          error: "compile:failed",
        };
      }

      // 3) Engine-Pfad (00-01): linear, byte-kompatibel zum Messaufbau.
      const config: BacktestEngineOptions = {
        timeframe,
        from: candles[0].time,
        to: candles[candles.length - 1].time,
        // Byte-kompatibler Task-02-Simulator — derselbe Pfad wie in der
        // Baseline (GAP-01). Kein `paper`-Overlay: das wäre ein anderer Maßstab.
        executionModel: "legacy",
        ...(options.engineConfig?.(cell) ?? {}),
      };
      const result = runMultiAssetBacktest({
        candlesBySymbol: new Map([[cell.instrumentId, candles]]),
        strategies: [{ type: "rule", spec: compiled.spec, id: cell.templateId }],
        config,
      });

      const counts: ScreeningBacktestCounts = {
        bars: result.barsProcessed,
        trades: result.trades.length,
        equityPoints: result.equityCurve.length,
      };

      // 4) Geschlossene Kennzahlenmenge + Provenienz.
      const metrics: Record<string, unknown> = {
        backtestPath: SCREENING_BACKTEST_PATH,
        timeframe: cell.timeframe,
        from: new Date(result.from).toISOString(),
        to: new Date(result.to).toISOString(),
        bars: counts.bars,
        trades: counts.trades,
        equityPoints: counts.equityPoints,
        caps: {
          minBars: RULE_BACKTEST_MIN_BARS,
          tradeCap: RULE_BACKTEST_TRADE_CAP,
          equityCap: RULE_BACKTEST_EQUITY_CAP,
        },
      };
      const m = result.metrics as unknown as Record<string, unknown>;
      for (const key of SCREENING_CELL_METRIC_KEYS) {
        metrics[key] = finiteOrNull(m[key] as number | null | undefined);
      }

      // 5) Optionaler Persistenz-Hook (Default: keiner, siehe Modulkopf).
      let backtestRunId: string | null = null;
      if (options.persist) {
        try {
          backtestRunId = await options.persist({
            cell,
            spec: compiled.spec,
            candles,
            metrics: result.metrics,
          });
        } catch {
          backtestRunId = null;
        }
      }

      return { backtestRunId, metrics, counts };
    },
  };
}

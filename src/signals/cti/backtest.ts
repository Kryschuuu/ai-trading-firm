/**
 * Claude Trading Indicator (CTI) — Anbindung an die Multi-Asset-Backtest-Engine.
 *
 * Diese Datei übersetzt CTI-Signale in `BacktestSignalDecision`s und fügt
 * **nichts** hinzu, was das Skript nicht hergibt:
 *
 *   | CTI                      | Backtest                                        |
 *   | ------------------------ | ----------------------------------------------- |
 *   | `BUY`                    | Long zum Schlusskurs des Signalbars              |
 *   | `SELL` (Shorts erlaubt)  | Short zum Schlusskurs des Signalbars             |
 *   | `SELL` (Long-only)       | `FLAT` — offene Long-Position wird glattgestellt |
 *   | `activeLongStop`         | absoluter Stop-Preis der Position                |
 *   | kein Kursziel im Skript  | `takeProfit = null` (Default)                    |
 *   | Umkehrsignal             | `SIGNAL_EXIT` der Gegenposition, dann Drehung    |
 *
 * ── Warum das kein Look-ahead sein KANN ────────────────────────────────────
 * Die Strategie bekommt von der Engine ausschließlich die gerade
 * geschlossene Kerze (`BacktestSignalBar.candle`) und reicht sie in den
 * {@link CtiRuntime} weiter. Sie hat keinen Zugriff auf die Kerzenreihe und
 * damit keine Möglichkeit, in die Zukunft zu sehen — unabhängig davon, was
 * sie rechnet. Der Einstieg erfolgt zum Schlusskurs DIESES Bars, also genau
 * zu dem Zeitpunkt, an dem auch der Chart das Dreieck zeichnet.
 *
 * ── Ausstiege ──────────────────────────────────────────────────────────────
 * Das Skript kennt genau einen Ausstieg: den ATR-Stop (`STOP_LOSS`, von der
 * Engine gegen `low`/`high` der Folgekerzen geprüft). Dazu kommt der
 * Umkehr-Ausstieg (`SIGNAL_EXIT`), weil eine Gegenposition sonst beide
 * Richtungen gleichzeitig hielte. Ein Kursziel gibt es nur, wenn der
 * Aufrufer `takeProfitRR` setzt — dann ist es ein Vielfaches der
 * Stop-Distanz und als Abweichung vom Original gekennzeichnet.
 *
 * Der Stop der Einstiegskerze wird bewusst erst ab der FOLGEKERZE geprüft:
 * Die Position existiert erst ab deren Schlusskurs. Der Indikator markiert
 * `stopHit` dagegen schon auf dem Signalbar (dort endet die gezeichnete
 * Linie) — ein Darstellungsdetail, kein Handelsereignis.
 */

import {
  DEFAULT_BACKTEST_CONFIG,
  runMultiAssetBacktest,
  type BacktestEngineOptions,
  type BacktestSignalBar,
  type BacktestSignalDecision,
  type BacktestSignalStrategy,
  type BacktestStrategyItem,
  type MultiAssetBacktestResult,
  type MultiAssetCandleMap,
} from "../../backtest";
import { ctiWarmupBars, resolveCtiParams, type CtiParams } from "./params";
import { CtiRuntime } from "./runtime";
import type { CtiBar } from "./types";

/** Optionen der CTI-Backtest-Strategie. */
export interface CtiStrategyOptions {
  /** Teilmenge der CTI-Parameter (wird geklemmt, siehe `resolveCtiParams`). */
  params?: Partial<CtiParams> | null;
  /**
   * Risikobudget je Einstieg als Anteil des Eigenkapitals. Default: der
   * Engine-Wert (`config.maxRiskPerTrade`), weil der CTI selbst keine
   * Positionsgröße kennt.
   */
  riskBudgetPct?: number;
  /** Positionsdeckel je Einstieg (Default: `config.maxPositionPct`). */
  maxPositionPct?: number;
  /**
   * Kursziel als Vielfaches der Stop-Distanz (z. B. 2 = 2R).
   * **Default `null` = kein Ziel** — das Skript definiert keines; ein Ziel
   * ist eine bewusste Abweichung des Aufrufers.
   */
  takeProfitRR?: number | null;
  /**
   * `SELL` als Short handeln (Default `true`). `false` macht aus dem
   * Verkaufssignal ein reines Glattstellen (Long-only-Betrieb, z. B. Spot).
   * Unabhängig davon muss der Lauf Shorts erlauben
   * (`BacktestEngineConfig.enableShorts`), sonst stuft die Engine jeden
   * Short selbst auf `FLAT` herab.
   */
  tradeShorts?: boolean;
  /** Gegenposition bei Umkehrsignal glattstellen (Default `true`). */
  closeOpposite?: boolean;
  /** Eigene Strategie-ID (Default `cti:<symbol>`). */
  id?: string;
}

/** CTI-Strategie mit Zugriff auf ihren Zustand (Diagnose nach dem Lauf). */
export interface CtiSignalStrategy extends BacktestSignalStrategy {
  /** Die geklemmten Parameter dieses Laufs. */
  readonly params: Readonly<CtiParams>;
  /** Der Automat — nach dem Lauf: letzter Bar, Streaks, Stops. */
  readonly runtime: CtiRuntime;
  /** Alle Bars mit Signal (unabhängig davon, ob sie zu einem Trade wurden). */
  readonly signalBars: readonly CtiBar[];
}

/**
 * Baut eine CTI-Strategie für ein Symbol.
 *
 * Der Rückgabewert hält den Automaten; dasselbe Objekt darf nur EINMAL in
 * einem Lauf verwendet werden (ein zweiter Lauf würde auf dem Zustand des
 * ersten aufsetzen). `runCtiBacktest` erzeugt die Strategien deshalb selbst.
 */
export function createCtiSignalStrategy(
  symbol: string,
  options: CtiStrategyOptions = {},
): CtiSignalStrategy {
  const resolved = resolveCtiParams(options.params ?? null);
  const runtime = new CtiRuntime(resolved.params);
  const tradeShorts = options.tradeShorts !== false;
  const closeOpposite = options.closeOpposite !== false;
  const takeProfitRR =
    typeof options.takeProfitRR === "number" && Number.isFinite(options.takeProfitRR) && options.takeProfitRR > 0
      ? options.takeProfitRR
      : null;
  const signalBars: CtiBar[] = [];

  const strategy: CtiSignalStrategy = {
    id: options.id ?? `cti:${symbol}`,
    symbol,
    params: resolved.params,
    runtime,
    signalBars,
    onBar(bar: BacktestSignalBar): BacktestSignalDecision | null {
      // Jede Kerze in den Automaten — auch im Warmup (Zustandsaufbau).
      const evaluated = runtime.push({
        time: bar.candle.time,
        high: bar.candle.high,
        low: bar.candle.low,
        close: bar.candle.close,
        volume: bar.candle.volume,
      });
      if (evaluated.signal === null) return null;
      signalBars.push(evaluated);
      // Warmup-Signale verwirft die Engine ohnehin; wir melden sie gar nicht
      // erst, damit `signalBars` und ausgeführte Trades dieselbe Zeitachse
      // haben.
      if (bar.warmup) return null;

      if (evaluated.signal === "BUY") {
        const stopLoss = evaluated.activeLongStop;
        return {
          side: "LONG",
          stopLoss,
          takeProfit: projectTarget("LONG", evaluated.close, stopLoss, takeProfitRR),
          riskBudgetPct: options.riskBudgetPct,
          maxPositionPct: options.maxPositionPct,
          closeOpposite,
        };
      }

      if (!tradeShorts) {
        // Long-only: Das Verkaufssignal beendet die Long-Position, eröffnet
        // aber nichts (kein stilles Short).
        return { side: "FLAT", stopLoss: null, takeProfit: null, closeOpposite };
      }
      const stopLoss = evaluated.activeShortStop;
      return {
        side: "SHORT",
        stopLoss,
        takeProfit: projectTarget("SHORT", evaluated.close, stopLoss, takeProfitRR),
        riskBudgetPct: options.riskBudgetPct,
        maxPositionPct: options.maxPositionPct,
        closeOpposite,
      };
    },
  };
  return strategy;
}

/** Kursziel als Vielfaches der Stop-Distanz (`null` = Original ohne Ziel). */
function projectTarget(
  side: "LONG" | "SHORT",
  entry: number,
  stopLoss: number | null,
  takeProfitRR: number | null,
): number | null {
  if (takeProfitRR === null || stopLoss === null) return null;
  const distance = Math.abs(entry - stopLoss);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const target = side === "LONG" ? entry + distance * takeProfitRR : entry - distance * takeProfitRR;
  return Number.isFinite(target) && target > 0 ? target : null;
}

/** Strategie-Eintrag für `runMultiAssetBacktest({ strategies: [...] })`. */
export function ctiStrategyItem(
  symbol: string,
  options: CtiStrategyOptions = {},
): BacktestStrategyItem & { signal: CtiSignalStrategy } {
  const signal = createCtiSignalStrategy(symbol, options);
  return { type: "signal", signal, id: signal.id };
}

/** Eingabe von {@link runCtiBacktest}. */
export interface RunCtiBacktestInput {
  /** Kerzen je Symbol (dieselbe Map wie bei `runMultiAssetBacktest`). */
  candlesBySymbol: MultiAssetCandleMap;
  /** Optionen der CTI-Strategie (gelten für alle Symbole). */
  options?: CtiStrategyOptions;
  /** Engine-Konfiguration (Kosten, Kapital, Timeframe …). */
  config?: BacktestEngineOptions;
}

/** Signalzähler eines Symbols — Indikator-Sicht, unabhängig von Guardrails. */
export interface CtiSymbolSignalStats {
  buy: number;
  sell: number;
  /** Zeitstempel des letzten Signals (`null` = keines). */
  lastSignalAt: number | null;
  /** Letzter ausgewerteter Bar (Dashboard-Grundlage). */
  lastBar: CtiBar | null;
}

/** Ergebnis von {@link runCtiBacktest}. */
export interface CtiBacktestOutcome {
  /** Das unveränderte Engine-Ergebnis (Metriken, Trades, Equity-Kurve). */
  result: MultiAssetBacktestResult;
  /** Die tatsächlich verwendeten (geklemmten) CTI-Parameter. */
  params: Readonly<CtiParams>;
  /** Parameter, die geklemmt werden mussten (leer = Eingabe war gültig). */
  clamped: readonly string[];
  /** Verwendeter Warmup (Bars) — mindestens der Bedarf des Indikators. */
  warmupBars: number;
  /** Signal-Statistik je Symbol. */
  signals: Record<string, CtiSymbolSignalStats>;
}

/**
 * Führt einen CTI-Backtest über eine Kerzen-Map aus.
 *
 * Voreinstellungen (jede davon überschreibbar):
 *   - `warmupBars` ≥ {@link ctiWarmupBars} — vorher kann der Indikator
 *     prinzipbedingt kein Signal liefern (EMA 200!).
 *   - `enableShorts` folgt `options.tradeShorts` (Default `true`), weil das
 *     Skript symmetrisch BUY und SELL liefert.
 *   - `executionModel: "paper"` — derselbe Fill-Simulator wie der
 *     PaperBroker inklusive Funding; der eingefrorene Legacy-Pfad bleibt
 *     über `config.executionModel: "legacy"` erreichbar.
 *
 * Die zurückgegebene Signal-Statistik stammt aus dem Indikator, nicht aus
 * dem Portfolio: Wenn weniger Trades als Signale im Report stehen, hat ein
 * Guardrail (Cash-Puffer, `maxOpenPositions`, Short-Sperre) gegriffen —
 * diese Differenz soll sichtbar sein, nicht verschwinden.
 */
export function runCtiBacktest(input: RunCtiBacktestInput): CtiBacktestOutcome {
  const resolved = resolveCtiParams(input.options?.params ?? null);
  const warmupNeeded = ctiWarmupBars(resolved.params);
  const rawMap =
    input.candlesBySymbol instanceof Map
      ? input.candlesBySymbol
      : new Map(Object.entries(input.candlesBySymbol));
  const symbols = Array.from(rawMap.keys()).sort();

  const strategies = symbols.map((symbol) =>
    createCtiSignalStrategy(symbol, { ...input.options, params: resolved.params }),
  );

  const configuredWarmup = input.config?.warmupBars ?? DEFAULT_BACKTEST_CONFIG.warmupBars;
  const config: BacktestEngineOptions = {
    executionModel: "paper",
    enableShorts: input.options?.tradeShorts !== false,
    ...input.config,
    warmupBars: Math.max(configuredWarmup, warmupNeeded),
  };

  const result = runMultiAssetBacktest({
    candlesBySymbol: input.candlesBySymbol,
    strategies: strategies.map((signal) => ({ type: "signal" as const, signal, id: signal.id })),
    config,
  });

  const signals: Record<string, CtiSymbolSignalStats> = {};
  for (const strategy of strategies) {
    const bars = strategy.signalBars;
    const last = bars.length > 0 ? bars[bars.length - 1] : null;
    signals[strategy.symbol] = {
      buy: bars.filter((bar) => bar.signal === "BUY").length,
      sell: bars.filter((bar) => bar.signal === "SELL").length,
      lastSignalAt: last ? last.time : null,
      lastBar: strategy.runtime.last,
    };
  }

  return {
    result,
    params: resolved.params,
    clamped: resolved.clamped,
    warmupBars: config.warmupBars ?? warmupNeeded,
    signals,
  };
}

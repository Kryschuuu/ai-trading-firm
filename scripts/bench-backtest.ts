#!/usr/bin/env node
/**
 * Backtest-Performance-Benchmark (STX-00-01, v0.6.0; Folgemessung STX-08-04).
 *
 * Das Protokoll misst weiterhin dieselben drei Pfade und dieselbe echte
 * HistoricalStore-Reihe. Die Messung von 2026-09-29 friert den damaligen
 * O(n²)-Stand von `backtestRule()` ein; seit STX-08-04 nutzt dessen aktueller
 * Stand `buildIndicatorCache`/`snapshotFromCache` und ist O(n).
 *
 * Gemessen werden je Kerzenzahl n ∈ {1000, 5000, 17520}:
 *
 *   1. `rule`       — `backtestRule(spec, candles)` (Single-Rule mit einmaligem
 *                     Cache-Aufbau und Cache-Snapshot je Bar).
 *   2. `multiAsset` — `runMultiAssetBacktest(...)` mit derselben Regel
 *                     (nutzt intern `buildIndicatorCache`/`snapshotFromCache`).
 *   3. `cache`      — reine `buildIndicatorCache` + `snapshotFromCache`-Schleife
 *                     über alle Bars (Indikator-Pfad ohne Trading-Logik).
 *
 * Je (Pfad, n) wird `--repeat` mal gemessen (Default 3), berichtet werden
 * alle Rohwerte und der Median; zusätzlich `ms/1000 Kerzen` und der Exponent
 * eines log-log-Fits über die drei Messpunkte (Erwartung: ≈ 1 für alle drei
 * aktuellen Pfade). Abgeschlossen wird mit der „1 Zelle Matrix"-Rechnung:
 * 7.500 Zellen × Median-Laufzeit einer 1h-Zelle in Kernstunden seriell.
 *
 * Projektregeln, die dieses Skript einhält:
 *   - Messdaten kommen ausschließlich aus dem `HistoricalStore` (echte,
 *     gespeicherte Serie; keine synthetischen Random-Bars).
 *   - KEIN Netz, KEINE Datenbank: es wird kein `src/db`-Modul importiert und
 *     nichts nach `data/` außerhalb von `data/bench/` geschrieben.
 *
 * Aufruf:
 *   npm run bench:backtest -- --instrument=BINANCE:BTCUSDT [--timeframe=1h] \
 *     [--dir=data/history] [--sizes=1000,5000,17520] [--repeat=3] \
 *     [--execution-model=legacy] [--starting-equity=10000] [--warmup=30] \
 *     [--out-dir=data/bench] [--paths=rule,multiAsset,cache] [--no-write]
 *
 * Ergebnis-Artefakte: `data/bench/bench-<instrument>-<tf>.json` (Rohdaten) und
 * `.md` (Protokoll). Die auditierten Zahlen stehen in
 * docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md.
 */

import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  backtestRule,
  ruleSignature,
  sanitizeRuleSpec,
  type CandleLike,
  type RuleSpec,
} from "../src/lib/ruleEngine";
import { buildIndicatorCache, snapshotFromCache } from "../src/backtest/indicatorCache";
import { runMultiAssetBacktest } from "../src/backtest/engine";
import {
  HistoricalStore,
  isSupportedTimeframe,
  SUPPORTED_TIMEFRAMES,
  SUPPORTED_TIMEFRAME_MS,
  type HistoricalCandleEntry,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import { joinRuntimePath, resolveRuntimePath } from "../src/lib/appPaths";

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten & Vertrag
// ─────────────────────────────────────────────────────────────────────────────

/** Messpunkte des Protokolls (Prompt 00-01): 1k / 5k / 2 Jahre 1h. */
export const BENCH_SIZES = [1_000, 5_000, 17_520] as const;

/** Matrix-Größe aus Prompt 05-04 (Strategie × Markt × Timeframe). */
export const MATRIX_CELLS = 7_500;

/** Zellgröße der Matrix-Rechnung: 17 520 Kerzen = 2 Jahre Stundenkerzen. */
export const MATRIX_CELL_CANDLES = 17_520;

/** Realistische Ziel-Teilmenge für einen Pilotlauf (Gate G6 der Roadmap). */
export const PILOT_CELLS = 50;

export const BENCH_PATHS = ["rule", "multiAsset", "cache"] as const;
export type BenchPath = (typeof BENCH_PATHS)[number];

export const BENCH_PATH_LABELS: Record<BenchPath, string> = {
  rule: "backtestRule (Single-Rule, Indicator-Cache, O(n))",
  multiAsset: "runMultiAssetBacktest (Engine, Indikator-Cache)",
  cache: "buildIndicatorCache + snapshotFromCache (reiner Indikator-Pfad)",
};

export interface BenchPathResult {
  /** Median der Wiederholungen in ms. */
  medianMs: number;
  /** Alle Rohwerte in Messreihenfolge (ms). */
  rawMs: number[];
  minMs: number;
  maxMs: number;
  /** Median normiert auf 1000 Kerzen. */
  msPer1000Bars: number;
}

export interface BenchPoint {
  /** Kerzenzahl des Messpunkts. */
  n: number;
  paths: Record<BenchPath, BenchPathResult>;
  /** Pfad-spezifische Belegwerte, dass tatsächlich gerechnet wurde. */
  detail: {
    rule?: { signals: number; trades: number; bars: number };
    multiAsset?: { trades: number; barsProcessed: number };
    cache?: { snapshots: number; bars: number };
  };
}

export interface BenchReport {
  generatedAt: string;
  /** Umgebung (deterministisch dokumentiert, damit Zahlen einordenbar sind). */
  environment: {
    node: string;
    platform: string;
    cpuModel: string;
    cpuCount: number;
  };
  source: {
    /** Store-Verzeichnis (relativ zum Projektstamm, sofern darunter). */
    dir: string;
    file: string;
    instrumentId: string;
    timeframe: SupportedTimeframe;
    /** SHA-256 über die gemessene Kerzenfolge (Provenienz der Messdaten). */
    seriesSha256: string;
    availableBars: number;
    window: { from: number; to: number };
    /** Kerzen mit Zeitlücke ≠ Timeframe (Datenqualität der Messreihe). */
    gapCount: number;
    maxGapMs: number;
  };
  rule: { name: string; symbol: string; signature: string };
  config: {
    sizes: number[];
    repeats: number;
    /** Ungemessene Warmläufe je (Pfad, n) vor den Messungen. */
    warmupRuns: number;
    executionModel: string;
    startingEquity: number;
    warmup: number;
    volumeWindow: number;
  };
  points: BenchPoint[];
  /** Log-log-Fit je Pfad: Steigung ≈ Komplexitäts-Exponent. */
  exponents: Record<BenchPath, number | null>;
  comparison: {
    /** Faktor `rule` / `multiAsset` (≥ 1 ⇒ Engine ist schneller). */
    speedupMultiAsset: number | null;
    speedupCache: number | null;
  };
  matrix: {
    cells: number;
    cellCandles: number;
    pilotCells: number;
    perPath: Record<BenchPath, { cellMs: number; coreHours: number; pilotCoreHours: number }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helfer (testbar ohne Store, ohne Laufzeitmessung)
// ─────────────────────────────────────────────────────────────────────────────

/** Median einer Zahlenfolge; wirft bei leerer Eingabe (kein stiller 0-Wert). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median() braucht mindestens einen Wert.");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Exponent eines log-log-Fits (kleinste Quadrate) über (n, Laufzeit)-Punkte:
 *   log(t) = exponent · log(n) + c   ⇒   exponent ≈ Komplexitätsordnung.
 * `null`, wenn weniger als zwei Punkte oder alle n identisch sind.
 */
export function logLogExponent(points: readonly { n: number; ms: number }[]): number | null {
  const valid = points.filter((p) => Number.isFinite(p.n) && p.n > 0 && Number.isFinite(p.ms) && p.ms > 0);
  if (valid.length < 2) return null;
  const xs = valid.map((p) => Math.log(p.n));
  const ys = valid.map((p) => Math.log(p.ms));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** ms je 1000 Kerzen (Vergleichsgröße über alle Messpunkte). */
export function msPer1000Bars(ms: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new Error("msPer1000Bars() braucht n > 0.");
  return (ms / n) * 1000;
}

export function summarizeRuns(rawMs: readonly number[]): BenchPathResult {
  const med = median(rawMs);
  return {
    medianMs: med,
    rawMs: [...rawMs],
    minMs: Math.min(...rawMs),
    maxMs: Math.max(...rawMs),
    msPer1000Bars: 0, // wird vom Aufrufer mit dem passenden n gesetzt
  };
}

/** 7.500 Zellen × Zellkosten → Kernstunden seriell (1 Kernstunde = 3 600 000 ms). */
export function coreHoursForMatrix(cellMs: number, cells: number = MATRIX_CELLS): number {
  return (cellMs * cells) / 3_600_000;
}

/**
 * Kanonische Bench-Regel. Bewusst so gewählt, dass sie auf echten Krypto-
 * Stundenkerzen regelmäßig auslöst (sonst würde ein Early-Exit gemessen
 * statt der Snapshot-/Indikatorarbeit) und dabei alle Snapshot-Felder
 * berührt, die `buildSnapshotFromCandles` berechnet.
 */
export const BENCH_RULE_INPUT = {
  name: "BENCH-Baseline (EMA/RSI/ADX/Bollinger)",
  rationale:
    "Messregel der Backtest-Performance-Baseline (STX-00-01). Kein Handelsvorschlag — " +
    "sie dient ausschließlich dazu, den Snapshot-/Indikatorpfad unter realistischer Verteilung zu messen.",
  condition: {
    logic: "all",
    conditions: [
      { field: "rsi14", op: "gt", value: 30 },
      { field: "adx14", op: "gt", value: 5 },
      { field: "bbwPct", op: "gt", value: 0.05 },
      { field: "macdHist", op: "gte", value: -50 },
      { field: "priceVsEma50Pct", op: "gt", value: -30 },
    ],
  },
  action: {
    side: "LONG",
    stopLossPct: 5,
    takeProfitRR: 1.5,
    riskBudgetPct: 0.02,
    maxPositionPct: 0.25,
  },
  window: { timeframe: "1h", maxExecutionsPerDay: 4, cooldownMinutes: 0, volumeWindow: 20 },
  riskScore: 0.3,
} as const;

/** Venue-nativer Symbolteil eines Instrument-IDs (`BINANCE:BTCUSDT` → `BTCUSDT`). */
export function nativeSymbolOf(instrumentId: string): string {
  const idx = instrumentId.indexOf(":");
  return idx > 0 && idx < instrumentId.length - 1 ? instrumentId.slice(idx + 1) : instrumentId;
}

/**
 * Baut die Bench-Regel über die Sanitize-Kette (keine hand-gebaute `RuleSpec`).
 *
 * Der gemessene Timeframe läuft durch die Sanitize-Kette selbst: seit STX-01
 * (v0.6.2) akzeptiert die `RuleWindow`-Allowlist jeden Store-Timeframe
 * (`RULE_ALLOWED_TIMEFRAMES`), der frühere Cast nach der Sanitize-Kette ist weg.
 *
 * Eine bewusste Zuweisung NACH der Sanitize-Kette, mit Vorbild im Repo:
 *   - `symbol` = Instrument-ID: die Engine löst Strategien über die Keys der
 *     Candle-Map auf (`engine.ts` `strat.symbol`), und `run-backtest.ts:363`
 *     setzt genau dafür `{ ...spec, symbol: instrumentId }`. Die Sanitize-
 *     Kette selbst akzeptiert nur venue-freie Symbolformen.
 */
export function buildBenchSpec(instrumentId: string, timeframe: SupportedTimeframe): RuleSpec {
  const parsed = sanitizeRuleSpec(
    {
      ...BENCH_RULE_INPUT,
      symbol: nativeSymbolOf(instrumentId),
      window: { ...BENCH_RULE_INPUT.window, timeframe },
    },
    "MANUAL",
  );
  if (!parsed.ok) {
    throw new Error(
      `Bench-Regel ungültig (Instrument "${instrumentId}"): ${parsed.errors.join("; ")}`,
    );
  }
  return { ...parsed.spec, symbol: instrumentId };
}

/** Store-Einträge → `CandleLike[]` (der Vertrag der gemessenen Pfade). */
export function toCandles(entries: readonly HistoricalCandleEntry[]): CandleLike[] {
  return entries.map((e) => ({
    time: e.ts,
    open: e.open,
    high: e.high,
    low: e.low,
    close: e.close,
    volume: e.volume,
  }));
}

/** SHA-256 über die gemessene Kerzenfolge (Provenienz, keine Interpretation). */
export function seriesDigest(candles: readonly CandleLike[]): string {
  const hash = createHash("sha256");
  for (const c of candles) {
    hash.update(`${c.time}:${c.open}:${c.high}:${c.low}:${c.close}:${c.volume}\n`);
  }
  return hash.digest("hex");
}

/** Zeitlücken der Reihe (Datenqualität; Datenlücken erklären Ausreißer). */
export function gapStats(
  candles: readonly CandleLike[],
  stepMs: number,
): { gapCount: number; maxGapMs: number } {
  let gapCount = 0;
  let maxGapMs = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta !== stepMs) {
      gapCount += 1;
      maxGapMs = Math.max(maxGapMs, Math.abs(delta - stepMs));
    }
  }
  return { gapCount, maxGapMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Messung
// ─────────────────────────────────────────────────────────────────────────────

function timeRun(fn: () => unknown): { ms: number; result: unknown } {
  const started = performance.now();
  const result = fn();
  return { ms: performance.now() - started, result };
}

/**
 * Führt `fn` `warmupRuns` mal ungemessen aus (V8-Tier-Up, GC-Einschwingen) und
 * danach `repeats` mal gemessen. Ohne diesen Warmlauf misst der Fit den
 * JIT-Sprung als „Skaleneffekt" mit (der Cache-Pfad erschien so z. B. mit
 * Exponent 0,74 statt ≈ 1).
 */
function measure(
  repeats: number,
  fn: () => unknown,
  warmupRuns = 0,
): { rawMs: number[]; last: unknown } {
  const rawMs: number[] = [];
  let last: unknown = undefined;
  for (let i = 0; i < warmupRuns; i++) fn();
  for (let i = 0; i < repeats; i++) {
    const { ms, result } = timeRun(fn);
    rawMs.push(ms);
    last = result;
  }
  return { rawMs, last };
}

export interface RunBenchOptions {
  candles: CandleLike[];
  spec: RuleSpec;
  instrumentId: string;
  timeframe: SupportedTimeframe;
  sizes?: readonly number[];
  repeats?: number;
  paths?: readonly BenchPath[];
  executionModel?: "legacy" | "paper";
  startingEquity?: number;
  /** Warmup-KERZEN der Messpfade (Default 30). */
  warmup?: number;
  volumeWindow?: number;
  /** Ungemessene Läufe je (Pfad, n) vor der Messung (Default 1). */
  warmupRuns?: number;
}

/**
 * Führt das Messprotokoll aus. Rein funktional (kein I/O) — der CLI-Teil
 * kümmert sich um Store, Artefakte und Ausgabe. Pro (Pfad, n) werden
 * `repeats` Läufe gemessen; gemeldet wird der Median plus alle Rohwerte.
 */
export function runBench(options: RunBenchOptions): {
  points: BenchPoint[];
  exponents: Record<BenchPath, number | null>;
  comparison: BenchReport["comparison"];
  matrix: BenchReport["matrix"];
  rule: BenchReport["rule"];
  config: BenchReport["config"];
} {
  const sizes = [...(options.sizes ?? BENCH_SIZES)].filter((n) => n > 0).sort((a, b) => a - b);
  const repeats = Math.max(1, options.repeats ?? 3);
  const paths = options.paths ?? [...BENCH_PATHS];
  const executionModel = options.executionModel ?? "legacy";
  const startingEquity = options.startingEquity ?? 10_000;
  const warmup = options.warmup ?? 30;
  const volumeWindow = options.volumeWindow ?? 20;
  const warmupRuns = Math.max(0, options.warmupRuns ?? 0);

  const points: BenchPoint[] = [];

  for (const n of sizes) {
    const window = options.candles.slice(0, n);
    if (window.length < n) {
      throw new Error(`Messpunkt n=${n} nicht möglich: nur ${window.length} Kerzen verfügbar.`);
    }
    const point: BenchPoint = { n, paths: {} as BenchPoint["paths"], detail: {} };

    if (paths.includes("rule")) {
      const { rawMs, last } = measure(
        repeats,
        () => backtestRule(options.spec, window, { startingEquity, warmup }),
        warmupRuns,
      );
      const result = last as ReturnType<typeof backtestRule>;
      point.paths.rule = { ...summarizeRuns(rawMs), msPer1000Bars: msPer1000Bars(median(rawMs), n) };
      point.detail.rule = { signals: result.signals, trades: result.stats.trades, bars: result.bars };
    }

    if (paths.includes("multiAsset")) {
      const { rawMs, last } = measure(repeats, () =>
        runMultiAssetBacktest({
          candlesBySymbol: { [options.instrumentId]: window },
          strategies: [{ type: "rule", spec: options.spec, id: `RULE-${options.instrumentId}` }],
          config: {
            timeframe: options.timeframe,
            initialCapital: startingEquity,
            warmupBars: warmup,
            executionModel,
          },
        }),
        warmupRuns,
      );
      const result = last as ReturnType<typeof runMultiAssetBacktest>;
      point.paths.multiAsset = {
        ...summarizeRuns(rawMs),
        msPer1000Bars: msPer1000Bars(median(rawMs), n),
      };
      point.detail.multiAsset = { trades: result.trades.length, barsProcessed: result.barsProcessed };
    }

    if (paths.includes("cache")) {
      const { rawMs, last } = measure(repeats, () => {
        const cache = buildIndicatorCache(window);
        let snapshots = 0;
        for (let i = warmup; i < window.length; i++) {
          if (snapshotFromCache(options.spec.symbol, window, cache, i, volumeWindow) !== null) {
            snapshots += 1;
          }
        }
        return { cache, snapshots };
      }, warmupRuns);
      const result = last as { snapshots: number };
      point.paths.cache = { ...summarizeRuns(rawMs), msPer1000Bars: msPer1000Bars(median(rawMs), n) };
      point.detail.cache = { snapshots: result.snapshots, bars: window.length };
    }

    points.push(point);
  }

  const exponentOf = (benchPath: BenchPath): number | null => {
    const series = points
      .filter((p) => p.paths[benchPath] !== undefined)
      .map((p) => ({ n: p.n, ms: p.paths[benchPath].medianMs }));
    return logLogExponent(series);
  };

  const exponents = Object.fromEntries(
    BENCH_PATHS.map((p) => [p, exponentOf(p)]),
  ) as Record<BenchPath, number | null>;

  const largest = points[points.length - 1];
  const ratio = (base: BenchPath, other: BenchPath): number | null => {
    const b = largest?.paths[base]?.medianMs;
    const o = largest?.paths[other]?.medianMs;
    if (b === undefined || o === undefined || o <= 0) return null;
    return b / o;
  };

  const cellMsOf = (benchPath: BenchPath): number => {
    const exact = points.find((p) => p.n === MATRIX_CELL_CANDLES);
    const chosen = exact ?? largest;
    return chosen?.paths[benchPath]?.medianMs ?? Number.NaN;
  };

  const matrix = {
    cells: MATRIX_CELLS,
    cellCandles: MATRIX_CELL_CANDLES,
    pilotCells: PILOT_CELLS,
    perPath: Object.fromEntries(
      BENCH_PATHS.map((p) => {
        const cellMs = cellMsOf(p);
        return [
          p,
          {
            cellMs,
            coreHours: coreHoursForMatrix(cellMs, MATRIX_CELLS),
            pilotCoreHours: coreHoursForMatrix(cellMs, PILOT_CELLS),
          },
        ];
      }),
    ) as BenchReport["matrix"]["perPath"],
  };

  return {
    points,
    exponents,
    comparison: { speedupMultiAsset: ratio("rule", "multiAsset"), speedupCache: ratio("rule", "cache") },
    matrix,
    rule: {
      name: options.spec.name,
      symbol: options.spec.symbol,
      signature: ruleSignature(options.spec),
    },
    config: {
      sizes,
      repeats,
      warmupRuns,
      executionModel,
      startingEquity,
      warmup,
      volumeWindow,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ausgabe
// ─────────────────────────────────────────────────────────────────────────────

const ms = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

/** Markdown-Protokoll (identisch zur Struktur der BENCH-BASELINE.md). */
export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [
    `# Backtest-Performance-Baseline (Rohprotokoll)`,
    ``,
    `- Erzeugt: ${report.generatedAt} · Node ${report.environment.node} · ` +
      `${report.environment.cpuCount} × ${report.environment.cpuModel}`,
    `- Reihe: \`${report.source.instrumentId}\` ${report.source.timeframe} aus \`${report.source.file}\``,
    `  (${report.source.availableBars} Kerzen verfügbar, Fenster ` +
      `${new Date(report.source.window.from).toISOString()} … ${new Date(report.source.window.to).toISOString()}, ` +
      `Lücken: ${report.source.gapCount})`,
    `- Messreihen-SHA-256: \`${report.source.seriesSha256}\``,
    `- Regel: ${report.rule.name} (\`${report.rule.signature}\`) · Wiederholungen: ${report.config.repeats} · ` +
      `Warmläufe je Messpunkt: ${report.config.warmupRuns} · ` +
      `Ausführungsmodell: ${report.config.executionModel} · Startkapital: ${report.config.startingEquity}`,
    ``,
    `Gemessen wird je (Pfad, n) nach ${report.config.warmupRuns} ungemessenem Warmlauf; berichtet wird der ` +
      `Median über ${report.config.repeats} gemessene Läufe („Rohwerte" = alle gemessenen Läufe).`,
    ``,
    `## Messpunkte (Median über ${report.config.repeats} Läufe)`,
    ``,
    `| Pfad | n | Rohwerte (ms) | Median (ms) | ms/1000 Kerzen | Exponent (log-log) |`,
    `|---|---:|---|---:|---:|---:|`,
  ];

  for (const benchPath of BENCH_PATHS) {
    for (const point of report.points) {
      const result = point.paths[benchPath];
      if (!result) continue;
      lines.push(
        `| ${benchPath} | ${point.n} | ${result.rawMs.map((v) => ms(v)).join(" · ")} | ` +
          `${ms(result.medianMs)} | ${ms(result.msPer1000Bars, 2)} | ${
            report.exponents[benchPath] === null ? "—" : ms(report.exponents[benchPath] as number, 2)
          } |`,
      );
    }
  }

  lines.push(
    ``,
    `## Vergleich (größter Messpunkt)`,
    ``,
    `- \`rule\` / \`multiAsset\`: ${report.comparison.speedupMultiAsset === null ? "—" : ms(report.comparison.speedupMultiAsset, 1) + "×"}`,
    `- \`rule\` / \`cache\`: ${report.comparison.speedupCache === null ? "—" : ms(report.comparison.speedupCache, 1) + "×"}`,
    ``,
    `## Matrix-Rechnung (${report.matrix.cells} Zellen × ${report.matrix.cellCandles} Kerzen = 1h-Zelle)`,
    ``,
    `| Pfad | Zelle (ms) | Kernstunden seriell (${report.matrix.cells} Zellen) | Kernstunden (Top-${report.matrix.pilotCells}) |`,
    `|---|---:|---:|---:|`,
  );
  for (const benchPath of BENCH_PATHS) {
    const cell = report.matrix.perPath[benchPath];
    lines.push(
      `| ${benchPath} | ${ms(cell.cellMs)} | ${ms(cell.coreHours, 2)} | ${ms(cell.pilotCoreHours, 3)} |`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `bench:backtest — Backtest-Performance-Baseline messen (STX-00-01).

Verwendung:
  npm run bench:backtest -- --instrument=<ID> [Optionen]

Pflicht:
  --instrument=<ID>    Instrument-ID im Store (z. B. BINANCE:BTCUSDT)

Optionen:
  --timeframe=<tf>     Gemessener Timeframe. Erlaubt: ${SUPPORTED_TIMEFRAMES.join(", ")}. Default: 1h
  --dir=<pfad>         Store-Verzeichnis. Default: data/history
  --sizes=<n,n,n>      Messpunkte (Default: ${BENCH_SIZES.join(",")}). Nicht verfügbare
                       Größen werden gemeldet und übersprungen (Fit braucht ≥ 2).
  --repeat=<k>         Läufe je Messpunkt (Default: 3) — berichtet wird der Median.
  --paths=<p,p,p>      Teilmenge von ${BENCH_PATHS.join(",")} (Default: alle).
  --execution-model=…  legacy (Default) oder paper — gilt nur für den multiAsset-Pfad.
  --starting-equity=<n> Startkapital (Default: STARTING_EQUITY aus der Umgebung, sonst 10000).
  --warmup-bars=<n>    Warmup-Kerzen der Messpfade (Default: 30).
  --warmup-runs=<k>    Ungemessene Läufe je (Pfad, n) vor der Messung (Default: 1).
                       0 = Kaltmessung (erster Lauf inkl. Tier-Up), 1+ = eingeschwungen.
  --out-dir=<pfad>     Artefakt-Verzeichnis. Default: data/bench
  --no-write           Keine Artefakte schreiben (nur stdout).
  --help               Diese Hilfe.

Es wird nichts nach data/ außerhalb von data/bench/ geschrieben; der Store wird
nur gelesen. Kein Netz, keine Datenbank (kein src/db-Import).

Ohne Store-Daten (frischer Checkout):
  npm run market-sync                                  # oder, offline:
  npm run history:import-csv -- --file=<csv> --instrument=<ID> --apply
  # → Details: docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md`;

function arg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function parseNumberList(raw: string | undefined, fallback: readonly number[]): number[] {
  if (!raw) return [...fallback];
  const parsed = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.floor(v));
  if (parsed.length === 0) throw new Error(`--sizes="${raw.slice(0, 40)}" enthält keine positiven Zahlen.`);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/** Store-Pfad für Fehlermeldungen: relativ zum Projektstamm, sonst absolut. */
function displayPath(dir: string): string {
  const abs = resolveRuntimePath(dir);
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

function fail(message: string): number {
  console.error(`[bench] FEHLER: ${message}`);
  console.error("[bench] Hilfe: npm run bench:backtest -- --help");
  return 1;
}

export interface BenchCliResult {
  exitCode: number;
  report: BenchReport | null;
  jsonPath: string | null;
  mdPath: string | null;
}

/** CLI-Einstieg (testbar: gibt Exit-Code + Report zurück, beendet nicht selbst). */
export function runCli(argv: string[] = process.argv.slice(2)): BenchCliResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return { exitCode: 0, report: null, jsonPath: null, mdPath: null };
  }

  const instrumentId = arg(argv, "instrument");
  if (!instrumentId) {
    return { exitCode: fail("--instrument=<ID> fehlt (z. B. BINANCE:BTCUSDT)."), report: null, jsonPath: null, mdPath: null };
  }

  const timeframeRaw = arg(argv, "timeframe") ?? "1h";
  if (!isSupportedTimeframe(timeframeRaw)) {
    return {
      exitCode: fail(
        `--timeframe="${timeframeRaw.slice(0, 20)}" ist nicht in der Allowlist (${SUPPORTED_TIMEFRAMES.join(", ")}).`,
      ),
      report: null,
      jsonPath: null,
      mdPath: null,
    };
  }
  const timeframe: SupportedTimeframe = timeframeRaw;

  let sizes: number[];
  let repeats: number;
  let paths: BenchPath[];
  try {
    sizes = parseNumberList(arg(argv, "sizes"), BENCH_SIZES);
    repeats = Math.max(1, Math.floor(Number(arg(argv, "repeat") ?? "3")) || 3);
    const rawPaths = arg(argv, "paths");
    paths = rawPaths
      ? (rawPaths
          .split(",")
          .map((p) => p.trim())
          .filter((p): p is BenchPath => (BENCH_PATHS as readonly string[]).includes(p)))
      : [...BENCH_PATHS];
    if (paths.length === 0) throw new Error(`--paths muss ${BENCH_PATHS.join("/")} enthalten.`);
  } catch (e) {
    return { exitCode: fail(e instanceof Error ? e.message : String(e)), report: null, jsonPath: null, mdPath: null };
  }

  const executionModelRaw = arg(argv, "execution-model") ?? "legacy";
  if (executionModelRaw !== "legacy" && executionModelRaw !== "paper") {
    return {
      exitCode: fail(`--execution-model="${executionModelRaw.slice(0, 20)}" ist weder legacy noch paper.`),
      report: null,
      jsonPath: null,
      mdPath: null,
    };
  }

  const startingEquity = Number(arg(argv, "starting-equity") ?? process.env.STARTING_EQUITY ?? "10000");
  if (!Number.isFinite(startingEquity) || startingEquity <= 0) {
    return { exitCode: fail("--starting-equity muss eine positive Zahl sein."), report: null, jsonPath: null, mdPath: null };
  }
  // `--warmup` bleibt als Alias lesbar (frühere Schreibweise), kanonisch ist
  // `--warmup-bars` — der Name kollidierte sonst mit `--warmup-runs`.
  const warmupRaw = arg(argv, "warmup-bars") ?? arg(argv, "warmup") ?? "30";
  const warmup = Math.max(0, Math.floor(Number(warmupRaw)) || 30);
  const warmupRunsRaw = Number(arg(argv, "warmup-runs") ?? "1");
  if (!Number.isFinite(warmupRunsRaw) || warmupRunsRaw < 0) {
    return { exitCode: fail("--warmup-runs muss eine nicht-negative Zahl sein."), report: null, jsonPath: null, mdPath: null };
  }
  const warmupRuns = Math.floor(warmupRunsRaw);

  const storeDir = arg(argv, "dir") ?? "data/history";
  const store = new HistoricalStore(storeDir);
  const available = store.query({ instrumentId, timeframe });
  if (available.length === 0) {
    return {
      exitCode: fail(
        `keine Kerzen für ${instrumentId} ${timeframe} in ${displayPath(storeDir)}. ` +
          "Erst Daten beschaffen: `npm run market-sync` (Netz) oder " +
          "`npm run history:import-csv -- --file=<csv> --instrument=" + instrumentId + " --apply` (offline). " +
          "Siehe docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md.",
      ),
      report: null,
      jsonPath: null,
      mdPath: null,
    };
  }

  const usable = sizes.filter((n) => n <= available.length);
  const skipped = sizes.filter((n) => n > available.length);
  if (usable.length < 2) {
    return {
      exitCode: fail(
        `nur ${available.length} Kerzen für ${instrumentId} ${timeframe} — für den log-log-Fit sind mindestens 2 ` +
          `Messpunkte nötig (verlangt: ${sizes.join(", ")}).`,
      ),
      report: null,
      jsonPath: null,
      mdPath: null,
    };
  }
  if (skipped.length > 0) {
    console.warn(
      `[bench] WARNUNG: ${skipped.join(", ")} übersprungen — nur ${available.length} Kerzen in der Reihe. ` +
        "Für das volle Protokoll die Reihe verlängern (npm run market-sync) oder --sizes anpassen.",
    );
  }

  const measured = toCandles(available.slice(-Math.max(...usable)));
  const spec = buildBenchSpec(instrumentId, timeframe);
  const stepMs = SUPPORTED_TIMEFRAME_MS[timeframe];
  const gaps = gapStats(measured, stepMs);
  const outDir = resolveRuntimePath(arg(argv, "out-dir") ?? "data/bench");

  console.log(
    `[bench] Reihe ${instrumentId} ${timeframe}: ${available.length} Kerzen, gemessen werden ${usable.join(", ")} ` +
      `× ${repeats} Läufe (Pfade: ${paths.join(", ")}).`,
  );
  console.log(
    `[bench] Regel "${spec.name}" (Signatur ${ruleSignature(spec)}), Lücken: ${gaps.gapCount}, ` +
      `Startkapital ${startingEquity}, Warmup ${warmup} Kerzen, Warmläufe ${warmupRuns}.`,
  );
  console.log(`[bench] Node ${process.version}, ${cpus().length} Kerne — Messung läuft, bitte nicht abbrechen …`);

  const startedAt = performance.now();
  let measuredResult: ReturnType<typeof runBench>;
  try {
    measuredResult = runBench({
      candles: measured,
      spec,
      instrumentId,
      timeframe,
      sizes: usable,
      repeats,
      paths,
      executionModel: executionModelRaw,
      startingEquity,
      warmup,
      volumeWindow: spec.window.volumeWindow,
      warmupRuns,
    });
  } catch (e) {
    return { exitCode: fail(e instanceof Error ? e.message : String(e)), report: null, jsonPath: null, mdPath: null };
  }

  const firstCandle = measured[0];
  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpuModel: cpus()[0]?.model ?? "unbekannt",
      cpuCount: cpus().length,
    },
    source: {
      dir: displayPath(storeDir),
      file: displayPath(store.filePath),
      instrumentId,
      timeframe,
      seriesSha256: seriesDigest(measured),
      availableBars: available.length,
      window: { from: firstCandle.time, to: measured[measured.length - 1].time },
      gapCount: gaps.gapCount,
      maxGapMs: gaps.maxGapMs,
    },
    rule: measuredResult.rule,
    config: measuredResult.config,
    points: measuredResult.points,
    exponents: measuredResult.exponents,
    comparison: measuredResult.comparison,
    matrix: measuredResult.matrix,
  };

  const elapsedSec = (performance.now() - startedAt) / 1000;
  console.log(renderMarkdown(report));
  console.log(
    `[bench] Messdauer gesamt ${elapsedSec.toFixed(1)} s für ${usable.length} Messpunkte × ${repeats} Läufe × ${paths.length} Pfade.`,
  );

  const noWrite = argv.includes("--no-write");
  if (noWrite) {
    return { exitCode: 0, report, jsonPath: null, mdPath: null };
  }

  const slug = `${instrumentId.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${timeframe}`;
  const jsonPath = joinRuntimePath(outDir, `bench-${slug}.json`);
  const mdPath = joinRuntimePath(outDir, `bench-${slug}.md`);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    writeFileSync(mdPath, renderMarkdown(report), "utf8");
  } catch (e) {
    return {
      exitCode: fail(`Artefakte nicht schreibbar (${e instanceof Error ? e.message : String(e)}).`),
      report,
      jsonPath: null,
      mdPath: null,
    };
  }
  console.log(`[bench] Artefakte: ${jsonPath}, ${mdPath}`);
  return { exitCode: 0, report, jsonPath, mdPath };
}

// Direktstart (`npm run bench:backtest`), nicht beim Test-Import.
const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("bench-backtest.ts");
if (invokedAsScript) {
  process.exitCode = runCli().exitCode;
}

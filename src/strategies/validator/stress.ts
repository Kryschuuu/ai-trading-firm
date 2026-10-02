/**
 * Deterministischer Cost- & Slippage-Stress-Runner (STX-06-03, Finding STX-11, Phase 6).
 *
 * Zweischichtiges Stress-Modell ohne drittes Kostenmodell:
 *   1. **In-Engine-Stress (`runInEngineStress`, `summarizeStressSweep`)**
 *      Beantwortet die Frage: *„Ist die Edge nach realen/gestressten Kosten noch da?"*
 *      Pro Szenario aus `COST_STRESS_SCENARIOS` (`base`, `double`, `triple`) wird
 *      genau **ein** Walk-Forward-Lauf mit angepasstem `BacktestEngineConfig`
 *      ausgeführt (`feeModel` skaliert, `slippageModel: "fixed"` mit
 *      `fixedSlippageBps`; `executionModel` bleibt der des Referenzlaufs:
 *      `"legacy" | "paper" | "event_replay"`).
 *      - Ein geänderter Slippage-/Fee-Satz kann im Engine-Lauf andere Fills,
 *        Stop-Outs oder Drawdown-Schwellen auslösen als eine reine
 *        Nachberechnung auf bestehenden Trades.
 *      - Ist im Referenzlauf `slippageModel: "none"` (oder 0 bp Gebühren/Slippage)
 *        konfiguriert, bricht `runInEngineStress` fail-closed mit
 *        `{ ok: false, errors: [...] }` ab — **kein** stilles Hochrechnen von 0.
 *      - Das `base`-Szenario verändert die Referenzkonfiguration nicht und ist
 *        damit byte-identisch zum Referenzlauf.
 *
 *   2. **Post-hoc-Stress (`runPostHocStress`)**
 *      Beantwortet die Frage: *„Wie empfindlich ist die Pfadverteilung gegen
 *      Ergebnisrauschen unter skalierten Kosten?"*
 *      Dünner Durchreiche-Adapter auf `runMonteCarloSimulation`
 *      (`src/backtest/montecarlo.ts`) mit `stress: { feeMultiplier, slippageMultiplier }`.
 *      **Keine eigene Monte-Carlo-Implementierung.**
 *      Das Post-hoc-Ergebnis steht im Report (`StressReport.postHoc` bzw.
 *      `StressSweepOk.postHoc`) **strikt getrennt** vom In-Engine-Ergebnis
 *      (`inEngine`) und fließt niemals in `degradationRatio`,
 *      `breakevenMultiplier` oder `verdict` ein.
 *
 * Hinweis zu `degradationRatio` (Prompt-Kurzkommentar vs. Verdikt-Grenzen):
 *   - Der Kurzkommentar in Punkt 3 des Prompts notiert verkürzt
 *     `Ratio OOS-Sharpe(base) / OOS-Sharpe(3×)`, während Punkt 5 die
 *     Verdikt-Grenzen als `>= 0.6` ⇒ `COST_ROBUST`, `[0.3, 0.6)` ⇒
 *     `COST_SENSITIVE`, `< 0.3` ⇒ `COST_DEPENDENT` festlegt.
 *   - Da höhere Kosten den OOS-Sharpe senken (`Sharpe(triple) <= Sharpe(base)`),
 *     wäre `Sharpe(base) / Sharpe(triple)` für jeden positiven 3×-Sharpe `>= 1.0`
 *     und würde mit fallendem 3×-Sharpe gegen `Infinity` wachsen.
 *   - Maßgeblich ist deshalb der **erhaltene OOS-Sharpe-Anteil**
 *     `degradationRatio = OOS-Sharpe(triple) / OOS-Sharpe(base)`:
 *     `>= 0.6` (mindestens 60 % des Basis-Sharpe bleiben bei 3× Kosten erhalten,
 *     und `triple.netPnl > 0`) ⇒ `COST_ROBUST`.
 *
 * Gesperrt (Finding STX-11):
 *   - Keine Änderung an `src/backtest/montecarlo.ts`, `BacktestEngineConfig`
 *     (`src/backtest/types.ts`) oder `FillSimulator` (`src/lib/marketdata/simulator.ts`).
 *   - Kein neues Kostenmodell; keine Änderung des Basislaufs; keine Erweiterung
 *     um Latenz- oder Markttiefe-Stress.
 */

import { DEFAULT_BACKTEST_CONFIG } from "../../backtest/engine";
import type {
  BacktestEngineConfig,
  BacktestEngineOptions,
  BacktestTradeLog,
} from "../../backtest/types";
import {
  computeWalkForwardWindows,
  loadWalkForwardConfig,
  runWalkForward,
  type RunWalkForwardInput,
  type WalkForwardReport,
  type WalkForwardTradeRecord,
} from "../../backtest/walkforward";
import {
  runMonteCarloSimulation,
  type MonteCarloConfig,
  type MonteCarloMethod,
  type MonteCarloResult,
  type MonteCarloSegmentFilter,
  type MonteCarloStressConfig,
  type MonteCarloTradeInput,
} from "../../backtest/montecarlo";

// ─────────────────────────────────────────────────────────────────────────────
// Version & Szenarien (SSoT)
// ─────────────────────────────────────────────────────────────────────────────

/** Schema- und Regelwerk-Version des Cost- & Slippage-Stress-Runners. */
export const COST_STRESS_VERSION = "stx06-cost-stress-v1" as const;

/**
 * Versionierte Kosten- und Slippage-Stress-Szenarien (STX-06-03, Finding STX-11).
 *
 * Wichtiger Hinweis (Annahmen vs. Messung):
 *   - Die `slippageBps`-Werte (5 / 10 / 20 bp) sind **normative Stress-Annahmen**
 *     für den In-Engine-Sweep (`slippageModel: "fixed"`, `fixedSlippageBps`),
 *     **keine** aus Live-/Paper-Fills gemessenen Ausführungs-Slippages.
 *   - Ob der Referenzlauf (`base`) tatsächlich Gebühren > 0 (`FEE_NONZERO`),
 *     Slippage > 0 (`SLIPPAGE_NONZERO`) und Gesamtkosten > 0 (`COST_NONZERO`)
 *     angesetzt hat, prüft deterministisch das Assumptions-Audit aus Paket
 *     STX-06-01 (`src/strategies/validator/assumptions.ts`, `auditAssumptions`).
 */
export const COST_STRESS_SCENARIOS = [
  { id: "base",   feeMultiplier: 1, slippageBps: 5,  label: "Basis" },
  { id: "double", feeMultiplier: 2, slippageBps: 10, label: "2× Kosten" },
  { id: "triple", feeMultiplier: 3, slippageBps: 20, label: "3× Kosten" },
] as const;

export type CostStressScenario = (typeof COST_STRESS_SCENARIOS)[number];
export type CostStressScenarioId = CostStressScenario["id"];

export const COST_STRESS_SCENARIO_IDS: readonly CostStressScenarioId[] = [
  "base",
  "double",
  "triple",
] as const;

/** Geschlossene Verdikt-Taxonomie des Cost-Stress-Runners. */
export const STRESS_VERDICTS = [
  "COST_ROBUST",
  "COST_SENSITIVE",
  "COST_DEPENDENT",
] as const;

export type StressVerdict = (typeof STRESS_VERDICTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Laufzeit-Bounds & Verdikt-Schwellen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default-Obergrenzen zur Begrenzung der Backtest-Laufzeitkosten:
 * max. 3 Szenarien × 3 Walk-Forward-Fenster × 5 Kandidaten = 45 Läufe.
 */
export const MAX_STRESS_SCENARIOS = 3 as const;
export const MAX_STRESS_WINDOWS = 3 as const;
export const MAX_STRESS_CANDIDATES = 5 as const;
export const DEFAULT_MAX_STRESS_RUNS = 45 as const;

/**
 * Konfigurierbare Schwellen für das Stress-Verdikt (`summarizeStressSweep`).
 *
 * Begründung der Defaults:
 *   - `robustMinRatio = 0.6`: Unter 3× Gebühren und 20 bp Slippage (`triple`)
 *     müssen mindestens 60 % des Out-of-Sample-Sharpe aus `base` erhalten
 *     bleiben **und** das `triple`-Szenario muss netto profitabel bleiben
 *     (`triple.netPnl > 0`).
 *   - `sensitiveMinRatio = 0.3`: Bleiben zwischen 30 % und < 60 % des
 *     OOS-Sharpe erhalten (oder ist `degradationRatio >= 0.6`, aber `triple`
 *     nicht mehr netto profitabel), reagiert die Strategie spürbar auf
 *     Friktionen (`COST_SENSITIVE`).
 *   - Darunter (`< 0.3` oder `degradationRatio === null`, z. B. wenn schon
 *     `base.sharpe <= 0`) hängt die scheinbare Edge an niedrigen Kostenannahmen
 *     (`COST_DEPENDENT`).
 */
export interface StressVerdictThresholds {
  readonly robustMinRatio: number;
  readonly sensitiveMinRatio: number;
  readonly minTripleNetPnl: number;
}

export const DEFAULT_STRESS_VERDICT_THRESHOLDS: StressVerdictThresholds = Object.freeze({
  robustMinRatio: 0.6,
  sensitiveMinRatio: 0.3,
  minTripleNetPnl: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Typen für In-Engine-Sweep, Zusammenfassung & Report
// ─────────────────────────────────────────────────────────────────────────────

/** Kennzahlen-Zeile eines einzelnen Stress-Szenarios in `StressSummary`. */
export interface StressScenarioSummaryRow {
  readonly id: CostStressScenarioId | string;
  readonly sharpe: number;
  readonly netPnl: number;
  readonly maxDrawdownPct: number;
  readonly trades: number;
}

/**
 * Zusammenfassung des In-Engine-Stress-Sweeps (`summarizeStressSweep`).
 */
export interface StressSummary {
  readonly scenarios: readonly StressScenarioSummaryRow[];
  /**
   * Erhaltener OOS-Sharpe-Anteil unter 3× Kosten:
   * `OOS-Sharpe(triple) / OOS-Sharpe(base)`.
   * (Im Prompt-Kurzkommentar als Ratio zwischen `base` und `3×` bezeichnet;
   * Richtung gemäß Punkt 5: `>= 0.6` ⇒ `COST_ROBUST`, `[0.3, 0.6)` ⇒
   * `COST_SENSITIVE`, `< 0.3` ⇒ `COST_DEPENDENT`.)
   * `null`, wenn `base` oder `triple` fehlt oder `base.sharpe <= 0`.
   */
  readonly degradationRatio: number | null;
  /**
   * Szenario-Multiplikator (Gebührenrunde), ab dem die Strategie kein Geld
   * mehr verdient (`netPnl <= 0`), bestimmt per linearer Interpolation
   * zwischen benachbarten Szenarien.
   * `null`, wenn `triple` noch positiv ist (`triple.netPnl > 0`) ⇒
   * bedeutet dokumentiert „hält mindestens 3×".
   */
  readonly breakevenMultiplier: number | null;
  readonly verdict: StressVerdict;
}

/** Laufzeit-Budget-Nachweis eines Stress-Sweeps. */
export interface StressRunBudget {
  readonly scenarioCount: number;
  readonly windowCount: number;
  readonly candidateCount: number;
  readonly plannedRuns: number;
  readonly executedRuns: number;
  readonly maxRuns: number;
}

/** Kontext eines einzelnen Szenario-Aufrufs im injizierbaren Runner-Port. */
export interface InEngineStressRunnerContext {
  readonly scenario: CostStressScenario;
  /** Vollständig aufgelöste `BacktestEngineConfig` des Szenarios. */
  readonly engineConfig: BacktestEngineConfig;
  /** Alias auf `engineConfig` für kompakte Test-Stubs. */
  readonly config: BacktestEngineConfig;
  /**
   * An `runWalkForward` übergebene Eingabe (sofern `walkForward` beim Aufruf
   * von `runInEngineStress` angegeben wurde).
   */
  readonly walkForwardInput?: RunWalkForwardInput;
}

/**
 * Vom Runner-Port akzeptierte Rückgabeform:
 *   - vollständiger `WalkForwardReport` (Produktionspfad über `runWalkForward`),
 *   - Objekt mit `aggregateOos: { sharpeRatio, netPnl, maxDrawdownPct, trades }`,
 *   - oder direktes Metrik-Objekt `{ sharpe | sharpeRatio, netPnl, maxDrawdownPct, trades }`
 *     für leichtgewichtige Unit-Test-Stubs.
 */
export type InEngineStressRunnerOutput =
  | WalkForwardReport
  | {
      readonly aggregateOos: {
        readonly sharpeRatio: number;
        readonly netPnl: number;
        readonly maxDrawdownPct: number;
        readonly trades: number;
      };
    }
  | {
      readonly sharpe?: number;
      readonly sharpeRatio?: number;
      readonly netPnl: number;
      readonly maxDrawdownPct: number;
      readonly trades: number;
    };

export type InEngineStressRunner<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
> = (
  context: InEngineStressRunnerContext,
) => Promise<TReport> | TReport;

/** Einzelergebnis eines Szenario-Laufs in `runInEngineStress`. */
export interface StressScenarioRun<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
> {
  readonly scenario: CostStressScenario;
  readonly engineConfig: BacktestEngineConfig;
  readonly report: TReport;
  readonly metrics: StressScenarioSummaryRow;
}

/** Eingabe für `runInEngineStress`. */
export interface RunInEngineStressInput<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
> {
  /**
   * Referenz-`BacktestEngineConfig` (bzw. `BacktestEngineOptions`). Falls
   * weggelassen, wird `walkForward.engineConfig` verwendet.
   */
  readonly engineConfig?: BacktestEngineOptions | BacktestEngineConfig | null;
  /**
   * Walk-Forward-Eingabe des Referenzlaufs. Pflicht, wenn der Standard-Runner
   * (`runWalkForward`) genutzt wird; optional bei injiziertem Test-`runner`.
   */
  readonly walkForward?: (Omit<RunWalkForwardInput, "engineConfig"> & {
    readonly engineConfig?: BacktestEngineOptions;
  }) | null;
  /**
   * Zu prüfende Stress-Szenarien (Default: `COST_STRESS_SCENARIOS`).
   */
  readonly scenarios?: readonly CostStressScenario[];
  /**
   * Harte Obergrenze für `Szenarien × Fenster × Kandidaten` (Default:
   * `DEFAULT_MAX_STRESS_RUNS = 45`). Überschreitung ⇒ `{ ok: false, errors }`.
   */
  readonly maxRuns?: number;
  /**
   * Explizite Fensteranzahl für die Budget-Prüfung (überschreibt die Ableitung
   * aus `walkForward.candles`/`windowConfig`).
   */
  readonly windowCount?: number;
  /**
   * Explizite Kandidatenanzahl für die Budget-Prüfung (überschreibt die
   * Ableitung aus `walkForward.strategies.length`).
   */
  readonly candidateCount?: number;
  /** Optionale Schwellenwerte für `summarizeStressSweep`. */
  readonly thresholds?: Partial<StressVerdictThresholds>;
  /**
   * Optionaler Runner-Port (Dependency Injection für deterministische Tests).
   * Default: führt `runWalkForward` pro Szenario aus.
   */
  readonly runner?: InEngineStressRunner<TReport>;
  /**
   * Optionaler Post-hoc-Stress-Auftrag. Wird — falls angegeben — nach dem
   * In-Engine-Sweep separat über `runPostHocStress` berechnet und unter
   * `postHoc` (getrennt von `inEngine`) abgelegt.
   */
  readonly postHoc?: PostHocStressInput | null;
}

/** Erfolgszweig von `runInEngineStress`. */
export interface StressSweepOk<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
> {
  readonly ok: true;
  readonly version: typeof COST_STRESS_VERSION;
  readonly runs: readonly StressScenarioRun<TReport>[];
  readonly scenarios: readonly StressScenarioSummaryRow[];
  readonly summary: StressSummary;
  /**
   * Schicht 1 (In-Engine-Stress) — steht im Report getrennt von `postHoc`.
   */
  readonly inEngine: StressSummary;
  /**
   * Schicht 2 (Post-hoc-Monte-Carlo-Stress) — steht im Report getrennt von
   * `inEngine`; `null`, wenn kein Post-hoc-Lauf angefordert wurde.
   */
  readonly postHoc: MonteCarloResult | null;
  readonly budget: StressRunBudget;
}

/** Fehlerzweig von `runInEngineStress` (fail-closed, kein stilles Hochrechnen). */
export interface StressSweepFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type StressSweepResult<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
> = StressSweepOk<TReport> | StressSweepFailure;

/**
 * Kombinierter Stress-Report mit strikter Trennung zwischen In-Engine-Sweep
 * (`inEngine`) und Post-hoc-Monte-Carlo-Stress (`postHoc`).
 */
export interface StressReport {
  readonly version: typeof COST_STRESS_VERSION;
  readonly inEngine: StressSummary;
  readonly postHoc: MonteCarloResult | readonly MonteCarloResult[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen: Rundung, CLI-Flag `--max-runs`, Konfigurations-Skalierung
// ─────────────────────────────────────────────────────────────────────────────

function round4(value: number): number {
  const r = Number(value.toFixed(4));
  return Object.is(r, -0) ? 0 : r;
}

function scaleFeeRate(rate: number, multiplier: number): number {
  if (multiplier === 1) return rate;
  const scaled = Number((rate * multiplier).toFixed(10));
  return Object.is(scaled, -0) ? 0 : scaled;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parst das CLI-Flag `--max-runs` (Formen `--max-runs=45` und `--max-runs 45`).
 * Default: `DEFAULT_MAX_STRESS_RUNS` (45 = 3 Szenarien × 3 Fenster × 5 Kandidaten).
 * Ungültige oder `<= 0` Werte liefern `{ ok: false, errors }`.
 */
export function parseMaxRunsFlag(
  argv: readonly string[],
  defaultMaxRuns: number = DEFAULT_MAX_STRESS_RUNS,
): { readonly ok: true; readonly maxRuns: number } | StressSweepFailure {
  let foundFlag = false;
  let rawValue: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (arg === "--max-runs") {
      foundFlag = true;
      rawValue = argv[i + 1];
      break;
    }
    if (arg.startsWith("--max-runs=")) {
      foundFlag = true;
      rawValue = arg.slice("--max-runs=".length);
      break;
    }
  }

  if (!foundFlag) {
    if (!Number.isInteger(defaultMaxRuns) || defaultMaxRuns < 1) {
      return {
        ok: false,
        errors: [
          `stress:invalid-max-runs — Default maxRuns (${String(defaultMaxRuns)}) muss eine positive Ganzzahl >= 1 sein.`,
        ],
      };
    }
    return { ok: true, maxRuns: defaultMaxRuns };
  }

  if (rawValue === undefined) {
    return {
      ok: false,
      errors: [
        "stress:invalid-max-runs — CLI-Flag --max-runs erfordert einen ganzzahligen Wert >= 1.",
      ],
    };
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || !/^[+-]?\d+$/.test(trimmed)) {
    return {
      ok: false,
      errors: [
        `stress:invalid-max-runs — CLI-Flag --max-runs erfordert eine positive Ganzzahl (erhalten: "${rawValue}").`,
      ],
    };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      errors: [
        `stress:invalid-max-runs — CLI-Flag --max-runs muss >= 1 sein (erhalten: ${String(parsed)}).`,
      ],
    };
  }

  return { ok: true, maxRuns: parsed };
}

/**
 * Prüft die Kosten- und Slippage-Konfiguration des Referenzlaufs fail-closed.
 *
 * Regeln:
 *   - `slippageModel: "none"` ⇒ Fehler (`stress:slippage-none`), kein stilles
 *     Hochrechnen auf 5/10/20 bp.
 *   - `slippageModel: "fixed"` mit `fixedSlippageBps <= 0` oder
 *     `slippageModel: "spread_relative"` mit `spreadSlippageFactor <= 0` ⇒
 *     Fehler (`stress:slippage-zero`).
 *   - Fehlende/ungültige `feeModel`-Werte oder `makerFee === 0 && takerFee === 0` ⇒
 *     Fehler (`stress:fee-zero`), da `0 × 2 = 0` und `0 × 3 = 0` den
 *     Gebühren-Stress still neutralisieren würden.
 */
export function validateReferenceCostConfig(
  rawConfig: BacktestEngineOptions | BacktestEngineConfig | null | undefined,
): { readonly ok: true; readonly resolved: BacktestEngineConfig } | StressSweepFailure {
  if (!rawConfig || typeof rawConfig !== "object") {
    return {
      ok: false,
      errors: [
        "stress:missing-engine-config — Referenzlauf enthält keine BacktestEngineConfig.",
      ],
    };
  }

  const errors: string[] = [];

  if (rawConfig.slippageModel === "none") {
    errors.push(
      'stress:slippage-none — slippageModel im Referenzlauf ist "none" (0 bp Slippage); kein stilles Hochrechnen auf Stress-Szenarien.',
    );
  } else if (
    rawConfig.slippageModel !== undefined &&
    rawConfig.slippageModel !== "fixed" &&
    rawConfig.slippageModel !== "spread_relative"
  ) {
    errors.push(
      `stress:invalid-slippage-model — Unbekanntes slippageModel "${String(rawConfig.slippageModel)}".`,
    );
  }

  const effectiveSlippageModel =
    rawConfig.slippageModel ?? DEFAULT_BACKTEST_CONFIG.slippageModel;

  if (effectiveSlippageModel === "fixed") {
    const bps = rawConfig.fixedSlippageBps ?? DEFAULT_BACKTEST_CONFIG.fixedSlippageBps;
    if (!isFiniteNumber(bps) || bps <= 0) {
      errors.push(
        `stress:slippage-zero — fixedSlippageBps im Referenzlauf muss > 0 sein (erhalten: ${String(rawConfig.fixedSlippageBps)}).`,
      );
    }
  } else if (effectiveSlippageModel === "spread_relative") {
    const factor =
      rawConfig.spreadSlippageFactor ?? DEFAULT_BACKTEST_CONFIG.spreadSlippageFactor;
    if (!isFiniteNumber(factor) || factor <= 0) {
      errors.push(
        `stress:slippage-zero — spreadSlippageFactor im Referenzlauf muss > 0 sein (erhalten: ${String(rawConfig.spreadSlippageFactor)}).`,
      );
    }
  }

  const rawFeeModel = rawConfig.feeModel ?? DEFAULT_BACKTEST_CONFIG.feeModel;
  if (
    !rawFeeModel ||
    typeof rawFeeModel !== "object" ||
    !isFiniteNumber(rawFeeModel.makerFee) ||
    !isFiniteNumber(rawFeeModel.takerFee)
  ) {
    errors.push(
      "stress:invalid-fee-model — feeModel.makerFee und feeModel.takerFee müssen endliche Zahlen sein.",
    );
  } else if (rawFeeModel.makerFee < 0 || rawFeeModel.takerFee < 0) {
    errors.push(
      `stress:negative-fee — feeModel enthält negative Gebühren (makerFee=${rawFeeModel.makerFee}, takerFee=${rawFeeModel.takerFee}).`,
    );
  } else if (rawFeeModel.makerFee === 0 && rawFeeModel.takerFee === 0) {
    errors.push(
      "stress:fee-zero — feeModel im Referenzlauf hat 0 bp Gebühren (makerFee=0, takerFee=0); kein stilles Hochrechnen mit Multiplikatoren.",
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const resolved: BacktestEngineConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...rawConfig,
    feeModel: {
      makerFee: rawFeeModel.makerFee,
      takerFee: rawFeeModel.takerFee,
    },
    slippageModel: effectiveSlippageModel,
    fixedSlippageBps:
      rawConfig.fixedSlippageBps ?? DEFAULT_BACKTEST_CONFIG.fixedSlippageBps,
    spreadSlippageFactor:
      rawConfig.spreadSlippageFactor ?? DEFAULT_BACKTEST_CONFIG.spreadSlippageFactor,
    executionModel:
      rawConfig.executionModel ?? DEFAULT_BACKTEST_CONFIG.executionModel,
  };

  return { ok: true, resolved };
}

/**
 * Erzeugt die Szenario-spezifische `BacktestEngineConfig` ausschließlich über
 * bestehende Konfigurationsfelder (`feeModel`, `slippageModel`, `fixedSlippageBps`,
 * `executionModel`).
 *
 * Garantien:
 *   - `executionModel` bleibt stets der des Referenzlaufs
 *     (`"legacy" | "paper" | "event_replay"`).
 *   - Für `base` (`id === "base"` und `feeMultiplier === 1`) bleibt die
 *     Referenzkonfiguration unverändert, sodass der `base`-Lauf byte-identisch
 *     zum Referenzlauf ist.
 *   - Für Stress-Szenarien (`double`, `triple`) wird `feeModel` mit
 *     `scenario.feeMultiplier` skaliert und `slippageModel: "fixed"` mit
 *     `fixedSlippageBps: scenario.slippageBps` gesetzt.
 */
export function buildScenarioEngineConfig(
  referenceConfig: BacktestEngineConfig,
  scenario: CostStressScenario,
): BacktestEngineConfig {
  const isBaseScenario =
    scenario.id === "base" &&
    scenario.feeMultiplier === 1 &&
    (referenceConfig.slippageModel !== "fixed" ||
      referenceConfig.fixedSlippageBps === scenario.slippageBps);

  if (isBaseScenario) {
    return {
      ...referenceConfig,
      feeModel: {
        makerFee: referenceConfig.feeModel.makerFee,
        takerFee: referenceConfig.feeModel.takerFee,
      },
    };
  }

  return {
    ...referenceConfig,
    feeModel: {
      makerFee: scaleFeeRate(referenceConfig.feeModel.makerFee, scenario.feeMultiplier),
      takerFee: scaleFeeRate(referenceConfig.feeModel.takerFee, scenario.feeMultiplier),
    },
    slippageModel: "fixed",
    fixedSlippageBps: scenario.slippageBps,
    executionModel: referenceConfig.executionModel,
  };
}

/**
 * Baut die `BacktestEngineOptions` für `runWalkForward` so auf, dass das
 * `base`-Szenario exakt dieselben Schlüssel wie die übergebene Referenz-Option
 * besitzt (damit `configHash`/`freezeHash`/`captureHash` in `WalkForwardReport`
 * auch bei partiellen `BacktestEngineOptions` byte-identisch zum Referenzlauf
 * bleiben).
 */
function buildWalkForwardEngineOptions(
  rawReferenceConfig: BacktestEngineOptions | BacktestEngineConfig,
  resolvedScenarioConfig: BacktestEngineConfig,
  scenario: CostStressScenario,
): BacktestEngineOptions {
  if (scenario.id === "base" && scenario.feeMultiplier === 1) {
    const clone: BacktestEngineOptions = {
      ...rawReferenceConfig,
    };
    if (rawReferenceConfig.feeModel) {
      clone.feeModel = {
        makerFee: rawReferenceConfig.feeModel.makerFee,
        takerFee: rawReferenceConfig.feeModel.takerFee,
      };
    }
    return clone;
  }

  return {
    ...rawReferenceConfig,
    feeModel: {
      makerFee: resolvedScenarioConfig.feeModel.makerFee,
      takerFee: resolvedScenarioConfig.feeModel.takerFee,
    },
    slippageModel: "fixed",
    fixedSlippageBps: scenario.slippageBps,
    executionModel:
      rawReferenceConfig.executionModel ?? resolvedScenarioConfig.executionModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Laufzeit-Budget-Bestimmung
// ─────────────────────────────────────────────────────────────────────────────

function resolveWindowCount<TReport extends InEngineStressRunnerOutput>(
  input: RunInEngineStressInput<TReport>,
): { readonly ok: true; readonly windowCount: number } | StressSweepFailure {
  if (input.windowCount !== undefined) {
    if (!Number.isInteger(input.windowCount) || input.windowCount < 1) {
      return {
        ok: false,
        errors: [
          `stress:invalid-window-count — windowCount muss eine Ganzzahl >= 1 sein (erhalten: ${String(input.windowCount)}).`,
        ],
      };
    }
    return { ok: true, windowCount: input.windowCount };
  }

  const wf = input.walkForward;
  if (wf && Array.isArray(wf.candles) && wf.candles.length >= 2) {
    try {
      const from = wf.candles[0]?.time ?? NaN;
      const to = wf.candles[wf.candles.length - 1]?.time ?? NaN;
      const wfConfig = { ...loadWalkForwardConfig(), ...(wf.walkforward ?? {}) };
      const layout = computeWalkForwardWindows(from, to, wfConfig);
      return { ok: true, windowCount: Math.max(1, layout.windows.length) };
    } catch {
      return { ok: true, windowCount: 1 };
    }
  }

  return { ok: true, windowCount: 1 };
}

function resolveCandidateCount<TReport extends InEngineStressRunnerOutput>(
  input: RunInEngineStressInput<TReport>,
): { readonly ok: true; readonly candidateCount: number } | StressSweepFailure {
  if (input.candidateCount !== undefined) {
    if (!Number.isInteger(input.candidateCount) || input.candidateCount < 1) {
      return {
        ok: false,
        errors: [
          `stress:invalid-candidate-count — candidateCount muss eine Ganzzahl >= 1 sein (erhalten: ${String(input.candidateCount)}).`,
        ],
      };
    }
    return { ok: true, candidateCount: input.candidateCount };
  }

  const candidates = input.walkForward?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    return { ok: true, candidateCount: candidates.length };
  }

  const strategies = input.walkForward?.strategies;
  if (Array.isArray(strategies) && strategies.length > 0) {
    return { ok: true, candidateCount: strategies.length };
  }

  return { ok: true, candidateCount: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrik-Extraktion, Interpolation & Zusammenfassung (`summarizeStressSweep`)
// ─────────────────────────────────────────────────────────────────────────────

function extractScenarioMetrics(
  scenarioId: CostStressScenarioId | string,
  output: InEngineStressRunnerOutput,
): StressScenarioSummaryRow {
  if (
    output &&
    typeof output === "object" &&
    "aggregateOos" in output &&
    output.aggregateOos &&
    typeof output.aggregateOos === "object"
  ) {
    const oos = output.aggregateOos;
    return {
      id: scenarioId,
      sharpe: round4(oos.sharpeRatio),
      netPnl: round4(oos.netPnl),
      maxDrawdownPct: round4(oos.maxDrawdownPct),
      trades: oos.trades,
    };
  }

  const direct = output as {
    readonly sharpe?: number;
    readonly sharpeRatio?: number;
    readonly netPnl: number;
    readonly maxDrawdownPct: number;
    readonly trades: number;
  };
  const rawSharpe = isFiniteNumber(direct.sharpe)
    ? direct.sharpe
    : isFiniteNumber(direct.sharpeRatio)
      ? direct.sharpeRatio
      : 0;

  return {
    id: scenarioId,
    sharpe: round4(rawSharpe),
    netPnl: round4(direct.netPnl),
    maxDrawdownPct: round4(direct.maxDrawdownPct),
    trades: direct.trades,
  };
}

/** Eingabe-Zeile für `summarizeStressSweep` (flexibel für direkte Zeilen oder Lauf-Objekte). */
export type StressSweepSummarizeItem =
  | StressScenarioSummaryRow
  | StressScenarioRun<InEngineStressRunnerOutput>
  | {
      readonly id: CostStressScenarioId | string;
      readonly sharpe?: number;
      readonly sharpeRatio?: number;
      readonly netPnl: number;
      readonly maxDrawdownPct: number;
      readonly trades: number;
      readonly feeMultiplier?: number;
    };

export type StressSweepSummarizeInput =
  | readonly StressSweepSummarizeItem[]
  | { readonly scenarios: readonly StressSweepSummarizeItem[] }
  | { readonly runs: readonly StressScenarioRun<InEngineStressRunnerOutput>[] };

export interface SummarizeStressSweepOptions {
  readonly thresholds?: Partial<StressVerdictThresholds>;
  readonly scenariosConfig?: readonly CostStressScenario[];
}

function normalizeSummaryRows(
  input: StressSweepSummarizeInput,
  scenariosConfig: readonly CostStressScenario[],
): {
  readonly rows: readonly StressScenarioSummaryRow[];
  readonly multipliersById: ReadonlyMap<string, number>;
} {
  const multipliersById = new Map<string, number>();
  for (const s of COST_STRESS_SCENARIOS) {
    multipliersById.set(s.id, s.feeMultiplier);
  }
  for (const s of scenariosConfig) {
    multipliersById.set(s.id, s.feeMultiplier);
  }

  let items: readonly StressSweepSummarizeItem[];
  if (Array.isArray(input)) {
    items = input;
  } else if ("runs" in input && Array.isArray(input.runs)) {
    items = input.runs;
  } else if ("scenarios" in input && Array.isArray(input.scenarios)) {
    items = input.scenarios;
  } else {
    items = [];
  }

  const rows: StressScenarioSummaryRow[] = items.map((item) => {
    if ("scenario" in item && "metrics" in item) {
      multipliersById.set(item.scenario.id, item.scenario.feeMultiplier);
      return {
        id: item.metrics.id,
        sharpe: round4(item.metrics.sharpe),
        netPnl: round4(item.metrics.netPnl),
        maxDrawdownPct: round4(item.metrics.maxDrawdownPct),
        trades: item.metrics.trades,
      };
    }

    if ("feeMultiplier" in item && isFiniteNumber(item.feeMultiplier)) {
      multipliersById.set(item.id, item.feeMultiplier);
    }

    const sharpeVal = isFiniteNumber(item.sharpe)
      ? item.sharpe
      : "sharpeRatio" in item && isFiniteNumber(item.sharpeRatio)
        ? item.sharpeRatio
        : 0;

    return {
      id: item.id,
      sharpe: round4(sharpeVal),
      netPnl: round4(item.netPnl),
      maxDrawdownPct: round4(item.maxDrawdownPct),
      trades: item.trades,
    };
  });

  return { rows, multipliersById };
}

/**
 * Berechnet den Breakeven-Gebührenmultiplikator per linearer Interpolation
 * zwischen benachbarten Stress-Szenarien.
 *
 * Semantik:
 *   - Ist bereits das Basisszenario (`base`, 1×) unprofitabel (`netPnl <= 0`),
 *     wird `1` (bei `netPnl === 0`) bzw. `0` (bei `netPnl < 0`) geliefert.
 *   - Fällt `netPnl` zwischen zwei benachbarten Szenarien `(m_i, pnl_i > 0)`
 *     und `(m_{i+1}, pnl_{i+1} <= 0)` auf oder unter 0, liefert lineare
 *     Interpolation: `m_i + (pnl_i / (pnl_i - pnl_{i+1})) * (m_{i+1} - m_i)`.
 *   - Bleiben alle Szenarien einschließlich `triple` strikt positiv
 *     (`triple.netPnl > 0`), wird `null` zurückgegeben — dokumentiert als
 *     **„hält mindestens 3×"**.
 */
export function computeBreakevenMultiplier(
  rows: readonly StressScenarioSummaryRow[],
  multipliersById?: ReadonlyMap<string, number>,
): number | null {
  if (rows.length === 0) return null;

  const points = rows
    .map((row, idx) => {
      const fallbackMultiplier =
        multipliersById?.get(row.id) ??
        COST_STRESS_SCENARIOS.find((s) => s.id === row.id)?.feeMultiplier ??
        idx + 1;
      return {
        id: row.id,
        multiplier: fallbackMultiplier,
        netPnl: row.netPnl,
      };
    })
    .sort((a, b) => a.multiplier - b.multiplier);

  const first = points[0];
  if (!isFiniteNumber(first.netPnl)) return null;
  if (first.netPnl === 0) return round4(first.multiplier);
  if (first.netPnl < 0) return 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const curr = points[i];
    const next = points[i + 1];
    if (!isFiniteNumber(curr.netPnl) || !isFiniteNumber(next.netPnl)) {
      return null;
    }
    if (curr.netPnl > 0 && next.netPnl <= 0) {
      const span = curr.netPnl - next.netPnl;
      if (span <= 0) return round4(curr.multiplier);
      const interpolated =
        curr.multiplier + (curr.netPnl / span) * (next.multiplier - curr.multiplier);
      return round4(interpolated);
    }
  }

  const last = points[points.length - 1];
  if (isFiniteNumber(last.netPnl) && last.netPnl > 0) {
    // `triple` (bzw. höchstes Szenario) noch positiv ⇒ „hält mindestens 3×"
    return null;
  }

  return round4(last.multiplier);
}

/**
 * Verdichtet die Szenario-Ergebnisse zu `StressSummary` (`degradationRatio`,
 * `breakevenMultiplier`, `verdict`).
 */
export function summarizeStressSweep(
  results: StressSweepSummarizeInput,
  options?: SummarizeStressSweepOptions,
): StressSummary {
  const thresholds: StressVerdictThresholds = {
    ...DEFAULT_STRESS_VERDICT_THRESHOLDS,
    ...(options?.thresholds ?? {}),
  };
  const scenariosConfig = options?.scenariosConfig ?? COST_STRESS_SCENARIOS;
  const { rows, multipliersById } = normalizeSummaryRows(results, scenariosConfig);

  const baseRow = rows.find((r) => r.id === "base") ?? rows[0];
  const tripleRow =
    rows.find((r) => r.id === "triple") ??
    (rows.length >= 2 ? rows[rows.length - 1] : undefined);

  let degradationRatio: number | null = null;
  if (
    baseRow &&
    tripleRow &&
    isFiniteNumber(baseRow.sharpe) &&
    isFiniteNumber(tripleRow.sharpe) &&
    baseRow.sharpe > 0
  ) {
    degradationRatio = round4(tripleRow.sharpe / baseRow.sharpe);
  }

  const breakevenMultiplier = computeBreakevenMultiplier(rows, multipliersById);

  const tripleProfitable =
    tripleRow !== undefined &&
    isFiniteNumber(tripleRow.netPnl) &&
    tripleRow.netPnl > thresholds.minTripleNetPnl;

  let verdict: StressVerdict;
  if (degradationRatio === null || degradationRatio < thresholds.sensitiveMinRatio) {
    verdict = "COST_DEPENDENT";
  } else if (degradationRatio >= thresholds.robustMinRatio && tripleProfitable) {
    verdict = "COST_ROBUST";
  } else {
    verdict = "COST_SENSITIVE";
  }

  return {
    scenarios: rows,
    degradationRatio,
    breakevenMultiplier,
    verdict,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schicht 1: In-Engine-Stress-Runner (`runInEngineStress`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Führt den In-Engine-Cost- & Slippage-Stress-Sweep über `COST_STRESS_SCENARIOS`
 * (`base`, `double`, `triple`) aus.
 *
 * Verhalten:
 *   - Prüft vorab `slippageModel` und `feeModel` des Referenzlaufs fail-closed
 *     (bei `slippageModel: "none"` ⇒ `{ ok: false, errors }`, 0 Läufe).
 *   - Prüft vorab das Laufzeit-Budget `Szenarien × Fenster × Kandidaten <= maxRuns`
 *     (Default `maxRuns = 45`; Überschreitung ⇒ `{ ok: false, errors }`, 0 Läufe).
 *   - Führt pro Szenario genau einen Walk-Forward-Lauf mit angepasstem
 *     `BacktestEngineConfig` aus (`executionModel` bleibt unverändert).
 *   - Verdichtet die Ergebnisse über `summarizeStressSweep` und hält `inEngine`
 *     und `postHoc` im Rückgabe-Report strikt getrennt.
 */
export async function runInEngineStress<
  TReport extends InEngineStressRunnerOutput = WalkForwardReport,
>(
  input: RunInEngineStressInput<TReport>,
): Promise<StressSweepResult<TReport>> {
  const scenarios = input.scenarios ?? COST_STRESS_SCENARIOS;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return {
      ok: false,
      errors: [
        "stress:empty-scenarios — Mindestens ein Stress-Szenario ist erforderlich.",
      ],
    };
  }

  const maxRuns = input.maxRuns ?? DEFAULT_MAX_STRESS_RUNS;
  if (!Number.isInteger(maxRuns) || maxRuns < 1) {
    return {
      ok: false,
      errors: [
        `stress:invalid-max-runs — maxRuns muss eine positive Ganzzahl >= 1 sein (erhalten: ${String(maxRuns)}).`,
      ],
    };
  }

  const windowRes = resolveWindowCount(input);
  if (!windowRes.ok) return windowRes;

  const candidateRes = resolveCandidateCount(input);
  if (!candidateRes.ok) return candidateRes;

  const scenarioCount = scenarios.length;
  const { windowCount } = windowRes;
  const { candidateCount } = candidateRes;
  const plannedRuns = scenarioCount * windowCount * candidateCount;

  if (plannedRuns > maxRuns) {
    return {
      ok: false,
      errors: [
        `stress:max-runs-exceeded — Geplante Läufe (${scenarioCount} Szenarien × ${windowCount} Fenster × ${candidateCount} Kandidaten = ${plannedRuns}) überschreiten das harte Limit maxRuns (${maxRuns}).`,
      ],
    };
  }

  const rawReferenceConfig =
    input.engineConfig ?? input.walkForward?.engineConfig ?? null;
  const configValidation = validateReferenceCostConfig(rawReferenceConfig);
  if (!configValidation.ok) {
    return configValidation;
  }

  const referenceConfig = configValidation.resolved;

  if (!input.runner && !input.walkForward) {
    return {
      ok: false,
      errors: [
        "stress:missing-walkforward-input — Ohne injizierten runner muss walkForward angegeben werden.",
      ],
    };
  }

  // Stabiler Zeitstempel über alle Szenarien, damit `base` und Referenzlauf
  // auch ohne explizites `nowMs` deterministisch dieselbe `createdAt` teilen.
  const deterministicNowMs = input.walkForward?.nowMs ?? Date.now();

  const runs: StressScenarioRun<TReport>[] = [];

  try {
    for (const scenario of scenarios) {
      const scenarioEngineConfig = buildScenarioEngineConfig(
        referenceConfig,
        scenario,
      );

      let walkForwardInput: RunWalkForwardInput | undefined;
      if (input.walkForward) {
        const wfEngineOptions = buildWalkForwardEngineOptions(
          rawReferenceConfig!,
          scenarioEngineConfig,
          scenario,
        );
        walkForwardInput = {
          ...input.walkForward,
          engineConfig: wfEngineOptions,
          nowMs: input.walkForward.nowMs ?? deterministicNowMs,
        };
      }

      const context: InEngineStressRunnerContext = {
        scenario,
        engineConfig: scenarioEngineConfig,
        config: scenarioEngineConfig,
        ...(walkForwardInput ? { walkForwardInput } : {}),
      };

      const report: TReport = input.runner
        ? await input.runner(context)
        : (runWalkForward(walkForwardInput!) as unknown as TReport);

      const metrics = extractScenarioMetrics(scenario.id, report);
      runs.push({
        scenario,
        engineConfig: scenarioEngineConfig,
        report,
        metrics,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`stress:runner-error — ${message}`],
    };
  }

  const summary = summarizeStressSweep(runs, {
    thresholds: input.thresholds,
    scenariosConfig: scenarios,
  });

  let postHocResult: MonteCarloResult | null = null;
  if (input.postHoc) {
    try {
      postHocResult = runPostHocStress(input.postHoc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errors: [`stress:posthoc-error — ${message}`],
      };
    }
  }

  return {
    ok: true,
    version: COST_STRESS_VERSION,
    runs,
    scenarios: summary.scenarios,
    summary,
    inEngine: summary,
    postHoc: postHocResult,
    budget: {
      scenarioCount,
      windowCount,
      candidateCount,
      plannedRuns,
      executedRuns: runs.length * windowCount * candidateCount,
      maxRuns,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schicht 2: Post-hoc-Stress (`runPostHocStress`) — dünner Adapter auf MC
// ─────────────────────────────────────────────────────────────────────────────

export type PostHocTradeRecord =
  | MonteCarloTradeInput
  | BacktestTradeLog
  | WalkForwardTradeRecord;

export interface PostHocStressOptions {
  readonly sourceRunId?: string;
  readonly stress?: MonteCarloStressConfig | null;
  readonly feeMultiplier?: number;
  readonly slippageMultiplier?: number;
  readonly config?: Partial<Omit<MonteCarloConfig, "stress">>;
  readonly method?: MonteCarloMethod;
  readonly runs?: number;
  readonly seed?: number;
  readonly blockLength?: number | null;
  readonly segment?: MonteCarloSegmentFilter;
  readonly initialEquity?: number;
  readonly ruinThresholdPct?: number;
  readonly mcRunner?: typeof runMonteCarloSimulation;
}

export interface PostHocStressInput extends PostHocStressOptions {
  readonly trades: readonly PostHocTradeRecord[];
}

function isMonteCarloTradeInput(trade: PostHocTradeRecord): trade is MonteCarloTradeInput {
  return (
    typeof trade === "object" &&
    trade !== null &&
    "seq" in trade &&
    "pnlNet" in trade &&
    "entryTs" in trade &&
    "exitTs" in trade
  );
}

function isWalkForwardTradeRecord(
  trade: PostHocTradeRecord,
): trade is WalkForwardTradeRecord {
  return (
    typeof trade === "object" &&
    trade !== null &&
    "trade" in trade &&
    "segment" in trade &&
    typeof trade.trade === "object" &&
    trade.trade !== null
  );
}

/**
 * Konvertiert `BacktestTradeLog[]` oder `WalkForwardTradeRecord[]` bei Bedarf
 * in kanonische `MonteCarloTradeInput[]`. Bereits kanonische
 * `MonteCarloTradeInput[]` werden unverändert durchgereicht.
 */
export function toMonteCarloTrades(
  trades: readonly PostHocTradeRecord[],
  segment: MonteCarloSegmentFilter = "OOS",
): readonly MonteCarloTradeInput[] {
  if (trades.length === 0) return [];
  if (trades.every(isMonteCarloTradeInput)) {
    return trades;
  }

  const rawLogs: BacktestTradeLog[] = [];
  for (const item of trades) {
    if (isWalkForwardTradeRecord(item)) {
      if (segment === "ALL" || item.segment === segment) {
        rawLogs.push(item.trade);
      }
    } else if (!isMonteCarloTradeInput(item)) {
      rawLogs.push(item);
    }
  }

  return rawLogs.map((log, index): MonteCarloTradeInput => ({
    seq: index + 1,
    symbol: log.symbol,
    strategyId: log.strategyId,
    entryTs: log.entryTime,
    exitTs: log.exitTime,
    pnlNet: log.pnl,
    fees: log.fees,
    slippage: log.slippage,
    notional: log.notional,
  }));
}

/**
 * Dünner Post-hoc-Stress-Adapter: reicht das Trade-Log ohne eigene
 * Monte-Carlo-Logik an `runMonteCarloSimulation` (`src/backtest/montecarlo.ts`)
 * mit `stress: { feeMultiplier, slippageMultiplier }` durch.
 *
 * Unterstützt sowohl `runPostHocStress({ trades, stress, ... })` als auch
 * `runPostHocStress(trades, { feeMultiplier, slippageMultiplier, ... })`.
 */
export function runPostHocStress(
  inputOrTrades: PostHocStressInput | readonly PostHocTradeRecord[],
  options?: PostHocStressOptions,
): MonteCarloResult {
  const input: PostHocStressInput = Array.isArray(inputOrTrades)
    ? { ...(options ?? {}), trades: inputOrTrades }
    : (inputOrTrades as PostHocStressInput);

  const segment: MonteCarloSegmentFilter =
    input.segment ?? input.config?.segment ?? "OOS";
  const mcTrades = toMonteCarloTrades(input.trades, segment);

  let stress: MonteCarloStressConfig | null = null;
  if (input.stress !== undefined && input.stress !== null) {
    const { feeMultiplier, slippageMultiplier } = input.stress;
    // `resolveMonteCarloConfig` weist `{ feeMultiplier: 1, slippageMultiplier: 1 }`
    // als No-Op zurück und verlangt `stress: null` für das 1×-Basisszenario.
    stress =
      feeMultiplier === 1 && slippageMultiplier === 1
        ? null
        : { feeMultiplier, slippageMultiplier };
  } else if (
    input.feeMultiplier !== undefined ||
    input.slippageMultiplier !== undefined
  ) {
    const feeMultiplier = input.feeMultiplier ?? 1;
    const slippageMultiplier = input.slippageMultiplier ?? 1;
    stress =
      feeMultiplier === 1 && slippageMultiplier === 1
        ? null
        : { feeMultiplier, slippageMultiplier };
  }

  const method: MonteCarloMethod =
    input.method ?? input.config?.method ?? "iid";

  const config: MonteCarloConfig = {
    ...(input.config ?? {}),
    method,
    ...(input.runs !== undefined ? { runs: input.runs } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.blockLength !== undefined ? { blockLength: input.blockLength } : {}),
    ...(input.segment !== undefined ? { segment: input.segment } : {}),
    ...(input.initialEquity !== undefined
      ? { initialEquity: input.initialEquity }
      : {}),
    ...(input.ruinThresholdPct !== undefined
      ? { ruinThresholdPct: input.ruinThresholdPct }
      : {}),
    stress,
  };

  const runner = input.mcRunner ?? runMonteCarloSimulation;
  return runner({
    sourceRunId: input.sourceRunId ?? "stress-posthoc-source",
    trades: mcTrades,
    config,
  });
}

/**
 * Baut den kombinierten Stress-Report, in dem In-Engine-Ergebnis (`inEngine`)
 * und Post-hoc-Ergebnis (`postHoc`) strikt getrennt nebeneinander stehen.
 */
export function buildStressReport(input: {
  readonly inEngine: StressSummary;
  readonly postHoc?: MonteCarloResult | readonly MonteCarloResult[] | null;
}): StressReport {
  return {
    version: COST_STRESS_VERSION,
    inEngine: input.inEngine,
    postHoc: input.postHoc ?? null,
  };
}

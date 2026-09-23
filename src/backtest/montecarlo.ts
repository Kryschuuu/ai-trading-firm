/**
 * Reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse (RMA-P6-02, v1.72.0).
 *
 * Simuliert aus einem verifizierten Walk-Forward-Trade-Ledger
 * (`backtest_trades`, RMA-P1-04) reproducible Pfade und berichtet robuste
 * Quantile für Drawdown, Ruin, Sharpe, End-Equity und Losing Streak.
 *
 * Modell (alle Annahmen sind Teil des Ergebnisses — `summary.caveats`):
 *   - **Renditebasis:** Trade i trägt die Equity-Rendite
 *     `r_i = pnlNet_i / E_{i-1}`, wobei `E_k` die REALISIERTE Equity der
 *     Quelle ist (`E_0 = initialEquity`, `E_k = E_0 + Σ_{j≤k} pnlNet_j`;
 *     Teleskop: `Π(1 + r_i)` reproduziert den Quellpfad exakt). Die Engine
 *     sizingt live auf aktueller Equity inkl. unrealisiertem PnL — die
 *     realisierte Basis ist die beste aus dem Ledger rekonstruierbare
 *     Näherung (dokumentierte Resampling-Annahme, keine Engine-Reprise).
 *   - **Methoden:** IID-Trade-Bootstrap, Moving-Block-Bootstrap (überlappende
 *     Blöcke, abgeschnitten auf den Horizont) und Stationary-Block-Bootstrap
 *     (Politis/Romano, zirkulär, Restart-Wahrscheinlichkeit 1/L). Horizont
 *     je Pfad = Stichprobengröße n (gleiche Trade-Anzahl wie die Quelle).
 *   - **Kostenstress:** `feeMultiplier`/`slippageMultiplier` ≥ 1 ziehen je
 *     Trade EXPLIZIT zusätzliche Kosten ab
 *     (`pnl' = pnlNet − fees·(m_fee−1) − slippage·(m_slip−1)`) — First-Order-
 *     Approximation auf FESTER Trade-Sequenz und fester Exposurbasis (kein
 *     Re-Sizing, keine Re-Signalisierung, kein Ersatz für einen echten
 *     Stress-Backtest).
 *   - **Ruin:** Equity fällt strikt unter `ruinThresholdPct %` des
 *     Startkapitals (Default 50 %). Equity ≤ 0 ⇒ Konto gewiped (Equity bleibt
 *     0; MaxDD = 100 %). Losing-Streak/Sharpe werden über die VOLLSTÄNDIG
 *     gezogene Trade-Sequenz gemessen (auch nach Wipe — die gezogenen
 *     Trade-Ergebnisse bleiben definiert).
 *   - **Sharpe:** Trade-Level-Sharpe über denselben Kernel wie Portfolio/
 *     Backtest (`sharpeRatio`, rf = 0), annualisiert mit `n / Spanne(Jahre)`
 *     aus den Ledger-Ereigniszeiten (Entry-/Exit-Zeitstempel). Die Zeitstempel
 *     dienen NUR der Annualisierungsskalierung — kein Look-ahead: Die Quelle
 *     ist ein unveränderlicher, append-only Run; die Simulation liest
 *     ausschließlich dessen Trades.
 *
 * Determinismus: gleiche (Trades, Config, Seed) ⇒ byte-identisches Summary.
 * PRNG ist der Repository-Kernel `mulberry32` (`src/lib/marketdata/prng.ts`,
 * Version `mulberry32-v1`), EIN sequenzieller Stream pro Simulation (feste
 * Ziehungsreihenfolge: Pfad für Pfad, Trade für Trade). Quantile sind
 * Nearest-Rank (Typ 1, invertierte empirische CDF — keine Interpolation).
 *
 * Fail-closed: fehlende/ invalide/ inkompatible Eingaben werden ABGELEHNT
 * (nie still als 0 behandelt): Mindeststichprobe 30 Trades, kontinuerte
 * `seq`-Ordnung, ein Symbol je Analyse, positive realisierte Quell-Equity,
 * ableitbare Spanne. `null`/unbekannt existiert in dieser reinen Funktion
 * als Fehler, nicht als neutraler Zahlenwert.
 *
 * Kein Live-Release: Diese Analyse ist Research. KEINE Zeile hier fließt in
 * Risk-Ceilings, Kill-Switches, Authority Chains oder Live-Gates — die
 * Ergebnisse sind bewusst nicht mit dem Risikosystem verdrahtet.
 *
 * Schichtung: alles hier ist rein (kein IO, ohne Datenbank testbar); die
 * Ledger-Quelle und Persistenz liegen in `./monteCarloStore.ts`.
 */

import { createHash } from "node:crypto";
import { createRng } from "../lib/marketdata/prng";
import { sharpeRatio } from "../portfolio/metrics";
import { stableStringify } from "../lib/ruleEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten & Bounds
// ─────────────────────────────────────────────────────────────────────────────

/** Versionierung der Simulationsmathematik (Teil des Idempotency-Keys). */
export const MC_ALGORITHM_VERSION = "mc1" as const;

/** Version des PRNG (persistiert mit jedem Lauf). */
export const MC_PRNG_ALGORITHM = "mulberry32-v1" as const;

/**
 * Mindeststichprobe: unter 30 Trades ist ein Bootstrap statistisch nicht
 * sinnvoll interpretierbar — die Analyse wird abgelehnt statt Scheingenauigkeit
 * zu erzeugen.
 */
export const MC_MIN_SAMPLE_TRADES = 30;

/** Anzahl simulierter Pfade: Bounds + Default. */
export const MC_RUNS_BOUNDS = { min: 100, max: 100_000, default: 1_000 } as const;

/** Seed-Bereich (uint32, kompatibel zu `normalizeSeed`/mulberry32). */
export const MC_SEED_BOUNDS = { min: 0, max: 4_294_967_295 } as const;

/** Ruin-Schwelle in Prozent des Startkapitals: (0, 100]. */
export const MC_RUIN_THRESHOLD_PCT_BOUNDS = { minExclusive: 0, max: 100 } as const;

/** Startkapital: > 0, harte Obergrenze gegen Datenmüll. */
export const MC_INITIAL_EQUITY_BOUNDS = { minExclusive: 0, max: 1e12 } as const;

/** Kostenstress-Multiplikatoren: ≥ 1 (1 = unverändert), Obergrenze gegen Absurdia. */
export const MC_STRESS_MULTIPLIER_BOUNDS = { min: 1, max: 100 } as const;

/** Blocklänge für Block-Bootstrap: ≥ 2 (1 degeneriert zu IID) und ≤ n. */
export const MC_BLOCK_LENGTH_BOUNDS = { min: 2 } as const;

/** Feste, bounded Drawdown-Exceedance-Schwellen (Prozent MaxDD). */
export const MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT = [10, 20, 30, 50] as const;

/** Berichtete Quantile (Nearest-Rank). */
export const MC_QUANTILE_LEVELS = [0.05, 0.5, 0.95] as const;

/** Jahreslänge in ms — 24/7-Krypto-Konvention (8760 h, wie Backtest-Metriken). */
export const MC_MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Annualisierungsgrenze (Trades/Jahr). Obergrenze = Kernel-Bound
 * (`validateAnnualization` ≤ 200 000). Außerhalb ⇒ Abweisung (fail-closed),
 * kein stilles Klemmen — Extremwerte bedeuten kaputte Ereigniszeiten.
 */
export const MC_TRADES_PER_YEAR_BOUNDS = { min: 1, max: 200_000 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Fehler
// ─────────────────────────────────────────────────────────────────────────────

/** Fehlercodes der Monte-Carlo-Analyse (maschinenlesbar, Muster `mc:`). */
export type MonteCarloErrorCode =
  | "mc:invalid-config"
  | "mc:invalid-trades"
  | "mc:insufficient-sample"
  | "mc:mixed-symbols"
  | "mc:source-ruined"
  | "mc:span-not-derivable"
  | "mc:empty-sample";

export class MonteCarloError extends Error {
  constructor(
    public readonly code: MonteCarloErrorCode,
    message: string,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MonteCarloError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

/** Resampling-Methode. */
export type MonteCarloMethod = "iid" | "moving_block" | "stationary_block";

/** Segment-Filter auf dem Quell-Ledger (Default `OOS` — empfohlene Basis). */
export type MonteCarloSegmentFilter = "OOS" | "IS" | "ALL";

/**
 * Ein Trade der Analyse (aus `backtest_trades`; Zahlen in Kontowährung).
 * `pnlNet` ist NETTO (Brutto − Gebühren + Funding; Kontosicht: Funding
 * negativ = gezahlt). `fees`/`slippage` ≥ 0 sind die Basis des
 * Kostenstressszenarios, `notional` die Exposurebasis des Trades.
 */
export interface MonteCarloTradeInput {
  /** Stabile Reihenfolge im Quell-Run (1..N, kanonisch aufsteigend). */
  seq: number;
  symbol: string;
  strategyId: string;
  /** Ereigniszeit des Entries (ms). */
  entryTs: number;
  /** Ereigniszeit des Exits (ms). */
  exitTs: number;
  pnlNet: number;
  fees: number;
  slippage: number;
  notional: number;
}

/** Kostenstressszenario (beide Multiplikatoren ≥ 1; mindestens einer > 1). */
export interface MonteCarloStressConfig {
  feeMultiplier: number;
  slippageMultiplier: number;
}

/** Konfiguration eines Laufs (unresolved; Defaults siehe `resolveMonteCarloConfig`). */
export interface MonteCarloConfig {
  method: MonteCarloMethod;
  /** uint32-Seed; Default 1. Deterministische Basis jedes Laufs. */
  seed?: number;
  /** Anzahl Pfade; Default 1 000, Bounds [100, 100 000]. */
  runs?: number;
  /** Pflicht für Block-Methoden (2..n); für `iid` verboten (null). */
  blockLength?: number | null;
  /** Segment-Filter der Quelle; Default `OOS`. */
  segment?: MonteCarloSegmentFilter;
  /** Startkapital der Pfade (> 0); Default 10 000 (Engine-Default). */
  initialEquity?: number;
  /** Ruin-Schwelle in % des Startkapitals ((0, 100]); Default 50. */
  ruinThresholdPct?: number;
  /** Kostenstress; null/undefiniert = Basisszenario. */
  stress?: MonteCarloStressConfig | null;
}

/** Vollständig aufgelöste, persistierbare Konfiguration (reproduzierbar). */
export interface ResolvedMonteCarloConfig {
  method: MonteCarloMethod;
  seed: number;
  runs: number;
  blockLength: number | null;
  segment: MonteCarloSegmentFilter;
  initialEquity: number;
  ruinThresholdPct: number;
  stress: MonteCarloStressConfig | null;
  prngAlgorithm: typeof MC_PRNG_ALGORITHM;
  algorithmVersion: typeof MC_ALGORITHM_VERSION;
  quantileLevels: readonly number[];
  drawdownExceedanceThresholdsPct: readonly number[];
}

/** Quantil- und Mittelwert-Zusammenfassung einer Pfadmetrik. */
export interface MonteCarloMetricSummary {
  p05: number;
  p50: number;
  p95: number;
  mean: number;
}

/** Exceedance-Wahrscheinlichkeiten (alle Schätzer über `runs` Pfade). */
export interface MonteCarloExceedanceSummary {
  /** P(Pfad ruiniert): Equity strikt unter der Ruin-Schwelle. */
  ruinProbability: number;
  /** P(End-Equity < Startkapital). */
  endBelowStartProbability: number;
  /** P(MaxDD ≥ Schwelle) für feste, bounded Schwellen. */
  maxDrawdownGtePct: ReadonlyArray<{ thresholdPct: number; probability: number }>;
}

/** Statistik-Hinweise: Stichprobe, Blockannahme, Runzahl, Grenzen. */
export interface MonteCarloStatsSummary {
  /** Größe der Quell-Stichprobe (nach Segment-Filter). */
  sampleTrades: number;
  /** Horizont je Pfad in Trades (= Stichprobengröße). */
  horizonTrades: number;
  /** Anzahl simulierter Pfade. */
  runs: number;
  /** Anzahl gezogener Blöcke über alle Pfade (IID: Einhandel-Ziehungen). */
  blocksDrawn: number;
  /** Anzahl distinkter Strategie-IDs in der Stichprobe (nur Hinweis, kein Gate). */
  distinctStrategies: number;
  /** Symbole in der Stichprobe (immer 1 — gemischte Runs werden abgelehnt). */
  symbols: number;
  /** Annualisierungsfaktor Trades/Jahr aus der Quell-Spanne (immer ableitbar — außerhalb der Bounds wird fail-closed abgelehnt). */
  annualizationTradesPerYear: number;
  scenario: "baseline" | "stress";
  stress: MonteCarloStressConfig | null;
  method: MonteCarloMethod;
  blockLength: number | null;
  seed: number;
  prngAlgorithm: string;
  algorithmVersion: string;
}

/** Empirische Beobachtung der Quelle in Original-Reihenfolge (KEIN Resampling). */
export interface MonteCarloObservedSummary {
  endEquity: number;
  maxDrawdownPct: number;
  losingStreak: number;
  sharpeRatio: number;
  ruined: boolean;
}

/** Bounded Gesamtergebnis — KEINE Rohpfade (die bleiben allein im Speicher). */
export interface MonteCarloSummary {
  /** Empirische Beobachtung: tatsächliche Netto-Trades der Quelle. */
  observed: MonteCarloObservedSummary;
  /**
   * Nur bei Szenario `stress`: derselbe First-Order-Kostenstress auf die
   * ORIGINAL-Sequenz (kein Resampling) — Anker für den Vergleich mit
   * `observed`. Bei `baseline` null.
   */
  observedStressed: MonteCarloObservedSummary | null;
  /** Resampling-Verteilungen unter der Szenario-Annahme. */
  resampled: {
    endEquity: MonteCarloMetricSummary;
    maxDrawdownPct: MonteCarloMetricSummary;
    sharpeRatio: MonteCarloMetricSummary;
    losingStreak: MonteCarloMetricSummary;
    exceedance: MonteCarloExceedanceSummary;
    /** Monte-Carlo-Standardfehler (binomial) der Wahrscheinlichkeitsschätzer. */
    mcse: { ruinProbability: number; endBelowStartProbability: number };
  };
  stats: MonteCarloStatsSummary;
  /** Konstante, bounded Hinweise (kein Freitext, keine IDs). */
  caveats: string[];
}

/** Ergebnis eines Laufs: referenziert Quelle, Seed, Config — reproduzierbar. */
export interface MonteCarloResult {
  sourceRunId: string;
  config: ResolvedMonteCarloConfig;
  /** sha256 über die kanonische (gefilterte) Eingabe-Stichprobe. */
  inputTradesHash: string;
  /** Stabiler Schlüssel `mcs1:<sha256>` über Identität + Config + Hash. */
  idempotencyKey: string;
  summary: MonteCarloSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validierung (rein, fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

const METHODS: readonly MonteCarloMethod[] = ["iid", "moving_block", "stationary_block"];
const SEGMENTS: readonly MonteCarloSegmentFilter[] = ["OOS", "IS", "ALL"];

function invalidConfig(message: string, detail: Record<string, unknown> = {}): MonteCarloError {
  return new MonteCarloError("mc:invalid-config", message, detail);
}

/**
 * Löst die Config auf (Defaults) und validiert alle Bounds.
 * `blockLength ≤ n` wird erst nach der Stichproben-Eligibility geprüft
 * (siehe `runMonteCarloSimulation`).
 */
export function resolveMonteCarloConfig(config: MonteCarloConfig): ResolvedMonteCarloConfig {
  if (!METHODS.includes(config.method)) {
    throw invalidConfig(`Methode '${String(config.method)}' ist unbekannt (erlaubt: ${METHODS.join(", ")}).`);
  }
  const seed = config.seed ?? 1;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < MC_SEED_BOUNDS.min || seed > MC_SEED_BOUNDS.max) {
    throw invalidConfig(
      `Seed muss eine ganze Zahl in [${MC_SEED_BOUNDS.min}, ${MC_SEED_BOUNDS.max}] sein (erhalten: ${String(config.seed)}).`
    );
  }
  const runs = config.runs ?? MC_RUNS_BOUNDS.default;
  if (!Number.isInteger(runs) || runs < MC_RUNS_BOUNDS.min || runs > MC_RUNS_BOUNDS.max) {
    throw invalidConfig(
      `runs muss eine ganze Zahl in [${MC_RUNS_BOUNDS.min}, ${MC_RUNS_BOUNDS.max}] sein (erhalten: ${String(config.runs)}).`
    );
  }
  const segment = config.segment ?? "OOS";
  if (!SEGMENTS.includes(segment)) {
    throw invalidConfig(`Segment '${String(config.segment)}' ist unbekannt (erlaubt: ${SEGMENTS.join(", ")}).`);
  }
  const initialEquity = config.initialEquity ?? 10_000;
  if (
    typeof initialEquity !== "number" ||
    !Number.isFinite(initialEquity) ||
    initialEquity <= MC_INITIAL_EQUITY_BOUNDS.minExclusive ||
    initialEquity > MC_INITIAL_EQUITY_BOUNDS.max
  ) {
    throw invalidConfig(
      `initialEquity muss endlich und in (${MC_INITIAL_EQUITY_BOUNDS.minExclusive}, ${MC_INITIAL_EQUITY_BOUNDS.max}] liegen (erhalten: ${String(config.initialEquity)}).`
    );
  }
  const ruinThresholdPct = config.ruinThresholdPct ?? 50;
  if (
    typeof ruinThresholdPct !== "number" ||
    !Number.isFinite(ruinThresholdPct) ||
    ruinThresholdPct <= MC_RUIN_THRESHOLD_PCT_BOUNDS.minExclusive ||
    ruinThresholdPct > MC_RUIN_THRESHOLD_PCT_BOUNDS.max
  ) {
    throw invalidConfig(
      `ruinThresholdPct muss in (${MC_RUIN_THRESHOLD_PCT_BOUNDS.minExclusive}, ${MC_RUIN_THRESHOLD_PCT_BOUNDS.max}] liegen (erhalten: ${String(config.ruinThresholdPct)}).`
    );
  }

  let blockLength: number | null = null;
  if (config.method === "iid") {
    if (config.blockLength !== undefined && config.blockLength !== null) {
      throw invalidConfig("Methode 'iid' akzeptiert keine blockLength (nur moving_block/stationary_block).");
    }
  } else {
    if (config.blockLength === undefined || config.blockLength === null) {
      throw invalidConfig(`Methode '${config.method}' erfordert blockLength (≥ ${MC_BLOCK_LENGTH_BOUNDS.min}).`);
    }
    if (
      typeof config.blockLength !== "number" ||
      !Number.isInteger(config.blockLength) ||
      config.blockLength < MC_BLOCK_LENGTH_BOUNDS.min
    ) {
      throw invalidConfig(
        `blockLength muss eine ganze Zahl ≥ ${MC_BLOCK_LENGTH_BOUNDS.min} sein (erhalten: ${String(config.blockLength)}).`
      );
    }
    blockLength = config.blockLength;
  }

  let stress: MonteCarloStressConfig | null = null;
  if (config.stress !== undefined && config.stress !== null) {
    const { feeMultiplier, slippageMultiplier } = config.stress;
    for (const [name, value] of [
      ["feeMultiplier", feeMultiplier],
      ["slippageMultiplier", slippageMultiplier],
    ] as const) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < MC_STRESS_MULTIPLIER_BOUNDS.min ||
        value > MC_STRESS_MULTIPLIER_BOUNDS.max
      ) {
        throw invalidConfig(
          `stress.${name} muss in [${MC_STRESS_MULTIPLIER_BOUNDS.min}, ${MC_STRESS_MULTIPLIER_BOUNDS.max}] liegen (erhalten: ${String(value)}).`
        );
      }
    }
    if (feeMultiplier === 1 && slippageMultiplier === 1) {
      throw invalidConfig(
        "Stress-Szenario mit feeMultiplier = slippageMultiplier = 1 ist ein No-Op — entweder einen Multiplikator > 1 setzen oder stress weglassen (Basisszenario)."
      );
    }
    stress = { feeMultiplier, slippageMultiplier };
  }

  return {
    method: config.method,
    seed,
    runs,
    blockLength,
    segment,
    initialEquity,
    ruinThresholdPct,
    stress,
    prngAlgorithm: MC_PRNG_ALGORITHM,
    algorithmVersion: MC_ALGORITHM_VERSION,
    quantileLevels: MC_QUANTILE_LEVELS,
    drawdownExceedanceThresholdsPct: MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stichproben-Eligibility (rein)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prüft die (bereits segment-gefilterte, nach `seq` sortierte) Stichprobe:
 * Endlichkeit, Vorzeichen, Ereigniszeit-Ordnung, ein Symbol, Mindestgröße.
 * Die Eingabe wird NICHT mutiert (auch nicht sortiert).
 */
export function validateMonteCarloSample(
  trades: readonly MonteCarloTradeInput[]
): { ok: true; sampleSize: number } | { ok: false; error: MonteCarloError } {
  if (trades.length === 0) {
    return { ok: false, error: new MonteCarloError("mc:empty-sample", "Stichprobe ist leer (Segment-Filter ohne Treffer).") };
  }
  if (trades.length < MC_MIN_SAMPLE_TRADES) {
    return {
      ok: false,
      error: new MonteCarloError(
        "mc:insufficient-sample",
        `Stichprobe zu klein: ${trades.length} Trades (Mindestens ${MC_MIN_SAMPLE_TRADES}) — Bootstrap-Quantile wären Scheingenauigkeit.`,
        { sampleTrades: trades.length, minimum: MC_MIN_SAMPLE_TRADES }
      ),
    };
  }
  const symbols = new Set<string>();
  let prevSeq = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (typeof t.seq !== "number" || !Number.isInteger(t.seq) || t.seq <= prevSeq) {
      return {
        ok: false,
        error: new MonteCarloError("mc:invalid-trades", `Trade an Position ${i}: seq muss streng aufsteigend sein (erhalten: ${String(t.seq)}).`, {
          position: i,
          seq: t.seq,
        }),
      };
    }
    prevSeq = t.seq;
    for (const [field, value] of [
      ["pnlNet", t.pnlNet],
      ["fees", t.fees],
      ["slippage", t.slippage],
      ["notional", t.notional],
      ["entryTs", t.entryTs],
      ["exitTs", t.exitTs],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return {
          ok: false,
          error: new MonteCarloError("mc:invalid-trades", `Trade #${t.seq}: Feld ${field} ist keine endliche Zahl (${String(value)}).`, {
            seq: t.seq,
            field,
          }),
        };
      }
    }
    if (t.notional <= 0) {
      return {
        ok: false,
        error: new MonteCarloError("mc:invalid-trades", `Trade #${t.seq}: notional muss > 0 sein (${t.notional}).`, { seq: t.seq }),
      };
    }
    if (t.fees < 0 || t.slippage < 0) {
      return {
        ok: false,
        error: new MonteCarloError("mc:invalid-trades", `Trade #${t.seq}: fees/slippage müssen ≥ 0 sein.`, {
          seq: t.seq,
          fees: t.fees,
          slippage: t.slippage,
        }),
      };
    }
    if (t.exitTs < t.entryTs) {
      return {
        ok: false,
        error: new MonteCarloError("mc:invalid-trades", `Trade #${t.seq}: exitTs liegt vor entryTs (Look-ahead-verdächtige Ereigniszeiten).`, {
          seq: t.seq,
          entryTs: t.entryTs,
          exitTs: t.exitTs,
        }),
      };
    }
    if (typeof t.symbol !== "string" || t.symbol.length === 0) {
      return {
        ok: false,
        error: new MonteCarloError("mc:invalid-trades", `Trade #${t.seq}: symbol fehlt.`, { seq: t.seq }),
      };
    }
    symbols.add(t.symbol);
  }
  if (symbols.size > 1) {
    return {
      ok: false,
      error: new MonteCarloError(
        "mc:mixed-symbols",
        `Stichprobe mischt ${symbols.size} Symbole — Resampling über inkompatible Instrumente ohne Normalisierung ist unzulässig (ein Run = ein Instrument).`,
        { symbols: symbols.size }
      ),
    };
  }
  return { ok: true, sampleSize: trades.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mathematik (rein)
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest-Rank-Quantil (Typ 1): `sorted[ceil(p·n) − 1]`, geklemmt auf [0, n−1]. */
export function nearestRankQuantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new MonteCarloError("mc:empty-sample", "Quantil leerer Stichprobe.");
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** Per-Trade-Equity-Renditen `r_i = pnl_i / E_{i-1}` auf realisierter Quell-Basis. */
function equityReturns(
  trades: readonly MonteCarloTradeInput[],
  initialEquity: number,
  stress: MonteCarloStressConfig | null
): { returns: number[]; stressed: boolean } {
  const returns: number[] = new Array(trades.length);
  let equity = initialEquity;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (equity <= 0) {
      throw new MonteCarloError(
        "mc:source-ruined",
        `Realisierte Quell-Equity ist ≤ 0 ab Trade #${t.seq} — relative Renditen sind nicht mehr definiert (die Quelle selbst ist ruiniert).`,
        { seq: t.seq, equity }
      );
    }
    let pnl = t.pnlNet;
    if (stress !== null) {
      pnl -= t.fees * (stress.feeMultiplier - 1) + t.slippage * (stress.slippageMultiplier - 1);
    }
    returns[i] = pnl / equity;
    equity += t.pnlNet;
  }
  return { returns, stressed: stress !== null };
}

/** Jahresisierung (Trades/Jahr) aus der Quell-Spanne; fail-closed außerhalb der Bounds. */
export function deriveTradesPerYear(trades: readonly MonteCarloTradeInput[]): number {
  let minEntry = Number.POSITIVE_INFINITY;
  let maxExit = Number.NEGATIVE_INFINITY;
  for (const t of trades) {
    if (t.entryTs < minEntry) minEntry = t.entryTs;
    if (t.exitTs > maxExit) maxExit = t.exitTs;
  }
  const spanMs = maxExit - minEntry;
  if (!(spanMs > 0)) {
    throw new MonteCarloError(
      "mc:span-not-derivable",
      `Quell-Spanne ist ${spanMs} ms — Annualisierung (Trades/Jahr) nicht ableitbar.`,
      { spanMs }
    );
  }
  const tradesPerYear = trades.length / (spanMs / MC_MS_PER_YEAR);
  if (
    !Number.isFinite(tradesPerYear) ||
    tradesPerYear < MC_TRADES_PER_YEAR_BOUNDS.min ||
    tradesPerYear > MC_TRADES_PER_YEAR_BOUNDS.max
  ) {
    throw new MonteCarloError(
      "mc:span-not-derivable",
      `Annualisierung ${tradesPerYear} Trades/Jahr liegt außerhalb [${MC_TRADES_PER_YEAR_BOUNDS.min}, ${MC_TRADES_PER_YEAR_BOUNDS.max}] — Ereigniszeiten prüfen (fail-closed, kein Klemmen).`,
      { tradesPerYear }
    );
  }
  return tradesPerYear;
}

/** Ergebnis eines einzelnen simulierten (oder beobachteten) Pfades. */
interface PathOutcome {
  endEquity: number;
  maxDrawdownPct: number;
  losingStreak: number;
  sharpeRatio: number;
  ruined: boolean;
}

/**
 * Simuliert EINEN Pfad über gegebene Rendite-Indizes (oder die Identität für
 * die Beobachtung). Equity ≤ 0 ⇒ Wipe: Equity bleibt 0, MaxDD = 100 %.
 * Losing-Streak und Sharpe laufen über die VOLLSTÄNDIGE Sequenz.
 */
function walkPath(
  returns: readonly number[],
  indices: readonly number[],
  initialEquity: number,
  ruinThreshold: number,
  tradesPerYear: number
): PathOutcome {
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDd = 0;
  let streak = 0;
  let maxStreak = 0;
  let ruined = false;
  const sequence: number[] = new Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const r = returns[indices[k]];
    sequence[k] = r;
    if (r < 0) {
      streak++;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      streak = 0;
    }
    if (equity > 0) {
      equity = equity * (1 + r);
      if (equity <= 0) equity = 0;
    }
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
    if (!ruined && equity < ruinThreshold) ruined = true;
  }
  return {
    endEquity: equity,
    maxDrawdownPct: maxDd * 100,
    losingStreak: maxStreak,
    sharpeRatio: sharpeRatio(sequence, { riskFreeRate: 0, annualization: tradesPerYear }).annualized,
    ruined,
  };
}

/** Zieht die Index-Sequenz eines Pfads nach der gewählten Methode. */
function drawIndices(
  rng: () => number,
  method: MonteCarloMethod,
  n: number,
  blockLength: number | null
): { indices: number[]; blocks: number } {
  if (method === "iid") {
    const indices = new Array<number>(n);
    for (let k = 0; k < n; k++) indices[k] = Math.floor(rng() * n);
    return { indices, blocks: n };
  }
  if (method === "moving_block") {
    const b = blockLength as number;
    const indices: number[] = [];
    let blocks = 0;
    while (indices.length < n) {
      const start = Math.floor(rng() * (n - b + 1));
      for (let j = 0; j < b && indices.length < n; j++) indices.push(start + j);
      blocks++;
    }
    return { indices, blocks };
  }
  // stationary_block (Politis/Romano): Restart mit p = 1/L, sonst weiter (zirkulär).
  const b = blockLength as number;
  const p = 1 / b;
  const indices: number[] = new Array<number>(n);
  let idx = Math.floor(rng() * n);
  let blocks = 1;
  indices[0] = idx;
  for (let k = 1; k < n; k++) {
    if (rng() < p) {
      idx = Math.floor(rng() * n);
      blocks++;
    } else {
      idx = (idx + 1) % n;
    }
    indices[k] = idx;
  }
  return { indices, blocks };
}

function binomialMcse(p: number, runs: number): number {
  return Math.sqrt(Math.max(0, p * (1 - p)) / runs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashes / Idempotenz
// ─────────────────────────────────────────────────────────────────────────────

/** Kanonische Projektion der Stichprobe (feldstabil, deterministisch). */
function canonicalTrades(trades: readonly MonteCarloTradeInput[]): unknown {
  return trades.map((t) => [
    t.seq,
    t.symbol,
    t.strategyId,
    t.entryTs,
    t.exitTs,
    t.pnlNet,
    t.fees,
    t.slippage,
    t.notional,
  ]);
}

/** sha256 über die kanonische Eingabe-Stichprobe (Datahash des Laufs). */
export function monteCarloInputHash(trades: readonly MonteCarloTradeInput[]): string {
  return createHash("sha256").update(stableStringify(canonicalTrades(trades))).digest("hex");
}

/**
 * Stabiler Idempotency-Key `mcs1:<sha256>` über fachliche Identität +
 * Simulationsconfig + Eingabe-Hash. Ein Retry derselben Analyse liefert
 * denselben Key ⇒ exakt eine Zeile (siehe `./monteCarloStore.ts`).
 */
export function monteCarloIdempotencyKey(input: {
  sourceRunId: string;
  config: ResolvedMonteCarloConfig;
  inputTradesHash: string;
}): string {
  const { config } = input;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        v: MC_ALGORITHM_VERSION,
        sourceRunId: input.sourceRunId,
        segment: config.segment,
        method: config.method,
        seed: config.seed,
        prngAlgorithm: config.prngAlgorithm,
        runs: config.runs,
        blockLength: config.blockLength,
        initialEquity: config.initialEquity,
        ruinThresholdPct: config.ruinThresholdPct,
        stress: config.stress,
        inputTradesHash: input.inputTradesHash,
      })
    )
    .digest("hex");
  return `mcs1:${digest}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hauptfunktion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Führt die Monte-Carlo-/Trade-Resampling-Analyse rein im Speicher aus.
 * `trades` muss bereits segment-gefiltert und nach `seq` aufsteigend sortiert
 * sein (siehe `loadMonteCarloSample` in `./monteCarloStore.ts`) und wird
 * NICHT mutiert. Deterministisch: gleiche Eingabe ⇒ byte-identisches Result.
 */
export function runMonteCarloSimulation(input: {
  sourceRunId: string;
  trades: readonly MonteCarloTradeInput[];
  config: MonteCarloConfig;
}): MonteCarloResult {
  const config = resolveMonteCarloConfig(input.config);

  const eligibility = validateMonteCarloSample(input.trades);
  if (!eligibility.ok) throw eligibility.error;
  const n = eligibility.sampleSize;

  if (config.blockLength !== null && config.blockLength > n) {
    throw invalidConfig(
      `blockLength ${config.blockLength} > Stichprobengröße ${n} — Blöcke größer als die Stichprobe sind unzulässig.`,
      { blockLength: config.blockLength, sampleTrades: n }
    );
  }

  const tradesPerYear = deriveTradesPerYear(input.trades);

  // Renditen: Basis (unverändert) und Szenario (Kostenstress) — die Basis für
  // r_i ist IMMER die realisierte Quell-Equity (feste Exposurbasis).
  const baseReturns = equityReturns(input.trades, config.initialEquity, null).returns;
  const simReturns = config.stress === null ? baseReturns : equityReturns(input.trades, config.initialEquity, config.stress).returns;

  const ruinThreshold = config.initialEquity * (config.ruinThresholdPct / 100);
  const identity = Array.from({ length: n }, (_, i) => i);

  // Beobachtung: Original-Sequenz mit TATSÄCHLICHEN Netto-Trades (unverändert).
  const observed = walkPath(baseReturns, identity, config.initialEquity, ruinThreshold, tradesPerYear);
  const observedStressed =
    config.stress === null
      ? null
      : walkPath(simReturns, identity, config.initialEquity, ruinThreshold, tradesPerYear);

  // Resampling: EIN sequenzieller PRNG-Stream, Pfad für Pfad.
  const rng = createRng(config.seed);
  const endEquities: number[] = new Array(config.runs);
  const maxDrawdowns: number[] = new Array(config.runs);
  const sharpes: number[] = new Array(config.runs);
  const losingStreaks: number[] = new Array(config.runs);
  let ruinCount = 0;
  let endBelowStartCount = 0;
  const ddExceedCounts = new Map<number, number>();
  for (const threshold of MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT) ddExceedCounts.set(threshold, 0);
  let blocksDrawn = 0;

  for (let p = 0; p < config.runs; p++) {
    const draw = drawIndices(rng, config.method, n, config.blockLength);
    blocksDrawn += draw.blocks;
    const outcome = walkPath(simReturns, draw.indices, config.initialEquity, ruinThreshold, tradesPerYear);
    endEquities[p] = outcome.endEquity;
    maxDrawdowns[p] = outcome.maxDrawdownPct;
    sharpes[p] = outcome.sharpeRatio;
    losingStreaks[p] = outcome.losingStreak;
    if (outcome.ruined) ruinCount++;
    if (outcome.endEquity < config.initialEquity) endBelowStartCount++;
    for (const threshold of MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT) {
      if (outcome.maxDrawdownPct >= threshold) ddExceedCounts.set(threshold, (ddExceedCounts.get(threshold) ?? 0) + 1);
    }
  }

  const metricSummary = (values: number[], digits: number): MonteCarloMetricSummary => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      p05: roundTo(nearestRankQuantile(sorted, 0.05), digits),
      p50: roundTo(nearestRankQuantile(sorted, 0.5), digits),
      p95: roundTo(nearestRankQuantile(sorted, 0.95), digits),
      mean: roundTo(values.reduce((acc, v) => acc + v, 0) / values.length, digits),
    };
  };

  const ruinProbability = ruinCount / config.runs;
  const endBelowStartProbability = endBelowStartCount / config.runs;

  const distinctStrategies = new Set(input.trades.map((t) => t.strategyId)).size;
  const caveats: string[] = [
    `resampling-assumption:${config.method}${config.blockLength !== null ? `:blockLength=${config.blockLength}` : ""}`,
    `sample:${n}-trades-conditional-on-source-run`,
    "quantiles-are-estimates-no-guarantee",
    "not-a-live-risk-release",
  ];
  if (config.stress !== null) {
    caveats.push("stress:first-order-cost-only-fixed-sequence-and-exposure");
  }

  const summary: MonteCarloSummary = {
    observed: {
      endEquity: roundTo(observed.endEquity, 4),
      maxDrawdownPct: roundTo(observed.maxDrawdownPct, 4),
      losingStreak: observed.losingStreak,
      sharpeRatio: roundTo(observed.sharpeRatio, 4),
      ruined: observed.ruined,
    },
    observedStressed:
      observedStressed === null
        ? null
        : {
            endEquity: roundTo(observedStressed.endEquity, 4),
            maxDrawdownPct: roundTo(observedStressed.maxDrawdownPct, 4),
            losingStreak: observedStressed.losingStreak,
            sharpeRatio: roundTo(observedStressed.sharpeRatio, 4),
            ruined: observedStressed.ruined,
          },
    resampled: {
      endEquity: metricSummary(endEquities, 4),
      maxDrawdownPct: metricSummary(maxDrawdowns, 4),
      sharpeRatio: metricSummary(sharpes, 4),
      losingStreak: metricSummary(losingStreaks, 4),
      exceedance: {
        ruinProbability: roundTo(ruinProbability, 6),
        endBelowStartProbability: roundTo(endBelowStartProbability, 6),
        maxDrawdownGtePct: MC_DRAWDOWN_EXCEEDANCE_THRESHOLDS_PCT.map((thresholdPct) => ({
          thresholdPct,
          probability: roundTo((ddExceedCounts.get(thresholdPct) ?? 0) / config.runs, 6),
        })),
      },
      mcse: {
        ruinProbability: roundTo(binomialMcse(ruinProbability, config.runs), 6),
        endBelowStartProbability: roundTo(binomialMcse(endBelowStartProbability, config.runs), 6),
      },
    },
    stats: {
      sampleTrades: n,
      horizonTrades: n,
      runs: config.runs,
      blocksDrawn,
      distinctStrategies,
      symbols: 1,
      annualizationTradesPerYear: roundTo(tradesPerYear, 4),
      scenario: config.stress === null ? "baseline" : "stress",
      stress: config.stress,
      method: config.method,
      blockLength: config.blockLength,
      seed: config.seed,
      prngAlgorithm: config.prngAlgorithm,
      algorithmVersion: config.algorithmVersion,
    },
    caveats,
  };

  const inputTradesHash = monteCarloInputHash(input.trades);
  return {
    sourceRunId: input.sourceRunId,
    config,
    inputTradesHash,
    idempotencyKey: monteCarloIdempotencyKey({ sourceRunId: input.sourceRunId, config, inputTradesHash }),
    summary,
  };
}

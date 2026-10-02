/**
 * STX-06-04 — `StrategyValidationReport` + deterministische Gate-Kette
 * (Phase 6, Finding STX-17) — REIN, keine IO.
 *
 * ── Was dieses Modul entscheidet ────────────────────────────────────────────
 * Es führt die Ergebnisse der deterministischen Vorstufen — Annahmen-Audit
 * (06-01), Overfit-/Robustheitsauswertung (06-02), Cost-Stress (06-03) — zu
 * **einem** objektiven, hashbaren Ergebnis zusammen. Die Kette ist fest und
 * wird strikt in dieser Reihenfolge ausgewertet:
 *
 * | # | Gate | Ergebnis |
 * |---|---|---|
 * | 1 | Annahmen-Audit (`AssumptionAudit.verdict`) | `INCONCLUSIVE` (kritisch verletzt/unprüfbar) bzw. `FAIL` (BLOCKING verletzt) |
 * | 2 | Holdout-Integrität (`IntegrityCheck.verdict`) | `CONTAMINATED`/`UNKNOWN` ⇒ `INCONCLUSIVE` |
 * | 3 | Datenlage (`tradeCount < 30`, keine OOS)` | `INCONCLUSIVE` |
 * | 4 | OOS-Metriken unter den Policy-Gates (`evaluateBacktestGate`) | `FAIL` |
 * | 5 | IS/OOS-Lücke (`TrainOosGap`) **oder** Plateau (`PlateauMetrics`) | `FAIL` |
 * | 6 | Cost-Stress (`StressSummary.verdict`) | `COST_DEPENDENT` ⇒ `FAIL` |
 * | 7 | Multiple Testing (`MultipleTestingWarning.blocking`) | `FAIL` |
 * | 8 | sonst | `PASS` |
 *
 * ── Die Regeln, die nicht verhandelbar sind ────────────────────────────────
 * - **`INCONCLUSIVE` schlägt `FAIL`:** Ein unklarer Lauf ist kein Beweis gegen
 *   die Strategie — aber auch kein Beleg dafür. Sobald ein Gate unklar ist,
 *   endet die Kette; spätere Gates werden **nicht** ausgewertet
 *   (`status: "SKIPPED"`), damit ein sauberes Sharpe keinen Annahmen-Bruch
 *   überstimmt.
 * - **Keine Gewichtung, kein Score, kein „knapp bestanden":** Es gibt genau
 *   `PASS | FAIL | INCONCLUSIVE` und die Kette. `PASS` entsteht **nur**, wenn
 *   jedes Gate der Kette bestanden wurde (`decided === null`).
 * - **Fehlende Fakten sind `INCONCLUSIVE`, nie stilles `PASS`:** Ein Gate ohne
 *   Eingabe ist nicht bestanden — dieselbe Konvention wie im Annahmen-Audit.
 * - **`computedAt` ist nie ein Zulässigkeitskriterium:** Es wird nur geprüft,
 *   dass die Zeitsemantik den DB-CHECK erfüllt
 *   (`eventTime ≤ availableAt ≤ computedAt`); kein Gate liest es.
 *
 * ── Grenzen kommen aus ihren Quellen, keine zweite Wahrheit ────────────────
 * | Gate | Grenze | Quelle |
 * |---|---|---|
 * | Datenlage | `MC_MIN_SAMPLE_TRADES` (30) | `src/backtest/montecarlo.ts` |
 * | OOS-Policy | `PromotionPolicy`-Felder (Trades, Fensterdauer, Drawdown, Win-Rate, Profit-Faktor, Datenqualität) | `strategyLifecycle/policies.ts` (`DEFAULT_PROMOTION_POLICY`/`PROMOTION_POLICY_BOUNDS`) |
 * | IS/OOS-Lücke | `DEFAULT_TRAIN_OOS_GAP_THRESHOLDS` (`0.5` / `0`) | `validator/overfit.ts` |
 * | Plateau | `minPlateauRobustShare` (Default `0.5`); Gültigkeitsbereich `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare` | `report.ts` (Default) + `strategyLifecycle/policies.ts` (Bounds) |
 * | Cost-Stress | `DEFAULT_STRESS_VERDICT_THRESHOLDS` | `validator/stress.ts` |
 * | Multiple Testing | `MULTIPLE_TESTING_THRESHOLDS` (`5`/`20`) | `validator/overfit.ts` |
 * | Regime-Stichprobe | `MC_MIN_SAMPLE_TRADES` (30) | `src/backtest/montecarlo.ts` |
 *
 * Der Plateau-Default („weniger als die Hälfte der Parametervarianten besteht
 * in allen Fenstern ⇒ der stabile Bereich ist die Ausnahme") ist der **einzige**
 * im Repo noch fehlende Bound; sein Wertebereich steht seit 06-04 in
 * `PROMOTION_POLICY_BOUNDS` (`validationMinPlateauShare`), damit die Grenze
 * nicht an zwei Stellen definiert wird.
 *
 * ── Regime-Aggregation (ADR-009, ADR-E2) ───────────────────────────────────
 * `aggregateRegimeTrades()` ordnet jeden Trade dem **letzten bestätigten**
 * `regime_snapshots`-Eintrag mit `asOf ≤ Entry` zu (point-in-time, gleiches
 * Symbol) und benutzt dafür ausschließlich das bestehende Vokabular und
 * Zeilenformat (`REGIME_EVAL_LABELS`, `RegimeEvalRow`-Semantik). `UNKNOWN` und
 * Trades ohne zuordenbaren Snapshot werden **ausgeschlossen und gezählt** —
 * nie auf `RANGE` abgebildet, nie als „Regime ohne Edge" gewertet. Kennzahlen
 * ohne ausreichende Stichprobe sind `null`, nie `0`. Jedes Ergebnis trägt
 * `featureVersion`/`modelVersion` der verwendeten Snapshots.
 * `evaluateRegimeOos()` selbst bleibt unverändert — es misst den Markt, nicht
 * die Strategie.
 *
 * ── Hashbarkeit ────────────────────────────────────────────────────────────
 * Der Report trägt `evidenceHash` (= `content_hash`) und `idempotencyKey`
 * (= `idempotency_key`); beide entstehen **ausschließlich** über
 * `evidenceContentHash()`/`evidenceIdempotencyKey()` aus
 * `strategyLifecycle/evidence.ts` — keine eigene Hashfunktion. Die Abbildung
 * Report → `EvidenceInput` ist `validationEvidenceInput()`; derselbe Report
 * liefert damit byte-identisch denselben Hash (Determinismus-Test).
 *
 * ── Gesperrt (Prompt) ───────────────────────────────────────────────────────
 * Kein LLM (06-05), keine automatische Promotion, kein `requestTransition`,
 * keine Gewichtung/Scoring, keine Änderung an `src/strategyLifecycle/**`
 * (ausgenommen der additive Bound `validationMinPlateauShare`).
 */
import { MC_MIN_SAMPLE_TRADES } from "@/backtest/montecarlo";
import { REGIME_EVAL_LABELS } from "@/lib/regimeEvaluation";
import { realizedVolatility, sharpeRatio } from "@/portfolio/metrics";
import { DEFAULT_PROMOTION_POLICY, PROMOTION_POLICY_BOUNDS, evaluateBacktestGate } from "@/strategyLifecycle/policies";
import type { PromotionPolicy } from "@/strategyLifecycle/policies";
import {
  canonicalJson,
  evidenceContentHash,
  evidenceIdempotencyKey,
  normalizeStrategyKey,
  normalizeStrategyVersion,
} from "@/strategyLifecycle/evidence";
import type { EvidenceInput } from "@/strategyLifecycle/evidence";
import { APP_VERSION } from "@/lib/version";
import type { MarketRegime } from "@/lib/marketRegime";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { StrategyClassKey } from "@/lib/signalDecay";
import type { AssumptionAudit } from "./assumptions";
import type {
  IntegrityCheck,
  MultipleTestingWarning,
  PlateauMetrics,
  TrainOosGap,
} from "./overfit";
import type { StressSummary } from "./stress";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Vokabular
// ─────────────────────────────────────────────────────────────────────────────

/** Schema-Version des Reports (Teil des Evidenz-Details). */
export const VALIDATION_REPORT_SCHEMA_VERSION = "svr1" as const;

/**
 * Die drei erlaubten Ergebnisse — wortgleich mit dem DB-CHECK
 * `result IN ('PASS','FAIL','INCONCLUSIVE')` (`strategy_lifecycle_evidence`).
 * Typseitig **und** laufzeitseitig geprüft ({@link isValidationResult}).
 */
export const VALIDATION_RESULTS = ["PASS", "FAIL", "INCONCLUSIVE"] as const;

export type ValidationResult = (typeof VALIDATION_RESULTS)[number];

/** Laufzeit-Wächter gegen jeden Pfad, der ein fremdes `result` einschleust. */
export function isValidationResult(value: unknown): value is ValidationResult {
  return (
    typeof value === "string" &&
    (VALIDATION_RESULTS as readonly string[]).includes(value)
  );
}

/** Wirft fail-closed, wenn ein Wert kein zulässiges Ergebnis ist. */
export function assertValidationResult(
  value: unknown,
): asserts value is ValidationResult {
  if (!isValidationResult(value)) {
    throw new Error(
      `validation:invalid-result — „${String(value).slice(0, 24)}" ist kein zulässiges Ergebnis; erlaubt: ${VALIDATION_RESULTS.join(", ")}.`,
    );
  }
}

/** Holdout-Integrität, wie sie im Report erscheint (nie `null`). */
export type ValidationHoldoutIntegrity = "CLEAN" | "CONTAMINATED" | "UNKNOWN";

// ─────────────────────────────────────────────────────────────────────────────
// 2) Report
// ─────────────────────────────────────────────────────────────────────────────

/** Kennzahlen des **OOS**-Fensters. Unbekannt ist `null`, nie `0`. */
export interface ValidationMetrics {
  /** Annualisierter Sharpe des OOS-Aggregats; `null` = nicht messbar. */
  readonly sharpe: number | null;
  readonly sortino: number | null;
  /** Maximaler Drawdown in Prozent des Kapitals (höher = schlechter). */
  readonly maxDrawdownPct: number | null;
  /** Gewinnquote als **Anteil [0,1]** (Policy-Konvention, kein Prozentwert). */
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly expectancy: number | null;
  /** Anzahl ausgewerteter OOS-Trades (ganze Zahl ≥ 0). */
  readonly tradeCount: number;
  readonly netPnl: number | null;
}

/** Robustheits-Kennzahlen; jede `null` ohne belastbare Grundlage. */
export interface ValidationRobustness {
  /**
   * `1 − robustShare` aus `plateauMetrics()`: Anteil der Parametervarianten,
   * der **nicht** in allen Fenstern besteht (höher = empfindlicher).
   */
  readonly parameterSensitivity: number | null;
  /**
   * `StressSummary.degradationRatio` (OOS-Sharpe-Anteil unter 3× Kosten) —
   * der Kopfwert des Cost-Stress-Sweeps.
   */
  readonly costStress: number | null;
  /**
   * Marginaler Anteil der letzten Kostenstufe
   * (`OOS-Sharpe(triple) / OOS-Sharpe(double)`); `null`, wenn eine der beiden
   * Stützstellen fehlt oder `double` nicht positiv ist. Dokumentiert, weil
   * `COST_STRESS_SCENARIOS` Gebühren **und** Slippage gemeinsam skaliert —
   * eine Trennung der beiden Anteile gibt es nicht.
   */
  readonly slippageStress: number | null;
  /**
   * Anteil der Regime-Zellen mit belastbarer Stichprobe (`sharpe !== null`)
   * und positivem Per-Trade-Sharpe; `null`, wenn keine Zelle auswertbar war.
   */
  readonly regimeStability: number | null;
}

/** Overfit-Kennzahlen; `null` ohne belastbare Grundlage. */
export interface ValidationOverfitting {
  /** `TrainOosGap.gap` (IS-Sharpe − OOS-Sharpe); `null` ohne OOS-Fenster. */
  readonly trainOosGap: number | null;
  /**
   * `1 − selectionStability`: wie fragil der gewählte Parameterpunkt relativ
   * zum Kandidatenfeld liegt (höher = fragiler).
   */
  readonly parameterFragility: number | null;
  /** `MultipleTestingWarning.level !== "NONE"` (WARNING oder BLOCKING). */
  readonly multipleTestingWarning: boolean;
  /**
   * `LEAKAGE_PROTECTED === "VIOLATED"` aus dem Annahmen-Audit. `UNKNOWN`
   * erzeugt **keine** Warnung — die Unsicherheit trägt das Gesamtergebnis
   * (`INCONCLUSIVE`), kein Flag.
   */
  readonly lookaheadWarning: boolean;
  /** Höchster Holdout-Befund: `CLEAN | CONTAMINATED | UNKNOWN`. */
  readonly holdoutIntegrity: ValidationHoldoutIntegrity;
}

/** Eine Annahme-Zeile im Report (aus dem Audit, unverändert übernommen). */
export interface ValidationAssumptionRow {
  readonly id: string;
  readonly status: string;
  readonly evidence: string;
}

/**
 * Eine Regime-Zeile. `regime` ist ausdrücklich **ohne** `UNKNOWN`
 * (`MarketRegime`) — `UNKNOWN` erzeugt keine Zeile, sondern einen Zähler in
 * {@link ValidationRegimeEvidence}.
 */
export interface ValidationRegimeRow {
  readonly regime: MarketRegime;
  readonly trades: number;
  /** Per-Trade-Sharpe (Mittelwert/σ, nicht annualisiert); `null` unter Stichprobe. */
  readonly sharpe: number | null;
}

/** Zähler und Provenienz der Regime-Aggregation. */
export interface ValidationRegimeEvidence {
  /** `featureVersion` der verwendeten Snapshots (distinct, sortiert). */
  readonly featureVersions: readonly string[];
  /** `modelVersion` der verwendeten Snapshots (distinct, sortiert). */
  readonly modelVersions: readonly string[];
  /** Anzahl Trades gesamt. */
  readonly tradesTotal: number;
  /** Trades mit zugeordnetem, bestätigtem Nicht-UNKNOWN-Regime. */
  readonly attributedTrades: number;
  /** Trades, deren Snapshot `UNKNOWN` (oder unbekannt) war — ausgeschlossen. */
  readonly unknownRegimeTrades: number;
  /** Trades ohne Snapshot mit `asOf ≤ Entry` — ausgeschlossen. */
  readonly unattributedTrades: number;
  /** Trades, deren Ergebnis keine Renditezahl trug (nur Zählung). */
  readonly returnlessTrades: number;
  /** Wirksame Mindeststichprobe je Regime-Zelle. */
  readonly minSampleTrades: number;
  readonly summary: string;
}

/** Ein Gate-Ergebnis der festen Kette. */
export type ValidationGateStatus = "PASS" | "FAIL" | "INCONCLUSIVE" | "SKIPPED";

export interface ValidationGateRecord {
  readonly id: ValidationGateId;
  /** 1-basierte Position in der Kette. */
  readonly step: number;
  readonly status: ValidationGateStatus;
  /** Immer mit Zahl (Repo-Konvention) — auch bei `SKIPPED`. */
  readonly evidence: string;
}

/** Die acht Stufen der Kette, in Auswertungsreihenfolge. */
export const VALIDATION_GATE_IDS = [
  "ASSUMPTIONS",
  "HOLDOUT_INTEGRITY",
  "DATA_SUFFICIENCY",
  "OOS_POLICY_GATES",
  "TRAIN_OOS_GAP_AND_PLATEAU",
  "COST_STRESS",
  "MULTIPLE_TESTING",
  "FINAL",
] as const;

export type ValidationGateId = (typeof VALIDATION_GATE_IDS)[number];

/** Der vollständige, hashbare Bericht. */
export interface StrategyValidationReport {
  readonly result: ValidationResult;
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly strategyVersionId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly class: StrategyClassKey;

  readonly metrics: ValidationMetrics;
  readonly robustness: ValidationRobustness;
  readonly overfitting: ValidationOverfitting;
  readonly assumptions: readonly ValidationAssumptionRow[];
  readonly regimes: readonly ValidationRegimeRow[];

  /** Freitext nur für menschliche Leser; nie maschinell ausgewertet. */
  readonly notes: readonly string[];

  /** = `content_hash` (`sle1:<sha256>`, `evidenceContentHash`). */
  readonly evidenceHash: string;
  /** = `idempotency_key` (`slei1:<sha256>`, `evidenceIdempotencyKey`). */
  readonly idempotencyKey: string;

  readonly policyVersion: string;
  readonly codeVersion: string;
  readonly dataVersion: string | null;

  readonly eventTime: number;
  readonly availableAt: number;
  readonly computedAt: number;

  // ── Additive Felder (Prompt-Shape bleibt vollständig enthalten) ──────────
  readonly schemaVersion: typeof VALIDATION_REPORT_SCHEMA_VERSION;
  /** Fenster der Bewertung (Eventzeit, ms) — Basis der Evidence-Snapshot-Zeile. */
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  /** FK auf `backtest_runs`, wenn die Evidenz einen konkreten Lauf belegt. */
  readonly backtestRunId: string | null;
  /** Symbol/Instrument des Laufs (Provenienz im Detail). */
  readonly symbol: string | null;
  /** Kerzentakt des Laufs (Provenienz im Detail). */
  readonly timeframe: SupportedTimeframe | null;
  /**
   * Datenqualitäts-Score [0,1] des Laufs; geht in die Evidenz-Metriken ein,
   * damit der Lifecycle sein `data.quality`-Check prüfen kann.
   */
  readonly dataQualityScore: number | null;
  /** Die Gate-Kette mit jedem Ergebnis — auch den übersprungenen. */
  readonly gates: readonly ValidationGateRecord[];
  /** Zähler + Versionsprovenienz der Regime-Aggregation. */
  readonly regimeEvidence: ValidationRegimeEvidence;
  /** Version der Annahmen-Prüflogik (`asm1`), sofern ein Audit vorlag. */
  readonly auditVersion: string | null;
  /** Ein Satz Klartext mit allen Zählungen. */
  readonly summary: string;
}

/** Felder, die den Hash bilden (ohne die beiden Hash-Felder selbst). */
export type StrategyValidationReportBody = Omit<
  StrategyValidationReport,
  "evidenceHash" | "idempotencyKey"
>;

// ─────────────────────────────────────────────────────────────────────────────
// 3) Regime-Aggregator (ADR-009/ADR-E2) — Trades ⇒ bestätigtes Regime je Trade
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal-Fakten eines Trades für die Regime-Zuordnung (nur Lesen). */
export interface RegimeTradeFact {
  readonly symbol: string;
  /** Entry-Zeit (ms) — der point-in-time Stichtag der Zuordnung. */
  readonly entryTime: number;
  /** Realisierter PnL in Kontowährung. */
  readonly pnl: number;
  /** Notional des Trades (für `pnl / notional`); `null` = nicht verfügbar. */
  readonly notional?: number | null;
  /** Ergebnis in Prozent (bevorzugt, wenn vorhanden); `null` = nicht verfügbar. */
  readonly pnlPct?: number | null;
}

/** Ein bestätigter Regime-Snapshot (`regime_snapshots`, nur Lesen). */
export interface RegimeSnapshotFact {
  readonly symbol: string;
  readonly asOf: number;
  /** Bestätigte Klasse; `UNKNOWN` oder Unbekanntes wird ausgeschlossen. */
  readonly confirmedRegime: string;
  readonly featureVersion: string;
  readonly modelVersion: string;
}

export interface RegimeAggregationOptions {
  /** Mindeststichprobe je Zelle (Default `MC_MIN_SAMPLE_TRADES` = 30). */
  readonly minSampleTrades?: number;
}

/** Ergebnis der Aggregation — Zeilen **und** die Ausschluss-Zähler. */
export interface RegimeTradeAggregate {
  readonly rows: readonly ValidationRegimeRow[];
  readonly featureVersions: readonly string[];
  readonly modelVersions: readonly string[];
  readonly tradesTotal: number;
  readonly attributedTrades: number;
  readonly unknownRegimeTrades: number;
  readonly unattributedTrades: number;
  readonly returnlessTrades: number;
  readonly minSampleTrades: number;
  readonly summary: string;
}

/** Bestätigte Klasse → zulässiges `MarketRegime` (ohne UNKNOWN, ohne RANGE-Fallback). */
function confirmedMarketRegime(value: string): MarketRegime | null {
  for (const label of REGIME_EVAL_LABELS) {
    if (label !== "UNKNOWN" && label === value) return label;
  }
  return null;
}

/** Rendite eines Trades: bevorzugt `pnlPct`, sonst `pnl/notional`; sonst `null`. */
function tradeReturn(trade: RegimeTradeFact): number | null {
  const pct = trade.pnlPct;
  if (typeof pct === "number" && Number.isFinite(pct)) return pct / 100;
  const notional = trade.notional;
  if (
    typeof notional === "number" &&
    Number.isFinite(notional) &&
    notional > 0 &&
    Number.isFinite(trade.pnl)
  ) {
    return trade.pnl / notional;
  }
  return null;
}

/**
 * Letzter Snapshot mit `asOf ≤ entryTime` (point-in-time). Die Snapshot-Reihe
 * ist nach `(asOf, featureVersion, modelVersion)` sortiert; bei gleichem `asOf`
 * gewinnt der letzte Eintrag dieser deterministischen Ordnung.
 */
function lastSnapshotAtOrBefore(
  sorted: readonly RegimeSnapshotFact[],
  entryTime: number,
): RegimeSnapshotFact | null {
  let found: RegimeSnapshotFact | null = null;
  for (const snapshot of sorted) {
    if (snapshot.asOf <= entryTime) found = snapshot;
    else break;
  }
  return found;
}

/**
 * Ordnet Trades ihren point-in-time-bestätigten Regime-Zellen zu.
 *
 * Reine Funktion, keine IO, keine Uhr. `UNKNOWN`-Snapshots und Trades ohne
 * Snapshot werden **ausgeschlossen und gezählt**; es gibt keinen Fallback auf
 * `RANGE` und keinen stillen `0`-Sharpe. Eine Zelle erscheint genau dann als
 * Zeile, wenn mindestens ein Trade zugeordnet wurde; ihr `sharpe` ist `null`,
 * solange die Zelle unter {@link RegimeAggregationOptions.minSampleTrades}
 * liegt oder keine Streuung hat.
 */
export function aggregateRegimeTrades(
  trades: readonly RegimeTradeFact[],
  snapshots: readonly RegimeSnapshotFact[],
  options: RegimeAggregationOptions = {},
): RegimeTradeAggregate {
  const minSampleTrades = options.minSampleTrades ?? MC_MIN_SAMPLE_TRADES;
  if (!Number.isInteger(minSampleTrades) || minSampleTrades < 2) {
    throw new Error(
      `validation:regime-min-sample — minSampleTrades muss eine ganze Zahl ≥ 2 sein (ist ${String(minSampleTrades)}).`,
    );
  }

  const bySymbol = new Map<string, RegimeSnapshotFact[]>();
  for (const snapshot of snapshots) {
    const list = bySymbol.get(snapshot.symbol) ?? [];
    list.push(snapshot);
    bySymbol.set(snapshot.symbol, list);
  }
  for (const list of bySymbol.values()) {
    list.sort(
      (a, b) =>
        a.asOf - b.asOf ||
        a.featureVersion.localeCompare(b.featureVersion) ||
        a.modelVersion.localeCompare(b.modelVersion),
    );
  }

  const buckets = new Map<MarketRegime, { trades: number; returns: number[] }>();
  const featureVersions = new Set<string>();
  const modelVersions = new Set<string>();
  let attributedTrades = 0;
  let unknownRegimeTrades = 0;
  let unattributedTrades = 0;
  let returnlessTrades = 0;

  for (const trade of trades) {
    const sorted = bySymbol.get(trade.symbol) ?? [];
    const snapshot = lastSnapshotAtOrBefore(sorted, trade.entryTime);
    if (!snapshot) {
      unattributedTrades += 1;
      continue;
    }
    featureVersions.add(snapshot.featureVersion);
    modelVersions.add(snapshot.modelVersion);
    const regime = confirmedMarketRegime(snapshot.confirmedRegime);
    if (regime === null) {
      // UNKNOWN (oder ein unbekanntes Label) — ausgeschlossen, nie auf RANGE.
      unknownRegimeTrades += 1;
      continue;
    }
    attributedTrades += 1;
    const bucket = buckets.get(regime) ?? { trades: 0, returns: [] };
    bucket.trades += 1;
    const value = tradeReturn(trade);
    if (value === null) returnlessTrades += 1;
    else bucket.returns.push(value);
    buckets.set(regime, bucket);
  }

  const rows: ValidationRegimeRow[] = [];
  for (const label of REGIME_EVAL_LABELS) {
    const regime = confirmedMarketRegime(label);
    if (regime === null) continue;
    const bucket = buckets.get(regime);
    if (!bucket || bucket.trades === 0) continue;
    let sharpe: number | null = null;
    if (bucket.trades >= minSampleTrades && bucket.returns.length >= 2) {
      // Per-Trade-Sharpe (nicht annualisiert): Mittelwert/σ derselben
      // Log-Renditen wie `portfolio/metrics.ts`; ohne Streuung gibt es keine
      // Sharpe-Aussage (null, nie 0).
      const volatility = realizedVolatility(bucket.returns, 1);
      if (Number.isFinite(volatility) && volatility > 0) {
        sharpe = Number(
          sharpeRatio(bucket.returns, { annualization: 1, riskFreeRate: 0 }).perPeriod.toFixed(4),
        );
      }
    }
    rows.push({ regime, trades: bucket.trades, sharpe });
  }

  const sortedFeatureVersions = [...featureVersions].sort();
  const sortedModelVersions = [...modelVersions].sort();
  const nullCells = rows.filter((row) => row.sharpe === null).length;
  const summary =
    `${rows.length} Regime-Zeile(n) aus ${attributedTrades} zugeordneten Trades; ` +
    `${unknownRegimeTrades} UNKNOWN- und ${unattributedTrades} nicht zuordenbare Trades ausgeschlossen ` +
    `(nie RANGE-Fallback), ${returnlessTrades} ohne Renditezahl, ${nullCells} Zelle(n) unter ` +
    `Mindeststichprobe ${minSampleTrades} ⇒ sharpe null; featureVersion ` +
    `${sortedFeatureVersions.join("|") || "—"}, modelVersion ${sortedModelVersions.join("|") || "—"}.`;

  return {
    rows,
    featureVersions: sortedFeatureVersions,
    modelVersions: sortedModelVersions,
    tradesTotal: trades.length,
    attributedTrades,
    unknownRegimeTrades,
    unattributedTrades,
    returnlessTrades,
    minSampleTrades,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Grenzen der Validierungs-Gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Der Plateau-Default. Sein **Gültigkeitsbereich** steht in
 * `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare` (lifecycle), damit es
 * keine zweite Grenz-Wahrheit gibt; der Default selbst gehört zum Gate.
 */
export interface ValidationGateBounds {
  readonly minPlateauRobustShare: number;
}

export const DEFAULT_VALIDATION_GATE_BOUNDS: Readonly<ValidationGateBounds> = Object.freeze({
  minPlateauRobustShare: 0.5,
});

/** Löst Overrides auf und wirft außerhalb des Policy-Bounds (fail-closed). */
export function resolveValidationGateBounds(
  override?: Partial<ValidationGateBounds> | null,
): ValidationGateBounds {
  const merged: ValidationGateBounds = { ...DEFAULT_VALIDATION_GATE_BOUNDS, ...(override ?? {}) };
  const [min, max] = PROMOTION_POLICY_BOUNDS.validationMinPlateauShare;
  const value = merged.minPlateauRobustShare;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `validation:gate-bounds — minPlateauRobustShare muss eine Zahl in [${min}, ${max}] sein (ist ${String(value)}).`,
    );
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Gate-Kette
// ─────────────────────────────────────────────────────────────────────────────

interface GateOutcome {
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly evidence: string;
}

export interface BuildValidationReportInput {
  // Identität / Provenienz
  readonly strategyKey: string;
  readonly strategyVersion: number;
  readonly strategyVersionId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly strategyClass: StrategyClassKey;
  readonly symbol?: string | null;
  readonly timeframe?: SupportedTimeframe | null;

  // OOS-Kennzahlen + Fenster
  readonly metrics: ValidationMetrics;
  readonly oosWindows: number | null;
  readonly windowStart: number | null;
  readonly windowEnd: number | null;
  /** Datenqualitäts-Score [0,1]; `null` = nicht erhoben (Policy-Gate sperrt). */
  readonly dataQualityScore?: number | null;

  // Vorstufen
  readonly assumptions: AssumptionAudit | null;
  readonly integrity: IntegrityCheck | null;
  readonly gap: TrainOosGap | null;
  readonly plateau: PlateauMetrics | null;
  readonly multipleTesting: MultipleTestingWarning | null;
  readonly stress: StressSummary | null;

  // Regime (roh; wird in `buildValidationReport` aggregiert)
  readonly trades?: readonly RegimeTradeFact[];
  readonly regimeSnapshots?: readonly RegimeSnapshotFact[];
  readonly minSampleTrades?: number;

  // Zeit + Versionen
  readonly eventTime: number;
  readonly availableAt: number;
  readonly computedAt: number;
  /** Bewertungszeitpunkt der OOS-Policy-Gates (Default: `availableAt`). */
  readonly nowMs?: number;
  readonly policy?: PromotionPolicy;
  readonly codeVersion?: string;
  readonly dataVersion?: string | null;
  readonly backtestRunId?: string | null;
  readonly notes?: readonly string[];
  readonly bounds?: Partial<ValidationGateBounds> | null;
}

function requireFiniteMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`validation:invalid-time — ${field} muss eine endliche Millisekunden-Zahl sein.`);
  }
  return value;
}

/** Zahl oder `null` — nie `NaN`/`Infinity` in einem Report. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireTradeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `validation:invalid-trade-count — metrics.tradeCount muss eine ganze Zahl ≥ 0 sein (ist ${String(value)}).`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`validation:invalid-field — ${field} darf nicht leer sein.`);
  }
  return value.trim();
}

/** Baut die achtstufige Kette und liefert Ergebnis + Protokoll. */
function runGateChain(
  input: BuildValidationReportInput,
  policy: PromotionPolicy,
  bounds: ValidationGateBounds,
  metrics: ValidationMetrics,
  audit: AssumptionAudit | null,
  integrity: IntegrityCheck | null,
): { result: ValidationResult; gates: ValidationGateRecord[] } {
  const tradeCount = metrics.tradeCount;
  const oosWindows = input.oosWindows;
  const gap = input.gap;
  const plateau = input.plateau;
  const stress = input.stress;
  const multipleTesting = input.multipleTesting;

  const chain: readonly { id: ValidationGateId; run: () => GateOutcome }[] = [
    {
      id: "ASSUMPTIONS",
      run: (): GateOutcome => {
        if (!audit) {
          return {
            status: "INCONCLUSIVE",
            evidence:
              "0 Annahmen-Prüfungen übergeben — ohne Audit ist das erste Gate nicht bestanden (INCONCLUSIVE statt PASS).",
          };
        }
        if (audit.verdict === "FAIL") {
          return {
            status: "FAIL",
            evidence:
              `${audit.violated.length} BLOCKING-Prüfung(en) verletzt, keine kritische Template-Annahme betroffen ` +
              `(${audit.blocking.map((c) => c.assumptionId).join(", ") || "—"}) ⇒ der Lauf ist nachweislich kaputt.`,
          };
        }
        if (audit.verdict === "INCONCLUSIVE") {
          return {
            status: "INCONCLUSIVE",
            evidence:
              `${audit.unknown.length} von ${audit.checks.length} Prüfungen UNKNOWN, ${audit.criticalFindings.length} ` +
              `kritische Annahme(n) betroffen (${audit.criticalFindings.join(", ") || "—"}) ⇒ keine Aussage ` +
              "für oder gegen die Strategie.",
          };
        }
        return { status: "PASS", evidence: audit.summary };
      },
    },
    {
      id: "HOLDOUT_INTEGRITY",
      run: (): GateOutcome => {
        if (!integrity) {
          return {
            status: "INCONCLUSIVE",
            evidence: "0 Holdout-Prüfungen übergeben — die Unberührtheit ist nicht belegt (INCONCLUSIVE).",
          };
        }
        if (integrity.verdict === "INCONCLUSIVE") {
          return {
            status: "INCONCLUSIVE",
            evidence:
              `Holdout-Status ${integrity.status} (${integrity.checks.filter((c) => c.status !== "CLEAN").length} ` +
              `von ${integrity.checks.length} Befund(en) nicht CLEAN): ${integrity.reason}`,
          };
        }
        return { status: "PASS", evidence: integrity.reason };
      },
    },
    {
      id: "DATA_SUFFICIENCY",
      run: (): GateOutcome => {
        if (tradeCount < MC_MIN_SAMPLE_TRADES) {
          return {
            status: "INCONCLUSIVE",
            evidence:
              `${tradeCount} OOS-Trades < Mindeststichprobe ${MC_MIN_SAMPLE_TRADES} — ` +
              "Bootstrap-Quantile wären Scheingenauigkeit, das Ergebnis trägt keine Aussage.",
          };
        }
        if (oosWindows === null || !Number.isInteger(oosWindows) || oosWindows < 1) {
          return {
            status: "INCONCLUSIVE",
            evidence: `${String(oosWindows)} OOS-Fenster — ohne Out-of-Sample gibt es keine OOS-Metriken.`,
          };
        }
        if (metrics.sharpe === null || metrics.maxDrawdownPct === null || metrics.profitFactor === null) {
          return {
            status: "INCONCLUSIVE",
            evidence:
              `OOS-Kennzahlen unvollständig (sharpe ${String(metrics.sharpe)}, maxDrawdownPct ` +
              `${String(metrics.maxDrawdownPct)}, profitFactor ${String(metrics.profitFactor)}) — fehlende ` +
              "Fakten sind kein bestandenes Gate.",
          };
        }
        return {
          status: "PASS",
          evidence:
            `${tradeCount} OOS-Trades in ${oosWindows} Fenster(n) ≥ ${MC_MIN_SAMPLE_TRADES}; Sharpe/Drawdown/` +
            "Profit-Faktor liegen vor.",
        };
      },
    },
    {
      id: "OOS_POLICY_GATES",
      run: (): GateOutcome => {
        // Zeitpunkt der Bewertung = Verfügbarkeit der Evidenz. Die Frische ist
        // ein Promotion-Kriterium (der Lifecycle prüft sie zum Antragszeitpunkt);
        // `computedAt` ist nie ein Zulässigkeitskriterium.
        const nowMs = input.nowMs ?? input.availableAt;
        const gate = evaluateBacktestGate(
          {
            windowStartMs: input.windowStart,
            windowEndMs: input.windowEnd,
            availableAtMs: input.availableAt,
            trades: tradeCount,
            winRate: metrics.winRate,
            profitFactor: metrics.profitFactor,
            maxDrawdownPct: metrics.maxDrawdownPct,
            dataQualityScore: input.dataQualityScore ?? null,
          },
          policy,
          nowMs,
        );
        const failed = gate.checks.filter((c) => c.status === "FAIL");
        if (failed.length > 0) {
          return {
            status: "FAIL",
            evidence:
              `${failed.length} Policy-Check(s) verletzt: ` +
              `${failed.map((c) => `${c.id} (${c.message})`).join("; ")} ⇒ OOS-Metriken unter den Gates.`,
          };
        }
        if (!gate.ok) {
          const missing = gate.checks.filter((c) => c.status !== "PASS");
          return {
            status: "INCONCLUSIVE",
            evidence:
              `${missing.length} Policy-Check(s) nicht beurteilbar (${missing.map((c) => `${c.id}:${c.status}`).join(", ")}) ` +
              "— fehlende Fakten sind INCONCLUSIVE, kein FAIL-Beweis.",
          };
        }
        return {
          status: "PASS",
          evidence:
            `${gate.checks.length} Policy-Check(s) bestanden (Policy ${policy.version}) gegen Fenster ` +
            `${input.windowStart ?? "—"}→${input.windowEnd ?? "—"}.`,
        };
      },
    },
    {
      id: "TRAIN_OOS_GAP_AND_PLATEAU",
      run: (): GateOutcome => {
        if (!gap) {
          return {
            status: "INCONCLUSIVE",
            evidence: "Kein IS/OOS-Aggregat übergeben (0 Aggregate) — die Lücke ist nicht messbar.",
          };
        }
        if (gap.verdict === "UNKNOWN") {
          return { status: "INCONCLUSIVE", evidence: gap.evidence };
        }
        if (gap.verdict === "BROKEN" || gap.verdict === "SUSPECT") {
          return { status: "FAIL", evidence: gap.evidence };
        }
        if (!plateau) {
          return {
            status: "INCONCLUSIVE",
            evidence: "Keine Plateau-Auswertung übergeben (0 Kandidaten) — ohne Scan kein Robustheitsurteil.",
          };
        }
        if (plateau.status === "UNKNOWN" || plateau.robustShare === null) {
          return { status: "INCONCLUSIVE", evidence: plateau.summary };
        }
        if (plateau.robustShare < bounds.minPlateauRobustShare) {
          return {
            status: "FAIL",
            evidence:
              `robustShare ${plateau.robustShare} < Grenze ${bounds.minPlateauRobustShare}: ` +
              `nur ${plateau.stableCount} von ${plateau.candidateCount} Kandidaten bestehen in allen ` +
              `${plateau.windowCount} Fenstern — der stabile Bereich ist die Ausnahme, kein Plateau.`,
          };
        }
        return {
          status: "PASS",
          evidence:
            `Lücke ${gap.gap ?? "—"} (${gap.verdict}); Plateau robustShare ${plateau.robustShare} ≥ ` +
            `${bounds.minPlateauRobustShare} (${plateau.stableCount}/${plateau.candidateCount} über ` +
            `${plateau.windowCount} Fenster).`,
        };
      },
    },
    {
      id: "COST_STRESS",
      run: (): GateOutcome => {
        if (!stress) {
          return {
            status: "INCONCLUSIVE",
            evidence: "Kein Cost-Stress-Sweep übergeben (0 Szenarien) — die Kostenabhängigkeit ist nicht belegt.",
          };
        }
        if (stress.verdict === "COST_DEPENDENT") {
          return {
            status: "FAIL",
            evidence:
              `Cost-Stress ${stress.verdict} (degradationRatio ${String(stress.degradationRatio)}, ` +
              `breakevenMultiplier ${String(stress.breakevenMultiplier)}, Szenarien ${stress.scenarios.length}) ` +
              "— die Edge existiert nur unter dem freundlichen Kostenmodell.",
          };
        }
        return {
          status: "PASS",
          evidence:
            `Cost-Stress ${stress.verdict} (degradationRatio ${String(stress.degradationRatio)}, ` +
            `breakevenMultiplier ${String(stress.breakevenMultiplier)}) — kein COST_DEPENDENT.`,
        };
      },
    },
    {
      id: "MULTIPLE_TESTING",
      run: (): GateOutcome => {
        if (!multipleTesting) {
          return {
            status: "INCONCLUSIVE",
            evidence: "Keine Multiple-Testing-Auswertung übergeben (0 Kandidaten) — der Suchraum ist unbekannt.",
          };
        }
        if (multipleTesting.blocking) {
          return { status: "FAIL", evidence: multipleTesting.evidence };
        }
        return { status: "PASS", evidence: multipleTesting.evidence };
      },
    },
  ];

  const gates: ValidationGateRecord[] = [];
  let decided: "FAIL" | "INCONCLUSIVE" | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const { id, run } = chain[index];
    const step = index + 1;
    if (decided !== null) {
      gates.push({
        id,
        step,
        status: "SKIPPED",
        evidence:
          `nicht ausgewertet — Schritt ${step - 1} hat mit ${decided} entschieden ` +
          "(Reihenfolge verhindert, dass ein sauberes Sharpe einen Bruch überstimmt).",
      });
      continue;
    }
    const outcome = run();
    gates.push({ id, step, status: outcome.status, evidence: outcome.evidence });
    if (outcome.status !== "PASS") decided = outcome.status;
  }

  const finalStep = chain.length + 1;
  const result: ValidationResult = decided ?? "PASS";
  if (decided === null) {
    gates.push({
      id: "FINAL",
      step: finalStep,
      status: "PASS",
      evidence: `${chain.length} von ${chain.length} Gates bestanden (0 FAIL, 0 INCONCLUSIVE, 0 SKIPPED) ⇒ PASS.`,
    });
  } else {
    gates.push({
      id: "FINAL",
      step: finalStep,
      status: "SKIPPED",
      evidence: `Schritt ${gates.findIndex((g) => g.status === decided) + 1} hat mit ${decided} entschieden.`,
    });
  }

  assertValidationResult(result);
  return { result, gates };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Report bauen
// ─────────────────────────────────────────────────────────────────────────────

/** Baut den vollständigen, hashbaren Report — rein und deterministisch. */
export function buildValidationReport(
  input: BuildValidationReportInput,
): StrategyValidationReport {
  if (!input || typeof input !== "object") {
    throw new Error("buildValidationReport: Eingabe fehlt (0 Felder lesbar).");
  }
  const policy = input.policy ?? DEFAULT_PROMOTION_POLICY;
  const bounds = resolveValidationGateBounds(input.bounds);

  const strategyKey = normalizeStrategyKey(input.strategyKey);
  if (!strategyKey) {
    throw new Error(
      `buildValidationReport: strategyKey „${String(input.strategyKey).slice(0, 32)}" ist ungültig (1..128 Zeichen [A-Za-z0-9._:@/-]).`,
    );
  }
  const strategyVersion = normalizeStrategyVersion(input.strategyVersion);
  if (strategyVersion === null) {
    throw new Error(
      `buildValidationReport: strategyVersion „${String(input.strategyVersion)}" ist ungültig (ganze Zahl ≥ 1).`,
    );
  }
  const strategyVersionId = requireNonEmptyString(input.strategyVersionId, "strategyVersionId");
  const templateId = requireNonEmptyString(input.templateId, "templateId");
  if (typeof input.templateVersion !== "number" || !Number.isInteger(input.templateVersion) || input.templateVersion < 1) {
    throw new Error(
      `buildValidationReport: templateVersion „${String(input.templateVersion)}" ist ungültig (ganze Zahl ≥ 1).`,
    );
  }

  const eventTime = requireFiniteMs(input.eventTime, "eventTime");
  const availableAt = requireFiniteMs(input.availableAt, "availableAt");
  const computedAt = requireFiniteMs(input.computedAt, "computedAt");
  if (availableAt < eventTime || computedAt < availableAt) {
    throw new Error(
      `buildValidationReport: Zeitsemantik verletzt (eventTime ${eventTime} ≤ availableAt ${availableAt} ≤ ` +
        `computedAt ${computedAt} gefordert) — der DB-CHECK würde die Evidenz ablehnen.`,
    );
  }

  const tradeCount = requireTradeCount(input.metrics?.tradeCount);
  const metrics: ValidationMetrics = Object.freeze({
    sharpe: finiteOrNull(input.metrics.sharpe),
    sortino: finiteOrNull(input.metrics.sortino),
    maxDrawdownPct: finiteOrNull(input.metrics.maxDrawdownPct),
    winRate: finiteOrNull(input.metrics.winRate),
    profitFactor: finiteOrNull(input.metrics.profitFactor),
    expectancy: finiteOrNull(input.metrics.expectancy),
    tradeCount,
    netPnl: finiteOrNull(input.metrics.netPnl),
  });

  const audit = input.assumptions ?? null;
  const integrity = input.integrity ?? null;
  const gap = input.gap ?? null;
  const plateau = input.plateau ?? null;
  const multipleTesting = input.multipleTesting ?? null;
  const stress = input.stress ?? null;

  const regimeAggregate = aggregateRegimeTrades(
    input.trades ?? [],
    input.regimeSnapshots ?? [],
    input.minSampleTrades === undefined ? {} : { minSampleTrades: input.minSampleTrades },
  );

  const leakage = audit?.checks.find((check) => check.assumptionId === "LEAKAGE_PROTECTED");
  const robustness: ValidationRobustness = Object.freeze({
    parameterSensitivity:
      plateau?.robustShare === null || plateau?.robustShare === undefined
        ? null
        : Number((1 - plateau.robustShare).toFixed(4)),
    costStress: finiteOrNull(stress?.degradationRatio),
    // Marginaler Anteil der letzten Kostenstufe: Der Sweep skaliert Gebühren
    // und Slippage gemeinsam — eine getrennte Slippage-Messung gibt es nicht.
    slippageStress: scenarioRatio(stress, "triple", "double"),
    regimeStability: regimeStabilityOf(regimeAggregate.rows),
  });

  const overfitting: ValidationOverfitting = Object.freeze({
    trainOosGap: finiteOrNull(gap?.gap),
    parameterFragility:
      plateau?.selectionStability === null || plateau?.selectionStability === undefined
        ? null
        : Number((1 - plateau.selectionStability).toFixed(4)),
    multipleTestingWarning: multipleTesting !== null && multipleTesting.level !== "NONE",
    lookaheadWarning: leakage?.status === "VIOLATED",
    holdoutIntegrity: (integrity?.status ?? "UNKNOWN") as ValidationHoldoutIntegrity,
  });

  const assumptions: readonly ValidationAssumptionRow[] = Object.freeze(
    (audit?.checks ?? []).map((check) => ({
      id: check.assumptionId,
      status: check.status,
      evidence: check.evidence,
    })),
  );

  const { result, gates } = runGateChain(
    input,
    policy,
    bounds,
    metrics,
    audit,
    integrity,
  );

  const body: StrategyValidationReportBody = {
    result,
    strategyKey,
    strategyVersion,
    strategyVersionId,
    templateId,
    templateVersion: input.templateVersion,
    class: input.strategyClass,
    metrics,
    robustness,
    overfitting,
    assumptions,
    regimes: regimeAggregate.rows,
    notes: Object.freeze([...(input.notes ?? [])]),
    policyVersion: policy.version,
    codeVersion: input.codeVersion ?? APP_VERSION,
    dataVersion: input.dataVersion ?? null,
    eventTime,
    availableAt,
    computedAt,
    schemaVersion: VALIDATION_REPORT_SCHEMA_VERSION,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    backtestRunId: input.backtestRunId ?? null,
    symbol: input.symbol ?? null,
    timeframe: input.timeframe ?? null,
    dataQualityScore: finiteOrNull(input.dataQualityScore),
    gates: Object.freeze(gates),
    regimeEvidence: Object.freeze({
      featureVersions: regimeAggregate.featureVersions,
      modelVersions: regimeAggregate.modelVersions,
      tradesTotal: regimeAggregate.tradesTotal,
      attributedTrades: regimeAggregate.attributedTrades,
      unknownRegimeTrades: regimeAggregate.unknownRegimeTrades,
      unattributedTrades: regimeAggregate.unattributedTrades,
      returnlessTrades: regimeAggregate.returnlessTrades,
      minSampleTrades: regimeAggregate.minSampleTrades,
      summary: regimeAggregate.summary,
    }),
    auditVersion: audit?.auditVersion ?? null,
    summary:
      `${result}: ${gates.filter((g) => g.status === "PASS").length} PASS, ` +
      `${gates.filter((g) => g.status === "FAIL").length} FAIL, ` +
      `${gates.filter((g) => g.status === "INCONCLUSIVE").length} INCONCLUSIVE, ` +
      `${gates.filter((g) => g.status === "SKIPPED").length} SKIPPED — ${templateId} v${input.templateVersion} ` +
      `(${strategyKey}@v${strategyVersion}), ${tradeCount} OOS-Trades.`,
  };

  const evidenceHash = evidenceContentHash(validationEvidenceInput(body));
  const idempotencyKey = evidenceIdempotencyKey(evidenceHash);
  const report: StrategyValidationReport = { ...body, evidenceHash, idempotencyKey };
  assertReportHashIntegrity(report);
  return Object.freeze(report);
}

/** Anteil positiver Per-Trade-Sharpes unter den auswertbaren Regime-Zellen. */
function regimeStabilityOf(rows: readonly ValidationRegimeRow[]): number | null {
  const evaluable = rows.filter((row): row is ValidationRegimeRow & { sharpe: number } => row.sharpe !== null);
  if (evaluable.length === 0) return null;
  const positive = evaluable.filter((row) => row.sharpe > 0).length;
  return Number((positive / evaluable.length).toFixed(4));
}

/** `sharpe(to)/sharpe(from)` aus den Szenario-Zeilen; `null`, wenn nicht messbar. */
function scenarioRatio(
  stress: StressSummary | null,
  toId: string,
  fromId: string,
): number | null {
  const rows = stress?.scenarios ?? [];
  const from = rows.find((row) => row.id === fromId);
  const to = rows.find((row) => row.id === toId);
  if (!from || !to) return null;
  if (!Number.isFinite(from.sharpe) || from.sharpe <= 0) return null;
  if (!Number.isFinite(to.sharpe)) return null;
  return Number((to.sharpe / from.sharpe).toFixed(4));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7) Evidenz-Abbildung (Hash + Idempotency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kanonisches Detail der Evidenzzeile — ausschließlich Primitive
 * (`string | number | boolean | null`), damit `evidenceContentHash()` die
 * Struktur stabil serialisieren kann. Listen (Annahmen, Regime, Gates) gehen
 * als `canonicalJson`-String hinein — sortierte Keys, stabile Zahlendarstellung.
 */
export function validationEvidenceDetail(
  report: StrategyValidationReportBody | StrategyValidationReport,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    templateId: report.templateId,
    templateVersion: report.templateVersion,
    strategyClass: report.class,
    symbol: report.symbol,
    timeframe: report.timeframe,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    dataQualityScore: report.dataQualityScore,
    robustnessParameterSensitivity: report.robustness.parameterSensitivity,
    robustnessCostStress: report.robustness.costStress,
    robustnessSlippageStress: report.robustness.slippageStress,
    robustnessRegimeStability: report.robustness.regimeStability,
    overfittingTrainOosGap: report.overfitting.trainOosGap,
    overfittingParameterFragility: report.overfitting.parameterFragility,
    overfittingMultipleTestingWarning: report.overfitting.multipleTestingWarning,
    overfittingLookaheadWarning: report.overfitting.lookaheadWarning,
    overfittingHoldoutIntegrity: report.overfitting.holdoutIntegrity,
    auditVerdict: report.gates[0]?.status ?? null,
    auditVersion: report.auditVersion,
    regimeFeatureVersions: report.regimeEvidence.featureVersions.join("|"),
    regimeModelVersions: report.regimeEvidence.modelVersions.join("|"),
    regimeTradesTotal: report.regimeEvidence.tradesTotal,
    regimeAttributedTrades: report.regimeEvidence.attributedTrades,
    regimeUnknownTrades: report.regimeEvidence.unknownRegimeTrades,
    regimeUnattributedTrades: report.regimeEvidence.unattributedTrades,
    regimeMinSampleTrades: report.regimeEvidence.minSampleTrades,
    assumptionsJson: canonicalJson(report.assumptions),
    regimesJson: canonicalJson(report.regimes),
    gatesJson: canonicalJson(report.gates),
    notesJson: canonicalJson(report.notes),
    summary: report.summary,
  });
}

/**
 * Report → `EvidenceInput`. **Die einzige** Abbildung; sowohl der Report-Hash
 * als auch `persist.ts` benutzen sie, damit die geschriebene Zeile exakt den
 * Hash trägt, den der Report behauptet.
 */
export function validationEvidenceInput(
  report: StrategyValidationReportBody | StrategyValidationReport,
): EvidenceInput {
  return {
    strategyKey: report.strategyKey,
    strategyVersion: report.strategyVersion,
    kind: "BACKTEST_RUN",
    result: report.result,
    codeVersion: report.codeVersion,
    policyVersion: report.policyVersion,
    promptVersion: null,
    dataVersion: report.dataVersion,
    ruleKey: null,
    backtestRunId: report.backtestRunId,
    snapshot: {
      metrics: {
        sharpe: report.metrics.sharpe,
        sortino: report.metrics.sortino,
        maxDrawdownPct: report.metrics.maxDrawdownPct,
        winRate: report.metrics.winRate,
        profitFactor: report.metrics.profitFactor,
        expectancy: report.metrics.expectancy,
        tradeCount: report.metrics.tradeCount,
        netPnl: report.metrics.netPnl,
        dataQualityScore: report.dataQualityScore,
      },
      sampleSize: report.metrics.tradeCount,
      windowStartMs: report.windowStart,
      windowEndMs: report.windowEnd,
    },
    eventTimeMs: report.eventTime,
    availableAtMs: report.availableAt,
    computedAtMs: report.computedAt,
    detail: validationEvidenceDetail(report),
  };
}

/** Empfohlener `content_hash` des Reports (`sle1:<sha256>`). */
export function validationEvidenceHash(
  report: StrategyValidationReportBody | StrategyValidationReport,
): string {
  return evidenceContentHash(validationEvidenceInput(report));
}

/** Empfohlener `idempotency_key` des Reports (`slei1:<sha256>`). */
export function validationIdempotencyKey(
  report: StrategyValidationReportBody | StrategyValidationReport,
): string {
  return evidenceIdempotencyKey(validationEvidenceHash(report));
}

/** Prüft, ob ein Report seine eigenen Hash-Felder korrekt trägt (fail-closed). */
export function assertReportHashIntegrity(report: StrategyValidationReport): void {
  const expectedHash = validationEvidenceHash(report);
  if (report.evidenceHash !== expectedHash) {
    throw new Error(
      `validation:hash-mismatch — evidenceHash „${report.evidenceHash.slice(0, 20)}…" passt nicht zum ` +
        `Report-Inhalt („${expectedHash.slice(0, 20)}…"); der Report wurde nachträglich verändert.`,
    );
  }
  const expectedIdempotency = evidenceIdempotencyKey(expectedHash);
  if (report.idempotencyKey !== expectedIdempotency) {
    throw new Error(
      `validation:idempotency-mismatch — idempotencyKey „${report.idempotencyKey.slice(0, 22)}…" passt nicht zum ` +
        `Content-Hash („${expectedIdempotency.slice(0, 22)}…").`,
    );
  }
  assertValidationResult(report.result);
}

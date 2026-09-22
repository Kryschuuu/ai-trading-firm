/**
 * MARKT-REGIME-KLASSIFIKATOR + REGIME-GATE (GAP-06, v1.46.0).
 *
 * Problem: `adaptiveRisk.ts` klassifiziert das VOLATILITÄTS-Regime
 * (NORMAL/ELEVATED/EXTREME) mit Hysterese — aber ausschließlich als
 * Risikofaktor auf Positionsgrößen. Ob ein Markt trendet, seitwärts läuft
 * oder crasht, war nirgends bestimmbar; Mean-Reversion-Signale liefen in
 * Trendmärkten ungedämpft (und umgekehrt).
 *
 * Dieses Modul liefert die fehlende Ebene — deterministisch, KEIN LLM
 * (Architektur-Test in tests/marketRegime.test.ts), nur aus Kerzen:
 *
 *   D1 KLASSIFIKATOR  classifyMarketRegime() — Features: ADX (Wilder,
 *      src/lib/indicators.ts), Regressions-Slope über Schlusskurse,
 *      realisierte Volatilität als Perzentil über den Lookback, Drawdown
 *      vom Fensterhoch. Priorität bei Mehrfachtreffern:
 *      CRASH > HIGH_VOL > TREND_UP/TREND_DOWN > RANGE.
 *      Zeitmaske: die Klassifikation nutzt ausschließlich die übergebenen
 *      (abgeschlossenen) Kerzen ≤ t — kein Lookahead.
 *
 *   D1b MULTIDIM (RMA-P2-01, v1.61.0)  classifyMarketRegimeMultidim()
 *      erweitert den Kern additiv um den versionierten Feature-Vertrag
 *      (`regimeFeatures.ts`: Preis/Volatilität/Liquidität/Perp/optional
 *      Makro) und liefert JEDES Snapshot zusätzlich Confidence, Coverage,
 *      Top-Treiber sowie Feature-/Modellversion:
 *        - Eskalations-Votes aus OK-Familien dürfen die Klasse NUR zum
 *          sichereren HIGH_VOL heben (nie CRASH erfinden, nie Trendrichtung
 *          drehen) — OHLCV-only bleibt identisch zum Altklassifikat
 *          (`featureMode: "ohlcv"` bzw. fehlende Familien ⇒ Degraded Mode).
 *        - Rohklassifikation (raw) und Confidence sind vom bestätigten
 *          Zustand der Hysterese getrennt; flackernde Familien erzeugen
 *          durch Eskalations-/Bestätigungssemantik kein Flapping.
 *        - Point-in-Time: Samples mit `availableAt > asOf` werden verworfen
 *          (kein Look-ahead), fehlende/stale/invalid bleiben `null`-Sample
 *          mit Grundcode (keine Nullsubstitution).
 *
 *   HYSTERESE  MarketRegimeStateMachine — Muster an adaptiveRisk
 *      (RegimeStateMachine) angelehnt: Eskalation (höhere Schwere) ist
 *      SOFORT (sichere Richtung), Seitwärts-/De-Eskalation erst nach
 *      REGIME_CONFIRM_CANDLES konsekutiven bestätigenden Bewertungen.
 *      Einzelne Gegenkerzen wechseln das Regime nicht (Whipsaw-Schutz).
 *
 *   D2 GATE  Regime → Dämpfungsfaktor je Strategieklasse
 *      (mean-reversion / trend / breakout), Werte geklemmt auf [0, 2].
 *      Umsetzung als DATENKONTEXT für ruleEngine/Approver (Faktor
 *      multipliziert das Signalgewicht), NICHT als hartes Veto:
 *        off     → Faktor 1, keine Ausweisung (Prompt byte-identisch),
 *        monitor → Ausweis + Audit, KEINE Wirkung (DEFAULT — Rollout
 *                  monitor-first),
 *        enforce → Faktor wirkt (Engine-Risikobudget-Kontext +
 *                  Mikro-Executor-Sizing, stets gegen die Code-Ceilings
 *                  geklemmt).
 *      UNKNOWN (zu wenig Kerzen) → Faktor 1 + UNKNOWN-Kennzeichnung, nie
 *      still.
 *
 *   D3 SICHTBARKEIT  Regime je Instrument im Ops-Center (Risk-Sektion,
 *      src/ops/collect.ts), Regime-Verlauf in den Cycle-Artefakten
 *      (regime-history.json, src/cycle/artifacts.ts), Audit je
 *      Regime-Wechsel (`regime:SYMBOL:VON→NACH`, Event REGIME_CHANGE) und
 *      je enforce-Dämpfung (REGIME_GATE_APPLIED).
 *
 * Fail-closed-Grundregeln der Serie: Paper-only, keine neuen Runtime-
 * Dependencies, Schwellen mit Bounds + sicherem Default, Mutationen ins
 * audit_log, Determinismus (reine Arithmetik, injizierbare Zeit in Tests).
 */

import { adx } from "./indicators";
import { auditWrite } from "./auditSink";
import { getCandles, type Candle } from "./marketData";
import {
  REGIME_FEATURE_VERSION,
  REGIME_MODEL_VERSION,
  assembleRegimeFeatureVector,
  type RegimeFamilyInputs,
  type RegimeFamilyState,
  type RegimeFeatureFamily,
  type RegimeFeatureMode,
} from "./regimeFeatures";

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

/** Die fünf Markt-Regimes des Klassifikators (D1). */
export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "CRASH";

/** Klassifikationsergebnis inkl. des datenlosen Zustands. */
export type MarketRegimeLabel = MarketRegime | "UNKNOWN";

/** Strategieklasse, auf die das Gate wirkt (D2). */
export type StrategyClass = "mean-reversion" | "trend" | "breakout";

/** Rollout-Modi des Gates — Default ist bewusst monitor-first. */
export type RegimeGateMode = "off" | "monitor" | "enforce";

/** Strukturell kompatible Kerze (marketData.Candle — Importfreiheit für Tests). */
export interface RegimeCandleLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Konstanten & Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/** ADX-Periode (Wilder-Standard). */
export const REGIME_ADX_PERIOD = 14;
/** Fenster (Kerzen) der realisierten Volatilität für das Perzentil. */
export const REGIME_VOL_WINDOW = 20;
/**
 * Mindest-Kerzenzahl für eine Klassifikation. Darunter: UNKNOWN —
 * niemals eine stille Rate-Klassifikation. (2·ADX-Periode + Puffer für
 * Slope/Vol-Perzentil.)
 */
export const MIN_CLASSIFY_CANDLES = 30;
/** Mindestanzahl Vol-Fenster, bevor ein Perzentil sinnvoll ist. */
export const MIN_VOL_SAMPLES = 5;
/** Länge des Regime-Verlaufs je Instrument (Ring-Buffer). */
export const REGIME_HISTORY_LENGTH = 50;
/** Min-Abstand zwischen zwei MARKTSEITIGEN Neubewertungen je Instrument. */
export const REGIME_EVAL_MIN_INTERVAL_MS = 45_000;
/** Kerzen-Intervall der markseitigen Neubewertung (Monitor/Refresh). */
export const REGIME_CANDLE_INTERVAL = "15m";
/** Deckel für markseitige Refresh-Aufrufe (DoS-/Ratenlimit-Schutz). */
export const REGIME_REFRESH_MAX_SYMBOLS = 16;
/** Deckel der Instrument-Ausweisung im Ops-Center. */
export const REGIME_OPS_MAX_INSTRUMENTS = 12;

export const STRATEGY_CLASSES: readonly StrategyClass[] = ["mean-reversion", "trend", "breakout"];

export type MarketRegimeConfig = {
  /** Lookback-Fenster der Klassifikation in Kerzen. */
  lookbackCandles: number;
  /** Drawdown vom Fensterhoch in %, ab dem (mit negativem Slope) CRASH gilt. */
  crashDrawdownPct: number;
  /** Perzentil-Rang der realisierten Volatilität, ab dem HIGH_VOL gilt. */
  highVolPercentile: number;
  /** Konsekutive bestätigende Bewertungen bis Regime-Wechsel (Hysterese). */
  confirmCandles: number;
  /** ADX-Schwelle für TREND_*. */
  trendAdx: number;
  /** Mindest-|Slope| in % pro Kerze für TREND_* (darunter → RANGE). */
  trendSlopePct: number;
  /** Gate-Modus: off | monitor (Default) | enforce. */
  gateMode: RegimeGateMode;
  /** Dämpfungsfaktoren je Regime × Strategieklasse, geklemmt [0, 2]. */
  gateFactors: Record<MarketRegime, Record<StrategyClass, number>>;
  // ── RMA-P2-01 (v1.61.0): multidimensionale Feature-Ebene ──────────────────
  /**
   * `multidim` (Default): Feature-Vertrag wird konsultiert (Eskalations-
   * votes, Confidence, Coverage). `ohlcv`: expliziter Degraded-/Legacy-Pfad —
   * Klassifikation identisch zum OHLCV-Kern, Familien `FAMILY_DISABLED`.
   */
  featureMode: RegimeFeatureMode;
  /** Spread-Schwelle in %, ab der die Liquiditätsfamilie HIGH_VOL stimmt. */
  liquiditySpreadHighPct: number;
  /** |Funding|-Schwelle (fraction je Intervall) für den Perp-HIGH_VOL-Vote. */
  perpFundingAbsThreshold: number;
  /** VIX-Level, ab dem die Makrofamilie HIGH_VOL stimmt (optional). */
  macroVixHigh: number;
  /**
   * Mindest-Coverage, ab der ein Gate-Faktor > 1 (Risiko-Boost) wirken darf.
   * Unterhalb (oder bei Degraded Mode) wird jeder risikoerhöhende Faktor auf
   * 1 geklemmt — Dämpfungen ≤ 1 bleiben jederzeit zulässig (fail-closed).
   */
  minBoostCoverage: number;
};

export const DEFAULT_MARKET_REGIME_CONFIG: MarketRegimeConfig = {
  lookbackCandles: 100,
  crashDrawdownPct: 10,
  highVolPercentile: 90,
  confirmCandles: 3,
  trendAdx: 25,
  trendSlopePct: 0.05,
  gateMode: "monitor",
  featureMode: "multidim",
  liquiditySpreadHighPct: 0.5,
  perpFundingAbsThreshold: 0.001,
  macroVixHigh: 30,
  minBoostCoverage: 1,
  gateFactors: {
    // Vorschlag aus GAP-06: Mean-Reversion in Trends dämpfen, Breakouts in
    // der Range — alles andere ×1 (keine versteckte Boost-/Veto-Logik).
    TREND_UP: { "mean-reversion": 0.5, trend: 1, breakout: 1 },
    TREND_DOWN: { "mean-reversion": 0.5, trend: 1, breakout: 1 },
    RANGE: { "mean-reversion": 1, trend: 1, breakout: 0.5 },
    HIGH_VOL: { "mean-reversion": 1, trend: 1, breakout: 1 },
    CRASH: { "mean-reversion": 1, trend: 1, breakout: 1 },
  },
};

/** Erlaubtes Fenster je Schwelle — Env-/Override-Werte werden geklemmt. */
export const MARKET_REGIME_BOUNDS: Record<
  Exclude<keyof MarketRegimeConfig, "gateMode" | "gateFactors" | "featureMode">,
  [min: number, max: number]
> = {
  lookbackCandles: [20, 500],
  crashDrawdownPct: [3, 50],
  highVolPercentile: [50, 99],
  confirmCandles: [1, 20],
  trendAdx: [10, 60],
  trendSlopePct: [0.005, 1],
  liquiditySpreadHighPct: [0.01, 10],
  perpFundingAbsThreshold: [0.00001, 0.05],
  macroVixHigh: [5, 120],
  minBoostCoverage: [0, 1],
};

/** Bounds der Gate-Faktoren (D2): [0, 2] — Klemmung statt Fehler. */
export const GATE_FACTOR_BOUNDS: readonly [number, number] = [0, 2];

const clampNum = (v: number, [min, max]: readonly [number, number]): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, min), max) : min;

const neutralFactors = (): Record<MarketRegime, Record<StrategyClass, number>> => ({
  TREND_UP: { "mean-reversion": 1, trend: 1, breakout: 1 },
  TREND_DOWN: { "mean-reversion": 1, trend: 1, breakout: 1 },
  RANGE: { "mean-reversion": 1, trend: 1, breakout: 1 },
  HIGH_VOL: { "mean-reversion": 1, trend: 1, breakout: 1 },
  CRASH: { "mean-reversion": 1, trend: 1, breakout: 1 },
});

/**
 * Parst `REGIME_GATE_FACTORS` (Grammatik: `REGIME:klasse=faktor,…`, z. B.
 * `TREND_UP:mean-reversion=0.5,RANGE:breakout=0.25`). Unbekannte Regimes/
 * Klassen oder kaputte Zahlen werden ÜBERSPRUNGEN (nie ein Grund, das Gate
 * stillzulegen); Werte werden auf [0, 2] geklemmt.
 */
export function parseGateFactors(
  raw: string | undefined,
  base: Record<MarketRegime, Record<StrategyClass, number>> = DEFAULT_MARKET_REGIME_CONFIG.gateFactors
): { factors: Record<MarketRegime, Record<StrategyClass, number>>; applied: number; skipped: number } {
  const factors = neutralFactors();
  for (const regime of Object.keys(base) as MarketRegime[]) {
    for (const cls of STRATEGY_CLASSES) factors[regime][cls] = base[regime][cls];
  }
  let applied = 0;
  let skipped = 0;
  if (typeof raw !== "string" || raw.trim() === "") return { factors, applied, skipped };
  for (const partRaw of raw.split(",")) {
    const part = partRaw.trim();
    if (part === "") continue;
    const m = /^([A-Za-z_]+):([a-z-]+)=(-?[0-9.]+)$/.exec(part);
    if (!m) {
      skipped++;
      continue;
    }
    const regime = m[1].toUpperCase() as MarketRegime;
    const cls = m[2] as StrategyClass;
    if (!(regime in factors) || !STRATEGY_CLASSES.includes(cls) || !Number.isFinite(Number(m[3]))) {
      skipped++;
      continue;
    }
    factors[regime][cls] = clampNum(Number(m[3]), GATE_FACTOR_BOUNDS);
    applied++;
  }
  return { factors, applied, skipped };
}

function parseMode(raw: string | undefined): RegimeGateMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "monitor" || v === "enforce") return v;
  // Unbekannter Wert → fail-closed auf den sicheren Default (Ausweis, keine
  // Wirkung). Niemals still enforce.
  return "monitor";
}

function parseFeatureMode(raw: string | undefined): RegimeFeatureMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "ohlcv" || v === "multidim") return v;
  // Unbekannter Wert → dokumentierter Default (multidim mit Degraded-Fallback:
  // fehlende Familien ⇒ OHLCV-Kern — nie ein stiller Legacy-Sonderweg).
  return "multidim";
}

/**
 * Klemmt eine Partial-Konfiguration in die Bounds (Muster:
 * clampVolatilityConfig). Ungültige Werte behalten den Basiswert.
 */
export function clampMarketRegimeConfig(
  raw: Partial<Record<keyof MarketRegimeConfig, unknown>>,
  base: MarketRegimeConfig = DEFAULT_MARKET_REGIME_CONFIG
): MarketRegimeConfig {
  const next: MarketRegimeConfig = {
    ...base,
    gateFactors: { ...base.gateFactors },
  };
  type NumericKey = Exclude<keyof MarketRegimeConfig, "gateMode" | "gateFactors" | "featureMode">;
  const numField = (field: NumericKey): void => {
    const v = raw[field];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    next[field] = clampNum(n, MARKET_REGIME_BOUNDS[field]);
    if (
      field === "lookbackCandles" ||
      field === "confirmCandles"
    ) {
      next[field] = Math.round(next[field]);
    }
  };
  numField("lookbackCandles");
  numField("crashDrawdownPct");
  numField("highVolPercentile");
  numField("confirmCandles");
  numField("trendAdx");
  numField("trendSlopePct");
  numField("liquiditySpreadHighPct");
  numField("perpFundingAbsThreshold");
  numField("macroVixHigh");
  numField("minBoostCoverage");
  if (typeof raw.gateMode === "string") next.gateMode = parseMode(raw.gateMode);
  if (typeof raw.featureMode === "string") next.featureMode = parseFeatureMode(raw.featureMode);
  return next;
}

/**
 * Lädt die Regime-Konfiguration aus der Umgebung (Bounds-Clamp + sichere
 * Defaults; Muster: loadExitConfig/loadFundingConfig). `overrides` (Tests)
 * überschreibt Env-Werte und wird ebenfalls geklemmt.
 */
export function loadMarketRegimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrides: Partial<Record<keyof MarketRegimeConfig, unknown>> = {}
): MarketRegimeConfig {
  const base = clampMarketRegimeConfig({
    lookbackCandles: env.REGIME_LOOKBACK_CANDLES,
    crashDrawdownPct: env.CRASH_DRAWDOWN_PCT,
    highVolPercentile: env.HIGH_VOL_PERCENTILE,
    confirmCandles: env.REGIME_CONFIRM_CANDLES,
    trendAdx: env.REGIME_TREND_ADX,
    trendSlopePct: env.REGIME_TREND_SLOPE_PCT,
    gateMode: env.REGIME_GATE_MODE,
    featureMode: env.REGIME_FEATURE_MODE,
    liquiditySpreadHighPct: env.REGIME_LIQUIDITY_SPREAD_HIGH_PCT,
    perpFundingAbsThreshold: env.REGIME_PERP_FUNDING_ABS,
    macroVixHigh: env.REGIME_MACRO_VIX_HIGH,
    minBoostCoverage: env.REGIME_MIN_BOOST_COVERAGE,
  });
  const { factors } = parseGateFactors(env.REGIME_GATE_FACTORS, base.gateFactors);
  base.gateFactors = factors;
  return clampMarketRegimeConfig(overrides, base);
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 — Klassifikator (reine Arithmetik, keine IO, kein LLM)
// ─────────────────────────────────────────────────────────────────────────────

export type RegimeFeatures = {
  /** ADX (Wilder) — Trendstärke 0–100; null bei zu kurzer Historie. */
  adx: number | null;
  /** OLS-Slope der Schlusskurse in % pro Kerze (normalisiert auf Mittelkurs). */
  slopePctPerCandle: number | null;
  /** Realisierte Volatilität (StdDev der Returns) des letzten Fensters. */
  realizedVol: number | null;
  /** Perzentil-Rang [0, 100] der aktuellen Vol über den Lookback. */
  volPercentile: number | null;
  /** Drawdown in % vom Fensterhoch (Schlusskurse). */
  drawdownPct: number | null;
  /** Anzahl verarbeiteter Kerzen (Zeitmaske-Nachweis). */
  candlesUsed: number;
};

export type RegimeClassification = {
  regime: MarketRegimeLabel;
  /** false = zu wenig Kerzen → UNKNOWN (nie still). */
  known: boolean;
  features: RegimeFeatures;
  reason: string;
};

/** Schwere-Ordnung für die Hysterese: Eskalation = sichere Richtung. */
export const MARKET_REGIME_SEVERITY: Record<MarketRegime, number> = {
  RANGE: 0,
  TREND_UP: 1,
  TREND_DOWN: 1,
  HIGH_VOL: 2,
  CRASH: 3,
};

function olsSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  let ym = 0;
  for (const v of values) ym += v;
  ym /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (values[i] - ym);
    den += (i - xm) * (i - xm);
  }
  return den > 0 ? num / den : 0;
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

/**
 * Deterministische Regime-Klassifikation aus (abgeschlossenen) Kerzen.
 *
 * Zeitmaske: nur die übergebenen Kerzen ≤ t gehen ein — erst die letzten
 * `lookbackCandles`, daraus ADX/Slope/Drawdown direkt und die Volatilität
 * als Perzentil über ALLE Fenster des Lookbacks. Kein Zugriff auf die
 * Zukunft, keine IO.
 *
 * Priorität bei Mehrfachtreffern: CRASH > HIGH_VOL > TREND_* > RANGE.
 */
export function classifyMarketRegime(
  candles: RegimeCandleLike[],
  cfg: MarketRegimeConfig = DEFAULT_MARKET_REGIME_CONFIG
): RegimeClassification {
  const empty: RegimeFeatures = {
    adx: null,
    slopePctPerCandle: null,
    realizedVol: null,
    volPercentile: null,
    drawdownPct: null,
    candlesUsed: Array.isArray(candles) ? candles.length : 0,
  };
  if (!Array.isArray(candles) || candles.length < MIN_CLASSIFY_CANDLES) {
    return {
      regime: "UNKNOWN",
      known: false,
      features: empty,
      reason: `Zu wenig Kerzen für die Klassifikation (${candles?.length ?? 0} < ${MIN_CLASSIFY_CANDLES}) — Regime UNKNOWN, Faktor 1.`,
    };
  }

  const slice = candles.slice(-cfg.lookbackCandles);
  const closes = slice.map((c) => c.close);
  const last = closes[closes.length - 1];

  // ── Features ────────────────────────────────────────────────────────────
  const adxValue = adx(slice as Candle[], REGIME_ADX_PERIOD);

  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const slope = olsSlope(closes);
  const slopePct = Number.isFinite(mean) && mean > 0 ? (slope / mean) * 100 : null;

  // Realisierte Volatilität als Perzentil über den Lookback: StdDev der
  // Returns je REGIME_VOL_WINDOW-Fenster; Rang des AKTUELLEN Fensters.
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  let realizedVol: number | null = null;
  let volPercentile: number | null = null;
  const sds: number[] = [];
  for (let i = 0; i + REGIME_VOL_WINDOW <= returns.length; i++) {
    sds.push(stddev(returns.slice(i, i + REGIME_VOL_WINDOW)));
  }
  if (sds.length >= MIN_VOL_SAMPLES) {
    realizedVol = sds[sds.length - 1];
    // Entarteter Fall: völlig konstante Volatilität (z. B. perfekte Gerade)
    // erzeugt nur Gleichstände — das Perzentil wäre per Tie-Zählung immer
    // 100 und würde HIGH_VOL falsch triggern. Ohne Streuung gibt es keinen
    // relativen Rang → null (kein HIGH_VOL-Trigger).
    const sdSpread = Math.max(...sds) - Math.min(...sds);
    if (sdSpread > 1e-12) {
      const atOrBelow = sds.filter((s) => s <= realizedVol!).length;
      volPercentile = (atOrBelow / sds.length) * 100;
    }
  }

  let drawdownPct: number | null = null;
  if (Number.isFinite(last) && last > 0) {
    const peak = Math.max(...closes);
    if (peak > 0) drawdownPct = ((peak - last) / peak) * 100;
  }

  const features: RegimeFeatures = {
    adx: adxValue,
    slopePctPerCandle: slopePct,
    realizedVol,
    volPercentile,
    drawdownPct,
    candlesUsed: slice.length,
  };

  // ── Entscheidung (strikte Priorität) ────────────────────────────────────
  const crashHit =
    drawdownPct != null &&
    drawdownPct >= cfg.crashDrawdownPct &&
    slopePct != null &&
    slopePct < 0;
  const highVolHit = volPercentile != null && volPercentile >= cfg.highVolPercentile;
  const trendHit =
    adxValue != null &&
    adxValue >= cfg.trendAdx &&
    slopePct != null &&
    Math.abs(slopePct) >= cfg.trendSlopePct;

  let regime: MarketRegime;
  let reason: string;
  if (crashHit) {
    regime = "CRASH";
    reason = `Drawdown ${drawdownPct!.toFixed(2)} % ≥ ${cfg.crashDrawdownPct} % bei negativem Slope (${slopePct!.toFixed(3)} %/Kerze)`;
  } else if (highVolHit) {
    regime = "HIGH_VOL";
    reason = `Vol-Perzentil ${volPercentile!.toFixed(1)} ≥ ${cfg.highVolPercentile} (realisierte Vol ${((realizedVol ?? 0) * 100).toFixed(3)} %)`;
  } else if (trendHit) {
    regime = slopePct! > 0 ? "TREND_UP" : "TREND_DOWN";
    reason = `ADX ${adxValue!.toFixed(1)} ≥ ${cfg.trendAdx} und Slope ${slopePct!.toFixed(3)} %/Kerze (|Slope| ≥ ${cfg.trendSlopePct})`;
  } else {
    regime = "RANGE";
    reason = `Kein Trend-/Vol-/Crash-Trigger (ADX ${adxValue != null ? adxValue.toFixed(1) : "n/v"}, Slope ${slopePct != null ? slopePct.toFixed(3) : "n/v"} %/Kerze, Vol-Perzentil ${volPercentile != null ? volPercentile.toFixed(1) : "n/v"}, Drawdown ${drawdownPct != null ? drawdownPct.toFixed(2) : "n/v"} %)`;
  }

  return { regime, known: true, features, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// D1b — Multidimensionale Klassifikation (RMA-P2-01, v1.61.0)
// ─────────────────────────────────────────────────────────────────────────────

/** Einer der Top-Treiber des gewählten Roh-Regimes (deterministisch). */
export interface RegimeTopDriver {
  /** Feature-Schlüssel aus dem Vertrag bzw. dem OHLCV-Kern. */
  key: string;
  family: "price" | "volatility" | "liquidity" | "perp" | "macro";
  /** Beitrag zu der Evidenz des gewählten Regimes (dokumentierte Formel). */
  contribution: number;
  /** Stabile, formatierte Anzeigezeile (keine Fremdtexte). */
  display: string;
}

/**
 * Multidimensionales Klassifikationsergebnis. Erweitert das bestehende
 * `RegimeClassification` additiv: `regime` bleibt die ROHKLASSIFIKATION vor
 * der Hysterese; `confidence`/`coverage`/`degraded`/`topDrivers`/Versionen
 * sind die neuen Dimensionen (RMA-P2-01).
 */
export type MultidimRegimeClassification = RegimeClassification & {
  /** Rohzustand vor Hysterese (identisch zu `regime`). */
  rawRegime: MarketRegimeLabel;
  /**
   * Deterministische Confidence in [0.2, 0.99] = Evidenz des gewählten
   * Regimes / Summe aller Evidenzen (ε-Anteil je Klasse). `null` bei UNKNOWN.
   */
  confidence: number | null;
  /** Coverage des Feature-Vertrags in [0, 1] (siehe `regimeFeatures.ts`). */
  coverage: number;
  /** true = nicht alle Pflichtfamilien OK → Degraded Mode (OHLCV-Fallback). */
  degraded: boolean;
  mode: RegimeFeatureMode;
  featureVersion: string;
  modelVersion: string;
  topDrivers: RegimeTopDriver[];
  families: RegimeFamilyState[];
  /** Event-/Verfügbarkeitszeit der Preisfamilie (letzte Kerze) oder `null`. */
  dataAsOf: string | null;
};

type RegimeVote = {
  family: RegimeFeatureFamily;
  key: string;
  display: string;
};

/** Evidenzpunkt je Eskalations-Vote einer OK-Familie (dokumentiert). */
export const REGIME_VOTE_WEIGHT = 1;
/** OI-Einbruch (24 h, fraction), ab dem die Perp-Familie HIGH_VOL stimmt. */
export const PERP_OI_COLLAPSE_THRESHOLD = -0.3;
/** Epsilon je Klasse in der Confidence-Rechnung (verhindert 0/0). */
const CONFIDENCE_EPS = 0.01;
const CONFIDENCE_MIN = 0.2;
const CONFIDENCE_MAX = 0.99;

const REGIME_KEYS: readonly MarketRegime[] = ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "CRASH"];

function clampUnit(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/**
 * Deterministische Evidence-Scores je Klasse aus den OHLCV-Features
 * ( dokumentierte Formeln — keine kalibrierten Gewichte, kein Online-Lernen):
 *
 *   CRASH      crashHit ? 1 + min(2, drawdownPct / (2·crashTh)) : 0
 *   HIGH_VOL   highVolHit ? 1 + (volPercentile − volTh)/100 : 0   (zusätzlich + je Vote)
 *   TREND_*    trendHit  ? 1 + min(1, (adx−adxTh)/adxTh)
 *                        + min(1, (|slope|−slopeTh)/slopeTh) : 0  (Richtung via Slope-Vorzeichen)
 *   RANGE      kein Trigger ? 1 + clamp((adxTh − adx)/adxTh, 0, 1) : 0
 *
 * Jede Klasse erhält zusätzlich ε, damit die Confidence nie durch 0/0
 * entartet. Confidence = Evidenz[gewählt] / Σ Evidenzen, geklemmt [0.2, 0.99].
 */
function evidenceScores(
  core: RegimeClassification,
  votes: readonly RegimeVote[],
  cfg: MarketRegimeConfig
): Record<MarketRegime, number> {
  const f = core.features;
  const scores = Object.fromEntries(REGIME_KEYS.map((k) => [k, CONFIDENCE_EPS])) as Record<
    MarketRegime,
    number
  >;
  if (!core.known) return scores;

  const adxV = f.adx;
  const slopeV = f.slopePctPerCandle;
  const crashHit =
    f.drawdownPct != null && f.drawdownPct >= cfg.crashDrawdownPct && slopeV != null && slopeV < 0;
  const highVolHit = f.volPercentile != null && f.volPercentile >= cfg.highVolPercentile;
  const trendHit =
    adxV != null && adxV >= cfg.trendAdx && slopeV != null && Math.abs(slopeV) >= cfg.trendSlopePct;

  if (crashHit && f.drawdownPct != null) {
    scores.CRASH += 1 + Math.min(2, f.drawdownPct / (2 * cfg.crashDrawdownPct));
  }
  if (highVolHit && f.volPercentile != null) {
    scores.HIGH_VOL += 1 + (f.volPercentile - cfg.highVolPercentile) / 100;
  }
  if (trendHit && adxV != null && slopeV != null) {
    const adxPart = clampUnit((adxV - cfg.trendAdx) / cfg.trendAdx);
    const slopePart = clampUnit((Math.abs(slopeV) - cfg.trendSlopePct) / cfg.trendSlopePct);
    const target: MarketRegime = slopeV > 0 ? "TREND_UP" : "TREND_DOWN";
    scores[target] += 1 + adxPart + slopePart;
  }
  if (!crashHit && !highVolHit && !trendHit) {
    const adxHeadroom = adxV != null ? clampUnit((cfg.trendAdx - adxV) / cfg.trendAdx) : 1;
    scores.RANGE += 1 + adxHeadroom;
  }
  for (let i = 0; i < votes.length; i++) {
    scores.HIGH_VOL += REGIME_VOTE_WEIGHT;
  }
  return scores;
}

/** Sammelt die Eskalations-Votes der OK-Familien (nur HIGH_VOL, nie CRASH). */
function collectVotes(
  cfg: MarketRegimeConfig,
  vector: ReturnType<typeof assembleRegimeFeatureVector>
): RegimeVote[] {
  const votes: RegimeVote[] = [];
  const family = (name: RegimeFamilyState["family"]): RegimeFamilyState | undefined =>
    vector.families.find((f) => f.family === name);

  const liq = family("liquidity");
  if (liq?.status === "OK") {
    const spread = liq.samples[0]?.value ?? null;
    if (spread != null && spread * 100 >= cfg.liquiditySpreadHighPct) {
      votes.push({
        family: "liquidity",
        key: "liquidity.relativeSpread",
        display: `Spread ${(spread * 100).toFixed(3)} % ≥ ${cfg.liquiditySpreadHighPct} %`,
      });
    }
  }

  const perp = family("perp");
  if (perp?.status === "OK") {
    const funding = perp.samples.find((s) => s.key === "perp.fundingRate")?.value ?? null;
    if (funding != null && Math.abs(funding) >= cfg.perpFundingAbsThreshold) {
      votes.push({
        family: "perp",
        key: "perp.fundingRate",
        display: `|Funding| ${Math.abs(funding).toFixed(5)} ≥ ${cfg.perpFundingAbsThreshold}`,
      });
    }
    const oi = perp.samples.find((s) => s.key === "perp.openInterestChange24h")?.value ?? null;
    if (oi != null && oi <= PERP_OI_COLLAPSE_THRESHOLD) {
      votes.push({
        family: "perp",
        key: "perp.openInterestChange24h",
        display: `OI-24h ${(oi * 100).toFixed(1)} % ≤ ${PERP_OI_COLLAPSE_THRESHOLD * 100} %`,
      });
    }
  }

  const macro = family("macro");
  if (macro?.status === "OK") {
    const vix = macro.samples[0]?.value ?? null;
    if (vix != null && vix >= cfg.macroVixHigh) {
      votes.push({
        family: "macro",
        key: "macro.vix",
        display: `VIX ${vix.toFixed(1)} ≥ ${cfg.macroVixHigh}`,
      });
    }
  }
  // Deterministische Reihenfolge (Familienreihenfolge des Vertrags, dann Key).
  const order: Record<RegimeVote["family"], number> = { price: 0, volatility: 1, liquidity: 2, perp: 3, macro: 4 };
  return votes.sort((a, b) => order[a.family] - order[b.family] || a.key.localeCompare(b.key));
}

/** Top-Treiber des gewählten Regimes (Beiträge, absteigend, Tie-Break Key). */
function topDriversFor(
  chosen: MarketRegime,
  core: RegimeClassification,
  votes: readonly RegimeVote[],
  cfg: MarketRegimeConfig
): RegimeTopDriver[] {
  const f = core.features;
  const drivers: RegimeTopDriver[] = [];
  const adxV = f.adx;
  const slopeV = f.slopePctPerCandle;
  const crashHit =
    f.drawdownPct != null && f.drawdownPct >= cfg.crashDrawdownPct && slopeV != null && slopeV < 0;
  const highVolHit = f.volPercentile != null && f.volPercentile >= cfg.highVolPercentile;
  const trendHit =
    adxV != null && adxV >= cfg.trendAdx && slopeV != null && Math.abs(slopeV) >= cfg.trendSlopePct;

  if (chosen === "CRASH" && crashHit && f.drawdownPct != null) {
    drivers.push({
      key: "drawdownPct",
      family: "price",
      contribution: 1 + Math.min(2, f.drawdownPct / (2 * cfg.crashDrawdownPct)),
      display: `Drawdown ${f.drawdownPct.toFixed(2)} %`,
    });
    if (slopeV != null) {
      drivers.push({
        key: "slopePctPerCandle",
        family: "price",
        contribution: CONFIDENCE_EPS,
        display: `Slope ${slopeV.toFixed(3)} %/Kerze`,
      });
    }
  } else if (chosen === "HIGH_VOL") {
    if (highVolHit && f.volPercentile != null) {
      drivers.push({
        key: "volatility.realizedPercentile",
        family: "volatility",
        contribution: 1 + (f.volPercentile - cfg.highVolPercentile) / 100,
        display: `Vol-Perzentil ${f.volPercentile.toFixed(1)}`,
      });
    }
    for (const vote of votes) {
      drivers.push({
        key: vote.key,
        family: vote.family,
        contribution: REGIME_VOTE_WEIGHT,
        display: vote.display,
      });
    }
    if (drivers.length === 0 && f.volPercentile != null) {
      drivers.push({
        key: "volatility.realizedPercentile",
        family: "volatility",
        contribution: CONFIDENCE_EPS,
        display: `Vol-Perzentil ${f.volPercentile.toFixed(1)}`,
      });
    }
  } else if ((chosen === "TREND_UP" || chosen === "TREND_DOWN") && trendHit && adxV != null && slopeV != null) {
    drivers.push({
      key: "adx",
      family: "price",
      contribution: 1 + clampUnit((adxV - cfg.trendAdx) / cfg.trendAdx),
      display: `ADX ${adxV.toFixed(1)}`,
    });
    drivers.push({
      key: "slopePctPerCandle",
      family: "price",
      contribution: clampUnit((Math.abs(slopeV) - cfg.trendSlopePct) / cfg.trendSlopePct),
      display: `Slope ${slopeV >= 0 ? "+" : ""}${slopeV.toFixed(3)} %/Kerze`,
    });
  } else if (chosen === "RANGE") {
    const adxHeadroom = adxV != null ? clampUnit((cfg.trendAdx - adxV) / cfg.trendAdx) : 1;
    drivers.push({
      key: "adx",
      family: "price",
      contribution: 1 + adxHeadroom,
      display: adxV != null ? `ADX ${adxV.toFixed(1)} (unter Schwellwerten)` : "ADX n/v",
    });
  }

  return drivers
    .sort((a, b) => b.contribution - a.contribution || a.key.localeCompare(b.key))
    .slice(0, 5);
}

export type ClassifyMultidimOptions = {
  /** As-of-Zeitpunkt (ms) der Bewertung — Defaults: letzte Kerzenzeit/0. */
  asOfMs?: number;
  /** Erweiterte Familien-Inputs (PIT-gefiltert). `null`/fehlend = OHLCV-Fallback. */
  families?: RegimeFamilyInputs | null;
};

/**
 * Multidimensionale, point-in-time-sichere Regime-Klassifikation (RMA-P2-01).
 *
 * Kompatibilitätsvertrag:
 *   - OHLCV-Kern (`classifyMarketRegime`) liefert weiterhin die Basisklasse;
 *     ohne verfügbare erweiterte Familien (oder `featureMode: "ohlcv"`) ist
 *     das Ergebnis KLASSE-IDENTISCH zum Altklassifikat — nur die neuen
 *     Dimensionen (Confidence/Coverage/…) kommen additiv dazu.
 *   - OK-Familien dürfen die Klasse ausschließlich zu `HIGH_VOL` eskalieren
 *     (sichere Richtung); `CRASH` und Trendrichtungen entstehen ausschließlich
 *     aus abgeschlossenen Kerzen.
 *   - Samples mit `availableAt > asOf` gelangen nie in die Entscheidung.
 */
export function classifyMarketRegimeMultidim(
  candles: RegimeCandleLike[],
  cfg: MarketRegimeConfig = DEFAULT_MARKET_REGIME_CONFIG,
  opts: ClassifyMultidimOptions = {}
): MultidimRegimeClassification {
  const core = classifyMarketRegime(candles, cfg);
  const list = Array.isArray(candles) ? candles : [];
  const lastCandle = list.length > 0 ? list[list.length - 1] : null;
  const asOfMs =
    opts.asOfMs ?? (lastCandle && Number.isFinite(lastCandle.time) ? lastCandle.time : Date.now());

  const vector = assembleRegimeFeatureVector({
    asOfMs,
    mode: cfg.featureMode,
    price: lastCandle ? { close: lastCandle.close, eventTimeMs: lastCandle.time } : null,
    volatility: {
      volPercentile: core.features.volPercentile,
      eventTimeMs: lastCandle ? lastCandle.time : null,
    },
    families: cfg.featureMode === "multidim" ? (opts.families ?? null) : null,
  });

  const coverage = vector.coverage;
  const degraded = vector.degraded;

  if (!core.known) {
    return {
      ...core,
      rawRegime: "UNKNOWN",
      confidence: null,
      coverage,
      degraded: true,
      mode: cfg.featureMode,
      featureVersion: REGIME_FEATURE_VERSION,
      modelVersion: REGIME_MODEL_VERSION,
      topDrivers: [],
      families: vector.families,
      dataAsOf: lastCandle ? new Date(lastCandle.time).toISOString() : null,
    };
  }

  const votes = cfg.featureMode === "multidim" ? collectVotes(cfg, vector) : [];
  const coreRegime = core.regime as MarketRegime;
  // Eskalation nur zur sicheren Richtung: votes sind ausschließlich HIGH_VOL.
  const escalates = votes.length > 0 && MARKET_REGIME_SEVERITY.HIGH_VOL > MARKET_REGIME_SEVERITY[coreRegime];
  const raw: MarketRegime = escalates ? "HIGH_VOL" : coreRegime;

  const scores = evidenceScores(core, votes, cfg);
  const total = REGIME_KEYS.reduce((sum, k) => sum + scores[k], 0);
  const confidenceRaw = total > 0 ? scores[raw] / total : 0.5;
  const confidence = Math.round(Math.min(Math.max(confidenceRaw, CONFIDENCE_MIN), CONFIDENCE_MAX) * 1e4) / 1e4;

  const topDrivers = topDriversFor(raw, core, votes, cfg);
  const reason =
    escalates
      ? `${core.reason} — Eskalation zu HIGH_VOL durch ${votes.map((v) => v.family).join("+")} (${votes.map((v) => v.display).join("; ")})`
      : core.reason;

  return {
    regime: raw,
    known: true,
    features: core.features,
    reason,
    rawRegime: raw,
    confidence,
    coverage,
    degraded,
    mode: cfg.featureMode,
    featureVersion: REGIME_FEATURE_VERSION,
    modelVersion: REGIME_MODEL_VERSION,
    topDrivers,
    families: vector.families,
    dataAsOf: lastCandle ? new Date(lastCandle.time).toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hysterese (Muster: adaptiveRisk RegimeStateMachine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regime-Hysterese gegen Whipsaws an Klassengrenzen.
 *
 * - Erstbewertung: wird SOFORT übernommen (Basislinie).
 * - Eskalation (Schwere ↑, z. B. RANGE → HIGH_VOL → CRASH): SOFORT — die
 *   sichere Richtung (Dämpfung/Risiko-Sicht schaltet schneller ein).
 * - Seitwärts-/De-Eskalation: erst nach `confirmCandles` konsekutiven
 *   bestätigenden Bewertungen; ein anderer Kandidat (oder der aktuelle
 *   Zustand) bricht die Streak ab. Einzelne Gegenkerzen wechseln das
 *   Regime nicht.
 *
 * Reine Klasse ohne IO — in Tests mit Sequenzen beliebig simulierbar.
 */
export class MarketRegimeStateMachine {
  private current: MarketRegime | null = null;
  private pending: MarketRegime | null = null;
  private confirmStreak = 0;

  get regime(): MarketRegime | null {
    return this.current;
  }
  get streak(): number {
    return this.confirmStreak;
  }
  get pendingCandidate(): MarketRegime | null {
    return this.pending;
  }

  reset(): void {
    this.current = null;
    this.pending = null;
    this.confirmStreak = 0;
  }

  update(candidate: MarketRegime, confirmCandles: number): { regime: MarketRegime; changed: boolean } {
    const need = Math.max(1, Math.trunc(confirmCandles) || 1);

    if (this.current === null) {
      this.current = candidate;
      this.pending = null;
      this.confirmStreak = 0;
      return { regime: candidate, changed: true };
    }
    if (candidate === this.current) {
      this.pending = null;
      this.confirmStreak = 0;
      return { regime: this.current, changed: false };
    }

    if (MARKET_REGIME_SEVERITY[candidate] > MARKET_REGIME_SEVERITY[this.current]) {
      // Eskalation: sofort (sichere Richtung).
      this.current = candidate;
      this.pending = null;
      this.confirmStreak = 0;
      return { regime: candidate, changed: true };
    }

    // Seitwärts (z. B. TREND_UP → TREND_DOWN) oder De-Eskalation: bestätigen.
    if (this.pending === candidate) this.confirmStreak += 1;
    else {
      this.pending = candidate;
      this.confirmStreak = 1;
    }
    if (this.confirmStreak >= need) {
      this.current = candidate;
      this.pending = null;
      this.confirmStreak = 0;
      return { regime: candidate, changed: true };
    }
    return { regime: this.current, changed: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D2 — Gate (Datenkontext, kein hartes Veto)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_GATE_FACTORS = DEFAULT_MARKET_REGIME_CONFIG.gateFactors;

export type RegimeGateApplication = {
  mode: RegimeGateMode;
  regime: MarketRegimeLabel;
  strategyClass: StrategyClass | null;
  /** Konfigurierter Faktor (off/UNKNOWN/ohne Klasse: 1), geklemmt [0, 2]. */
  factor: number;
  inputWeight: number;
  /** weight × factor — NUR im enforce-Modus unterschiedlich vom Input. */
  effectiveWeight: number;
  /** true = enforce UND Faktor ≠ 1 UND Regime bekannt UND Klasse vorhanden. */
  applied: boolean;
  /** true = Regime UNKNOWN (zu wenig Kerzen) — Faktor 1, nie still. */
  unknown: boolean;
  /** Coverage des Feature-Vertrags (Default 1, wenn nicht übergeben). */
  coverage: number;
  /** true = Degraded Mode (nicht alle Pflichtfamilien OK). */
  degraded: boolean;
  /**
   * true = ein konfigurierter Risiko-Boost (> 1) wurde wegen zu niedriger
   * Coverage bzw. Degraded Mode auf 1 geklemmt (fail-closed, nie still:
   * der Grund steht in `reason`).
   */
  boostBlocked: boolean;
  reason: string;
};

/** Faktor je Regime × Strategieklasse (UNKNOWN/ohne Klasse → 1). */
export function regimeGateFactor(
  regime: MarketRegimeLabel,
  strategyClass: StrategyClass | null,
  cfg: MarketRegimeConfig = DEFAULT_MARKET_REGIME_CONFIG
): number {
  if (regime === "UNKNOWN" || strategyClass == null) return 1;
  const f = cfg.gateFactors[regime]?.[strategyClass];
  return clampNum(Number.isFinite(f) ? (f as number) : 1, GATE_FACTOR_BOUNDS);
}

/**
 * Wendet das Regime-Gate auf ein Signalgewicht an — als DATENKONTEXT:
 *
 *   off     → Faktor 1, applied=false (Entscheidungspfad byte-identisch),
 *   monitor → Faktor wird ausgewiesen, applied=false (KEINE Wirkung),
 *   enforce → applied=true genau wenn Faktor ≠ 1; effectiveWeight =
 *             inputWeight × factor.
 *
 * UNKNOWN → Faktor 1 + unknown=true (fail-closed, nie still). Ohne
 * Strategieklasse kein Faktor (keine stillschweigende Klassifizierung).
 *
 * Coverage-Schutz (RMA-P2-01): Ein risikoerhöhender Faktor (> 1) wirkt nur,
 * wenn `degraded !== true` UND `coverage ≥ minBoostCoverage` (Default 1.0).
 * Unterhalb dieser Schwelle wird der Faktor auf 1 geklemmt (`boostBlocked`);
 * Dämpfungen ≤ 1 bleiben davon nie betroffen. Fehlende Coverage-Angabe
 * (Alt-Aufrufe) zählt als 1 / nicht degradiert — bestehende Defaults ändern
 * sich dadurch nicht.
 */
export function applyRegimeGate(input: {
  regime: MarketRegimeLabel;
  strategyClass: StrategyClass | null;
  weight: number;
  mode?: RegimeGateMode;
  cfg?: MarketRegimeConfig;
  /** Coverage des Snapshot (Default 1). */
  coverage?: number;
  /** Degraded-Flag des Snapshot (Default false). */
  degraded?: boolean;
}): RegimeGateApplication {
  const cfg = input.cfg ?? DEFAULT_MARKET_REGIME_CONFIG;
  const mode = input.mode ?? cfg.gateMode;
  const weight = Number.isFinite(input.weight) ? input.weight : 0;
  const unknown = input.regime === "UNKNOWN";
  const coverage =
    input.coverage != null && Number.isFinite(input.coverage)
      ? Math.min(Math.max(input.coverage, 0), 1)
      : 1;
  const degraded = input.degraded === true;
  const minBoostCoverage =
    Number.isFinite(cfg.minBoostCoverage) && cfg.minBoostCoverage >= 0
      ? Math.min(cfg.minBoostCoverage, 1)
      : 1;

  let factor = 1;
  if (mode !== "off" && !unknown && input.strategyClass != null) {
    factor = regimeGateFactor(input.regime, input.strategyClass, cfg);
  }

  // Fail-closed Coverage-Klemmung: nie risikoerhöhend bei fehlender
  // Abdeckung — vor der enforce-Anwendung, damit `applied` ehrlich bleibt.
  let boostBlocked = false;
  if (factor > 1 && (degraded || coverage < minBoostCoverage)) {
    factor = 1;
    boostBlocked = true;
  }

  const applied = mode === "enforce" && !unknown && input.strategyClass != null && factor !== 1;
  const effectiveWeight = applied ? weight * factor : weight;

  let reason: string;
  if (unknown) reason = "Regime UNKNOWN (zu wenig Kerzen) — Faktor 1, keine Dämpfung (nie still).";
  else if (boostBlocked)
    reason = `Coverage ${(coverage * 100).toFixed(0)} %${degraded ? " (Degraded Mode)" : ""} < Mindest-Coverage ${(minBoostCoverage * 100).toFixed(0)} % — risikoerhöhender Faktor auf 1 geklemmt (fail-closed).`;
  else if (input.strategyClass == null) reason = "Keine Strategieklasse ableitbar — Faktor 1.";
  else if (mode === "off") reason = "Gate-Modus off — keine Ausweisung, keine Wirkung.";
  else if (mode === "monitor")
    reason =
      factor === 1
        ? `Regime ${input.regime}: keine Dämpfung für ${input.strategyClass} (monitor, keine Wirkung).`
        : `Regime ${input.regime}: Faktor ${factor.toFixed(2)} für ${input.strategyClass} (monitor: Ausweis + Audit, OHNE Wirkung).`;
  else
    reason =
      factor === 1
        ? `Regime ${input.regime}: keine Dämpfung für ${input.strategyClass} (enforce).`
        : `Regime ${input.regime}: Signalgewicht × ${factor.toFixed(2)} für ${input.strategyClass} (enforce).`;

  return {
    mode,
    regime: input.regime,
    strategyClass: input.strategyClass,
    factor,
    inputWeight: weight,
    effectiveWeight,
    applied,
    unknown,
    coverage,
    degraded,
    boostBlocked,
    reason,
  };
}

/**
 * Deterministische Strategieklasse aus einem Mission-Template (regelbasiert,
 * keine Heuristik über Inhalte): `mean-reversion`/`reversion`/`contrarian`
 * → mean-reversion; `breakout` → breakout; `trend`/`momentum` → trend.
 * Sonst null (→ Faktor 1, nie stillschweigende Zuordnung).
 */
export function strategyClassOfTemplate(templateId: string | null | undefined): StrategyClass | null {
  if (typeof templateId !== "string" || templateId.trim() === "") return null;
  const t = templateId.trim().toLowerCase();
  if (t.includes("mean-reversion") || t.includes("reversion") || t.includes("contrarian")) return "mean-reversion";
  if (t.includes("breakout")) return "breakout";
  if (t.includes("trend") || t.includes("momentum")) return "trend";
  return null;
}

export type RegimeGateExecutionSnapshot = {
  mode: RegimeGateMode;
  regime: MarketRegimeLabel;
  factor: number;
  applied: boolean;
  unknown: boolean;
  /** Coverage des zugrunde liegenden Regime-Snapshots (1, wenn keiner da). */
  coverage: number;
  degraded: boolean;
  boostBlocked: boolean;
};

/**
 * Gate-Auflösung für den Mikro-Executor (nur LESERAM-Zugriff, keine IO):
 * wirkt ausschließlich im enforce-Modus; fehlendes Regime-Snapshot oder
 * UNKNOWN → Faktor 1 (fail-safe, kein Raten). Coverage/Degraded des
 * Snapshots fließen mit ein — risikoerhörende Faktoren (> 1) werden bei
 * zu niedriger Coverage wie in `applyRegimeGate` geklemmt.
 */
export function resolveRegimeGateForExecution(
  symbol: string,
  strategyClass: StrategyClass | null,
  cfg: MarketRegimeConfig = loadMarketRegimeConfig()
): RegimeGateExecutionSnapshot {
  const snapshot = getInstrumentRegime(symbol);
  const regime: MarketRegimeLabel = snapshot?.regime ?? "UNKNOWN";
  const coverage = snapshot?.coverage ?? 1;
  const degraded = snapshot?.degraded ?? false;
  if (cfg.gateMode !== "enforce") {
    return {
      mode: cfg.gateMode,
      regime,
      factor: 1,
      applied: false,
      unknown: regime === "UNKNOWN",
      coverage,
      degraded,
      boostBlocked: false,
    };
  }
  const gate = applyRegimeGate({
    regime,
    strategyClass,
    weight: 1,
    mode: "enforce",
    cfg,
    coverage,
    degraded,
  });
  return {
    mode: cfg.gateMode,
    regime,
    factor: gate.factor,
    applied: gate.applied,
    unknown: gate.unknown,
    coverage,
    degraded,
    boostBlocked: gate.boostBlocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 — Laufzeit-Zustand je Instrument (globalThis, HMR-sicher)
// ─────────────────────────────────────────────────────────────────────────────

export type RegimeChangeEvent = {
  at: string;
  symbol: string;
  from: MarketRegimeLabel;
  to: MarketRegimeLabel;
  reason: string;
  /** Maschinenlesbarer Code: `regime:SYMBOL:VON→NACH`. */
  code: string;
  // RMA-P2-01 (additiv): Dimensionen des auslösenden Snapshots.
  rawRegime: MarketRegimeLabel;
  confidence: number | null;
  coverage: number;
  degraded: boolean;
  featureVersion: string;
  modelVersion: string;
};

export type InstrumentRegimeSnapshot = {
  symbol: string;
  regime: MarketRegimeLabel;
  known: boolean;
  at: string | null;
  features: RegimeFeatures;
  reason: string;
  lastChange: RegimeChangeEvent | null;
  changeCount: number;
  // ── RMA-P2-01 (v1.61.0): multidimensionale Dimensionen (additiv) ──────────
  /** Rohklassifikation vor Hysteresebestätigung. */
  rawRegime: MarketRegimeLabel;
  /** Confidence [0.2, 0.99] der Rohklassifikation; `null` bei UNKNOWN. */
  confidence: number | null;
  /** Coverage des Feature-Vertrags [0, 1]. */
  coverage: number;
  /** true = Degraded Mode (OHLCV-Fallback, nicht alle Pflichtfamilien OK). */
  degraded: boolean;
  mode: RegimeFeatureMode;
  featureVersion: string;
  modelVersion: string;
  topDrivers: RegimeTopDriver[];
  families: RegimeFamilyState[];
  /** Event-/Verfügbarkeitszeit der Datenbasis (letzte Kerze) oder `null`. */
  dataAsOf: string | null;
};

type InstrumentState = {
  machine: MarketRegimeStateMachine;
  regime: MarketRegimeLabel;
  classification: MultidimRegimeClassification | null;
  lastEvalAt: number | null;
  history: RegimeChangeEvent[];
  changeCount: number;
};

const G = globalThis as typeof globalThis & {
  __marketRegime?: { instruments: Map<string, InstrumentState> };
};

function state(): NonNullable<(typeof G)["__marketRegime"]> {
  G.__marketRegime ??= { instruments: new Map() };
  return G.__marketRegime;
}

function snapshotOf(symbol: string, st: InstrumentState): InstrumentRegimeSnapshot {
  return {
    symbol,
    regime: st.regime,
    known: st.regime !== "UNKNOWN",
    at: st.lastEvalAt != null ? new Date(st.lastEvalAt).toISOString() : null,
    features: st.classification?.features ?? {
      adx: null,
      slopePctPerCandle: null,
      realizedVol: null,
      volPercentile: null,
      drawdownPct: null,
      candlesUsed: 0,
    },
    reason: st.classification?.reason ?? "Noch keine Bewertung erfolgt.",
    lastChange: st.history.length > 0 ? st.history[st.history.length - 1] : null,
    changeCount: st.changeCount,
    rawRegime: st.classification?.rawRegime ?? "UNKNOWN",
    confidence: st.classification?.confidence ?? null,
    coverage: st.classification?.coverage ?? 0,
    degraded: st.classification?.degraded ?? true,
    mode: st.classification?.mode ?? "multidim",
    featureVersion: st.classification?.featureVersion ?? REGIME_FEATURE_VERSION,
    modelVersion: st.classification?.modelVersion ?? REGIME_MODEL_VERSION,
    topDrivers: st.classification?.topDrivers ? [...st.classification.topDrivers] : [],
    families: st.classification?.families ? st.classification.families.map((f) => ({ ...f })) : [],
    dataAsOf: st.classification?.dataAsOf ?? null,
  };
}

async function writeRegimeChangeAudit(event: RegimeChangeEvent): Promise<void> {
  const alarm = event.to === "CRASH" || event.to === "HIGH_VOL" || event.to === "UNKNOWN";
  try {
    await auditWrite("REGIME_CHANGE", alarm ? "WARN" : "INFO", event, {
      auditClass: alarm ? "security" : "telemetry",
    });
  } catch {
    /* Audit ist best-effort — ein Auditfehler darf die Klassifikation nicht brechen. */
  }
}

export type EvaluateRegimeOptions = {
  cfg?: MarketRegimeConfig;
  /** Fester Zeitstempel (ms) für Determinismus in Tests; zugleich `asOf`. */
  now?: number;
  /** Audit unterdrücken (z. B. reine Unit-Tests). */
  audit?: boolean;
  /**
   * PIT-gefilterte Feature-Inputs der erweiterten Familien (vom Live-Loader
   * `regimeFamilyInputs.ts` oder aus Backtest-Fixtures). `null`/fehlend ⇒
   * Degraded Mode mit OHLCV-Kern (kein IO in diesem Modul).
   */
  families?: RegimeFamilyInputs | null;
};

/**
 * Bewertet das Regime eines Instruments aus (abgeschlossenen) Kerzen —
 * reine Arithmetik + Hysterese; Regime-Wechsel werden im Verlauf
 * protokolliert und (best-effort) auditiert (`regime:SYMBOL:VON→NACH`).
 * UNKNOWN bei zu wenig Kerzen berührt die Hysterese-Maschine nicht.
 *
 * Rohklassifikation (`rawRegime`) und Confidence kommen aus
 * `classifyMarketRegimeMultidim`; die Maschine bestätigt wie zuvor mit
 * `confirmCandles` (Eskalation sofort) — erweiterte Flacker-Familien können
 * den bestätigten Zustand damit nicht hin- und herwerfen.
 */
export function evaluateInstrumentRegime(
  symbolRaw: string,
  candles: RegimeCandleLike[],
  opts: EvaluateRegimeOptions = {}
): InstrumentRegimeSnapshot {
  const symbol = String(symbolRaw ?? "").toUpperCase();
  const cfg = opts.cfg ?? loadMarketRegimeConfig();
  const nowMs = opts.now ?? Date.now();
  const s = state();
  let st = s.instruments.get(symbol);
  if (!st) {
    st = {
      machine: new MarketRegimeStateMachine(),
      regime: "UNKNOWN",
      classification: null,
      lastEvalAt: null,
      history: [],
      changeCount: 0,
    };
    s.instruments.set(symbol, st);
  }

  const classification = classifyMarketRegimeMultidim(candles, cfg, {
    asOfMs: nowMs,
    families: opts.families ?? null,
  });
  const from = st.regime;
  let to: MarketRegimeLabel;
  if (!classification.known) {
    to = "UNKNOWN"; // nie still — aber die Maschine bleibt unangetastet.
  } else {
    to = st.machine.update(classification.regime as MarketRegime, cfg.confirmCandles).regime;
  }

  st.classification = classification;
  st.lastEvalAt = nowMs;

  if (to !== from) {
    const event: RegimeChangeEvent = {
      at: new Date(st.lastEvalAt).toISOString(),
      symbol,
      from,
      to,
      reason: classification.reason,
      code: `regime:${symbol}:${from}→${to}`,
      rawRegime: classification.rawRegime,
      confidence: classification.confidence,
      coverage: classification.coverage,
      degraded: classification.degraded,
      featureVersion: classification.featureVersion,
      modelVersion: classification.modelVersion,
    };
    st.history.push(event);
    if (st.history.length > REGIME_HISTORY_LENGTH) st.history.shift();
    st.changeCount += 1;
    if (opts.audit !== false) void writeRegimeChangeAudit(event);
  }
  st.regime = to;
  return snapshotOf(symbol, st);
}

/**
 * Markseitige Neubewertung mehrerer Instrumente (Monitor-Tick): holt je
 * Symbol `lookbackCandles` 15m-Kerzen und klassifiziert. Min-Interval je
 * Symbol, Fehler bleiben pro Symbol lokal (kein Abbruch, kein Raten).
 * Wirft NIE — der Aufrufer bekommt Snapshots (ggf. zuletzt bekannten Stand).
 */
export async function refreshInstrumentRegimes(
  symbols: string[],
  opts: {
    cfg?: MarketRegimeConfig;
    force?: boolean;
    now?: number;
    fetchCandles?: (symbol: string, limit: number) => Promise<Candle[]>;
    /** Audit unterdrücken (Tests). */
    audit?: boolean;
    /**
     * Erweiterte Feature-Familien je Symbol (LIVE-Loader aus
     * `regimeFamilyInputs.ts` — bewusst injizierbar, damit dieses Modul
     * ohne IO bleibt). Ohne Loader: Degraded Mode mit OHLCV-Kern.
     */
    loadFamilies?: (symbol: string, nowMs: number) => RegimeFamilyInputs | null | undefined;
  } = {}
): Promise<InstrumentRegimeSnapshot[]> {
  const cfg = opts.cfg ?? loadMarketRegimeConfig();
  const nowMs = opts.now ?? Date.now();
  const fetcher =
    opts.fetchCandles ?? ((sym: string, limit: number) => getCandles(sym, REGIME_CANDLE_INTERVAL, limit));
  const unique = [...new Set((symbols ?? []).map((x) => String(x ?? "").toUpperCase()).filter(Boolean))].slice(
    0,
    REGIME_REFRESH_MAX_SYMBOLS
  );
  const out: InstrumentRegimeSnapshot[] = [];
  const s = state();
  for (const symbol of unique) {
    const existing = s.instruments.get(symbol);
    if (
      !opts.force &&
      existing?.lastEvalAt != null &&
      nowMs - existing.lastEvalAt < REGIME_EVAL_MIN_INTERVAL_MS
    ) {
      out.push(snapshotOf(symbol, existing));
      continue;
    }
    try {
      const candles = await fetcher(symbol, cfg.lookbackCandles);
      let families: RegimeFamilyInputs | null = null;
      if (opts.loadFamilies) {
        try {
          families = opts.loadFamilies(symbol, nowMs) ?? null;
        } catch {
          families = null; // Loader-Fehler ⇒ Degraded Mode, nie ein Wurf.
        }
      }
      out.push(
        evaluateInstrumentRegime(symbol, candles, { cfg, now: nowMs, audit: opts.audit, families })
      );
    } catch {
      // Datenfehler → letzten bekannten Stand ausweisen (nie raten, nie werfen).
      if (existing) out.push(snapshotOf(symbol, existing));
    }
  }
  return out;
}

/** Synchroner RAM-Snapshot eines Instruments (null = noch nie bewertet). */
export function getInstrumentRegime(symbolRaw: string): InstrumentRegimeSnapshot | null {
  const symbol = String(symbolRaw ?? "").toUpperCase();
  const st = state().instruments.get(symbol);
  return st ? snapshotOf(symbol, st) : null;
}

export type MarketRegimeStatus = {
  mode: RegimeGateMode;
  instruments: InstrumentRegimeSnapshot[];
  evaluatedAt: string | null;
};

/**
 * Ops-Center-Snapshot (Risk-Sektion): Gate-Modus + Regimes je Instrument,
 * nach Schwere sortiert (CRASH zuerst), gekappt. Reine RAM-Lese, keine IO.
 */
export function getMarketRegimeStatus(cfg: MarketRegimeConfig = loadMarketRegimeConfig()): MarketRegimeStatus {
  const s = state();
  const instruments = [...s.instruments.entries()]
    .map(([symbol, st]) => snapshotOf(symbol, st))
    .sort((a, b) => {
      const sev = (r: MarketRegimeLabel): number => (r === "UNKNOWN" ? -1 : MARKET_REGIME_SEVERITY[r]);
      if (sev(b.regime) !== sev(a.regime)) return sev(b.regime) - sev(a.regime);
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, REGIME_OPS_MAX_INSTRUMENTS);
  const latest = instruments.reduce<string | null>(
    (acc, i) => (i.at != null && (acc == null || i.at > acc) ? i.at : acc),
    null
  );
  return { mode: cfg.gateMode, instruments, evaluatedAt: latest };
}

/**
 * Regime-Verlauf für die Cycle-Artefakte (Muster src/cycle/artifacts.ts):
 * `regime-history.json` im Tages-Artefaktverzeichnis. null = noch keine
 * Bewertung in diesem Prozess (dann wird kein Artefakt geschrieben).
 *
 * `schemaVersion: 2` (RMA-P2-01): je Instrument zusätzlich Rohklasse,
 * Confidence, Coverage, Degraded, Feature-/Modellversion, Top-Treiber und
 * Familienstatus — gebounded wie bisher (Historie ≤ REGIME_HISTORY_LENGTH).
 */
export function collectRegimeHistoryArtifact(
  cfg: MarketRegimeConfig = loadMarketRegimeConfig()
): {
  schemaVersion: number;
  asOf: string;
  mode: RegimeGateMode;
  featureMode: RegimeFeatureMode;
  featureVersion: string;
  modelVersion: string;
  instruments: unknown[];
} | null {
  const s = state();
  if (s.instruments.size === 0) return null;
  const instruments = [...s.instruments.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol, st]) => ({
      symbol,
      regime: st.regime,
      rawRegime: st.classification?.rawRegime ?? "UNKNOWN",
      confidence: st.classification?.confidence ?? null,
      coverage: st.classification?.coverage ?? 0,
      degraded: st.classification?.degraded ?? true,
      featureVersion: st.classification?.featureVersion ?? REGIME_FEATURE_VERSION,
      modelVersion: st.classification?.modelVersion ?? REGIME_MODEL_VERSION,
      topDrivers: st.classification?.topDrivers ?? [],
      families: (st.classification?.families ?? []).map((f) => ({
        family: f.family,
        status: f.status,
        reason: f.reason,
      })),
      lastEvalAt: st.lastEvalAt != null ? new Date(st.lastEvalAt).toISOString() : null,
      dataAsOf: st.classification?.dataAsOf ?? null,
      reason: st.classification?.reason ?? null,
      features: st.classification?.features ?? null,
      changeCount: st.changeCount,
      history: [...st.history],
    }));
  return {
    schemaVersion: 2,
    asOf: new Date().toISOString(),
    mode: cfg.gateMode,
    featureMode: cfg.featureMode,
    featureVersion: REGIME_FEATURE_VERSION,
    modelVersion: REGIME_MODEL_VERSION,
    instruments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-Kontext (Engine/Approver — Datenkontext, kein Veto)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministische Prompt-Zeile für den Approver-/Entscheidungskontext der
 * Engine (GAP-06). Leer bei Modus `off` (Prompt bleibt byte-identisch).
 * Erweitert (RMA-P2-01) um Confidence, Coverage und Degraded-Kennzeichnung —
 * nur in `monitor`/`enforce`, `off` bleibt leer.
 */
export function formatRegimeGateContext(
  snapshot: InstrumentRegimeSnapshot,
  strategyClass: StrategyClass | null,
  gate: RegimeGateApplication
): string {
  if (gate.mode === "off") return "";
  const f = snapshot.features;
  const featureLine = [
    `ADX ${f.adx != null ? f.adx.toFixed(1) : "n/v"}`,
    `Slope ${f.slopePctPerCandle != null ? `${f.slopePctPerCandle >= 0 ? "+" : ""}${f.slopePctPerCandle.toFixed(3)} %/Kerze` : "n/v"}`,
    `Drawdown ${f.drawdownPct != null ? `${f.drawdownPct.toFixed(2)} %` : "n/v"}`,
    `Vol-Perzentil ${f.volPercentile != null ? f.volPercentile.toFixed(0) : "n/v"}`,
  ].join(", ");
  const dims = [
    snapshot.confidence != null ? `Conf ${snapshot.confidence.toFixed(2)}` : "Conf n/v",
    `Coverage ${(snapshot.coverage * 100).toFixed(0)} %`,
    snapshot.degraded ? "Degraded (OHLCV-Fallback)" : "Full",
    `Rohklasse ${snapshot.rawRegime}`,
  ].join(" · ");
  const classPart = strategyClass != null ? ` · Strategieklasse ${strategyClass}` : " · keine Strategieklasse ableitbar";
  const effect =
    gate.mode === "monitor"
      ? gate.factor !== 1 && !gate.unknown && strategyClass != null
        ? ` → Faktor ${gate.factor.toFixed(2)} (MONITOR: Ausweis + Audit, keine Wirkung auf die Entscheidung)`
        : " → keine Dämpfung (MONITOR: Ausweis + Audit, keine Wirkung)"
      : gate.applied
        ? ` → Faktor ${gate.factor.toFixed(2)} WIRKT: Signalgewicht × ${gate.factor.toFixed(2)} (enforce)`
        : gate.boostBlocked
          ? ` → Boost wegen Coverage geklemmt: Faktor 1 (enforce, fail-closed)`
          : " → Faktor 1 (enforce: keine Dämpfung)";
  return `REGIME-GATE ${snapshot.symbol}: Regime ${snapshot.regime} (${featureLine}) · ${dims}${classPart}${effect}. Modi: off/monitor/enforce (REGIME_GATE_MODE).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Leert den kompletten Laufzeit-Zustand (nur für Tests). */
export function __resetMarketRegimeForTests(): void {
  delete G.__marketRegime;
}

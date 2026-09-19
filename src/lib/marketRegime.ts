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
};

export const DEFAULT_MARKET_REGIME_CONFIG: MarketRegimeConfig = {
  lookbackCandles: 100,
  crashDrawdownPct: 10,
  highVolPercentile: 90,
  confirmCandles: 3,
  trendAdx: 25,
  trendSlopePct: 0.05,
  gateMode: "monitor",
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
  Exclude<keyof MarketRegimeConfig, "gateMode" | "gateFactors">,
  [min: number, max: number]
> = {
  lookbackCandles: [20, 500],
  crashDrawdownPct: [3, 50],
  highVolPercentile: [50, 99],
  confirmCandles: [1, 20],
  trendAdx: [10, 60],
  trendSlopePct: [0.005, 1],
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
  const numField = (field: Exclude<keyof MarketRegimeConfig, "gateMode" | "gateFactors">): void => {
    const v = raw[field];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    next[field] = clampNum(n, MARKET_REGIME_BOUNDS[field]);
    if (field === "lookbackCandles" || field === "confirmCandles") next[field] = Math.round(next[field]);
  };
  numField("lookbackCandles");
  numField("crashDrawdownPct");
  numField("highVolPercentile");
  numField("confirmCandles");
  numField("trendAdx");
  numField("trendSlopePct");
  if (typeof raw.gateMode === "string") next.gateMode = parseMode(raw.gateMode);
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
 */
export function applyRegimeGate(input: {
  regime: MarketRegimeLabel;
  strategyClass: StrategyClass | null;
  weight: number;
  mode?: RegimeGateMode;
  cfg?: MarketRegimeConfig;
}): RegimeGateApplication {
  const cfg = input.cfg ?? DEFAULT_MARKET_REGIME_CONFIG;
  const mode = input.mode ?? cfg.gateMode;
  const weight = Number.isFinite(input.weight) ? input.weight : 0;
  const unknown = input.regime === "UNKNOWN";

  let factor = 1;
  if (mode !== "off" && !unknown && input.strategyClass != null) {
    factor = regimeGateFactor(input.regime, input.strategyClass, cfg);
  }

  const applied = mode === "enforce" && !unknown && input.strategyClass != null && factor !== 1;
  const effectiveWeight = applied ? weight * factor : weight;

  let reason: string;
  if (unknown) reason = "Regime UNKNOWN (zu wenig Kerzen) — Faktor 1, keine Dämpfung (nie still).";
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
};

/**
 * Gate-Auflösung für den Mikro-Executor (nur LESERAM-Zugriff, keine IO):
 * wirkt ausschließlich im enforce-Modus; fehlendes Regime-Snapshot oder
 * UNKNOWN → Faktor 1 (fail-safe, kein Raten).
 */
export function resolveRegimeGateForExecution(
  symbol: string,
  strategyClass: StrategyClass | null,
  cfg: MarketRegimeConfig = loadMarketRegimeConfig()
): RegimeGateExecutionSnapshot {
  const snapshot = getInstrumentRegime(symbol);
  const regime: MarketRegimeLabel = snapshot?.regime ?? "UNKNOWN";
  if (cfg.gateMode !== "enforce") {
    return { mode: cfg.gateMode, regime, factor: 1, applied: false, unknown: regime === "UNKNOWN" };
  }
  const gate = applyRegimeGate({ regime, strategyClass, weight: 1, mode: "enforce", cfg });
  return { mode: cfg.gateMode, regime, factor: gate.factor, applied: gate.applied, unknown: gate.unknown };
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
};

type InstrumentState = {
  machine: MarketRegimeStateMachine;
  regime: MarketRegimeLabel;
  classification: RegimeClassification | null;
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
  /** Fester Zeitstempel (ms) für Determinismus in Tests. */
  now?: number;
  /** Audit unterdrücken (z. B. reine Unit-Tests). */
  audit?: boolean;
};

/**
 * Bewertet das Regime eines Instruments aus (abgeschlossenen) Kerzen —
 * reine Arithmetik + Hysterese; Regime-Wechsel werden im Verlauf
 * protokolliert und (best-effort) auditiert (`regime:SYMBOL:VON→NACH`).
 * UNKNOWN bei zu wenig Kerzen berührt die Hysterese-Maschine nicht.
 */
export function evaluateInstrumentRegime(
  symbolRaw: string,
  candles: RegimeCandleLike[],
  opts: EvaluateRegimeOptions = {}
): InstrumentRegimeSnapshot {
  const symbol = String(symbolRaw ?? "").toUpperCase();
  const cfg = opts.cfg ?? loadMarketRegimeConfig();
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

  const classification = classifyMarketRegime(candles, cfg);
  const from = st.regime;
  let to: MarketRegimeLabel;
  if (!classification.known) {
    to = "UNKNOWN"; // nie still — aber die Maschine bleibt unangetastet.
  } else {
    to = st.machine.update(classification.regime as MarketRegime, cfg.confirmCandles).regime;
  }

  st.classification = classification;
  st.lastEvalAt = opts.now ?? Date.now();

  if (to !== from) {
    const event: RegimeChangeEvent = {
      at: new Date(st.lastEvalAt).toISOString(),
      symbol,
      from,
      to,
      reason: classification.reason,
      code: `regime:${symbol}:${from}→${to}`,
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
      out.push(evaluateInstrumentRegime(symbol, candles, { cfg, now: nowMs, audit: opts.audit }));
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
 */
export function collectRegimeHistoryArtifact(
  cfg: MarketRegimeConfig = loadMarketRegimeConfig()
): { schemaVersion: number; asOf: string; mode: RegimeGateMode; instruments: unknown[] } | null {
  const s = state();
  if (s.instruments.size === 0) return null;
  const instruments = [...s.instruments.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol, st]) => ({
      symbol,
      regime: st.regime,
      lastEvalAt: st.lastEvalAt != null ? new Date(st.lastEvalAt).toISOString() : null,
      reason: st.classification?.reason ?? null,
      features: st.classification?.features ?? null,
      changeCount: st.changeCount,
      history: [...st.history],
    }));
  return {
    schemaVersion: 1,
    asOf: new Date().toISOString(),
    mode: cfg.gateMode,
    instruments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-Kontext (Engine/Approver — Datenkontext, kein Veto)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministische Prompt-Zeile für den Approver-/Entscheidungskontext der
 * Engine (GAP-06). Leer bei Modus `off` (Prompt bleibt byte-identisch).
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
  const classPart = strategyClass != null ? ` · Strategieklasse ${strategyClass}` : " · keine Strategieklasse ableitbar";
  const effect =
    gate.mode === "monitor"
      ? gate.factor !== 1 && !gate.unknown && strategyClass != null
        ? ` → Faktor ${gate.factor.toFixed(2)} (MONITOR: Ausweis + Audit, keine Wirkung auf die Entscheidung)`
        : " → keine Dämpfung (MONITOR: Ausweis + Audit, keine Wirkung)"
      : gate.applied
        ? ` → Faktor ${gate.factor.toFixed(2)} WIRKT: Signalgewicht × ${gate.factor.toFixed(2)} (enforce)`
        : " → Faktor 1 (enforce: keine Dämpfung)";
  return `REGIME-GATE ${snapshot.symbol}: Regime ${snapshot.regime} (${featureLine})${classPart}${effect}. Modi: off/monitor/enforce (REGIME_GATE_MODE).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Leert den kompletten Laufzeit-Zustand (nur für Tests). */
export function __resetMarketRegimeForTests(): void {
  delete G.__marketRegime;
}

/**
 * Versionierte Konfiguration des Markt-Scanners (Task 04).
 *
 * Die eingebaute {@link DEFAULT_SCANNER_CONFIG} ist die Quelle der Wahrheit und
 * wird in `src/scanner/scanner.config.json` als lesbare, versionierbare Vorlage
 * gespiegelt (ein Test erzwingt Deckungsgleichheit). Über
 * `SCANNER_CONFIG_FILE=/pfad/config.json` lässt sich sie ersetzen; die Datei
 * wird beim Laden **validiert** — eine kaputte Konfiguration bricht laut ab,
 * statt still schwächere Regeln zu aktivieren.
 *
 * Alle Schwellen, Gewichte und Trichtergrößen leben hier. Kein Faktor liest
 * Umgebungsvariablen selbst.
 */

import { readFileSync } from "node:fs";
import { ASSET_CLASSES, MARKET_TYPES, type AssetClass, type MarketType } from "@/universe/types";
import { SCORE_COMPONENTS, type ScoreComponent } from "./types";

/** Fehler einer ungültigen Scanner-Konfiguration (Meldung ohne Secrets). */
export class ScannerConfigError extends Error {
  /** Maschinenlesbarer Code für den API-Fehler-Contract. */
  readonly code = "SCANNER_CONFIG_ERROR";
  constructor(message: string) {
    super(`Scanner-Konfiguration ungültig: ${message}`);
    this.name = "ScannerConfigError";
  }
}

/** Gewichte der neun Score-Komponenten (Summe exakt 1). */
export type ScoreWeights = Record<ScoreComponent, number>;

/** Parameter des Liquiditätsfaktors. */
export interface LiquidityConfig {
  /** Volumen (Quote), ab dem der normierte Wert > 0 wird. */
  minVolume24h: number;
  /** Volumen (Quote), ab dem der normierte Wert 1 erreicht. */
  maxVolume24h: number;
}

/** Parameter des Spread-Faktors. */
export interface SpreadConfig {
  /** Relativer Spread, der als bestmöglich gilt (→ 1). */
  bestSpread: number;
  /** Relativer Spread, ab dem der Faktor 0 ist. */
  worstSpread: number;
}

/** Parameter des ATR-Faktors (Stop-Abstände). */
export interface AtrConfig {
  /** Wilder-Periode. */
  period: number;
  /** Unterhalb: zu wenig Bewegung für sinnvolle Stops (→ 0). */
  floorPct: number;
  /** Untere Grenze des Sweet Spots. */
  idealLowPct: number;
  /** Obere Grenze des Sweet Spots. */
  idealHighPct: number;
  /** Oberhalb: Stops müssten unwirtschaftlich weit stehen (→ 0). */
  ceilingPct: number;
}

/** Parameter der realisierten Volatilität. */
export interface VolatilityConfig {
  /** Anzahl Perioden (Renditen), über die σ berechnet wird. */
  lookback: number;
  /** Perioden pro Jahr für die Annualisierung (365 = Tageskerzen, 24/7). */
  periodsPerYear: number;
  /** Unterhalb: zu ruhig (→ 0). */
  floor: number;
  /** Untere Grenze des Sweet Spots. */
  idealLow: number;
  /** Obere Grenze des Sweet Spots. */
  idealHigh: number;
  /** Oberhalb: unhandelbar volatil (→ 0). */
  ceiling: number;
}

/** Parameter des Momentum-Faktors. */
export interface MomentumConfig {
  /** Rückblick-Fenster in Perioden. */
  lookbacks: number[];
  /** Gewichte der Fenster (gleiche Länge, Summe 1). */
  lookbackWeights: number[];
  /** Rendite-Betrag, der den normierten Wert 1 ergibt. */
  scale: number;
  /** `absolute` = Bewegung zählt in beide Richtungen, `directional` = nur long. */
  mode: "absolute" | "directional";
}

/** Parameter des Trend-Faktors (EMA-Struktur). */
export interface TrendConfig {
  /** Schnelle EMA. */
  fastPeriod: number;
  /** Mittlere EMA. */
  midPeriod: number;
  /** Langsame EMA. */
  slowPeriod: number;
  /** Relativer EMA-Abstand, der volle Stärke bedeutet. */
  scale: number;
}

/** Parameter des Volumen-Verhältnisses. */
export interface VolumeRatioConfig {
  /** Fenster des jüngeren Durchschnitts. */
  recentPeriods: number;
  /** Fenster des Referenzdurchschnitts. */
  basePeriods: number;
  /** Verhältnis, das 0 ergibt. */
  minRatio: number;
  /** Verhältnis, das 1 ergibt. */
  maxRatio: number;
}

/** Parameter des RSI-Faktors. */
export interface RsiConfig {
  /** Wilder-Periode. */
  period: number;
  /** Abstand von 50, bis zu dem der Faktor 1 bleibt (30…70 bei 20). */
  neutralBand: number;
  /** Abstand von 50, ab dem der Faktor 0 ist (0/100 bei 50). */
  extremeBand: number;
}

/** Parameter des Drawdown-Faktors. */
export interface DrawdownConfig {
  /** Fenster in Perioden. */
  lookback: number;
  /** Drawdown, ab dem der Faktor 0 ist (0.5 = −50 %). */
  maxDrawdown: number;
}

/** Parameter des Korrelationsfaktors. */
export interface CorrelationConfig {
  /** Fenster in Renditen. */
  lookback: number;
  /** Verfahren: Pearson (Default) oder Spearman (Rangkorrelation). */
  method: "pearson" | "spearman";
  /** Benchmark-Instrument-ID (nur Doku/Artefakt; Serien werden injiziert). */
  benchmarkInstrumentId: string;
}

/** Parameter der deterministischen News-Risiko-Heuristik. */
export interface NewsConfig {
  /** Risikobeitrag je Meldung der letzten 24 h. */
  weightEvents24h: number;
  /** Risikobeitrag je Meldung der letzten 7 Tage. */
  weightEvents7d: number;
  /** Risikobeitrag je High-Impact-Meldung. */
  weightHighImpact: number;
  /** Risikobeitrag eines terminierten Ereignisses im Horizont. */
  weightScheduled: number;
  /** Horizont in Stunden, in dem ein Termin als Risiko zählt. */
  scheduledHorizonHours: number;
  /** Alter von `lastSeen` in Stunden, ab dem Datenveralterung als Risiko zählt. */
  stalenessHours: number;
  /** Risikobeitrag veralteter Registry-Daten. */
  weightStaleness: number;
  /** Angenommenes Risiko ohne News-Kontext (konservativ, nicht 0). */
  neutralRisk: number;
}

/** Parameter des Funding-Faktors. */
export interface FundingConfig {
  /** Funding-Intervalle pro Jahr, falls das Instrument keins meldet (8 h ⇒ 1095). */
  defaultIntervalsPerYear: number;
  /** Annualisierte Funding-Kosten, ab denen der Faktor 0 ist. */
  maxAnnualized: number;
  /** Wert für Instrumente ohne Funding (Spot) — dort entstehen keine Kosten. */
  spotValue: number;
}

/** Parameter des Open-Interest-Faktors. */
export interface OpenInterestConfig {
  /** OI (Quote), ab dem der normierte Wert > 0 wird. */
  minOpenInterest: number;
  /** OI (Quote), ab dem der normierte Wert 1 erreicht. */
  maxOpenInterest: number;
  /** Neutralwert für Instrumente ohne OI-Begriff (Spot/Aktien). */
  neutralValue: number;
}

/** Parameter der Handelskosten (Execution). */
export interface ExecutionConfig {
  /** `taker` = 2 × Taker-Fee, `maker` = 2 × Maker-Fee, `blend` = Maker+Taker. */
  feeMode: "taker" | "maker" | "blend";
  /** Ob der Spread zu den Roundturn-Kosten addiert wird. */
  includeSpread: boolean;
  /** Roundturn-Kosten, die als bestmöglich gelten (→ 1). */
  bestCost: number;
  /** Roundturn-Kosten, ab denen der Faktor 0 ist. */
  worstCost: number;
}

/** Schwellen der Volatilitäts-Regime (annualisierte realisierte Volatilität). */
export interface RegimeConfig {
  /** `< low` ⇒ LOW. */
  low: number;
  /** `< normal` ⇒ NORMAL. */
  normal: number;
  /** `< high` ⇒ HIGH, sonst EXTREME. */
  high: number;
}

/** Größen der Trichter-Ebenen. */
export interface FunnelConfig {
  /** Maximale Anzahl „geeigneter“ Instrumente (Ebene 2). */
  eligibleMax: number;
  /** Maximale Anzahl „interessanter“ Instrumente (Ebene 3). */
  interestingMax: number;
  /** Mindest-Score für „interessant“. */
  interestingMinScore: number;
  /** Größe der Daily Rotation (Ebene 4). */
  dailyMax: number;
  /** Mindestzahl Deep-Analyse-Kandidaten. */
  deepMin: number;
  /** Höchstzahl Deep-Analyse-Kandidaten. */
  deepMax: number;
  /** Diversifikation: max. Instrumente je Anlageklasse in der Deep-Liste. */
  maxPerAssetClass: number;
}

/** Harte Filterregeln der Ebene „geeignet“. */
export interface FilterConfig {
  /** Nur `status === "active"`. */
  requireStatusActive: boolean;
  /** Nur `paperAvailable === true`. */
  requirePaperAvailable: boolean;
  /** Erlaubte Markttypen. */
  allowedMarketTypes: MarketType[];
  /** Erlaubte Anlageklassen. */
  allowedAssetClasses: AssetClass[];
  /** Mindest-24h-Volumen (Quote). */
  minVolume24h: number;
  /** Maximaler relativer Spread. */
  maxSpread: number;
  /** Mindestanzahl Kerzen für belastbare Faktoren. */
  minCandles: number;
  /** Maximaler Drawdown im Lookback. */
  maxDrawdown: number;
  /** Maximale Roundturn-Handelskosten. */
  maxExecutionCost: number;
  /** EXTREME-Regime ausschließen. */
  excludeExtremeRegime: boolean;
}

/** Schwellen der Weekly-Klassifikation. */
export interface WeeklyConfig {
  /** Mindest-Score für CORE. */
  coreMinScore: number;
  /** Mindest-24h-Volumen für CORE. */
  coreMinVolume24h: number;
  /** Mindestzahl vorheriger Reviews, in denen das Instrument enthalten war. */
  coreMinPersistence: number;
  /** Mindest-Score für ROTATION. */
  rotationMinScore: number;
  /** Mindest-Score, ab dem ein Neuling DISCOVERY statt EXCLUDED wird. */
  discoveryMinScore: number;
  /** Relativer Liquiditätsrückgang, der eine Herabstufung auslöst (0.5 = −50 %). */
  liquidityDropPct: number;
  /** Relative Gebührenerhöhung, die eine Herabstufung auslöst. */
  feeIncreasePct: number;
  /** |r| gegen den Benchmark, ab dem ein Instrument als Cluster-Mitglied gilt. */
  clusterCorrelation: number;
}

/** Vollständige, versionierte Scanner-Konfiguration. */
export interface ScannerConfig {
  /** Schema-/Konfigurationsversion (erscheint in jedem Artefakt). */
  version: number;
  /** Freitext-Beschreibung. */
  description: string;
  /** Gewichte der neun Score-Komponenten. */
  weights: ScoreWeights;
  /** Faktor-Parameter. */
  factors: {
    liquidity: LiquidityConfig;
    spread: SpreadConfig;
    atr: AtrConfig;
    volatility: VolatilityConfig;
    momentum: MomentumConfig;
    trend: TrendConfig;
    volumeRatio: VolumeRatioConfig;
    rsi: RsiConfig;
    drawdown: DrawdownConfig;
    correlation: CorrelationConfig;
    news: NewsConfig;
    funding: FundingConfig;
    openInterest: OpenInterestConfig;
    execution: ExecutionConfig;
  };
  /** Regime-Schwellen. */
  regime: RegimeConfig;
  /** Trichtergrößen. */
  funnel: FunnelConfig;
  /** Filterregeln. */
  filters: FilterConfig;
  /** Weekly-Schwellen. */
  weekly: WeeklyConfig;
}

/**
 * Eingebaute Default-Konfiguration (Version 1).
 *
 * Gewichte exakt nach Vorgabe: 25/15/15/10/10/10/5/5/5 (= 100 %).
 * Trichter exakt nach Vorgabe: 2.000 → 500 → 100 (+20–40 Deep).
 */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  version: 1,
  description:
    "Deterministischer Markt-Scanner (Task 04): Faktor-Parameter, Score-Gewichte, " +
    "Regime-Schwellen, Trichtergrößen und Filterregeln. Kein LLM, kein Netzwerk.",
  weights: {
    liquidity: 0.25,
    volatility: 0.15,
    trend: 0.15,
    momentum: 0.1,
    spread: 0.1,
    volume: 0.1,
    correlation: 0.05,
    news: 0.05,
    execution: 0.05,
  },
  factors: {
    liquidity: { minVolume24h: 100_000, maxVolume24h: 10_000_000_000 },
    spread: { bestSpread: 0.0001, worstSpread: 0.005 },
    atr: { period: 14, floorPct: 0.002, idealLowPct: 0.01, idealHighPct: 0.04, ceilingPct: 0.12 },
    volatility: {
      lookback: 30,
      periodsPerYear: 365,
      floor: 0.05,
      idealLow: 0.2,
      idealHigh: 0.8,
      ceiling: 2.5,
    },
    momentum: { lookbacks: [5, 20, 60], lookbackWeights: [0.2, 0.3, 0.5], scale: 0.3, mode: "absolute" },
    trend: { fastPeriod: 9, midPeriod: 21, slowPeriod: 50, scale: 0.1 },
    volumeRatio: { recentPeriods: 5, basePeriods: 20, minRatio: 0.5, maxRatio: 2 },
    rsi: { period: 14, neutralBand: 20, extremeBand: 50 },
    drawdown: { lookback: 60, maxDrawdown: 0.5 },
    correlation: { lookback: 30, method: "pearson", benchmarkInstrumentId: "BINANCE:BTCUSDT" },
    news: {
      weightEvents24h: 0.08,
      weightEvents7d: 0.02,
      weightHighImpact: 0.2,
      weightScheduled: 0.3,
      scheduledHorizonHours: 48,
      stalenessHours: 48,
      weightStaleness: 0.2,
      neutralRisk: 0.25,
    },
    funding: { defaultIntervalsPerYear: 1095, maxAnnualized: 0.5, spotValue: 1 },
    openInterest: { minOpenInterest: 100_000, maxOpenInterest: 5_000_000_000, neutralValue: 0.5 },
    execution: { feeMode: "taker", includeSpread: true, bestCost: 0.0005, worstCost: 0.005 },
  },
  regime: { low: 0.25, normal: 0.6, high: 1.2 },
  funnel: {
    eligibleMax: 2000,
    interestingMax: 500,
    interestingMinScore: 55,
    dailyMax: 100,
    deepMin: 20,
    deepMax: 40,
    maxPerAssetClass: 8,
  },
  filters: {
    requireStatusActive: true,
    requirePaperAvailable: true,
    allowedMarketTypes: ["spot", "perpetual", "future"],
    allowedAssetClasses: ["crypto", "equity", "etf", "fx", "commodity", "index"],
    minVolume24h: 1_000_000,
    maxSpread: 0.005,
    minCandles: 30,
    maxDrawdown: 0.8,
    maxExecutionCost: 0.006,
    excludeExtremeRegime: true,
  },
  weekly: {
    coreMinScore: 70,
    coreMinVolume24h: 50_000_000,
    coreMinPersistence: 1,
    rotationMinScore: 55,
    discoveryMinScore: 40,
    liquidityDropPct: 0.5,
    feeIncreasePct: 0.5,
    clusterCorrelation: 0.9,
  },
};

/** Toleranz, mit der die Gewichtssumme geprüft wird (Gleitkomma). */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

/** Rekursive Teilstruktur — Overrides dürfen beliebig flach angegeben werden. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly (infer _U)[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tiefer Merge: `patch` überschreibt `base` feldweise (Arrays werden ersetzt). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue; // unbekannte Schlüssel werden ignoriert (kein Schmuggelpfad)
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function num(value: unknown, path: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new ScannerConfigError(`${path}: erwartet endliche Zahl`);
  if (opts.int && !Number.isInteger(n)) throw new ScannerConfigError(`${path}: erwartet Ganzzahl`);
  if (opts.min !== undefined && n < opts.min) throw new ScannerConfigError(`${path}: muss ≥ ${opts.min} sein`);
  if (opts.max !== undefined && n > opts.max) throw new ScannerConfigError(`${path}: muss ≤ ${opts.max} sein`);
  return n;
}

function ordered(values: number[], path: string): void {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i] > values[i - 1])) {
      throw new ScannerConfigError(`${path}: Schwellen müssen streng aufsteigend sein`);
    }
  }
}

/**
 * Validiert eine (fremde) Konfiguration vollständig und liefert eine
 * bereinigte, tief kopierte Instanz.
 *
 * @throws {ScannerConfigError} bei Strukturfehlern, unplausiblen Schwellen oder
 *   einer Gewichtssumme ≠ 1.
 */
export function validateScannerConfig(raw: unknown): ScannerConfig {
  if (!isPlainObject(raw)) throw new ScannerConfigError("erwartet Objekt");
  const cfg = deepMerge(structuredClone(DEFAULT_SCANNER_CONFIG), raw);

  cfg.version = num(cfg.version, "version", { min: 1, int: true });
  cfg.description = typeof cfg.description === "string" ? cfg.description.slice(0, 1000) : "";

  // ── Gewichte: alle Komponenten vorhanden, ≥ 0, Summe exakt 1 ──────────────
  let sum = 0;
  for (const component of SCORE_COMPONENTS) {
    const w = num(cfg.weights?.[component], `weights.${component}`, { min: 0, max: 1 });
    cfg.weights[component] = w;
    sum += w;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new ScannerConfigError(`weights: Summe muss 1 sein (ist ${sum})`);
  }

  const f = cfg.factors;
  f.liquidity.minVolume24h = num(f.liquidity.minVolume24h, "factors.liquidity.minVolume24h", { min: 1 });
  f.liquidity.maxVolume24h = num(f.liquidity.maxVolume24h, "factors.liquidity.maxVolume24h", { min: 1 });
  ordered([f.liquidity.minVolume24h, f.liquidity.maxVolume24h], "factors.liquidity");

  f.spread.bestSpread = num(f.spread.bestSpread, "factors.spread.bestSpread", { min: 0 });
  f.spread.worstSpread = num(f.spread.worstSpread, "factors.spread.worstSpread", { min: 0 });
  ordered([f.spread.bestSpread, f.spread.worstSpread], "factors.spread");
  f.correlation.benchmarkInstrumentId =
    typeof f.correlation.benchmarkInstrumentId === "string"
      ? f.correlation.benchmarkInstrumentId.slice(0, 64)
      : DEFAULT_SCANNER_CONFIG.factors.correlation.benchmarkInstrumentId;

  f.atr.period = num(f.atr.period, "factors.atr.period", { min: 2, max: 500, int: true });
  f.atr.floorPct = num(f.atr.floorPct, "factors.atr.floorPct", { min: 0 });
  f.atr.idealLowPct = num(f.atr.idealLowPct, "factors.atr.idealLowPct", { min: 0 });
  f.atr.idealHighPct = num(f.atr.idealHighPct, "factors.atr.idealHighPct", { min: 0 });
  f.atr.ceilingPct = num(f.atr.ceilingPct, "factors.atr.ceilingPct", { min: 0 });
  ordered([f.atr.floorPct, f.atr.idealLowPct, f.atr.idealHighPct, f.atr.ceilingPct], "factors.atr");

  f.volatility.lookback = num(f.volatility.lookback, "factors.volatility.lookback", { min: 2, max: 5000, int: true });
  f.volatility.periodsPerYear = num(f.volatility.periodsPerYear, "factors.volatility.periodsPerYear", { min: 1 });
  f.volatility.floor = num(f.volatility.floor, "factors.volatility.floor", { min: 0 });
  f.volatility.idealLow = num(f.volatility.idealLow, "factors.volatility.idealLow", { min: 0 });
  f.volatility.idealHigh = num(f.volatility.idealHigh, "factors.volatility.idealHigh", { min: 0 });
  f.volatility.ceiling = num(f.volatility.ceiling, "factors.volatility.ceiling", { min: 0 });
  ordered(
    [f.volatility.floor, f.volatility.idealLow, f.volatility.idealHigh, f.volatility.ceiling],
    "factors.volatility"
  );

  if (!Array.isArray(f.momentum.lookbacks) || !f.momentum.lookbacks.length) {
    throw new ScannerConfigError("factors.momentum.lookbacks: mindestens ein Fenster");
  }
  if (f.momentum.lookbacks.length !== f.momentum.lookbackWeights.length) {
    throw new ScannerConfigError("factors.momentum: lookbacks und lookbackWeights müssen gleich lang sein");
  }
  f.momentum.lookbacks = f.momentum.lookbacks.map((v, i) =>
    num(v, `factors.momentum.lookbacks[${i}]`, { min: 1, max: 5000, int: true })
  );
  const mWeightSum = f.momentum.lookbackWeights.reduce(
    (a, v, i) => a + num(v, `factors.momentum.lookbackWeights[${i}]`, { min: 0 }),
    0
  );
  if (Math.abs(mWeightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new ScannerConfigError(`factors.momentum.lookbackWeights: Summe muss 1 sein (ist ${mWeightSum})`);
  }
  f.momentum.scale = num(f.momentum.scale, "factors.momentum.scale", { min: 1e-6 });
  if (f.momentum.mode !== "absolute" && f.momentum.mode !== "directional") {
    throw new ScannerConfigError("factors.momentum.mode: erwartet absolute|directional");
  }

  f.trend.fastPeriod = num(f.trend.fastPeriod, "factors.trend.fastPeriod", { min: 1, max: 5000, int: true });
  f.trend.midPeriod = num(f.trend.midPeriod, "factors.trend.midPeriod", { min: 1, max: 5000, int: true });
  f.trend.slowPeriod = num(f.trend.slowPeriod, "factors.trend.slowPeriod", { min: 1, max: 5000, int: true });
  ordered([f.trend.fastPeriod, f.trend.midPeriod, f.trend.slowPeriod], "factors.trend");
  f.trend.scale = num(f.trend.scale, "factors.trend.scale", { min: 1e-6 });

  f.volumeRatio.recentPeriods = num(f.volumeRatio.recentPeriods, "factors.volumeRatio.recentPeriods", {
    min: 1,
    max: 5000,
    int: true,
  });
  f.volumeRatio.basePeriods = num(f.volumeRatio.basePeriods, "factors.volumeRatio.basePeriods", {
    min: 1,
    max: 5000,
    int: true,
  });
  f.volumeRatio.minRatio = num(f.volumeRatio.minRatio, "factors.volumeRatio.minRatio", { min: 0 });
  f.volumeRatio.maxRatio = num(f.volumeRatio.maxRatio, "factors.volumeRatio.maxRatio", { min: 0 });
  ordered([f.volumeRatio.minRatio, f.volumeRatio.maxRatio], "factors.volumeRatio");

  f.rsi.period = num(f.rsi.period, "factors.rsi.period", { min: 2, max: 500, int: true });
  f.rsi.neutralBand = num(f.rsi.neutralBand, "factors.rsi.neutralBand", { min: 0, max: 50 });
  f.rsi.extremeBand = num(f.rsi.extremeBand, "factors.rsi.extremeBand", { min: 0, max: 50 });
  ordered([f.rsi.neutralBand, f.rsi.extremeBand], "factors.rsi");

  f.drawdown.lookback = num(f.drawdown.lookback, "factors.drawdown.lookback", { min: 2, max: 5000, int: true });
  f.drawdown.maxDrawdown = num(f.drawdown.maxDrawdown, "factors.drawdown.maxDrawdown", { min: 0.01, max: 1 });

  f.correlation.lookback = num(f.correlation.lookback, "factors.correlation.lookback", {
    min: 2,
    max: 5000,
    int: true,
  });
  if (f.correlation.method !== "pearson" && f.correlation.method !== "spearman") {
    throw new ScannerConfigError("factors.correlation.method: erwartet pearson|spearman");
  }

  for (const key of ["weightEvents24h", "weightEvents7d", "weightHighImpact", "weightScheduled", "weightStaleness", "neutralRisk"] as const) {
    f.news[key] = num(f.news[key], `factors.news.${key}`, { min: 0, max: 1 });
  }
  f.news.scheduledHorizonHours = num(f.news.scheduledHorizonHours, "factors.news.scheduledHorizonHours", { min: 0 });
  f.news.stalenessHours = num(f.news.stalenessHours, "factors.news.stalenessHours", { min: 0 });

  f.funding.defaultIntervalsPerYear = num(f.funding.defaultIntervalsPerYear, "factors.funding.defaultIntervalsPerYear", { min: 1 });
  f.funding.maxAnnualized = num(f.funding.maxAnnualized, "factors.funding.maxAnnualized", { min: 1e-6 });
  f.funding.spotValue = num(f.funding.spotValue, "factors.funding.spotValue", { min: 0, max: 1 });

  f.openInterest.minOpenInterest = num(f.openInterest.minOpenInterest, "factors.openInterest.minOpenInterest", { min: 1 });
  f.openInterest.maxOpenInterest = num(f.openInterest.maxOpenInterest, "factors.openInterest.maxOpenInterest", { min: 1 });
  ordered([f.openInterest.minOpenInterest, f.openInterest.maxOpenInterest], "factors.openInterest");
  f.openInterest.neutralValue = num(f.openInterest.neutralValue, "factors.openInterest.neutralValue", { min: 0, max: 1 });

  if (!["taker", "maker", "blend"].includes(f.execution.feeMode)) {
    throw new ScannerConfigError("factors.execution.feeMode: erwartet taker|maker|blend");
  }
  f.execution.includeSpread = Boolean(f.execution.includeSpread);
  f.execution.bestCost = num(f.execution.bestCost, "factors.execution.bestCost", { min: 0 });
  f.execution.worstCost = num(f.execution.worstCost, "factors.execution.worstCost", { min: 0 });
  ordered([f.execution.bestCost, f.execution.worstCost], "factors.execution");

  cfg.regime.low = num(cfg.regime.low, "regime.low", { min: 0 });
  cfg.regime.normal = num(cfg.regime.normal, "regime.normal", { min: 0 });
  cfg.regime.high = num(cfg.regime.high, "regime.high", { min: 0 });
  ordered([cfg.regime.low, cfg.regime.normal, cfg.regime.high], "regime");

  const fn = cfg.funnel;
  fn.eligibleMax = num(fn.eligibleMax, "funnel.eligibleMax", { min: 1, max: 1_000_000, int: true });
  fn.interestingMax = num(fn.interestingMax, "funnel.interestingMax", { min: 1, max: 1_000_000, int: true });
  fn.interestingMinScore = num(fn.interestingMinScore, "funnel.interestingMinScore", { min: 0, max: 100 });
  fn.dailyMax = num(fn.dailyMax, "funnel.dailyMax", { min: 1, max: 1_000_000, int: true });
  fn.deepMin = num(fn.deepMin, "funnel.deepMin", { min: 0, max: 1_000_000, int: true });
  fn.deepMax = num(fn.deepMax, "funnel.deepMax", { min: 1, max: 1_000_000, int: true });
  fn.maxPerAssetClass = num(fn.maxPerAssetClass, "funnel.maxPerAssetClass", { min: 1, max: 1_000_000, int: true });
  if (fn.deepMin > fn.deepMax) throw new ScannerConfigError("funnel: deepMin darf deepMax nicht überschreiten");
  if (!(fn.eligibleMax >= fn.interestingMax && fn.interestingMax >= fn.dailyMax && fn.dailyMax >= fn.deepMax)) {
    throw new ScannerConfigError("funnel: Ebenen müssen monoton kleiner werden (eligible ≥ interesting ≥ daily ≥ deep)");
  }

  const fl = cfg.filters;
  fl.requireStatusActive = Boolean(fl.requireStatusActive);
  fl.requirePaperAvailable = Boolean(fl.requirePaperAvailable);
  fl.excludeExtremeRegime = Boolean(fl.excludeExtremeRegime);
  fl.allowedMarketTypes = uniqueEnum(fl.allowedMarketTypes, MARKET_TYPES, "filters.allowedMarketTypes");
  fl.allowedAssetClasses = uniqueEnum(fl.allowedAssetClasses, ASSET_CLASSES, "filters.allowedAssetClasses");
  fl.minVolume24h = num(fl.minVolume24h, "filters.minVolume24h", { min: 0 });
  fl.maxSpread = num(fl.maxSpread, "filters.maxSpread", { min: 0, max: 1 });
  fl.minCandles = num(fl.minCandles, "filters.minCandles", { min: 0, max: 100_000, int: true });
  fl.maxDrawdown = num(fl.maxDrawdown, "filters.maxDrawdown", { min: 0, max: 1 });
  fl.maxExecutionCost = num(fl.maxExecutionCost, "filters.maxExecutionCost", { min: 0, max: 1 });

  const wk = cfg.weekly;
  wk.coreMinScore = num(wk.coreMinScore, "weekly.coreMinScore", { min: 0, max: 100 });
  wk.coreMinVolume24h = num(wk.coreMinVolume24h, "weekly.coreMinVolume24h", { min: 0 });
  wk.coreMinPersistence = num(wk.coreMinPersistence, "weekly.coreMinPersistence", { min: 0, max: 520, int: true });
  wk.rotationMinScore = num(wk.rotationMinScore, "weekly.rotationMinScore", { min: 0, max: 100 });
  wk.discoveryMinScore = num(wk.discoveryMinScore, "weekly.discoveryMinScore", { min: 0, max: 100 });
  if (!(wk.coreMinScore >= wk.rotationMinScore && wk.rotationMinScore >= wk.discoveryMinScore)) {
    throw new ScannerConfigError("weekly: coreMinScore ≥ rotationMinScore ≥ discoveryMinScore erforderlich");
  }
  wk.liquidityDropPct = num(wk.liquidityDropPct, "weekly.liquidityDropPct", { min: 0, max: 1 });
  wk.feeIncreasePct = num(wk.feeIncreasePct, "weekly.feeIncreasePct", { min: 0 });
  wk.clusterCorrelation = num(wk.clusterCorrelation, "weekly.clusterCorrelation", { min: 0, max: 1 });

  return cfg;
}

function uniqueEnum<T extends string>(raw: unknown, allowed: readonly T[], path: string): T[] {
  if (!Array.isArray(raw) || !raw.length) throw new ScannerConfigError(`${path}: erwartet nicht-leere Liste`);
  const out: T[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      throw new ScannerConfigError(`${path}: "${String(v).slice(0, 20)}" ist keiner von ${allowed.join(" | ")}`);
    }
    if (!out.includes(v as T)) out.push(v as T);
  }
  return out;
}

/**
 * Baut eine Konfiguration aus den Defaults plus optionalen Overrides.
 * Praktisch für Tests („was passiert, wenn `dailyMax` 10 ist?“) und für
 * Aufrufer, die nur eine Schwelle verschieben wollen.
 */
export function resolveScannerConfig(overrides?: DeepPartial<ScannerConfig>): ScannerConfig {
  if (!overrides) return structuredClone(DEFAULT_SCANNER_CONFIG);
  return validateScannerConfig(overrides);
}

/**
 * Lädt die Konfiguration: Datei aus `SCANNER_CONFIG_FILE`, sonst die
 * eingebauten Defaults. Eine unlesbare Datei ist ein harter Fehler.
 */
export function loadScannerConfig(file = process.env.SCANNER_CONFIG_FILE): ScannerConfig {
  if (!file) return structuredClone(DEFAULT_SCANNER_CONFIG);
  return validateScannerConfig(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Claude Trading Indicator (CTI) — Parameter, Grenzen und Aufwärmphase.
 *
 * Diese Datei ist die **einzige Wahrheit** über die Einstellungen des
 * Indikators. Sie bildet die Pine-Inputs 1:1 ab und trennt dabei exakt so,
 * wie es das Original tut:
 *
 *   - **Einstellbar** (Pine `input.*`): die vier Dimensions-Schalter, die
 *     Stop-Loss-Parameter (`atrLength`, `atrMultiplier`) und die
 *     Signalfilter (`persistBars`, `minBarsBetween`).
 *   - **Fest verdrahtet** (Pine: „Internal defaults … not exposed in the
 *     inputs menu"): die Perioden der einzelnen Komponenten-Indikatoren
 *     ({@link CTI_COMPONENTS}).
 *
 * Die reinen Darstellungs-Inputs des Skripts (`showDashboard`,
 * `showBackground`) haben keinen Einfluss auf Signale und existieren hier
 * deshalb nicht — der Dashboard-Text wird aus dem Bar-Zustand gerendert
 * (`src/signals/cti/dashboard.ts`), nicht aus einem Schalter.
 *
 * ── Klemmen statt raten ────────────────────────────────────────────────────
 * Pine erzwingt seine `minval`-Grenzen in der UI. Hier übernimmt das
 * {@link resolveCtiParams}: jeder Wert wird auf {@link CTI_PARAM_BOUNDS}
 * geklemmt und JEDE Korrektur wird in `clamped` gemeldet — dieselbe
 * „sichtbar statt still"-Konvention wie `sanitizeRuleSpec()` in
 * `src/lib/ruleEngine.ts`. Ein ungültiger Typ (String, NaN, Infinity) ist
 * kein Grund für einen stillen Default: er wird als Korrektur protokolliert.
 */

/**
 * Die fest verdrahteten Komponenten-Perioden des Original-Skripts.
 *
 * Wer hier etwas ändert, verlässt die 1:1-Treue zum Chart — deshalb sind die
 * Werte eingefroren und nicht Teil von {@link CtiParams}. Sie stehen hier
 * als benannte Konstanten (statt als Zahlen im Rechenpfad), damit Tests und
 * Doku gegen dieselbe Quelle prüfen können.
 */
export const CTI_COMPONENTS = Object.freeze({
  /** Trend: `ta.ema(close, 200)`. */
  emaLength: 200,
  /** Trend: `ta.supertrend(3.0, 10)` — ATR-Periode. */
  supertrendAtrPeriod: 10,
  /** Trend: `ta.supertrend(3.0, 10)` — Faktor. */
  supertrendFactor: 3.0,
  /** Trend: Bollinger-Basis `ta.sma(close, 20)`. */
  bollingerLength: 20,
  /** Trend: Bollinger-Abstand `2 · ta.stdev(close, 20)`. */
  bollingerMult: 2.0,
  /** Momentum: `ta.macd(close, 12, 26, 9)`. */
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  /** Momentum: `ta.rsi(close, 14)` gegen 50. */
  rsiLength: 14,
  /** Momentum: `ta.stoch(close, high, low, 14)`. */
  stochLength: 14,
  /** Momentum: `%D = ta.sma(%K, 3)`. */
  stochD: 3,
  /** Momentum: `%K = ta.sma(raw, 3)`. */
  stochSmooth: 3,
  /** Volatilität: `ta.dmi(14, 14)`. */
  adxLength: 14,
  adxSmoothing: 14,
  /** Volatilität: ADX-Mindeststärke, darunter ist die Dimension neutral. */
  adxMinStrength: 20.0,
  /** Volumen: `ta.sma(ta.obv, 10)`. */
  volumeSmoothLength: 10,
} as const);

/** Die vier Marktdimensionen des CTI (Reihenfolge wie im Dashboard). */
export const CTI_DIMENSIONS = ["trend", "momentum", "volatility", "volume"] as const;

export type CtiDimension = (typeof CTI_DIMENSIONS)[number];

/** Die einstellbaren Parameter — 1:1 die `input.*`-Zeilen des Skripts. */
export interface CtiParams {
  /** Dimension „Trend" (EMA 200 + Supertrend + Bollinger-Basis) einbeziehen. */
  useTrend: boolean;
  /** Dimension „Momentum" (MACD + RSI + Stochastik) einbeziehen. */
  useMomentum: boolean;
  /** Dimension „Volatilität" (DMI/ADX) einbeziehen. */
  useVolatility: boolean;
  /** Dimension „Volumen" (OBV gegen seinen Schnitt) einbeziehen. */
  useVolume: boolean;
  /** `ATR Length (Stop Loss)` — Periode des Stop-ATR (Pine: `minval = 1`). */
  atrLength: number;
  /** `ATR Multiplier (Stop Loss)` — Vielfaches des ATR (Pine: `minval = 0.1`). */
  atrMultiplier: number;
  /** `Require Verdict For (bars)` — Bars, die das Verdikt halten muss. */
  persistBars: number;
  /** `Minimum Bars Between Signals` — Sperrfrist nach einem Signal. */
  minBarsBetween: number;
}

/** Grenzen der numerischen Parameter (`min` aus Pine, `max` als Schutzdeckel). */
export const CTI_PARAM_BOUNDS = Object.freeze({
  atrLength: Object.freeze({ min: 1, max: 1_000, integer: true }),
  atrMultiplier: Object.freeze({ min: 0.1, max: 100, integer: false }),
  persistBars: Object.freeze({ min: 1, max: 1_000, integer: true }),
  minBarsBetween: Object.freeze({ min: 0, max: 10_000, integer: true }),
} as const);

/** Default-Parameter — exakt die Vorgaben des Pine-Skripts. */
export const DEFAULT_CTI_PARAMS: Readonly<CtiParams> = Object.freeze({
  useTrend: true,
  useMomentum: true,
  useVolatility: true,
  useVolume: true,
  atrLength: 14,
  atrMultiplier: 3.0,
  persistBars: 2,
  minBarsBetween: 10,
});

/** Ergebnis von {@link resolveCtiParams}: normalisierte Parameter + Belege. */
export interface ResolvedCtiParams {
  params: CtiParams;
  /**
   * Namen aller Felder, die geklemmt oder ersetzt wurden — leer, wenn die
   * Eingabe unverändert übernommen wurde. Aufrufer protokollieren das
   * (CLI, Backtest-Report), statt es zu verschlucken.
   */
  clamped: string[];
}

type NumericParamKey = keyof typeof CTI_PARAM_BOUNDS;

function resolveBoolean(
  value: unknown,
  fallback: boolean,
  key: string,
  clamped: string[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  clamped.push(key);
  return fallback;
}

function resolveNumber(
  value: unknown,
  fallback: number,
  key: NumericParamKey,
  clamped: string[],
): number {
  const bounds = CTI_PARAM_BOUNDS[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    clamped.push(key);
    return fallback;
  }
  let next = value;
  if (bounds.integer) next = Math.trunc(next);
  if (next < bounds.min) next = bounds.min;
  if (next > bounds.max) next = bounds.max;
  if (next !== value) clamped.push(key);
  return next;
}

/**
 * Baut gültige CTI-Parameter aus einer Teilmenge — fail-closed, mit Belegen.
 *
 * Reine Funktion: gleiche Eingabe ⇒ identisches Ergebnis. Unbekannte Keys
 * werden ignoriert (sie können den Indikator nicht beeinflussen), ungültige
 * Werte fallen auf den Default zurück UND erscheinen in `clamped`.
 */
export function resolveCtiParams(input?: Partial<CtiParams> | null): ResolvedCtiParams {
  const source = (input ?? {}) as Partial<Record<keyof CtiParams, unknown>>;
  const clamped: string[] = [];
  const params: CtiParams = {
    useTrend: resolveBoolean(source.useTrend, DEFAULT_CTI_PARAMS.useTrend, "useTrend", clamped),
    useMomentum: resolveBoolean(source.useMomentum, DEFAULT_CTI_PARAMS.useMomentum, "useMomentum", clamped),
    useVolatility: resolveBoolean(source.useVolatility, DEFAULT_CTI_PARAMS.useVolatility, "useVolatility", clamped),
    useVolume: resolveBoolean(source.useVolume, DEFAULT_CTI_PARAMS.useVolume, "useVolume", clamped),
    atrLength: resolveNumber(source.atrLength, DEFAULT_CTI_PARAMS.atrLength, "atrLength", clamped),
    atrMultiplier: resolveNumber(source.atrMultiplier, DEFAULT_CTI_PARAMS.atrMultiplier, "atrMultiplier", clamped),
    persistBars: resolveNumber(source.persistBars, DEFAULT_CTI_PARAMS.persistBars, "persistBars", clamped),
    minBarsBetween: resolveNumber(source.minBarsBetween, DEFAULT_CTI_PARAMS.minBarsBetween, "minBarsBetween", clamped),
  };
  return { params, clamped };
}

/**
 * Bars, die eine Dimension braucht, bevor sie überhaupt ein Votum ≠ neutral
 * liefern KANN (1-basiert, also „ab dem wievielten Bar").
 *
 * Herleitung je Komponente (0-basierter Index des ersten Nicht-`na`-Werts):
 *   - `ta.ema(close, n)`            ⇒ n − 1
 *   - `ta.sma(close, n)`            ⇒ n − 1
 *   - `ta.macd(12, 26, 9)`          ⇒ (26 − 1) + (9 − 1) = 33
 *   - `ta.rsi(close, 14)`           ⇒ 14 (Change beginnt erst auf Bar 1)
 *   - Stochastik 14/3/3             ⇒ (14 − 1) + (3 − 1) + (3 − 1) = 17
 *   - `ta.dmi(14, 14)`              ⇒ 14 + (14 − 1) = 27
 *   - `ta.sma(ta.obv, 10)`          ⇒ 10 (OBV beginnt erst auf Bar 1)
 *   - Supertrend liefert ab Bar 0 eine Richtung (bärisch in der Aufwärmphase)
 *
 * Eine Dimension ist einstimmig — sie braucht also ihre LANGSAMSTE Komponente.
 */
export const CTI_DIMENSION_WARMUP: Readonly<Record<CtiDimension, number>> = Object.freeze({
  // Bollinger (20) und Supertrend (10) sind schneller als die EMA 200.
  trend: CTI_COMPONENTS.emaLength,
  // MACD (34) ist langsamer als RSI (15) und Stochastik (18).
  momentum: CTI_COMPONENTS.macdSlow + CTI_COMPONENTS.macdSignal - 1,
  volatility: CTI_COMPONENTS.adxLength + CTI_COMPONENTS.adxSmoothing,
  volume: CTI_COMPONENTS.volumeSmoothLength + 1,
});

/**
 * Anzahl Kerzen bis zum FRÜHESTMÖGLICHEN Signal — als Bar-Zählung (1-basiert),
 * passend zu `BacktestEngineConfig.warmupBars` (die Engine zählt den ersten
 * Bar als Schritt 1).
 *
 * Rechnung: Die langsamste aktive Dimension liefert ihr erstes Votum auf Bar
 * `slowest`. Das Verdikt muss `persistBars` Bars in Folge halten, der erste
 * davon ist ebendieser Bar — deshalb `slowest + persistBars − 1` und nicht
 * `+ persistBars`. Mit den Defaults: 200 (EMA) + 2 − 1 = **201**.
 *
 * Nützlich für `BacktestEngineConfig.warmupBars` und als Mindestlänge beim
 * Seeden der Live-Engine. Sind alle Dimensionen abgeschaltet, feuert der
 * Indikator nie (`enabledCount == 0`) — der Wert ist dann nur noch der
 * Persistenzbedarf.
 */
export function ctiWarmupBars(params: Readonly<CtiParams> = DEFAULT_CTI_PARAMS): number {
  const active: number[] = [];
  if (params.useTrend) active.push(CTI_DIMENSION_WARMUP.trend);
  if (params.useMomentum) active.push(CTI_DIMENSION_WARMUP.momentum);
  if (params.useVolatility) active.push(CTI_DIMENSION_WARMUP.volatility);
  if (params.useVolume) active.push(CTI_DIMENSION_WARMUP.volume);
  const slowest = active.length > 0 ? Math.max(...active) : 0;
  const persist = Math.max(1, params.persistBars);
  return Math.max(1, slowest + persist - 1);
}

/** Aufwärmbedarf mit den Default-Parametern (alle vier Dimensionen aktiv). */
export const CTI_DEFAULT_WARMUP_BARS = ctiWarmupBars(DEFAULT_CTI_PARAMS);

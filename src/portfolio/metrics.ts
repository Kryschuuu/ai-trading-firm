/**
 * Kennzahl-Bibliothek des Portfolio-Moduls (Task 05).
 *
 * **Jede Funktion dokumentiert ihre Formel, ihre Annahmen und ihre Grenzen.**
 * Alle Funktionen sind rein: keine Uhr, kein Zufall, kein I/O, keine
 * Seiteneffekte. Unbrauchbare Eingaben (NaN, ±∞, Preise ≤ 0, zu kurze Serien)
 * werfen einen {@link PortfolioError} — es wird nie interpoliert oder geraten.
 *
 * Konventionen:
 *   - Gerechnet wird mit **logarithmischen Renditen** `r_t = ln(p_t / p_{t-1})`
 *     (zeitadditiv, symmetrisch, für kleine Werte ≈ einfache Rendite).
 *   - `A` = Annualisierungsfaktor (Perioden pro Jahr, je Asset-Klasse).
 *   - Standardabweichungen verwenden `ddof = 1` (erwartungstreue
 *     Stichprobenvarianz), sofern nicht anders angegeben.
 *   - Zinssätze (`riskFreeRate`) werden **annualisiert** übergeben und intern
 *     arithmetisch auf die Periode umgerechnet: `rf_p = rf / A`.
 */

import {
  DEFAULT_ANNUALIZATION_FALLBACK,
  DEFAULT_ATR_PERIOD,
  DEFAULT_DDOF,
  DEFAULT_REGIME_THRESHOLDS,
  DEFAULT_RISK_FREE_RATE,
  OUTPUT_DECIMALS,
  annualizationFor,
  roundTo,
  validateAnnualization,
  validateRegimeThresholds,
  type RegimeThresholds,
} from "./config";
import { PortfolioError, requireFinite, requireFiniteAtLeast, requirePositive } from "./errors";
import { mean, stdDev } from "./numeric";
import type { CandleLike, MaxDrawdownResult, MetricSet, SeriesInput, VolatilityRegime } from "./types";

/** Optionen der Kennzahlberechnung. */
export interface MetricsOptions {
  /** Annualisierungsfaktor; überschreibt den Wert aus der Asset-Klasse. */
  annualization?: number;
  /** Annualisierter risikofreier Zins (Default 0). */
  riskFreeRate?: number;
  /** Freiheitsgrade der Standardabweichung (Default 1). */
  ddof?: number;
  /** ATR-Periode (Default 14). */
  atrPeriod?: number;
  /** Zielrendite (MAR) der Sortino Ratio, pro Periode; Default `rf_p`. */
  downsideTarget?: number;
  /** Regime-Schwellen (Default {@link DEFAULT_REGIME_THRESHOLDS}). */
  regime?: RegimeThresholds;
}

/**
 * Logarithmische Renditen aus Schlusskursen.
 *
 * Formel: `r_t = ln(p_t / p_{t-1})` für `t = 1 … n−1`.
 *
 * Annahmen: Kurse strikt positiv und endlich. Grenzen: liefert `n − 1` Werte;
 * bei weniger als zwei Kursen ist keine Rendite berechenbar.
 *
 * @throws PortfolioError `INSUFFICIENT_DATA` (< 2 Kurse), `NON_POSITIVE_PRICE`,
 *         `INVALID_INPUT` (NaN/±∞).
 */
export function logReturnsFromPrices(prices: readonly number[], field = "prices"): number[] {
  if (prices.length < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `mindestens 2 Kurse nötig, gefunden ${prices.length}`, { field });
  }
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    for (const [v, idx] of [
      [prev, i - 1],
      [cur, i],
    ] as const) {
      if (!Number.isFinite(v)) {
        throw new PortfolioError("INVALID_INPUT", `Kurs ${idx} ist keine endliche Zahl`, {
          field,
          details: { index: idx },
        });
      }
      if (v <= 0) {
        throw new PortfolioError("NON_POSITIVE_PRICE", `Kurs ${idx} ist ${v} (Logarithmus undefiniert)`, {
          field,
          details: { index: idx },
        });
      }
    }
    out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Logarithmische Renditen aus einfachen Renditen.
 *
 * Formel: `r_t = ln(1 + R_t)`; umgekehrt `R_t = e^{r_t} − 1`.
 *
 * Annahmen: `R_t > −1` (Totalverlust `−1` ist der Pol des Logarithmus).
 *
 * @throws PortfolioError `INVALID_INPUT` bei `R_t ≤ −1` oder NaN/±∞.
 */
export function logReturnsFromSimpleReturns(returns: readonly number[], field = "returns"): number[] {
  if (returns.length === 0) {
    throw new PortfolioError("INSUFFICIENT_DATA", "leere Renditereihe", { field });
  }
  const out: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!Number.isFinite(r)) {
      throw new PortfolioError("INVALID_INPUT", `Rendite ${i} ist keine endliche Zahl`, {
        field,
        details: { index: i },
      });
    }
    if (r <= -1) {
      throw new PortfolioError("INVALID_INPUT", `Rendite ${i} ist ${r} (≤ −100 %, Logarithmus undefiniert)`, {
        field,
        details: { index: i },
      });
    }
    out.push(Math.log1p(r));
  }
  return out;
}

/**
 * Prüft eine bereits logarithmische Renditereihe auf Endlichkeit (nur Prüfung,
 * keine Änderung der Werte).
 *
 * @throws PortfolioError `INVALID_INPUT` bei NaN/±∞, `INSUFFICIENT_DATA` bei leerer Reihe.
 */
export function validateLogReturns(logReturns: readonly number[], field = "logReturns"): number[] {
  if (logReturns.length === 0) {
    throw new PortfolioError("INSUFFICIENT_DATA", "leere Log-Renditereihe", { field });
  }
  for (let i = 0; i < logReturns.length; i++) {
    const r = logReturns[i];
    if (!Number.isFinite(r)) {
      throw new PortfolioError("INVALID_INPUT", `Log-Rendite ${i} ist keine endliche Zahl`, {
        field,
        details: { index: i },
      });
    }
  }
  return logReturns.slice();
}

/**
 * Realisierte Volatilität (annualisiert).
 *
 * Formel:
 * `σ_p = √( Σ_t (r_t − r̄)² / (n − ddof) )`,  `σ_a = σ_p · √A`
 *
 * Annahmen: Renditen sind unabhängig und identisch verteilt (i. i. d.),
 * Volatilität ist über das Jahr konstant. Grenzen: misst nur **vergangene**
 * Schwankung und skaliert mit `√A` — bei Volatility-Clustering (GARCH-Effekt)
 * oder Sprüngen unterschätzt sie das tatsächliche Risiko.
 */
export function realizedVolatility(
  logReturns: readonly number[],
  annualization = DEFAULT_ANNUALIZATION_FALLBACK,
  ddof = DEFAULT_DDOF
): number {
  const A = validateAnnualization(annualization);
  const sigma = stdDev(logReturns, ddof);
  const annualized = sigma * Math.sqrt(A);
  if (!Number.isFinite(annualized)) {
    throw new PortfolioError("NUMERIC_FAILURE", "annualisierte Volatilität ist nicht endlich", {
      field: "logReturns",
    });
  }
  return annualized;
}

/**
 * Geometrisch annualisierte Rendite aus der mittleren Log-Rendite.
 *
 * Formel: `R_a = exp(r̄ · A) − 1`.
 *
 * Annahmen: konstante Renditeverteilung. Grenzen: extrapoliert die
 * Vergangenheit und ignoriert Reihenfolgerisiko.
 */
export function annualizedReturn(meanLogReturnPerPeriod: number, annualization = DEFAULT_ANNUALIZATION_FALLBACK): number {
  const A = validateAnnualization(annualization);
  const r = requireFinite(meanLogReturnPerPeriod, "meanLogReturn");
  return Math.expm1(r * A);
}

/**
 * True Range einer Kerzenserie.
 *
 * Formel: `TR_t = max(high_t − low_t, |high_t − close_{t−1}|, |low_t − close_{t−1}|)`.
 *
 * Annahmen: `high ≥ low > 0`, `close > 0`. Grenzen: die erste Kerze hat keine
 * True Range (kein Vortag) und wird übersprungen.
 */
export function trueRangeSeries(candles: readonly CandleLike[], field = "candles"): number[] {
  if (candles.length < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `True Range benötigt ≥ 2 Kerzen, gefunden ${candles.length}`, {
      field,
    });
  }
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    for (const [name, v] of [
      ["high", c.high],
      ["low", c.low],
      ["close", c.close],
      ["prevClose", prevClose],
    ] as const) {
      if (!Number.isFinite(v) || v <= 0) {
        throw new PortfolioError("INVALID_INPUT", `${name} von Kerze ${i} ist ${v}`, {
          field,
          details: { index: i },
        });
      }
    }
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return out;
}

/**
 * Average True Range (Wilder, Default-Periode 14).
 *
 * Formel: Seed `ATR_p = (1/p) · Σ_{t=1..p} TR_t`, danach
 * `ATR_t = (ATR_{t−1} · (p − 1) + TR_t) / p`.
 *
 * Annahmen: Wilder-Glättung gewichtet die letzten `p` Perioden exponentiell.
 * Grenzen: ATR ist ein **absolutes** Kursmaß (keine Prozentangabe) und reagiert
 * träge auf plötzliche Regimewechsel.
 *
 * @throws PortfolioError `INSUFFICIENT_DATA` wenn weniger als `period + 1` Kerzen.
 */
export function averageTrueRange(candles: readonly CandleLike[], period = DEFAULT_ATR_PERIOD): number {
  const p = Math.floor(requireFiniteAtLeast(period, 1, "atrPeriod"));
  const trs = trueRangeSeries(candles);
  if (trs.length < p) {
    throw new PortfolioError("INSUFFICIENT_DATA", `ATR(${p}) benötigt ${p} True Ranges, gefunden ${trs.length}`, {
      field: "candles",
      details: { period: p, available: trs.length },
    });
  }
  let acc = 0;
  for (let i = 0; i < p; i++) acc += trs[i];
  let atr = acc / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  return atr;
}

/**
 * Sharpe Ratio.
 *
 * Formel:
 * `SR_p = (r̄ − rf_p) / σ_p` mit `rf_p = rf / A`,  `SR_a = SR_p · √A`.
 *
 * Annahmen: symmetrische, annähernd normalverteilte Renditen; `σ_p` ist die
 * Standardabweichung der Log-Renditen (`ddof = 1`). Grenzen: bestraft
 * Aufwärtsvolatilität genauso wie Verluste und ist bei fat tails zu optimistisch
 * — dafür gibt es {@link sortinoRatio}.
 */
export function sharpeRatio(
  logReturns: readonly number[],
  options?: { riskFreeRate?: number; annualization?: number; ddof?: number }
): { perPeriod: number; annualized: number } {
  const A = validateAnnualization(options?.annualization ?? DEFAULT_ANNUALIZATION_FALLBACK);
  const rf = options?.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const rfPerPeriod = requireFinite(rf, "riskFreeRate") / A;
  const sigma = stdDev(logReturns, options?.ddof ?? DEFAULT_DDOF);
  const perPeriod = sigma === 0 ? 0 : (mean(logReturns) - rfPerPeriod) / sigma;
  return { perPeriod, annualized: perPeriod * Math.sqrt(A) };
}

/**
 * Sortino Ratio (Downside-Deviation statt Gesamtvolatilität).
 *
 * Formel:
 * `DD = √( (1/n) · Σ_t min(r_t − τ, 0)² )`,  `So_p = (r̄ − rf_p) / DD`,
 * `So_a = So_p · √A`. `τ` = Zielrendite (MAR), Default `rf_p`.
 *
 * Annahmen: nur Unterschreitungen des Ziels zählen als Risiko; der Nenner nutzt
 * alle `n` Beobachtungen (Standard-Konvention, `ddof = 0`).
 * Grenzen: ohne einzige Zielunterschreitung ist die Ratio nicht definiert —
 * es wird `0` geliefert, wenn auch keine Überschussrendite vorliegt, sonst
 * `Infinity` (mathematisch korrekt, in JSON als `null` serialisiert).
 */
export function sortinoRatio(
  logReturns: readonly number[],
  options?: { riskFreeRate?: number; annualization?: number; downsideTarget?: number }
): { perPeriod: number; annualized: number; downsideDeviation: number } {
  const A = validateAnnualization(options?.annualization ?? DEFAULT_ANNUALIZATION_FALLBACK);
  const rf = options?.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const rfPerPeriod = requireFinite(rf, "riskFreeRate") / A;
  const target = options?.downsideTarget ?? rfPerPeriod;
  const n = logReturns.length;
  if (n === 0) throw new PortfolioError("INSUFFICIENT_DATA", "Sortino benötigt mindestens eine Rendite");
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const r = logReturns[i];
    if (!Number.isFinite(r)) {
      throw new PortfolioError("INVALID_INPUT", `Rendite ${i} ist keine endliche Zahl`, {
        field: "logReturns",
        details: { index: i },
      });
    }
    const d = Math.min(r - target, 0);
    acc += d * d;
  }
  const dd = Math.sqrt(acc / n);
  const excess = mean(logReturns) - rfPerPeriod;
  const perPeriod = dd === 0 ? (excess > 0 ? Infinity : 0) : excess / dd;
  return { perPeriod, annualized: perPeriod * Math.sqrt(A), downsideDeviation: dd };
}

/**
 * Equity-Kurve aus logarithmischen Renditen.
 *
 * Formel: `E_0 = start`, `E_t = E_{t−1} · e^{r_t}`.
 */
export function equityCurveFromLogReturns(logReturns: readonly number[], start = 1): number[] {
  const s = requirePositive(start, "start");
  const curve = [s];
  let level = s;
  for (let i = 0; i < logReturns.length; i++) {
    const r = logReturns[i];
    if (!Number.isFinite(r)) {
      throw new PortfolioError("INVALID_INPUT", `Rendite ${i} ist keine endliche Zahl`, {
        field: "logReturns",
        details: { index: i },
      });
    }
    level *= Math.exp(r);
    curve.push(level);
  }
  return curve;
}

/**
 * Maximaler Drawdown inklusive Tiefpunkt und Dauer.
 *
 * Formel:
 * `peak_t = max_{s≤t} E_s`,  `dd_t = (peak_t − E_t) / peak_t`,
 * `MDD = max_t dd_t`.
 * `troughIndex` = Index des Minimums im größten Rückgang,
 * `recoveryIndex` = erster Index nach dem Tief mit `E_t ≥ peak`.
 * Dauer `durationPeriods = (recoveryIndex ?? letzter Index) − peakIndex`.
 *
 * Annahmen: positive Kurswerte. Grenzen: MDD ist pfadabhängig und rein
 * historisch — er sagt nichts über den nächsten, möglicherweise tieferen
 * Rückgang aus.
 *
 * @throws PortfolioError `INSUFFICIENT_DATA` (< 2 Punkte), `NON_POSITIVE_PRICE`.
 */
export function maxDrawdown(equity: readonly number[], field = "equity"): MaxDrawdownResult {
  if (equity.length < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Drawdown benötigt ≥ 2 Punkte, gefunden ${equity.length}`, {
      field,
    });
  }
  let peak = equity[0];
  let peakIndex = 0;
  if (!Number.isFinite(peak) || peak <= 0) {
    throw new PortfolioError("NON_POSITIVE_PRICE", `Startwert ist ${peak}`, { field, details: { index: 0 } });
  }
  let best = 0;
  let bestPeakIndex = 0;
  let bestTroughIndex = 0;
  for (let i = 1; i < equity.length; i++) {
    const v = equity[i];
    if (!Number.isFinite(v) || v <= 0) {
      throw new PortfolioError("NON_POSITIVE_PRICE", `Wert ${i} ist ${v}`, { field, details: { index: i } });
    }
    if (v > peak) {
      peak = v;
      peakIndex = i;
    }
    const dd = (peak - v) / peak;
    if (dd > best) {
      best = dd;
      bestPeakIndex = peakIndex;
      bestTroughIndex = i;
    }
  }
  if (best === 0) {
    return {
      value: 0,
      peakIndex: 0,
      troughIndex: 0,
      recoveryIndex: 0,
      peakToTroughPeriods: 0,
      durationPeriods: 0,
      recovered: true,
    };
  }
  const peakValue = equity[bestPeakIndex];
  let recoveryIndex: number | null = null;
  for (let i = bestTroughIndex + 1; i < equity.length; i++) {
    if (equity[i] >= peakValue) {
      recoveryIndex = i;
      break;
    }
  }
  const end = recoveryIndex ?? equity.length - 1;
  return {
    value: best,
    peakIndex: bestPeakIndex,
    troughIndex: bestTroughIndex,
    recoveryIndex,
    peakToTroughPeriods: bestTroughIndex - bestPeakIndex,
    durationPeriods: end - bestPeakIndex,
    recovered: recoveryIndex !== null,
  };
}

/**
 * Profit Factor.
 *
 * Formel: `PF = Σ_t max(r_t, 0) / |Σ_t min(r_t, 0)|`
 * (Bruttogewinn / Bruttoverlust).
 *
 * Annahmen: jede Beobachtung zählt als „Trade" (bei Periodenrenditen ist der
 * Wert deshalb ein Perioden-Profit-Factor, kein Trade-Statistik-Ersatz).
 * Grenzen: ohne Verluste ist `PF = ∞` (`Infinity`, in JSON `null`); ohne
 * Bewegung (`Bruttogewinn = Bruttoverlust = 0`) ist er undefiniert (`null`).
 * `grossProfit`/`grossLoss` werden mitgeliefert, damit der Fall eindeutig bleibt.
 */
export function profitFactor(returns: readonly number[]): { value: number | null; grossProfit: number; grossLoss: number } {
  if (returns.length === 0) {
    throw new PortfolioError("INSUFFICIENT_DATA", "Profit Factor benötigt mindestens eine Rendite");
  }
  let grossProfit = 0;
  let grossLoss = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (!Number.isFinite(r)) {
      throw new PortfolioError("INVALID_INPUT", `Rendite ${i} ist keine endliche Zahl`, {
        field: "returns",
        details: { index: i },
      });
    }
    if (r > 0) grossProfit += r;
    else grossLoss += -r;
  }
  if (grossLoss === 0) return { value: grossProfit > 0 ? Infinity : null, grossProfit, grossLoss };
  return { value: grossProfit / grossLoss, grossProfit, grossLoss };
}

/**
 * Volatilitäts-Regime.
 *
 * Regel: `σ_a < low ⇒ LOW`, `σ_a < normal ⇒ NORMAL`, `σ_a < high ⇒ HIGH`,
 * sonst `EXTREME`. Die Grenze gehört zur oberen Klasse.
 *
 * Annahmen: `σ_a` ist annualisiert. Grenzen: Schwellen sind Konvention, keine
 * Naturkonstante — sie müssen zur Asset-Klasse passen (Krypto ≠ Anleihe).
 */
export function classifyVolatilityRegime(
  annualizedVolatility: number,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS
): VolatilityRegime {
  const t = validateRegimeThresholds(thresholds);
  const sigma = requireFiniteAtLeast(annualizedVolatility, 0, "annualizedVolatility");
  if (sigma < t.low) return "LOW";
  if (sigma < t.normal) return "NORMAL";
  if (sigma < t.high) return "HIGH";
  return "EXTREME";
}

/**
 * Löst die logarithmischen Renditen einer {@link SeriesInput} auf.
 *
 * Genau eine Quelle (`logReturns` > `returns` > `prices`) wird verwendet;
 * mehrere Quellen gleichzeitig sind ein Konfigurationsfehler, weil sonst
 * unklar wäre, welche Reihe gemeint ist.
 */
export function resolveLogReturns(series: SeriesInput): number[] {
  const sources = [series.logReturns, series.returns, series.prices].filter((v) => v !== undefined).length;
  if (sources === 0) {
    throw new PortfolioError("INVALID_INPUT", "eine der Quellen prices/returns/logReturns ist Pflicht", {
      field: series.symbol || "series",
    });
  }
  if (sources > 1) {
    throw new PortfolioError("INVALID_INPUT", "nur eine Quelle (prices | returns | logReturns) erlaubt", {
      field: series.symbol || "series",
    });
  }
  const label = series.symbol || "series";
  if (series.logReturns) return validateLogReturns(series.logReturns, `${label}.logReturns`);
  if (series.returns) return logReturnsFromSimpleReturns(series.returns, `${label}.returns`);
  return logReturnsFromPrices(series.prices as readonly number[], `${label}.prices`);
}

/**
 * Vollständiger Kennzahlensatz einer Serie.
 *
 * Kombiniert {@link realizedVolatility}, {@link sharpeRatio},
 * {@link sortinoRatio}, {@link maxDrawdown}, {@link profitFactor},
 * {@link averageTrueRange} (falls Kerzen vorhanden) und
 * {@link classifyVolatilityRegime}.
 *
 * Verfahren: jede Kennzahl wird aus derselben validierten Renditereihe einzeln
 * berechnet, danach werden alle Ausgaben auf
 * {@link OUTPUT_DECIMALS} Dezimalen gerundet ⇒ byte-identische JSON-Antworten.
 */
export function computeMetrics(series: SeriesInput, options: MetricsOptions = {}): MetricSet {
  const symbol = typeof series.symbol === "string" ? series.symbol : "";
  if (!symbol) throw new PortfolioError("INVALID_SYMBOL", "symbol fehlt", { field: "symbol" });
  const annualization = validateAnnualization(
    options.annualization ?? annualizationFor(series.assetClass ?? null)
  );
  const riskFreeRate = requireFinite(series.riskFreeRate ?? options.riskFreeRate ?? DEFAULT_RISK_FREE_RATE, "riskFreeRate");
  const ddof = options.ddof ?? DEFAULT_DDOF;
  const logReturns = resolveLogReturns(series);

  const volatilityPerPeriod = stdDev(logReturns, ddof);
  const volatility = realizedVolatility(logReturns, annualization, ddof);
  const meanLog = mean(logReturns);
  const sharpe = sharpeRatio(logReturns, { riskFreeRate, annualization, ddof });
  const sortino = sortinoRatio(logReturns, {
    riskFreeRate,
    annualization,
    downsideTarget: options.downsideTarget,
  });
  const mdd = maxDrawdown(equityCurveFromLogReturns(logReturns), `${symbol}.equity`);
  const pf = profitFactor(logReturns);

  let atr: number | null = null;
  let atrPct: number | null = null;
  let atrPeriod: number | null = null;
  if (series.candles && series.candles.length > 0) {
    const period = Math.floor(options.atrPeriod ?? DEFAULT_ATR_PERIOD);
    atr = averageTrueRange(series.candles, period);
    const lastClose = series.candles[series.candles.length - 1].close;
    atrPct = lastClose > 0 && Number.isFinite(lastClose) ? atr / lastClose : null;
    atrPeriod = period;
  }

  const r = (v: number | null) => (v === null || !Number.isFinite(v) ? v : roundTo(v, OUTPUT_DECIMALS));
  return {
    symbol,
    observations: logReturns.length,
    annualization,
    meanLogReturn: r(meanLog) as number,
    annualizedReturn: r(annualizedReturn(meanLog, annualization)) as number,
    volatilityPerPeriod: r(volatilityPerPeriod) as number,
    volatility: r(volatility) as number,
    sharpe: r(sharpe.annualized) as number,
    sharpePerPeriod: r(sharpe.perPeriod) as number,
    sortino: r(sortino.annualized) as number,
    sortinoPerPeriod: r(sortino.perPeriod) as number,
    downsideDeviation: r(sortino.downsideDeviation) as number,
    maxDrawdown: {
      value: r(mdd.value) as number,
      peakIndex: mdd.peakIndex,
      troughIndex: mdd.troughIndex,
      recoveryIndex: mdd.recoveryIndex,
      peakToTroughPeriods: mdd.peakToTroughPeriods,
      durationPeriods: mdd.durationPeriods,
      recovered: mdd.recovered,
    },
    profitFactor: pf.value === null ? null : r(pf.value),
    grossProfit: r(pf.grossProfit) as number,
    grossLoss: r(pf.grossLoss) as number,
    atr: r(atr),
    atrPct: r(atrPct),
    atrPeriod,
    riskFreeRate,
    regime: classifyVolatilityRegime(volatility, options.regime ?? DEFAULT_REGIME_THRESHOLDS),
  };
}

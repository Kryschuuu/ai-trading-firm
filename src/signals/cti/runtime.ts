/**
 * Claude Trading Indicator (CTI) — der Rechenkern.
 *
 * Nachbau des Pine-Skripts „Claude Trading Indicator" (`@version=6`,
 * shorttitle `CTI`) als **inkrementeller Zustandsautomat**: eine geschlossene
 * Kerze rein, der vollständige Bar-Zustand raus. Es gibt bewusst nur DIESE
 * eine Implementierung — Backtest (`./backtest.ts`), Trading-Engine
 * (`./engine.ts`) und CLI füttern denselben Automaten. Damit ist
 * Backtest-↔-Live-Parität keine Behauptung, sondern eine Eigenschaft der
 * Architektur.
 *
 * ── Das Zwei-Stufen-Konsensmodell (1:1 aus dem Skript) ─────────────────────
 *
 * Stufe 1 — jede Dimension stimmt INTERN einstimmig ab:
 *
 *   | Dimension   | Komponenten                                   | bullisch, wenn …                |
 *   | ----------- | --------------------------------------------- | ------------------------------- |
 *   | Trend       | EMA 200, Supertrend(10, 3), Bollinger-Basis 20 | alle drei bullisch              |
 *   | Momentum    | MACD(12,26,9), RSI(14) vs. 50, Stoch(14,3,3)   | alle drei bullisch              |
 *   | Volatilität | DMI(14,14) mit `ADX >= 20`                     | `+DI > −DI` bei genug Stärke    |
 *   | Volumen     | OBV vs. `ta.sma(obv, 10)`                      | OBV über seinem Schnitt         |
 *
 * Stufe 2 — das Verdikt verlangt Einstimmigkeit über alle EINGESCHALTETEN
 * Dimensionen (`bullCount == enabledCount`). Ein einziges neutrales Votum
 * genügt, um das Verdikt zu verhindern — genau das macht den Indikator
 * selten und selektiv.
 *
 * Danach greifen die beiden Filter des Skripts:
 *   1. `persistBars` — das Verdikt muss exakt so viele Bars in Folge halten.
 *      Pine prüft `bullStreak == persistBars` (Gleichheit, nicht `>=`): Das
 *      Signal feuert EINMAL je Strecke, nicht auf jedem weiteren Bar.
 *   2. `minBarsBetween` — Sperrfrist in Bars seit dem letzten Signal. Fällt
 *      der `== persistBars`-Moment in die Sperrfrist, ist das Signal für
 *      diese Strecke verloren (es wird NICHT nachgeholt). Auch das ist
 *      Originalverhalten und wird hier absichtlich nicht „verbessert".
 *
 * ── Keine Rückblende, kein Repainting ──────────────────────────────────────
 * Der Automat sieht nur, was er bekommen hat. Jeder Bar wird genau einmal
 * gefüttert, die Zeit muss streng steigen (`CtiInputError` sonst). Eine
 * laufende Kerze gehört nicht hinein: Signale sind Bar-Schluss-Signale —
 * im Chart entspricht das einem Alert mit „Once Per Bar Close".
 *
 * ── Stops ──────────────────────────────────────────────────────────────────
 * `longStop = close − atr · atrMultiplier`, `shortStop = close + atr · …`
 * (ATR = `ta.atr(atrLength)`, Wilder). Beim Signal wird der Stop eingefroren
 * (`activeLongStop`), nicht nachgezogen; `low <= activeLongStop` bzw.
 * `high >= activeShortStop` beendet die Strecke. Das Skript zeichnet dort
 * die Linie zu Ende — die Trading-Engine schließt dort die Position.
 */

import {
  createAtr,
  createBollinger,
  createDmi,
  createEma,
  createMacd,
  createObv,
  createRsi,
  createSma,
  createStoch,
  createSupertrend,
  type PineAccumulator,
  type PineBollingerValue,
  type PineDmiValue,
  type PineMacdValue,
  type PineStochValue,
  type PineSupertrendValue,
  type PineValue,
} from "../pine";
import {
  CTI_COMPONENTS,
  DEFAULT_CTI_PARAMS,
  resolveCtiParams,
  type CtiParams,
} from "./params";
import {
  CtiInputError,
  type CtiBar,
  type CtiCandle,
  type CtiComponentVotes,
  type CtiDimensionVotes,
  type CtiReadings,
  type CtiSignalKind,
  type CtiVerdict,
  type CtiVote,
} from "./types";

/**
 * Pines Vergleichslogik `a > b ? 1 : a < b ? -1 : 0` inklusive `na`:
 * Ist einer der Werte `na`, sind BEIDE Vergleiche false ⇒ neutral.
 */
function compareVote(a: PineValue, b: PineValue): CtiVote {
  if (a === null || b === null) return 0;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

/** Einstimmigkeit: alle Voten bullisch ⇒ 1, alle bärisch ⇒ −1, sonst 0. */
function unanimous(votes: readonly CtiVote[]): CtiVote {
  if (votes.every((vote) => vote === 1)) return 1;
  if (votes.every((vote) => vote === -1)) return -1;
  return 0;
}

/** Prüft eine Kerze fail-closed: unbrauchbare Daten erzeugen keine Signale. */
function assertCandle(candle: CtiCandle, index: number): void {
  const invalid =
    !candle ||
    !Number.isFinite(candle.time) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    !Number.isFinite(candle.volume) ||
    candle.close <= 0 ||
    candle.high <= 0 ||
    candle.low <= 0 ||
    candle.volume < 0 ||
    candle.high < candle.low;
  if (invalid) {
    throw new CtiInputError(
      "INVALID_CANDLE",
      `CTI: Kerze ${index} ist unbrauchbar (time/high/low/close/volume müssen endlich, Kurse > 0, ` +
        `volume >= 0 und high >= low sein).`,
    );
  }
}

/** Momentaufnahme des Automaten (Diagnose, Status-Endpunkte, Tests). */
export interface CtiRuntimeState {
  /** Anzahl verarbeiteter Bars. */
  bars: number;
  /** Zeitstempel des zuletzt verarbeiteten Bars (`null` = noch keiner). */
  lastTime: number | null;
  bullStreak: number;
  bearStreak: number;
  lastSignalIndex: number | null;
  inLongTrade: boolean;
  inShortTrade: boolean;
  activeLongStop: number | null;
  activeShortStop: number | null;
}

/**
 * Inkrementeller CTI. Nicht thread-/reentrant-sicher (es gibt in Node auch
 * keine Threads im Hot-Path) und bewusst nicht klonbar: Ein Automat gehört
 * genau einem Symbol + Timeframe.
 */
export class CtiRuntime {
  /** Normalisierte, geklemmte Parameter dieses Automaten. */
  readonly params: Readonly<CtiParams>;
  /** Felder, die {@link resolveCtiParams} korrigiert hat (leer = unverändert). */
  readonly clamped: readonly string[];

  private readonly ema: PineAccumulator;
  private readonly supertrend: PineAccumulator<CtiCandle, PineSupertrendValue>;
  private readonly bollinger: PineAccumulator<PineValue, PineBollingerValue>;
  private readonly macd: PineAccumulator<PineValue, PineMacdValue>;
  private readonly rsi: PineAccumulator;
  private readonly stoch: PineAccumulator<CtiCandle, PineStochValue>;
  private readonly dmi: PineAccumulator<CtiCandle, PineDmiValue>;
  private readonly obv: PineAccumulator<CtiCandle>;
  private readonly obvSma: PineAccumulator;
  private readonly atr: PineAccumulator<CtiCandle>;

  private barIndex = -1;
  private lastTime: number | null = null;
  private bullStreak = 0;
  private bearStreak = 0;
  private lastSignalIndex: number | null = null;
  private activeLongStop: number | null = null;
  private activeShortStop: number | null = null;
  private inLongTrade = false;
  private inShortTrade = false;
  private lastBar: CtiBar | null = null;

  constructor(params?: Partial<CtiParams> | null) {
    const resolved = resolveCtiParams(params);
    this.params = Object.freeze({ ...resolved.params });
    this.clamped = Object.freeze([...resolved.clamped]);

    this.ema = createEma(CTI_COMPONENTS.emaLength);
    this.supertrend = createSupertrend(
      CTI_COMPONENTS.supertrendFactor,
      CTI_COMPONENTS.supertrendAtrPeriod,
    );
    this.bollinger = createBollinger(CTI_COMPONENTS.bollingerLength, CTI_COMPONENTS.bollingerMult);
    this.macd = createMacd(CTI_COMPONENTS.macdFast, CTI_COMPONENTS.macdSlow, CTI_COMPONENTS.macdSignal);
    this.rsi = createRsi(CTI_COMPONENTS.rsiLength);
    this.stoch = createStoch(
      CTI_COMPONENTS.stochLength,
      CTI_COMPONENTS.stochSmooth,
      CTI_COMPONENTS.stochD,
    );
    this.dmi = createDmi(CTI_COMPONENTS.adxLength, CTI_COMPONENTS.adxSmoothing);
    this.obv = createObv();
    this.obvSma = createSma(CTI_COMPONENTS.volumeSmoothLength);
    this.atr = createAtr(this.params.atrLength);
  }

  /** Zuletzt ausgewerteter Bar (`null`, solange nichts gefüttert wurde). */
  get last(): CtiBar | null {
    return this.lastBar;
  }

  /** Anzahl verarbeiteter Bars. */
  get bars(): number {
    return this.barIndex + 1;
  }

  /** Zustand für Diagnose/Status (reine Kopie, kein interner Zeiger). */
  state(): CtiRuntimeState {
    return {
      bars: this.bars,
      lastTime: this.lastTime,
      bullStreak: this.bullStreak,
      bearStreak: this.bearStreak,
      lastSignalIndex: this.lastSignalIndex,
      inLongTrade: this.inLongTrade,
      inShortTrade: this.inShortTrade,
      activeLongStop: this.activeLongStop,
      activeShortStop: this.activeShortStop,
    };
  }

  /**
   * Verarbeitet die NÄCHSTE geschlossene Kerze und liefert den Bar-Zustand.
   *
   * @throws {CtiInputError} bei unbrauchbaren Werten, gleichem oder
   *   rückwärts laufendem Zeitstempel (Doppel-Tick/Out-of-order). Beides
   *   würde Streaks und Sperrfrist verfälschen — lieber laut scheitern.
   */
  push(candle: CtiCandle): CtiBar {
    const index = this.barIndex + 1;
    assertCandle(candle, index);
    if (this.lastTime !== null && candle.time <= this.lastTime) {
      throw new CtiInputError(
        candle.time === this.lastTime ? "DUPLICATE_BAR" : "NON_MONOTONIC_TIME",
        `CTI: Kerzenzeit ${candle.time} ist nicht größer als die zuletzt verarbeitete ${this.lastTime}.`,
      );
    }
    this.barIndex = index;
    this.lastTime = candle.time;

    // ── Komponenten (Reihenfolge wie im Skript) ──────────────────────────
    const close = candle.close;
    const emaValue = this.ema.next(close);
    const supertrendValue = this.supertrend.next(candle);
    const bollingerValue = this.bollinger.next(close);
    const macdValue = this.macd.next(close);
    const rsiValue = this.rsi.next(close);
    const stochValue = this.stoch.next(candle);
    const dmiValue = this.dmi.next(candle);
    const obvValue = this.obv.next(candle);
    const obvMaValue = this.obvSma.next(obvValue);
    const atrValue = this.atr.next(candle);

    // ── Tier 1: Komponenten-Voten ────────────────────────────────────────
    const votes: CtiComponentVotes = {
      ema: compareVote(close, emaValue),
      // Pine: `stDir < 0 ? 1 : stDir > 0 ? -1 : 0` — die Richtung ist invers
      // zum Votum (−1 = Aufwärtstrend).
      supertrend: supertrendValue.direction < 0 ? 1 : -1,
      bollinger: compareVote(close, bollingerValue.basis),
      macd: compareVote(macdValue.macd, macdValue.signal),
      rsi: compareVote(rsiValue, 50),
      stoch: compareVote(stochValue.k, stochValue.d),
      dmi:
        dmiValue.adx !== null && dmiValue.adx >= CTI_COMPONENTS.adxMinStrength
          ? compareVote(dmiValue.plus, dmiValue.minus)
          : 0,
      obv: compareVote(obvValue, obvMaValue),
    };

    // ── Tier 2: Dimensions-Voten (je einstimmig) ─────────────────────────
    const dimensions: CtiDimensionVotes = {
      trend: unanimous([votes.ema, votes.supertrend, votes.bollinger]),
      momentum: unanimous([votes.macd, votes.rsi, votes.stoch]),
      // Die Volatilitäts-Dimension hat nur eine Komponente: das DMI-Votum ist
      // bereits die Einstimmigkeit (ADX-Schwelle inbegriffen).
      volatility: votes.dmi,
      volume: votes.obv,
    };

    // ── Verdikt: Einstimmigkeit über alle EINGESCHALTETEN Dimensionen ────
    const active: CtiVote[] = [];
    if (this.params.useTrend) active.push(dimensions.trend);
    if (this.params.useMomentum) active.push(dimensions.momentum);
    if (this.params.useVolatility) active.push(dimensions.volatility);
    if (this.params.useVolume) active.push(dimensions.volume);

    const enabledCount = active.length;
    let bullCount = 0;
    let bearCount = 0;
    for (const vote of active) {
      if (vote === 1) bullCount += 1;
      else if (vote === -1) bearCount += 1;
    }
    const verdictBull = enabledCount > 0 && bullCount === enabledCount;
    const verdictBear = enabledCount > 0 && bearCount === enabledCount;
    const verdict: CtiVerdict = verdictBull ? "BULL" : verdictBear ? "BEAR" : "NONE";

    // ── Filter 1: Persistenz (Pine prüft Gleichheit, nicht `>=`) ─────────
    this.bullStreak = verdictBull ? this.bullStreak + 1 : 0;
    this.bearStreak = verdictBear ? this.bearStreak + 1 : 0;
    const bullReady = this.bullStreak === this.params.persistBars;
    const bearReady = this.bearStreak === this.params.persistBars;

    // ── Filter 2: Sperrfrist seit dem letzten Signal ─────────────────────
    const barsSinceSignal = this.lastSignalIndex === null ? null : index - this.lastSignalIndex;
    const cooldownOk = barsSinceSignal === null || barsSinceSignal >= this.params.minBarsBetween;

    const buySignal = bullReady && cooldownOk;
    const sellSignal = bearReady && cooldownOk && !buySignal;
    const signal: CtiSignalKind | null = buySignal ? "BUY" : sellSignal ? "SELL" : null;
    if (signal !== null) this.lastSignalIndex = index;

    // ── Stops: beim Signal eingefroren, nie nachgezogen ──────────────────
    const longStop = atrValue === null ? null : close - atrValue * this.params.atrMultiplier;
    const shortStop = atrValue === null ? null : close + atrValue * this.params.atrMultiplier;

    if (buySignal) {
      this.inLongTrade = true;
      this.inShortTrade = false;
      this.activeLongStop = longStop;
    }
    if (sellSignal) {
      this.inShortTrade = true;
      this.inLongTrade = false;
      this.activeShortStop = shortStop;
    }

    // Die Strecke endet, sobald der Kurs den Stop durchhandelt — inklusive
    // der Signalkerze selbst (Pine prüft das in derselben Kerze).
    let stopHit: "LONG" | "SHORT" | null = null;
    if (this.inLongTrade && this.activeLongStop !== null && candle.low <= this.activeLongStop) {
      this.inLongTrade = false;
      stopHit = "LONG";
    }
    if (this.inShortTrade && this.activeShortStop !== null && candle.high >= this.activeShortStop) {
      this.inShortTrade = false;
      stopHit = "SHORT";
    }

    const readings: CtiReadings = {
      ema: emaValue,
      supertrendLine: supertrendValue.line,
      supertrendDirection: supertrendValue.direction,
      bollingerUpper: bollingerValue.upper,
      bollingerBasis: bollingerValue.basis,
      bollingerLower: bollingerValue.lower,
      macd: macdValue.macd,
      macdSignal: macdValue.signal,
      macdHistogram: macdValue.histogram,
      rsi: rsiValue,
      stochK: stochValue.k,
      stochD: stochValue.d,
      diPlus: dmiValue.plus,
      diMinus: dmiValue.minus,
      adx: dmiValue.adx,
      obv: obvValue,
      obvMa: obvMaValue,
      atr: atrValue,
    };

    const bar: CtiBar = {
      index,
      time: candle.time,
      close,
      readings,
      votes,
      dimensions,
      enabledCount,
      bullCount,
      bearCount,
      verdict,
      bullStreak: this.bullStreak,
      bearStreak: this.bearStreak,
      signal,
      barsSinceSignal,
      longStop,
      shortStop,
      activeLongStop: this.activeLongStop,
      activeShortStop: this.activeShortStop,
      inLongTrade: this.inLongTrade,
      inShortTrade: this.inShortTrade,
      stopHit,
    };
    this.lastBar = bar;
    return bar;
  }
}

/**
 * Wertet eine vollständige Kerzenreihe aus (Offline-Analyse, Tests, CLI).
 *
 * Reiner Faltungs-Helfer über {@link CtiRuntime} — KEINE zweite
 * Implementierung. Daraus folgt die Kausalitätsgarantie, die
 * `tests/cti.indicator.test.ts` festnagelt: Das Ergebnis der ersten `k`
 * Kerzen ist identisch, egal ob man `k` oder alle `n` Kerzen auswertet.
 */
export function computeCtiSeries(
  candles: readonly CtiCandle[],
  params?: Partial<CtiParams> | null,
): CtiBar[] {
  const runtime = new CtiRuntime(params ?? DEFAULT_CTI_PARAMS);
  const out: CtiBar[] = [];
  for (const candle of candles) out.push(runtime.push(candle));
  return out;
}

/** Alle Bars mit Signal — die kompakte Signalliste einer Reihe. */
export function ctiSignals(bars: readonly CtiBar[]): CtiBar[] {
  return bars.filter((bar) => bar.signal !== null);
}

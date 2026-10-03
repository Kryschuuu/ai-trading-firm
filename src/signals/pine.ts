/**
 * Pine-Script-treue Indikator-Primitive (`ta.*`) — die Rechenbasis des
 * Claude Trading Indicators (`src/signals/cti/`).
 *
 * ── Warum eine zweite Indikator-Datei neben `src/lib/indicators.ts`? ────────
 * `src/lib/indicators.ts` ist die Quelle der REGELFELDER (`RULE_FIELDS`) und
 * darf sich nicht ändern: ihre EMA ist mit dem ersten Schlusskurs geseedet,
 * ihr ATR ist das arithmetische Mittel der True Ranges, ihr MACD erbt beides.
 * Das sind gültige, dokumentierte Konventionen — aber **nicht** die von
 * TradingView. Ein Indikator, der „1 zu 1 wie im Chart" rechnen soll, braucht
 * exakt die Pine-Semantik:
 *
 *   | Pine                | Semantik, die hier nachgebaut wird                |
 *   | ------------------- | ------------------------------------------------- |
 *   | `ta.sma(x, n)`      | Mittel der letzten n Werte; `na`, wenn ein Wert na |
 *   | `ta.ema(x, n)`      | Seed = `ta.sma(x, n)`, dann α = 2/(n+1)            |
 *   | `ta.rma(x, n)`      | Seed = `ta.sma(x, n)`, dann α = 1/n (Wilder)       |
 *   | `ta.stdev(x, n)`    | Populations-σ mit `isZero`-Korrektur               |
 *   | `ta.rsi(x, n)`      | `rma(up)/rma(down)` (NICHT die Summenrekursion)    |
 *   | `ta.macd(…)`        | Differenz zweier `ta.ema`, Signal = `ta.ema`       |
 *   | `ta.stoch(…)`       | `100·(c − llv)/(hhv − llv)`                        |
 *   | `ta.tr` / `ta.atr`  | True Range bzw. `rma(tr(true), n)`                 |
 *   | `ta.supertrend(…)`  | Bandverriegelung + Richtungsumschlag (Doku-Code)   |
 *   | `ta.dmi(…)`         | `fixnan`-geführte DI-Linien, ADX = `rma(dx)`       |
 *   | `ta.obv`            | `cum(sign(change(close)) · volume)`                |
 *
 * Beide Dateien bleiben nebeneinander bestehen: Regeln rechnen weiter mit
 * `src/lib/indicators.ts`, der CTI rechnet mit dieser Datei. Wer sie mischt,
 * bekommt andere Zahlen — deshalb steht die Abgrenzung hier im Kopf und in
 * `docs/CLAUDE_TRADING_INDICATOR.md`.
 *
 * ── Streaming statt Array ──────────────────────────────────────────────────
 * Jede Funktion liefert einen **Akkumulator** mit `next(value)`: ein Bar rein,
 * der Wert DIESES Bars raus. Daraus folgt direkt die wichtigste Eigenschaft
 * für Backtest und Live-Betrieb:
 *
 *   Ein Akkumulator kann strukturell nicht in die Zukunft sehen —
 *   er hat die künftigen Bars schlicht nicht.
 *
 * Backtest (`src/signals/cti/backtest.ts`) und Trading-Engine
 * (`src/signals/cti/engine.ts`) füttern denselben Code mit derselben
 * Reihenfolge und bekommen deshalb per Konstruktion dieselben Signale.
 * `seriesOf()` faltet einen Akkumulator über ein Array — für Tests und
 * Offline-Auswertungen, nicht als zweite Implementierung.
 *
 * ── `null` ist `na`, nie 0 ──────────────────────────────────────────────────
 * Solange ein Indikator nicht aufgewärmt ist, liefert er `null`. Das ist
 * dieselbe Fail-closed-Konvention wie im übrigen Repo (`null ≠ 0`): Ein
 * RSI von 0 ist eine Aussage („maximal überverkauft"), ein RSI von `null`
 * ist keine. In Pine ist `na > 50` false und `na < 50` ebenfalls false —
 * der CTI übersetzt das zu einem neutralen Votum.
 *
 * Nicht-endliche Eingaben (NaN/Infinity) werden wie `na` behandelt; eine
 * laufende Rekursion verliert dadurch ihren Zustand und seedet neu, sobald
 * wieder `length` zusammenhängende Werte vorliegen.
 *
 * Determinismus: keine Uhr, kein Zufall, keine IO, keine Bibliothek.
 */

/** Ein Indikatorwert; `null` entspricht Pines `na`. */
export type PineValue = number | null;

/**
 * Streaming-Indikator: ein Bar rein, der Wert dieses Bars raus.
 * Aufrufer MÜSSEN die Bars lückenlos und chronologisch einspeisen — ein
 * übersprungener Bar verschiebt jede Rekursion (wie in Pine auch).
 */
export interface PineAccumulator<TIn = PineValue, TOut = PineValue> {
  next(value: TIn): TOut;
}

/** Strukturelle Kerze (kompatibel zu `CandleLike` aus `src/lib/ruleEngine`). */
export interface PineBar {
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Ergebnis von `ta.macd`. */
export interface PineMacdValue {
  macd: PineValue;
  signal: PineValue;
  histogram: PineValue;
}

/** Ergebnis des geglätteten Stochastik-Oszillators (`%K`/`%D`). */
export interface PineStochValue {
  /** Rohwert `ta.stoch(close, high, low, length)`. */
  raw: PineValue;
  /** `%K` = `ta.sma(raw, smoothK)`. */
  k: PineValue;
  /** `%D` = `ta.sma(k, dLength)`. */
  d: PineValue;
}

/** Ergebnis von `ta.supertrend` — `direction` ist nie `na` (wie in Pine). */
export interface PineSupertrendValue {
  line: PineValue;
  /** `-1` = Aufwärtstrend (bullisch), `1` = Abwärtstrend (bärisch). */
  direction: -1 | 1;
}

/** Ergebnis von `ta.dmi`. */
export interface PineDmiValue {
  plus: PineValue;
  minus: PineValue;
  adx: PineValue;
}

/** Ergebnis der Bollinger-Bänder (Basis = `ta.sma`, σ = `ta.stdev`). */
export interface PineBollingerValue {
  basis: PineValue;
  upper: PineValue;
  lower: PineValue;
}

/**
 * Periodenlänge prüfen — fail-closed. Eine stillschweigend korrigierte Länge
 * wäre eine zweite Wahrheit über den Indikator; der CTI klemmt seine
 * Parameter sichtbar VOR dem Aufruf (`resolveCtiParams`).
 */
function requireLength(length: number, fn: string): number {
  if (!Number.isFinite(length) || !Number.isInteger(length) || length < 1) {
    throw new RangeError(`${fn}: length muss eine ganze Zahl >= 1 sein (ist ${String(length)}).`);
  }
  return length;
}

/** Nicht-endliche Zahlen sind `na` — nie eine stille 0. */
function normalize(value: PineValue | undefined): PineValue {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * Pines `isZero(val, eps)` aus der dokumentierten `ta.stdev`-Referenz:
 * Rundungsreste unterhalb von 1e-10 · |Mittelwert| zählen als exakte 0.
 * Ohne diese Korrektur liefert eine konstante Kursreihe ein σ > 0 (Artefakt
 * der Gleitkomma-Subtraktion) — und damit Bollinger-Bänder, die es im Chart
 * nicht gibt.
 */
function isZero(value: number, eps: number): number {
  return Math.abs(value) <= 1e-10 * Math.abs(eps) ? 0 : value;
}

/** `ta.sma(source, length)` — `na`, solange ein Fensterwert `na` ist. */
export function createSma(length: number): PineAccumulator {
  const len = requireLength(length, "ta.sma");
  const window: PineValue[] = [];
  return {
    next(value: PineValue): PineValue {
      window.push(normalize(value));
      if (window.length > len) window.shift();
      if (window.length < len) return null;
      let sum = 0;
      for (const entry of window) {
        if (entry === null) return null;
        sum += entry;
      }
      return sum / len;
    },
  };
}

/**
 * Gemeinsame Rekursion von `ta.ema` und `ta.rma`:
 *
 *   `value := na(value[1]) ? ta.sma(src, len) : α · src + (1 − α) · value[1]`
 *
 * Das ist der entscheidende Unterschied zur EMA in `src/lib/indicators.ts`
 * (Seed = erster Schlusskurs): Pine beginnt erst beim `len`-ten Wert und
 * startet dort auf dem einfachen Mittel.
 */
function createRecursiveAverage(length: number, alpha: number, fn: string): PineAccumulator {
  const len = requireLength(length, fn);
  const seed = createSma(len);
  let state: PineValue = null;
  return {
    next(value: PineValue): PineValue {
      const current = normalize(value);
      if (current === null) {
        // `na` bricht die Rekursion; das Fenster bleibt synchron, damit der
        // Neustart exakt `len` zusammenhängende Werte verlangt.
        seed.next(null);
        state = null;
        return null;
      }
      const sma = seed.next(current);
      if (state === null) {
        state = sma;
        return state;
      }
      state = alpha * current + (1 - alpha) * state;
      return state;
    },
  };
}

/** `ta.ema(source, length)` — Seed = `ta.sma`, α = 2/(length+1). */
export function createEma(length: number): PineAccumulator {
  return createRecursiveAverage(length, 2 / (requireLength(length, "ta.ema") + 1), "ta.ema");
}

/** `ta.rma(source, length)` — Wilder-Glättung: Seed = `ta.sma`, α = 1/length. */
export function createRma(length: number): PineAccumulator {
  return createRecursiveAverage(length, 1 / requireLength(length, "ta.rma"), "ta.rma");
}

/** `ta.stdev(source, length)` — Populations-σ mit `isZero`-Korrektur. */
export function createStdev(length: number): PineAccumulator {
  const len = requireLength(length, "ta.stdev");
  const window: PineValue[] = [];
  return {
    next(value: PineValue): PineValue {
      window.push(normalize(value));
      if (window.length > len) window.shift();
      if (window.length < len) return null;
      let sum = 0;
      for (const entry of window) {
        if (entry === null) return null;
        sum += entry;
      }
      const avg = sum / len;
      let squares = 0;
      for (const entry of window) {
        const deviation = isZero((entry as number) - avg, avg);
        squares += deviation * deviation;
      }
      return Math.sqrt(squares / len);
    },
  };
}

/** `ta.highest(source, length)`. */
export function createHighest(length: number): PineAccumulator {
  const len = requireLength(length, "ta.highest");
  const window: PineValue[] = [];
  return {
    next(value: PineValue): PineValue {
      window.push(normalize(value));
      if (window.length > len) window.shift();
      if (window.length < len) return null;
      let best = -Infinity;
      for (const entry of window) {
        if (entry === null) return null;
        if (entry > best) best = entry;
      }
      return best;
    },
  };
}

/** `ta.lowest(source, length)`. */
export function createLowest(length: number): PineAccumulator {
  const len = requireLength(length, "ta.lowest");
  const window: PineValue[] = [];
  return {
    next(value: PineValue): PineValue {
      window.push(normalize(value));
      if (window.length > len) window.shift();
      if (window.length < len) return null;
      let best = Infinity;
      for (const entry of window) {
        if (entry === null) return null;
        if (entry < best) best = entry;
      }
      return best;
    },
  };
}

/** `ta.change(source)` — Differenz zum Vorwert, erster Bar `na`. */
export function createChange(): PineAccumulator {
  let previous: PineValue = null;
  return {
    next(value: PineValue): PineValue {
      const current = normalize(value);
      const change = previous === null || current === null ? null : current - previous;
      previous = current;
      return change;
    },
  };
}

/**
 * `ta.tr(handleNa)` — True Range.
 *
 * `handleNa = true` liefert auf dem ersten Bar `high − low` (so rechnet
 * `ta.atr`); `false` liefert dort `na` (so rechnet `ta.dmi` über `ta.tr`).
 */
export function createTrueRange(handleNa: boolean): PineAccumulator<PineBar> {
  let previousClose: PineValue = null;
  return {
    next(bar: PineBar): PineValue {
      const high = normalize(bar?.high);
      const low = normalize(bar?.low);
      const close = normalize(bar?.close);
      if (high === null || low === null || close === null) {
        previousClose = close;
        return null;
      }
      const prev = previousClose;
      previousClose = close;
      if (prev === null) return handleNa ? high - low : null;
      return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
    },
  };
}

/** `ta.atr(length)` = `ta.rma(ta.tr(true), length)`. */
export function createAtr(length: number): PineAccumulator<PineBar> {
  const trueRange = createTrueRange(true);
  const rma = createRma(requireLength(length, "ta.atr"));
  return {
    next(bar: PineBar): PineValue {
      return rma.next(trueRange.next(bar));
    },
  };
}

/**
 * `ta.rsi(source, length)` = `100 − 100/(1 + rma(up)/rma(down))`.
 *
 * Sonderfälle wie in Pine: `rma(down) == 0` und `rma(up) > 0` ⇒ 100
 * (reiner Aufwärtslauf). Sind BEIDE 0 (vollständig flache Reihe), ist der
 * Quotient `0/0` ⇒ `na` — nicht 50. Der CTI wertet das als neutral.
 */
export function createRsi(length: number): PineAccumulator {
  const len = requireLength(length, "ta.rsi");
  const upRma = createRma(len);
  const downRma = createRma(len);
  let previous: PineValue = null;
  return {
    next(value: PineValue): PineValue {
      const current = normalize(value);
      if (current === null) {
        upRma.next(null);
        downRma.next(null);
        previous = null;
        return null;
      }
      const change = previous === null ? null : current - previous;
      previous = current;
      const up = upRma.next(change === null ? null : Math.max(change, 0));
      const down = downRma.next(change === null ? null : Math.max(-change, 0));
      if (up === null || down === null) return null;
      if (down === 0) return up === 0 ? null : 100;
      const rs = up / down;
      return 100 - 100 / (1 + rs);
    },
  };
}

/** `ta.macd(source, fast, slow, signal)`. */
export function createMacd(
  fastLength: number,
  slowLength: number,
  signalLength: number,
): PineAccumulator<PineValue, PineMacdValue> {
  const fast = createEma(requireLength(fastLength, "ta.macd"));
  const slow = createEma(requireLength(slowLength, "ta.macd"));
  const signal = createEma(requireLength(signalLength, "ta.macd"));
  return {
    next(value: PineValue): PineMacdValue {
      const fastValue = fast.next(value);
      const slowValue = slow.next(value);
      const macd = fastValue === null || slowValue === null ? null : fastValue - slowValue;
      const signalValue = signal.next(macd);
      const histogram = macd === null || signalValue === null ? null : macd - signalValue;
      return { macd, signal: signalValue, histogram };
    },
  };
}

/**
 * Geglätteter Stochastik-Oszillator, exakt in der Reihenfolge des Skripts:
 *
 *   `raw = ta.stoch(close, high, low, kLength)`
 *   `%K  = ta.sma(raw, smoothK)`
 *   `%D  = ta.sma(%K, dLength)`
 *
 * Bei `hhv == llv` (vollkommen flaches Fenster) ist der Rohwert eine Division
 * durch 0 ⇒ `na`, nicht 50 oder 0.
 */
export function createStoch(
  kLength: number,
  smoothK: number,
  dLength: number,
): PineAccumulator<PineBar, PineStochValue> {
  const highest = createHighest(requireLength(kLength, "ta.stoch"));
  const lowest = createLowest(kLength);
  const kSma = createSma(requireLength(smoothK, "ta.stoch"));
  const dSma = createSma(requireLength(dLength, "ta.stoch"));
  return {
    next(bar: PineBar): PineStochValue {
      const hhv = highest.next(normalize(bar?.high));
      const llv = lowest.next(normalize(bar?.low));
      const close = normalize(bar?.close);
      let raw: PineValue = null;
      if (hhv !== null && llv !== null && close !== null) {
        const range = hhv - llv;
        raw = range === 0 ? null : (100 * (close - llv)) / range;
      }
      const k = kSma.next(raw);
      const d = dSma.next(k);
      return { raw, k, d };
    },
  };
}

/**
 * `ta.obv` = `ta.cum(math.sign(ta.change(close)) · volume)`.
 *
 * Der erste Bar hat keine Veränderung ⇒ `na` (wie in Pine). Danach ist der
 * OBV eine laufende Summe; ein konstanter Offset würde den Vergleich gegen
 * seinen gleitenden Schnitt ohnehin nicht verändern.
 */
export function createObv(): PineAccumulator<PineBar> {
  let previousClose: PineValue = null;
  let cumulative: PineValue = null;
  return {
    next(bar: PineBar): PineValue {
      const close = normalize(bar?.close);
      const volume = normalize(bar?.volume);
      if (close === null) {
        previousClose = null;
        return cumulative;
      }
      if (previousClose === null) {
        previousClose = close;
        return cumulative;
      }
      const direction = Math.sign(close - previousClose);
      previousClose = close;
      // Kein belastbares Volumen ⇒ `na` für DIESEN Bar. Die Summe wird
      // bewusst nicht zurückgesetzt: ein Reset würde die gesamte Reihe
      // still neu verankern und damit jeden Vergleich gegen ihren
      // gleitenden Schnitt verfälschen.
      if (volume === null) return null;
      cumulative = (cumulative ?? 0) + direction * volume;
      return cumulative;
    },
  };
}

/**
 * `ta.supertrend(factor, atrPeriod)` — 1:1 der Referenzcode der Pine-Doku:
 *
 * ```
 * src = hl2, atr = ta.atr(atrPeriod)
 * upperBand = src + factor·atr, lowerBand = src − factor·atr
 * lowerBand := lowerBand > nz(lowerBand[1]) or close[1] < nz(lowerBand[1]) ? lowerBand : nz(lowerBand[1])
 * upperBand := upperBand < nz(upperBand[1]) or close[1] > nz(upperBand[1]) ? upperBand : nz(upperBand[1])
 * direction := na(atr[1]) ? 1 : superTrend[1] == upperBand[1] ? (close > upperBand ? -1 : 1)
 *                                                             : (close < lowerBand ? 1 : -1)
 * superTrend := direction == -1 ? lowerBand : upperBand
 * ```
 *
 * Die `nz()`-Nullen der Aufwärmphase sind KEIN Schönheitsfehler, sondern Teil
 * des Verhaltens: Bis `atr[1]` existiert, meldet Pine `direction = 1`
 * (bärisch). Der CTI erbt das — und weil sein Trend-Votum Einstimmigkeit
 * verlangt (EMA 200 ist in dieser Zeit `na`), entsteht daraus kein Signal.
 */
export function createSupertrend(
  factor: number,
  atrPeriod: number,
): PineAccumulator<PineBar, PineSupertrendValue> {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`ta.supertrend: factor muss > 0 sein (ist ${String(factor)}).`);
  }
  const atr = createAtr(requireLength(atrPeriod, "ta.supertrend"));
  let previousAtr: PineValue = null;
  let previousUpper: PineValue = null;
  let previousLower: PineValue = null;
  let previousSuper: PineValue = null;
  let previousClose: PineValue = null;

  return {
    next(bar: PineBar): PineSupertrendValue {
      const atrValue = atr.next(bar);
      const high = normalize(bar?.high);
      const low = normalize(bar?.low);
      const close = normalize(bar?.close);
      const src = high === null || low === null ? null : (high + low) / 2;

      const rawUpper = atrValue === null || src === null ? null : src + factor * atrValue;
      const rawLower = atrValue === null || src === null ? null : src - factor * atrValue;

      // `nz(x[1])` — fehlender Vorwert zählt als 0 (Pine-Semantik).
      const nzLower = previousLower ?? 0;
      const nzUpper = previousUpper ?? 0;

      const lower =
        (rawLower !== null && rawLower > nzLower) || (previousClose !== null && previousClose < nzLower)
          ? rawLower
          : nzLower;
      const upper =
        (rawUpper !== null && rawUpper < nzUpper) || (previousClose !== null && previousClose > nzUpper)
          ? rawUpper
          : nzUpper;

      let direction: -1 | 1;
      if (previousAtr === null) {
        direction = 1;
      } else if (previousSuper !== null && previousUpper !== null && previousSuper === previousUpper) {
        direction = upper !== null && close !== null && close > upper ? -1 : 1;
      } else {
        direction = lower !== null && close !== null && close < lower ? 1 : -1;
      }

      const line = direction === -1 ? lower : upper;

      previousAtr = atrValue;
      previousUpper = upper;
      previousLower = lower;
      previousSuper = line;
      previousClose = close;

      return { line, direction };
    },
  };
}

/**
 * `ta.dmi(diLength, adxSmoothing)` — DI-Linien und ADX.
 *
 * ```
 * up = ta.change(high), down = -ta.change(low)
 * plusDM  = na(up) ? na : (up > down and up > 0 ? up : 0)
 * minusDM = na(down) ? na : (down > up and down > 0 ? down : 0)
 * trueRange = ta.rma(ta.tr, diLength)                       // ta.tr, NICHT ta.tr(true)
 * plus  = fixnan(100 · ta.rma(plusDM, diLength)  / trueRange)
 * minus = fixnan(100 · ta.rma(minusDM, diLength) / trueRange)
 * adx   = 100 · ta.rma(|plus − minus| / (sum == 0 ? 1 : sum), adxSmoothing)
 * ```
 *
 * `fixnan` trägt den letzten gültigen Wert fort — relevant genau dann, wenn
 * die geglättete True Range 0 ist (vollständig flache Kerzenreihe); dort wäre
 * der Quotient `0/0`. Vor dem ersten gültigen Wert bleibt `null`.
 */
export function createDmi(
  diLength: number,
  adxSmoothing: number,
): PineAccumulator<PineBar, PineDmiValue> {
  const di = requireLength(diLength, "ta.dmi");
  const smoothing = requireLength(adxSmoothing, "ta.dmi");
  const trueRange = createTrueRange(false);
  const trRma = createRma(di);
  const plusRma = createRma(di);
  const minusRma = createRma(di);
  const adxRma = createRma(smoothing);
  let previousHigh: PineValue = null;
  let previousLow: PineValue = null;
  let lastPlus: PineValue = null;
  let lastMinus: PineValue = null;

  return {
    next(bar: PineBar): PineDmiValue {
      const high = normalize(bar?.high);
      const low = normalize(bar?.low);
      const tr = trueRange.next(bar);

      const up = previousHigh === null || high === null ? null : high - previousHigh;
      const down = previousLow === null || low === null ? null : previousLow - low;
      previousHigh = high;
      previousLow = low;

      const plusDm = up === null || down === null ? null : up > down && up > 0 ? up : 0;
      const minusDm = up === null || down === null ? null : down > up && down > 0 ? down : 0;

      const smoothedTr = trRma.next(tr);
      const smoothedPlus = plusRma.next(plusDm);
      const smoothedMinus = minusRma.next(minusDm);

      const usable = smoothedTr !== null && smoothedTr !== 0;
      let plus: PineValue = usable && smoothedPlus !== null ? (100 * smoothedPlus) / (smoothedTr as number) : null;
      let minus: PineValue = usable && smoothedMinus !== null ? (100 * smoothedMinus) / (smoothedTr as number) : null;

      // fixnan(): letzter gültiger Wert statt `na`.
      if (plus === null) plus = lastPlus;
      else lastPlus = plus;
      if (minus === null) minus = lastMinus;
      else lastMinus = minus;

      let dx: PineValue = null;
      if (plus !== null && minus !== null) {
        const sum = plus + minus;
        dx = Math.abs(plus - minus) / (sum === 0 ? 1 : sum);
      }
      const smoothedDx = adxRma.next(dx);

      return { plus, minus, adx: smoothedDx === null ? null : 100 * smoothedDx };
    },
  };
}

/** Bollinger-Bänder: Basis = `ta.sma`, Abstand = `mult · ta.stdev`. */
export function createBollinger(
  length: number,
  mult: number,
): PineAccumulator<PineValue, PineBollingerValue> {
  const len = requireLength(length, "bollinger");
  if (!Number.isFinite(mult) || mult <= 0) {
    throw new RangeError(`bollinger: mult muss > 0 sein (ist ${String(mult)}).`);
  }
  const sma = createSma(len);
  const stdev = createStdev(len);
  return {
    next(value: PineValue): PineBollingerValue {
      const basis = sma.next(value);
      const deviation = stdev.next(value);
      if (basis === null || deviation === null) return { basis, upper: null, lower: null };
      const offset = mult * deviation;
      return { basis, upper: basis + offset, lower: basis - offset };
    },
  };
}

/**
 * Faltet einen Akkumulator über ein Array — für Tests, Offline-Auswertungen
 * und Doku-Beispiele. Bewusst KEINE zweite Implementierung: dieselbe
 * Rekursion wie im Live-Pfad, nur in einer Schleife.
 */
export function seriesOf<TIn, TOut>(
  accumulator: PineAccumulator<TIn, TOut>,
  values: readonly TIn[],
): TOut[] {
  const out: TOut[] = [];
  for (const value of values) out.push(accumulator.next(value));
  return out;
}
